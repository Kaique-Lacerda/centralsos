import { Check, CircleAlert, Cloud, Database, Download, Package, ShieldCheck } from 'lucide-react';
import type { CatalogTool } from '../../../services/tools/GitHubToolsService';
import { architectureOf, categoryOf, formatBytes, typeLabel } from '../catalog';
import { toolDownloadUrl } from '../downloads';

export function ToolCard({ tool, releaseTag }: { tool: CatalogTool; releaseTag: string }) {
    const category = categoryOf(tool);
    const Icon = category === 'Banco de dados' ? Database : category === 'Fiscal e documentos' ? Cloud : Package;
    const url = toolDownloadUrl(tool, releaseTag);
    const reasons = { missing: 'O arquivo declarado não foi publicado.', 'name-mismatch': 'O nome do arquivo diverge do manifesto.', ambiguous: 'Há arquivos duplicados nesta Release.', 'invalid-url': 'A origem do arquivo não foi validada.', available: 'A URL do arquivo não corresponde ao catálogo oficial.' };
    return <article className="portal-tool-card" aria-labelledby={`tool-${tool.id}`}>
        <div className="portal-tool-main"><div className="portal-tool-icon"><Icon size={26} strokeWidth={1.8} aria-hidden="true" /></div><div className="portal-tool-copy"><h3 id={`tool-${tool.id}`}>{tool.name}</h3><p className="portal-tool-classification">{category} <span>·</span> {typeLabel(tool.type)}</p><p className="portal-tool-description">{tool.description}</p></div></div>
        <div className="portal-tool-actions"><span className={`portal-badge ${url ? 'available' : 'unavailable'}`}>{url ? <Check size={12} aria-hidden="true" /> : <CircleAlert size={12} aria-hidden="true" />}{url ? 'Disponível' : 'Indisponível'}</span>
            {url ? <a className="portal-tool-download" href={url} download aria-label={`Baixar ${tool.name}`}><Download size={16} aria-hidden="true" />Baixar</a> : <button className="portal-tool-download" disabled aria-label={`Download de ${tool.name} indisponível`}>Indisponível</button>}
        </div>
        {!url && <p className="portal-tool-problem">{reasons[tool.assetStatus]}</p>}
        <details className="portal-tool-details"><summary>Detalhes do arquivo</summary><dl><div><dt>Versão</dt><dd>{tool.version}</dd></div><div><dt>Arquitetura</dt><dd>{architectureOf(tool)}</dd></div><div><dt>Tamanho</dt><dd>{formatBytes(tool.sizeBytes)}</dd></div><div><dt>Administrador</dt><dd>{tool.requiresAdmin ? <><ShieldCheck size={12} aria-hidden="true" /> Necessário</> : 'Não exigido pelo manifesto'}</dd></div><div className="portal-detail-wide"><dt>Arquivo</dt><dd>{tool.assetName}</dd></div><div className="portal-detail-wide"><dt>SHA-256 esperado</dt><dd><code>{tool.sha256}</code></dd></div></dl><p>Compare o hash do arquivo baixado. O portal não verifica nem executa o instalador no seu computador.</p></details>
    </article>;
}
