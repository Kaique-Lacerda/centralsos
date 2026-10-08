import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { load } from './load.mjs';
const a = await load('tests/control/administration-entry.ts');
const migrations = await a.readMigrations(resolve('server/control/migrations'));
const tables = ['central_sos_control_state', 'control_users', 'control_memberships', 'control_sessions', 'control_enrollment_limits', 'control_native_auth_state', 'control_companies', 'control_administrative_audit'];
const data = { company: { id: randomUUID(), name: 'Test company' }, environment: { id: randomUUID(), name: 'Test environment' }, operator: { subject: 'test-oidc-subject', name: 'Test operator' }, role: 'admin' };
const deny = code => error => error.code === code;

// SQL-contract fixture only. Real transactions/concurrency are covered separately
// by tests/integration against an explicitly isolated PostgreSQL database.
function database({ applied = [], present = [], fail, existing = false, disabled = false, role = 'admin', wrongCompany = false } = {}) {
    const calls = [], ledger = [...applied], relations = new Set(present);
    if (applied.length) relations.add('control_schema_migrations');
    const state = { environments: existing ? [{ ...data.environment, companyId: wrongCompany ? randomUUID() : data.company.id }] : [], devices: [], commands: [], results: [], pairing: [], audit: [] };
    const client = { async query(sql, values) {
        calls.push({ sql, values }); if (fail && sql.includes(fail)) throw Object.assign(new Error('private credentials must not escape'), { code: 'ECONNREFUSED' });
        if (sql.includes('to_regclass')) return { rows: [{ table_name: relations.has(values?.[0] ?? 'control_schema_migrations') ? 'table' : null }] };
        if (sql.startsWith('SELECT version')) return { rows: ledger };
        if (sql.startsWith('SELECT state')) return { rows: [{ state: structuredClone(state) }] };
        if (sql.startsWith('SELECT name')) return { rows: existing ? [{ name: data.company.name }] : [] };
        if (sql.startsWith('SELECT display_name')) return { rows: existing ? [{ display_name: data.operator.name, enabled: !disabled }] : [] };
        if (sql.startsWith('SELECT role')) return { rows: existing ? [{ role }] : [] };
        return { rows: [] };
    }, release() { calls.push({ sql: 'RELEASE' }); } };
    return { calls, pool: { connect: async () => client }, client };
}
const ready = options => database({ applied: migrations, present: tables, ...options });

