import { useRef, useState, type ReactNode } from 'react';
import type { PrinterDiagnosticSnapshot } from '../../packages/contracts/printer-diagnostic';
import { PrinterService } from '../services/printers/PrinterService';
import { diagnosePort,diagnosePrinter,healthLabels,spoolerLabel,spoolerStartLabel,comId } from '../../packages/agent-rules/printers/PrinterHealth';
import { canConfirmSpoolerAction,diagnosticRecord } from '../services/printers/PrinterCorrections';
import { type PrinterRepairResult } from '../../packages/agent-rules/printers/PrinterAutoFix';
import { presentPrinter } from '../services/printers/PrinterPresentation';
import { collectPrinterKnownIssues } from '../../packages/agent-rules/printers/PrinterKnownIssues';

export function PrinterDiagnosticsPanel({name,snapshot,busy,refresh,changed,details,actions,onRepairBusy,remoteHint=false}:{
  name:string;snapshot:PrinterDiagnosticSnapshot|null;busy:boolean;refresh:()=>Promise<void>;
  changed:(snapshot:PrinterDiagnosticSnapshot)=>Promise<void>;details?:ReactNode;
  actions?:ReactNode;
  onRepairBusy?:(busy:boolean)=>void;remoteHint?:boolean;
}) {
  const [acting,setActing]=useState(false);const running=useRef(false);
  const [repairResult,setResult]=useState<PrinterRepairResult|null>(null);
  const [detailsOpen,setDetailsOpen]=useState(false);const [portChoice,setPortChoice]=useState('');
  const [portMessage,setPortMessage]=useState('');const [portRecord,setPortRecord]=useState('');
  const [probe,setProbe]=useState('');
  const port=snapshot?diagnosePort(snapshot):null;
  const presentation=presentPrinter(snapshot,name,remoteHint);
  // A subsequent presence change invalidates an earlier repair conclusion.
  const result=repairResult&&(!snapshot||!repairResult.snapshot||diagnosticRecord(snapshot)===diagnosticRecord(repairResult.snapshot))?repairResult:null;
  const intervention=!!result&&/Intervenção|desconectada/.test(result.title);
  const knownIssues=snapshot?collectPrinterKnownIssues(snapshot):[];
  const health=snapshot?diagnosePrinter(snapshot):[];
  const uniquePort=port?.mismatch&&port.candidates.length===1&&port.candidates[0].name.toLowerCase()!==snapshot?.printer?.port?.toLowerCase()?port.candidates[0]:null;
  const repair=async()=>{
    if(running.current)return;running.current=true;setActing(true);onRepairBusy?.(true);setResult(null);
    try{const next=await PrinterService.repair(name,remoteHint);setResult(next);if(next.snapshot)await changed(next.snapshot);}
    catch(error){setResult({status:'failed',title:'Não foi possível corrigir automaticamente',message:'Consulte os detalhes para investigar esta impressora.',snapshot:null,removedJobs:0,initialProblems:[],remainingProblems:[],steps:[{action:'diagnose',problems:[],before:'Não verificado',after:'Não verificado',success:false,description:'Falha durante a verificação.',nativeError:String(error)}]});}
    finally{running.current=false;setActing(false);onRepairBusy?.(false);}
  };
  const changePort=async()=>{
    if(!snapshot||!portChoice||running.current)return;running.current=true;setActing(true);onRepairBusy?.(true);setPortMessage('');
    let before=diagnosticRecord(snapshot);let after='Não verificado';let message='Porta alterada e confirmada.';let success=false;
    try{const current=await PrinterService.getDiagnostic(name);before=diagnosticRecord(current);
      if(!current.printer||current.printer.port!==snapshot.printer?.port)throw new Error('A porta atual mudou ou não pôde ser confirmada. Atualize o diagnóstico.');
      await PrinterService.setPort(name,portChoice);const next=await PrinterService.getDiagnostic(name);after=diagnosticRecord(next);
      success=next.printer?.port?.toLowerCase()===portChoice.toLowerCase();if(!success)message='O Windows aceitou a operação, mas a mudança não foi confirmada.';
      await changed(next);
    }catch(error){message='Não foi possível alterar a porta. Consulte os detalhes.';after=String(error);}
    finally{setPortMessage(message);setPortRecord(JSON.stringify({action:'Alterar porta',before,after,success,result:message},null,2));setPortChoice('');running.current=false;setActing(false);onRepairBusy?.(false);}
  };
  const testTcp=async()=>{setActing(true);try{const value=await PrinterService.probeConnection(name);setProbe(value.host+':'+value.port+' · '+value.detail);}catch(error){setProbe(String(error));}finally{setActing(false);}};
  return <section className="printer-diagnosis printer-auto-fix">
    <div className="printer-repair-conclusion" role="status" aria-live="polite">
      {acting?<p className="printer-repair-progress"><span className="printer-repair-spinner" aria-hidden="true"/>Verificando...</p>:
       result?<><b className={'printer-repair-result '+(intervention?'intervention':result.status)}>{intervention?'⚠':result.status==='corrected'||result.status==='no_change'?'✓':result.status==='partial'?'⚠':'✕'} {result.title}</b><p>{result.message}</p></>:
       presentation.recommendedAction?<small>{presentation.recommendedAction}</small>:null}
    </div>
    <div className="printer-actions"><button className="primary printer-fix-now" disabled={busy||acting} onClick={()=>void repair()}>Verificar e corrigir</button>{actions}</div>
    {!acting&&uniquePort&&<div className="printer-port-suggestion"><p>⚠ Possível porta incorreta</p><button className="printer-secondary-action" disabled={!snapshot?.isElevated||busy} onClick={()=>setPortChoice(uniquePort.name)}>Corrigir porta</button></div>}
    {portMessage&&<p role="status">{portMessage}</p>}
    <details className="printer-diagnostic-details" open={detailsOpen} onToggle={event=>setDetailsOpen(event.currentTarget.open)}><summary>Detalhes técnicos</summary>
      <button className="printer-secondary-action" disabled={busy||acting} onClick={()=>void refresh()}>Atualizar diagnóstico</button>
      {snapshot&&<>
        <div className="printer-technical-blocks">
          <section><h4>Conexão</h4><dl className="printer-technical-fields">
            <div><dt>Tipo</dt><dd>{presentation.connectionLabel}</dd></div>
            <div><dt>Porta configurada</dt><dd>{snapshot.printer?.port??'Não informada'}</dd></div>
            <div><dt>Porta registrada</dt><dd>{port?.registered===null?'Não verificada':port?.registered?'Sim':'Não'}</dd></div>
            <div><dt>Dispositivo associado</dt><dd>{port?.presence.associatedId??'Não determinado'}</dd></div>
            <div><dt>Presente</dt><dd>{!port?.presence.applicable?'Não aplicável':port.presence.present===true?'Sim':port.presence.present===false?'Não':'Não verificável'}</dd></div>
            <div><dt>Comunicação física</dt><dd>{port?.presence.communication==='not_applicable'?'Não aplicável / não verificável localmente':'Não confirmada'}</dd></div>
            {port?.presence.device&&<div><dt>Dispositivo Windows</dt><dd>{port.presence.device.friendlyName??'Não informado'} · ConfigManager: {port.presence.device.configManagerErrorCode??'desconhecido'}</dd></div>}
          </dl></section>
          <section><h4>Impressão</h4><dl className="printer-technical-fields">
            <div><dt>Spooler local</dt><dd>{spoolerLabel(snapshot.spooler)} · {spoolerStartLabel(snapshot.spooler)}</dd></div>
            <div><dt>Fila acessível</dt><dd>{snapshot.queue.error?'Não':'Sim'}</dd></div>
            <div><dt>Jobs</dt><dd>{snapshot.queue.error?'Não verificado':snapshot.queue.items.length}</dd></div>
            <div><dt>Pausada</dt><dd>{snapshot.printer?snapshot.printer.statusBits&1?'Sim':'Não':'Não verificado'}</dd></div>
            <div><dt>Servidor / compartilhamento</dt><dd>{snapshot.printer?.server??'Local / não informado'} · {snapshot.printer?.shareName??'Não informado'}</dd></div>
            {!!((snapshot.printer?.attributes??0)&0x8000)&&<div><dt>Redirecionamento</dt><dd>Atributo TS presente; comunicação com a sessão de origem não verificada.</dd></div>}
          </dl></section>
          <section><h4>Driver</h4><dl className="printer-technical-fields">
            <div><dt>Nome</dt><dd>{snapshot.driver?.name??snapshot.printer?.driver??'Não informado'}</dd></div>
            <div><dt>Versão</dt><dd>{snapshot.driver?.version??'Não informada'}</dd></div>
            <div><dt>Arquitetura</dt><dd>{snapshot.driver?.environment??'Não informada'}</dd></div>
          </dl>{snapshot.driverError&&<small>{snapshot.driverError.message}</small>}</section>
          <section><h4>Windows</h4><dl className="printer-technical-fields">
            <div><dt>Estado reportado</dt><dd>{health.find(item=>item.name==='Impressora')?.detail}</dd></div>
            <div><dt>Estado bruto / atributos</dt><dd>{snapshot.printer?`${snapshot.printer.statusBits} / ${snapshot.printer.attributes}`:'Não informado'}</dd></div>
            <div><dt>Origem</dt><dd>GetPrinter / EnumJobs / EnumPorts / SetupAPI / ConfigManager / WMI / SCM</dd></div>
            <div><dt>Erros WMI</dt><dd>{snapshot.deviceStatus?JSON.stringify(snapshot.deviceStatus):snapshot.deviceStatusError??'Não verificados'}</dd></div>
          </dl><details><summary>Diagnóstico e inventário completos</summary>
            <dl className="printer-health-grid">{health.map(item=><div key={item.name}><dt>{item.name} <span className={'printer-health-label '+item.status}>{healthLabels[item.status]}</span></dt><dd>{item.detail}</dd></div>)}</dl>
            <pre className="printer-raw-data">{JSON.stringify({ports:snapshot.ports,serial:snapshot.serial,tcp:snapshot.tcp,presentDevices:snapshot.presentDevices,association:port?.presence},null,2)}</pre>
          </details></section>
        </div>
        <details><summary>Evidências dos problemas conhecidos ({knownIssues.length})</summary><pre>{JSON.stringify(knownIssues,null,2)}</pre></details>
        {port?.tcp&&<><p>TCP/IP: {port.tcp.hostAddress??'?'}:{port.tcp.portNumber??'?'} · {port.tcp.protocol===1?'RAW':port.tcp.protocol===2?'LPR':'Protocolo não informado'} · Fila: {port.tcp.queue??'Não informada'} · SNMP: {port.tcp.snmpEnabled===null?'Não informado':port.tcp.snmpEnabled?'Sim':'Não'}</p><button className="printer-secondary-action" disabled={acting} onClick={()=>void testTcp()}>Testar conexão TCP configurada</button>{probe&&<p>{probe}</p>}</>}
        {port?.mismatch&&<div className="printer-port-correction"><p>{port.candidates.length>1?'Mais de uma porta compatível; escolha manual necessária.':uniquePort?'Uma correspondência de hardware disponível.':'Não há evidência suficiente para sugerir uma porta.'}</p><label>Alteração manual · exige confirmação<select value="" disabled={acting||!snapshot.isElevated} onChange={event=>setPortChoice(event.target.value)}><option value="">Selecione uma porta registrada</option>{(comId(snapshot.printer?.port??null)?port.options:snapshot.ports.items).map(p=><option key={p.name} value={p.name}>{p.name}</option>)}</select></label></div>}
      </>}
      {repairResult&&<section className="printer-correction-history"><h4>Ações realizadas</h4>{repairResult.steps.length===0?<p>Nenhuma alteração foi necessária.</p>:repairResult.steps.map((step,i)=><div key={i}><p>{step.success?'✓':'⚠'} {step.description}</p>{step.nativeError&&<p>{step.nativeError}</p>}<details><summary>Problema / antes / ação / depois</summary><pre>{JSON.stringify(step,null,2)}</pre></details></div>)}<details><summary>Problemas detectados e restantes</summary><pre>{JSON.stringify({initial:repairResult.initialProblems,remaining:repairResult.remainingProblems},null,2)}</pre></details></section>}
      {portRecord&&<pre className="printer-raw-data">{portRecord}</pre>}
      {details}
    </details>
    {portChoice&&<div className="printer-confirm-backdrop"><section className="printer-confirm" role="alertdialog" aria-modal="true" aria-label="Confirmar alteração de porta"><h3>Alterar porta?</h3><p>Configurada: <b>{snapshot?.printer?.port}</b><br/>Selecionada: <b>{portChoice}</b></p><p>A porta desta impressora será alterada. A compatibilidade física não é garantida apenas pelo cadastro.</p><div><button className="printer-secondary-action" disabled={acting} onClick={()=>setPortChoice('')}>Cancelar</button><button className="printer-danger-action" disabled={acting||!snapshot?.isElevated} onClick={()=>void changePort()}>Alterar porta</button></div></section></div>}
  </section>;
}

