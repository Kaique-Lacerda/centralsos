import { Search, X } from 'lucide-react';
import type { CatalogCategory, CatalogTool } from '../../../../packages/contracts/catalog';
export const emptyManagedFilters = { search: '', category: '', type: '', compatibility: '', availability: '' };
export type ManagedFiltersValue = typeof emptyManagedFilters;
const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
export function filterManagedTools(tools: readonly CatalogTool[], filters: ManagedFiltersValue) {
    return tools.filter(tool => (!filters.search || normalize([tool.name, tool.description, ...tool.tags].join(' ')).includes(normalize(filters.search)))
        && (!filters.category || tool.categoryId === filters.category) && (!filters.type || tool.type === filters.type)
        && (!filters.compatibility || tool.compatibility === filters.compatibility)
        && (!filters.availability || tool.versions.some(v => v.published) === (filters.availability === 'available')));
}
export function ManagedFilters({ tools, categories, value, onChange }: {
    tools: readonly CatalogTool[]; categories: readonly CatalogCategory[]; value: ManagedFiltersValue; onChange: (value: ManagedFiltersValue) => void;
}) {
    const update = (key: keyof ManagedFiltersValue, next: string) => onChange({ ...value, [key]: next });
    const options = (key: 'type' | 'compatibility') => [...new Set(tools.map(t => t[key]))].sort((a,b) => a.localeCompare(b,'pt-BR'));
    const fields = [
        { key: 'category', label: 'Categoria', options: categories.map(c => ({ id:c.id, name:c.name })) },
        { key: 'type', label: 'Classe / tipo', options: options('type').map(name => ({ id:name, name })) },
        { key: 'compatibility', label: 'Compatibilidade', options: options('compatibility').map(name => ({ id:name, name })) },
        { key: 'availability', label: 'Disponibilidade', options: [{ id:'available',name:'Download disponível' },{ id:'unavailable',name:'Indisponível' }] }
    ] as const;
    const active = Object.entries(value).filter(([,selected]) => selected) as [keyof ManagedFiltersValue,string][];
    const display = (key: keyof ManagedFiltersValue, selected: string) => fields.find(f => f.key === key)?.options.find(o => o.id === selected)?.name ?? selected;
    return <div className="portal-filter-area"><form className="portal-filters" role="search" aria-label="Pesquisar e filtrar ferramentas" onSubmit={e => e.preventDefault()}>
        <label className="portal-search"><span className="portal-sr-only">Buscar ferramenta</span><Search size={18} aria-hidden="true" /><input type="search" placeholder="Buscar ferramenta…" value={value.search} onChange={e => update('search',e.target.value)} /></label>
        {fields.map(field => <label className="portal-select" key={field.key}><span className="portal-sr-only">{field.label}</span><select value={value[field.key]} onChange={e => update(field.key,e.target.value)}><option value="">{field.label}</option>{field.options.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>)}
        <button className="portal-text-button portal-clear" type="button" disabled={!active.length} onClick={() => onChange({ ...emptyManagedFilters })}>Limpar filtros</button>
    </form>{active.length > 0 && <div className="portal-active-filters">{active.map(([key,selected]) => <button key={key} type="button" onClick={() => update(key,'')} aria-label={`Remover filtro ${display(key,selected)}`}>{display(key,selected)}<X size={13} aria-hidden="true" /></button>)}</div>}</div>;
}
