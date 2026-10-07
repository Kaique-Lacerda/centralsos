import type { PrinterDiagnosticSnapshot, SpoolerActionResult } from '../../contracts/printer-diagnostic';
import type { PrintJobSnapshot, PrinterPermissionsSnapshot } from '../../contracts/machine';
import { diagnosePort, jobProblems, printerNativeHealth } from './PrinterHealth';
import { diagnosticRecord } from './PrinterDiagnosticRecord';
import { isRedirected, isRemotePrinter, printerPresence } from './PrinterPresence';
import { collectPrinterKnownIssues, needsPhysicalIntervention } from './PrinterKnownIssues';

export interface DetectedProblem { id:string;level:'critical'|'problem'|'attention';description:string }
export type RepairAction='startSpooler'|'resume'|'cancelErrors'|'restartSpooler'|'supportPermissions'|'diagnose';
export interface RepairStep {action:RepairAction;problems:DetectedProblem[];before:string;after:string;success:boolean;description:string;nativeError:string|null}
export interface PrinterRepairResult {
  status:'corrected'|'partial'|'failed'|'no_change';title:string;message:string;
  initialProblems:DetectedProblem[];remainingProblems:DetectedProblem[];steps:RepairStep[];
  snapshot:PrinterDiagnosticSnapshot|null;removedJobs:number;
}
export interface AutoFixClient {
  getDiagnostic:(name:string)=>Promise<PrinterDiagnosticSnapshot>;
  startSpooler:()=>Promise<SpoolerActionResult>;restartSpooler:()=>Promise<SpoolerActionResult>;
  resume:(name:string)=>Promise<void>;cancelProblemJob:(name:string,id:number)=>Promise<boolean>;
  getPermissions?:(name:string)=>Promise<PrinterPermissionsSnapshot>;
  configurePermissions?:(name:string)=>Promise<void>;
}
export function isProblemJob(job:PrintJobSnapshot):boolean {
  // Only ERROR / BLOCKED_DEVQ can justify targeted automatic cancellation.
  // Waiting for paper, offline hardware or a human is not a corrupt job.
  return jobProblems(job).length>0 && !!((job.statusBits??0)&(2|0x200)) && ((job.statusBits??0)&(1|4|0x20|0x40|0x80|0x100|0x400|0x1000|0x2000))===0;
}
export function detectPrinterProblems(s:PrinterDiagnosticSnapshot):DetectedProblem[] {
  const found:DetectedProblem[]=collectPrinterKnownIssues(s).map(issue=>({id:issue.id,level:issue.severity==='error'?'problem':'attention',description:issue.description}));
  const add=(id:string,level:DetectedProblem['level'],description:string)=>found.push({id,level,description});
  const localService=!isRemotePrinter(s)&&!isRedirected(s);
  if(localService&&(s.spooler.error||s.spooler.state==null))add('spooler_unknown','attention','Não foi possível verificar o serviço de impressão.');
  const port=diagnosePort(s);
  if(port.presence.applicable&&port.presence.present===null)add('device_unconfirmed','attention',port.presence.detail);
  const state=printerNativeHealth(s.printer);
  if(state.status==='unverified')add('state_unknown','attention','Estado não informado pelo driver.');
  if(!s.driver?.version)add('driver_version_unknown','attention','Versão do driver não verificada.');
  add('physical_unconfirmed','attention','A disponibilidade física da impressora não foi confirmada.');
  return found.sort((a,b)=>({critical:0,problem:1,attention:2}[a.level]-{critical:0,problem:1,attention:2}[b.level]));
}
export function knownPrinterProblems(s:PrinterDiagnosticSnapshot):DetectedProblem[] {return detectPrinterProblems(s).filter(p=>p.level!=='attention');}
function remote(s:PrinterDiagnosticSnapshot,name:string,remoteHint:boolean):boolean {return remoteHint||name.startsWith('\\\\')||!!s.printer?.server||!!((s.printer?.attributes??0)&0x10);}
export function automaticRepairPlan(s:PrinterDiagnosticSnapshot,name:string,remoteHint=false):RepairAction[] {
  if(needsPhysicalIntervention(s))return [];
  const plan:RepairAction[]=[];
  if(s.spooler.state===1&&s.isElevated&&s.spooler.startMode!==4&&!remote(s,name,remoteHint)&&!isRedirected(s))plan.push('startSpooler');
  if((s.printer?.statusBits??0)&1)plan.push('resume');
  if(!s.queue.error&&s.queue.items.some(isProblemJob))plan.push('cancelErrors');
  // Restart is evaluated AFTER cancellation, never preselected just because
  // a queue contains errors. Port/ACL/global deletion are not blind plan steps.
  return plan;
}
export function shouldRestartSpooler(s:PrinterDiagnosticSnapshot,name:string,remoteHint=false):boolean {
  const hardwareFault=printerNativeHealth(s.printer).status==='problem'||!!((s.printer?.attributes??0)&0x400);
  // A running SCM service plus persistent jobs does not prove a stuck Spooler.
  // Actual SCM PAUSED is positive service evidence; never infer it from job age.
  return !needsPhysicalIntervention(s)&&!isRedirected(s)&&s.spooler.state===7&&!s.spooler.error&&s.spooler.startMode!==4&&s.isElevated&&!remote(s,name,remoteHint)&&!hardwareFault;
}
function accessDenied(error:unknown):boolean {
  const text=String(error);
  return /(?:código Windows: |Windows )(5)(?:\D|$)/.test(text)||text==='O Windows negou acesso à impressora.';
}
export function canRepairSupportPermissions(s:PrinterDiagnosticSnapshot,acl:PrinterPermissionsSnapshot,required:'managePrinter'|'manageDocuments',name:string,remoteHint=false):boolean {
  if(printerPresence(s).present===false||!s.isElevated||remote(s,name,remoteHint)||isRedirected(s)||acl.state!=='available')return false;
  // Access denial alone is not permission diagnosis. Require an interpretable
  // direct Everyone allow, missing the specific right; reject denies, inherited
  // or special entries whose effective rights cannot safely be inferred here.
  if(acl.entries.some(e=>e.accessType!=='Permitir'||!e.permissions||e.inherited||e.specialPermissions))return false;
  const everyone=acl.entries.filter(e=>e.sid==='S-1-1-0');
  return everyone.length===1&&everyone[0].editable&&everyone[0].permissions?.[required]===false;
}

