import { useMemo, useState } from 'react';
import { CircleAlert, Cog, Monitor, RefreshCw, Search } from 'lucide-react';
import { runtimeEnvironment } from '../services/runtime/environment';
import { WindowsServicesService } from '../services/windows-services/WindowsServicesService';
import { isPriorityServiceStopped, isPriorityWindowsService } from '../services/windows-services/WindowsServicePresentation';
import type { SnapshotCollection, WindowsServiceSnapshot } from '../../packages/contracts/machine';
import '../windows-services-diagnostic.css';
import { SupportService } from '../services/support/SupportService';
import { correctKnownServices } from '../services/support/SupportRepair';
import { canCorrectService } from '../services/support/SupportInterpretation';
import { isReadOnlyService } from '../services/support/ServiceSafety';
import type { ServiceAction } from '../types/support';
import { useSupportConfirmation } from './support/SupportUI';

type ServiceFilter = 'all' | 'running' | 'stopped' | 'disabled';

function normalized(value: string | null) {
  return value?.trim().toLocaleLowerCase() ?? '';
}

function ServiceCard({ service, busy, action }: { service: WindowsServiceSnapshot; busy: boolean; action: (service: WindowsServiceSnapshot, action: ServiceAction) => void }) {
  const state = service.state || service.status || 'Não disponível';
  const stateClass = normalized(service.state) === 'running' ? 'running' : normalized(service.state) === 'stopped' ? 'stopped' : 'unknown';
  const priority = isPriorityWindowsService(service);
  const priorityStopped = isPriorityServiceStopped(service);
  return <article className={`windows-service-card${priority ? ' priority' : ''}${priorityStopped ? ' priority-stopped' : ''}`}>
    <header className="windows-service-heading">
      <div className="windows-service-icon"><Cog size={17}/></div>
      <div className="windows-service-title">
        <h2>{service.displayName || service.name || 'Serviço sem nome informado'}</h2>
        <div className="windows-service-badges">
          {service.name && <span className="windows-service-badge">{service.name}</span>}
          {priority && <span className={`windows-service-badge priority${priorityStopped ? ' stopped' : ''}`}>{priorityStopped ? 'Prioritário · parado' : 'Prioritário'}</span>}
          <span className={`windows-service-badge ${stateClass}`}>{state}</span>
          {service.startMode && <span className={`windows-service-badge ${normalized(service.startMode) === 'disabled' ? 'disabled' : ''}`}>{service.startMode}</span>}
        </div>
      </div>
    </header>
    {isReadOnlyService(service) ? <p className="snapshot-note">Serviço estrutural/crítico · somente leitura</p> : <div className="support-actions">
      <button className="primary" disabled={busy || service.state !== 'Stopped' || normalized(service.startMode) === 'disabled'} onClick={() => action(service, 'start')}>{canCorrectService(service) ? 'Corrigir · Iniciar' : 'Iniciar'}</button>
      <button className="linkbtn" disabled={busy || service.state !== 'Running'} onClick={() => action(service, 'restart')}>Reiniciar</button>
      <button className="linkbtn" disabled={busy || service.state !== 'Running'} onClick={() => action(service, 'stop')}>Parar</button>
    </div>}
    <details className="support-details"><summary>Detalhes técnicos</summary><dl className="windows-service-details">
      <div><dt>Inicialização</dt><dd>{service.startMode || 'Não disponível'}</dd></div>
      <div><dt>Status</dt><dd>{service.status || 'Não disponível'}</dd></div>
      <div><dt>Executado como</dt><dd>{service.startName || 'Não disponível'}</dd></div>
      <div className="path"><dt>Executável associado</dt><dd>{service.pathName || 'Não disponível'}</dd></div>
      {service.description && <div className="description"><dt>Descrição</dt><dd>{service.description}</dd></div>}
    </dl></details>
  </article>;
}

