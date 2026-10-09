import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { load } from '../control/load.mjs';
import { isolatedDatabase, tlsFixture, oidcFixture, random, challenge } from './fixture.mjs';
const a = await load('tests/control/administration-entry.ts');
const migrations = await a.readMigrations(resolve('server/control/migrations'));
const configuredDatabase = isolatedDatabase(process.env);
const native = { 'x-central-sos-client': 'support-native-v1', 'content-type': 'application/json' };
const cookie = (response, name) => [].concat(response.headers['set-cookie'] ?? []).find(value => value.startsWith(name + '='))?.split(';')[0];
const field = (html, name) => new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1];

test('proteção de banco: integração nunca usa CONTROL_DATABASE_URL ou banco não confirmado', () => {
    assert.equal(isolatedDatabase({ CONTROL_DATABASE_URL: 'postgres://secret@localhost/production' }), null);
    for (const env of [
        { CONTROL_TEST_DATABASE_URL: 'postgres://test@localhost/production', CONTROL_TEST_ALLOW_DATABASE: 'production' },
        { CONTROL_TEST_DATABASE_URL: 'postgres://test@localhost/central_sos_test' },
        { CONTROL_TEST_DATABASE_URL: 'postgres://test@localhost/central_sos_test?options=unsafe', CONTROL_TEST_ALLOW_DATABASE: 'central_sos_test' }
    ]) assert.throws(() => isolatedDatabase(env), /ISOLATION/);
});
test('OIDC controlado por HTTPS real: discovery, PKCE, assinatura, nonce e sujeito habilitado', async () => {
    const tls = await tlsFixture();
    try {
        const oidc = await oidcFixture(tls), verifier = random(), nonce = random();
        const pool = { query: async (_sql, values) => ({ rows: [{ subject: values[0] }], rowCount: values[0] === 'test-admin' ? 1 : 0 }) };
        const auth = new a.ControlAuthentication(pool, { ...oidc, origin: 'https://control.example.test', sessionSecret: random() }, { fetcher: tls.fetcher, keyResolver: oidc.keyResolver });
        const url = await auth.authorizationUrl(random(), verifier, nonce, '/api/control/auth/native/callback');
        const authorization = await tls.request(url), callback = new URL(authorization.headers.location);
        await assert.rejects(auth.exchangeSubject(callback.searchParams.get('code'), random(), a.digest(nonce), '/api/control/auth/native/callback'));
        assert.equal(await auth.exchangeSubject(callback.searchParams.get('code'), verifier, a.digest(nonce), '/api/control/auth/native/callback'), 'test-admin');
        await assert.rejects(auth.exchangeSubject(callback.searchParams.get('code'), verifier, a.digest(nonce), '/api/control/auth/native/callback')); // single-use OIDC code
    } finally { await tls.close(); }
});

