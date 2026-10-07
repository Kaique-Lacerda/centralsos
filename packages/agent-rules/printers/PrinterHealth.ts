import type { PrinterDiagnosticSnapshot, PrinterNativeState, SpoolerState } from '../../contracts/printer-diagnostic';
import type { PrintJobSnapshot } from '../../contracts/machine';
import { comId, diagnosticConnection, isRemotePrinter, isRedirected, printerPresence } from './PrinterPresence';
export { comId } from './PrinterPresence';

export type HealthStatus = 'ok'|'attention'|'problem'|'unverified';
export interface HealthItem { name:string;status:HealthStatus;detail:string }
export const healthLabels:Record<HealthStatus,string> = {ok:'OK',attention:'Atenção',problem:'Problema',unverified:'Não verificado'};
export function spoolerLabel(state:SpoolerState):string { return ({1:'Parado',2:'Iniciando',3:'Parando',4:'Executando',5:'Retomando',6:'Pausando',7:'Pausado'} as Record<number,string>)[state.state??0]??'Não verificado'; }
export function spoolerStartLabel(state:SpoolerState):string { return ({0:'Boot',1:'Sistema',2:'Automático',3:'Manual',4:'Desabilitado'} as Record<number,string>)[state.startMode??-1]??'Não verificado'; }
const printerFlags:[number,string,HealthStatus][] = [
  [1,'Pausada','attention'],[2,'Erro','problem'],[4,'Excluindo','attention'],[8,'Papel preso','problem'],[0x10,'Sem papel','problem'],[0x20,'Alimentação manual','attention'],[0x40,'Problema de papel','problem'],[0x80,'Offline','problem'],[0x100,'E/S ativa','ok'],[0x200,'Ocupada','ok'],[0x400,'Imprimindo','ok'],[0x800,'Saída cheia','problem'],[0x1000,'Não disponível','problem'],[0x2000,'Aguardando','ok'],[0x4000,'Processando','ok'],[0x8000,'Inicializando','attention'],[0x10000,'Aquecendo','ok'],[0x20000,'Toner baixo','attention'],[0x40000,'Sem toner','problem'],[0x80000,'Pendente de impressão','attention'],[0x100000,'Intervenção necessária','problem'],[0x200000,'Memória insuficiente','problem'],[0x400000,'Tampa aberta','problem'],[0x800000,'Servidor desconhecido','unverified'],[0x1000000,'Economia de energia','ok'],
];
export function printerNativeHealth(printer:PrinterNativeState|null):HealthItem {
  if (!printer) return {name:'Impressora',status:'unverified',detail:'Estado não consultado.'};
  const flags=printerFlags.filter(([bit])=>(printer.statusBits&bit)!==0);
  if (printer.attributes&0x400) flags.push([0x400,'Configurada para trabalhar offline','attention']);
  const status=flags.some(f=>f[2]==='problem')?'problem':flags.some(f=>f[2]==='attention')?'attention':flags.some(f=>f[2]==='unverified')||!flags.length?'unverified':'ok';
  return {name:'Impressora',status,detail:flags.length?flags.map(f=>f[1]).join(' · '):'Estado não informado pelo driver.'};
}
export function jobProblems(job:PrintJobSnapshot):string[] {
  if (job.statusBits===undefined) return [];
  return ([[2,'Erro'],[0x20,'Offline'],[0x40,'Sem papel'],[0x200,'Bloqueado pelo driver'],[0x400,'Intervenção necessária']] as [number,string][]).filter(([bit])=>(job.statusBits!&bit)!==0).map(([,label])=>label);
}
export function jobStateLabels(job:PrintJobSnapshot):string[] {
  return [...jobProblems(job),...((job.statusBits??0)&1?['Pausado']:[])] ;
}
function usbIdentity(value:string|null):string|null { const match=value?.match(/VID_([0-9A-F]{4}).*PID_([0-9A-F]{4})/i);return match?`${match[1]}:${match[2]}`.toUpperCase():null; }
export function diagnosePort(snapshot:PrinterDiagnosticSnapshot) {
  const configured=snapshot.printer?.port?.split(',').map(s=>s.trim()).filter(Boolean)??[];
  const registered=configured.length&&!snapshot.ports.error?configured.every(name=>snapshot.ports.items.some(p=>p.name.toLowerCase()===name.toLowerCase())):null;
  const com=configured.length===1?comId(configured[0]):null;
  const serial=com&&!snapshot.serial.error?snapshot.serial.items.find(p=>p.deviceId?.toUpperCase()===com):null;
  const presence=printerPresence(snapshot);
  const serialMissing=!!com&&presence.present===false;
  const code=presence.device?.configManagerErrorCode??serial?.configManagerErrorCode;
  const serialFault=presence.present===true&&code!=null&&code!==0;
  const mismatch=!isRedirected(snapshot)&&(registered===false||serialMissing);
  const identity=usbIdentity(snapshot.driver?.hardwareId??null);
  // VID/PID + a healthy enumerated device + an actual registered print port.
  // Friendly names and the mere presence of a COM port are insufficient.
  const candidates=presence.applicable&&!snapshot.ports.error&&!snapshot.presentDevices?.com.error&&identity?snapshot.ports.items.filter(port=>{
    const id=comId(port.name);const matches=snapshot.presentDevices?.com.items.filter(d=>d.portName?.toUpperCase()===id)??[];
    return !!id&&matches.length===1&&matches[0].configManagerErrorCode===0&&usbIdentity(matches[0].instanceId)===identity;
  }):[];
  const options=snapshot.ports.error?[]:snapshot.ports.items.filter(p=>comId(p.name));
  const tcp=configured.length===1?snapshot.tcp.items.find(p=>p.name.toLowerCase()===configured[0].toLowerCase())??null:null;
  const health:HealthItem=isRedirected(snapshot)?{name:'Porta',status:'unverified',detail:'Registro de porta no host não confirma o transporte de uma fila Terminal Services.'}:{name:'Porta',status:registered===null?'unverified':registered===false?'attention':'ok',detail:registered===null?snapshot.ports.error||'Porta não informada.':registered===false?'PORT_MISMATCH · Possível configuração de porta incorreta: porta não registrada.':'Porta registrada no spooler. Isso não confirma presença de dispositivo ou comunicação física.'};
  return {configured,registered,serial,serialMissing,serialFault,mismatch,candidates,options,tcp,health,presence};
}
export function printerAccessLabel(error:string|null):string {
  const code=Number(error?.match(/(?:código Windows: |Windows )(\d+)/)?.[1]);
  if (code===5) return 'Acesso negado'; if (code===1722||code===53) return 'Servidor indisponível';if (code===1801||code===1802) return 'Fila indisponível';return 'Estado não conhecido';
}
export function diagnosePrinter(snapshot:PrinterDiagnosticSnapshot):HealthItem[] {
  const port=diagnosePort(snapshot);
  const remote=isRemotePrinter(snapshot);const redirected=isRedirected(snapshot);
  const connection:HealthItem={name:'Conexão',status:snapshot.printer?'unverified':'problem',detail:snapshot.printer?(redirected?'Atributo Terminal Services presente; fila redirecionada. Hardware não verificável neste host.':remote?'Acesso à fila remota confirmado por OpenPrinter; o dispositivo físico não foi confirmado.':port.tcp?`TCP/IP configurado: ${port.tcp.hostAddress??'?'}:${port.tcp.portNumber??'?'}. Disponibilidade física não confirmada.`:port.presence.detail):`${printerAccessLabel(snapshot.printerError)}. ${snapshot.printerError??''}`};
  const device:HealthItem={name:'Dispositivo',status:port.presence.present===false?'attention':port.serialFault?'problem':port.presence.present===true?'ok':'unverified',detail:port.serialFault?`Dispositivo ${port.presence.associatedId} presente, com ConfigManagerErrorCode ${port.presence.device?.configManagerErrorCode??port.serial?.configManagerErrorCode}.`:port.presence.detail};
  const errors=snapshot.queue.items.filter(j=>jobProblems(j).length);
  const paused=snapshot.queue.items.filter(j=>((j.statusBits??0)&1)!==0);
  const unknownJobs=snapshot.queue.items.some(j=>j.statusBits===undefined);
  const queue:HealthItem={name:'Fila',status:snapshot.queue.error?'unverified':errors.length?'problem':paused.length?'attention':unknownJobs?'unverified':'ok',detail:snapshot.queue.error??`${snapshot.queue.items.length} trabalhos · ${errors.length} com erro/bloqueio · ${paused.length} pausados`};
  const spooler:HealthItem={name:'Spooler local',status:snapshot.spooler.error||snapshot.spooler.state==null?'unverified':snapshot.spooler.state===4?'ok':snapshot.spooler.state===1?'problem':'attention',detail:`${spoolerLabel(snapshot.spooler)} · ${spoolerStartLabel(snapshot.spooler)}${remote?' (o serviço do servidor não foi consultado)':''}`};
  const missing=[2,126,1797].includes(snapshot.driverError?.code??0)||!!snapshot.printer&&!snapshot.printer.driver;
  const driver:HealthItem={name:'Driver',status:snapshot.driver?'ok':missing?'problem':'unverified',detail:snapshot.driver?`${snapshot.driver.name??snapshot.printer?.driver??'Nome não informado'} · ${snapshot.driver.version??'Versão não informada'} · ${snapshot.driver.environment??'Arquitetura não informada'}`:snapshot.driverError?.code===5?'Acesso ao driver negado.':snapshot.driverError?.message??'Driver não informado.'};
  return [connection,port.health,device,queue,spooler,driver,printerNativeHealth(snapshot.printer)];
}
// Card health concerns this connection type; it never equates EnumPorts with
// presence, or presence of a serial adapter with successful printing.
export function printerSummaryHealth(s:PrinterDiagnosticSnapshot):{status:HealthStatus;label:string;description:string} {
  const items=diagnosePrinter(s);const p=diagnosePort(s);const redirected=isRedirected(s);const remote=isRemotePrinter(s);
  const faults=items.filter(i=>i.name!=='Conexão'&&(!(remote||redirected)||!['Spooler local','Porta'].includes(i.name)));
  const fault=faults.find(i=>i.status==='problem'||i.status==='attention');
  if(fault)return {status:fault.status,label:fault.status==='problem'?'Problema':'Atenção',description:fault.detail};
  if(!s.printer||s.queue.error||!s.driver||(!remote&&!redirected&&(p.registered!==true||s.spooler.state!==4||s.spooler.error)))return {status:'unverified',label:'Não verificado',description:'Não foi possível confirmar todos os dados necessários da fila.'};
  if(redirected)return {status:'unverified',label:'Redirecionada · hardware não verificável',description:'Fila acessível na sessão; redirecionamento/comunicação física não confirmados localmente.'};
  if(p.presence.applicable&&(p.presence.present!==true||p.presence.device?.configManagerErrorCode!==0))return {status:'attention',label:'Atenção',description:p.presence.detail};
  if(p.presence.present===true)return {status:'ok',label:'Dispositivo presente · sem erro conhecido',description:'Dispositivo correspondente presente; comunicação física com a impressora não confirmada.'};
  const kind=diagnosticConnection(s);
  return {status:'unverified',label:'Fila acessível · conexão não confirmada',description:kind==='Porta lógica'?'Fila lógica acessível; nenhum hardware local esperado.':'Nenhum erro conhecido na fila; conectividade com o destino não confirmada.'};
}
export function overallHealth(items:HealthItem[]):HealthStatus {return items.some(i=>i.status==='problem')?'problem':items.some(i=>i.status==='attention')?'attention':items.some(i=>i.status==='unverified')?'unverified':'ok';}
