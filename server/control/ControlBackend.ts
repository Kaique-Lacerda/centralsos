import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { commandDefinitions, PROTOCOL_VERSION, commandRequestSchema, enrollmentSchema, heartbeatSchema, resultSchema, canTransition, isOnline, deviceStatus } from '../../src/control/contracts.js';
import type { CommandStatus, Device, RemoteCommand } from '../../src/control/contracts.js';
import type { Actor, ControlState, Repository } from './Repository.js';
export class ApiError extends Error {
    constructor(public status: number, message: string) { super(message); }
}
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export class ControlBackend {
    constructor(readonly repository: Repository, readonly now = () => Date.now(), readonly offlineMs = 90000) { }
    private audit(s: ControlState, actorId: string, action: string, deviceId: string | null, commandId: string | null, parameters: unknown, outcome: string, durationMs: number | null = null) { s.audit.push({ id: randomUUID(), actorId, action, deviceId, commandId, parameters, outcome, durationMs, timestamp: new Date(this.now()).toISOString() }); }
    private authorize(s: ControlState, actor: Actor, environmentId: string, write = false, admin = false) {
        const env = s.environments.find(e => e.id === environmentId);
        const membership = actor.memberships.find(m => m.companyId === env?.companyId);
        if (!env || !membership || write && membership.role === 'viewer' || admin && membership.role !== 'admin')
            throw new ApiError(403, 'Acesso não autorizado a este ambiente.');
    }
    private device(s: ControlState, actor: Actor, id: string, write = false) { const d = s.devices.find(d => d.id === id && !d.revokedAt); if (!d)
        throw new ApiError(404, 'Dispositivo não encontrado.'); this.authorize(s, actor, d.environmentId, write); if (!s.environments.some(e => e.id === d.environmentId && e.companyId === d.companyId)) throw new ApiError(403, 'Vínculo Company/Environment/Device inválido.'); return d; }
    private publicDevice(d: ControlState['devices'][number]): Device { const { credentialHash: _credential, fingerprint: _fingerprint, revokedAt: _revoked, ...publicData } = d; return { ...publicData, status: deviceStatus(d, this.now(), this.offlineMs) }; }
    agentDevice(s: ControlState, credential: string) { if (credential.length < 40 || credential.length > 100)
        throw new ApiError(401, 'Credencial inválida.'); const hash = digest(credential); const d = s.devices.find(d => !d.revokedAt && safeEqual(d.credentialHash, hash)); if (!d)
        throw new ApiError(401, 'Dispositivo não autorizado.');
        if (!s.environments.some(e => e.id === d.environmentId && e.companyId === d.companyId)) throw new ApiError(403, 'Vínculo Company/Environment/Device inválido.'); return d; }
    async pair(actor: Actor, environmentId: string, profile: 'SERVER' | 'TERMINAL', serverDeviceId: string | null) {
        return this.repository.transaction(s => {
            this.authorize(s, actor, environmentId, true, true);
            if (serverDeviceId && (profile !== 'TERMINAL' || !s.devices.some(d => d.id === serverDeviceId && d.profile === 'SERVER' && d.environmentId === environmentId && s.environments.some(e => e.id === environmentId && e.companyId === d.companyId) && !d.revokedAt)))
                throw new ApiError(400, 'Servidor precisa pertencer ao mesmo ambiente.');
            const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
            const bytes = randomBytes(8);
            const code = 'SOS-' + [...bytes].map((b, i) => (i === 4 ? '-' : '') + alphabet[b % alphabet.length]).join('');
            const expiresAt = new Date(this.now() + 10 * 60000).toISOString();
            s.pairing.push({ hash: digest(code), environmentId, companyId: s.environments.find(e => e.id === environmentId)!.companyId, profile, serverDeviceId, expiresAt, usedAt: null, createdBy: actor.id });
            this.audit(s, actor.id, 'device.pairing_code', null, null, { environmentId, profile, serverDeviceId }, 'CREATED');
            return { code, expiresAt };
        });
    }
    async enroll(input: unknown) {
        const v = enrollmentSchema.parse(input);
        if (v.protocolVersion !== PROTOCOL_VERSION) throw new ApiError(409, 'Protocolo incompatível; atualize Desktop/Agent.');
        return this.repository.transaction(s => {
            const pair = s.pairing.find(p => safeEqual(p.hash, digest(v.pairingCode)));
            if (!pair || pair.usedAt || Date.parse(pair.expiresAt) <= this.now())
                throw new ApiError(400, 'Código inválido, expirado ou já utilizado.');
            if (!s.environments.some(e => e.id === pair.environmentId && e.companyId === pair.companyId)) throw new ApiError(403, 'Empresa do pareamento foi alterada.');
            if (pair.profile !== v.profile)
                throw new ApiError(400, 'Perfil não corresponde ao pareamento.');
            if (s.devices.some(d => d.fingerprint === v.fingerprint && !d.revokedAt))
                throw new ApiError(409, 'Dispositivo já vinculado.');
            if (pair.serverDeviceId && !s.devices.some(d => d.id === pair.serverDeviceId && d.environmentId === pair.environmentId && d.companyId === pair.companyId && d.profile === 'SERVER' && !d.revokedAt))
                throw new ApiError(409, 'Servidor do pareamento não está disponível.');
            const credential = randomBytes(32).toString('base64url');
            const id = randomUUID();
            pair.usedAt = new Date(this.now()).toISOString();
            s.devices.push({ id, companyId: pair.companyId, environmentId: pair.environmentId, displayName: v.hostname, hostname: v.hostname, profile: v.profile, serverDeviceId: pair.serverDeviceId, appVersion: v.appVersion, agentVersion: v.agentVersion, coreVersion: v.coreVersion, protocolVersion: v.protocolVersion, osVersion: v.osVersion, architecture: v.architecture, localIp: null, lastSeenAt: null, status: 'NEVER_CONNECTED', healthSummary: null, revokedAt: null, credentialHash: digest(credential), fingerprint: v.fingerprint });
            this.audit(s, pair.createdBy, 'device.enroll', id, null, { hostname: v.hostname, profile: v.profile }, 'ENROLLED');
            return { protocolVersion: PROTOCOL_VERSION, companyId: pair.companyId, deviceId: id, credential, environmentId: pair.environmentId, environmentName: s.environments.find(e => e.id === pair.environmentId)?.name ?? '', profile: pair.profile, serverDeviceId: pair.serverDeviceId, serverName: s.devices.find(d => d.id === pair.serverDeviceId)?.displayName ?? null };
        });
    }
    async heartbeat(credential: string, input: unknown) { const v = heartbeatSchema.parse(input); return this.repository.transaction(s => { const d = this.agentDevice(s, credential); if (d.id !== v.deviceId || d.profile !== v.profile)
        throw new ApiError(403, 'Identidade/perfil não correspondem ao dispositivo.'); Object.assign(d, { hostname: v.hostname, appVersion: v.appVersion, agentVersion: v.agentVersion, coreVersion: v.coreVersion, protocolVersion: v.protocolVersion, osVersion: v.osVersion, localIp: v.localIp, healthSummary: v.healthSummary, lastSeenAt: new Date(this.now()).toISOString() }); return { accepted: true, serverTime: new Date(this.now()).toISOString() }; }); }
    async list(actor: Actor) { return this.repository.transaction(s => ({ environments: s.environments.filter(e => actor.memberships.some(m => m.companyId === e.companyId)), devices: s.devices.filter(d => !d.revokedAt && s.environments.some(e => e.id === d.environmentId && e.companyId === d.companyId && actor.memberships.some(m => m.companyId === e.companyId))).map(d => this.publicDevice(d)) })); }
    async getDevice(actor: Actor, id: string) { return this.repository.transaction(s => ({ device: this.publicDevice(this.device(s, actor, id)), history: s.audit.filter(a => a.deviceId === id).slice(-100).reverse() })); }
    async send(actor: Actor, id: string, input: unknown) {
        const v = commandRequestSchema.parse(input);
        if (commandDefinitions[v.type].requiresConfirmation && !v.confirmed)
            throw new ApiError(400, 'Confirmação explícita obrigatória.');
        return this.repository.transaction(s => {
            const d = this.device(s, actor, id, true);
            if (d.protocolVersion !== PROTOCOL_VERSION) throw new ApiError(409, 'Protocolo incompatível; comando não enviado.');
            if (!commandDefinitions[v.type].allowedDeviceProfiles.includes(d.profile)) throw new ApiError(403, 'Perfil não permitido para este comando.');
            if (!isOnline(d.lastSeenAt, this.now(), this.offlineMs))
                throw new ApiError(409, 'Agent offline; nenhuma ação foi enviada.');
            if (s.commands.filter(c => c.deviceId === id && ['PENDING', 'RECEIVED', 'RUNNING'].includes(c.status)).length >= 20)
                throw new ApiError(429, 'Limite de comandos pendentes.');
            const c: RemoteCommand = { id: randomUUID(), protocolVersion: PROTOCOL_VERSION, deviceId: id, type: v.type, payload: v.payload, confirmed: v.confirmed, requestedBy: actor.id, createdAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + 5 * 60000).toISOString(), status: 'PENDING', startedAt: null, finishedAt: null };
            s.commands.push(c);
            this.audit(s, actor.id, c.type, id, c.id, v.payload, 'PENDING');
            return c;
        });
    }
    async poll(credential: string) { return this.repository.transaction(s => { const d = this.agentDevice(s, credential); if (d.protocolVersion !== PROTOCOL_VERSION) return []; const now = this.now(); for (const c of s.commands.filter(c => c.deviceId === d.id && ['PENDING', 'RECEIVED'].includes(c.status) && Date.parse(c.expiresAt) <= now)) {
        c.status = 'EXPIRED';
        c.finishedAt = new Date(now).toISOString();
        this.audit(s, c.requestedBy, c.type, d.id, c.id, c.payload, 'EXPIRED');
    } return s.commands.filter(c => c.deviceId === d.id && ['PENDING', 'RECEIVED', 'RUNNING'].includes(c.status)).slice(0, 1); }); }
    async ack(credential: string, id: string, status: 'RECEIVED' | 'RUNNING') { return this.repository.transaction(s => { const d = this.agentDevice(s, credential); if (d.protocolVersion !== PROTOCOL_VERSION) throw new ApiError(409, 'Protocolo incompatível.'); const c = s.commands.find(c => c.id === id && c.deviceId === d.id); if (!c)
        throw new ApiError(404, 'Comando não encontrado.'); if (Date.parse(c.expiresAt) <= this.now() && c.status !== 'RUNNING')
        throw new ApiError(409, 'Comando expirado.'); if (!canTransition(c.status, status))
        throw new ApiError(409, 'Transição inválida.'); if (c.status !== status) {
        c.status = status;
        if (status === 'RUNNING')
            c.startedAt = new Date(this.now()).toISOString();
        this.audit(s, c.requestedBy, c.type, d.id, c.id, c.payload, status);
    } return c; }); }
    async result(credential: string, id: string, input: unknown) { let v = resultSchema.parse(input); if (id !== v.commandId)
        throw new ApiError(400, 'ID do resultado divergente.'); if (v.protocolVersion !== PROTOCOL_VERSION) throw new ApiError(409, 'Protocolo do resultado incompatível.'); return this.repository.transaction(s => { const d = this.agentDevice(s, credential); if (d.protocolVersion !== PROTOCOL_VERSION) throw new ApiError(409, 'Protocolo incompatível.'); const c = s.commands.find(c => c.id === id && c.deviceId === d.id); if (!c)
        throw new ApiError(404, 'Comando não encontrado.'); if (c.status === "EXPIRED" && v.status !== "EXPIRED")
        v = { ...v, status: "EXPIRED", success: false, summary: ("Expirado antes da confirmação final. " + v.summary).slice(0, 2000), details: { reportedStatus: v.status, reportedDetails: v.details } }; const existing = s.results.find(r => r.commandId === id); if (existing) {
        if (!isDeepStrictEqual(existing, v))
            throw new ApiError(409, 'Resultado final já registrado.');
        return existing;
    } if (!canTransition(c.status, v.status))
        throw new ApiError(409, 'Estado não aceita este resultado.'); c.status = v.status; c.finishedAt = new Date(this.now()).toISOString(); s.results.push(v); this.audit(s, c.requestedBy, c.type, d.id, c.id, c.payload, v.status, Math.max(0, Date.parse(v.finishedAt) - Date.parse(v.startedAt))); return v; }); }
    async getCommand(actor: Actor, id: string) { return this.repository.transaction(s => { const c = s.commands.find(c => c.id === id); if (!c)
        throw new ApiError(404, 'Comando não encontrado.'); this.device(s, actor, c.deviceId); return { command: c, result: s.results.find(r => r.commandId === id) ?? null }; }); }
    async revoke(credential: string) { return this.repository.transaction(s => { const d = this.agentDevice(s, credential); d.revokedAt = new Date(this.now()).toISOString(); for (const c of s.commands.filter(c => c.deviceId === d.id && c.status === 'PENDING'))
        c.status = 'REJECTED'; this.audit(s, d.id, 'device.revoke', d.id, null, {}, 'REVOKED'); return { revoked: true }; }); }
}
