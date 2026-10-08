import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Pool } from 'pg';
import type { Actor } from './Repository.js';
import { ApiError, digest } from './ControlBackend.js';
export interface AuthConfig {
    issuer: string;
    clientId: string;
    clientSecret: string;
    origin: string;
    sessionSecret: string;
}
const token = () => randomBytes(32).toString('base64url');
export function cookieValue(cookie: string | undefined, name: string): string | undefined { return cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))?.slice(name.length + 1); }
export class ControlAuthentication {
    constructor(private pool: Pool, private config: AuthConfig, private dependencies: { fetcher?: typeof fetch; keyResolver?: JWTVerifyGetKey } = {}) {
        for (const u of [config.issuer, config.origin])
            if (new URL(u).protocol !== 'https:')
                throw new Error('OIDC e Control exigem HTTPS.');
        if (config.sessionSecret.length < 32)
            throw new Error('CONTROL_SESSION_SECRET precisa de pelo menos 32 caracteres aleatórios.');
    }
    private async discovery() {
        const r = await (this.dependencies.fetcher ?? fetch)(`${this.config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(8000), redirect: 'error' });
        if (!r.ok)
            throw new ApiError(503, 'Provedor de autenticação indisponível.');
        const d = await r.json() as {
            issuer: string;
            authorization_endpoint: string;
            token_endpoint: string;
            jwks_uri: string;
        };
        if (d.issuer !== this.config.issuer || [d.authorization_endpoint, d.token_endpoint, d.jwks_uri].some(u => new URL(u).protocol !== 'https:'))
            throw new Error('Discovery OIDC inválido.');
        return d;
    }
    private sign(value: string) { return createHmac('sha256', this.config.sessionSecret).update(value).digest('base64url'); }
    private redirectUri(path: string) {
        if (!['/api/control/auth/callback', '/api/control/auth/native/callback'].includes(path)) throw new ApiError(400,'Callback inválido.');
        return this.config.origin + path;
    }
    async authorizationUrl(state: string, verifier: string, nonce: string, callbackPath: string) {
        const d = await this.discovery(), url = new URL(d.authorization_endpoint);
        url.search = new URLSearchParams({ response_type:'code',client_id:this.config.clientId,redirect_uri:this.redirectUri(callbackPath),scope:'openid profile',state,nonce,code_challenge:Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))).toString('base64url'),code_challenge_method:'S256' }).toString();
        return url.toString();
    }
    async exchangeSubject(code: string, verifier: string, nonceHash: string, callbackPath: string) {
        const d = await this.discovery();
        const r = await (this.dependencies.fetcher ?? fetch)(d.token_endpoint, { method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:this.redirectUri(callbackPath),client_id:this.config.clientId,client_secret:this.config.clientSecret,code_verifier:verifier}) });
        if (!r.ok) throw new ApiError(401,'Provedor não autorizou o login.');
        const response = await r.json() as { id_token?: string };
        if (!response.id_token) throw new ApiError(401,'ID token ausente.');
        const { payload } = await jwtVerify(response.id_token,this.dependencies.keyResolver ?? createRemoteJWKSet(new URL(d.jwks_uri)),{issuer:this.config.issuer,audience:this.config.clientId,algorithms:['RS256','ES256'],requiredClaims:['exp','iat','sub','nonce']});
        if (!payload.sub || payload.sub.length > 256 || typeof payload.nonce !== 'string' || digest(payload.nonce) !== nonceHash) throw new ApiError(401,'Identidade/nonce inválidos.');
        if (!(await this.pool.query('SELECT subject FROM control_users WHERE subject = $1 AND enabled = true',[payload.sub])).rowCount) throw new ApiError(403,'Usuário não habilitado pelo administrador do Control.');
        return payload.sub;
    }
    async login() {
        const state = token();
        const verifier = token();
        const nonce = token();
        const raw = Buffer.from(JSON.stringify({ state, verifier, nonce, expires: Date.now() + 300000 })).toString('base64url');
        return { url: await this.authorizationUrl(state,verifier,nonce,'/api/control/auth/callback'), cookie: `sos_oidc=${raw}.${this.sign(raw)}; HttpOnly; Secure; SameSite=Lax; Path=/api/control/auth; Max-Age=300` };
    }
    async callback(url: URL, cookies: string | undefined) {
        const packed = cookieValue(cookies, 'sos_oidc');
        const [raw, signature] = packed?.split('.') ?? [];
        const expected = raw ? this.sign(raw) : '';
        if (!signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))
            throw new ApiError(401, 'Estado de login inválido.');
        const saved = JSON.parse(Buffer.from(raw, 'base64url').toString()) as {
            state: string;
            verifier: string;
            nonce: string;
            expires: number;
        };
        if (saved.expires <= Date.now() || url.searchParams.get('state') !== saved.state || !url.searchParams.get('code'))
            throw new ApiError(401, 'Login expirado ou inválido.');
        const subject = await this.exchangeSubject(url.searchParams.get('code')!,saved.verifier,digest(saved.nonce),'/api/control/auth/callback');
        const session = token();
        await this.pool.query('INSERT INTO control_sessions(token_hash,subject,expires_at) VALUES($1,$2,now()+interval \'8 hours\')', [digest(session), subject]);
        return `sos_session=${session}; HttpOnly; Secure; SameSite=Strict; Path=/api/control; Max-Age=28800`;
    }
    async authenticate(cookies: string | undefined): Promise<Actor> {
        const session = cookieValue(cookies, 'sos_session');
        if (!session)
            throw new ApiError(401, 'Entre no CENTRAL SOS Control.');
        const r = await this.pool.query('SELECT u.subject, u.display_name FROM control_sessions s JOIN control_users u ON u.subject=s.subject WHERE s.token_hash=$1 AND s.expires_at>now() AND u.enabled=true', [digest(session)]);
        const row = r.rows[0];
        if (!row)
            throw new ApiError(401, 'Sessão inválida ou expirada.');
        const memberships = await this.pool.query('SELECT company_id AS "companyId", role FROM control_memberships WHERE subject=$1', [row.subject]);
        return { id: row.subject, name: row.display_name, memberships: memberships.rows };
    }
}
