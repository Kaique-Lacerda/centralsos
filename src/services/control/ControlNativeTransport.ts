import { validateControlOrigin, NATIVE_CLIENT_HEADER, type ControlTransport, type NativeHttpAdapter, type NativeHttpResponse } from '../../../packages/contracts/control/NativeAuthentication';
export type { NativeHttpRequest, NativeHttpResponse, NativeHttpAdapter } from '../../../packages/contracts/control/NativeAuthentication';
export class ControlTransportError extends Error {
    constructor(public code: string, public status: number) { super(code==='SESSION_EXPIRED'?'Sessão expirada. Entre novamente.':`Requisição do Control recusada (${status}, ${code}).`); }
}
export function createControlNativeTransport(originValue: string, adapter: NativeHttpAdapter): ControlTransport {
    const origin = validateControlOrigin(originValue), timeoutMs=12000,maxResponseBytes=2_000_000;
    return async <T>(path: string, data?: unknown): Promise<T> => {
        // Login/proof and credential redemption belong entirely to the future Rust host.
        if (!/^\/(?:session|environments|devices(?:\/[a-f0-9-]{36}(?:\/commands)?)?|commands\/[a-f0-9-]{36}|pairing|auth\/native\/(?:session|logout))$/.test(path)) throw new ControlTransportError('INVALID_PATH',400);
        const url = origin+'/api/control'+path;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let response: NativeHttpResponse;
        try {
            response = await Promise.race([adapter({url,method:data===undefined?'GET':'POST',headers:{'X-Central-Sos-Client':NATIVE_CLIENT_HEADER,Accept:'application/json',...(data===undefined?{}:{'Content-Type':'application/json'})},body:data===undefined?undefined:JSON.stringify(data),authentication:'operator',timeoutMs,maxResponseBytes,followRedirects:false}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new ControlTransportError('TIMEOUT',0)),timeoutMs);})]);
        } catch (cause) { if (cause instanceof ControlTransportError) throw cause; throw new ControlTransportError('CONNECTION_FAILED',0); }
        finally { if (timer) clearTimeout(timer); }
        if (response.redirected || response.url!==url || response.status>=300 && response.status<400) throw new ControlTransportError('REDIRECT_REJECTED',response.status);
        if (new TextEncoder().encode(response.body).byteLength>maxResponseBytes) throw new ControlTransportError('RESPONSE_TOO_LARGE',response.status);
        let value: unknown;
        try { value=JSON.parse(response.body); } catch { throw new ControlTransportError('INVALID_RESPONSE',response.status); }
        if (response.status<200 || response.status>=300) {
            const allowed=['SESSION_INVALID','SESSION_EXPIRED','SESSION_REVOKED','OPERATOR_DISABLED','MEMBERSHIP_REQUIRED','RATE_LIMITED','INVALID_REQUEST','INVALID_TRANSACTION','TRANSACTION_EXPIRED','TRANSACTION_CONSUMED','PROOF_INVALID','CONFIRMATION_REQUIRED','IDENTITY_MISMATCH','BACKEND_UNAVAILABLE'];
            const code=typeof value==='object' && value!==null && 'code' in value && typeof value.code==='string' && allowed.includes(value.code)?value.code:response.status===401?'SESSION_INVALID':response.status===403?'FORBIDDEN':response.status===429?'RATE_LIMITED':'HTTP_ERROR';
            throw new ControlTransportError(code,response.status);
        }
        return value as T;
    };
}
