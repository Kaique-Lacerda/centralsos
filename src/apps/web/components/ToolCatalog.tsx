import { useState } from 'react';
import { CircleAlert, LoaderCircle, Package, RefreshCw, Search } from 'lucide-react';
import type { GitHubToolsLookup } from '../../../services/tools/GitHubToolsService';
import type { PortalResource } from '../usePortalResource';
import { emptyFilters, filterTools } from '../catalog';
import { ToolFilters } from './ToolFilters';
import { ToolCard } from './ToolCard';

export function ToolCatalog({ resource }: { resource: PortalResource<GitHubToolsLookup> }) {
    const [filters, setFilters] = useState({ ...emptyFilters });
    const { data, error, loading, refresh } = resource;
    const tools = data?.status === 'available' ? data.tools : [];
    const visible = filterTools(tools, filters, data?.status === 'available' ? data.release.tagName : undefined);
    const catalogReady = !loading && !error && data?.status === 'available';
    const state = error ? { title: 'Não foi possível carregar o catálogo', text: error, icon: CircleAlert }
        : loading ? { title: 'Carregando catálogo', text: 'Consultando as ferramentas publicadas no GitHub.', icon: LoaderCircle }
        : data?.status === 'manifest-missing' ? { title: 'Manifesto não encontrado', text: 'A Release de ferramentas não contém o catálogo necessário. Tente atualizar mais tarde.', icon: CircleAlert }
        : data?.status === 'manifest-invalid' ? { title: 'Manifesto inválido', text: data.reason, icon: CircleAlert }
        : !data || data.status === 'not-published' ? { title: 'Catálogo ainda não publicado', text: 'As ferramentas aparecerão aqui quando uma Release oficial estiver disponível.', icon: Package }
        : tools.length === 0 ? { title: 'Nenhuma ferramenta publicada', text: 'O catálogo está válido, mas ainda não possui ferramentas.', icon: Package }
        : visible.length === 0 ? { title: 'Nenhuma ferramenta encontrada', text: 'Tente outro termo ou remova um filtro para ampliar a busca.', icon: Search } : null;
    return <section className="portal-container portal-catalog" id="tools" aria-labelledby="tools-title" aria-busy={loading}>
        <header className="portal-catalog-heading"><div><p className="portal-eyebrow">CATÁLOGO OFICIAL</p><h2 id="tools-title">Ferramentas <span>homologadas</span></h2><p>Encontre ferramentas aprovadas para suporte, instalação e diagnóstico.</p></div><button className="portal-refresh" onClick={refresh} disabled={loading} aria-label="Atualizar catálogo"><RefreshCw size={16} className={loading ? 'portal-spin' : undefined} aria-hidden="true" /><span>Atualizar</span></button></header>
        <ToolFilters tools={tools} filters={filters} onChange={setFilters} />
        {catalogReady && <div className="portal-catalog-count" role="status"><span>{visible.length} {visible.length === 1 ? 'ferramenta encontrada' : 'ferramentas encontradas'}</span><span>{data.release.tagName}</span></div>}
        {state ? <div className="portal-catalog-state" role={error || data?.status === 'manifest-invalid' ? 'alert' : 'status'}><state.icon className={loading ? 'portal-spin' : undefined} size={28} aria-hidden="true" /><h3>{state.title}</h3><p>{state.text}</p>{!loading && (error || data?.status === 'manifest-missing' || data?.status === 'manifest-invalid') && <button className="portal-text-button" onClick={refresh}>Tentar novamente</button>}{catalogReady && tools.length > 0 && <button className="portal-text-button" onClick={() => setFilters({ ...emptyFilters })}>Limpar filtros</button>}</div>
            : data?.status === 'available' && <div className="portal-tool-grid">{visible.map(tool => <ToolCard key={tool.id} tool={tool} releaseTag={data.release.tagName} />)}</div>}
        <p className="portal-catalog-note">Downloads diretos dos assets oficiais. Disponibilidade não comprova compatibilidade com sua máquina; confira os detalhes antes de instalar.</p>
    </section>;
}
