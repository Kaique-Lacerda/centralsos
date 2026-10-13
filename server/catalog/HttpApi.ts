import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Pool } from 'pg';
import { CatalogAuthentication, clearCookie, clearLegacyCookie, digest, equalHash, type CatalogActor } from './Authentication.js';
import { CatalogService } from './CatalogService.js';
import { catalogPool, catalogConfiguration } from './Configuration.js';
import { PrivateBlobStorage } from './Storage.js';
import { CatalogError, id, loginSchema, parse, roleSchema, requireSession } from './Validation.js';
export interface CatalogApiServices { pool: Pool; auth: CatalogAuthentication; catalog: CatalogService; origin: string }
let cached: CatalogApiServices | undefined;
export function catalogServices(): CatalogApiServices {
    if (cached) return cached;
    const config = catalogConfiguration(process.env), pool = catalogPool(process.env);
    return cached = { pool, origin: config.origin, auth: new CatalogAuthentication(pool, config.rateSecret), catalog: new CatalogService(pool, new PrivateBlobStorage()) };
}
const messages: Record<string, string> = {
    SESSION_REQUIRED: 'Entre no CENTRAL SOS para acessar o portal.',
    INVALID_CREDENTIAL: 'Senha incorreta ou acesso indisponível.', LOGIN_RATE_LIMITED: 'Muitas tentativas. Aguarde cinco minutos.',
    ACCESS_DENIED: 'Acesso reservado ao administrador.', SESSION_EXPIRED: 'Sessão encerrada. Entre novamente.', SESSION_INVALID: 'Sessão inválida.',
    CSRF_REJECTED: 'Recarregue a página antes de tentar novamente.', CATALOG_NOT_CONFIGURED: 'O catálogo administrável ainda não foi configurado.',
    DOWNLOAD_DENIED: 'Download indisponível ou acesso não autorizado.', INVALID_INPUT: 'Confira os dados informados.',
    FILE_FORMAT_INVALID: 'O conteúdo do arquivo não corresponde ao formato permitido.', FILE_SIZE_INVALID: 'O tamanho do arquivo não corresponde ao cadastro.',
    PASSWORDS_MUST_DIFFER: 'As senhas de técnico e administrador devem ser diferentes.', PASSWORD_POLICY: 'Use uma senha diferente do exemplo, com 14 a 128 caracteres.',
    VERSION_NOT_VERIFIED_OR_UNAVAILABLE: 'Verifique o arquivo antes de aprovar a publicação.', UPLOAD_EXPIRED_OR_UNAVAILABLE: 'O envio expirou ou não está disponível.'
};
export async function readCatalogBody(request: IncomingMessage) {
    if (!request.headers['content-type']?.startsWith('application/json')) throw new CatalogError('INVALID_INPUT');
    const parsed = (request as IncomingMessage & { body?: unknown }).body;
    if (parsed !== undefined) {
        try {
            const source = typeof parsed === 'string' ? parsed : Buffer.isBuffer(parsed) ? parsed.toString('utf8') : JSON.stringify(parsed);
            if (Buffer.byteLength(source) > 16384) throw new CatalogError('PAYLOAD_TOO_LARGE', 413);
            return JSON.parse(source);
        } catch (error) { if (error instanceof CatalogError) throw error; throw new CatalogError('INVALID_INPUT'); }
    }
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of request) {
        size += chunk.length; if (size > 16384) throw new CatalogError('PAYLOAD_TOO_LARGE', 413);
        chunks.push(Buffer.from(chunk));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new CatalogError('INVALID_INPUT'); }
}
export function requireCatalogOrigin(request: IncomingMessage, origin: string) {
    if (request.headers.origin !== origin || request.headers['sec-fetch-site'] === 'cross-site') throw new CatalogError('CSRF_REJECTED', 403);
}
export function requireCatalogCsrf(request: IncomingMessage, actor: CatalogActor | null) {
    if (!actor) throw new CatalogError('ACCESS_DENIED', 403);
    const value = request.headers['x-catalog-csrf'];
    if (typeof value !== 'string' || !equalHash(digest(value), actor.csrfHash)) throw new CatalogError('CSRF_REJECTED', 403);
}
export function createCatalogHandler(getServices: () => CatalogApiServices = catalogServices) {
    return async (request: IncomingMessage, response: ServerResponse) => {
        response.setHeader('Cache-Control', 'no-store'); response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.setHeader('X-Content-Type-Options', 'nosniff'); response.setHeader('Referrer-Policy', 'no-referrer');
        const send = (status: number, data: unknown) => { response.statusCode = status; response.end(JSON.stringify(data)); };
        try {
            const services = getServices();
            const path = new URL(request.url ?? '/', services.origin).pathname;
            const match = /^\/api\/catalog(?:\/(.*))?$/.exec(path);
            if (!match) throw new CatalogError('NOT_FOUND', 404);
            const route = match[1] ?? '', method = request.method;
            if (!['GET','POST','PATCH','DELETE'].includes(method ?? '')) { response.setHeader('Allow', 'GET, POST, PATCH, DELETE'); throw new CatalogError('METHOD_NOT_ALLOWED', 405); }
            if (method !== 'GET') requireCatalogOrigin(request, services.origin);
            if (route === 'login' && method === 'POST') {
                const data = parse(loginSchema, await readCatalogBody(request));
                // Vercel overwrites x-vercel-forwarded-for. Other runtimes use the socket, never an arbitrary client header.
                const forwarded = process.env.VERCEL ? request.headers['x-vercel-forwarded-for'] : undefined;
                const source = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : request.socket.remoteAddress ?? 'unknown';
                const result = await services.auth.login(data.role, data.password, source);
                response.setHeader('Set-Cookie', [clearLegacyCookie, result.cookie]); send(200, result.session); return;
            }
            const actor = await services.auth.authenticate(request.headers.cookie);
            requireSession(actor);
            if (route === 'session' && method === 'GET') { send(200, actor ? await services.auth.refreshCsrf(actor) : null); return; }
            if (route === 'categories' && method === 'GET') { send(200, await services.catalog.categories(actor)); return; }
            if (route === 'tools' && method === 'GET') { send(200, await services.catalog.tools(actor)); return; }
            if (route === 'audit' && method === 'GET') { if (!actor) throw new CatalogError('ACCESS_DENIED', 403); send(200, await services.catalog.history(actor)); return; }
            if (method !== 'GET' && actor) requireCatalogCsrf(request, actor);
            if (method !== 'GET') {
                const budgetKey = digest('request:' + (actor?.tokenHash ?? request.socket.remoteAddress ?? 'unknown'));
                const count = await services.pool.query(`INSERT INTO catalog_login_limits(key_hash,window_start,attempts) VALUES($1,now(),1)
                    ON CONFLICT(key_hash) DO UPDATE SET attempts=CASE WHEN catalog_login_limits.window_start<now()-interval '1 minute' THEN 1 ELSE catalog_login_limits.attempts+1 END,
                    window_start=CASE WHEN catalog_login_limits.window_start<now()-interval '1 minute' THEN now() ELSE catalog_login_limits.window_start END RETURNING attempts`, [budgetKey]);
                if (count.rows[0].attempts>60) throw new CatalogError('REQUEST_RATE_LIMITED', 429);
            }
            const downloadMatch = /^versions\/([^/]+)\/download$/.exec(route);
            if (downloadMatch && method === 'POST') { send(200, await services.catalog.download(actor, id(downloadMatch[1]))); return; }
            if (!actor) throw new CatalogError('ACCESS_DENIED', 403);
            if (route === 'logout' && method === 'POST') { await services.auth.logout(actor); response.setHeader('Set-Cookie', clearCookie); send(200, { ok: true }); return; }
            if (route === 'categories' && method === 'POST') { send(201, await services.catalog.addCategory(actor, await readCatalogBody(request))); return; }
            if (route === 'tools' && method === 'POST') { send(201, await services.catalog.createTool(actor, await readCatalogBody(request))); return; }
            if (route === 'credentials' && method === 'POST') {
                const result = await services.catalog.changePassword(actor, await readCatalogBody(request));
                if (result.reloginRequired) response.setHeader('Set-Cookie', clearCookie); send(200, result); return;
            }
            if (route === 'sessions/revoke' && method === 'POST') {
                const value = await readCatalogBody(request); if (typeof value !== 'object' || !value || Object.keys(value).length !== 1) throw new CatalogError('INVALID_INPUT');
                const result = await services.catalog.revoke(actor, parse(roleSchema, value.role));
                if (result.reloginRequired) response.setHeader('Set-Cookie', clearCookie); send(200, result); return;
            }
            const toolMatch = /^tools\/([^/]+)$/.exec(route);
            const categoryMatch = /^categories\/([^/]+)$/.exec(route);
            if (categoryMatch && method === 'PATCH') { send(200, await services.catalog.editCategory(actor,id(categoryMatch[1]),await readCatalogBody(request))); return; }
            if (toolMatch && method === 'PATCH') { send(200, await services.catalog.editTool(actor, id(toolMatch[1]), await readCatalogBody(request))); return; }
            if (toolMatch && method === 'DELETE') { send(200, await services.catalog.remove(actor, id(toolMatch[1]))); return; }
            const uploadMatch = /^tools\/([^/]+)\/upload$/.exec(route);
            if (uploadMatch && method === 'POST') { send(201, await services.catalog.upload(actor, id(uploadMatch[1]), await readCatalogBody(request))); return; }
            const versionMatch = /^versions\/([^/]+)\/(finalize|publish|unpublish)$/.exec(route);
            if (versionMatch && method === 'POST') {
                const versionId = id(versionMatch[1]);
                send(200, versionMatch[2] === 'finalize' ? await services.catalog.finalize(actor, versionId) : await services.catalog.publish(actor, versionId, versionMatch[2] === 'publish')); return;
            }
            throw new CatalogError('NOT_FOUND', 404);
        } catch (error) {
            if (error instanceof CatalogError) {
                if (error.status === 401) response.setHeader('Set-Cookie', [clearLegacyCookie, clearCookie]);
                if (error.status === 429) response.setHeader('Retry-After', '300');
                send(error.status, { code: error.code, error: messages[error.code] ?? 'Operação indisponível. Confira os dados e tente novamente.' });
            } else if ((error as { code?: string })?.code === '23505') send(409, { code: 'ALREADY_EXISTS', error: 'Esse registro ou versão já existe.' });
            else if ((error as { code?: string })?.code === '23503') send(400, { code: 'INVALID_REFERENCE', error: 'A categoria ou referência informada não existe.' });
            else {
                const reasonCode = (error as { code?: string })?.code;
                const connectionTimeout = /Connection terminated due to connection timeout|timeout exceeded when trying to connect/.test(error instanceof Error ? error.message : '');
                const reason = connectionTimeout ? 'DATABASE_CONNECTION_TIMEOUT' : reasonCode && ['57014','55P03','53300','ETIMEDOUT','ECONNRESET','ECONNREFUSED'].includes(reasonCode) ? reasonCode : 'UNAVAILABLE';
                console.error(JSON.stringify({ event: 'catalog.request_failed', code: 'CATALOG_UNAVAILABLE', reason }));
                send(503, { code: 'CATALOG_UNAVAILABLE', error: 'Catálogo temporariamente indisponível.' });
            }
        }
    };
}
export const handleCatalogApi = createCatalogHandler();
