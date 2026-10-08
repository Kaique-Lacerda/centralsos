import { NavLink, Outlet } from 'react-router-dom';
import { Activity, Monitor } from 'lucide-react';
import { getProductRuntime } from '../product';

const runtime = getProductRuntime('support', 'web');
export function SupportShell() {
    return <div className="shell" data-product={runtime.product} data-runtime={runtime.identity}>
        <aside className="sidebar"><div className="brand"><div className="brand-mark"><Activity size={19} /></div><div><strong>CENTRAL SOS</strong><small>Suporte</small></div></div>
            <div className="nav-caption">ATENDIMENTO</div><nav><NavLink className="nav-link" to="/control"><Monitor size={17} />Ambientes e dispositivos</NavLink></nav>
            <div className="sidebar-bottom">Prévia Web do Suporte</div>
        </aside>
        <main className="main"><header className="topbar">CENTRAL SOS Suporte<span>Autenticação Web · cookies same-origin</span></header><div className="page"><Outlet /></div></main>
    </div>;
}
