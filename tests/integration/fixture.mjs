import { createServer, request as httpsRequest } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from 'jose';

export const random = () => randomBytes(32).toString('base64url');
export const challenge = value => createHash('sha256').update(value).digest('base64url');
export function isolatedDatabase(env) {
    if (!env.CONTROL_TEST_DATABASE_URL) return null;
    let url; try { url = new URL(env.CONTROL_TEST_DATABASE_URL); } catch { throw new Error('TEST_DATABASE_CONFIGURATION_INVALID'); }
    const name = url.pathname.slice(1);
    if (!/^central_sos_test(?:_[a-z0-9_]+)?$/.test(name) || env.CONTROL_TEST_ALLOW_DATABASE !== name || url.search) throw new Error('TEST_DATABASE_EXPLICIT_ISOLATION_REQUIRED');
    return env.CONTROL_TEST_DATABASE_URL;
}

/** Test-only certificate and signer, never used by production or updater. TLS is
 * validated using this explicit CA, never NODE_TLS_REJECT_UNAUTHORIZED=0. */
export async function tlsFixture() {
    const directory = resolve('.control-build', 'integration-tls-' + randomUUID());
    await mkdir(directory, { recursive: true });
    const keyFile = resolve(directory, 'temporary.key'), certFile = resolve(directory, 'temporary.crt');
    let key, cert;
    try {
        const openssl = process.env.CONTROL_TEST_OPENSSL ?? (process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl');
        execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', keyFile, '-out', certFile], { stdio: 'pipe', timeout: 15000 });
        key = await readFile(keyFile); cert = await readFile(certFile);
    } finally { await unlink(keyFile).catch(() => {}); await unlink(certFile).catch(() => {}); }
    const servers = [];
    async function server(handler) {
        const instance = createServer({ key, cert }, (req, res) => {
            Promise.resolve(handler(req, res)).catch(() => { res.statusCode = 500; res.end('test fixture failed'); });
        });
        await new Promise((ok, fail) => { instance.once('error', fail); instance.listen(0, '127.0.0.1', ok); });
        servers.push(instance);
        return 'https://127.0.0.1:' + instance.address().port;
    }
    async function request(url, { method = 'GET', headers = {}, body, signal } = {}) {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' || parsed.hostname !== '127.0.0.1') throw new Error('TEST_FIXTURE_URL_REJECTED');
        return new Promise((ok, fail) => {
            const outgoing = httpsRequest(parsed, { method, headers, ca: cert, rejectUnauthorized: true, signal, timeout: 10000 }, incoming => {
                const chunks = [];
                incoming.on('data', chunk => chunks.push(chunk));
                incoming.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    let data; try { data = JSON.parse(raw); } catch { data = raw; }
                    ok({ status: incoming.statusCode, headers: incoming.headers, raw, body: data });
                });
            });
            outgoing.on('timeout', () => outgoing.destroy(new Error('TEST_FIXTURE_TIMEOUT')));
            outgoing.on('error', fail);
            outgoing.end(body === undefined ? undefined : body instanceof URLSearchParams ? body.toString() : typeof body === 'string' ? body : JSON.stringify(body));
        });
    }
    const fetcher = async (url, options) => {
        const response = await request(url, options);
        return new Response(response.raw, { status: response.status, headers: response.headers });
    };
    return { server, request, fetcher, close: async () => { await Promise.all(servers.map(instance => new Promise(ok => { instance.closeAllConnections(); instance.close(ok); }))); key.fill(0); } };
}
export async function oidcFixture(tls) {
    const keys = await generateKeyPair('ES256'), publicKey = await exportJWK(keys.publicKey);
    publicKey.kid = 'test-oidc-key'; publicKey.alg = 'ES256'; publicKey.use = 'sig';
    const clientId = 'central-sos-integration', clientSecret = random(), codes = new Map();
    let issuer, nextIdentity = { subject: 'test-admin', overrides: {} };
    issuer = await tls.server(async (req, res) => {
        const url = new URL(req.url, issuer);
        const json = (data, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
        if (url.pathname === '/.well-known/openid-configuration') return json({ issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', jwks_uri: issuer + '/jwks' });
        if (url.pathname === '/jwks') return json({ keys: [publicKey] });
        if (url.pathname === '/authorize') {
            if (url.searchParams.get('client_id') !== clientId || url.searchParams.get('code_challenge_method') !== 'S256') return json({ error: 'invalid_request' }, 400);
            const code = random(), redirect = url.searchParams.get('redirect_uri');
            codes.set(code, { ...nextIdentity, redirect, nonce: url.searchParams.get('nonce'), challenge: url.searchParams.get('code_challenge') });
            const callback = new URL(redirect); callback.searchParams.set('code', code); callback.searchParams.set('state', url.searchParams.get('state'));
            res.writeHead(302, { Location: callback.toString() }); res.end(); return;
        }
        if (url.pathname === '/token' && req.method === 'POST') {
            let raw = ''; for await (const chunk of req) raw += chunk.toString();
            const params = new URLSearchParams(raw), saved = codes.get(params.get('code'));
            if (!saved || params.get('client_secret') !== clientSecret || params.get('client_id') !== clientId || params.get('redirect_uri') !== saved.redirect || challenge(params.get('code_verifier')) !== saved.challenge) return json({ error: 'invalid_grant' }, 401);
            codes.delete(params.get('code'));
            const now = Math.floor(Date.now() / 1000);
            const jwt = await new SignJWT({ sub: saved.subject, nonce: saved.nonce, ...saved.overrides }).setProtectedHeader({ alg: 'ES256', kid: publicKey.kid }).setIssuer(issuer).setAudience(clientId).setIssuedAt(now).setExpirationTime(now + 300).sign(keys.privateKey);
            return json({ id_token: jwt });
        }
        json({ error: 'not_found' }, 404);
    });
    // Obtain actual JWKS over verified fixture HTTPS. The existing injection seam
    // changes only how test CA trust is supplied, not cryptographic validation.
    const jwks = (await tls.request(issuer + '/jwks')).body;
    return { issuer, clientId, clientSecret, keyResolver: createLocalJWKSet(jwks), identity(subject, overrides = {}) { nextIdentity = { subject, overrides }; } };
}
