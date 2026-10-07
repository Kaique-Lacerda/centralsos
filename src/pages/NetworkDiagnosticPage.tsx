import { useState } from 'react';
import { AlertTriangle, CircleAlert, Monitor, Network, RefreshCw } from 'lucide-react';
import { runtimeEnvironment } from '../services/runtime/environment';
import { SupportService } from '../services/support/SupportService';
import type { NetworkSupportSnapshot } from '../types/support';
import { NetworkOperationsPanel } from './support/NetworkOperationsPanel';
import '../support-tools.css';
import { classifyNetworkAdapter, networkAdministrativeState, networkConnectionState, partialNetworkNotice, splitNetworkAdapters, summarizeNetwork } from '../services/network/NetworkDiagnostic';
import type { NetworkAdapterSnapshot, SnapshotCollection } from '../types/machine';
import '../network-diagnostic.css';

const stateLabels = { connected: 'Conectado', disconnected: 'Desconectado', connecting: 'Conectando', unknown: 'Não conclusivo' } as const;

function valueOrUnavailable(values: string[], fallback = 'Não disponível') {
  return values.length ? values.join(', ') : fallback;
}

function ipv4Values(values: string[]) { return values.filter(value => !value.includes(':')); }
function ipv6Values(values: string[]) { return values.filter(value => value.includes(':')); }

function NetworkAdapterCard({ adapter, isPrimary }: { adapter: NetworkAdapterSnapshot; isPrimary: boolean }) {
  const kind = classifyNetworkAdapter(adapter);
  const state = networkConnectionState(adapter.status);
  const gatewaysIpv4 = ipv4Values(adapter.gateways);
  const dnsIpv4 = ipv4Values(adapter.dnsServers);
  return <article className="network-adapter-card">
    <header className="network-adapter-heading">
      <div className="network-card-icon"><Network size={18}/></div>
      <div className="network-card-title">
        <h2>{adapter.name || 'Interface sem nome informado'}</h2>
        <div className="network-badges">
          {isPrimary&&<span className="network-badge primary">Conexão principal</span>}
          <span className={`network-badge ${kind==='Não determinado'?'unknown':'kind'}`}>{kind}</span>
          <span className={`network-badge state-${state}`}>{stateLabels[state]}</span>
        </div>
      </div>
    </header>
    {adapter.productName&&<p className="network-device">Dispositivo: {adapter.productName}{adapter.manufacturer?` · ${adapter.manufacturer}`:''}</p>}
    <dl className="network-adapter-details">
      <div><dt>IPv4</dt><dd>{valueOrUnavailable(adapter.ipv4)}</dd></div>
      <div><dt>Gateway IPv4</dt><dd>{valueOrUnavailable(gatewaysIpv4)}</dd></div>
      <div><dt>DNS IPv4</dt><dd>{valueOrUnavailable(dnsIpv4)}</dd></div>
    </dl>
    <details className="network-secondary-details">
      <summary>Detalhes de rede</summary>
      <dl className="network-adapter-details secondary">
        <div><dt>Estado administrativo</dt><dd>{({enabled:'Habilitado',disabled:'Desabilitado',unknown:'Não determinado'})[networkAdministrativeState(adapter)]}</dd></div>
        <div><dt>Estado de mídia/conexão</dt><dd>{adapter.status || 'Não determinado'}</dd></div>
        <div><dt>MAC</dt><dd>{adapter.mac||'Não disponível'}</dd></div>
        <div><dt>IPv6</dt><dd>{valueOrUnavailable(ipv6Values(adapter.ipv6))}</dd></div>
        <div><dt>Gateways IPv6</dt><dd>{valueOrUnavailable(ipv6Values(adapter.gateways))}</dd></div>
        <div><dt>DNS IPv6</dt><dd>{valueOrUnavailable(ipv6Values(adapter.dnsServers))}</dd></div>
      </dl>
    </details>
  </article>;
}

