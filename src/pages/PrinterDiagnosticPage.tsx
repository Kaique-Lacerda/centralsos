import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, CircleAlert, ClipboardList, FileText, Monitor, Printer, RefreshCw, Pause, Play, Star, Settings, Trash2, Save, X, Shield } from 'lucide-react';
import { runtimeEnvironment } from '../services/runtime/environment';
import { PrinterService } from '../services/printers/PrinterService';
import { PrinterDiagnosticsPanel, PrinterSpoolerPanel } from './PrinterDiagnosticsPanel';
import { PrinterAddPanel } from './PrinterAddPanel';
import { createPrinterQueueMonitor } from '../services/printers/PrinterQueueMonitor';
import { jobStateLabels } from '../../packages/agent-rules/printers/PrinterHealth';
import { diagnosticConnection } from '../../packages/agent-rules/printers/PrinterPresence';
import { createPrinterPresenceMonitor } from '../services/printers/PrinterPresenceMonitor';
import { presentPrinter, summarizePrinterPresentation, type PrinterPresentationState } from '../services/printers/PrinterPresentation';
import type { PrinterDiagnosticSnapshot } from '../../packages/contracts/printer-diagnostic';
import { classifyPrinterConnection, partialCollectionNotice } from '../services/printers/PrinterDiagnostic';
import { getPrinterActionAvailability, getPrinterConfigurationActionAvailability, getPrinterTestErrorMessage, getQueueEmptyMessage, getQueuePagesLabel, getQueueSizeLabel, getQueueStatus, getQueueClearMessage, validatePrinterName, validatePrinterShareName } from '../services/printers/PrinterOperations';
import type { PrintJobSnapshot, PrinterSnapshot, SnapshotCollection, PrinterConfigurationSnapshot, PrinterPermissionsSnapshot, PrinterPermissionValues } from '../../packages/contracts/machine';
import '../printer-diagnostic.css';

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : typeof error === 'string' && error.trim() ? error : fallback;
}

export function PrinterCardSummary({name,isDefault,presentation}:{name:string;isDefault:boolean;presentation:PrinterPresentationState}) {
  return <>
    <div className="printer-card-heading"><div className="printer-card-icon"><Printer size={18}/></div>
      <div className="printer-card-title"><h2>{name}</h2><span className={`printer-badge printer-state ${presentation.tone}`}>{presentation.statusIcon} {presentation.primaryLabel}</span></div>
      {isDefault&&<span className="printer-badge default">Padrão</span>}
    </div>
    <p className="printer-connection-line">{presentation.connectionLabel}{presentation.destination&&<span>{presentation.destination}</span>}</p>
    <dl className="printer-summary-fields">
      {presentation.connectionLabel!=='Virtual'&&<div><dt>Porta</dt><dd>{presentation.portSummary.value}<small>{presentation.portSummary.registration}</small></dd></div>}
      {presentation.deviceSummary.visible&&presentation.connectionLabel!=='Virtual'&&<div><dt>Dispositivo</dt><dd>{presentation.deviceSummary.value}<small>{presentation.deviceSummary.presence}</small></dd></div>}
      <div><dt>Fila</dt><dd>{presentation.queueSummary.value}{presentation.queueSummary.notice&&<small>{presentation.queueSummary.notice}</small>}</dd></div>
    </dl>
  </>;
}

