import { useMemo, useState } from 'react';
import { CircleAlert, Cog, Monitor, RefreshCw, Search } from 'lucide-react';
import { runtimeEnvironment } from '../services/runtime/environment';
import { WindowsServicesService } from '../services/windows-services/WindowsServicesService';
import { isPriorityServiceStopped, isPriorityWindowsService } from '../services/windows-services/WindowsServicePresentation';
import type { SnapshotCollection, WindowsServiceSnapshot } from '../types/machine';
import '../windows-services-diagnostic.css';

type ServiceFilter = 'all' | 'running' | 'stopped' | 'disabled';

function normalized(value: string | null) {
  return value?.trim().toLocaleLowerCase() ?? '';
}

function ServiceCard({ service }: { service: WindowsServiceSnapshot }) {
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
    <dl className="windows-service-details">
      <div><dt>Inicialização</dt><dd>{service.startMode || 'Não disponível'}</dd></div>
      <div><dt>Status</dt><dd>{service.status || 'Não disponível'}</dd></div>
      <div><dt>Executado como</dt><dd>{service.startName || 'Não disponível'}</dd></div>
      <div className="path"><dt>Executável associado</dt><dd>{service.pathName || 'Não disponível'}</dd></div>
      {service.description && <div className="description"><dt>Descrição</dt><dd>{service.description}</dd></div>}
    </dl>
  </article>;
}

export function WindowsServicesDiagnosticPage() {
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
    }).sort((a, b) => (a.displayName || a.name || '').localeCompare(b.displayName || b.name || '', 'pt-BR'));
  }, [filter, items, query]);

  return <>
    <header className="windows-services-page-heading">
      <div><small>FERRAMENTA · SISTEMA</small><h1>Diagnóstico de Serviços do Windows</h1><p>Inventário e estado atual dos serviços. Consulta WMI somente leitura.</p></div>
      <button className="primary windows-services-refresh" disabled={busy || runtimeEnvironment !== 'desktop'} onClick={refresh}><RefreshCw size={14}/>{busy ? 'Consultando…' : collection ? 'Atualizar diagnóstico' : 'Consultar serviços'}</button>
    </header>
    {runtimeEnvironment === 'web' && <p className="notice"><Monitor/> A consulta dos serviços locais exige o Desktop Windows. Nenhuma coleta foi executada no navegador.</p>}
    {error && <p className="error"><CircleAlert/>{error}</p>}
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
        : <section className="windows-services-list" aria-label="Serviços do Windows">{visible.map((service, index) => <ServiceCard key={`${service.name ?? service.displayName ?? 'service'}-${index}`} service={service}/>)}</section>}
    </>}
  </>;
}
