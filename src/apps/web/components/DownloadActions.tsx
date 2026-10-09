import { Download, LoaderCircle, RefreshCw } from 'lucide-react';
import type { WindowsReleaseLookup } from '../../../services/releases/GitHubReleaseService';
import { clientDownloadState } from '../downloads';
import { formatBytes } from '../catalog';
import type { PortalResource } from '../usePortalResource';

export function DownloadActions({ resource }: { resource: PortalResource<WindowsReleaseLookup> }) {
    const client = clientDownloadState(resource.data, resource.loading, resource.error);
    const label = <><span className="portal-download-symbol">{resource.loading ? <LoaderCircle className="portal-spin" size={29} aria-hidden="true" /> : <Download size={29} aria-hidden="true" />}</span><span><strong>Baixar Cliente</strong><small>{client.detail}</small></span></>;
    const release = resource.data?.status === 'available' ? resource.data : null;
    return <div id="downloads" className="portal-downloads">
        <div className="portal-download-buttons">
            {client.url ? <a className="portal-download primary-download" href={client.url} download aria-describedby="client-release-info">{label}</a>
                : <button className="portal-download primary-download" disabled aria-describedby="client-release-info">{label}</button>}
            <button className="portal-download secondary-download" disabled aria-describedby="support-release-info"><span className="portal-download-symbol"><Download size={29} aria-hidden="true" /></span><span><strong>Baixar Suporte</strong><small>Ainda não publicado</small></span></button>
        </div>
        <div className="portal-download-information" aria-live="polite">
            <p id="client-release-info">{client.status === 'available' && release ? <><span>Cliente {release.version}</span><span>Windows · {formatBytes(release.asset.sizeBytes)}</span></>
                : <span>{client.status === 'error' ? `Não foi possível consultar o Cliente. ${resource.error}` : client.detail}</span>}</p>
            <p id="support-release-info">O instalador próprio do Suporte ainda não foi publicado.</p>
            <button className="portal-text-button" onClick={resource.refresh} disabled={resource.loading}><RefreshCw size={12} aria-hidden="true" />Atualizar versões</button>
        </div>
    </div>;
}