function Queue({ jobs, busy, error, technicalError, refresh, clear, cancel, disabled, monitoring }: {
  jobs: PrintJobSnapshot[] | null; busy: boolean; error: string; technicalError: string;
  refresh: () => void; clear: () => void; cancel: (job: PrintJobSnapshot) => void; disabled: boolean;
  monitoring:string;
}) {
  return (
    <section className="printer-queue" aria-label="Fila de impressão">
      <p className="printer-monitor-status" role="status">● {monitoring}</p>
      <div className="printer-queue-heading"><h3><ClipboardList size={16}/> {jobs?.length ? `${jobs.length} ${jobs.length===1?'trabalho':'trabalhos'}` : 'Fila de impressão'}</h3><div>
        <button className="printer-secondary-action" disabled={busy||disabled} onClick={refresh}><RefreshCw size={13}/>{busy?'Atualizando…':'Atualizar fila'}</button>
        <button className="printer-danger-action" disabled={busy||disabled||!jobs?.length} onClick={clear}><Trash2 size={13}/>Limpar fila</button>
      </div></div>
      {busy ? <p className="printer-queue-message">Consultando fila…</p> : error ? (
        <div className="printer-queue-error"><p>{error}</p>{technicalError&&<small>{technicalError}</small>}</div>
      ) : jobs && getQueueEmptyMessage(jobs) ? (
        <p className="printer-queue-message">{getQueueEmptyMessage(jobs)}</p>
      ) : jobs && (
        <div className="printer-queue-table-wrap">
          <table className="printer-queue-table">
            <thead><tr><th>Documento</th><th>Usuário</th><th>Estado</th><th>Tamanho</th><th>Páginas</th><th>Horário (UTC)</th><th>Posição</th><th>Ação</th></tr></thead>
            <tbody>{jobs.map(job=><tr key={job.jobId}>
              <td>{job.document||'Não informado'}</td>
              <td>{job.user||'Não informado'}</td>
              <td>
                <span title={job.statusDetail??undefined} className={`printer-job-status ${getQueueStatus(job.status).toLocaleLowerCase('pt-BR').replace(/\s+/g, '-')}`}>{jobStateLabels(job).join(' · ')||getQueueStatus(job.status)}</span>
                {job.statusDetail&&<small className="printer-job-detail">{job.statusDetail}</small>}
              </td>
              <td>{getQueueSizeLabel(job.sizeBytes)}</td>
              <td>{getQueuePagesLabel(job.totalPages, job.pagesPrinted)}</td>
              <td>{job.submittedAt||'Não informado'}</td>
              <td>{job.position}</td><td><button className="printer-danger-action compact" disabled={disabled} onClick={()=>cancel(job)}>Cancelar</button></td>
            </tr>)}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function permissionLabel(values: PrinterPermissionValues | null, key: keyof PrinterPermissionValues, accessType: string): string {
  if (!values) return 'Não interpretado';
  if (!values[key]) return 'Não definido';
  return accessType==='Negar' ? 'Negado' : accessType==='Permitir' ? 'Permitido' : 'Detectado';
}

function PermissionDetails({ snapshot }: { snapshot: PrinterPermissionsSnapshot }) {
  return <details className="printer-permission-details"><summary>Detalhes técnicos das permissões</summary>
    {snapshot.state==='available'&&<div className="printer-permissions-table-wrap"><table className="printer-permissions-table"><thead><tr><th>Usuário/Grupo</th><th>Tipo de ACE</th><th>Imprimir</th><th>Gerenciar impressora</th><th>Gerenciar documentos</th><th>Especiais</th></tr></thead><tbody>{snapshot.entries.map((entry,index)=><tr key={`${entry.sid??'unknown'}-${entry.aceIndex}-${index}`}>
      <td>{entry.account}{entry.inherited&&<small>Herdada</small>}<small>{entry.sid}</small></td><td>{entry.accessType}</td><td>{permissionLabel(entry.permissions,'print',entry.accessType)}</td><td>{permissionLabel(entry.permissions,'managePrinter',entry.accessType)}</td><td>{permissionLabel(entry.permissions,'manageDocuments',entry.accessType)}</td><td>{entry.specialPermissions?'Detectadas':'Não detectadas'}</td>
    </tr>)}</tbody></table></div>}
    {snapshot.state==='unavailable'&&<p>Não foi possível consultar as permissões.</p>}
    {snapshot.notice&&<small className="printer-permission-notice">{snapshot.notice}</small>}
  </details>;
}

type PermissionOperationStatus = { success: boolean; message: string; technical: string | null };

export function PrinterPermissionsSection({ snapshot, available, busy, status, configure }: {
  snapshot: PrinterPermissionsSnapshot; available: boolean; busy: boolean;
  status: PermissionOperationStatus | null; configure: () => void;
}) {
  return <>
    <section className="printer-settings-section"><h4><Shield size={15}/> Permissões</h4>
      <p>Permissões da impressora</p>
      <button className="printer-secondary-action" disabled={!available||busy} onClick={configure}><Shield size={13}/>Configurar permissões</button>
      <p>Configura o grupo 'Todos' com as permissões necessárias para uso e gerenciamento da impressora.</p>
      {status&&<div role="status"><p className={`printer-action-message ${status.success?'success':'error'}`}>{status.success?<Check size={14}/>:<CircleAlert size={14}/>} {status.message}</p>
        {status.technical&&<details className="printer-permission-details"><summary>Detalhe técnico da operação</summary><p>{status.technical}</p></details>}
      </div>}
    </section>
    <PermissionDetails snapshot={snapshot}/>
  </>;
}

function PrinterCard({ printer, refreshPrinters, notify,reportPresentation }: { printer: PrinterSnapshot; refreshPrinters: () => Promise<void>; notify: (message: string) => void;reportPresentation:(name:string,state:PrinterPresentationState)=>void }) {
  const [queueOpen, setQueueOpen] = useState(false);
  const [diagnostic,setDiagnostic]=useState<PrinterDiagnosticSnapshot|null>(null);
  const [diagnosticBusy,setDiagnosticBusy]=useState(false);
  const [monitoring,setMonitoring]=useState('Monitoramento indisponível · atualização manual');
  const liveQueue=useRef<ReturnType<typeof createPrinterQueueMonitor>|null>(null);
  const queueRefreshInFlight=useRef<Promise<void>|null>(null);
  const [actionRecord,setActionRecord]=useState('');
  const [repairBusy,setRepairBusy]=useState(false);
  const [queueBusy, setQueueBusy] = useState(false);
  const [queue, setQueue] = useState<PrintJobSnapshot[] | null>(null);
  const [queueError, setQueueError] = useState('');
  const [queueTechnicalError, setQueueTechnicalError] = useState('');
  const [printing, setPrinting] = useState(false);
  const [printMessage, setPrintMessage] = useState('');
  const [printTechnicalError, setPrintTechnicalError] = useState('');
  const [printSucceeded, setPrintSucceeded] = useState(false);
  const [queueActionBusy, setQueueActionBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [configuration, setConfiguration] = useState<PrinterConfigurationSnapshot | null>(null);
  const [configurationBusy, setConfigurationBusy] = useState(false);
  const [paused, setPaused] = useState<boolean | null>(null);
  const [configurationError, setConfigurationError] = useState('');
  const [operationMessage, setOperationMessage] = useState('');
  const [operationError, setOperationError] = useState('');
  const [saving, setSaving] = useState(false);
  const [printerName, setPrinterName] = useState(printer.name);
  const [shareName, setShareName] = useState(printer.shareName ?? '');
  const [shareEnabled, setShareEnabled] = useState(printer.shared === true);
  const [settingsPort,setSettingsPort]=useState('');
  const [permissionStatus, setPermissionStatus] = useState<PermissionOperationStatus | null>(null);
  const [confirmation, setConfirmation] = useState<{ title: string; message: string; label: string; action: () => Promise<void> } | null>(null);
  const actionAvailability = getPrinterActionAvailability(runtimeEnvironment);
  const configurationAvailability = getPrinterConfigurationActionAvailability(runtimeEnvironment, configuration?.isElevated??diagnostic?.isElevated);
  const isPaused = diagnostic?.printer ? !!(diagnostic.printer.statusBits&1) : paused;
  const connection = diagnostic?diagnosticConnection(diagnostic):classifyPrinterConnection(printer);
  const remoteHint=printer.network===true&&printer.local!==true||!!printer.server;
  const presentation=presentPrinter(diagnostic,printer.name,remoteHint);
  const configuredSharePath = configuration?.server && configuration.shareName
    ? `\\\\${configuration.server.replace(/^\\+/, '')}\\${configuration.shareName}`
    : null;
  useEffect(()=>{reportPresentation(printer.name,presentPrinter(diagnostic,printer.name,remoteHint));},[diagnostic,printer.name,remoteHint,reportPresentation]);

  useEffect(() => {
    if (!actionAvailability.available) return;
    let active = true;
    setDiagnosticBusy(true);
    void PrinterService.getDiagnostic(printer.name).then(value => { if(active){setDiagnostic(value);setPaused(value.printer?!!(value.printer.statusBits&1):null);setQueue(value.queue.error?null:value.queue.items);} }).catch(error => {if(active){setPaused(null);setOperationError(errorText(error,'Falha no diagnóstico.'));}}).finally(()=>{if(active)setDiagnosticBusy(false);});
    return () => { active = false; };
  }, [actionAvailability.available, printer]);

  const refreshDiagnostic=async()=>{if(!actionAvailability.available)return;setDiagnosticBusy(true);try{const next=await PrinterService.getDiagnostic(printer.name);setDiagnostic(next);setPaused(next.printer?!!(next.printer.statusBits&1):null);}catch(error){setOperationError(errorText(error,'Falha no diagnóstico.'));}finally{setDiagnosticBusy(false);}};

  useEffect(()=>{
    if(!actionAvailability.available||repairBusy||!['COM / Local','USB / Local','Local / Não identificado'].includes(connection))return;
    const monitor=createPrinterPresenceMonitor({query:()=>PrinterService.getDiagnostic(printer.name),
      shouldQuery:()=>document.visibilityState!=='hidden',
      receive:next=>{setDiagnostic(next);setPaused(next.printer?!!(next.printer.statusBits&1):null);},
      error:error=>setDiagnostic(d=>d?{...d,presentDevices:{com:{items:[],error:errorText(error,'Presença não verificada.')},usb:{items:[],error:errorText(error,'Presença não verificada.')}}}:d),
    });
    return ()=>monitor.stop();
  },[actionAvailability.available,printer.name,connection,repairBusy]);

  useEffect(()=>{
    if(!queueOpen||!actionAvailability.available)return;
    const monitor=createPrinterQueueMonitor({
      query:async()=>{
        const [jobs,native,spooler]=await Promise.allSettled([PrinterService.getQueue(printer.name),PrinterService.getNativeState(printer.name),PrinterService.getSpooler()]);
        if(jobs.status==='rejected')throw jobs.reason;
        return {jobs:jobs.value,native:native.status==='fulfilled'?native.value:null,nativeError:native.status==='rejected'?String(native.reason):null,spooler:spooler.status==='fulfilled'?spooler.value[0]:null};
      },
      receive:value=>{setQueue(value.jobs);setQueueError('');setQueueTechnicalError('');setPaused(value.native?!!(value.native.statusBits&1):null);setConfiguration(c=>c&&value.native?{...c,paused:!!(value.native.statusBits&1)}:null);setDiagnostic(d=>d?{...d,printer:value.native,printerError:value.nativeError,queue:{items:value.jobs,error:null},spooler:value.spooler??{state:null,startMode:null,error:'Spooler não consultado.'}}:d);},
      error:error=>{setQueue(null);setQueueError('Não foi possível consultar a fila desta impressora.');setQueueTechnicalError(errorText(error,''));setDiagnostic(d=>d?{...d,queue:{items:[],error:errorText(error,'Fila indisponível.')}}:d);},
      busy:setQueueBusy,
      subscribe:receive=>PrinterService.monitorQueue(printer.name,receive),
      mode:(mode,detail)=>setMonitoring(mode==='native'?'Atualização automática · eventos do Windows':mode==='polling'?`Atualização automática · consulta a cada 3 s${detail?' (notificação nativa indisponível)':''}`:'Monitoramento indisponível · atualização manual'),
    });
    liveQueue.current=monitor;
    return ()=>{monitor.stop();liveQueue.current=null;};
  },[queueOpen,actionAvailability.available,printer.name]);

  const viewQueue = async () => {
    if (!actionAvailability.available) return;
    if (queueOpen) { setQueueOpen(false); return; }
    setQueueOpen(true);
  };

  const refreshQueue = async () => {
    if (!actionAvailability.available) return;
    if(liveQueue.current){await liveQueue.current.refresh();return;}
    if(queueRefreshInFlight.current){await queueRefreshInFlight.current;return;}
    const promise=(async()=>{setQueueBusy(true);setQueueError('');setQueueTechnicalError('');
      try{const jobs=await PrinterService.getQueue(printer.name);setQueue(jobs);setDiagnostic(d=>d?{...d,queue:{items:jobs,error:null}}:d);}
      catch(error){setQueueError('Não foi possível consultar a fila desta impressora.');setQueueTechnicalError(errorText(error,''));}
      finally{setQueueBusy(false);}
    })();queueRefreshInFlight.current=promise;try{await promise;}finally{queueRefreshInFlight.current=null;}
  };

  const loadConfiguration = async () => {
    if (!actionAvailability.available) return;
    setConfigurationBusy(true); setConfigurationError('');
    try {
      const value = await PrinterService.getConfiguration(printer.name);
      setConfiguration(value); setPrinterName(value.printerName); setShareName(value.shareName ?? ''); setShareEnabled(value.shared);
      setSettingsPort(''); setPaused(value.paused);
    } catch (error) { setConfigurationError('Não foi possível consultar as configurações e permissões.'); setOperationError(errorText(error, '')); }
    finally { setConfigurationBusy(false); }
  };

  const openSettings = async () => { setSettingsOpen(true); setOperationMessage(''); setOperationError(''); await loadConfiguration(); };

  const requestConfirmation = (title: string, message: string, label: string, action: () => Promise<void>) => {
    setOperationMessage(''); setOperationError(''); setConfirmation({ title, message, label, action });
  };

  const runConfirmed = async () => {
    if (!confirmation) return;
    setSaving(true); setOperationMessage(''); setOperationError('');
    let before='Não verificado';try{before=JSON.stringify(await PrinterService.getDiagnostic(printer.name));}catch{/* A failed read never invents a state. */}
    let result='Operação aceita pelo Windows.';
    try { await confirmation.action(); setConfirmation(null); }
    catch (error) { result=errorText(error,'Não foi possível concluir a operação.');setOperationError(result);setConfirmation(null); }
    finally {let after='Não verificado';try{const next=await PrinterService.getDiagnostic(printer.name);after=JSON.stringify(next);setDiagnostic(next);}catch{/* Preserve the actual operation result. */}setActionRecord(`Antes: ${before}\nAção: ${confirmation.title}\nDepois: ${after}\nResultado: ${result}`);setSaving(false);}
  };

  const clearQueue = () => requestConfirmation('Limpar a fila da impressora?', 'Todos os trabalhos pendentes desta impressora serão removidos.', 'Limpar fila', async () => {
    setQueueActionBusy(true);
    try {
      const result = await PrinterService.clearQueue(printer.name);
      await refreshQueue();
      setOperationMessage(getQueueClearMessage(result));
    } finally { setQueueActionBusy(false); }
  });

  const cancelJob = (job: PrintJobSnapshot) => requestConfirmation('Cancelar trabalho de impressão?', `O trabalho “${job.document||`#${job.jobId}`}” desta impressora será cancelado.`, 'Cancelar trabalho', async () => {
    setQueueActionBusy(true);
    try { await PrinterService.cancelJob(printer.name, job.jobId); await refreshQueue(); setOperationMessage('Trabalho cancelado.'); }
    finally { setQueueActionBusy(false); }
  });

  const togglePause = () => requestConfirmation(isPaused ? 'Retomar a impressora?' : 'Pausar a impressora?', isPaused ? 'A fila desta impressora poderá voltar a imprimir.' : 'A fila desta impressora ficará pausada até ser retomada.', isPaused ? 'Retomar' : 'Pausar', async () => {
    if (isPaused) await PrinterService.resume(printer.name); else await PrinterService.pause(printer.name);
    try {
      const updatedPaused = await PrinterService.getPauseState(printer.name);
      setPaused(updatedPaused); setConfiguration(current => current ? { ...current, paused: updatedPaused } : current);
      setDiagnostic(current=>current?.printer?{...current,printer:{...current.printer,statusBits:updatedPaused?current.printer.statusBits|1:current.printer.statusBits&~1}}:current);
      setOperationMessage(updatedPaused ? 'Impressora pausada.' : 'Impressora retomada.');
    } catch (error) {
      setPaused(null); setConfiguration(null);
      setOperationError(`A operação foi aceita pelo Windows, mas não foi possível confirmar o estado atual. ${errorText(error, '')}`);
    }
    await refreshPrinters();
  });

  const doDefault = () => requestConfirmation('Definir impressora padrão?', `“${printer.name}” passará a ser a impressora padrão deste usuário.`, 'Definir como padrão', async () => {
    await PrinterService.setDefault(printer.name); await refreshPrinters(); setOperationMessage('Impressora definida como padrão.');
  });

  const saveName = () => {
    if (!configurationAvailability.available) { setOperationError(configurationAvailability.message!); return; }
    const validation = validatePrinterName(printerName); if (validation) { setOperationError(validation); return; }
    requestConfirmation('Alterar nome da impressora?', `O nome será alterado de “${printer.name}” para “${printerName.trim()}”.`, 'Alterar nome', async () => {
      await PrinterService.rename(printer.name, printerName.trim()); notify('Nome da impressora alterado.'); await refreshPrinters();
    });
  };

  const saveShare = () => {
    if (!configurationAvailability.available) { setOperationError(configurationAvailability.message!); return; }
    if (shareEnabled) { const validation = validatePrinterShareName(shareName); if (validation) { setOperationError(validation); return; } }
    requestConfirmation('Alterar compartilhamento?', 'A alteração do nome compartilhado pode invalidar caminhos de rede existentes para esta impressora.', shareEnabled ? 'Salvar compartilhamento' : 'Desativar compartilhamento', async () => {
      await PrinterService.setShare(printer.name, shareEnabled, shareEnabled ? shareName.trim() : null);
      await loadConfiguration(); await refreshPrinters(); setOperationMessage(shareEnabled ? 'Compartilhamento atualizado.' : 'Compartilhamento desativado.');
    });
  };

  const removePrinter=()=>requestConfirmation('Remover esta impressora?', `Impressora: ${printer.name}\nA conexão do usuário ou o objeto local será removido. Driver e porta serão preservados.`, 'Remover impressora', async()=>{
    setQueueOpen(false);await PrinterService.removePrinter(printer.name,true);setSettingsOpen(false);await refreshPrinters();notify(`Remoção solicitada ao Windows: ${printer.name}.`);
  });
  const changeSettingsPort=()=>{
    if(!settingsPort||!configurationAvailability.available)return;
    requestConfirmation('Alterar porta?',`Impressora: ${printer.name}\nAtual: ${configuration?.port}\nNova: ${settingsPort}`, 'Alterar porta',async()=>{
      const current=await PrinterService.getDiagnostic(printer.name);
      if(current.printer?.port!==configuration?.port)throw new Error('A porta atual mudou. Consulte as configurações novamente.');
      await PrinterService.setPort(printer.name,settingsPort);
      const after=await PrinterService.getDiagnostic(printer.name);
      if(after.printer?.port?.toLowerCase()!==settingsPort.toLowerCase())throw new Error('O Windows aceitou a alteração, mas a nova porta não foi confirmada.');
      setDiagnostic(after);await loadConfiguration();setOperationMessage('Porta atualizada e confirmada.');
    });
  };

  const configurePermissions = () => {
    if (!configurationAvailability.available) { setOperationError(configurationAvailability.message!); return; }
    requestConfirmation('Configurar permissões para Todos?', 'Serão habilitadas para o grupo "Todos":\n• Imprimir\n• Gerenciar esta impressora\n• Gerenciar documentos\n\nAs outras entradas de segurança serão preservadas.', 'Configurar permissões', async () => {
      setPermissionStatus(null);
      try {
        await PrinterService.configurePermissions(printer.name);
        setPermissionStatus({ success: true, message: 'Permissões configuradas com sucesso.', technical: null });
        await loadConfiguration();
      } catch (error) {
        setPermissionStatus({ success: false, message: 'Não foi possível configurar as permissões da impressora.', technical: errorText(error, 'O Windows não retornou detalhes da falha.') });
        throw error;
      }
    });
  };

  const printTestPage = async () => {
    if (!actionAvailability.available) return;
    setPrinting(true); setPrintMessage(''); setPrintTechnicalError(''); setPrintSucceeded(false);
    try {
      await PrinterService.printTestPage(printer.name);
      setPrintMessage('Página de teste enviada para a impressora.');
      setPrintSucceeded(true);
      await refreshQueue();
      await refreshDiagnostic();
    } catch (error) {
      setPrintMessage(getPrinterTestErrorMessage(error));
      setPrintTechnicalError(errorText(error, ''));
    } finally { setPrinting(false); }
  };

  return <article className="printer-card">
    <PrinterCardSummary name={printer.name} isDefault={printer.isDefault} presentation={presentation}/>
    {!actionAvailability.available&&<small className="printer-desktop-note"><Monitor size={12}/> Ações de fila e impressão: Disponível no Desktop</small>}
    {printMessage&&<p className={`printer-action-message ${printSucceeded?'success':'error'}`} role="status">{printSucceeded?<Check size={14}/>:<CircleAlert size={14}/>} {printMessage}{printTechnicalError&&!printSucceeded&&printTechnicalError!==printMessage&&<small>{printTechnicalError}</small>}</p>}
    {!settingsOpen&&(operationMessage||operationError)&&<p className={`printer-action-message ${operationError?'error':'success'}`} role="status">{operationError?<CircleAlert size={14}/>:<Check size={14}/>} {operationError||operationMessage}</p>}
    {actionAvailability.available&&<PrinterDiagnosticsPanel name={printer.name} snapshot={diagnostic} busy={diagnosticBusy||printing||queueActionBusy||saving} refresh={refreshDiagnostic} onRepairBusy={setRepairBusy} remoteHint={remoteHint} changed={async value=>{setDiagnostic(value);setPaused(value.printer?!!(value.printer.statusBits&1):null);await refreshQueue();}} actions={<>
      <button className="printer-secondary-action" disabled={!actionAvailability.available||queueBusy||repairBusy} aria-expanded={queueOpen} title="Abrir ou fechar a fila de impressão" onClick={()=>void viewQueue()}><ClipboardList size={14}/>Fila</button>
      <button className="printer-secondary-action" disabled={!actionAvailability.available||printing||repairBusy} title="Enviar página de teste para esta impressora" onClick={()=>void printTestPage()}><FileText size={14}/>Teste</button>
      <button className="printer-secondary-action" disabled={!actionAvailability.available||configurationBusy||repairBusy} title={actionAvailability.message??undefined} onClick={()=>void openSettings()}><Settings size={14}/>Configurações</button>
    </>} details={<>
      <details><summary>Dados coletados do Windows</summary><pre className="printer-raw-data">{JSON.stringify({diagnostic,inventory:printer},null,2)}</pre></details>
      <section><h4>Segurança</h4><button className="printer-secondary-action" disabled={configurationBusy||repairBusy} onClick={()=>void loadConfiguration()}>Consultar ACL · somente leitura</button>{configuration&&<PermissionDetails snapshot={configuration.permissions}/>}</section>
      {actionRecord&&<details className="printer-correction-report"><summary>Última operação: antes / ação / depois</summary><pre>{actionRecord}</pre></details>}
    </>}/>}
    {queueOpen&&<Queue jobs={queue} busy={queueBusy||queueActionBusy} error={queueError} technicalError={queueTechnicalError} refresh={()=>void refreshQueue()} clear={clearQueue} cancel={cancelJob} disabled={!actionAvailability.available||queueActionBusy||repairBusy} monitoring={monitoring}/>}
    {settingsOpen&&<div className="printer-settings-backdrop"><div className="printer-panel" role="dialog" aria-modal="true" aria-label={`Configurações de ${printer.name}`}>
      <div className="printer-panel-heading"><div><small>Configurações</small><h3>{printer.name}</h3></div><button className="printer-icon-button" aria-label="Fechar configurações" disabled={saving} onClick={()=>setSettingsOpen(false)}><X size={17}/></button></div>
      <div className="printer-panel-content">
      {configurationBusy&&<p className="printer-queue-message">Consultando configurações e ACL…</p>}
      {configurationError&&<p className="printer-action-message error"><CircleAlert size={14}/>{configurationError}</p>}
      {(operationMessage||operationError)&&<p className={`printer-action-message ${operationError?'error':'success'}`} role="status">{operationError?<CircleAlert size={14}/>:<Check size={14}/>} {operationError||operationMessage}</p>}
      {configuration&&<>
        {!configurationAvailability.available&&<p className="printer-configuration-notice" role="status">{configurationAvailability.message}</p>}
        {configuration.redirected&&<p className="printer-configuration-notice">Impressora redirecionada de uma sessão remota. O Windows pode limitar alterações de propriedades, compartilhamento e permissões.</p>}
        <section className="printer-settings-section"><h4>Geral</h4>
          <div className="printer-actions"><button className="printer-secondary-action" disabled={saving||repairBusy||isPaused===null} onClick={togglePause}>{isPaused?<Play size={14}/>:<Pause size={14}/>} {isPaused?'Retomar':'Pausar'}</button>{!printer.isDefault&&<button className="printer-secondary-action" disabled={saving||repairBusy} onClick={doDefault}><Star size={14}/>Definir como padrão</button>}</div>
          <label>Nome da impressora<input value={printerName} onChange={event=>setPrinterName(event.target.value)} maxLength={220}/></label>
          <button className="printer-secondary-action" disabled={!configurationAvailability.available||saving||printerName.trim()===configuration.printerName} onClick={saveName}><Save size={13}/>Salvar nome</button>
          <p className="printer-settings-status">Padrão: {printer.isDefault?'Sim':'Não'} · Estado: {configuration.paused?'Pausada':'Não pausada'}</p>
        </section>
        <section className="printer-settings-section"><h4>Compartilhamento</h4>
          <p>Caminho: <b>{configuredSharePath||'Não informado pelo Windows'}</b></p>
          <p>Servidor: <b>{configuration.server||'Não informado pelo Windows'}</b></p>
          <label className="printer-checkbox"><input type="checkbox" checked={shareEnabled} onChange={event=>setShareEnabled(event.target.checked)}/> Compartilhar esta impressora</label>
          {shareEnabled&&<label>Nome compartilhado<input value={shareName} onChange={event=>setShareName(event.target.value)} maxLength={80}/></label>}
          <button className="printer-secondary-action" disabled={!configurationAvailability.available||saving||(shareEnabled===configuration.shared&&shareName===(configuration.shareName??''))} onClick={saveShare}><Save size={13}/>Salvar compartilhamento</button>
        </section>
        <section className="printer-settings-section"><h4>Conexão</h4><p>Tipo: {configuration.redirected?'Redirecionada (sessão remota)':connection} · Porta: {configuration.port||'Não informado'}</p><p>Dispositivo: {presentation.deviceSummary.value} · {presentation.deviceSummary.presence}</p>
          {!configuration.redirected&&<details><summary>Alterar porta · exige confirmação</summary><label>Porta registrada<select value={settingsPort} disabled={saving||!configurationAvailability.available} onChange={event=>setSettingsPort(event.target.value)}><option value="">Selecione</option>{diagnostic?.ports.items.map(port=><option key={port.name} value={port.name}>{port.name}</option>)}</select></label><button className="printer-secondary-action" disabled={!settingsPort||saving||!configurationAvailability.available} onClick={changeSettingsPort}>Alterar porta</button></details>}
        </section>
        <PrinterPermissionsSection snapshot={configuration.permissions} available={configurationAvailability.available} busy={saving||configurationBusy} status={permissionStatus} configure={configurePermissions}/>
        <section className="printer-settings-section"><h4>Gerenciamento</h4><button className="printer-danger-action" disabled={!configurationAvailability.available||saving||repairBusy||configuration.redirected} onClick={removePrinter}><Trash2 size={14}/>Remover impressora</button></section>
        <details className="printer-settings-section"><summary>Detalhes técnicos</summary><p>Localização: {configuration.location||'Não informada'}</p><p>Comentário: {configuration.comment||'Não informado'}</p><p>Driver: {configuration.driver||'Não informado'}</p></details>
      </>}
      </div>
    </div></div>}
    {confirmation&&<div className="printer-confirm-backdrop"><section className="printer-confirm" role="alertdialog" aria-modal="true" aria-labelledby={`confirm-${printer.name}`}><h3 id={`confirm-${printer.name}`}>{confirmation.title}</h3><p>{confirmation.message}</p><div><button className="printer-secondary-action" disabled={saving} onClick={()=>setConfirmation(null)}>Cancelar</button><button className="printer-danger-action" disabled={saving} onClick={()=>void runConfirmed()}>{saving?'Aplicando…':confirmation.label}</button></div></section></div>}
  </article>;
}

export function PrinterDiagnosticPage() {
  const [collection, setCollection] = useState<SnapshotCollection<PrinterSnapshot> | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(runtimeEnvironment === 'desktop');
  const [capturedAt, setCapturedAt] = useState<number | null>(null);
  const [operationNotice, setOperationNotice] = useState('');
  const [addOpen,setAddOpen]=useState(false);
  const [presentations,setPresentations]=useState<Record<string,PrinterPresentationState>>({});
  const reportPresentation=useCallback((name:string,state:PrinterPresentationState)=>setPresentations(previous=>({...previous,[name]:state})),[]);

  const update = async () => {
    if (runtimeEnvironment !== 'desktop') return;
    setBusy(true); setError('');
    try {
      const snapshot = await PrinterService.getPrinters();
      setCollection(snapshot);
      setPresentations({});
      setCapturedAt(Date.now());
    } catch (cause) {
      setError(errorText(cause, 'Não foi possível carregar as impressoras.'));
    } finally { setBusy(false); }
  };

  const initialLoadStarted = useRef(false);
  useEffect(() => {
    if (runtimeEnvironment === 'desktop' && !initialLoadStarted.current) {
      initialLoadStarted.current = true;
      void update();
    }
  }, []);
  const notice = collection ? partialCollectionNotice(collection) : null;
  const summary=summarizePrinterPresentation(collection?.items.map(printer=>presentations[printer.name]??presentPrinter(null))??[]);
  const defaults = collection?.items.filter(printer=>printer.isDefault).length ?? 0;

  return <>
    <header className="printer-page-heading"><div><small>FERRAMENTA · IMPRESSORAS</small><h1>Impressoras</h1>{collection&&<p>{collection.items.length} encontradas · {summary.available} disponíveis · {summary.attention} com atenção · {defaults} padrão{summary.unknown?` · ${summary.unknown} não verificadas`:''}</p>}</div><div className="printer-actions">{runtimeEnvironment==='desktop'&&<button className="primary printer-add-button" onClick={()=>setAddOpen(true)}>+ Adicionar impressora</button>}<button className="printer-secondary-action printer-refresh" disabled={busy||runtimeEnvironment!=='desktop'} onClick={()=>void update()}><RefreshCw size={14}/>{busy?'Atualizando…':'Atualizar'}</button></div></header>
    {runtimeEnvironment==='web'&&<p className="notice"><Monitor/> A lista local, fila, impressão, configurações e permissões estão disponíveis somente no Desktop. Nenhuma alteração foi simulada neste navegador.</p>}
    {error&&<p className="error"><CircleAlert/>{error}</p>}
    {operationNotice&&<p className="printer-action-message success" role="status"><Check size={14}/>{operationNotice}<button aria-label="Dispensar aviso" onClick={()=>setOperationNotice('')}><X size={13}/></button></p>}
    {busy&&!collection&&<p className="printer-loading">Carregando impressoras…</p>}
    {collection&&<>
      {capturedAt&&<small className="printer-captured">Atualizado {new Date(capturedAt).toLocaleTimeString()}</small>}
      {notice&&<p className="notice"><AlertTriangle/> {notice}</p>}
      {collection.error&&<details className="printer-collection-error"><summary>Detalhes da coleta</summary><p>{collection.error}</p><small>Origem: consulta WMI Win32_Printer</small></details>}
      {collection.items.length===0?<div className="empty printer-empty"><Printer/><b>Nenhuma impressora encontrada</b><p>{collection.error?'O Windows não retornou uma lista completa. Consulte os detalhes da coleta.':'O Windows não retornou impressoras instaladas.'}</p></div>:<section className="printer-list" aria-label="Impressoras encontradas">{collection.items.map((printer,index)=><PrinterCard key={`${printer.name}-${index}`} printer={printer} refreshPrinters={update} notify={setOperationNotice} reportPresentation={reportPresentation}/>)}</section>}
    </>}
    {runtimeEnvironment==='desktop'&&<PrinterSpoolerPanel refreshPrinters={update}/>}
    {runtimeEnvironment==='desktop'&&addOpen&&<PrinterAddPanel close={()=>setAddOpen(false)} refresh={update} notify={setOperationNotice}/>}
  </>;
}
