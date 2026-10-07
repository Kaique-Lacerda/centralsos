import type { PrinterDiagnosticSnapshot, SpoolerActionResult } from '../../../packages/contracts/printer-diagnostic';
import { jobProblems } from '../../../packages/agent-rules/printers/PrinterHealth';
import { diagnosticRecord } from '../../../packages/agent-rules/printers/PrinterDiagnosticRecord';
export { diagnosticRecord } from '../../../packages/agent-rules/printers/PrinterDiagnosticRecord';

export type CorrectionId='startSpooler'|'restartSpooler'|'resume'|'cancelErrors'|'clearQueue';
export interface CorrectionOption {id:CorrectionId;label:string;selected:boolean;available:boolean;notice:string}
export function correctionOptions(s:PrinterDiagnosticSnapshot):CorrectionOption[] {
  const spooler=s.spooler.state;const paused=!!((s.printer?.statusBits??0)&1);const errors=s.queue.items.some(j=>jobProblems(j).length);
  return [
    {id:'startSpooler',label:'Iniciar Spooler local',selected:spooler===1&&s.isElevated,available:spooler===1&&s.isElevated&&s.spooler.startMode!==4,notice:'Exige administrador. Não habilita serviço desabilitado.'},
    {id:'restartSpooler',label:'Reiniciar Spooler local',selected:false,available:spooler===4&&s.isElevated,notice:'Interrompe temporariamente a impressão de TODAS as filas locais. Não limpa a pasta de spool.'},
    {id:'resume',label:'Retomar esta impressora',selected:paused,available:paused,notice:'Apenas a fila selecionada.'},
    {id:'cancelErrors',label:'Cancelar trabalhos com erro/bloqueio',selected:false,available:!s.queue.error&&errors,notice:'Somente jobs com estados nativos de erro, offline, sem papel, bloqueio ou intervenção.'},
    {id:'clearQueue',label:'Limpar fila desta impressora',selected:false,available:!s.queue.error&&s.queue.items.length>0,notice:'Remove TODOS os trabalhos desta fila. A confirmação do plano autoriza esta remoção.'},
  ];
}
export interface CorrectionReport {action:string;before:string;after:string;success:boolean;result:string}
export function canConfirmSpoolerAction(action:'start'|'restart'|'reset',confirmed:boolean,phrase:string):boolean {
  return confirmed&&(action!=='reset'||phrase==='REDEFINIR');
}
export interface CorrectionClient {
  getDiagnostic:(name:string)=>Promise<PrinterDiagnosticSnapshot>;startSpooler:()=>Promise<SpoolerActionResult>;restartSpooler:()=>Promise<SpoolerActionResult>;
  resume:(name:string)=>Promise<void>;cancelJob:(name:string,id:number)=>Promise<void>;
  clearQueue:(name:string)=>Promise<{removedCount:number;failedJobIds:number[]}>;
}
export async function executeCorrections(client:CorrectionClient,name:string,selected:CorrectionId[],confirmed:boolean) {
  if(!confirmed)throw new Error('Confirme o plano de correção antes de executar.');
  const reports:CorrectionReport[]=[];
  let current=await client.getDiagnostic(name);
  // Never execute stale checkbox choices without checking the current diagnostic.
  const allowed=correctionOptions(current);
  const unique=[...new Set(selected)].filter(id=>allowed.some(o=>o.id===id&&o.available));
  for(const id of ['startSpooler','restartSpooler','resume','cancelErrors','clearQueue'] as CorrectionId[]) {
    if(!unique.includes(id)||id==='cancelErrors'&&unique.includes('clearQueue'))continue;
    const before=diagnosticRecord(current);let success=true;let result='Operação aceita pelo Windows.';
    const targets=(id==='cancelErrors'?current.queue.items.filter(j=>jobProblems(j).length):id==='clearQueue'?current.queue.items:[]).map(j=>j.jobId);
    try {
      if(id==='startSpooler')await client.startSpooler();
      else if(id==='restartSpooler')await client.restartSpooler();
      else if(id==='resume')await client.resume(name);
      else if(id==='clearQueue'){const r=await client.clearQueue(name);result=`${r.removedCount} solicitações de remoção aceitas; ${r.failedJobIds.length} falhas.`;success=r.failedJobIds.length===0;}
      else {const jobs=current.queue.items.filter(j=>jobProblems(j).length);const failures:string[]=[];let removed=0;
        for(const job of jobs)try{await client.cancelJob(name,job.jobId);removed++;}catch(e){failures.push(`#${job.jobId}: ${String(e)}`);}
        result=`${removed} cancelamentos aceitos.${failures.length?' Falhas: '+failures.join('; '):''}`;success=!failures.length;
      }
    }catch(error){success=false;result=String(error);}
    let after='Estado final não confirmado.';
    try {
      current=await client.getDiagnostic(name);after=diagnosticRecord(current);
      if(id==='resume'&&(!current.printer||!!(current.printer.statusBits&1))) {success=false;result+=' Retomada não confirmada no estado final.';}
      if((id==='startSpooler'||id==='restartSpooler')&&current.spooler.state!==4) {success=false;result+=' Spooler em execução não confirmado.';}
      if(targets.length&&(current.queue.error||targets.some(target=>current.queue.items.some(j=>j.jobId===target)))) {success=false;result+=' Remoção ainda não confirmada na fila; atualize para verificar o processamento do Windows.';}
    }catch(error){success=false;result+=` Leitura final: ${String(error)}`;}
    reports.push({action:allowed.find(o=>o.id===id)!.label,before,after,success,result});
    if(!success&&(id==='startSpooler'||id==='restartSpooler'))break;
  }
  return {reports,snapshot:current};
}
