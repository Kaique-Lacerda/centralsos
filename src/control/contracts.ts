import { z } from 'zod';
import { commandDefinitions, PROTOCOL_VERSION } from './CommandPolicy.js';
export { commandDefinitions, PROTOCOL_VERSION };
export const profileSchema = z.enum(['TERMINAL', 'SERVER']);
export type DeviceProfile = z.infer<typeof profileSchema>;
export const healthSchema = z.enum(['ok', 'warnings', 'critical']);
export type HealthSummary = z.infer<typeof healthSchema>;
export type CommandPolicy = 'SAFE' | 'CONFIRMATION_REQUIRED' | 'LOCAL_ONLY';
export const commandStatuses = ['PENDING', 'RECEIVED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'REJECTED', 'EXPIRED'] as const;
export type CommandStatus = typeof commandStatuses[number];
export type { CommandType } from './CommandPolicy.js';
import type { CommandType } from './CommandPolicy.js';
export const commandPolicies = Object.fromEntries(Object.entries(commandDefinitions).map(([type, policy]) => [type, policy.requiresConfirmation ? 'CONFIRMATION_REQUIRED' : 'SAFE'])) as Record<CommandType, CommandPolicy>;
const empty = z.object({}).strict();
const printerName = z.string().trim().min(1).max(220).refine(v => !/[\x00-\x1f]/.test(v), 'Nome de impressora inválido');
export const commandRequestSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('machine.refresh'), payload: empty, confirmed: z.boolean().default(false) }).strict(),
    z.object({ type: z.literal('machine.validate'), payload: empty, confirmed: z.boolean().default(false) }).strict(),
    z.object({ type: z.literal('printer.check'), payload: z.object({ printerName: printerName.optional() }).strict(), confirmed: z.boolean().default(false) }).strict(),
    z.object({ type: z.literal('printer.auto_fix'), payload: z.object({ printerName }).strict(), confirmed: z.boolean() }).strict(),
    z.object({ type: z.literal('spooler.restart'), payload: empty, confirmed: z.boolean() }).strict(),
    z.object({ type: z.literal('service.check'), payload: z.object({ name: z.string().regex(/^[a-zA-Z0-9_. -]{1,256}$/).optional() }).strict(), confirmed: z.boolean().default(false) }).strict()
]);
export type CommandRequest = z.infer<typeof commandRequestSchema>;
const version = z.string().regex(/^\d+\.\d+\.\d+$/);
const protocol = z.number().int().min(1).max(65535);
export const enrollmentSchema = z.object({ pairingCode: z.string().regex(/^SOS-[A-Z2-9]{4}-[A-Z2-9]{4}$/), fingerprint: z.string().regex(/^[a-f0-9]{64}$/), hostname: z.string().trim().min(1).max(253), profile: profileSchema, appVersion: version, agentVersion: version, coreVersion: version, protocolVersion: protocol, osVersion: z.string().max(512).nullable(), architecture: z.string().max(32) }).strict();
export const heartbeatSchema = z.object({ deviceId: z.uuid(), timestamp: z.iso.datetime({ offset: true }), hostname: z.string().min(1).max(253), profile: profileSchema, appVersion: version, agentVersion: version, coreVersion: version, protocolVersion: protocol, osVersion: z.string().max(512).nullable(), uptime: z.number().int().nonnegative(), localIp: z.string().max(64).nullable(), healthSummary: healthSchema.nullable() }).strict();
export type DeviceHeartbeat = z.infer<typeof heartbeatSchema>;
export interface Company {
    id: string;
    name: string;
}
export interface Environment {
    id: string;
    companyId: string;
    name: string;
}
export interface Device {
    id: string;
    environmentId: string;
    companyId: string;
    displayName: string;
    hostname: string;
    profile: DeviceProfile;
    serverDeviceId: string | null;
    appVersion: string;
    agentVersion: string;
    coreVersion: string;
    protocolVersion: number;
    osVersion: string | null;
    architecture: string;
    localIp: string | null;
    lastSeenAt: string | null;
    status: 'ONLINE' | 'DEGRADED' | 'OFFLINE' | 'NEVER_CONNECTED';
    healthSummary: HealthSummary | null;
}
export interface RemoteCommand {
    id: string;
    deviceId: string;
    type: CommandType;
    protocolVersion: number;
    payload: Record<string, unknown>;
    confirmed: boolean;
    requestedBy: string;
    createdAt: string;
    expiresAt: string;
    status: CommandStatus;
    startedAt: string | null;
    finishedAt: string | null;
}
export const resultSchema = z.object({ commandId: z.uuid(), protocolVersion: protocol, success: z.boolean(), status: z.enum(['SUCCEEDED', 'FAILED', 'REJECTED', 'EXPIRED']), summary: z.string().max(2000), details: z.unknown(), startedAt: z.iso.datetime({ offset: true }), finishedAt: z.iso.datetime({ offset: true }) }).strict().refine(v => v.success === (v.status === 'SUCCEEDED'), 'Resultado e estado incompatíveis').refine(v => Date.parse(v.finishedAt) >= Date.parse(v.startedAt), 'Intervalo inválido');
export type RemoteCommandResult = z.infer<typeof resultSchema>;
export function isOnline(lastSeenAt: string | null, now: number, windowMs = 90000): boolean { const at = lastSeenAt ? Date.parse(lastSeenAt) : NaN; return Number.isFinite(at) && at <= now + 5000 && now - at <= windowMs; }
export function canTransition(from: CommandStatus, to: CommandStatus): boolean {
    if (from === to)
        return true;
    return ({ PENDING: ['RECEIVED', 'EXPIRED', 'REJECTED'], RECEIVED: ['RUNNING', 'EXPIRED', 'REJECTED', 'FAILED'], RUNNING: ['SUCCEEDED', 'FAILED', 'REJECTED'], SUCCEEDED: [], FAILED: [], REJECTED: [], EXPIRED: [] } as Record<CommandStatus, CommandStatus[]>)[from].includes(to);
}
export function backoff(attempt: number, random = .5): number { return Math.min(60000, Math.min(60000, 5000 * 2 ** Math.min(Math.max(attempt, 0), 4)) * (.8 + .4 * Math.max(0, Math.min(1, random)))); }
export function deviceStatus(d: Pick<Device, 'lastSeenAt' | 'protocolVersion' | 'healthSummary'>, now: number, windowMs = 90000): Device['status'] {
    if (!d.lastSeenAt) return 'NEVER_CONNECTED';
    if (!isOnline(d.lastSeenAt, now, windowMs)) return 'OFFLINE';
    return d.protocolVersion !== PROTOCOL_VERSION || d.healthSummary !== 'ok' ? 'DEGRADED' : 'ONLINE';
}
export function buildTopology(devices: Device[]) { return { servers: devices.filter(d => d.profile === 'SERVER').map(server => ({ server, terminals: devices.filter(d => d.profile === 'TERMINAL' && d.serverDeviceId === server.id && d.environmentId === server.environmentId && d.companyId === server.companyId) })), unassigned: devices.filter(d => d.profile === 'TERMINAL' && !d.serverDeviceId) }; }
