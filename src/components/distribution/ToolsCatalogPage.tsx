import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, CircleAlert, Download, Package, RefreshCw, ShieldCheck } from 'lucide-react';
import { getGitHubToolsCatalog, type CatalogTool, type GitHubToolsLookup } from '../../services/tools/GitHubToolsService';
import '../../installations.css';

function formatToolSize(bytes: number | null) {
  if (bytes === null) return 'Tamanho não informado';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} KB`;
  return `${(bytes / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;
}

function assetProblem(tool: CatalogTool) {
  if (tool.assetStatus === 'missing') return `Asset não encontrado na Release: ${tool.assetName}`;
  if (tool.assetStatus === 'name-mismatch') return `Nome divergente: manifesto declara ${tool.assetName}, Release contém ${tool.actualAssetName ?? 'outro nome'}.`;
  if (tool.assetStatus === 'ambiguous') return `Mais de um asset chamado ${tool.assetName} foi publicado.`;
  if (tool.assetStatus === 'invalid-url') return 'A URL de download do asset não foi validada como URL oficial do repositório.';
  return '';
}

function ToolCard({ tool, renderInstallation }: { tool: CatalogTool; renderInstallation?: (tool: CatalogTool) => ReactNode }) {
  const problem = assetProblem(tool);
  return <article className="installation-tool-card">
    <div className="installation-tool-icon"><Package size={18}/></div>
    <div className="installation-tool-body">
      <div className="installation-tool-title"><h2>{tool.name}</h2><span className="installation-tool-type">{tool.type}</span></div>
      <p>{tool.description}</p>
      {renderInstallation ? renderInstallation(tool) : <div className={`installation-state-badge ${tool.assetStatus === 'available' ? 'available' : 'unavailable'}`}>{tool.assetStatus === 'available' ? 'Download disponível' : 'Indisponível'}</div>}
      <div className="installation-tool-metadata">
        <span>Disponível: {tool.version}</span><span>{formatToolSize(tool.sizeBytes)}</span>
        <span>{tool.architecture ?? 'Arquitetura não informada'}</span>
        {tool.requiresAdmin && <span className="installation-admin"><ShieldCheck size={13}/> Requer administrador</span>}
      </div>
      {problem && <p className="installation-asset-problem"><AlertTriangle size={14}/>{problem}</p>}
      <details className="installation-integrity"><summary>SHA-256 esperado</summary><code>{tool.sha256}</code></details>
    </div>
    {tool.downloadUrl
      ? <a className="primary installation-download" href={tool.downloadUrl} target="_blank" rel="noopener noreferrer"><Download size={14}/>Baixar</a>
      : <button className="primary installation-download" disabled><Download size={14}/>Indisponível</button>}
  </article>;
}

function CatalogContent({ lookup, error, loading, retry, renderInstallation }: {
  lookup: GitHubToolsLookup | null;
  error: string;
  loading: boolean;
  retry: () => void;
  renderInstallation?: (tool: CatalogTool) => ReactNode;
}) {
  if (loading && !lookup) return <div className="empty installations-empty"><RefreshCw className="installation-spinner"/><b>Carregando catálogo</b><p>Consultando Releases de ferramentas do CENTRAL SOS.</p></div>;
  if (error) return <div className="installation-state error"><CircleAlert/><div><b>Não foi possível carregar o catálogo</b><p>{error}</p><button className="linkbtn" onClick={retry}>Tentar novamente</button></div></div>;
  if (!lookup || lookup.status === 'not-published') return <div className="empty installations-empty"><Package/><b>Nenhuma Release de ferramentas publicada</b><p>O catálogo aparecerá aqui quando uma Release com tag tools-* for publicada.</p></div>;
  if (lookup.status === 'manifest-missing') return <div className="installation-state warning"><CircleAlert/><div><b>Manifesto não encontrado</b><p>A Release {lookup.release.tagName} não contém o asset tools-manifest.json.</p><button className="linkbtn" onClick={retry}>Atualizar catálogo</button></div></div>;
  if (lookup.status === 'manifest-invalid') return <div className="installation-state error"><CircleAlert/><div><b>Manifesto inválido</b><p>Release {lookup.release.tagName}: {lookup.reason}</p><button className="linkbtn" onClick={retry}>Tentar novamente</button></div></div>;
  if (lookup.tools.length === 0) return <div className="empty installations-empty"><Package/><b>Nenhuma ferramenta nesta Release</b><p>O manifesto de {lookup.release.tagName} está válido, mas não lista ferramentas.</p></div>;
  return <div className="installation-tool-list">{lookup.tools.map(tool => <ToolCard key={tool.id} tool={tool} renderInstallation={renderInstallation}/>)}</div>;
}

const loadPublicCatalog = (refresh: boolean) => getGitHubToolsCatalog({ refresh, runtime: 'web' });
export function ToolsCatalogPage({ title = 'Instalações', loadCatalog = loadPublicCatalog, onRefresh, renderInstallation }: {
  title?: string;
  loadCatalog?: (refresh: boolean) => Promise<GitHubToolsLookup>;
  onRefresh?: () => void;
  renderInstallation?: (tool: CatalogTool) => ReactNode;
}) {
  const [lookup, setLookup] = useState<GitHubToolsLookup | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const requestId = useRef(0);
  const load = useCallback(async (refresh = false) => {
    const id = ++requestId.current;
    setLoading(true); setError('');
    try {
      const result = await loadCatalog(refresh);
      if (id === requestId.current) { setLookup(result); setCheckedAt(Date.now()); }
    } catch (cause) {
      if (id === requestId.current) setError(cause instanceof Error ? cause.message : 'Falha ao consultar o catálogo de ferramentas.');
    } finally {
      if (id === requestId.current) { setLoading(false); onRefresh?.(); }
    }
  }, [loadCatalog, onRefresh]);
  useEffect(() => { void load(); return () => { requestId.current++; }; }, [load]);
  const release = lookup?.status === 'available' || lookup?.status === 'manifest-missing' || lookup?.status === 'manifest-invalid' ? lookup.release : null;

  return <>
    <header className="installations-heading"><div><small>CATÁLOGO REMOTO · FERRAMENTAS</small><h1>{title}</h1><p>Downloads oficiais publicados nas Releases de ferramentas do CENTRAL SOS.</p></div><button className="primary installations-refresh" disabled={loading} onClick={() => void load(true)}><RefreshCw size={14}/>{loading ? 'Atualizando…' : 'Atualizar catálogo'}</button></header>
    {release && <div className="installations-release"><span>Catálogo {release.tagName}</span>{release.publishedAt && <span>Publicado em {new Date(release.publishedAt).toLocaleDateString('pt-BR')}</span>}{checkedAt && <span>Consultado em {new Date(checkedAt).toLocaleString('pt-BR')}</span>}</div>}
    <p className="installations-safety"><ShieldCheck size={15}/> Os arquivos são baixados diretamente dos assets da Release. O CENTRAL SOS nunca os executa automaticamente. O SHA-256 é registrado e exibido como esperado; a verificação do arquivo baixado ainda não está implementada.</p>
    <CatalogContent lookup={lookup} error={error} loading={loading} retry={() => void load(true)} renderInstallation={renderInstallation}/>
  </>;
}
