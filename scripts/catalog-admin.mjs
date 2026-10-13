import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { load } from '../tests/control/load.mjs';

// Credentials are read from a protected local file, never command-line plaintext.
// This CLI is not an HTTP endpoint. Production administration requires a deliberate opt-in.
const [command, ...args] = process.argv.slice(2);
const option = name => args[args.indexOf(name) + 1];
let pool;
try {
    if (process.env.CATALOG_ADMIN_ENABLED !== '1') throw new Error('ADMINISTRATION_NOT_AUTHORIZED');
    const { catalogPool } = await load('server/catalog/Configuration.ts');
    pool = catalogPool(process.env);
    if (command === 'migrate' && (args.includes('--dry-run') !== args.includes('--apply'))) {
        const { migrateCatalogSql } = await load('server/catalog/Migrations.ts');
        const sql = await readFile(resolve('server/catalog/migrations/001_catalog.sql'), 'utf8');
        const result = await migrateCatalogSql(pool, sql, args.includes('--apply'));
        console.log(JSON.stringify({ event: 'catalog.migration', ...result }));
    } else if (command === 'import-legacy' && args.includes('--tag') && (args.includes('--dry-run') !== args.includes('--apply'))) {
        const { loadLegacyImport, importLegacyCatalog } = await load('server/catalog/LegacyCatalogImport.ts');
        const mapping = args.includes('--mapping-file') ? JSON.parse(await readFile(resolve(option('--mapping-file')),'utf8')) : {};
        const result = await importLegacyCatalog(pool,await loadLegacyImport(option('--tag'),mapping),args.includes('--apply'));
        console.log(JSON.stringify({event:'catalog.legacy_import',...result}));
    } else if (command === 'password' && ['technician','admin'].includes(option('--role')) && args.includes('--password-file')) {
        const { rotateCredential } = await load('server/catalog/Authentication.ts');
        const password = (await readFile(resolve(option('--password-file')), 'utf8')).replace(/\r?\n$/, '');
        const client = await pool.connect();
        try {
            await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(827351920)');
            await rotateCredential(client, option('--role'), password, { role: 'admin', tokenHash: createHash('sha256').update('local-administration').digest('hex') });
            await client.query('COMMIT'); console.log(JSON.stringify({ event: 'catalog.password_rotated', role: option('--role'), sessionsRevoked: true }));
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    } else if (command === 'revoke' && ['technician','admin'].includes(option('--role'))) {
        const { audit } = await load('server/catalog/Authentication.ts');
        const client = await pool.connect();
        try {
            await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(827351920)');
            await client.query('UPDATE catalog_credentials SET epoch=epoch+1,enabled=false WHERE role=$1', [option('--role')]);
            await client.query('DELETE FROM catalog_sessions WHERE role=$1', [option('--role')]);
            await audit(client, 'admin', createHash('sha256').update('local-administration').digest('hex'), 'credential.disable.' + option('--role'));
            await client.query('COMMIT'); console.log(JSON.stringify({ event: 'catalog.access_revoked', role: option('--role') }));
        } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    } else throw new Error('INVALID_ADMINISTRATIVE_COMMAND');
} catch (error) {
    const allowed = ['ADMINISTRATION_NOT_AUTHORIZED','INVALID_ADMINISTRATIVE_COMMAND','PASSWORD_POLICY','PASSWORDS_MUST_DIFFER','CATALOG_MIGRATION_DIVERGENT','CATALOG_SCHEMA_UNTRACKED','LEGACY_MAPPING_REQUIRED','LEGACY_MAPPING_TARGET_MISSING','LEGACY_VERSION_CONFLICT','LEGACY_SOURCE_DIVERGENT','LEGACY_HASH_OR_SIZE_MISMATCH','LEGACY_SOURCE_INVALID','LEGACY_MANIFEST_INVALID','LEGACY_ASSET_AMBIGUOUS_OR_INVALID','LEGACY_REDIRECT_REJECTED','LEGACY_RELEASE_UNAVAILABLE'];
    const raw = error?.code ?? error?.message;
    console.error(JSON.stringify({ event: 'catalog.administration_failed', code: allowed.includes(raw) ? raw : 'CATALOG_ADMINISTRATION_FAILED' })); process.exitCode = 1;
} finally { await pool?.end(); }
