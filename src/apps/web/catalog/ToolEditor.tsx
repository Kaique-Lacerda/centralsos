import { useState, type FormEvent } from 'react';
import type { CatalogCategory, CatalogSession, CatalogTool, CatalogVisibility } from '../../../../packages/contracts/catalog';
import { catalogRequest } from './CatalogApi';
export function ToolEditor({ session, categories, tool, onDone, onCancel }: {
    session: CatalogSession; categories: CatalogCategory[]; tool?: CatalogTool; onDone: () => Promise<void>; onCancel: () => void;
}) {
    const [name, setName] = useState(tool?.name ?? ''), [description, setDescription] = useState(tool?.description ?? '');
    const [categoryId, setCategoryId] = useState(tool?.categoryId ?? categories[0]?.id ?? ''), [newCategory, setNewCategory] = useState('');
    const [type, setType] = useState(tool?.type ?? 'Instalador'), [compatibility, setCompatibility] = useState(tool?.compatibility ?? 'Windows x64');
    const [tags, setTags] = useState(tool?.tags.join(', ') ?? ''), [requiresAdmin, setRequiresAdmin] = useState(tool?.requiresAdmin ?? true);
    const [visibility, setVisibility] = useState<CatalogVisibility>(tool?.visibility === 'admin' ? 'admin' : 'technicians');
    const [busy, setBusy] = useState(false), [error, setError] = useState('');
    async function submit(event: FormEvent) {
        event.preventDefault(); setBusy(true); setError('');
        try {
            let category = categoryId;
            if (newCategory.trim()) {
                category = (await catalogRequest<CatalogCategory>('categories', session, 'POST', { name: newCategory.trim() })).id;
                setCategoryId(category); setNewCategory(''); await onDone();
            }
            await catalogRequest(tool ? `tools/${tool.id}` : 'tools', session, tool ? 'PATCH' : 'POST', { name, description, categoryId: category, type, compatibility,
                tags: tags.split(',').map(tag => tag.trim()).filter(Boolean), requiresAdmin, visibility });
            await onDone(); onCancel();
        } catch (failure) { setError(failure instanceof Error ? failure.message : 'Não foi possível salvar.'); }
        finally { setBusy(false); }
    }
    return <form className="catalog-panel catalog-editor" onSubmit={submit}><h2>{tool ? 'Editar ferramenta' : 'Adicionar ferramenta'}</h2>
        <div className="catalog-form-grid"><label>Nome<input value={name} onChange={e => setName(e.target.value)} required maxLength={120} /></label>
            <label>Visibilidade<select value={visibility} onChange={e => setVisibility(e.target.value as CatalogVisibility)}><option value="technicians">Técnicos</option><option value="admin">Somente administrador</option></select></label>
            <label>Categoria<select value={categoryId} onChange={e => setCategoryId(e.target.value)} disabled={!!newCategory}><option value="">Selecione</option>{categories.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}</select></label>
            <label>Ou criar categoria<input value={newCategory} onChange={e => setNewCategory(e.target.value)} maxLength={80} placeholder="Nova categoria" /></label>
            <label>Classe / tipo<input value={type} onChange={e => setType(e.target.value)} required maxLength={60} /></label>
            <label>Compatibilidade<input value={compatibility} onChange={e => setCompatibility(e.target.value)} required maxLength={160} /></label>
            <label>Tags, separadas por vírgula<input value={tags} onChange={e => setTags(e.target.value)} maxLength={800} /></label>
            <label className="catalog-checkbox"><input type="checkbox" checked={requiresAdmin} onChange={e => setRequiresAdmin(e.target.checked)} /> Instalação exige administrador</label>
        </div><label>Descrição<textarea value={description} onChange={e => setDescription(e.target.value)} required maxLength={2000} rows={3} /></label>
        {!tool && <p>Após cadastrar, envie o instalador e aprove sua publicação.</p>}
        {error && <p role="alert" className="catalog-error">{error}</p>}
        <div className="catalog-actions"><button className="portal-tool-download" disabled={busy || (!categoryId && !newCategory.trim())}>{busy ? 'Salvando…' : 'Salvar ferramenta'}</button><button className="portal-refresh" type="button" disabled={busy} onClick={onCancel}>Cancelar</button></div>
    </form>;
}
