import { Pool } from 'pg';
import { databaseConfiguration } from '../control/Configuration.js';
import { CatalogError } from './Validation.js';
export function catalogPool(env: NodeJS.ProcessEnv): Pool {
    // Marketplace Neon URLs include sslmode=require. pg would let this replace
    // our verified TLS options, so remove ONLY that known flag and keep verify-full.
    let connectionString = env.CATALOG_DATABASE_URL;
    if (connectionString) {
        let url: URL;
        try { url = new URL(connectionString); } catch { throw new CatalogError('CATALOG_NOT_CONFIGURED', 503); }
        const modes = url.searchParams.getAll('sslmode');
        if (modes.length === 1 && ['require', 'verify-full'].includes(modes[0])) {
            url.searchParams.delete('sslmode'); connectionString = url.toString();
        }
    }
    const pool = new Pool(databaseConfiguration({
        CONTROL_DATABASE_URL: connectionString,
        CONTROL_DATABASE_TLS: env.CATALOG_DATABASE_TLS,
        CONTROL_DATABASE_CA: env.CATALOG_DATABASE_CA
    }));
    pool.on('error', () => console.error(JSON.stringify({ event: 'catalog.database_error', code: 'DATABASE_UNAVAILABLE' })));
    return pool;
}
export function catalogConfiguration(env: NodeJS.ProcessEnv) {
    let origin: URL;
    try { origin = new URL(env.CATALOG_ORIGIN ?? ''); } catch { throw new CatalogError('CATALOG_NOT_CONFIGURED', 503); }
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || !env.CATALOG_RATE_SECRET || env.CATALOG_RATE_SECRET.length < 32) throw new CatalogError('CATALOG_NOT_CONFIGURED', 503);
    return { origin: origin.origin, rateSecret: env.CATALOG_RATE_SECRET };
}
