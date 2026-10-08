import { Link } from 'react-router-dom';
import { ArrowRight, Box, Download } from 'lucide-react';
import { distributionProducts } from '../../services/distribution/products';

export function PortalHome() {
    return <><div className="heading"><small>PORTAL DE DISTRIBUIÇÃO</small><h1>CENTRAL SOS</h1><p>Aplicativos Windows e ferramentas homologadas para suporte técnico.</p></div>
        <div className="portal-cards">
            <Link className="panel" to="/download/client"><Download /><h2>Baixar Cliente</h2><p>{distributionProducts.client.description}</p><span>Consultar versão e instalador oficial <ArrowRight size={14} /></span></Link>
            <Link className="panel" to="/download/support"><Download /><h2>Baixar Suporte</h2><p>{distributionProducts.support.description}</p><span>Em desenvolvimento</span></Link>
            <Link className="panel" to="/tools"><Box /><h2>Ferramentas homologadas</h2><p>Instaladores auxiliares publicados no catálogo oficial.</p><span>Abrir catálogo <ArrowRight size={14} /></span></Link>
        </div><section className="panel"><h2>Instalação do Cliente</h2><p>Baixe o instalador oficial para Windows, abra o arquivo e siga as instruções. Ferramentas auxiliares são downloads separados e não são executadas automaticamente pelo portal.</p></section>
    </>;
}
export function SupportDownloadPage() {
    return <><div className="heading"><small>APLICATIVO DO TÉCNICO</small><h1>{distributionProducts.support.name}</h1><p>{distributionProducts.support.description}</p></div>
        <section className="panel release-card"><div className="release-icon"><Download /></div><div className="release-content"><b>Em desenvolvimento</b><p>O instalador do Suporte ainda não foi publicado.</p></div><button className="primary" disabled>Indisponível</button></section>
    </>;
}
