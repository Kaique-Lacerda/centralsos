import { useState, type FormEvent } from 'react';
import { LockKeyhole } from 'lucide-react';
import type { CatalogRole, CatalogSession } from '../../../../packages/contracts/catalog';
import { catalogRequest } from './CatalogApi';
export function CatalogLogin({ onLogin }: { onLogin: (session: CatalogSession) => void }) {
    const [role, setRole] = useState<CatalogRole>('technician'), [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false), [error, setError] = useState('');
    async function submit(event: FormEvent) {
        event.preventDefault(); setBusy(true); setError('');
        try { onLogin(await catalogRequest<CatalogSession>('login', null, 'POST', { role, password })); }
        catch (failure) { setError(failure instanceof Error ? failure.message : 'Não foi possível entrar.'); }
        finally { setPassword(''); setBusy(false); }
    }
    return <form className="catalog-login catalog-panel" onSubmit={submit}><LockKeyhole size={28} aria-hidden="true" />
        <h2>Acesso ao portal</h2><p>Entre para consultar ferramentas ou administrar o catálogo.</p>
        <fieldset disabled={busy}><legend>Nível de acesso</legend><div className="catalog-role-options">
            <label><input type="radio" name="role" checked={role === 'technician'} onChange={() => setRole('technician')} /> Técnico</label>
            <label><input type="radio" name="role" checked={role === 'admin'} onChange={() => setRole('admin')} /> Administrador</label>
        </div></fieldset>
        <label>Senha<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required maxLength={128} disabled={busy} /></label>
        {error && <p role="alert" className="catalog-error">{error}</p>}
        <button className="portal-tool-download" disabled={busy}>{busy ? 'Entrando…' : 'Entrar no catálogo'}</button>
    </form>;
}