test('integração PostgreSQL real + duas instâncias HTTPS + OIDC controlado', { skip: !configuredDatabase ? 'CONTROL_TEST_DATABASE_URL/CONTROL_TEST_ALLOW_DATABASE não configurados; PostgreSQL real isolado obrigatório.' : false }, async t => {
    const schema = 'control_test_' + randomUUID().replaceAll('-', ''), tls = await tlsFixture();
    const config = a.databaseConfiguration({ ...process.env, CONTROL_DATABASE_URL: configuredDatabase });
    const owner = new Pool(config);
    const pool1 = new Pool({ ...config, options: '-c search_path=' + schema });
    const pool2 = new Pool({ ...config, options: '-c search_path=' + schema });
    let created = false;
    const originalConsole = console.error, logs = [];
    const loginSecrets = [];
    console.error = message => logs.push(String(message));
    const data = { company: { id: randomUUID(), name: 'Integration company A' }, environment: { id: randomUUID(), name: 'Integration environment A' }, operator: { subject: 'test-admin', name: 'Integration administrator' }, role: 'admin' };
    const options = { actor: 'integration-test-runner', dryRun: false };
    let clock = Date.now();
    try {
        await owner.query('CREATE SCHEMA ' + schema); created = true;
        await t.test('1 migrações ordenadas, atômicas e idempotentes entre instâncias', async () => {
            const results = await Promise.all([a.applyMigrations(pool1, migrations, false), a.applyMigrations(pool2, migrations, false)]);
            assert.equal(results.reduce((sum, row) => sum + row.pending.length, 0), migrations.length);
            assert.equal((await pool1.query('SELECT count(*)::int AS count FROM control_schema_migrations')).rows[0].count, migrations.length);
            await assert.rejects(a.applyMigrations(pool1, migrations.map((m, i) => i === 0 ? { ...m, checksum: '0'.repeat(64) } : m), false), error => error.code === 'MIGRATION_DIVERGENT');
        });
        await t.test('2 provisionamento dry-run, idempotência, auditoria e papel explícito', async () => {
            await a.provision(pool1, migrations, data, { ...options, dryRun: true });
            assert.equal((await pool1.query('SELECT count(*)::int AS count FROM control_users')).rows[0].count, 0);
            await Promise.all([a.provision(pool1, migrations, data, options), a.provision(pool2, migrations, data, options)]);
            assert.equal((await pool1.query('SELECT count(*)::int AS count FROM control_users')).rows[0].count, 1);
            assert.equal((await pool1.query('SELECT count(*)::int AS count FROM control_administrative_audit')).rows[0].count, 1);
            await assert.rejects(a.provision(pool1, migrations, { ...data, role: 'viewer' }, options), error => error.code === 'ROLE_CHANGE_CONFIRMATION_REQUIRED');
        });
        const oidc = await oidcFixture(tls), secret = random();
        const domain1 = new a.ControlBackend(new a.PostgresRepository(pool1), () => clock);
        const domain2 = new a.ControlBackend(new a.PostgresRepository(pool2), () => clock);
        let origin, services1, services2;
        origin = await tls.server((req, res) => a.handleControlApi(req, res, services1));
        const replica = await tls.server((req, res) => a.handleControlApi(req, res, services2));
        const auth1 = new a.ControlAuthentication(pool1, { ...oidc, origin, sessionSecret: secret }, { fetcher: tls.fetcher, keyResolver: oidc.keyResolver });
        const auth2 = new a.ControlAuthentication(pool2, { ...oidc, origin, sessionSecret: secret }, { fetcher: tls.fetcher, keyResolver: oidc.keyResolver });
        const native1 = new a.NativeAuthentication(new a.PostgresNativeAuthRepository(pool1), auth1, origin, secret, () => clock);
        const native2 = new a.NativeAuthentication(new a.PostgresNativeAuthRepository(pool2), auth2, origin, secret, () => clock);
        services1 = { pool: pool1, backend: domain1, auth: auth1, nativeAuth: native1, origin };
        services2 = { pool: pool2, backend: domain2, auth: auth2, nativeAuth: native2, origin };
        const call = (path, options = {}, second = false) => tls.request((second ? replica : origin) + path, options);
        async function login(subject = 'test-admin') {
            oidc.identity(subject);
            const verifier = random();
            const start = await call('/api/control/auth/native/start', { method: 'POST', headers: native, body: { protocolVersion: 1, codeChallengeMethod: 'S256', codeChallenge: challenge(verifier) } });
            assert.equal(start.status, 200);
            const s = start.body, proof = { transactionId: s.transactionId, deviceCode: s.deviceCode, codeVerifier: verifier };
            loginSecrets.push(s.deviceCode, verifier);
            const authorization = await tls.request(s.authorizationUrl);
            const identity = await tls.request(authorization.headers.location);
            const callback = await tls.request(identity.headers.location, { headers: { cookie: cookie(authorization, '__Host-sos-native-oidc') } });
            assert.equal(callback.status, 303);
            const grant = cookie(callback, '__Host-sos-native-browser');
            const page = await call(callback.headers.location, { headers: { cookie: grant } }, true);
            assert.equal(page.status, 200);
            const confirm = await call('/api/control/auth/native/confirm', { method: 'POST', headers: { 'content-type': 'application/json', cookie: grant, origin }, body: { transactionId: s.transactionId, userCode: s.userCode, csrfToken: field(page.raw, 'csrfToken'), confirmed: true } }, true);
            assert.equal(confirm.status, 200);
            const status = await call('/api/control/auth/native/status', { method: 'POST', headers: native, body: proof }, true);
            assert.equal(status.body.operator.subject, subject);
            return { proof, completion: { ...proof, expectedSubject: subject } };
        }
        let operator;
        await t.test('3 login OIDC, memberships, handoff nativo consumido uma única vez entre réplicas', async () => {
            const flow = await login();
            const completed = await Promise.all([call('/api/control/auth/native/complete', { method: 'POST', headers: native, body: flow.completion }), call('/api/control/auth/native/complete', { method: 'POST', headers: native, body: flow.completion }, true)]);
            assert.equal(completed.filter(r => r.status === 200).length, 1); assert.equal(completed.filter(r => r.status === 409).length, 1);
            operator = { ...native, authorization: 'Bearer ' + completed.find(r => r.status === 200).body.accessToken };
            loginSecrets.push(operator.authorization.slice(7));
            const session = await call('/api/control/auth/native/session', { headers: operator }, true); assert.equal(session.status, 200); assert.deepEqual(session.body.memberships, [{ companyId: data.company.id, role: 'admin' }]);
        });
        await t.test('4 ambientes, dispositivos vazios e sessão compatíveis com Suporte PR18', async () => {
            assert.deepEqual((await call('/api/control/environments', { headers: operator }, true)).body, [{ ...data.environment, companyId: data.company.id }]);
            assert.deepEqual((await call('/api/control/devices', { headers: operator })).body, []);
        });
        let enrolled, pairing;
        const versions = { appVersion: '0.2.0', agentVersion: '0.1.0', coreVersion: '0.1.0', protocolVersion: 1 };
        await t.test('5 pairing, enrollment concorrente uma vez, heartbeat e nenhuma credencial no inventário', async () => {
            const response = await call('/api/control/pairing', { method: 'POST', headers: operator, body: { environmentId: data.environment.id, profile: 'TERMINAL' } }); assert.equal(response.status, 200); pairing = response.body;
            const body = { pairingCode: pairing.code, fingerprint: 'a'.repeat(64), hostname: 'TEST-SIMULATED-AGENT', profile: 'TERMINAL', ...versions, osVersion: null, architecture: 'x64' };
            const responses = await Promise.all([call('/api/agent/enroll', { method: 'POST', headers: { 'content-type': 'application/json' }, body }), call('/api/agent/enroll', { method: 'POST', headers: { 'content-type': 'application/json' }, body }, true)]);
            assert.equal(responses.filter(r => r.status === 200).length, 1); enrolled = responses.find(r => r.status === 200).body;
            const heartbeat = await call('/api/agent/heartbeat', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + enrolled.credential }, body: { deviceId: enrolled.deviceId, hostname: 'TEST-SIMULATED-AGENT', profile: 'TERMINAL', ...versions, timestamp: new Date(clock).toISOString(), uptime: 1, localIp: null, healthSummary: 'ok', osVersion: null } }, true); assert.equal(heartbeat.status, 200);
            const devices = await call('/api/control/devices', { headers: operator }); assert.equal(devices.body[0].status, 'ONLINE'); assert.ok(!devices.raw.includes(enrolled.credential)); assert.ok(!devices.raw.includes('credentialHash'));
        });
        let command;
        const agent = () => ({ 'content-type': 'application/json', authorization: 'Bearer ' + enrolled.credential });
        await t.test('6 policy existente, comando pendente, polling e ACK persistentes', async () => {
            const created = await call('/api/control/devices/' + enrolled.deviceId + '/commands', { method: 'POST', headers: operator, body: { type: 'machine.refresh', payload: {} } }); assert.equal(created.status, 200); command = created.body;
            const pending = await call('/api/agent/commands', { headers: agent() }, true); assert.equal(pending.body[0].id, command.id);
            for (const status of ['RECEIVED', 'RUNNING']) assert.equal((await call('/api/agent/commands/' + command.id + '/ack', { method: 'POST', headers: agent(), body: { status } }, true)).status, 200);
            const rejected = await call('/api/control/devices/' + enrolled.deviceId + '/commands', { method: 'POST', headers: operator, body: { type: 'shell', payload: { script: 'not allowed' } } }); assert.equal(rejected.status, 400);
        });
        await t.test('7 resultado simulado explicitamente sem execução Windows, auditoria e idempotência', async () => {
            const result = { commandId: command.id, protocolVersion: 1, success: false, status: 'REJECTED', summary: 'Agent de teste: nenhuma coleta ou operação Windows executada.', details: { simulated: true, reason: 'TEST_AGENT_NO_WINDOWS_EXECUTOR' }, startedAt: new Date(clock).toISOString(), finishedAt: new Date(clock).toISOString() };
            for (let i = 0; i < 2; i++) assert.equal((await call('/api/agent/commands/' + command.id + '/result', { method: 'POST', headers: agent(), body: result }, i === 1)).status, 200);
            const history = await call('/api/control/devices/' + enrolled.deviceId, { headers: operator }, true); assert.ok(history.body.history.some(row => row.outcome === 'REJECTED'));
            const fetched = await call('/api/control/commands/' + command.id, { headers: operator }, true); assert.equal(fetched.body.result.details.simulated, true);
        });
        let outsider;
        await t.test('8 isolamento empresa/ambiente e viewer sem comandos/pairing', async () => {
            const b = { ...data, company: { id: randomUUID(), name: 'Integration B' }, environment: { id: randomUUID(), name: 'Integration B' }, operator: { subject: 'test-viewer', name: 'Integration viewer' }, role: 'viewer' };
            await a.provision(pool2, migrations, b, options);
            const flow = await login('test-viewer'), completed = await call('/api/control/auth/native/complete', { method: 'POST', headers: native, body: flow.completion }); outsider = { ...native, authorization: 'Bearer ' + completed.body.accessToken };
            loginSecrets.push(completed.body.accessToken);
            assert.deepEqual((await call('/api/control/devices', { headers: outsider })).body, []);
            assert.equal((await call('/api/control/devices/' + enrolled.deviceId, { headers: outsider })).status, 403);
            assert.equal((await call('/api/control/commands/' + command.id, { headers: outsider })).status, 403);
            assert.equal((await call('/api/control/pairing', { method: 'POST', headers: outsider, body: { environmentId: b.environment.id, profile: 'TERMINAL' } })).status, 403);
            assert.equal((await call('/api/control/devices/' + enrolled.deviceId + '/commands', { method: 'POST', headers: outsider, body: { type: 'machine.refresh', payload: {} } })).status, 403);
        });
        await t.test('9 revogação Agent e sessão operador logout sem fallback', async () => {
            assert.equal((await call('/api/agent/revoke', { method: 'POST', headers: agent() })).status, 200);
            assert.equal((await call('/api/agent/commands', { headers: agent() }, true)).status, 401);
            assert.equal((await call('/api/control/auth/native/logout', { method: 'POST', headers: operator }, true)).status, 200);
            const response = await call('/api/control/devices', { headers: operator }); assert.equal(response.body.code, 'SESSION_REVOKED');
        });
        await t.test('10 sessão expirada e usuário desabilitado consultados em PostgreSQL', async () => {
            clock += 8 * 3600000 + 1;
            const expired = await call('/api/control/devices', { headers: outsider }, true); assert.equal(expired.body.code, 'SESSION_EXPIRED');
            clock = Date.now();
            const flow = await login(), completed = await call('/api/control/auth/native/complete', { method: 'POST', headers: native, body: flow.completion });
            const headers = { ...native, authorization: 'Bearer ' + completed.body.accessToken };
            loginSecrets.push(completed.body.accessToken);
            await pool1.query('UPDATE control_users SET enabled=false WHERE subject=$1', ['test-admin']);
            const disabled = await call('/api/control/devices', { headers }, true); assert.equal(disabled.body.code, 'OPERATOR_DISABLED');
        });
        await t.test('11 browser OIDC não habilita operador não provisionado', async () => {
            oidc.identity('test-unprovisioned');
            const login = await call('/api/control/auth/login');
            const authorized = await tls.request(login.headers.location);
            const denied = await tls.request(authorized.headers.location, { headers: { cookie: cookie(login, 'sos_oidc') } }); assert.equal(denied.status, 403);
        });
        await t.test('12 falha real de conexão SQL, HTTP seguro e ausência de credenciais nos logs', async () => {
            const badPool = new Pool({ ...config, port: 1, connectionTimeoutMillis: 100, connectionString: undefined, host: '127.0.0.1', database: 'central_sos_test', user: 'test' });
            try {
                await assert.rejects(new a.PostgresRepository(badPool).transaction(() => {}));
                const failure = { ...services1, backend: new a.ControlBackend(new a.PostgresRepository(badPool)) };
                const failingOrigin = await tls.server((req, res) => a.handleControlApi(req, res, failure));
                const response = await tls.request(failingOrigin + '/api/agent/commands', { headers: agent() }); assert.equal(response.status, 503); assert.ok(!response.raw.includes(configuredDatabase));
                assert.ok(logs.some(row => row.includes('DATABASE_UNAVAILABLE')));
                for (const secretValue of [secret, oidc.clientSecret, operator.authorization, enrolled.credential, pairing.code, configuredDatabase, ...loginSecrets]) assert.ok(logs.every(row => !row.includes(secretValue)));
                assert.ok(logs.every(row => !/test-admin|test-viewer|SELECT|127\.0\.0\.1/.test(row)));
            } finally { await badPool.end(); }
        });
    } finally {
        console.error = originalConsole;
        await tls.close(); await pool1.end(); await pool2.end();
        // Cleanup only the randomly-created schema inside the confirmed test DB.
        // No DROP DATABASE and no access to production/public schema.
        if (created) await owner.query('DROP SCHEMA ' + schema + ' CASCADE');
        await owner.end();
    }
});