export function NetworkDiagnosticPage() {
  const [support, setSupport] = useState<NetworkSupportSnapshot|null>(null);
  const [message, setMessage] = useState('');
  const [collection, setCollection] = useState<SnapshotCollection<NetworkAdapterSnapshot>|null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [capturedAt, setCapturedAt] = useState<number|null>(null);

  const refresh = async () => {
    if (runtimeEnvironment !== 'desktop') return;
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const next = await SupportService.network();
      setSupport(next); setCollection(next.adapters);
      setCapturedAt(Date.now());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao coletar os adaptadores de rede.');
    } finally { setBusy(false); }
  };
  const operate = async (operation: () => Promise<{ after: NetworkSupportSnapshot; message: string }>) => {
    if (busy || runtimeEnvironment !== 'desktop') return;
    setBusy(true); setError(''); setMessage('');
    try { const result = await operation(); setSupport(result.after); setCollection(result.after.adapters); setCapturedAt(Date.now()); setMessage(result.message); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const summary = collection ? summarizeNetwork(collection) : null;
  const collectionNotice = collection ? partialNetworkNotice(collection) : null;
  const { visibleAdapters, otherAdapters } = collection
    ? splitNetworkAdapters(collection.items)
    : { visibleAdapters: [], otherAdapters: [] };
  return <>
    <header className="network-page-heading">
      <div><small>FERRAMENTAS</small><h1>Rede</h1><p>Interfaces, IP, DHCP, gateway, DNS, proxy e testes de conectividade.</p></div>
      <button className="primary network-refresh" disabled={busy||runtimeEnvironment!=='desktop'} onClick={refresh}><RefreshCw size={14}/>{busy?'Atualizando…':'Atualizar diagnóstico'}</button>
    </header>
    {runtimeEnvironment==='web'&&<p className="notice"><Monitor/> A consulta dos adaptadores locais depende do Desktop Windows. Nenhuma coleta local foi executada no navegador.</p>}
    {error&&<p className="error"><CircleAlert/>{error}</p>}
    {message&&<p className="notice">{message}</p>}
    {support&&<NetworkOperationsPanel snapshot={support} busy={busy} operate={operate}/>}
    {collection&&summary&&<>
      {capturedAt&&<p className="network-captured">Atualizado em {new Date(capturedAt).toLocaleString()}</p>}
      {collectionNotice&&<p className="notice"><AlertTriangle/>{collectionNotice}</p>}
      <details className="support-details"><summary>Interfaces e detalhes de rede</summary>
      <section className="network-summary" aria-label="Resumo da rede">
        <div><small>Interfaces relevantes</small><b>{summary.relevantCount}</b><span>na visão principal</span></div>
        <div><small>Conectadas</small><b>{summary.connectedCount}</b><span>estado da interface</span></div>
        <div><small>Físicas desconectadas</small><b>{summary.disconnectedPhysicalCount}</b><span>adaptadores físicos</span></div>
        <div><small>VPNs ativas</small><b>{summary.activeVpnCount}</b><span>túneis conectados</span></div>
        <div><small>Sistema / infraestrutura</small><b>{summary.infrastructureCount}</b><span>em Outras interfaces</span></div>
        <div><small>Outras interfaces</small><b>{summary.otherCount}</b><span>recolhidas abaixo</span></div>
      </section>
      <section className={`network-primary-summary ${summary.primary?'selected':'unknown'}`}>
        <div><small>Conexão principal{summary.primary?' · Conectado':''}</small><b>{summary.primary?.name??'Não determinado'}</b></div>
        {summary.primary
          ? <dl className="network-primary-fields"><div><dt>IPv4</dt><dd>{valueOrUnavailable(summary.primary.ipv4)}</dd></div><div><dt>Gateway IPv4</dt><dd>{valueOrUnavailable(ipv4Values(summary.primary.gateways))}</dd></div><div><dt>DNS IPv4</dt><dd>{valueOrUnavailable(ipv4Values(summary.primary.dnsServers))}</dd></div></dl>
          : <p>{summary.primaryCandidateCount>1?'Há múltiplas interfaces conectadas com IPv4 e gateway; não foi possível escolher uma sem consultar prioridade de rotas.':'Nenhuma interface apresentou simultaneamente conexão confirmada, IPv4 utilizável e gateway.'}</p>}
        <small className="network-connectivity-note">O estado Conectado descreve a interface; não confirma acesso à Internet.</small>
      </section>
      {visibleAdapters.length===0&&<div className="empty network-empty"><Network/><b>Nenhuma interface relevante identificada</b><p>O inventário completo permanece disponível em Outras interfaces.</p></div>}
      {visibleAdapters.length>0&&<><h2 className="network-section-title">Interfaces importantes ({visibleAdapters.length})</h2><section className="network-adapter-list" aria-label="Interfaces importantes">{visibleAdapters.map((adapter,index)=><NetworkAdapterCard key={`${adapter.name}-${index}`} adapter={adapter} isPrimary={adapter===summary.primary}/>)}</section></>}
      {otherAdapters.length>0&&<details className="network-other-interfaces"><summary>Outras interfaces ({otherAdapters.length})</summary><section className="network-adapter-list" aria-label="Outras interfaces">{otherAdapters.map((adapter,index)=><NetworkAdapterCard key={`${adapter.name}-${index}`} adapter={adapter} isPrimary={false}/>)}</section></details>}
      </details>
    </>}
  </>;
}
