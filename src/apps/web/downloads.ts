import type { WindowsReleaseLookup } from '../../services/releases/GitHubReleaseService';
import type { CatalogTool } from '../../services/tools/GitHubToolsService';

/** Defense in depth at the public UI boundary. No new download source or fallback. */
export function officialAssetUrl(value: string | null, assetName: string, tag?: string): string | null {
    if (!value) return null;
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.host !== 'github.com' || url.username || url.password || url.search || url.hash) return null;
        const parts = url.pathname.split('/');
        if (parts.length !== 7 || parts.slice(0, 5).join('/') !== '/Kaique-Lacerda/centralsos/releases/download') return null;
        const release = decodeURIComponent(parts[5]);
        const filename = decodeURIComponent(parts[6]);
        if (!/^(?:tools-)?v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(release)
            || /[\\/]/.test(filename) || filename !== assetName || (tag !== undefined && release !== tag)) return null;
        return value;
    } catch { return null; }
}
export function toolDownloadUrl(tool: CatalogTool, releaseTag?: string) {
    return tool.assetStatus === 'available' ? officialAssetUrl(tool.downloadUrl, tool.assetName, releaseTag) : null;
}
export type ClientDownloadState = { status: 'available' | 'loading' | 'unpublished' | 'unavailable' | 'error'; detail: string; url: string | null };
export function clientDownloadState(lookup: WindowsReleaseLookup | null, loading = false, error = ''): ClientDownloadState {
    if (loading) return { status: 'loading', detail: 'Consultando versão…', url: null };
    if (error) return { status: 'error', detail: 'Temporariamente indisponível', url: null };
    if (!lookup || lookup.status === 'not-published') return { status: 'unpublished', detail: 'Ainda não publicado', url: null };
    if (lookup.status !== 'available') return { status: 'unavailable', detail: lookup.status === 'no-installer' ? 'Instalador não publicado' : 'Release ou instalador ambíguo', url: null };
    // Support, Agent and Helper assets can never enable the Client CTA.
    const name = lookup.asset.name.toLowerCase();
    const isClient = /^central[ ._-]+sos[ ._-]/.test(name) && !/(?:suporte|support|agent|helper|uninstall|updater|portable)/.test(name) && name.endsWith('.exe');
    const isApplicationTag = lookup.version !== null && /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(lookup.version);
    const url = isClient && isApplicationTag ? officialAssetUrl(lookup.asset.downloadUrl, lookup.asset.name, lookup.version!) : null;
    return url ? { status: 'available', detail: 'Download direto', url } : { status: 'unavailable', detail: 'Instalador não validado', url: null };
}