export function PrinterSpoolerPanel({refreshPrinters}:{refreshPrinters:()=>Promise<void>}) {
  const [state,setState]=useState<Awaited<ReturnType<typeof PrinterService.getSpooler>>|null>(null);
  const [busy,setBusy]=useState(false);const [action,setAction]=useState<'start'|'restart'|'reset'|null>(null);const [phrase,setPhrase]=useState('');const [confirmed,setConfirmed]=useState(false);const [message,setMessage]=useState('');const [report,setReport]=useState('');
  const refresh=async()=>{setBusy(true);try{setState(await PrinterService.getSpooler());}catch(e){setMessage(String(e));}finally{setBusy(false);}};
  const run=async()=>{if(!action||!canConfirmSpoolerAction(action,confirmed,phrase))return;setBusy(true);setMessage('');setReport('');const before=state?.[0]??null;let failure:string|null=null;
    try{const result=action==='reset'?await PrinterService.resetSpooler(true):action==='restart'?await PrinterService.restartSpooler():await PrinterService.startSpooler();setMessage(`${spoolerLabel(result.after)} · ${result.removedFiles} arquivos de spool removidos${result.failedFiles.length?' · Limpeza parcial: '+result.failedFiles.join('; '):''}`);setReport(JSON.stringify({action,...result},null,2));await refreshPrinters();}
    catch(e){failure=String(e);setMessage(failure);}finally{setAction(null);setConfirmed(false);setPhrase('');let after=null;try{const next=await PrinterService.getSpooler();setState(next);after=next[0];}catch{setState(null);}if(failure)setReport(JSON.stringify({action,before,after,result:failure,success:false},null,2));setBusy(false);}
  };
  return <details className="printer-spooler-panel" onToggle={e=>{if(e.currentTarget.open&&!state&&!busy)void refresh();}}><summary>Manutenção avançada · sistema de impressão</summary>
    <p>{state?`${spoolerLabel(state[0])} · Inicialização ${spoolerStartLabel(state[0])}`:'Estado ainda não consultado.'}</p>{state?.[0].error&&<p>{state[0].error}</p>}
    <button className="printer-secondary-action" disabled={busy} onClick={()=>void refresh()}>Consultar Spooler</button>
    {(['start','restart','reset'] as const).map(id=><button className={id==='reset'?'printer-danger-action':'printer-secondary-action'} key={id} disabled={busy||!state?.[1]||state[0].state==null||id==='start'&&state[0].state!==1} onClick={()=>{setAction(id);setConfirmed(false);setPhrase('');}}>{id==='start'?'Iniciar Spooler':id==='restart'?'Reiniciar Spooler':'Redefinir sistema de impressão'}</button>)}
    {state&&!state[1]&&<p>Operações exigem CENTRAL SOS executada como administrador.</p>}
    {action&&<section className="printer-correction-plan" role="alertdialog" aria-label="Confirmar operação do Spooler"><h3>{action==='reset'?'Redefinir sistema de impressão':action==='restart'?'Reiniciar Spooler local':'Iniciar Spooler local'}</h3><p>{action==='reset'?'Esta operação removerá todos os trabalhos de impressão pendentes deste computador, de TODAS as impressoras do spooler local. Somente arquivos .SPL/.SHD da pasta local fixa serão removidos.':action==='restart'?'Esta operação interrompe temporariamente a impressão de TODAS as filas locais. Não remove arquivos de spool.':'O serviço local poderá voltar a processar trabalhos.'}</p>
      {action==='reset'&&<label>Digite REDEFINIR<input value={phrase} onChange={e=>setPhrase(e.target.value)} disabled={busy}/></label>}
      <label className="printer-checkbox"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} disabled={busy}/> Confirmo a operação e seu impacto.</label><button className="printer-danger-action" disabled={busy||!canConfirmSpoolerAction(action,confirmed,phrase)} onClick={()=>void run()}>Confirmar operação</button><button className="printer-secondary-action" disabled={busy} onClick={()=>setAction(null)}>Cancelar</button>
    </section>}
    {message&&<p role="status">{message}</p>}{report&&<details><summary>Relatório: antes / ação / depois</summary><pre>{report}</pre></details>}
  </details>;
}
