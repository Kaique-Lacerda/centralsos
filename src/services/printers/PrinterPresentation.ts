import type { PrinterDiagnosticSnapshot } from '../../types/printer-diagnostic';
import { automaticRepairPlan, isProblemJob, shouldRestartSpooler } from './PrinterAutoFix';
import { diagnosePort, diagnosePrinter, printerNativeHealth, printerSummaryHealth } from './PrinterHealth';
import { diagnosticConnection, isRemotePrinter, isRedirected, isVirtualPrinter } from './PrinterPresence';
import { collectPrinterKnownIssues } from './PrinterKnownIssues';

export type PrinterPrimaryStatus='ok'|'disconnected'|'attention'|'error'|'paused'|'offline'|'unknown';
export type PrinterPresentationTone='success'|'warning'|'error'|'unknown';
export interface PrinterPresentationState {
  primaryStatus:PrinterPrimaryStatus;primaryLabel:string;statusIcon:string;tone:PrinterPresentationTone;
  connectionLabel:string;destination:string|null;
  portSummary:{value:string;registration:string};
  deviceSummary:{value:string;presence:string;visible:boolean};
  queueSummary:{value:string;notice:string|null};recommendedAction:string|null;autoFixAvailable:boolean;
}
const statuses:Record<PrinterPrimaryStatus,{label:string;icon:string;tone:PrinterPresentationTone}>={
  ok:{label:'OK',icon:'✓',tone:'success'},disconnected:{label:'Desconectada',icon:'⚠',tone:'warning'},
  attention:{label:'Atenção',icon:'⚠',tone:'warning'},error:{label:'Erro',icon:'✕',tone:'error'},
  paused:{label:'Pausada',icon:'⏸',tone:'warning'},offline:{label:'Offline',icon:'●',tone:'error'},
  unknown:{label:'Estado desconhecido',icon:'?',tone:'unknown'},
};
export function presentPrinter(s:PrinterDiagnosticSnapshot|null,name='',remoteHint=false):PrinterPresentationState {
  if(!s)return {primaryStatus:'unknown',primaryLabel:'Estado desconhecido',statusIcon:'?',tone:'unknown',connectionLabel:'Não identificado',destination:null,
    portSummary:{value:'Não informada',registration:'Não verificada'},deviceSummary:{value:'Não identificado',presence:'Não verificado',visible:true},queueSummary:{value:'Não verificada',notice:null},recommendedAction:null,autoFixAvailable:false};
  const port=diagnosePort(s);const kind=diagnosticConnection(s);const redirected=isRedirected(s);const remote=isRemotePrinter(s);
  const virtual=isVirtualPrinter(s);const native=printerNativeHealth(s.printer);
  const health=diagnosePrinter(s);const badJobs=s.queue.items.filter(isProblemJob).length;
  const knownIssues=collectPrinterKnownIssues(s);
  const driverHealth=health.find(i=>i.name==='Driver');
  const ready=!!s.printer&&!s.printerError&&!s.queue.error&&!!s.driver;
  const localServiceReady=s.spooler.state===4&&!s.spooler.error;
  const remoteDestination=s.printer?.server&&s.printer.shareName?`\\\\${s.printer.server.replace(/^\\+/, '')}\\${s.printer.shareName.replace(/^\\+/, '')}`:
    /^\\\\[^\\]+\\[^\\]+$/.test(s.printer?.name??'')?s.printer!.name:null;
  let state:PrinterPrimaryStatus='unknown';
  // Missing associated hardware must not be hidden behind an accessible queue.
  if(port.presence.present===false)state='disconnected';
  else if(knownIssues.some(issue=>issue.id==='PRINTER_OFFLINE')||!!((s.printer?.attributes??0)&0x400))state='offline';
  else if(knownIssues.some(issue=>issue.id==='PRINTER_PAUSED'))state='paused';
  else if(knownIssues.some(issue=>issue.severity==='error'))state='error';
  else if(s.printerError||s.queue.error||badJobs||native.status==='problem'||driverHealth?.status==='problem'||port.serialFault)state='error';
  else if(!remote&&!redirected&&s.spooler.state===1)state='error';
  else if(!remote&&!redirected&&!virtual&&port.registered===false)state='attention';
  else if(!ready||health.find(i=>i.name==='Fila')?.status==='unverified'||(!remote&&!redirected&&!localServiceReady))state='unknown';
  else if(knownIssues.some(issue=>issue.severity==='warning')||native.status==='attention'||s.queue.items.some(j=>!!((j.statusBits??0)&1)))state='attention';
  else if(virtual)state='ok';
  else if(remote)state=remoteDestination?'ok':'attention';
  else if(kind==='TCP/IP / Rede')state=port.tcp?.hostAddress&&port.tcp.portNumber&&[1,2].includes(port.tcp.protocol??0)?'ok':'attention';
  // The TS bit identifies a redirected queue, not a live transport to hardware.
  else if(redirected)state=native.status==='ok'?'ok':'unknown';
  else if(printerSummaryHealth(s).status==='ok')state='ok';
  else state=port.presence.applicable?'attention':'unknown';
  const labels=statuses[state];
  const connectionLabel=virtual?'Virtual':redirected?'Redirecionada':remote||kind==='TCP/IP / Rede'?'Rede':kind==='COM / Local'?'COM / Local':kind==='USB / Local'?'USB / Local':kind==='Porta lógica'?'Lógica':'Local';
  const destination=remote?remoteDestination:port.tcp?.hostAddress??null;
  return {primaryStatus:state,primaryLabel:labels.label,statusIcon:labels.icon,tone:labels.tone,connectionLabel,destination,
    portSummary:{value:s.printer?.port??'Não informada',registration:port.registered===true?'✓ Registrada':port.registered===false?'✕ Não registrada':'Não verificada'},
    deviceSummary:{value:port.presence.associatedId??(virtual?'Hardware':'Não identificado'),presence:!port.presence.applicable?'Não aplicável':port.presence.present===true?'✓ Presente':port.presence.present===false?'✕ Não presente':'Não verificado',visible:port.presence.applicable||virtual},
    queueSummary:{value:s.queue.error?'Não acessível':s.queue.items.length?`${s.queue.items.length} ${s.queue.items.length===1?'trabalho':'trabalhos'}`:'Nenhum trabalho',notice:!s.queue.error&&badJobs?`⚠ ${badJobs} com erro`:null},
    recommendedAction:state==='disconnected'?'Conecte a impressora.':knownIssues[0]&&!knownIssues[0].autoFix?knownIssues[0].suggestedAction:null,
    autoFixAvailable:automaticRepairPlan(s,name||s.printer?.name||'',remoteHint).length>0||shouldRestartSpooler(s,name||s.printer?.name||'',remoteHint),
  };
}
export function summarizePrinterPresentation(states:PrinterPresentationState[]) {
  return {available:states.filter(s=>s.primaryStatus==='ok').length,attention:states.filter(s=>['attention','disconnected','paused','offline','error'].includes(s.primaryStatus)).length,unknown:states.filter(s=>s.primaryStatus==='unknown').length};
}
