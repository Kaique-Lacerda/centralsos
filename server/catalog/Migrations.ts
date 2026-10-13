import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { CatalogError } from './Validation.js';
export async function migrateCatalog(pool: Pool, apply = false) {
    const sql = (await readFile(new URL('./migrations/001_catalog.sql', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
    return migrateCatalogSql(pool, sql, apply);
}
export async function migrateCatalogSql(pool: Pool, sql: string, apply = false) {
    const checksum = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex'), client = await pool.connect();
    try {
        await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(827351921)');
        const exists = (await client.query("SELECT to_regclass('catalog_schema_migrations') AS table_name")).rows[0].table_name;
        const rows = exists ? (await client.query('SELECT version,checksum FROM catalog_schema_migrations ORDER BY version')).rows : [];
        if (rows.length > 1 || (rows.length === 1 && (rows[0].version !== 1 || rows[0].checksum.trim() !== checksum))) throw new CatalogError('CATALOG_MIGRATION_DIVERGENT');
        if (!rows.length && (await client.query("SELECT to_regclass('catalog_credentials') AS table_name")).rows[0].table_name) throw new CatalogError('CATALOG_SCHEMA_UNTRACKED');
        if (apply && !rows.length) {
            await client.query(sql);
            await client.query('CREATE TABLE catalog_schema_migrations(version integer PRIMARY KEY,checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
            await client.query('INSERT INTO catalog_schema_migrations(version,checksum) VALUES(1,$1)', [checksum]);
        }
        await client.query(apply ? 'COMMIT' : 'ROLLBACK'); return { applied: apply || rows.length === 1, pending: !apply && rows.length === 0, dryRun: !apply, checksum };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
}
