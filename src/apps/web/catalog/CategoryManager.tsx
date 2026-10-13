import { useState, type FormEvent } from 'react';
import type { CatalogCategory, CatalogSession } from '../../../../packages/contracts/catalog';
import { catalogRequest } from './CatalogApi';
export function CategoryManager({ session, categories, onDone }: { session: CatalogSession; categories: CatalogCategory[]; onDone: () => Promise<void> }) {
    const [selected,setSelected] = useState(''), [name,setName] = useState(''), [busy,setBusy] = useState(false), [error,setError] = useState('');
    async function submit(event: FormEvent) {
        event.preventDefault(); setBusy(true); setError('');
        try { await catalogRequest(selected ? `categories/${selected}` : 'categories',session,selected ? 'PATCH' : 'POST',{ name }); await onDone(); setSelected(''); setName(''); }
        catch (failure) { setError(failure instanceof Error ? failure.message : 'Não foi possível salvar a categoria.'); }
        finally { setBusy(false); }
    }
    return <details className="catalog-panel catalog-category-manager"><summary>Gerenciar categorias</summary><form onSubmit={submit}>
        <label>Categoria para editar<select value={selected} disabled={busy} onChange={e => { setSelected(e.target.value); setName(categories.find(c => c.id === e.target.value)?.name ?? ''); }}><option value="">Criar nova categoria</option>{categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label>Nome da categoria<input value={name} onChange={e => setName(e.target.value)} maxLength={80} required disabled={busy} /></label>
        <button className="portal-tool-download" disabled={busy}>{selected ? 'Salvar categoria' : 'Adicionar categoria'}</button>{error && <p role="alert" className="catalog-error">{error}</p>}
    </form></details>;
}
