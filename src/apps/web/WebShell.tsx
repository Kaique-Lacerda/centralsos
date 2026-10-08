import { NavLink, Outlet } from 'react-router-dom';
import { Activity } from 'lucide-react';
import { getProductRuntime } from '../product';
import './portal.css';

const runtime = getProductRuntime('web', 'web');
const links = [['/', 'Início'], ['/download/client', 'Baixar Cliente'], ['/download/support', 'Baixar Suporte'], ['/tools', 'Ferramentas homologadas']] as const;
export function WebShell() {
    return <div className="public-portal" data-product={runtime.product} data-runtime={runtime.identity}>
        <header className="portal-header"><div className="brand"><div className="brand-mark"><Activity size={19} /></div><div><strong>CENTRAL SOS</strong><small>Downloads oficiais</small></div></div>
            <nav aria-label="Portal CENTRAL SOS">{links.map(([path, label]) => <NavLink key={path} end={path === '/'} to={path}>{label}</NavLink>)}</nav>
        </header>
        <main className="page"><Outlet /></main>
        <footer className="portal-footer">CENTRAL SOS · Distribuição de aplicativos e ferramentas homologadas</footer>
    </div>;
}
