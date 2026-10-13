import { useState, type FormEvent } from 'react';
import type { CatalogRole, CatalogSession } from '../../../../packages/contracts/catalog';
import { catalogRequest } from './CatalogApi';
export function CatalogSecurity({ session, onRevoked, onError }: { session: CatalogSession; onRevoked: () => void; onError: (message: string) => void }) {
    const [role, setRole] = useState<CatalogRole>('technician'), [password, setPassword] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
    async function rotate(event: FormEvent) {
        event.preventDefault(); setBusy(true); setMessage('');
        try {
            await catalogRequest('credentials', session, 'POST', { role, password }); setMessage('Senha alterada. As sessões desse nível foram encerradas.');
            if (role === 'admin') onRevoked();
        } catch (error) { onError(error instanceof Error ? error.message : 'Não foi possível alterar a senha.'); }
        finally { setPassword(''); setBusy(false); }
    }
    async function revoke() {
        if (!window.confirm('Encerrar todas as sessões desse nível de acesso?')) return;
        setBusy(true);
        try { await catalogRequest('sessions/revoke', session, 'POST', { role }); setMessage('Sessões encerradas.'); if (role === 'admin') onRevoked(); }
        catch (error) { onError(error instanceof Error ? error.message : 'Não foi possível encerrar as sessões.'); }
        finally { setBusy(false); }
    }
    return <details className="catalog-panel catalog-security"><summary>Senhas e sessões do catálogo</summary><form onSubmit={rotate}>
        <p>A troca de senha encerra todas as sessões do nível escolhido.</p><label>Acesso<select value={role} onChange={e => setRole(e.target.value as CatalogRole)}><option value="technician">Técnicos</option><option value="admin">Administrador</option></select></label>
        <label>Nova senha<input type="password" autoComplete="new-password" minLength={14} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} required disabled={busy} /></label>
        <small>14 a 128 caracteres. Use senhas diferentes para cada nível.</small><div className="catalog-actions"><button className="portal-tool-download" disabled={busy}>Trocar senha</button><button className="portal-refresh" type="button" disabled={busy} onClick={() => void revoke()}>Encerrar sessões</button></div>
        {message && <p role="status">{message}</p>}
    </form></details>;
}
