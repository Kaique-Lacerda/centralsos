import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CircleAlert, Monitor } from 'lucide-react';
import { LocalConfigService } from '../services/runtime/localConfig';
import { runtimeEnvironment } from '../services/runtime/environment';
import { MachineSnapshotService } from '../services/snapshot/MachineSnapshotService';
import { WindowsAdminService, type WindowsAdminAction } from '../services/windows/WindowsAdminService';
import { getPrinterHealth, getPrinterTechnicalDetails } from '../services/printers/PrinterDiagnostic';
import { runMachineValidation } from '../services/validation/runMachineValidation';
import type { MachineSnapshot } from '../types/machine';
import type { MachineValidationRun, ValidationStatus } from '../services/validation/types';
import type { ComputerNetworkSummaryAdapter } from '../services/network/ComputerNetworkSummary';

function formatBytes(bytes: number | null) {
  if (bytes === null) return 'Não disponível';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatUptime(seconds: number | null) {
  if (seconds === null) return 'Não disponível';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days}d ${hours}h ${minutes}min`;
}

const statusLabel: Record<ValidationStatus, string> = { success: 'OK', warning: 'Atenção', error: 'Problema', skipped: 'Não validado', ignored: 'Não validado' };
const overallLabel = { operational: 'Operacional', attention: 'Atenção', action_required: 'Ação necessária' } as const;

export function ComputerDiagnosticPage({ getNetworkSummary }: { getNetworkSummary: (adapters: MachineSnapshot['network']['items']) => ComputerNetworkSummaryAdapter[] }) {
  const [snapshot, setSnapshot] = useState<MachineSnapshot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [hostnameInput, setHostnameInput] = useState('');
  const [hostnameMessage, setHostnameMessage] = useState('');
  const [requestedHostname, setRequestedHostname] = useState<string | null>(null);
  const [adminMessage, setAdminMessage] = useState('');
  const [adminBusy, setAdminBusy] = useState(false);
  const [validation, setValidation] = useState<MachineValidationRun | null>(null);
  const [validationError, setValidationError] = useState('');
  const [validationBusy, setValidationBusy] = useState(false);
  const environment = LocalConfigService.load();
  const system = snapshot?.system;
  const network = snapshot ? getNetworkSummary(snapshot.network.items) : [];
  const hostnameValidation = WindowsAdminService.validateHostname(hostnameInput);
  const connectedAdapters = network.filter(adapter => adapter.status?.toLocaleLowerCase('pt-BR').includes('conectado'));
  const networkReady = network.some(adapter => adapter.ipv4.length > 0 && adapter.gateways.length > 0);
  const printerHealth = snapshot?.printers.items.map(getPrinterHealth) ?? [];
  const hasPrinterProblem = printerHealth.some(item => item.status === 'problem');
  const hasPrinterAttention = printerHealth.some(item => item.status === 'attention' || item.status === 'not-validated');

  const collectSnapshot = async () => {
    setBusy(true);
    setError('');
    try {
      const current = await MachineSnapshotService.getSnapshot();
      setSnapshot(current);
      setHostnameInput(current.system.hostname === 'Indisponível' ? '' : current.system.hostname);
      setRequestedHostname(previous => previous && previous.toLocaleLowerCase() === current.system.hostname.toLocaleLowerCase() ? null : previous);
      return current;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha na consulta do computador.');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const executeValidation = async () => {
    setValidationBusy(true);
    setValidationError('');
    try {
      setValidation(await runMachineValidation(snapshot ?? undefined));
    } catch (cause) {
      setValidationError(cause instanceof Error ? cause.message : 'Falha ao validar o ambiente.');
    } finally {
      setValidationBusy(false);
    }
  };

  const changeHostname = async (event: FormEvent) => {
    event.preventDefault();
    setHostnameMessage('');
    const checked = WindowsAdminService.validateHostname(hostnameInput);
    if (!checked.valid) {
      setHostnameMessage(checked.message);
      return;
    }
    const newHostname = hostnameInput.trim();
    if (!window.confirm(`Confirma alterar o hostname de “${system?.hostname ?? 'desconhecido'}” para “${newHostname}”? A alteração exige privilégios de administrador e pode exigir reinicialização do Windows.`)) return;
    try {
      const result = await WindowsAdminService.changeHostname(newHostname);
      setRequestedHostname(result.hostname);
      setHostnameMessage(`O Windows registrou o hostname ${result.hostname}. Reinicie o Windows para aplicar e confirmar o nome atualizado.`);
      await collectSnapshot();
      setHostnameInput(result.hostname);
    } catch (cause) {
      setHostnameMessage(cause instanceof Error ? cause.message : 'O Windows não conseguiu alterar o hostname.');
    }
  };

  const openAdminTool = async (action: WindowsAdminAction, label: string) => {
    setAdminBusy(true);
    setAdminMessage('');
    try {
      await WindowsAdminService.open(action);
      setAdminMessage(`${label} foi solicitado ao Windows.`);
    } catch (cause) {
      setAdminMessage(cause instanceof Error ? cause.message : `Não foi possível abrir ${label}.`);
    } finally {
      setAdminBusy(false);
    }
  };

  const printSummary = !snapshot ? 'Aguardando coleta' : hasPrinterProblem ? 'Problema' : hasPrinterAttention ? 'Atenção' : 'OK';

  return <>
    <header className="computer-diagnostic-heading"><div><small>FERRAMENTA · SISTEMA</small><h1>Diagnóstico do Computador</h1><p>Central de consulta local. A coleta começa somente quando você solicita.</p></div><button className="primary" disabled={busy || runtimeEnvironment !== 'desktop'} onClick={() => void collectSnapshot()}>{busy ? 'Coletando…' : snapshot ? 'Atualizar snapshot' : 'Coletar snapshot'}</button></header>
    <div className="panel row computer-collection-note"><div><b>Coleta explícita e somente leitura</b><p>Sistema, armazenamento, rede e impressoras. Serviços e validação são consultados separadamente, sob solicitação.</p></div></div>
    {runtimeEnvironment === 'web' && <p className="notice"><Monitor/> A coleta local e as ferramentas administrativas exigem o aplicativo Desktop.</p>}
    {error && <p className="error"><CircleAlert/>{error}</p>}
    {snapshot && <>
      <p className="snapshot-time">Coletado em {new Date(snapshot.capturedAt).toLocaleString('pt-BR')}</p>
      <div className="diagnostic-overview" aria-label="Resumo do diagnóstico">
        <div><small>Sistema</small><b className={system?.error ? 'attention' : 'ok'}>{system?.operatingSystem ? 'Dados coletados' : 'Dados parciais'}</b><span>{system?.hostname || 'Hostname indisponível'}</span></div>
        <div><small>Rede local</small><b className={networkReady ? 'ok' : connectedAdapters.length ? 'attention' : 'problem'}>{networkReady ? 'IPv4 e gateway disponíveis' : connectedAdapters.length ? 'Gateway não identificado' : 'Sem conexão relevante identificada'}</b><span>{connectedAdapters.length} interface(s) importante(s) conectada(s)</span></div>
        <div><small>Impressoras</small><b className={hasPrinterProblem ? 'problem' : hasPrinterAttention ? 'attention' : 'ok'}>{printSummary}</b><span>{snapshot.printers.items.length} dispositivo(s) retornado(s)</span></div>
        <div><small>Serviços</small><b>Não consultados</b><span>A consulta é separada e explícita</span><Link className="linkbtn" to="/tools/windows-services-diagnostic">Abrir diagnóstico de serviços <ArrowRight size={13}/></Link></div>
      </div>

      <section className="panel snapshot-section">
        <h2>Sistema</h2><h3 className="snapshot-subheading">Windows</h3>
        <div className="snapshot-grid">{[
          ['Sistema operacional', system?.operatingSystem], ['Versão', system?.windowsVersion], ['Build', system?.windowsBuild], ['Arquitetura', system?.architecture],
          ['Hostname', system?.hostname], ['Usuário atual', system?.username], ['Domínio / workgroup', system?.domainOrWorkgroup],
          ['Ingresso em domínio', system?.joinedToDomain === null ? null : system?.joinedToDomain ? 'Sim' : 'Não'], ['Uptime', formatUptime(system?.uptimeSeconds ?? null)]
        ].map(([label, value]) => <div className="snapshot-field" key={label}><small>{label}</small><b>{value || 'Não disponível'}</b></div>)}</div>
        <h3 className="snapshot-subheading">Hardware</h3>
        <div className="snapshot-grid">{[
          ['Fabricante', system?.manufacturer], ['Modelo', system?.model], ['Processador', system?.cpu], ['Memória RAM', formatBytes(system?.ramBytes ?? null)],
          ['BIOS', system?.bios ? [system.bios.manufacturer, system.bios.version, system.bios.releaseDate].filter(Boolean).join(' · ') : null]
        ].map(([label, value]) => <div className="snapshot-field" key={label}><small>{label}</small><b>{value || 'Não disponível'}</b></div>)}</div>
        {system?.error && <details className="snapshot-technical"><summary>Ver detalhes técnicos da coleta</summary><p>{system.error}</p><small>Origem: WMI / MachineSnapshot</small></details>}
      </section>

      <section className="panel snapshot-section">
        <div className="snapshot-section-heading"><h2>Armazenamento</h2><span>{snapshot.storage.items.length} volume(s)</span></div>
        {snapshot.storage.error && <details className="snapshot-technical"><summary>Coleta parcial — detalhes técnicos</summary><p>{snapshot.storage.error}</p><small>Origem: consulta de volumes do Windows</small></details>}
        {snapshot.storage.items.length === 0 ? <p className="snapshot-empty">Nenhum volume retornado.</p> : snapshot.storage.items.map(volume => <div className="snapshot-row" key={volume.unit}><b>{volume.unit}</b><span>{volume.label || 'Sem rótulo'}</span><span>Total {formatBytes(volume.totalBytes)}</span><span>Usado {formatBytes(volume.usedBytes)}</span><span>Livre {formatBytes(volume.freeBytes)}</span></div>)}
      </section>

      <section className="panel snapshot-section">
        <div className="snapshot-section-heading"><h2>Rede</h2><span>{network.length} interface(s) importante(s)</span></div>
        {snapshot.network.error && <details className="snapshot-technical"><summary>Coleta parcial — detalhes técnicos</summary><p>{snapshot.network.error}</p><small>Origem: WMI / MachineSnapshot</small></details>}
        {network.length === 0 ? <p className="snapshot-empty">{snapshot.network.items.length === 0 ? 'Nenhum adaptador retornado.' : 'Nenhum adaptador relevante para o resumo.'}</p> : network.map((adapter, index) => <div className="snapshot-item" key={`${adapter.name}-${index}`}><b>{adapter.name} · {adapter.kind}</b><span>Estado: {adapter.status || 'Não disponível'}</span><span>IPv4: {adapter.ipv4.join(', ') || '—'}</span><span>Gateway IPv4: {adapter.gateways.join(', ') || '—'}</span><span>DNS: {adapter.dnsServers.join(', ') || '—'}</span></div>)}
        <p className="snapshot-connectivity">Estado geral: {networkReady ? 'Há IPv4 e gateway em interface relevante.' : connectedAdapters.length ? 'Há interface relevante conectada, mas faltam dados completos de IPv4 e gateway.' : 'Nenhuma interface importante aparece conectada.'} O snapshot não testa acesso à Internet.</p>
        <Link className="linkbtn" to="/tools/network-diagnostic">Abrir detalhes no Diagnóstico de Rede <ArrowRight size={14}/></Link>
      </section>

      <section className="panel snapshot-section">
        <div className="snapshot-section-heading"><h2>Impressoras</h2><Link className="linkbtn" to="/tools/printer-diagnostic">Abrir Impressoras <ArrowRight size={13}/></Link></div>
        {snapshot.printers.error && <details className="snapshot-technical"><summary>Coleta parcial — detalhes técnicos</summary><p>{snapshot.printers.error}</p><small>Origem: consulta WMI Win32_Printer</small></details>}
        {snapshot.printers.items.length === 0 ? <p className="snapshot-empty">Nenhuma impressora retornada.</p> : snapshot.printers.items.map((printer, index) => {
          const health = getPrinterHealth(printer);
          const details = getPrinterTechnicalDetails(printer);
          const sharePath = details.find(item => item.label === 'Caminho do compartilhamento')?.detected;
          const kind = printer.local === true ? 'Local' : printer.network === true ? 'Rede' : 'Não determinado';
          return <article className="computer-printer" key={`${printer.name}-${index}`}>
            <header><div><b>{printer.name}</b><span className={`computer-printer-status ${health.status}`}>{health.label}</span>{printer.isDefault && <span className="printer-badge default">Padrão</span>}</div><p>{health.description}</p></header>
            <div className="computer-printer-summary"><span>Nome compartilhado: {printer.shareName || 'Não informado'}</span><span>Caminho/share: {sharePath === 'Não informado pelo Windows' ? 'Não informado' : sharePath}</span><span>Tipo: {kind}</span><span>Compartilhamento: {printer.shared === null ? 'Não informado' : printer.shared ? 'Ativado' : 'Desativado'}</span><span>Segurança/ACL: não consultada</span><span>Driver: {printer.driver || 'Não informado'}</span><span>Porta: {printer.port || 'Não informada'}</span><span>Servidor: {printer.server || 'Não informado'}</span><span>Estado: {printer.status || 'Não informado'}</span><span>Localização: {printer.location || 'Não informada'}</span></div>
            <details className="snapshot-technical"><summary>Ver detalhes técnicos</summary><dl>{details.map(item => <div key={item.label}><dt>{item.label}</dt><dd>{item.detected}</dd><small>Esperado: {item.expected} · Origem: {item.source}</small></div>)}</dl>{snapshot.printers.error && <p>Erro técnico da coleta: {snapshot.printers.error}</p>}</details>
          </article>;
        })}
      </section>

      <section className="panel snapshot-section">
        <h2>Serviços do Windows</h2><p className="snapshot-note">O snapshot não enumera serviços. A consulta dedicada mostra busca, filtros, contadores, detalhes e serviços prioritários, sem permitir alterações.</p>
        <Link className="linkbtn" to="/tools/windows-services-diagnostic">Abrir diagnóstico de serviços <ArrowRight size={14}/></Link>
      </section>

      <section className="panel snapshot-section">
        <h2>Ferramentas do Sistema</h2><p className="snapshot-note">A alteração de hostname exige confirmação, privilégios administrativos e pode exigir reinicialização. Os atalhos abrem ferramentas fixas do Windows.</p>
        <form className="hostname-form" onSubmit={changeHostname}>
          <label>Hostname atual<b>{system?.hostname || 'Não disponível'}</b></label>
          {requestedHostname && <p className="hostname-pending">Novo hostname registrado: {requestedHostname}. Aguardando reinicialização.</p>}
          <label>Novo hostname<input value={hostnameInput} maxLength={15} onChange={event => setHostnameInput(event.target.value)} placeholder="Ex.: TERMINAL-03" disabled={runtimeEnvironment !== 'desktop'}/></label>
          <small>Use de 1 a 15 letras, números ou hífens; não comece nem termine com hífen.</small>
          {hostnameInput && !hostnameValidation.valid && <small className="hostname-validation-error">{hostnameValidation.message}</small>}
          <button className="primary" disabled={runtimeEnvironment !== 'desktop' || busy || !hostnameValidation.valid || hostnameInput.trim().toLocaleLowerCase() === system?.hostname.toLocaleLowerCase() || hostnameInput.trim().toLocaleLowerCase() === requestedHostname?.toLocaleLowerCase()}>Alterar hostname</button>
        </form>
        {hostnameMessage && <p className={hostnameMessage.includes('registrou') ? 'notice' : 'error'}>{hostnameMessage}</p>}
        <div className="system-tool-actions">
          <button className="linkbtn" disabled={runtimeEnvironment !== 'desktop' || adminBusy} onClick={() => void openAdminTool('computerManagement', 'Gerenciamento do Computador')}>Gerenciamento do Computador</button>
          <button className="linkbtn" disabled={runtimeEnvironment !== 'desktop' || adminBusy} onClick={() => void openAdminTool('services', 'Serviços')}>Serviços</button>
          <button className="linkbtn" disabled={runtimeEnvironment !== 'desktop' || adminBusy} onClick={() => void openAdminTool('registry', 'Editor do Registro')}>Editor do Registro</button>
          <button className="linkbtn" disabled={runtimeEnvironment !== 'desktop' || adminBusy} onClick={() => void openAdminTool('networkSettings', 'Configurações de Rede')}>Configurações de Rede</button>
          <button className="linkbtn" disabled={runtimeEnvironment !== 'desktop' || adminBusy} onClick={() => void openAdminTool('adminTerminal', 'Terminal administrativo')}>Terminal administrativo</button>
        </div>
        {adminMessage && <p className="snapshot-note">{adminMessage}</p>}
      </section>

      <section className="panel snapshot-section">
        <div className="snapshot-section-heading"><h2>Validação do Ambiente</h2><span>Perfil: {environment?.machineRole === 'server' ? 'Servidor' : 'Terminal'}</span></div>
        <p className="snapshot-note">Usa as regras já cadastradas. Servidor herda Terminal e acrescenta somente os requisitos existentes. O snapshot coletado nesta tela é reutilizado.</p>
        {!environment && <p className="notice">Configure o perfil da máquina antes da validação. <Link to="/settings">Abrir configurações</Link></p>}
        <button className="primary" disabled={runtimeEnvironment !== 'desktop' || validationBusy || !environment} onClick={() => void executeValidation()}>{validationBusy ? 'Validando…' : validation ? 'Executar novamente' : 'Executar validação'}</button>
        {validationError && <p className="error">{validationError}</p>}
        {validation && <><div className={`validation-summary ${validation.summary.overallStatus}`}><div><small>Perfil aplicado</small><b>{overallLabel[validation.summary.overallStatus]}</b></div><span>{validation.summary.total} verificações</span><span className="success-text">✓ {validation.summary.success} OK</span><span className="warning-text">⚠ {validation.summary.warning} alertas</span><span className="error-text">✗ {validation.summary.error} problemas</span><span className="muted-text">— {validation.summary.skipped} não validadas</span></div>
          <details className="computer-validation-details"><summary>Ver resultados por requisito</summary><div>{validation.results.map(result => <article className={`computer-validation-result ${result.status}`} key={result.ruleId}><header><b>{result.title}</b><span>{statusLabel[result.status]}</span></header><p>{result.description}</p>{(result.expected || result.actual) && <small>Esperado: {result.expected || '—'} · Detectado: {result.actual || '—'}</small>}</article>)}</div></details>
          <Link className="linkbtn" to="/validation">Abrir validação detalhada <ArrowRight size={13}/></Link></>}
      </section>
    </>}
  </>;
}
