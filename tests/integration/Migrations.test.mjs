import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { load } from '../control/load.mjs';
import { postgresFixture } from './postgres-fixture.mjs';

const { readMigrations, applyMigrations, diagnosticCode } = await load('tests/control/administration-entry.ts');
const { limitEnrollment } = await load('server/control/EnrollmentRateLimit.ts');
const migrations = await readMigrations(resolve('server/control/migrations'));
const originalSource = (await readFile('server/control/migrations/001_control.sql', 'utf8')).replace(/\r\n/g, '\n').replace('window_start bigint', 'window bigint');
const originalChecksum = createHash('sha256').update(originalSource).digest('hex');
const legacy = migrations.slice(0, 3).map((m, i) => i === 0 ? { ...m, checksum: originalChecksum, sql: m.sql.replace('window_start bigint', '"window" bigint') } : m);

test('PostgreSQL real descartável: migrações e enrollment (nunca usa URL de banco existente)', {
    skip: !process.env.CONTROL_TEST_POSTGRES_BIN ? 'Defina CONTROL_TEST_POSTGRES_BIN para binários locais; o teste cria seu próprio cluster loopback.' : false
}, async t => {
    const fixture = await postgresFixture(process.env.CONTROL_TEST_POSTGRES_BIN);
    t.diagnostic('PostgreSQL ' + fixture.version + '; cluster novo exclusivamente local.');
    const pool = fixture.createPool();
    // Each subtest gets an isolated schema, in the disposable cluster only.
    async function isolated(run) {
        const client = await pool.connect(), schema = 'migration_' + randomUUID().replaceAll('-', '');
        try {
            await client.query(`CREATE SCHEMA ${schema}`);
            await client.query(`SET search_path TO ${schema}`);
            const db = { connect: async () => ({ query: client.query.bind(client), release() {} }) };
            await run(db, client);
        } finally { await client.query('RESET search_path'); client.release(); }
    }
    try {
        await t.test('SQL original falha com 42601; dry-run não detecta sintaxe e não persiste DDL', () => isolated(async (db, client) => {
            assert.equal(originalChecksum, '7ee5b61d78dd7865d7d1874aa226fae056559b25d65093f835409290f936e255');
            const broken = [{ ...migrations[0], checksum: originalChecksum, sql: migrations[0].sql.replace('window_start bigint', 'window bigint') }];
            assert.equal((await applyMigrations(db, broken, true)).pending.length, 1);
            await assert.rejects(applyMigrations(db, broken, false), e => e.code === '42601' && diagnosticCode(e) === 'DATABASE_SQL_SYNTAX_ERROR');
            assert.equal((await client.query("SELECT to_regclass('control_schema_migrations') AS ledger, to_regclass('central_sos_control_state') AS state")).rows[0].ledger, null);
            assert.equal((await client.query("SELECT to_regclass('central_sos_control_state') AS state")).rows[0].state, null);
            await applyMigrations(db, migrations, false); // safe retry after rollback
        }));
        await t.test('instalação nova aplica 001–004 e reaplicação é idempotente', () => isolated(async (db, client) => {
            await applyMigrations(db, migrations, false);
            const before = (await client.query('SELECT version,name,checksum,applied_at FROM control_schema_migrations ORDER BY version')).rows;
            assert.deepEqual(before.map(({ checksum }) => checksum), migrations.map(m => m.checksum));
            assert.deepEqual((await applyMigrations(db, migrations, false)).pending, []);
            assert.deepEqual((await client.query('SELECT version,name,checksum,applied_at FROM control_schema_migrations ORDER BY version')).rows, before);
            assert.ok((await client.query("SELECT attname FROM pg_attribute WHERE attrelid='control_enrollment_limits'::regclass AND attname='window_start'")).rowCount);
        }));
        await t.test('dois administradores concorrentes aplicam cada migração uma única vez', () => isolated(async (db, client) => {
            const schema = (await client.query('SELECT current_schema() AS schema')).rows[0].schema;
            const other = await fixture.createPool().connect();
            try {
                await other.query(`SET search_path TO ${schema}`);
                const replica = { connect: async () => ({ query: other.query.bind(other), release() {} }) };
                const results = await Promise.all([applyMigrations(db, migrations, false), applyMigrations(replica, migrations, false)]);
                assert.equal(results.reduce((sum, result) => sum + result.pending.length, 0), migrations.length);
                assert.equal((await client.query('SELECT count(*)::int AS count FROM control_schema_migrations')).rows[0].count, migrations.length);
            } finally { other.release(); }
        }));
        await t.test('legado rastreado mantém checksum, timestamps e contadores ao renomear coluna', () => isolated(async (db, client) => {
            await applyMigrations(db, legacy, false);
            const before = (await client.query('SELECT * FROM control_schema_migrations ORDER BY version')).rows;
            await client.query('INSERT INTO control_enrollment_limits(source_hash,"window",attempts) VALUES($1,123,7)', ['a'.repeat(64)]);
            assert.deepEqual((await applyMigrations(db, migrations, true)).pending, ['004_enrollment_window_start.sql']);
            await applyMigrations(db, migrations, false);
            assert.deepEqual((await client.query('SELECT * FROM control_schema_migrations WHERE version <= 3 ORDER BY version')).rows, before);
            assert.deepEqual((await client.query('SELECT window_start,attempts FROM control_enrollment_limits')).rows, [{ window_start: '123', attempts: 7 }]);
            assert.deepEqual((await applyMigrations(db, migrations, false)).pending, []);
            await assert.rejects(applyMigrations(db, migrations.map((m, i) => i === 0 ? { ...m, checksum: 'f'.repeat(64) } : m), false), e => e.code === 'MIGRATION_DIVERGENT');
        }));
        await t.test('colunas ambíguas recusam migração e preservam ledger/dados', () => isolated(async (db, client) => {
            await applyMigrations(db, legacy, false);
            await client.query('ALTER TABLE control_enrollment_limits ADD COLUMN window_start bigint');
            const before = (await client.query('SELECT * FROM control_schema_migrations ORDER BY version')).rows;
            await assert.rejects(applyMigrations(db, migrations, false), e => e.code === '42701' && diagnosticCode(e) === 'DATABASE_SCHEMA_CONFLICT');
            assert.deepEqual((await client.query('SELECT * FROM control_schema_migrations ORDER BY version')).rows, before);
        }));
        await t.test('instalações parciais rastreadas atualizam sem mudar os checksums anteriores', async () => {
            for (const count of [1, 2]) await isolated(async (db, client) => {
                await applyMigrations(db, legacy.slice(0, count), false);
                const before = (await client.query('SELECT * FROM control_schema_migrations ORDER BY version')).rows;
                await applyMigrations(db, migrations, false);
                assert.deepEqual((await client.query('SELECT * FROM control_schema_migrations WHERE version <= $1 ORDER BY version', [count])).rows, before);
                assert.deepEqual((await applyMigrations(db, migrations, false)).pending, []);
            });
        });
        await t.test('coluna ausente falha com diagnóstico específico, sem marcar 004 aplicada', () => isolated(async (db, client) => {
            await applyMigrations(db, legacy, false);
            await client.query('ALTER TABLE control_enrollment_limits RENAME COLUMN "window" TO wrong_column');
            await assert.rejects(applyMigrations(db, migrations, false), e => e.code === '42703' && diagnosticCode(e) === 'DATABASE_SCHEMA_MISMATCH');
            assert.equal((await client.query('SELECT count(*)::int AS count FROM control_schema_migrations')).rows[0].count, 3);
        }));
        await t.test('CLI administrativo distingue erro SQL real sem vazar consulta/credenciais', () => isolated(async (db, client) => {
            await applyMigrations(db, legacy, false);
            await client.query('ALTER TABLE control_enrollment_limits ADD COLUMN window_start bigint');
            const schema = (await client.query('SELECT current_schema() AS schema')).rows[0].schema;
            const environment = fixture.adminEnvironment(schema);
            let failure;
            try { execFileSync(process.execPath, ['scripts/control-admin.mjs', 'migrate', '--apply'], { env: { ...process.env, ...environment }, windowsHide: true, stdio: 'pipe', encoding: 'utf8', timeout: 15000 }); }
            catch (error) { failure = error; }
            assert.equal(failure?.status, 1);
            assert.deepEqual(JSON.parse(failure.stderr), { event: 'control.administration_failed', code: 'DATABASE_SCHEMA_CONFLICT' });
            assert.ok(!failure.stderr.includes(new URL(environment.CONTROL_ADMIN_DATABASE_URL).password));
            assert.doesNotMatch(failure.stderr, /postgresql:|ALTER TABLE|Enrollment window|window_start/);
        }));
        await t.test('rate limit: 10 aceitas, 11ª rejeitada, IP em hash, janela renova e fontes independentes', () => isolated(async (db, client) => {
            await applyMigrations(db, migrations, false);
            const now = Date.now;
            Date.now = () => 600000;
            try {
                for (let i = 0; i < 10; i++) await limitEnrollment(client, '192.0.2.1');
                await assert.rejects(limitEnrollment(client, '192.0.2.1'), e => e.status === 429);
                await limitEnrollment(client, '192.0.2.2');
                const rows = (await client.query('SELECT * FROM control_enrollment_limits')).rows;
                assert.equal(rows.length, 2);
                assert.ok(rows.every(row => /^[a-f0-9]{64}$/.test(row.source_hash) && row.window_start === '10'));
                Date.now = () => 660000;
                await limitEnrollment(client, '192.0.2.1');
                const row = (await client.query('SELECT window_start,attempts FROM control_enrollment_limits WHERE source_hash=$1', [createHash('sha256').update('192.0.2.1').digest('hex')])).rows[0];
                assert.deepEqual(row, { window_start: '11', attempts: 1 });
            } finally { Date.now = now; }
        }));
        await t.test('concorrência de duas conexões não ultrapassa 10 aceitações na mesma janela', () => isolated(async (db, client) => {
            await applyMigrations(db, migrations, false);
            const schema = (await client.query('SELECT current_schema() AS schema')).rows[0].schema;
            const replica = fixture.createPool();
            const other = await replica.connect();
            const now = Date.now; Date.now = () => 600000;
            try {
                await other.query(`SET search_path TO ${schema}`);
                // Two independent connections compete, without queuing concurrent
                // queries on the same client (deprecated by node-postgres).
                const lanes = await Promise.all([client, other].map(async connection => {
                    const results = [];
                    for (let i = 0; i < 10; i++) results.push(...await Promise.allSettled([limitEnrollment(connection, '192.0.2.3')]));
                    return results;
                }));
                const attempts = lanes.flat();
                assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 10);
                assert.ok(attempts.filter(r => r.status === 'rejected').every(r => r.reason.status === 429));
                assert.equal((await client.query('SELECT attempts FROM control_enrollment_limits')).rows[0].attempts, 20);
            } finally { Date.now = now; other.release(); }
        }));
    } finally { await fixture.close(); }
});
