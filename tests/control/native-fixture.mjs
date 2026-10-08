import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { generateKeyPair, SignJWT } from 'jose';
import { load } from './load.mjs';

export const { NativeAuthentication, proofChallenge, PostgresNativeAuthRepository, emptyNativeState, ControlAuthentication, handleControlApi, ControlBackend, MemoryRepository } = await load('tests/control/native-entry.ts');
const keys = await generateKeyPair('ES256'); // Ephemeral OIDC test signer; never written to disk.
export const origin = 'https://control.example.test';
export const companyId = '46b36bf7-8a55-44de-97bf-88052f42b135';
export const environmentId = '361b8019-96ae-431b-92af-8dbd5b43c633';
const random = () => randomBytes(32).toString('base64url');

// Test-only transactional model: replicas share serialized transactions and live actors.
export class TestNativeRepository {
    state = emptyNativeState();
    tail = Promise.resolve();
    constructor(users) { this.users = users; }
    transaction(work) {
        const run = this.tail.then(async () => {
            const state = structuredClone(this.state);
            const result = await work({ state, actor: async subject => {
                const user = this.users.get(subject);
                return user?.enabled ? structuredClone(user.actor) : null;
            }});
            this.state = state;
            return result;
        });
        this.tail = run.catch(() => {});
        return run;
    }
}

export function fixture({ repositoryFactory } = {}) {
    let clock = Date.parse('2026-10-08T12:00:00Z');
    const users = new Map([['operator-a', { enabled: true, actor: { id: 'operator-a', name: 'Operador de teste', memberships: [{ companyId, role: 'admin' }] } }]]);
    const sessions = new Map(), codes = new Map();
    const config = { issuer: 'https://identity.example.test', origin, clientId: 'support-test-client', clientSecret: random(), sessionSecret: random() };
    const calls = [];
    const pool = { query: async (sql, values) => {
        if (sql.startsWith('INSERT INTO control_sessions')) { sessions.set(values[0], values[1]); return { rows: [], rowCount: 1 }; }
        if (sql.includes('control_memberships')) return { rows: structuredClone(users.get(values[0])?.actor.memberships ?? []) };
        const subject = sql.includes('control_sessions') ? sessions.get(values[0]) : values[0];
        const user = users.get(subject);
        return { rows: user?.enabled ? [{ subject, display_name: user.actor.name }] : [], rowCount: user?.enabled ? 1 : 0 };
    }};
    const fetcher = async (url, options) => {
        calls.push({ url, options });
        assert.equal(options.redirect, 'error'); assert.ok(options.signal);
        if (url.endsWith('/.well-known/openid-configuration')) return Response.json({ issuer: config.issuer, authorization_endpoint: config.issuer+'/authorize', token_endpoint: config.issuer+'/token', jwks_uri: config.issuer+'/jwks' });
        assert.equal(url, config.issuer+'/token');
        const form = options.body, saved = codes.get(form.get('code'));
        if (!saved || saved.used || form.get('client_secret') !== config.clientSecret || form.get('client_id') !== config.clientId || form.get('redirect_uri') !== saved.redirect || proofChallenge(form.get('code_verifier')) !== saved.challenge) return Response.json({ error: 'invalid_grant' }, { status: 401 });
        saved.used = true;
        const now = Math.floor(Date.now()/1000);
        const jwt = await new SignJWT({ sub: saved.subject, nonce: saved.nonce, iss: config.issuer, aud: config.clientId, iat: now, exp: now+300, ...saved.overrides }).setProtectedHeader({ alg: 'ES256' }).sign(keys.privateKey);
        const parts = jwt.split('.');
        if (saved.overrides.breakSignature) parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
        return Response.json({ id_token: parts.join('.') });
    };
    const oidc = new ControlAuthentication(pool, config, { fetcher, keyResolver: async () => keys.publicKey });
    const repo = repositoryFactory ? repositoryFactory(users) : new TestNativeRepository(users);
    const makeAuth = () => new NativeAuthentication(repo, oidc, origin, config.sessionSecret, () => clock);
    const auth = makeAuth();
    function issue(url, subject='operator-a', overrides={}) {
        const params = new URL(url).searchParams, code = random();
        codes.set(code, { subject, overrides, nonce: params.get('nonce'), challenge: params.get('code_challenge'), redirect: params.get('redirect_uri'), used: false });
        return { code, state: params.get('state') };
    }
    async function start() {
        const verifier = random();
        const started = await auth.start({ protocolVersion: 1, codeChallengeMethod: 'S256', codeChallenge: proofChallenge(verifier) });
        return { started, proof: { transactionId: started.transactionId, deviceCode: started.deviceCode, codeVerifier: verifier } };
    }
    async function browser(login, subject='operator-a', overrides={}) {
        const authorization = await auth.authorize(login.started.userCode), exchange = issue(authorization.url, subject, overrides);
        const grant = await auth.callback(exchange.state, exchange.code, authorization.browser);
        const confirmation = await auth.confirmation(grant.transactionId, grant.browser);
        return { authorization, exchange, grant, confirmation, input: { transactionId: grant.transactionId, csrfToken: confirmation.csrf, userCode: confirmation.userCode, confirmed: true } };
    }
    async function approve(login) { const b = await browser(login); await auth.confirm(b.input,b.grant.browser); return b; }
    async function credential() { const login = await start(); await approve(login); return auth.complete({ ...login.proof, expectedSubject: 'operator-a' }); }
    const domain = new MemoryRepository(); domain.state.environments.push({ id: environmentId, companyId, name: 'Ambiente de teste' });
    const backend = new ControlBackend(domain, () => clock);
    return { auth, oidc, repo, users, pool, domain, backend, config, calls, start, browser, approve, credential, issue, makeAuth, now: () => clock, advance: ms => clock+=ms };
}
export async function request(f, path, { method='GET', headers={}, body, encrypted=true } = {}) {
    const response = { statusCode: 200, headers: {}, setHeader(key,value) { this.headers[key.toLowerCase()] = value; }, writeHead(status,headers) { this.statusCode=status; for (const [k,v] of Object.entries(headers)) this.setHeader(k,v); }, end(raw) { this.raw=raw??''; try { this.body=JSON.parse(this.raw); } catch { this.body=this.raw; } } };
    await handleControlApi({ url: '/api/control'+path, method, headers, body, socket: { encrypted, remoteAddress: '192.0.2.1' } }, response, { nativeAuth: f.auth, auth: f.oidc, origin, pool: f.pool, backend: f.backend });
    return response;
}
export const nativeHeaders = { 'x-central-sos-client': 'support-native-v1', 'content-type': 'application/json' };
export const denied = code => error => { assert.equal(error.code, code); return true; };
