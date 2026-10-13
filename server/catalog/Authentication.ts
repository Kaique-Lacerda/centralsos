import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { hash, verify, argon2id } from 'argon2';
import type { Pool, PoolClient } from 'pg';
import type { CatalogRole, CatalogSession } from '../../packages/contracts/catalog/index.js';
import { CatalogError, validatePassword } from './Validation.js';
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const cookieName = '__Secure-central_sos_catalog';
export const clearCookie = `${cookieName}=; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
export const clearLegacyCookie = `${cookieName}=; Path=/api/catalog; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
export interface CatalogActor { role: CatalogRole; tokenHash: string; csrfHash: string; expiresAt: string }
export function equalHash(left: string, right: string) {
    return /^[a-f0-9]{64}$/.test(left) && /^[a-f0-9]{64}$/.test(right) && timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}
export async function audit(db: Pick<PoolClient, 'query'>, role: CatalogRole, sessionRef: string, action: string, resourceId: string | null = null) {
    await db.query('INSERT INTO catalog_audit(id,role,session_ref,action,resource_id) VALUES($1,$2,$3,$4,$5)', [randomUUID(), role, sessionRef, action, resourceId]);
}
export class CatalogAuthentication {
    constructor(private readonly pool: Pool, private readonly rateSecret: string) {}
    async login(role: CatalogRole, password: string, source: string) {
        // Atomic persisted limits work across Function instances. No raw IP is stored.
        const keys = [createHmac('sha256', this.rateSecret).update('source:' + source).digest('hex'), digest('catalog:login:' + role)];
        for (let i = 0; i < keys.length; i++) {
            const r = await this.pool.query(`INSERT INTO catalog_login_limits(key_hash,window_start,attempts) VALUES($1,now(),1)
                ON CONFLICT(key_hash) DO UPDATE SET attempts=CASE WHEN catalog_login_limits.window_start < now()-interval '5 minutes' THEN 1 ELSE catalog_login_limits.attempts+1 END,
                window_start=CASE WHEN catalog_login_limits.window_start < now()-interval '5 minutes' THEN now() ELSE catalog_login_limits.window_start END RETURNING attempts`, [keys[i]]);
            if (r.rows[0].attempts > (i === 0 ? 5 : 100)) throw new CatalogError('LOGIN_RATE_LIMITED', 429);
        }
        const credential = (await this.pool.query('SELECT password_hash,epoch,enabled FROM catalog_credentials WHERE role=$1', [role])).rows[0];
        if (!credential?.enabled || !await verify(credential.password_hash, password).catch(() => false)) throw new CatalogError('INVALID_CREDENTIAL', 401);
        const token = randomBytes(32).toString('base64url'), csrfToken = this.csrf(digest(token));
        const seconds = role === 'admin' ? 3600 : 14400;
        const expiresAt = new Date(Date.now() + seconds * 1000).toISOString();
        // Recheck epoch atomically: rotating a password during Argon2 verification cannot create a valid old session.
        const r = await this.pool.query(`INSERT INTO catalog_sessions(token_hash,role,epoch,csrf_hash,expires_at)
            SELECT $1,role,epoch,$2,$3 FROM catalog_credentials WHERE role=$4 AND epoch=$5 AND enabled RETURNING role`, [digest(token), digest(csrfToken), expiresAt, role, credential.epoch]);
        if (!r.rowCount) throw new CatalogError('INVALID_CREDENTIAL', 401);
        return { session: { role, csrfToken, expiresAt } satisfies CatalogSession,
            cookie: `${cookieName}=${token}; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=${seconds}` };
    }
    async authenticate(cookie = ''): Promise<CatalogActor | null> {
        const values = cookie.split(';').map(value => value.trim()).filter(value => value.startsWith(cookieName + '='));
        if (!values.length) return null;
        if (values.length !== 1) throw new CatalogError('SESSION_INVALID', 401);
        const token = values[0].slice(cookieName.length + 1);
        if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new CatalogError('SESSION_INVALID', 401);
        const tokenHash = digest(token);
        const row = (await this.pool.query(`SELECT s.role,s.csrf_hash,s.expires_at FROM catalog_sessions s
            JOIN catalog_credentials c ON c.role=s.role AND c.epoch=s.epoch AND c.enabled
            WHERE s.token_hash=$1 AND s.expires_at>now()`, [tokenHash])).rows[0];
        if (!row) throw new CatalogError('SESSION_EXPIRED', 401);
        return { role: row.role, tokenHash, csrfHash: row.csrf_hash, expiresAt: row.expires_at.toISOString() };
    }
    private csrf(tokenHash: string) { return createHmac('sha256', this.rateSecret).update('csrf:' + tokenHash).digest('base64url'); }
    async refreshCsrf(actor: CatalogActor): Promise<CatalogSession> { return { role: actor.role, csrfToken: this.csrf(actor.tokenHash), expiresAt: actor.expiresAt }; }
    async logout(actor: CatalogActor) { await this.pool.query('DELETE FROM catalog_sessions WHERE token_hash=$1', [actor.tokenHash]); }
}
export async function rotateCredential(db: PoolClient, role: CatalogRole, password: string, actor: { role: CatalogRole; tokenHash: string }) {
    validatePassword(password);
    const other = (await db.query('SELECT password_hash FROM catalog_credentials WHERE role<>$1', [role])).rows[0];
    if (other && await verify(other.password_hash, password)) throw new CatalogError('PASSWORDS_MUST_DIFFER');
    const passwordHash = await hash(password, { type: argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
    await db.query(`INSERT INTO catalog_credentials(role,password_hash) VALUES($1,$2)
        ON CONFLICT(role) DO UPDATE SET password_hash=$2,epoch=catalog_credentials.epoch+1,enabled=true,updated_at=now()`, [role, passwordHash]);
    await db.query('DELETE FROM catalog_sessions WHERE role=$1', [role]);
    await audit(db, actor.role, actor.tokenHash, 'credential.rotate.' + role);
}
