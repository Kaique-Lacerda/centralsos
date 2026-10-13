import { Check, Download, Package } from 'lucide-react';
import { useState } from 'react';
import type { CatalogSession, CatalogTool } from '../../../../packages/contracts/catalog';
import { catalogRequest } from './CatalogApi';
import { VersionUpload } from './VersionUpload';
export function ManagedToolCard({ tool, session, busy, onAction, onRefresh, onEdit }: {
    tool: CatalogTool; session: CatalogSession; busy: boolean;
    onAction: (work: () => Promise<unknown>) => Promise<void>; onRefresh: () => Promise<void>; onEdit: () => void;
}) {
    const [confirmation,setConfirmation] = useState<{kind:'publish';versionId:string;version:string} | {kind:'remove'} | null>(null);
    const latest = tool.versions.find(version => version.published);
    const download = (id: string) => void onAction(async () => {
        const result = await catalogRequest<{ url: string }>(`versions/${id}/download`, session, 'POST'); window.location.assign(result.url);
    });
    return <article className="portal-tool-card managed-tool-card" aria-labelledby={`managed-tool-${tool.id}`}>
        <div className="portal-tool-main"><div className="portal-tool-icon"><Package size={26} aria-hidden="true" /></div><div className="portal-tool-copy"><h3 id={`managed-tool-${tool.id}`}>{tool.name}</h3><p className="portal-tool-classification">{tool.categoryName} · {tool.type}</p><p className="portal-tool-description">{tool.description}</p></div></div>
        <div className="portal-tool-actions"><span className={`portal-badge ${latest ? 'available' : 'unavailable'}`}>{latest && <Check size={12} aria-hidden="true" />}{latest ? 'Disponível' : 'Indisponível'}</span>
            {latest ? <button className="portal-tool-download" disabled={busy} onClick={() => download(latest.id)} aria-label={`Baixar ${tool.name}`}><Download size={16} aria-hidden="true" />Baixar</button> : <button className="portal-tool-download" disabled>Indisponível</button>}
        </div>
        <details className="portal-tool-details"><summary>Detalhes e versões</summary><p>{tool.compatibility}{tool.requiresAdmin ? ' · Instalação exige administrador' : ''}</p>
            {!tool.versions.length && <p>Nenhum arquivo enviado. Ferramenta indisponível.</p>}
            {tool.versions.map(version => <div className="catalog-version" key={version.id}><div><strong>Versão {version.version}</strong><small>{version.fileName} · {version.size.toLocaleString('pt-BR')} bytes</small><span className={`portal-badge ${version.published ? 'available' : 'unavailable'}`}>{version.published ? 'Aprovada e publicada' : version.verified ? 'Verificada · aguardando publicação' : 'Envio pendente de verificação'}</span></div>
                {version.source?.kind === 'github-release' && <p className="catalog-source-note">Origem: GitHub Release {version.source.tag}. Arquivo público no GitHub; o login do portal não o torna privado.</p>}
                <div className="catalog-actions">{version.published && <button className="portal-text-button" disabled={busy} onClick={() => download(version.id)}>Baixar versão {version.version}</button>}
                    {session.role === 'admin' && <>{!version.verified && <button className="portal-refresh" disabled={busy} onClick={() => void onAction(() => catalogRequest(`versions/${version.id}/finalize`,session,'POST'))}>Verificar envio</button>}
                        {version.verified && <button className="portal-refresh" disabled={busy} onClick={() => {
                            if (version.published) void onAction(() => catalogRequest(`versions/${version.id}/unpublish`,session,'POST'));
                            else setConfirmation({kind:'publish',versionId:version.id,version:version.version});
                        }}>{version.published ? 'Despublicar' : 'Aprovar e publicar'}</button>}</>}
                </div>{version.sha256 && <details className="catalog-hash"><summary>SHA-256 do arquivo</summary><code>{version.sha256}</code></details>}
            </div>)}
        </details>
        {session.role === 'admin' && <div className="catalog-card-admin"><button className="portal-text-button" onClick={onEdit} disabled={busy}>Editar ferramenta</button><VersionUpload toolId={tool.id} session={session} onDone={onRefresh} /><button className="portal-text-button" disabled={busy} onClick={() => {
            setConfirmation({kind:'remove'});
        }}>Remover do catálogo</button></div>}
        {session.role === 'admin' && confirmation && <div className="catalog-confirm" role="group" aria-label={confirmation.kind==='publish' ? 'Confirmar publicação' : 'Confirmar remoção'}>
            <p>{confirmation.kind==='publish' ? `Aprovar e publicar ${tool.name}, versão ${confirmation.version}, para os acessos autorizados?` : `Remover ${tool.name} do catálogo? O histórico e os arquivos serão preservados.`}</p>
            <div className="catalog-actions"><button className="portal-tool-download" disabled={busy} onClick={() => {
                const selected=confirmation; setConfirmation(null);
                void onAction(() => selected.kind==='publish' ? catalogRequest(`versions/${selected.versionId}/publish`,session,'POST') : catalogRequest(`tools/${tool.id}`,session,'DELETE'));
            }}>{confirmation.kind==='publish' ? 'Confirmar publicação' : 'Confirmar remoção'}</button><button className="portal-refresh" disabled={busy} onClick={() => setConfirmation(null)}>Cancelar</button></div>
        </div>}
    </article>;
}
