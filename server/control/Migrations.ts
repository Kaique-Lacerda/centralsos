import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { AdministrativeError } from './Configuration.js';

export const migrationNames = ['001_control.sql', '002_support_native_auth.sql', '003_control_administration.sql', '004_enrollment_window_start.sql'] as const;
// Exact, reviewed predecessor of 001 only. Keep its ledger checksum untouched;
// 004 performs the data-preserving rename. No general checksum bypass is allowed.
const original001Checksum = '7ee5b61d78dd7865d7d1874aa226fae056559b25d65093f835409290f936e255';
const corrected001Checksum = 'ef18cc36bc427b2556889440244642d052b2ebbe348164fd1e6bf47101358168';
const tables = [
    ['central_sos_control_state', 'control_users', 'control_memberships', 'control_sessions', 'control_enrollment_limits'],
    ['control_native_auth_state'],
    ['control_companies', 'control_administrative_audit']
];
export interface Migration { version: number; name: string; checksum: string; sql: string }
export async function readMigrations(directory: string): Promise<Migration[]> {
    return Promise.all(migrationNames.map(async (name, index) => {
        const source = (await readFile(resolve(directory, name), 'utf8')).replace(/\r\n/g, '\n');
        const sql = source.replace(/^\s*BEGIN;\s*/i, '').replace(/\s*COMMIT;\s*$/i, '');
        if (/\b(BEGIN|COMMIT|ROLLBACK)\s*;/i.test(sql)) throw new AdministrativeError('MIGRATION_TRANSACTION_INVALID');
        return { version: index + 1, name, checksum: createHash('sha256').update(source).digest('hex'), sql };
    }));
}
export async function migrationStatus(client: Pick<PoolClient, 'query'>, migrations: Migration[]) {
    const exists = (await client.query("SELECT to_regclass('control_schema_migrations') AS table_name")).rows[0]?.table_name;
    const applied: { version: number; name: string; checksum: string }[] = exists ? (await client.query('SELECT version, name, checksum FROM control_schema_migrations ORDER BY version')).rows : [];
    for (let i = 0; i < applied.length; i++) {
        const expected = migrations[i], actual = applied[i];
        const compatible001 = expected?.version === 1 && expected.name === '001_control.sql'
            && expected.checksum === corrected001Checksum && actual.checksum === original001Checksum;
        if (!expected || actual.version !== expected.version || actual.name !== expected.name || (actual.checksum !== expected.checksum && !compatible001)) throw new AdministrativeError('MIGRATION_DIVERGENT');
    }
    for (let i = 0; i < migrations.length; i++) {
        for (const table of tables[i] ?? []) {
            const exists = (await client.query('SELECT to_regclass($1) AS table_name', [table])).rows[0]?.table_name;
            if (i < applied.length && !exists) throw new AdministrativeError('MIGRATION_SCHEMA_MISSING');
            if (i >= applied.length && exists) throw new AdministrativeError('MIGRATION_LEGACY_SCHEMA_UNTRACKED');
        }
    }
    return { applied: applied.map(row => row.name), pending: migrations.slice(applied.length).map(row => row.name) };
}
/** All DDL and ledger inserts share one transaction; applied ledger rows are immutable.
 * Dry-run validates history/schema only; it does not parse or execute pending SQL. */
export async function applyMigrations(pool: Pool, migrations: Migration[], dryRun = true) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(827351901)');
        const status = await migrationStatus(client, migrations);
        if (!dryRun) {
            await client.query('CREATE TABLE IF NOT EXISTS control_schema_migrations (version integer PRIMARY KEY, name text UNIQUE NOT NULL, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
            for (const migration of migrations.slice(status.applied.length)) {
                await client.query(migration.sql);
                await client.query('INSERT INTO control_schema_migrations(version,name,checksum) VALUES($1,$2,$3)', [migration.version, migration.name, migration.checksum]);
            }
        }
        await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
        return { ...status, dryRun };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
}
