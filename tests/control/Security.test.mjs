import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { load } from './load.mjs';
const { ControlBackend } = await load('server/control/ControlBackend.ts');
const { MemoryRepository } = await load('server/control/Repository.ts');
const { commandDefinitions, PROTOCOL_VERSION, heartbeatSchema, deviceStatus, backoff } = await load('src/control/contracts.ts');
const { operationContexts } = await load('src/control/CommandPolicy.ts');
const company = 'company-a', environment = '5bad9f25-e005-4116-9ce9-384843210581';
const actor = { id: 'subject-a', name: 'Support fixture', memberships: [{ companyId: company, role: 'admin' }] };
const versions = { appVersion: '0.1.0', agentVersion: '0.1.0', coreVersion: '0.1.0', protocolVersion: PROTOCOL_VERSION };
function fixture() {
    let clock = Date.parse('2026-10-06T12:00:00Z');
    const repo = new MemoryRepository();
    repo.state.environments.push({ id: environment, companyId: company, name: 'Fixture' });
    const api = new ControlBackend(repo, () => clock);
    const enrollInput = (code, fingerprint = 'a') => ({ pairingCode: code, fingerprint: fingerprint.repeat(64), hostname: 'TEST', profile: 'TERMINAL', ...versions, osVersion: null, architecture: 'x64' });
    const enroll = async (fingerprint = 'a') => api.enroll(enrollInput((await api.pair(actor, environment, 'TERMINAL', null)).code, fingerprint));
    const beat = (d, extra = {}) => ({ deviceId: d.deviceId, timestamp: new Date(clock).toISOString(), hostname: 'TEST', profile: d.profile, ...versions, osVersion: null, uptime: 1, localIp: null, healthSummary: 'ok', ...extra });
    return { api, repo, enroll, enrollInput, beat, now: () => clock, advance: ms => clock += ms };
}
test('enrollment incompatível não consome código; protocolo não depende da versão do produto', async () => {
    const f = fixture(), p = await f.api.pair(actor, environment, 'TERMINAL', null);
    await assert.rejects(f.api.enroll({ ...f.enrollInput(p.code), protocolVersion: 2 }), /Protocolo incompatível/);
    assert.equal(f.repo.state.pairing[0].usedAt, null);
    const d = await f.api.enroll({ ...f.enrollInput(p.code), appVersion: '9.0.0' });
    assert.equal(d.protocolVersion, 1); assert.equal(d.companyId, company);
});
test('heartbeat incompatível marca DEGRADED e bloqueia send/poll/ACK/result', async () => {
    const f = fixture(), d = await f.enroll(); await f.api.heartbeat(d.credential, f.beat(d));
    const c = await f.api.send(actor, d.deviceId, { type: 'machine.refresh', payload: {} });
    await f.api.heartbeat(d.credential, f.beat(d, { protocolVersion: 2 }));
    assert.equal((await f.api.list(actor)).devices[0].status, 'DEGRADED');
    assert.deepEqual(await f.api.poll(d.credential), []);
    await assert.rejects(f.api.send(actor, d.deviceId, { type: 'machine.refresh', payload: {} }), /Protocolo incompatível/);
    await assert.rejects(f.api.ack(d.credential, c.id, 'RECEIVED'), /Protocolo incompatível/);
    await assert.rejects(f.api.result(d.credential, c.id, { protocolVersion: 2, commandId: c.id, success: false, status: 'REJECTED', summary: 'fixture', details: {}, startedAt: new Date(f.now()).toISOString(), finishedAt: new Date(f.now()).toISOString() }), /Protocolo/);
});
test('credencial não transfere dispositivo, resultado nem empresa', async () => {
    const f = fixture(), a = await f.enroll(), b = await f.enroll('b');
    await f.api.heartbeat(a.credential, f.beat(a));
    const c = await f.api.send(actor, a.deviceId, { type: 'service.check', payload: {} });
    await assert.rejects(f.api.ack(b.credential, c.id, 'RECEIVED'), /não encontrado/);
    await assert.rejects(f.api.result(b.credential, c.id, { protocolVersion: 1, commandId: c.id, success: false, status: 'REJECTED', summary: 'fixture', details: {}, startedAt: new Date(f.now()).toISOString(), finishedAt: new Date(f.now()).toISOString() }), /não encontrado/);
    await assert.rejects(f.api.heartbeat(a.credential, f.beat(a, { companyId: 'company-b' })));
    const outsider = { ...actor, memberships: [{ companyId: 'company-b', role: 'admin' }] };
    await assert.rejects(f.api.send(outsider, a.deviceId, { type: 'machine.refresh', payload: {} }), /não autorizado/);
    await assert.rejects(f.api.getCommand(outsider, c.id), /não autorizado/);
    f.repo.state.environments[0].companyId = 'company-b';
    await assert.rejects(f.api.heartbeat(a.credential, f.beat(a)), /Vínculo/);
    assert.deepEqual((await f.api.list(outsider)).devices, []);
});
test('pareamento fica vinculado à empresa original, não a ambiente reassociado', async () => {
    const f = fixture(), p = await f.api.pair(actor, environment, 'TERMINAL', null);
    f.repo.state.environments[0].companyId = 'company-b';
    await assert.rejects(f.api.enroll(f.enrollInput(p.code)), /Empresa/);
    assert.equal(f.repo.state.pairing[0].usedAt, null);
});
test('matriz completa: confirmação, contexto e whitelist não vêm do payload', () => {
    assert.equal(Object.keys(commandDefinitions).length, 9);
    for (const policy of Object.values(commandDefinitions)) {
        assert.ok(policy.executionContext); assert.ok(policy.auditCategory); assert.ok(policy.timeout > 0);
        assert.deepEqual(policy.allowedDeviceProfiles, ['TERMINAL', 'SERVER']);
        assert.equal(typeof policy.idempotent, 'boolean');
        assert.ok(!policy.nativeOperations.includes('shell'));
    }
    assert.equal(commandDefinitions['printer.auto_fix'].requiresInteractiveUser, true);
    assert.equal(commandDefinitions['printer.auto_fix'].requiresConfirmation, true);
    assert.equal(commandDefinitions['spooler.restart'].executionContext, 'MACHINE_SYSTEM_SAFE');
    assert.equal(operationContexts.hkcu, 'USER_SESSION_REQUIRED');
    assert.equal(operationContexts.arbitraryExecution, 'UNSUPPORTED_REMOTE');
});
test('NEVER_CONNECTED/ONLINE/DEGRADED/OFFLINE e jitter limitado são determinísticos', () => {
    const now = Date.now(), base = { lastSeenAt: null, protocolVersion: 1, healthSummary: 'ok' };
    assert.equal(deviceStatus(base, now), 'NEVER_CONNECTED');
    base.lastSeenAt = new Date(now).toISOString(); assert.equal(deviceStatus(base, now), 'ONLINE');
    assert.equal(deviceStatus({ ...base, healthSummary: null }, now), 'DEGRADED');
    assert.equal(deviceStatus({ ...base, healthSummary: 'critical' }, now), 'DEGRADED');
    assert.equal(deviceStatus(base, now + 90001), 'OFFLINE');
    assert.notEqual(backoff(0, 0), backoff(0, 1)); assert.equal(backoff(99, 1), 60000);
});
test('heartbeat recusa inventários e sua coleta nativa é leve', async () => {
    const f = fixture(), d = await f.enroll();
    assert.equal(heartbeatSchema.safeParse(f.beat(d)).success, true);
    for (const field of ['snapshot', 'printers', 'services', 'processes', 'storage', 'payload', 'command'])
        assert.equal(heartbeatSchema.safeParse({ ...f.beat(d), [field]: [] }).success, false);
    const metadata = await readFile('crates/core/src/services/agent_metadata.rs', 'utf8');
    assert.doesNotMatch(metadata, /collect_machine_snapshot|Win32_Printer|Win32_Process|Win32_Service|Win32_LogicalDisk/);
});
test('Agent não expõe executor/TCP/eval de payload; configuração não contém credencial assumida', async () => {
    const engine = await readFile('crates/agent/src/engine.rs', 'utf8');
    assert.doesNotMatch(engine, /\.eval\(|Command::new|TcpListener|powershell|cmd\.exe|format!\(/i);
    assert.match(engine, /JsValue::from_json/);
    for (const path of ['crates/agent/src/runner.rs', 'crates/agent/src/service.rs'])
        assert.doesNotMatch(await readFile(path, 'utf8'), /TcpListener|UdpSocket|Command::new|powershell|cmd\.exe/i);
    const config = await readFile('.env.example', 'utf8');
    assert.doesNotMatch(config.replace(/^CONTROL_OFFLINE_SECONDS=90\r?\n/m, ''), /^(?:CONTROL_|CENTRAL_SOS_UPDATER_)[A-Z_]+=\S+/m);
    const vault = await readFile('crates/link/src/vault.rs', 'utf8');
    assert.match(vault, /trusted_owner\(target\)/);
    assert.match(vault, /nNumberOfLinks>1/);
    assert.match(vault, /OWNER_SECURITY_INFORMATION\|PROTECTED_DACL_SECURITY_INFORMATION/);
});
