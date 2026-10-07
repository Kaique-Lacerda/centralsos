import type { IncomingMessage, ServerResponse } from 'node:http';
import { z, ZodError } from 'zod';
import { Pool } from 'pg';
import { ControlBackend, ApiError } from './ControlBackend.js';
import { PostgresRepository } from './PostgresRepository.js';
import { ControlAuthentication } from './Authentication.js';
import { profileSchema } from '../../packages/contracts/control/contracts.js';
import { limitEnrollment } from './EnrollmentRateLimit.js';
const pairSchema = z.object({ environmentId: z.uuid(), profile: profileSchema, serverDeviceId: z.uuid().nullable().default(null) }).strict();
let cached: {
    backend: ControlBackend;
    auth: ControlAuthentication;
    origin: string;
    pool: Pool;
} | null = null;
function services() {
    if (cached)
        return cached;
    const names = ['CONTROL_DATABASE_URL', 'CONTROL_OIDC_ISSUER', 'CONTROL_OIDC_CLIENT_ID', 'CONTROL_OIDC_CLIENT_SECRET', 'CONTROL_ORIGIN', 'CONTROL_SESSION_SECRET'] as const;
    if (names.some(name => !process.env[name]))
        throw new ApiError(503, 'Control não configurado: banco, HTTPS e autenticação ainda precisam ser definidos.');
    if (!Number.isInteger(Number(process.env.CONTROL_OFFLINE_SECONDS ?? 90)) || Number(process.env.CONTROL_OFFLINE_SECONDS ?? 90) < 30 || Number(process.env.CONTROL_OFFLINE_SECONDS ?? 90) > 3600)
        throw new ApiError(503, 'CONTROL_OFFLINE_SECONDS precisa estar entre 30 e 3600.');
    const pool = new Pool({ connectionString: process.env.CONTROL_DATABASE_URL, max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 10000 });
    cached = { pool, backend: new ControlBackend(new PostgresRepository(pool), undefined, Number(process.env.CONTROL_OFFLINE_SECONDS ?? 90) * 1000), auth: new ControlAuthentication(pool, { issuer: process.env.CONTROL_OIDC_ISSUER!, clientId: process.env.CONTROL_OIDC_CLIENT_ID!, clientSecret: process.env.CONTROL_OIDC_CLIENT_SECRET!, origin: process.env.CONTROL_ORIGIN!.replace(/\/$/, ''), sessionSecret: process.env.CONTROL_SESSION_SECRET! }), origin: process.env.CONTROL_ORIGIN!.replace(/\/$/, '') };
    return cached;
}
export async function readBody(req: IncomingMessage): Promise<unknown> {
    // Vercel may already have parsed JSON; standalone Node supplies the original stream.
    const parsed = (req as IncomingMessage & {
        body?: unknown;
    }).body;
    let raw = parsed === undefined ? '' : typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    if (parsed === undefined)
        for await (const chunk of req) {
            raw += chunk.toString();
            if (Buffer.byteLength(raw) > 2000000)
                throw new ApiError(413, 'Payload excedeu o limite.');
        }
    if (Buffer.byteLength(raw) > 2000000)
        throw new ApiError(413, 'Payload excedeu o limite.');
    try {
        return JSON.parse(raw || '{}');
    }
    catch {
        throw new ApiError(400, 'JSON inválido.');
    }
}
export async function handleControlApi(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
        const { backend, auth, origin, pool } = services();
        const url = new URL(req.url ?? '/', origin);
        const path = url.pathname;
        const method = req.method ?? 'GET';
        let result: unknown;
        if (path === '/api/control/auth/login' && method === 'GET') {
            const login = await auth.login();
            res.setHeader('Set-Cookie', login.cookie);
            res.writeHead(302, { Location: login.url });
            res.end();
            return;
        }
        if (path === '/api/control/auth/callback' && method === 'GET') {
            const cookie = await auth.callback(url, req.headers.cookie);
            res.setHeader('Set-Cookie', [cookie, 'sos_oidc=; HttpOnly; Secure; SameSite=Lax; Path=/api/control/auth; Max-Age=0']);
            res.writeHead(302, { Location: '/control' });
            res.end();
            return;
        }
        if (path === '/api/agent/enroll' && method === 'POST') {
            // Trust Vercel's overwritten header only on Vercel, otherwise use the direct peer.
            const peer = process.env.VERCEL === '1' ? String(req.headers['x-vercel-forwarded-for'] ?? req.socket?.remoteAddress ?? 'unknown').split(',')[0] : req.socket?.remoteAddress ?? 'unknown';
            await limitEnrollment(pool, peer);
            result = await backend.enroll(await readBody(req));
        }
        else if (path.startsWith('/api/agent/')) {
            const credential = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{40,100})$/)?.[1];
            if (!credential)
                throw new ApiError(401, 'Credencial Agent obrigatória.');
            const match = path.match(/^\/api\/agent\/commands\/([a-f0-9-]{36})\/(ack|result)$/);
            if (path === '/api/agent/heartbeat' && method === 'POST')
                result = await backend.heartbeat(credential, await readBody(req));
            else if (path === '/api/agent/commands' && method === 'GET')
                result = await backend.poll(credential);
            else if (path === '/api/agent/revoke' && method === 'POST')
                result = await backend.revoke(credential);
            else if (match && method === 'POST')
                result = match[2] === 'result' ? await backend.result(credential, match[1], await readBody(req)) : await backend.ack(credential, match[1], z.object({ status: z.enum(['RECEIVED', 'RUNNING']) }).strict().parse(await readBody(req)).status);
            else
                throw new ApiError(404, 'Endpoint não encontrado.');
        }
        else if (path.startsWith('/api/control/')) {
            if (method !== 'GET' && req.headers.origin !== origin)
                throw new ApiError(403, 'Origem não autorizada.');
            const actor = await auth.authenticate(req.headers.cookie);
            const d = path.match(/^\/api\/control\/devices\/([a-f0-9-]{36})(\/commands)?$/);
            const c = path.match(/^\/api\/control\/commands\/([a-f0-9-]{36})$/);
            if (path === '/api/control/session' && method === 'GET')
                result = { name: actor.name };
            else if (path === '/api/control/environments' && method === 'GET')
                result = (await backend.list(actor)).environments;
            else if (path === '/api/control/devices' && method === 'GET')
                result = (await backend.list(actor)).devices;
            else if (path === '/api/control/pairing' && method === 'POST') {
                const p = pairSchema.parse(await readBody(req));
                result = await backend.pair(actor, p.environmentId, p.profile, p.serverDeviceId);
            }
            else if (d && method === 'GET' && !d[2])
                result = await backend.getDevice(actor, d[1]);
            else if (d && method === 'POST' && d[2])
                result = await backend.send(actor, d[1], await readBody(req));
            else if (c && method === 'GET')
                result = await backend.getCommand(actor, c[1]);
            else
                throw new ApiError(404, 'Endpoint não encontrado.');
        }
        else
            throw new ApiError(404, 'Endpoint não encontrado.');
        res.end(JSON.stringify(result));
    }
    catch (e) {
        const status = e instanceof ApiError ? e.status : e instanceof ZodError ? 400 : 503;
        res.statusCode = status;
        res.end(JSON.stringify({ error: e instanceof ApiError ? e.message : e instanceof ZodError ? 'Contrato inválido.' : 'Backend indisponível; consulte os logs administrativos.' }));
        if (!(e instanceof ApiError || e instanceof ZodError))
            console.error(JSON.stringify({ event: 'control.request_failed', code: 'BACKEND_FAILURE' }));
    }
}
