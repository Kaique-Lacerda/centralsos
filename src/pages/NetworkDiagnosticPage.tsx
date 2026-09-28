import { useState } from 'react';
import { AlertTriangle, CircleAlert, Monitor, Network, RefreshCw } from 'lucide-react';
import { runtimeEnvironment } from '../services/runtime/environment';
import { NetworkService } from '../services/network/NetworkService';
import { classifyNetworkAdapter, networkConnectionState, partialNetworkNotice, summarizeNetwork } from '../services/network/NetworkDiagnostic';
import type { NetworkAdapterSnapshot, SnapshotCollection } from '../types/machine';
import '../network-diagnostic.css';

const stateLabels = { connected: 'Conectado', disconnected: 'Desconectado', connecting: 'Conectando', unknown: 'Não conclusivo' } as const;

function valueOrUnavailable(values: string[], fallback = 'Não disponível') {
  return values.length ? values.join(', ') : fallback;
}

function NetworkAdapterCard({ adapter, isPrimary }: { adapter: NetworkAdapterSnapshot; isPrimary: boolean }) {
  const kind = classifyNetworkAdapter(adapter);
  const state = networkConnectionState(adapter.status);
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
      <div><dt>MAC</dt><dd>{adapter.mac||'Não disponível'}</dd></div>
      <div><dt>IPv4</dt><dd>{valueOrUnavailable(adapter.ipv4)}</dd></div>
      <div><dt>IPv6</dt><dd>{valueOrUnavailable(adapter.ipv6)}</dd></div>
      <div><dt>Gateway</dt><dd>{valueOrUnavailable(adapter.gateways,'Não disponível')}</dd></div>
      <div><dt>DNS</dt><dd>{valueOrUnavailable(adapter.dnsServers,'Não disponível')}</dd></div>
    </dl>
  </article>;
}

export function NetworkDiagnosticPage() {
  const [collection, setCollection] = useState<SnapshotCollection<NetworkAdapterSnapshot>|null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [capturedAt, setCapturedAt] = useState<number|null>(null);

  const refresh = async () => {
    if (runtimeEnvironment !== 'desktop') return;
    setBusy(true); setError('');
    try {
      setCollection(await NetworkService.getAdapters());
      setCapturedAt(Date.now());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Falha ao coletar os adaptadores de rede.');
    } finally { setBusy(false); }
  };

  const summary = collection ? summarizeNetwork(collection) : null;
  const collectionNotice = collection ? partialNetworkNotice(collection) : null;
  return <>
    <header className="network-page-heading">
      <div><small>FERRAMENTA · CONECTIVIDADE</small><h1>Diagnóstico de Rede</h1><p>Interfaces, endereços e rotas disponíveis no snapshot. Consulta somente leitura.</p></div>
      <button className="primary network-refresh" disabled={busy||runtimeEnvironment!=='desktop'} onClick={refresh}><RefreshCw size={14}/>{busy?'Atualizando…':'Atualizar diagnóstico'}</button>
    </header>
    {runtimeEnvironment==='web'&&<p className="notice"><Monitor/> A consulta dos adaptadores locais depende do Desktop Windows. Nenhuma coleta local foi executada no navegador.</p>}
    {error&&<p className="error"><CircleAlert/>{error}</p>}
    {collection&&summary&&<>
      {capturedAt&&<p className="network-captured">Atualizado em {new Date(capturedAt).toLocaleString()}</p>}
      {collectionNotice&&<p className="notice"><AlertTriangle/>{collectionNotice}</p>}
      <section className="network-summary" aria-label="Resumo da rede">
        <div><small>Interfaces</small><b>{summary.total}</b><span>retornadas pelo Windows</span></div>
        <div><small>Conectadas</small><b>{summary.connected}</b><span>estado confirmado</span></div>
        <div><small>Desconectadas</small><b>{summary.disconnected}</b><span>estado confirmado</span></div>
        <div><small>VPNs</small><b>{summary.vpns}</b><span>indicadores identificados</span></div>
        <div><small>Virtuais / sistema</small><b>{summary.virtualOrSystem}</b><span>classificação identificada</span></div>
      </section>
      <section className={`network-primary-summary ${summary.primary?'selected':'unknown'}`}>
        <div><small>Conexão principal</small><b>{summary.primary?.name??'Não determinado'}</b></div>
        {summary.primary
          ? <p>{valueOrUnavailable(summary.primary.ipv4)} · Gateway {valueOrUnavailable(summary.primary.gateways)} · DNS {valueOrUnavailable(summary.primary.dnsServers)}</p>
          : <p>{summary.primaryCandidateCount>1?'Há múltiplas interfaces conectadas com IPv4 e gateway; não foi possível escolher uma sem consultar prioridade de rotas.':'Nenhuma interface apresentou simultaneamente conexão confirmada, IPv4 utilizável e gateway.'}</p>}
      </section>
      {summary.total===0
        ? <div className="empty network-empty"><Network/><b>Nenhuma interface retornada</b><p>{collection.error?'Consulte o aviso de coleta parcial acima.':'O Windows não retornou adaptadores de rede.'}</p></div>
        : <section className="network-adapter-list" aria-label="Interfaces de rede">{collection.items.map((adapter,index)=><NetworkAdapterCard key={`${adapter.name}-${index}`} adapter={adapter} isPrimary={adapter===summary.primary}/>)}</section>}
    </>}
  </>;
}
