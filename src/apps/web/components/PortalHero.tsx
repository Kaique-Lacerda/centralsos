import type { WindowsReleaseLookup } from '../../../services/releases/GitHubReleaseService';
import type { PortalResource } from '../usePortalResource';
import emblem from '../assets/emblem-hero.webp';
import { DownloadActions } from './DownloadActions';

export function PortalHero({ resource }: { resource: PortalResource<WindowsReleaseLookup> }) {
    return <section className="portal-hero" aria-labelledby="portal-title">
        <div className="portal-container portal-hero-inner"><div className="portal-hero-copy"><p className="portal-eyebrow">PORTAL OFICIAL</p>
            <h1 id="portal-title">CENTRAL <span>SOS</span></h1><p className="portal-hero-description">Downloads e ferramentas para suporte técnico.</p>
            <DownloadActions resource={resource} />
        </div><div className="portal-hero-art" aria-hidden="true"><div className="portal-orbit" /><div className="portal-horizon" /><img src={emblem} alt="" width="640" height="636" /></div></div>
    </section>;
}