test('configuração administrativa explícita, sem credenciais padrão ou URL em erros', () => {
    for (const env of [{}, { CONTROL_ADMIN_ENABLED: '1' }, { CONTROL_ADMIN_ACTOR: 'operator' }, { CONTROL_ADMIN_ENABLED: '1', CONTROL_ADMIN_ACTOR: '\ninvalid' }]) assert.throws(() => a.requireAdministration(env), deny('ADMINISTRATION_NOT_AUTHORIZED'));
    assert.equal(a.requireAdministration({ CONTROL_ADMIN_ENABLED: '1', CONTROL_ADMIN_ACTOR: 'owner' }), 'owner');
    assert.throws(() => a.databaseConfiguration({ CONTROL_DATABASE_URL: 'postgres://private:secret@localhost/prod' }, true), deny('DATABASE_NOT_CONFIGURED'));
    assert.throws(() => a.databaseConfiguration({ CONTROL_DATABASE_URL: 'invalid:secret' }), deny('DATABASE_CONFIGURATION_INVALID'));
});
test('TLS: valida certificado por padrão; disable somente loopback; URL não substitui SSL/CA', () => {
    const url = 'postgres://test:test@localhost/central_sos_test';
    assert.deepEqual(a.databaseConfiguration({ CONTROL_DATABASE_URL: url }).ssl, { rejectUnauthorized: true });
    assert.equal(a.databaseConfiguration({ CONTROL_DATABASE_URL: url, CONTROL_DATABASE_TLS: 'disable' }).ssl, false);
    assert.equal(a.databaseConfiguration({ CONTROL_DATABASE_URL: url, CONTROL_DATABASE_CA: 'test CA' }).ssl.ca, 'test CA');
    assert.throws(() => a.databaseConfiguration({ CONTROL_DATABASE_URL: url.replace('localhost', 'db.example.test'), CONTROL_DATABASE_TLS: 'disable' }), deny('DATABASE_TLS_REQUIRED'));
    for (const option of ['sslmode=disable', 'sslmode=require', 'sslrootcert=private', 'sslnegotiation=direct']) assert.throws(() => a.databaseConfiguration({ CONTROL_DATABASE_URL: url + '?' + option }), deny('DATABASE_TLS_URL_OPTIONS_FORBIDDEN'));
});
test('configuração real exige HTTPS canônico, OIDC e segredo de sessão externos', () => {
    const env = { CONTROL_ORIGIN: 'https://control.example.test', CONTROL_OIDC_ISSUER: 'https://id.example.test/issuer', CONTROL_OIDC_CLIENT_ID: 'test', CONTROL_OIDC_CLIENT_SECRET: 'test', CONTROL_SESSION_SECRET: 'x'.repeat(32) };
    assert.equal(a.controlConfiguration(env).origin, env.CONTROL_ORIGIN);
    for (const origin of ['http://control.example.test', 'https://control.example.test/api', 'https://user:pass@control.example.test']) assert.throws(() => a.controlConfiguration({ ...env, CONTROL_ORIGIN: origin }));
    assert.throws(() => a.controlConfiguration({ ...env, CONTROL_OIDC_ISSUER: 'http://id.example.test' }));
    assert.throws(() => a.controlConfiguration({ ...env, CONTROL_OIDC_CLIENT_SECRET: '' }), deny('CONTROL_NOT_CONFIGURED'));
});
test('catálogo de migrações fixo, checksums estáveis em LF/CRLF e sem transação aninhada', async () => {
    assert.deepEqual(migrations.map(m => m.name), a.migrationNames);
    for (const m of migrations) { assert.match(m.checksum, /^[a-f0-9]{64}$/); assert.doesNotMatch(m.sql, /\b(BEGIN|COMMIT|ROLLBACK)\s*;/i); assert.doesNotMatch(m.sql, /DROP\s+TABLE|TRUNCATE/i); }
    const directory = resolve('.control-build', 'migration-test-' + randomUUID()); await mkdir(directory, { recursive: true });
    for (const name of a.migrationNames) await writeFile(resolve(directory, name), (await readFile(resolve('server/control/migrations', name), 'utf8')).replace(/\r?\n/g, '\r\n'));
    assert.deepEqual((await a.readMigrations(directory)).map(m => m.checksum), migrations.map(m => m.checksum));
});
test('migrações dry-run não executa DDL; aplicação mantém ordem, ledger e commit atômico', async () => {
    let d = database(); const result = await a.applyMigrations(d.pool, migrations); assert.equal(result.pending.length, 3);
    assert.ok(!d.calls.some(c => /CREATE TABLE|INSERT INTO/.test(c.sql))); assert.equal(d.calls.at(-2).sql, 'ROLLBACK');
    d = database(); await a.applyMigrations(d.pool, migrations, false);
    const inserted = d.calls.filter(c => c.sql.startsWith('INSERT INTO control_schema_migrations')); assert.deepEqual(inserted.map(c => c.values[0]), [1, 2, 3]);
    assert.equal(d.calls[0].sql, 'BEGIN'); assert.match(d.calls[1].sql, /pg_advisory_xact_lock/); assert.equal(d.calls.at(-2).sql, 'COMMIT');
});
test('migrações já aplicadas não repetem SQL; divergência, ordem desconhecida e legado falham', async () => {
    const d = ready(); await a.applyMigrations(d.pool, migrations, false); assert.ok(!d.calls.some(c => c.sql.startsWith('INSERT INTO control_schema_migrations')));
    for (const options of [{ applied: [{ ...migrations[0], checksum: 'f'.repeat(64) }], present: tables }, { applied: [migrations[1]], present: tables }]) await assert.rejects(a.applyMigrations(database(options).pool, migrations, false), deny('MIGRATION_DIVERGENT'));
    await assert.rejects(a.applyMigrations(database({ present: [tables[0]] }).pool, migrations, false), deny('MIGRATION_LEGACY_SCHEMA_UNTRACKED'));
    await assert.rejects(a.applyMigrations(database({ applied: migrations, present: [] }).pool, migrations, false), deny('MIGRATION_SCHEMA_MISSING'));
});
test('falha de SQL causa rollback e libera conexão sem commit', async () => {
    const d = database({ fail: 'CREATE TABLE central_sos_control_state' }); await assert.rejects(a.applyMigrations(d.pool, migrations, false)); assert.equal(d.calls.at(-2).sql, 'ROLLBACK'); assert.equal(d.calls.at(-1).sql, 'RELEASE'); assert.ok(!d.calls.some(c => c.sql === 'COMMIT'));
});
test('provisionamento valida UUID/subject/papel e recusa campos não previstos', async () => {
    assert.equal(a.provisioningSchema.parse({ ...data, company: { ...data.company, id: data.company.id.toUpperCase() } }).company.id, data.company.id);
    for (const input of [{ ...data, company: { ...data.company, id: 'invalid' } }, { ...data, operator: { ...data.operator, subject: '\nsecret' } }, { ...data, role: 'root' }, { ...data, password: 'not accepted' }]) await assert.rejects(a.provision(ready().pool, migrations, input, { actor: 'owner', dryRun: false }), deny('PROVISIONING_INPUT_INVALID'));
});
test('provisionamento dry-run preserva banco; commit registra auditoria sem sujeito/ator em claro', async () => {
    let d = ready(); const options = { actor: 'test-owner', dryRun: true };
    assert.equal((await a.provision(d.pool, migrations, data, options)).changed, true); assert.ok(!d.calls.some(c => /^(INSERT|UPDATE)/.test(c.sql)));
    d = ready(); await a.provision(d.pool, migrations, data, { ...options, dryRun: false });
    const audit = d.calls.find(c => c.sql.startsWith('INSERT INTO control_administrative_audit'));
    assert.match(audit.values[1], /^[a-f0-9]{64}$/); assert.match(audit.values[2], /^[a-f0-9]{64}$/); assert.ok(!JSON.stringify(audit.values).includes(data.operator.subject));
    assert.ok(d.calls.every(c => !/DELETE|TRUNCATE|DROP/.test(c.sql))); assert.equal(d.calls.at(-2).sql, 'COMMIT');
});
test('provisionamento idempotente, sem reativar usuário, remover vínculos ou mover ambiente', async () => {
    const options = { actor: 'owner', dryRun: false };
    let d = ready({ existing: true }); assert.equal((await a.provision(d.pool, migrations, data, options)).changed, false); assert.ok(!d.calls.some(c => /^(INSERT|UPDATE)/.test(c.sql)));
    await assert.rejects(a.provision(ready({ existing: true, disabled: true }).pool, migrations, data, options), deny('OPERATOR_DISABLED'));
    await assert.rejects(a.provision(ready({ existing: true, wrongCompany: true }).pool, migrations, data, options), deny('ENVIRONMENT_COMPANY_CONFLICT'));
    await assert.rejects(a.provision(ready({ existing: true, role: 'viewer' }).pool, migrations, data, options), deny('ROLE_CHANGE_CONFIRMATION_REQUIRED'));
    const dryRun = ready({ existing: true, role: 'viewer' }); assert.equal((await a.provision(dryRun.pool, migrations, data, { ...options, dryRun: true })).roleChangeRequiresConfirmation, true); assert.ok(!dryRun.calls.some(c => /^(INSERT|UPDATE)/.test(c.sql)));
    d = ready({ existing: true, role: 'viewer' }); assert.equal((await a.provision(d.pool, migrations, data, { ...options, confirmRoleChange: true })).changes.membership, 'role_changed');
});
test('provisionamento exige migrações e rollback preserva alterações após erro', async () => {
    await assert.rejects(a.provision(database().pool, migrations, data, { actor: 'owner', dryRun: false }), deny('MIGRATION_REQUIRED'));
    const d = ready({ fail: 'INSERT INTO control_administrative_audit' }); await assert.rejects(a.provision(d.pool, migrations, data, { actor: 'owner', dryRun: false })); assert.equal(d.calls.at(-2).sql, 'ROLLBACK'); assert.ok(!d.calls.some(c => c.sql === 'COMMIT'));
});
test('diagnósticos seguros não serializam mensagem/SQL/credenciais ou query do callback', async () => {
    const error = Object.assign(new Error('postgres://user:secret@example.test SELECT private'), { code: 'ECONNREFUSED' });
    assert.equal(a.diagnosticCode(error), 'DATABASE_UNAVAILABLE'); assert.equal(a.diagnosticCode({ code: '42P01' }), 'MIGRATION_REQUIRED');
    const report = a.safeRequestDiagnostic('/api/control/auth/native/callback?code=secret', error); assert.deepEqual(report, { event: 'control.request_failed', area: 'native-auth', code: 'DATABASE_UNAVAILABLE' });
    assert.equal(a.safeRequestDiagnostic('/api/agent/enroll', new a.ApiError(409, 'Protocolo incompatível')).area, 'enrollment');
    assert.equal(a.diagnosticCode(new a.ApiError(409, 'Protocolo incompatível; atualize Desktop/Agent.')), 'PROTOCOL_MISMATCH');
    assert.equal(a.diagnosticCode(new a.ApiError(400, 'Código inválido, expirado ou já utilizado.')), 'ENROLLMENT_REJECTED');
    const diagnostic = await a.administrativeDiagnostics({}, null, migrations); assert.ok(diagnostic.some(d => d.code === 'CONTROL_NOT_CONFIGURED')); assert.doesNotMatch(JSON.stringify(diagnostic), /secret|postgres:\/\//);
});
test('CLI não executa nada sem autorização explícita e falha sem imprimir ambiente', () => {
    try { execFileSync(process.execPath, ['scripts/control-admin.mjs', 'migrate', '--apply'], { env: { ...process.env, CONTROL_ADMIN_ENABLED: '', CONTROL_ADMIN_DATABASE_URL: 'postgres://private:super-secret@localhost/prod' }, encoding: 'utf8', stdio: 'pipe' }); assert.fail('must reject'); }
    catch (error) { assert.equal(error.status, 1); assert.match(error.stderr, /ADMINISTRATION_NOT_AUTHORIZED/); assert.doesNotMatch(error.stderr, /super-secret|postgres:\/\//); }
});
