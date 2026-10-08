import { invoke, isTauri } from '@tauri-apps/api/core';
import { validateControlOrigin, type NativeHttpAdapter } from '../../../packages/contracts/control/NativeAuthentication';
import { supportAuthViewSchema, supportControlRequestSchema, parseSupportControlResponse, type SupportAuthView } from '../../../packages/contracts/control/SupportDesktop';
import { createControlNativeTransport, ControlTransportError } from './ControlNativeTransport';
import { createControlApi } from './ControlService';

export const isSupportDesktop = () => isTauri();
export type SupportInvoker = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
const safeCodes = new Set(['SESSION_EXPIRED', 'SESSION_CHANGED', 'UNAUTHORIZED', 'RATE_LIMITED', 'BACKEND_UNAVAILABLE', 'BACKEND_NOT_CONFIGURED', 'CONNECTION_FAILED', 'TIMEOUT', 'AUTH_BUSY', 'INVALID_REQUEST', 'INVALID_RESPONSE', 'CONFIRMATION_REQUIRED', 'INVALID_TRANSACTION', 'REDIRECT_REJECTED', 'RESPONSE_TOO_LARGE', 'IDENTITY_MISMATCH', 'BROWSER_UNAVAILABLE', 'REQUEST_REJECTED', 'COMMAND_BLOCKED']);
function failure(value: unknown): ControlTransportError {
    const v = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    return new ControlTransportError(typeof v.code === 'string' && safeCodes.has(v.code) ? v.code : 'HOST_UNAVAILABLE', typeof v.status === 'number' ? v.status : 0);
}
export function createSupportAuth(call: SupportInvoker = invoke) {
    const action = async (command: string, args?: Record<string, unknown>): Promise<SupportAuthView> => {
        try { return supportAuthViewSchema.parse(await call(command, args)); } catch (e) { throw failure(e); }
    };
    return {
        status: () => action('support_status'), start: () => action('support_login_start'), poll: () => action('support_login_poll'),
        complete: () => action('support_login_complete', { confirmed: true }), session: () => action('support_session'), logout: () => action('support_logout'),
    };
}
export function createSupportDesktopApi(originValue: string, call: SupportInvoker = invoke) {
    const origin = validateControlOrigin(originValue);
    const adapter: NativeHttpAdapter = async wire => {
        const url = new URL(wire.url);
        if (url.origin !== origin || url.search || url.hash || url.username || url.password || !url.pathname.startsWith('/api/control/')) throw new ControlTransportError('INVALID_PATH', 400);
        const path = url.pathname.slice('/api/control'.length);
        let data: unknown;
        try { data = wire.body === undefined ? undefined : JSON.parse(wire.body); } catch { throw new ControlTransportError('INVALID_REQUEST', 400); }
        const get = wire.method === 'GET' && data === undefined;
        let request: unknown;
        const parts = path.split('/');
        if (path === '/environments' && get) request = { operation: 'environments' };
        else if (path === '/devices' && get) request = { operation: 'devices' };
        else if (parts.length === 3 && parts[1] === 'devices' && get) request = { operation: 'device', id: parts[2] };
        else if (parts.length === 3 && parts[1] === 'commands' && get) request = { operation: 'command', id: parts[2] };
        else if (parts.length === 4 && parts[1] === 'devices' && parts[3] === 'commands' && wire.method === 'POST') request = { operation: 'send', id: parts[2], command: data };
        else if (path === '/pairing' && wire.method === 'POST' && data && typeof data === 'object') request = { ...data, operation: 'pair' };
        else throw new ControlTransportError('INVALID_PATH', 400);
        try {
            const typed = supportControlRequestSchema.parse(request);
            const response = parseSupportControlResponse(typed, await call('support_control', { request: typed }));
            return { status: 200, url: wire.url, redirected: false, body: JSON.stringify(response) };
        } catch (e) { throw failure(e); }
    };
    return createControlApi(createControlNativeTransport(origin, adapter));
}
