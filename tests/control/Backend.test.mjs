import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load.mjs';
const { ControlBackend, digest } = await load('server/control/ControlBackend.ts');
const { MemoryRepository } = await load('server/control/Repository.ts');
const { isOnline, buildTopology, commandRequestSchema, canTransition, backoff, heartbeatSchema, resultSchema } = await load('src/control/contracts.ts');
const env = '5bad9f25-e005-4116-9ce9-384843210581';
const actor = { id: 'support-subject', name: 'Support', memberships: [{ companyId: 'company', role: 'admin' }] };
function fixture() {
  let clock = Date.parse('2026-10-06T12:00:00Z');
  const repo = new MemoryRepository(); repo.state.environments.push({ id: env, companyId: 'company', name: 'Test environment' });
  const api = new ControlBackend(repo, () => clock);
  const enroll = async (profile = 'TERMINAL', server = null, fingerprint = 'a'.repeat(64)) => {
    const pair = await api.pair(actor, env, profile, server);
    return api.enroll({ pairingCode: pair.code, fingerprint, hostname: 'TEST-01', profile, appVersion: '0.1.0', agentVersion: '0.1.0', coreVersion: '0.1.0', protocolVersion: 1, osVersion: 'Windows fixture', architecture: 'x64' });
  };
  const heartbeat = d => api.heartbeat(d.credential, { deviceId: d.deviceId, timestamp: new Date(clock).toISOString(), hostname: 'TEST-01', profile: d.profile, appVersion: '0.1.0', agentVersion: '0.1.0', coreVersion: '0.1.0', protocolVersion: 1, osVersion: 'Windows fixture', uptime: 60, localIp: '192.0.2.1', healthSummary: 'ok' });
  return { api, repo, enroll, heartbeat, advance: ms => clock += ms, now: () => clock };
}
test('enrollment usa código único e armazena apenas hash de credencial', async () => {
  const f = fixture(); const d = await f.enroll();
  assert.equal(d.credential.length, 43); assert.equal(f.repo.state.devices[0].credentialHash, digest(d.credential));
  assert.ok(f.repo.state.pairing[0].usedAt); assert.equal(JSON.stringify(f.repo.state).includes(d.credential), false);
  const listed = await f.api.list(actor); assert.equal('credentialHash' in listed.devices[0], false); assert.equal('fingerprint' in listed.devices[0], false);
});
test('código expirado ou reutilizado não registra outro dispositivo', async () => {
  const f = fixture(); const pair = await f.api.pair(actor, env, 'TERMINAL', null);
  const data = { pairingCode: pair.code, fingerprint: 'a'.repeat(64), hostname: 'TEST', profile: 'TERMINAL', appVersion: '0.1.0', agentVersion: '0.1.0', coreVersion: '0.1.0', protocolVersion: 1, osVersion: null, architecture: 'x64' };
  await f.api.enroll(data); await assert.rejects(f.api.enroll({ ...data, fingerprint: 'b'.repeat(64) }), /já utilizado/);
  const second = await f.api.pair(actor, env, 'TERMINAL', null); f.advance(600_001);
  await assert.rejects(f.api.enroll({ ...data, pairingCode: second.code }), /expirado/);
});
test('uso concorrente do mesmo código tem apenas um vencedor', async () => {
  const f = fixture(); const pair = await f.api.pair(actor, env, 'TERMINAL', null);
  const data = { pairingCode: pair.code, fingerprint: 'a'.repeat(64), hostname: 'TEST', profile: 'TERMINAL', appVersion: '0.1.0', agentVersion: '0.1.0', coreVersion: '0.1.0', protocolVersion: 1, osVersion: null, architecture: 'x64' };
  const outcomes = await Promise.allSettled([f.api.enroll(data), f.api.enroll({ ...data, fingerprint: 'b'.repeat(64) })]);
  assert.equal(outcomes.filter(v => v.status === 'fulfilled').length, 1);
});
test('heartbeat usa relógio do backend e calcula offline sem snapshot completo', async () => {
  const f = fixture(); const d = await f.enroll(); assert.equal((await f.api.list(actor)).devices[0].status, 'NEVER_CONNECTED');
  await f.heartbeat(d); const listed = (await f.api.list(actor)).devices[0]; assert.equal(listed.status, 'ONLINE'); assert.equal(listed.healthSummary, 'ok');
  f.advance(90_001); assert.equal((await f.api.list(actor)).devices[0].status, 'OFFLINE');
  assert.equal(isOnline('invalid', f.now()), false); assert.equal(isOnline(new Date(f.now() + 10_000).toISOString(), f.now()), false);
});
test('contratos aceitam timestamps UTC emitidos pelo chrono Rust (+00:00)', () => {
  const timestamp = '2026-10-06T12:00:00+00:00';
  assert.equal(heartbeatSchema.safeParse({ deviceId: '67163dda-0a42-4a45-9ba0-5a9e36e01233', timestamp, hostname: 'TEST', profile: 'TERMINAL', appVersion: '0.1.0', agentVersion: '0.1.0', coreVersion: '0.1.0', protocolVersion: 1, osVersion: null, uptime: 1, localIp: null, healthSummary: null }).success, true);
  assert.equal(resultSchema.safeParse({ commandId: '67163dda-0a42-4a45-9ba0-5a9e36e01233', protocolVersion: 1, success: true, status: 'SUCCEEDED', summary: 'fixture', details: {}, startedAt: timestamp, finishedAt: timestamp }).success, true);
});
test('Terminal referencia Server do mesmo ambiente e forma topologia', async () => {
  const f = fixture(); const server = await f.enroll('SERVER'); const terminal = await f.enroll('TERMINAL', server.deviceId, 'b'.repeat(64));
  const tree = buildTopology((await f.api.list(actor)).devices); assert.equal(tree.servers[0].terminals[0].id, terminal.deviceId);
  await assert.rejects(f.api.pair(actor, env, 'SERVER', server.deviceId), /mesmo ambiente/);
  await assert.rejects(f.api.pair(actor, env, 'TERMINAL', 'missing'), /mesmo ambiente/);
});
test('autorização separa viewer, empresa e credencial Agent', async () => {
  const f = fixture(); const d = await f.enroll(); await f.heartbeat(d);
  const viewer = { ...actor, memberships: [{ companyId: 'company', role: 'viewer' }] };
  await assert.rejects(f.api.send(viewer, d.deviceId, { type: 'machine.refresh', payload: {} }), /não autorizado/);
  await assert.rejects(f.api.getDevice({ ...actor, memberships: [] }, d.deviceId), /não autorizado/);
  await assert.rejects(f.api.poll('wrong'.repeat(10)), /não autorizado/);
  await assert.rejects(f.api.heartbeat(d.credential, { deviceId: '67163dda-0a42-4a45-9ba0-5a9e36e01233', timestamp: new Date(f.now()).toISOString(), hostname: 'TEST', profile: 'TERMINAL', appVersion: '0.1.0', agentVersion: '0.1.0', coreVersion: '0.1.0', protocolVersion: 1, osVersion: null, uptime: 1, localIp: null, healthSummary: null }), /não correspondem/);
});
for (const final of ['SUCCEEDED', 'FAILED']) test(`PENDING → RECEIVED → RUNNING → ${final}, com resultado e auditoria idempotentes`, async () => {
  const f = fixture(); const d = await f.enroll(); await f.heartbeat(d);
  const c = await f.api.send(actor, d.deviceId, { type: 'machine.refresh', payload: {} }); assert.equal(c.status, 'PENDING');
  assert.equal((await f.api.poll(d.credential))[0].id, c.id);
  await f.api.ack(d.credential, c.id, 'RECEIVED'); await f.api.ack(d.credential, c.id, 'RECEIVED'); await f.api.ack(d.credential, c.id, 'RUNNING');
  await assert.rejects(f.api.ack(d.credential, c.id, 'RECEIVED'), /Transição inválida/);
  const result = { commandId: c.id, protocolVersion: 1, success: final === 'SUCCEEDED', status: final, summary: 'fixture', details: { a: 1, b: 2 }, startedAt: new Date(f.now()).toISOString(), finishedAt: new Date(f.now() + 10).toISOString() };
  await f.api.result(d.credential, c.id, result); await f.api.result(d.credential, c.id, { ...result, details: { b: 2, a: 1 } });
  assert.equal(f.repo.state.results.length, 1); assert.equal(f.repo.state.audit.filter(a => a.outcome === final).length, 1);
  assert.equal((await f.api.getCommand(actor, c.id)).command.status, final); assert.equal((await f.api.poll(d.credential)).length, 0);
  await assert.rejects(f.api.result(d.credential, c.id, { ...result, summary: 'changed' }), /já registrado/);
});
test('comando expirado não chega ao Agent e offline impede envio', async () => {
  const f = fixture(); const d = await f.enroll(); await assert.rejects(f.api.send(actor, d.deviceId, { type: 'machine.refresh', payload: {} }), /offline/);
  await f.heartbeat(d); const c = await f.api.send(actor, d.deviceId, { type: 'machine.refresh', payload: {} }); f.advance(300_001);
  assert.deepEqual(await f.api.poll(d.credential), []); assert.equal((await f.api.getCommand(actor, c.id)).command.status, 'EXPIRED');
});
test('resultado tardio mantém EXPIRED e não bloqueia retransmissão da outbox', async () => {
  const f = fixture(); const d = await f.enroll(); await f.heartbeat(d);
  const c = await f.api.send(actor, d.deviceId, { type: 'machine.refresh', payload: {} }); await f.api.ack(d.credential, c.id, 'RECEIVED');
  f.advance(300_001); await f.api.poll(d.credential);
  const result = { commandId: c.id, protocolVersion: 1, success: false, status: 'FAILED', summary: 'ACK interrupted; no replay', details: {}, startedAt: new Date(f.now()).toISOString(), finishedAt: new Date(f.now()).toISOString() };
  await f.api.result(d.credential, c.id, result); await f.api.result(d.credential, c.id, result);
  const recorded = await f.api.getCommand(actor, c.id); assert.equal(recorded.command.status, 'EXPIRED'); assert.equal(recorded.result.details.reportedStatus, 'FAILED');
});
test('somente comandos declarados e payloads tipados; confirmação obrigatória', async () => {
  const f = fixture(); const d = await f.enroll(); await f.heartbeat(d);
  for (const type of ['execute_shell', 'run_script', 'printer.remove', 'network.change']) assert.equal(commandRequestSchema.safeParse({ type, payload: {} }).success, false);
  assert.equal(commandRequestSchema.safeParse({ type: 'machine.refresh', payload: { command: 'anything' } }).success, false);
  await assert.rejects(f.api.send(actor, d.deviceId, { type: 'printer.auto_fix', payload: { printerName: 'Fixture' }, confirmed: false }), /Confirmação/);
  const c = await f.api.send(actor, d.deviceId, { type: 'printer.auto_fix', payload: { printerName: 'Fixture' }, confirmed: true }); assert.equal(c.requestedBy, actor.id);
});
test('revogação invalida credencial e reconexão usa backoff limitado', async () => {
  const f = fixture(); const d = await f.enroll(); await f.api.revoke(d.credential); await assert.rejects(f.heartbeat(d), /não autorizado/);
  assert.equal(backoff(0), 5000); assert.equal(backoff(99), 60000); assert.equal(canTransition('SUCCEEDED', 'RUNNING'), false);
});