export function WindowsServicesDiagnosticPage() {
  const { confirm, dialog } = useSupportConfirmation();
  const [message, setMessage] = useState('');
  const [collection, setCollection] = useState<SnapshotCollection<WindowsServiceSnapshot> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [capturedAt, setCapturedAt] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ServiceFilter>('all');

  const refresh = async () => {
    if (runtimeEnvironment !== 'desktop' || busy) return;
    setBusy(true);
    setError('');
    try {
      setCollection(await WindowsServicesService.getServices());
      setCapturedAt(Date.now());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao consultar os serviços do Windows.');
    } finally {
      setBusy(false);
    }
  };
  const act = async (service: WindowsServiceSnapshot, action: ServiceAction) => {
    if (busy || !service.name || runtimeEnvironment !== 'desktop') return;
    const automatic = action === 'start' && canCorrectService(service);
    if (!automatic && !await confirm(`${action === 'stop' ? 'Parar' : action === 'restart' ? 'Reiniciar' : 'Iniciar'} ${service.displayName || service.name}? Isso pode interromper aplicações ou conexões. Nenhuma configuração de inicialização será alterada.`)) return;
    setBusy(true); setError(''); setMessage('');
    try { const result = await SupportService.serviceAction(service.name, action, !automatic); setCollection(await WindowsServicesService.getServices()); setMessage(`${result.after.displayName || result.after.name}: ${result.after.state}. ${result.message}`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); try { setCollection(await WindowsServicesService.getServices()); } catch { /* Preserve the last known inventory; the operation error remains visible. */ } }
    finally { setBusy(false); }
  };
  const verify = async () => {
    if (busy || runtimeEnvironment !== 'desktop') return;
    setBusy(true); setError(''); setMessage('');
    try { const fresh = await WindowsServicesService.getServices(); if (fresh.error) throw new Error(fresh.error); const results = await correctKnownServices(SupportService, fresh.items); setCollection(await WindowsServicesService.getServices()); setMessage(results.join(' ') || 'Nenhum serviço de suporte conhecido parado e habilitado exigiu correção.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const items = collection?.items ?? [];
  const running = items.filter(service => normalized(service.state) === 'running').length;
  const stopped = items.filter(service => normalized(service.state) === 'stopped').length;
  const disabled = items.filter(service => normalized(service.startMode) === 'disabled').length;
  const priorityStopped = items.filter(isPriorityServiceStopped).length;
  const visible = useMemo(() => {
    const search = normalized(query);
    return items.filter(service => {
      const matchesFilter = filter === 'all'
        || (filter === 'running' && normalized(service.state) === 'running')
        || (filter === 'stopped' && normalized(service.state) === 'stopped')
        || (filter === 'disabled' && normalized(service.startMode) === 'disabled');
      const matchesSearch = !search || [service.name, service.displayName, service.pathName, service.description]
        .some(value => normalized(value).includes(search));
      return matchesFilter && matchesSearch;
    }).sort((a, b) => Number(isPriorityWindowsService(b)) - Number(isPriorityWindowsService(a)) || (a.displayName || a.name || '').localeCompare(b.displayName || b.name || '', 'pt-BR'));
  }, [filter, items, query]);

  return <>
    <header className="windows-services-page-heading">
      <div><small>FERRAMENTAS</small><h1>Serviços</h1><p>Estado atual e ações explícitas. A inicialização não é alterada automaticamente.</p></div>
      <button className="primary windows-services-refresh" disabled={busy || runtimeEnvironment !== 'desktop'} onClick={refresh}><RefreshCw size={14}/>{busy ? 'Consultando…' : collection ? 'Atualizar diagnóstico' : 'Consultar serviços'}</button>
    </header>
    {runtimeEnvironment === 'web' && <p className="notice"><Monitor/> A consulta dos serviços locais exige o Desktop Windows. Nenhuma coleta foi executada no navegador.</p>}
    {error && <p className="error"><CircleAlert/>{error}</p>}
    {message && <p className="notice">{message}</p>}
    <button className="primary" disabled={busy || runtimeEnvironment !== 'desktop'} onClick={verify}>Verificar e corrigir</button>
    {collection?.error && <p className="notice"><CircleAlert/>{collection.error}</p>}
    {collection && <>
      {capturedAt && <p className="windows-services-captured">Consultado em {new Date(capturedAt).toLocaleString()}</p>}
      <section className="windows-services-summary" aria-label="Resumo dos serviços">
        <div><small>Encontrados</small><b>{items.length}</b><span>serviços</span></div>
        <div><small>Em execução</small><b>{running}</b><span>estado confirmado</span></div>
        <div><small>Parados</small><b>{stopped}</b><span>estado confirmado</span></div>
        <div><small>Desabilitados</small><b>{disabled}</b><span>inicialização desabilitada</span></div>
        <div className={priorityStopped ? 'attention' : ''}><small>Prioritários parados</small><b>{priorityStopped}</b><span>serviços de suporte conhecidos</span></div>
      </section>
      <div className="windows-services-toolbar">
        <label className="windows-services-search"><Search size={15}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar por nome, executável ou descrição" aria-label="Buscar serviços"/></label>
        <label className="windows-services-filter">Estado<select value={filter} onChange={event => setFilter(event.target.value as ServiceFilter)}><option value="all">Todos</option><option value="running">Em execução</option><option value="stopped">Parados</option><option value="disabled">Desabilitados</option></select></label>
        <span>{visible.length} de {items.length}</span>
      </div>
      {visible.length === 0
        ? <div className="empty windows-services-empty"><Cog/><b>{items.length ? 'Nenhum serviço corresponde à busca' : 'Nenhum serviço retornado'}</b><p>{items.length ? 'Altere o texto ou o filtro para ver outros serviços.' : collection.error ? 'A consulta WMI não retornou dados; veja o detalhe acima.' : 'O Windows não retornou serviços nesta consulta.'}</p></div>
        : <section className="windows-services-list" aria-label="Serviços do Windows">{visible.map((service, index) => <ServiceCard key={`${service.name ?? service.displayName ?? 'service'}-${index}`} service={service} busy={busy} action={act}/>)}</section>}
    </>}
    {dialog}
  </>;
}
