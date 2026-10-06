import type { PresentPrintDevice, PrinterDiagnosticSnapshot } from '../../types/printer-diagnostic';

export type DiagnosticConnection='Redirecionada / Terminal Services'|'Compartilhada / Remota'|'TCP/IP / Rede'|'COM / Local'|'USB / Local'|'Virtual'|'Porta lógica'|'Local / Não identificado';
export function comId(port:string|null):string|null {
  const match=port?.trim().match(/(?:^|_)COM([1-9]\d*):?$/i);
  return match&&Number.isSafeInteger(Number(match[1]))?`COM${Number(match[1])}`:null;
}
export function isRedirected(s:PrinterDiagnosticSnapshot):boolean {return !!((s.printer?.attributes??0)&0x8000);}
export function isRemotePrinter(s:PrinterDiagnosticSnapshot):boolean {return !!s.printer?.server||!!((s.printer?.attributes??0)&0x10)||!!s.printer?.name.startsWith('\\\\');}
export function isVirtualPrinter(s:PrinterDiagnosticSnapshot):boolean {
  if(isRedirected(s)||isRemotePrinter(s))return false;
  const driver=(s.driver?.name??s.printer?.driver??'').trim().toLowerCase();
  const port=(s.printer?.port??'').trim().toUpperCase();
  // Exact installed driver + its logical output port, never the friendly name.
  return (driver==='microsoft print to pdf'&&port==='PORTPROMPT:')||
    (['send to microsoft onenote 16 driver','send to microsoft onenote driver','onenote (desktop)'].includes(driver)&&port==='NUL:')||
    (['microsoft xps document writer','microsoft xps document writer v4'].includes(driver)&&['PORTPROMPT:','XPSPORT:'].includes(port));
}
export function diagnosticConnection(s:PrinterDiagnosticSnapshot):DiagnosticConnection {
  if(isRedirected(s))return 'Redirecionada / Terminal Services';
  if(isRemotePrinter(s))return 'Compartilhada / Remota';
  if(isVirtualPrinter(s))return 'Virtual';
  const port=s.printer?.port?.trim()??'';
  if(s.tcp.items.some(p=>p.name.toLowerCase()===port.toLowerCase()))return 'TCP/IP / Rede';
  if(comId(port))return 'COM / Local';
  if(/^USB\d+:?$/i.test(port))return 'USB / Local';
  if(/^(FILE:|PORTPROMPT:|NUL:|SHRFAX:)$/i.test(port))return 'Porta lógica';
  return 'Local / Não identificado';
}
export interface PrinterPresence {
  applicable:boolean;associatedId:string|null;present:boolean|null;device:PresentPrintDevice|null;
  communication:'unconfirmed'|'not_applicable';method:string;confidence:'port'|'none';detail:string;
}
export function printerPresence(s:PrinterDiagnosticSnapshot):PrinterPresence {
  const kind=diagnosticConnection(s);
  const base:PrinterPresence={applicable:true,associatedId:null,present:null,device:null,communication:'unconfirmed',method:'Sem associação confiável',confidence:'none',detail:'Dispositivo físico não confirmado.'};
  if(isRedirected(s))return {...base,applicable:false,communication:'not_applicable',detail:'Não aplicável localmente: fila redirecionada. O hardware está na sessão de origem.'};
  if(isRemotePrinter(s)||kind==='TCP/IP / Rede')return {...base,applicable:false,communication:'not_applicable',detail:'Presença PnP local não aplicável a esta conexão de rede.'};
  if(kind==='Virtual'||kind==='Porta lógica')return {...base,applicable:false,communication:'not_applicable',detail:kind==='Virtual'?'Impressora virtual; dispositivo físico não aplicável.':'Porta lógica; presença de hardware local não aplicável.'};
  const id=comId(s.printer?.port??null);
  if(!id)return {...base,detail:kind==='USB / Local'?'Dispositivo USB não verificável: não há associação segura entre a porta do spooler e uma instância USBPRINT.':'Dispositivo físico não confirmado: tipo ou associação da porta não determinado.'};
  const inventory=s.presentDevices?.com;
  const selected={...base,associatedId:id,method:'COM extraída da porta configurada; comparação exata com PortName via SetupAPI DIGCF_PRESENT',confidence:'port' as const};
  if(!inventory||inventory.error)return {...selected,detail:`Presença de ${id} não verificável. ${inventory?.error??'Inventário SetupAPI não disponível.'}`};
  const matches=inventory.items.filter(d=>d.portName?.trim().toUpperCase()===id);
  if(matches.length>1)return {...selected,confidence:'none',detail:`Associação ambígua: mais de um dispositivo presente informa ${id}.`};
  if(matches.length===1)return {...selected,present:true,device:matches[0],detail:`${id} presente no Windows; comunicação com a impressora não confirmada.`};
  // An unreadable device PortName makes the negative result inconclusive.
  if(inventory.items.some(d=>!/^COM[1-9]\d*$/i.test(d.portName?.trim()??'')))return {...selected,detail:`Presença de ${id} não verificável: a enumeração contém PortName não determinado.`};
  return {...selected,present:false,detail:`Não foi encontrado um dispositivo correspondente à porta configurada (${id}). Possível impressora desconectada.`};
}
