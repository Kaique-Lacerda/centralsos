import { useEffect, useMemo, useState } from 'react';
import { ControlPage } from '../../pages/control/ControlPage';
import { createSupportAuth, createSupportDesktopApi, isSupportDesktop } from '../../services/control/SupportDesktopBridge';
import type { SupportAuthView } from '../../../packages/contracts/control/SupportDesktop';

const auth = createSupportAuth();
const titles: Record<SupportAuthView['state'], string> = {
    unconfigured: 'Backend não configurado', signed_out: 'Entre no CENTRAL SOS Suporte', starting: 'Iniciando entrada',
    awaiting_browser: 'Autorize no navegador', awaiting_identity: 'Confirme sua identidade', authenticated: 'Autenticado',
    login_expired: 'Login expirado', session_expired: 'Sessão expirada', unavailable: 'Backend indisponível', unauthorized: 'Usuário sem autorização',
};
export function SupportAuthPanel({ view, busy, error, start, complete, logout }: {
    view: SupportAuthView; busy: boolean; error: string; start: () => void; complete: () => void; logout: () => void;
}) {
    return <section className="support-card" aria-live="polite"><h1>{titles[view.state]}</h1>
        {view.state === 'unconfigured' ? <p>Configure a origem HTTPS em backend.json no diretório de configuração do Suporte e reinicie o aplicativo. Nenhum servidor padrão está configurado.</p> : null}
        {view.operatorName ? <p>Operador: <strong>{view.operatorName}</strong></p> : null}
        {view.comparisonCode ? <p>Confira este código no navegador: <strong>{view.comparisonCode}</strong></p> : null}
        {view.expiresAt ? <p>Expira em {new Date(view.expiresAt).toLocaleString()}</p> : null}
        {view.state === 'awaiting_browser' ? <p>Entre e autorize no navegador padrão. A janela verificará a aprovação respeitando o intervalo do servidor.</p> : null}
        {view.state === 'awaiting_identity' ? <p>Confirme que o operador acima é você antes de concluir a entrada.</p> : null}
        {view.revocationPending ? <p role="alert" className="error">A credencial local foi apagada, mas a revogação remota falhou. A sessão remota poderá continuar válida até expiração.</p> : null}
        {error ? <p role="alert" className="error">{error}</p> : null}
        {view.message ? <p role="status">{view.message}</p> : null}
        <div className="support-actions">
            {['signed_out', 'login_expired', 'session_expired', 'unavailable', 'unauthorized'].includes(view.state) ? <button className="primary" disabled={busy} onClick={start}>Entrar</button> : null}
            {view.state === 'awaiting_identity' ? <button className="primary" disabled={busy} onClick={complete}>Confirmar identidade e entrar</button> : null}
            {['authenticated', 'starting', 'awaiting_browser', 'awaiting_identity'].includes(view.state) ? <button className="primary" onClick={logout}>{view.state === 'authenticated' ? 'Sair' : 'Cancelar entrada'}</button> : null}
        </div>
    </section>;
}
function NativeControl() {
    const [view, setView] = useState<SupportAuthView | null>(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const service = useMemo(() => view?.backendOrigin ? createSupportDesktopApi(view.backendOrigin) : null, [view?.backendOrigin]);
    useEffect(() => { let live = true; const refresh = () => auth.status().then(v => { if (live) setView(v); }).catch(() => { if (live) setError('Host nativo indisponível.'); });
        void refresh(); const timer = setInterval(refresh, 1000); return () => { live = false; clearInterval(timer); }; }, []);
    useEffect(() => {
        if (view?.state !== 'awaiting_browser') return;
        let live = true; const timer = setInterval(() => { void auth.poll().then(v => { if (live) { setView(v); setError(''); } }).catch(e => { if (live) setError(e.message); }); }, view.intervalSeconds * 1000);
        return () => { live = false; clearInterval(timer); };
    }, [view?.state, view?.intervalSeconds]);
    useEffect(() => { if (view?.state !== 'authenticated') return; let live = true;
        const timer = setInterval(() => { void auth.session().then(v => { if (live) { setView(v); setError(''); } }).catch(e => { if (live) setError(e.message); }); }, 60000);
        return () => { live = false; clearInterval(timer); }; }, [view?.state]);
    const action = async (fn: () => Promise<SupportAuthView>, leaving = false) => {
        setBusy(true); setError('');
        // Unmount Control immediately. Rust also clears the token before revocation HTTP.
        if (leaving) setView(v => v ? { ...v, state: 'signed_out', operatorName: null, comparisonCode: null, expiresAt: null } : v);
        try { setView(await fn()); } catch (e) { setError(e instanceof Error ? e.message : 'Operação nativa recusada.'); }
        finally { setBusy(false); }
    };
    if (!view) return <p role="status">{error || 'Carregando sessão nativa…'}</p>;
    return <><SupportAuthPanel view={view} busy={busy} error={error} start={() => void action(auth.start)} complete={() => void action(auth.complete)} logout={() => void action(auth.logout, true)} />
        {view.state === 'authenticated' && service ? <ControlPage service={service} native /> : null}</>;
}
export function SupportControlPage() { return isSupportDesktop() ? <NativeControl /> : <ControlPage />; }