export async function runPrinterAutoFix(client:AutoFixClient,name:string,options:{remoteHint?:boolean;settle?:()=>Promise<void>}={}):Promise<PrinterRepairResult> {
  const settle=options.settle??(()=>new Promise(resolve=>setTimeout(resolve,250)));
  const steps:RepairStep[]=[];let current:PrinterDiagnosticSnapshot;
  try{current=await client.getDiagnostic(name);}catch(error){return {status:'failed',title:'Não foi possível corrigir automaticamente',message:'Não foi possível verificar esta impressora. Consulte os detalhes.',initialProblems:[],remainingProblems:[],snapshot:null,removedJobs:0,steps:[{action:'diagnose',problems:[],before:'Não verificado',after:'Não verificado',success:false,description:'Diagnóstico inicial indisponível.',nativeError:String(error)}]};}
  const initialProblems=detectPrinterProblems(current);let removedJobs=0;let permissionsAttempted=false;let verified=true;
  const remoteHint=options.remoteHint??false;
  const observe=async(test:(s:PrinterDiagnosticSnapshot)=>boolean)=>{
    for(let i=0;i<3;i++){await settle();current=await client.getDiagnostic(name);if(test(current))return true;}
    return false;
  };
  const repairPermissions=async(required:'managePrinter'|'manageDocuments',error:unknown)=>{
    if(permissionsAttempted||!accessDenied(error)||!client.getPermissions||!client.configurePermissions)return false;
    const acl=await client.getPermissions(name);if(!canRepairSupportPermissions(current,acl,required,name,remoteHint))return false;
    permissionsAttempted=true;const before=JSON.stringify({diagnostic:current,acl});let success=false;let nativeError:string|null=null;let after='Não verificado';
    try{await client.configurePermissions(name);current=await client.getDiagnostic(name);const finalAcl=await client.getPermissions(name);after=JSON.stringify({diagnostic:current,acl:finalAcl});success=true;}catch(failure){nativeError=String(failure);}
    steps.push({action:'supportPermissions',problems:[{id:'support_permissions',level:'problem',description:'Acesso negado e direito ausente no baseline direto de Todos.'}],before,after,success,description:success?'Permissões padrão de suporte reaplicadas e verificadas pelo Windows.':'Não foi possível confirmar a reaplicação das permissões padrão.',nativeError});
    return success;
  };
  const action=async(id:RepairAction,work:()=>Promise<void>,test:(s:PrinterDiagnosticSnapshot)=>boolean,description:string,right?:'managePrinter'|'manageDocuments')=>{
    const before=diagnosticRecord(current);const problems=detectPrinterProblems(current);let error:string|null=null;let accepted=false;
    try{try{await work();accepted=true;}catch(failure){if(right&&await repairPermissions(right,failure)){await work();accepted=true;}else throw failure;}}
    catch(failure){error=String(failure);}
    let confirmed=false;
    try{confirmed=await observe(test);}catch(failure){verified=false;error=`${error??''} Leitura final: ${String(failure)}`;}
    steps.push({action:id,problems,before,after:verified?diagnosticRecord(current):'Estado final não confirmado',success:accepted&&confirmed,description:accepted&&confirmed?description:accepted?'Operação aceita, mas alteração ainda não confirmada.':'Não foi possível executar esta correção.',nativeError:error});
    return accepted&&confirmed;
  };
  if(automaticRepairPlan(current,name,remoteHint).includes('startSpooler')) {
    if(!await action('startSpooler',async()=>{await client.startSpooler();},s=>s.spooler.state===4,'Serviço de impressão iniciado.'))return finish();
  }
  if(verified&&automaticRepairPlan(current,name,remoteHint).includes('resume'))await action('resume',()=>client.resume(name),s=>!!s.printer&&!(s.printer.statusBits&1),'Impressora retomada.','managePrinter');
  if(verified&&automaticRepairPlan(current,name,remoteHint).includes('cancelErrors')) {
    const targets=current.queue.items.filter(isProblemJob);const acceptedIds:number[]=[];
    await action('cancelErrors',async()=>{
      const errors:string[]=[];
      for(const job of targets)try{
        let accepted:boolean;try{accepted=await client.cancelProblemJob(name,job.jobId);}catch(error){if(await repairPermissions('manageDocuments',error))accepted=await client.cancelProblemJob(name,job.jobId);else throw error;}
        if(accepted)acceptedIds.push(job.jobId);
      }catch(error){errors.push(`#${job.jobId}: ${String(error)}`);}
      if(errors.length)throw new Error(errors.join('; '));
    },s=>!s.queue.error&&targets.every(j=>!s.queue.items.some(now=>now.jobId===j.jobId&&isProblemJob(now))),'Trabalhos problemáticos verificados novamente.');
    removedJobs=acceptedIds.filter(id=>!current.queue.error&&!current.queue.items.some(j=>j.jobId===id)).length;
    const step=[...steps].reverse().find(s=>s.action==='cancelErrors')!;
    if(removedJobs)step.description=`${removedJobs} ${removedJobs===1?'trabalho problemático removido':'trabalhos problemáticos removidos'}.`;
  }
  if(verified&&shouldRestartSpooler(current,name,remoteHint))await action('restartSpooler',async()=>{await client.restartSpooler();},s=>s.spooler.state===4,'Serviço de impressão reiniciado.');
  try{await settle();current=await client.getDiagnostic(name);verified=true;}catch(error){verified=false;steps.push({action:'diagnose',problems:[],before:diagnosticRecord(current),after:'Não verificado',success:false,description:'Não foi possível confirmar o diagnóstico final.',nativeError:String(error)});}
  return finish();

  function finish():PrinterRepairResult {
    const remainingProblems=detectPrinterProblems(current);const remaining=remainingProblems.filter(p=>p.level!=='attention');
    const successes=steps.filter(s=>s.success);const hasFailure=steps.some(s=>!s.success);
    const wasProblem=initialProblems.some(p=>p.level!=='attention');
    const status=!verified?(successes.length?'partial':'failed'):!remaining.length&&!hasFailure?(wasProblem?'corrected':'no_change'):successes.length||removedJobs?'partial':'failed';
    const issues=collectPrinterKnownIssues(current);
    const pendingIssue=issues.find(issue=>issue.physicalIntervention||issue.requiresConfirmation||issue.severity==='error'||issue.id==='WORK_OFFLINE');
    const title=verified&&pendingIssue?.id==='DEVICE_NOT_PRESENT'?'Impressora desconectada':verified&&pendingIssue?.physicalIntervention?'Intervenção necessária':status==='corrected'?'Problema corrigido':status==='partial'?'Correção parcial':status==='no_change'&&pendingIssue?'Intervenção necessária':status==='no_change'?'Nenhum problema encontrado':'Não foi possível corrigir automaticamente';
    const done=successes.map(s=>s.description).join(' ')+(removedJobs&&!successes.some(s=>s.action==='cancelErrors')?` ${removedJobs} trabalhos problemáticos removidos.`:'');
    const pending=!verified?'O estado final não pôde ser confirmado.':current.spooler.state===1&&!current.isElevated&&!remote(current,name,remoteHint)?'Para iniciar o serviço de impressão, abra a CENTRAL SOS como administrador.':pendingIssue?[pendingIssue.description,pendingIssue.suggestedAction].join('. '):remaining[0]?.description??(hasFailure?'Uma operação não pôde ser confirmada.':'');
    return {status,title,message:[done,pending].filter(Boolean).join(' ')||(status==='no_change'?'Nenhuma alteração foi necessária.':'O problema não apareceu na verificação final.'),initialProblems,remainingProblems,steps,snapshot:verified?current:null,removedJobs};
  }
}
