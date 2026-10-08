import { z } from 'zod';

export const NATIVE_CLIENT_HEADER = 'support-native-v1';
export const nativeProofSchema = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/);
export const nativeStartSchema = z.object({ protocolVersion: z.literal(1), codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), codeChallengeMethod: z.literal('S256') }).strict();
export const nativePollSchema = z.object({ transactionId: z.uuid(), deviceCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/), codeVerifier: nativeProofSchema }).strict();
export const nativeCompleteSchema = nativePollSchema.extend({ expectedSubject: z.string().min(1).max(256) }).strict();
export const nativeConfirmSchema = z.object({ transactionId: z.uuid(), csrfToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/), userCode: z.string().regex(/^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/), confirmed: z.literal(true) }).strict();
export type NativeStartRequest = z.infer<typeof nativeStartSchema>;
export type NativePollRequest = z.infer<typeof nativePollSchema>;
export type NativeCompleteRequest = z.infer<typeof nativeCompleteSchema>;
export type NativeConfirmRequest = z.infer<typeof nativeConfirmSchema>;
export interface NativeAuthorizationStart { protocolVersion: 1; transactionId: string; deviceCode: string; userCode: string; authorizationUrl: string; expiresAt: string; intervalSeconds: number }
export type NativeAuthorizationStatus = { state: 'pending'; intervalSeconds: number } | { state: 'approved'; operator: { subject: string; name: string }; intervalSeconds: number };
export interface NativeSession { subject: string; name: string; memberships: { companyId: string; role: 'viewer' | 'operator' | 'admin' }[]; expiresAt: string; scope: 'control' }
/** Returned to the future Rust host only, never persisted by React or placed in a URL. */
export interface NativeSessionCredential { accessToken: string; tokenType: 'Bearer'; expiresAt: string; scope: 'control' }
export type ControlTransport = <T>(path: string, body?: unknown) => Promise<T>;
export interface NativeHttpRequest {
    url: string; method: 'GET' | 'POST'; headers: Record<string, string>; body?: string;
    authentication: 'operator'; timeoutMs: number; maxResponseBytes: number; followRedirects: false;
}
export interface NativeHttpResponse { status: number; url: string; redirected: boolean; body: string }
/** Rust injects the credential and enforces origin/path/response limits independently. */
export type NativeHttpAdapter = (request: NativeHttpRequest) => Promise<NativeHttpResponse>;
export type NativeAuthErrorCode = 'INVALID_REQUEST' | 'INVALID_TRANSACTION' | 'TRANSACTION_EXPIRED' | 'TRANSACTION_CONSUMED' | 'PROOF_INVALID' | 'CONFIRMATION_REQUIRED' | 'IDENTITY_MISMATCH' | 'OPERATOR_DISABLED' | 'MEMBERSHIP_REQUIRED' | 'SESSION_INVALID' | 'SESSION_EXPIRED' | 'SESSION_REVOKED' | 'CSRF_REJECTED' | 'NATIVE_CONTEXT_REQUIRED' | 'RATE_LIMITED' | 'BACKEND_UNAVAILABLE';
export interface NativeAuthErrorResponse { code: NativeAuthErrorCode; error: string }
/** Reject non-canonical and path-bearing origins before constructing any native request. */
export function validateControlOrigin(value: string): string {
    let url: URL;
    try { url = new URL(value); }
    catch { throw new Error('A origem do Control deve ser uma origem HTTPS válida.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || value !== url.origin && value !== url.origin + '/') throw new Error('A origem do Control deve ser HTTPS, sem credenciais, caminho, query ou fragment.');
    return url.origin;
}
