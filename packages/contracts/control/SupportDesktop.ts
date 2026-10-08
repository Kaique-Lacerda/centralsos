import { z } from 'zod';
import { commandRequestSchema, commandDefinitions, commandStatuses, profileSchema, healthSchema, resultSchema, type Device, type Environment, type RemoteCommand } from './contracts';

/** IPC contains operations, never destinations, headers or credentials. */
export const supportControlRequestSchema = z.discriminatedUnion('operation', [
    z.object({ operation: z.literal('environments') }).strict(),
    z.object({ operation: z.literal('devices') }).strict(),
    z.object({ operation: z.literal('device'), id: z.uuid() }).strict(),
    z.object({ operation: z.literal('command'), id: z.uuid() }).strict(),
    z.object({ operation: z.literal('send'), id: z.uuid(), command: commandRequestSchema }).strict(),
    z.object({ operation: z.literal('pair'), environmentId: z.uuid(), profile: profileSchema, serverDeviceId: z.uuid().nullable() }).strict(),
]);
export type SupportControlRequest = z.infer<typeof supportControlRequestSchema>;
export const supportAuthViewSchema = z.object({
    state: z.enum(['unconfigured', 'signed_out', 'starting', 'awaiting_browser', 'awaiting_identity', 'authenticated', 'login_expired', 'session_expired', 'unavailable', 'unauthorized']),
    operatorName: z.string().max(256).nullable(), expiresAt: z.string().nullable(), comparisonCode: z.string().nullable(),
    backendOrigin: z.string().nullable(), message: z.string().nullable(), intervalSeconds: z.number().int().min(5).max(60), revocationPending: z.boolean(),
}).strict();
export type SupportAuthView = z.infer<typeof supportAuthViewSchema>;
export const environmentSchema: z.ZodType<Environment> = z.object({ id: z.uuid(), companyId: z.uuid(), name: z.string() }).strict();
export const deviceSchema: z.ZodType<Device> = z.object({
    id: z.uuid(), environmentId: z.uuid(), companyId: z.uuid(), displayName: z.string(), hostname: z.string(), profile: profileSchema,
    serverDeviceId: z.uuid().nullable(), appVersion: z.string(), agentVersion: z.string(), coreVersion: z.string(), protocolVersion: z.number().int(),
    osVersion: z.string().nullable(), architecture: z.string(), localIp: z.string().nullable(), lastSeenAt: z.string().nullable(),
    status: z.enum(['ONLINE', 'DEGRADED', 'OFFLINE', 'NEVER_CONNECTED']), healthSummary: healthSchema.nullable(),
}).strict();
export const remoteCommandSchema: z.ZodType<RemoteCommand> = z.object({
    id: z.uuid(), deviceId: z.uuid(), type: z.enum(Object.keys(commandDefinitions) as [keyof typeof commandDefinitions, ...Array<keyof typeof commandDefinitions>]),
    protocolVersion: z.number().int(), payload: z.record(z.string(), z.unknown()), confirmed: z.boolean(), requestedBy: z.string(),
    createdAt: z.string(), expiresAt: z.string(), status: z.enum(commandStatuses), startedAt: z.string().nullable(), finishedAt: z.string().nullable(),
}).strict();
export function parseSupportControlResponse(request: SupportControlRequest, value: unknown): unknown {
    switch (request.operation) {
        case 'environments': return z.array(environmentSchema).parse(value);
        case 'devices': return z.array(deviceSchema).parse(value);
        // Audit rows also contain backend-only deviceId/parameters; expose only ControlPage's existing projection.
        case 'device': return z.object({ device: deviceSchema, history: z.array(z.object({ id: z.uuid(), timestamp: z.string(), actorId: z.string(), action: z.string(), outcome: z.string(), commandId: z.uuid().nullable(), durationMs: z.number().nullable() })) }).strict().parse(value);
        case 'send': return remoteCommandSchema.parse(value);
        case 'command': return z.object({ command: remoteCommandSchema, result: resultSchema.nullable() }).strict().parse(value);
        case 'pair': return z.object({ code: z.string().regex(/^SOS-[A-Z2-9]{4}-[A-Z2-9]{4}$/), expiresAt: z.string() }).strict().parse(value);
    }
}
