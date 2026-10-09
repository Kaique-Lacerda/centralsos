import type { CatalogTool } from '../../services/tools/GitHubToolsService';
import { toolDownloadUrl } from './downloads';

// Presentation metadata for exact published IDs; this does not alter the manifest
// or assert compatibility/homologation. Unknown records remain unclassified.
export const toolCategories: Readonly<Record<string, string>> = {
    'firebird-2.5.9': 'Banco de dados',
    iboconsole: 'Banco de dados',
    'nuvem-contabil-1.0.29': 'Fiscal e documentos',
};
export const categoryOf = (tool: CatalogTool) => toolCategories[tool.id] ?? 'Não classificada';
export const typeLabel = (value: string) => ({ installer: 'Instalador', utility: 'Utilitário' }[value] ?? value);
export const architectureOf = (tool: CatalogTool) => tool.architecture ?? 'Não informada';
export function normalizeSearch(value: string) {
    return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').trim();
}
export type ToolFilters = { search: string; category: string; type: string; architecture: string; availability: string };
export const emptyFilters: ToolFilters = { search: '', category: '', type: '', architecture: '', availability: '' };
export function filterTools(tools: readonly CatalogTool[], filters: ToolFilters, releaseTag?: string) {
    const query = normalizeSearch(filters.search);
    return tools.filter(tool => (!query || normalizeSearch(`${tool.name} ${tool.description}`).includes(query))
        && (!filters.category || categoryOf(tool) === filters.category)
        && (!filters.type || tool.type === filters.type)
        && (!filters.architecture || architectureOf(tool) === filters.architecture)
        && (!filters.availability || (toolDownloadUrl(tool, releaseTag) ? 'available' : 'unavailable') === filters.availability));
}
export function filterOptions(tools: readonly CatalogTool[]) {
    const unique = (values: string[]) => [...new Set(values)].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    return { category: unique(tools.map(categoryOf)), type: unique(tools.map(tool => tool.type)), architecture: unique(tools.map(architectureOf)) };
}
export function formatBytes(bytes: number | null) {
    if (bytes === null) return 'Não informado';
    return bytes < 1024 * 1024 ? `${(bytes / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} KB`
        : `${(bytes / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`;
}
