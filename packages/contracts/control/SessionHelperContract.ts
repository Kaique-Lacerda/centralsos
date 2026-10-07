import { z } from 'zod';

export const SESSION_HELPER_TRANSPORT = 'AUTHENTICATED_LOCAL_NAMED_PIPE' as const;
export const SESSION_PROTOCOL_VERSION = 1;
export const SESSION_MAX_MESSAGE_BYTES = 262144;
export const SESSION_MAX_VALIDITY_MS = 30000;
export const sessionOperations = ['session.info', 'session.processes', 'session.printers'] as const;
export const sessionErrorCodes = [
    'SESSION_REQUIRED', 'SESSION_LOCKED', 'SESSION_DISCONNECTED', 'SESSION_AMBIGUOUS',
    'SESSION_STATE_UNKNOWN', 'SESSION_HELPER_UNAVAILABLE', 'SESSION_PROTOCOL_MISMATCH',
    'SESSION_PEER_REJECTED', 'SESSION_INVALID_REQUEST', 'SESSION_EXPIRED',
    'SESSION_MESSAGE_TOO_LARGE', 'SESSION_TIMEOUT', 'SESSION_REPLAY', 'SESSION_COLLECTION_FAILED'
] as const;
const identity = z.object({ sessionId: z.number().int().min(1).max(4294967295), userSid: z.string().regex(/^S-1-[0-9-]+$/).max(184), logonSid: z.string().regex(/^S-1-5-5-[0-9-]+$/).max(184) }).strict();
const empty = z.object({}).strict();
const header = { requestId: z.uuid(), protocolVersion: z.number().int().min(1).max(65535), timestamp: z.number().int().safe(), expiresAt: z.number().int().safe(), nonce: z.uuid(), session: identity };
export const sessionHelperRequestSchema = z.discriminatedUnion('operation', [
    z.object({ ...header, operation: z.literal('session.info'), payload: empty }).strict(),
    z.object({ ...header, operation: z.literal('session.processes'), payload: empty }).strict(),
    z.object({ ...header, operation: z.literal('session.printers'), payload: empty }).strict()
]);
const data = z.discriminatedUnion('operation', [
    z.object({ operation: z.literal('session.info'), data: z.object({ session: identity, username: z.string(), domain: z.string(), state: z.literal('active') }).strict() }).strict(),
    z.object({ operation: z.literal('session.processes'), data: z.object({ items: z.array(z.object({ pid: z.number().int().nonnegative().max(4294967295), name: z.string() }).strict()).max(512), truncated: z.boolean(), incomplete: z.boolean() }).strict() }).strict(),
    z.object({ operation: z.literal('session.printers'), data: z.object({ items: z.array(z.object({ name: z.string(), server: z.string().nullable(), isDefault: z.boolean().nullable() }).strict()).max(128), truncated: z.boolean(), incomplete: z.boolean() }).strict() }).strict()
]);
export const sessionHelperResponseSchema = z.object({ requestId: z.uuid(), protocolVersion: z.number().int().min(1).max(65535), timestamp: z.number().int().safe(), nonce: z.uuid(), session: identity,
    outcome: z.discriminatedUnion('status', [
        z.object({ status: z.literal('completed'), result: data }).strict(),
        z.object({ status: z.literal('rejected'), error: z.object({ code: z.enum(sessionErrorCodes), message: z.string() }).strict() }).strict()
    ])
}).strict();
export type SessionHelperRequest = z.infer<typeof sessionHelperRequestSchema>;
export type SessionHelperResponse = z.infer<typeof sessionHelperResponseSchema>;
export type SessionErrorCode = typeof sessionErrorCodes[number];
export class SessionContractError extends Error {
    constructor(public readonly code: SessionErrorCode) { super(code); }
}
/** Reference validation for fixtures/Control; Windows token authentication remains native. */
export function decodeSessionRequest(json: string, now: number): SessionHelperRequest {
    if (new TextEncoder().encode(json).length > SESSION_MAX_MESSAGE_BYTES) throw new SessionContractError('SESSION_MESSAGE_TOO_LARGE');
    let value: unknown;
    try { value = JSON.parse(json); } catch { throw new SessionContractError('SESSION_INVALID_REQUEST'); }
    const parsed = sessionHelperRequestSchema.safeParse(value);
    if (!parsed.success) throw new SessionContractError('SESSION_INVALID_REQUEST');
    const request = parsed.data;
    if (request.protocolVersion !== SESSION_PROTOCOL_VERSION) throw new SessionContractError('SESSION_PROTOCOL_MISMATCH');
    if (request.expiresAt <= now) throw new SessionContractError('SESSION_EXPIRED');
    if (request.timestamp > now + 2000 || request.expiresAt <= request.timestamp || request.expiresAt - request.timestamp > SESSION_MAX_VALIDITY_MS) throw new SessionContractError('SESSION_INVALID_REQUEST');
    return request;
}
/** Reserved contract only; deliberately absent from schemas, registry and executor. */
export interface FutureApplicationRestart { operation: 'application.restart'; payload: { product: 'TROIA' } }
