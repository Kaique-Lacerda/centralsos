import { Pool, type PoolConfig } from 'pg';
import { validateControlOrigin } from '../../packages/contracts/control/NativeAuthentication.js';

export class AdministrativeError extends Error {
    constructor(public readonly code: string) { super(code); }
}
export type Settings = Record<string, string | undefined>;
export function databaseConfiguration(env: Settings, administrative = false): PoolConfig {
    const raw = env[administrative ? 'CONTROL_ADMIN_DATABASE_URL' : 'CONTROL_DATABASE_URL'];
    if (!raw) throw new AdministrativeError('DATABASE_NOT_CONFIGURED');
    let url: URL;
    try { url = new URL(raw); } catch { throw new AdministrativeError('DATABASE_CONFIGURATION_INVALID'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) throw new AdministrativeError('DATABASE_CONFIGURATION_INVALID');
    // pg connection-string SSL options replace the ssl object. Never allow a URL to
    // silently disable certificate verification or override the configured CA.
    if ([...url.searchParams.keys()].some(key => /^ssl/i.test(key))) throw new AdministrativeError('DATABASE_TLS_URL_OPTIONS_FORBIDDEN');
    const mode = env.CONTROL_DATABASE_TLS || 'verify-full';
    if (!['verify-full', 'disable'].includes(mode)) throw new AdministrativeError('DATABASE_TLS_CONFIGURATION_INVALID');
    if (mode === 'disable' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new AdministrativeError('DATABASE_TLS_REQUIRED');
    return { connectionString: raw, ssl: mode === 'disable' ? false : { rejectUnauthorized: true, ...(env.CONTROL_DATABASE_CA ? { ca: env.CONTROL_DATABASE_CA } : {}) }, max: administrative ? 2 : 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 10000, lock_timeout: 5000 };
}
export function createControlPool(env: Settings, administrative = false): Pool {
    const pool = new Pool(databaseConfiguration(env, administrative));
    pool.on('error', () => console.error(JSON.stringify({ event: 'control.database_idle_error', code: 'DATABASE_UNAVAILABLE' })));
    return pool;
}
export function requireAdministration(env: Settings) {
    if (env.CONTROL_ADMIN_ENABLED !== '1' || !env.CONTROL_ADMIN_ACTOR || !/^[^\x00-\x1f\x7f]{1,256}$/.test(env.CONTROL_ADMIN_ACTOR)) throw new AdministrativeError('ADMINISTRATION_NOT_AUTHORIZED');
    return env.CONTROL_ADMIN_ACTOR;
}
export function controlConfiguration(env: Settings) {
    if (['CONTROL_ORIGIN', 'CONTROL_OIDC_ISSUER', 'CONTROL_OIDC_CLIENT_ID', 'CONTROL_OIDC_CLIENT_SECRET', 'CONTROL_SESSION_SECRET'].some(key => !env[key])) throw new AdministrativeError('CONTROL_NOT_CONFIGURED');
    let origin: string, issuer: URL;
    try {
        origin = validateControlOrigin(env.CONTROL_ORIGIN!);
        issuer = new URL(env.CONTROL_OIDC_ISSUER!);
        if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash) throw new Error();
    } catch { throw new AdministrativeError('HTTPS_CONFIGURATION_INVALID'); }
    if (env.CONTROL_SESSION_SECRET!.length < 32) throw new AdministrativeError('SESSION_CONFIGURATION_INVALID');
    const offlineSeconds = Number(env.CONTROL_OFFLINE_SECONDS ?? 90);
    if (!Number.isInteger(offlineSeconds) || offlineSeconds < 30 || offlineSeconds > 3600) throw new AdministrativeError('OFFLINE_CONFIGURATION_INVALID');
    return { origin, offlineSeconds, auth: { origin, issuer: env.CONTROL_OIDC_ISSUER!, clientId: env.CONTROL_OIDC_CLIENT_ID!, clientSecret: env.CONTROL_OIDC_CLIENT_SECRET!, sessionSecret: env.CONTROL_SESSION_SECRET! } };
}
