import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { CatalogSession } from '../../../../packages/contracts/catalog';
import { CatalogApiError, catalogRequest } from './CatalogApi';
import { CatalogLogin } from './CatalogLogin';
import emblem from '../assets/emblem-brand.webp';
import './catalog.css';

const Access = createContext<{ session: CatalogSession; endSession: () => void; logout: () => Promise<void> } | null>(null);
export function useCatalogAccess() {
    const access = useContext(Access);
    if (!access) throw new Error('Catalog access must be authenticated.');
    return access;
}
// Children are mounted only after the server has confirmed a valid catalog session.
export function CatalogAccess({ children }: { children: ReactNode }) {
    const [session, setSession] = useState<CatalogSession | null>(null);
    const [ready, setReady] = useState(false), [error, setError] = useState('');
    const endSession = useCallback(() => setSession(null), []);
    const checkSession = useCallback(async () => {
        setReady(false); setError('');
        try { setSession(await catalogRequest<CatalogSession>('session', null)); }
        catch (failure) {
            setSession(null);
            if (!(failure instanceof CatalogApiError) || failure.status !== 401) setError(failure instanceof Error ? failure.message : 'Não foi possível verificar seu acesso.');
        } finally { setReady(true); }
    }, []);
    useEffect(() => { void checkSession(); }, [checkSession]);
    useEffect(() => {
        if (!session) return;
        const timer = window.setTimeout(endSession, Math.max(0, Date.parse(session.expiresAt) - Date.now()));
        const onUnauthorized = () => endSession();
        window.addEventListener('catalog-session-expired', onUnauthorized);
        return () => { window.clearTimeout(timer); window.removeEventListener('catalog-session-expired', onUnauthorized); };
    }, [session, endSession]);
    async function logout() { await catalogRequest('logout', session, 'POST'); endSession(); }
    if (!ready || !session) return <div className="public-portal catalog-access"><main className="portal-container managed-catalog">
        <div className="catalog-access-brand"><img src={emblem} alt="Logo CENTRAL SOS" width="88" height="88" /><h1>CENTRAL <span>SOS</span></h1><p>Portal de aplicativos e ferramentas homologadas.</p></div>
        {!ready ? <p role="status">Verificando acesso…</p> : <CatalogLogin onLogin={value => { setSession(value); setError(''); }} />}
        {error && <div role="alert" className="catalog-error catalog-panel">{error}<button className="portal-refresh" onClick={() => void checkSession()}>Tentar novamente</button></div>}
    </main></div>;
    return <Access.Provider value={{ session, endSession, logout }}>{children}</Access.Provider>;
}
