import { Download } from 'lucide-react';
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { distributionProducts } from '../../services/distribution/products';
import { getLatestWindowsRelease } from '../../services/releases/GitHubReleaseService';
import { getGitHubToolsCatalog } from '../../services/tools/GitHubToolsService';
import { usePortalResource } from './usePortalResource';
import { PortalHero } from './components/PortalHero';
import { ToolCatalog } from './components/ToolCatalog';

const loadClient = (refresh: boolean) => getLatestWindowsRelease({ refresh });
const loadTools = (refresh: boolean) => getGitHubToolsCatalog({ refresh, runtime: 'web' });

export function PortalHome() {
    const client = usePortalResource(loadClient);
    const tools = usePortalResource(loadTools);
    const { hash } = useLocation();
    useEffect(() => {
        // Wait for the final page height before scrolling legacy public links.
        if ((hash !== '#tools' && hash !== '#downloads') || client.loading || tools.loading) return;
        const frame = requestAnimationFrame(() => document.getElementById(hash.slice(1))?.scrollIntoView());
        return () => cancelAnimationFrame(frame);
    }, [hash, client.loading, tools.loading]);
    return <><PortalHero resource={client} /><ToolCatalog resource={tools} /></>;
}
export function SupportDownloadPage() {
    return <><div className="heading"><small>APLICATIVO DO TÉCNICO</small><h1>{distributionProducts.support.name}</h1><p>{distributionProducts.support.description}</p></div>
        <section className="panel release-card"><div className="release-icon"><Download /></div><div className="release-content"><b>Em desenvolvimento</b><p>O instalador do Suporte ainda não foi publicado.</p></div><button className="primary" disabled>Indisponível</button></section>
    </>;
}
