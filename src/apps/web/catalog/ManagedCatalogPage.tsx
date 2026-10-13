import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Package, Plus, RefreshCw } from 'lucide-react';
import type { CatalogCategory, CatalogTool, CatalogAudit } from '../../../../packages/contracts/catalog';
import { useCatalogAccess } from './CatalogAccess';
import { ToolEditor } from './ToolEditor';
import { CatalogApiError, catalogRequest } from './CatalogApi';
import { CatalogSecurity } from './CatalogSecurity';
import { CategoryManager } from './CategoryManager';
import { ManagedToolCard } from './ManagedToolCard';
import { ManagedFilters, emptyManagedFilters, filterManagedTools } from './ManagedFilters';
import './catalog.css';
export function ManagedCatalogPage() {
    const { session, endSession } = useCatalogAccess();
    const [ready,setReady] = useState(false), [loading,setLoading] = useState(true);
    const [tools,setTools] = useState<CatalogTool[]>([]), [categories,setCategories] = useState<CatalogCategory[]>([]);
    const [filters,setFilters] = useState({ ...emptyManagedFilters }), [error,setError] = useState('');
    const [editor,setEditor] = useState<CatalogTool | 'new' | null>(null), [busy,setBusy] = useState(false), [history,setHistory] = useState<CatalogAudit[] | null>(null);
    const requestGeneration = useRef(0);
    const refresh = useCallback(async () => {
        const generation = ++requestGeneration.current; setLoading(true);
        try {
            const [nextTools,nextCategories] = await Promise.all([catalogRequest<CatalogTool[]>('tools',session),catalogRequest<CatalogCategory[]>('categories',session)]);
            if (generation === requestGeneration.current) { setTools(nextTools); setCategories(nextCategories); setReady(true); setError(''); }
        } finally { if (generation === requestGeneration.current) setLoading(false); }
    }, [session]);
    useEffect(() => { void refresh().catch(failure => setError(failure.message)); return () => { requestGeneration.current++; }; }, [refresh]);
    const shown = useMemo(() => filterManagedTools(tools,filters), [tools,filters]);
    async function action(work: () => Promise<unknown>) {
        setBusy(true); setError('');
        try { await work(); await refresh(); }
        catch (failure) { setError(failure instanceof Error ? failure.message : 'Não foi possível concluir.'); if (failure instanceof CatalogApiError && failure.status === 401) endSession(); }
        finally { setBusy(false); }
    }
    return <section className="portal-container portal-catalog managed-catalog unified-catalog" id="tools" aria-labelledby="tools-title" aria-busy={loading}>
        <header className="portal-catalog-heading"><div><p className="portal-eyebrow">CATÁLOGO OFICIAL</p><h2 id="tools-title">Ferramentas <span>homologadas</span></h2><p>Encontre ferramentas aprovadas para suporte, instalação e diagnóstico.</p></div>
            <button className="portal-refresh" disabled={loading || busy} onClick={() => void action(refresh)} aria-label="Atualizar catálogo"><RefreshCw size={16} aria-hidden="true" /><span>Atualizar</span></button>
        </header>
        {session.role === 'admin' && <div className="catalog-admin-bar"><span>Gerencie as ferramentas desta mesma listagem.</span><button className="portal-tool-download" onClick={() => setEditor('new')} disabled={busy}><Plus size={16} /> Adicionar ferramenta</button></div>}
        {session.role === 'admin' && editor && <ToolEditor key={editor === 'new' ? 'new' : editor.id} session={session} categories={categories} tool={editor === 'new' ? undefined : editor} onDone={refresh} onCancel={() => setEditor(null)} />}
        <ManagedFilters tools={tools} categories={categories} value={filters} onChange={setFilters} />
        {ready && <div className="portal-catalog-count" role="status"><span>{shown.length} {shown.length === 1 ? 'ferramenta encontrada' : 'ferramentas encontradas'}</span><span>Catálogo CENTRAL SOS</span></div>}
        {!ready && !error && <div className="portal-catalog-state" role="status"><Package size={28} /><h3>Carregando catálogo</h3><p>Consultando as ferramentas autorizadas.</p></div>}
        {error && <div role="alert" className="catalog-error catalog-panel">{error}<button className="portal-text-button" onClick={() => void action(refresh)}>Tentar novamente</button></div>}
        <div className="portal-tool-grid">{shown.map(tool => <ManagedToolCard key={tool.id} tool={tool} session={session} busy={busy} onAction={action} onRefresh={refresh} onEdit={() => setEditor(tool)} />)}</div>
        {ready && !shown.length && !error && <div className="portal-catalog-state"><Package size={28} /><h3>{tools.length ? 'Nenhuma ferramenta encontrada' : 'Nenhuma ferramenta disponível'}</h3><p>{tools.length ? 'Tente outro termo ou remova um filtro.' : session.role === 'admin' ? 'Adicione uma ferramenta e envie sua primeira versão.' : 'Ferramentas aprovadas para este acesso aparecerão aqui.'}</p></div>}
        <p className="portal-catalog-note">A disponibilidade não comprova compatibilidade. Confira a versão e os detalhes antes de instalar.</p>
        {session.role === 'admin' && <div className="catalog-management"><CategoryManager session={session} categories={categories} onDone={refresh} /><CatalogSecurity session={session} onRevoked={endSession} onError={setError} />
            <details className="catalog-panel catalog-history"><summary onClick={() => void catalogRequest<CatalogAudit[]>('audit',session).then(setHistory).catch(f => setError(f.message))}>Registros administrativos</summary>
                {history?.map(entry => <p key={entry.id}><time>{new Date(entry.createdAt).toLocaleString('pt-BR')}</time> · {entry.role} · {entry.action}</p>)}<small>Registros identificam o nível e a sessão, não a pessoa que usou uma senha compartilhada.</small></details></div>}
    </section>;
}
