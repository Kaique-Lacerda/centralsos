import { Search, X } from 'lucide-react';
import type { CatalogTool } from '../../../services/tools/GitHubToolsService';
import { emptyFilters, filterOptions, typeLabel, type ToolFilters as Filters } from '../catalog';

export function ToolFilters({ tools, filters, onChange }: { tools: readonly CatalogTool[]; filters: Filters; onChange: (filters: Filters) => void }) {
    const options = filterOptions(tools);
    const update = (key: keyof Filters, value: string) => onChange({ ...filters, [key]: value });
    const fields = [
        { key: 'category', label: 'Categoria', values: options.category },
        { key: 'type', label: 'Classe / tipo', values: options.type },
        { key: 'architecture', label: 'Arquitetura', values: options.architecture },
        { key: 'availability', label: 'Disponibilidade', values: ['available', 'unavailable'] },
    ] as const;
    const display = (key: keyof Filters, value: string) => key === 'type' ? typeLabel(value) : key === 'availability' ? value === 'available' ? 'Download disponível' : 'Indisponível' : value;
    const active = Object.entries(filters).filter(([, value]) => value) as [keyof Filters, string][];
    return <div className="portal-filter-area"><form className="portal-filters" role="search" aria-label="Pesquisar e filtrar ferramentas" onSubmit={event => event.preventDefault()}>
        <label className="portal-search"><span className="portal-sr-only">Pesquisar por nome ou descrição</span><Search size={18} aria-hidden="true" /><input type="search" placeholder="Buscar ferramenta…" value={filters.search} onChange={event => update('search', event.target.value)} /></label>
        {fields.map(field => <label className="portal-select" key={field.key}><span className="portal-sr-only">{field.label}</span><select value={filters[field.key]} onChange={event => update(field.key, event.target.value)}><option value="">{field.label}</option>{field.values.map(value => <option key={value} value={value}>{display(field.key, value)}</option>)}</select></label>)}
        <button type="button" className="portal-text-button portal-clear" disabled={!active.length} onClick={() => onChange({ ...emptyFilters })}>Limpar filtros</button>
    </form>{active.length > 0 && <div className="portal-active-filters" aria-label="Filtros ativos">{active.map(([key, value]) => <button key={key} type="button" onClick={() => update(key, '')} aria-label={`Remover filtro ${key === 'search' ? 'pesquisa' : fields.find(field => field.key === key)?.label}: ${display(key, value)}`}>{display(key, value)}<X size={13} aria-hidden="true" /></button>)}</div>}</div>;
}
