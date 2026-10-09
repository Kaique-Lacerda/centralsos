import { Outlet } from 'react-router-dom';
import { getProductRuntime } from '../product';
import emblem from './assets/emblem-brand.webp';
import './portal.css';

const runtime = getProductRuntime('web', 'web');
export function WebShell() {
    return <div className="public-portal" data-product={runtime.product} data-runtime={runtime.identity}>
        <a className="portal-skip-link" href="#portal-main">Pular para o conteúdo</a>
        <header className="portal-header"><div className="portal-container"><a className="portal-brand" href="/" aria-label="CENTRAL SOS — início"><img src={emblem} alt="" width="46" height="46" /><strong>CENTRAL <span>SOS</span></strong></a></div>
        </header>
        <main id="portal-main" tabIndex={-1}><Outlet /></main>
        <footer className="portal-footer">CENTRAL SOS · Distribuição de aplicativos e ferramentas homologadas</footer>
    </div>;
}
