import type { IncomingMessage, ServerResponse } from 'node:http';
import { NATIVE_CLIENT_HEADER } from '../../packages/contracts/control/NativeAuthentication.js';
import { cookieValue } from './Authentication.js';
import { NativeAuthentication, NativeAuthError } from './NativeAuthentication.js';

const prefix = '/api/control/auth/native';
function fail(code: ConstructorParameters<typeof NativeAuthError>[0], status: number, message: string): never { throw new NativeAuthError(code,status,message); }
export function requireNativeContext(req: IncomingMessage): string {
    if (req.headers.cookie || req.headers.origin || req.headers['x-central-sos-client'] !== NATIVE_CLIENT_HEADER) fail('NATIVE_CONTEXT_REQUIRED',403,'Esta requisição exige o transporte nativo, sem cookies ou Origin.');
    const header = req.headers.authorization;
    if (!header) return '';
    const token = /^Bearer (sos_operator_[A-Za-z0-9_-]{43})$/.exec(header)?.[1];
    if (!token) fail('SESSION_INVALID',401,'Credencial de operador inválida.');
    return token;
}
export function requireBrowserOrigin(req: IncomingMessage, origin: string) {
    if (req.headers.origin !== origin || req.headers.authorization) fail('CSRF_REJECTED',403,'Origem não autorizada.');
}
function escape(value: string) { return value.replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]!)); }
function html(res: ServerResponse, content: string) {
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy',"default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    res.end(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Autorizar CENTRAL SOS Suporte</title><main>${content}</main></html>`);
}
// __Host- prevents sibling domains from planting/overriding authentication cookies.
function cookie(name: string, value: string, seconds=300) { return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${seconds}`; }
async function body(req: IncomingMessage) {
    let raw = '', parsed = (req as IncomingMessage & {body?:unknown}).body;
    if (parsed === undefined) {
        for await (const chunk of req) { raw += chunk.toString(); if (Buffer.byteLength(raw)>16384) fail('INVALID_REQUEST',413,'Payload de autenticação excedeu o limite.'); }
    } else raw = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
    if (Buffer.byteLength(raw)>16384) fail('INVALID_REQUEST',413,'Payload de autenticação excedeu o limite.');
    const type = req.headers['content-type']?.split(';')[0];
    if (type === 'application/x-www-form-urlencoded') {
        const params = new URLSearchParams(raw);
        if ([...params.keys()].some(key=>params.getAll(key).length!==1)) fail('INVALID_REQUEST',400,'Formulário inválido.');
        if (parsed && typeof parsed === 'object') return parsed;
        return Object.fromEntries(params);
    }
    if (type !== 'application/json') fail('INVALID_REQUEST',415,'Content-Type de autenticação inválido.');
    try { return JSON.parse(raw); } catch { return fail('INVALID_REQUEST',400,'JSON de autenticação inválido.'); }
}
/** HTTPS is checked at a trusted ingress, never inferred from an arbitrary Host. */
export function requireNativeHttps(req: IncomingMessage) {
    const tls = (req.socket as typeof req.socket & {encrypted?:boolean})?.encrypted === true;
    const vercelTls = process.env.VERCEL === '1' && req.headers['x-forwarded-proto'] === 'https';
    if (!tls && !vercelTls) fail('NATIVE_CONTEXT_REQUIRED',403,'Autenticação nativa exige HTTPS no ingresso.');
}
export async function handleNativeAuth(req: IncomingMessage, res: ServerResponse, auth: NativeAuthentication, peer: string): Promise<boolean> {
    const url = new URL(req.url ?? '/',auth.origin);
    if (!url.pathname.startsWith(prefix+'/')) return false;
    requireNativeHttps(req);
    res.setHeader('Referrer-Policy','no-referrer');
    await auth.limit(peer,url.pathname===prefix+'/start'?'start':'native-route',url.pathname===prefix+'/start'?5:90);
    const action = url.pathname.slice(prefix.length+1), method = req.method;
    if (['start','status','complete','session','logout'].includes(action)) {
        const token = requireNativeContext(req);
        if (url.search) fail('INVALID_REQUEST',400,'Parâmetros de autenticação não são aceitos na URL.');
        let result: unknown;
        if (action==='start' && method==='POST') {
            if (token) fail('INVALID_REQUEST',400,'Inicie o login sem credencial existente.');
            result = await auth.start(await body(req));
        } else if (['status','complete'].includes(action) && method==='POST') {
            if (token) fail('INVALID_REQUEST',400,'Transação não aceita credencial de sessão.');
            const input = await body(req);
            result = action==='status' ? await auth.status(input) : await auth.complete(input);
        } else if (action==='session' && method==='GET') result = (await auth.authenticate(token)).session;
        else if (action==='logout' && method==='POST') result = await auth.logout(token);
        else fail('INVALID_REQUEST',405,'Método não permitido.');
        res.end(JSON.stringify(result)); return true;
    }
    if (req.headers.authorization) fail('NATIVE_CONTEXT_REQUIRED',403,'Abra a autorização no navegador externo.');
    if (action==='authorize' && method==='GET') {
        if ([...url.searchParams.keys()].some(key=>key!=='user_code') || url.searchParams.getAll('user_code').length!==1) fail('INVALID_REQUEST',400,'URL de autorização inválida.');
        const login = await auth.authorize(url.searchParams.get('user_code')??'');
        res.setHeader('Set-Cookie',cookie('__Host-sos-native-oidc',login.browser));
        res.writeHead(302,{Location:login.url}); res.end(); return true;
    }
    if (action==='callback' && method==='GET') {
        if (url.searchParams.getAll('state').length!==1 || url.searchParams.getAll('code').length!==1) fail('INVALID_REQUEST',400,'Retorno de login inválido.');
        const grant = await auth.callback(url.searchParams.get('state')??'',url.searchParams.get('code')??'',cookieValue(req.headers.cookie,'__Host-sos-native-oidc')??'');
        res.setHeader('Set-Cookie',[cookie('__Host-sos-native-browser',grant.browser),cookie('__Host-sos-native-oidc','',0)]);
        res.writeHead(303,{Location:prefix+'/confirm?id='+grant.transactionId}); res.end(); return true;
    }
    if (action==='confirm' && method==='GET') {
        if (url.searchParams.getAll('id').length!==1 || [...url.searchParams.keys()].some(key=>key!=='id')) fail('INVALID_REQUEST',400,'Confirmação inválida.');
        const confirmation = await auth.confirmation(url.searchParams.get('id')??'',cookieValue(req.headers.cookie,'__Host-sos-native-browser')??'');
        html(res,`<h1>Autorizar CENTRAL SOS Suporte</h1><p>Operador: <strong>${escape(confirmation.name)}</strong></p><p>Confira este código no aplicativo que você abriu: <strong>${confirmation.userCode}</strong></p><p>Não autorize solicitações recebidas por terceiros. A autorização permite operações do Control conforme seus vínculos atuais.</p><form method="post" action="${prefix}/confirm"><input type="hidden" name="transactionId" value="${confirmation.transactionId}"><input type="hidden" name="csrfToken" value="${confirmation.csrf}"><input type="hidden" name="userCode" value="${confirmation.userCode}"><label><input type="checkbox" name="confirmed" value="on" required>Solicitei este login e conferi o código no CENTRAL SOS Suporte.</label><p><button type="submit">Autorizar sessão</button></p></form>`); return true;
    }
    if (action==='confirm' && method==='POST') {
        requireBrowserOrigin(req,auth.origin);
        const input = await body(req) as Record<string,unknown>;
        await auth.confirm({...input,confirmed:input?.confirmed===true || input?.confirmed==='on'},cookieValue(req.headers.cookie,'__Host-sos-native-browser')??'');
        res.setHeader('Set-Cookie',cookie('__Host-sos-native-browser','',0));
        html(res,'<h1>Autorização confirmada</h1><p>Volte ao CENTRAL SOS Suporte para concluir o login. Esta página não recebeu credenciais do Desktop.</p>'); return true;
    }
    fail('INVALID_REQUEST',404,'Endpoint de autenticação não encontrado.');
}
