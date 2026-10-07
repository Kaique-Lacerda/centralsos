import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load.mjs';
const { createRulesRuntime } = await load('src/agent/RulesRuntime.ts');
const { ValidationRegistry } = await load('src/services/validation/ValidationRegistry.ts');
const collection = (items = []) => ({ items, error: null });
const snapshot = () => ({ capturedAt: 0, system: { hostname: 'TEST', username: 'fixture', operatingSystem: 'Windows', windowsVersion: '10', architecture: 'x64', error: null }, storage: collection([{ unit: 'C:', totalBytes: 100, freeBytes: 50, usedBytes: 50 }]), network: collection([{ name: 'Ethernet', status: 'Conectado', ipv4: [], ipv6: [], gateways: [], dnsServers: [] }]), printers: collection([{ name: 'Fixture' }]) });
test('refresh reutiliza snapshot e service.check consulta sem mutadores', async () => {
  const calls = []; const run = createRulesRuntime((op, args) => { calls.push({ op, args }); return op === 'snapshot' ? snapshot() : collection(); });
  assert.equal((await run('machine.refresh', {}, 'TERMINAL')).system.hostname, 'TEST'); await run('service.check', { name: 'Spooler' }, 'TERMINAL'); assert.deepEqual(calls.map(v => v.op), ['snapshot', 'services']); assert.equal(calls[1].args.name, 'Spooler');
});
test('validação usa o registry existente e herda Terminal no Server', async () => {
  const unknown = { value: null, error: 'fixture unavailable' };
  const installation = { uacEnableLua: unknown, networkDiscovery: unknown, automaticNetworkDeviceSetup: unknown, filePrinterSharing: unknown, passwordProtectedSharing: unknown, dllFileName: null, dllSystem32Exists: unknown, dllSyswow64Exists: unknown, databaseExists: unknown, firebirdServices: [], firebirdError: 'fixture', cobian: [], cobianError: 'fixture', ibconsoleExecutables: [], ibconsoleError: 'fixture', nubeContabil: [], nubeContabilError: 'fixture' };
  for (const profile of ['TERMINAL', 'SERVER']) {
    const calls = []; const run = createRulesRuntime(op => { calls.push(op); return op === 'snapshot' ? snapshot() : installation; });
    const result = await run('machine.validate', {}, profile); assert.deepEqual(calls, ['snapshot', 'installation']); assert.equal(result.results.length, ValidationRegistry.getApplicableRules(profile.toLowerCase()).length); assert.equal(result.summary.total, result.results.length);
    assert.equal(result.coverage, 'PARTIAL_USER_SESSION_REQUIRED');
    const sessionRules=result.results.filter(r=>r.ruleId==='system-username'||r.category==='printers'||r.category==='backup'||r.category==='cloud_accounting');
    assert.ok(sessionRules.length >= 2);
    for (const rule of sessionRules) { assert.equal(rule.status,'ignored'); assert.equal(rule.actual,'USER_SESSION_REQUIRED'); assert.equal(rule.context.code,'USER_SESSION_REQUIRED'); }
  }
});

for (const type of ['printer.check', 'printer.auto_fix']) test(type + ' exige sessão sem coletar nem corrigir em Session 0', async () => {
  const calls = []; const run = createRulesRuntime(op => { calls.push(op); throw Error('unobservable session resource'); });
  const result = await run(type, { printerName: String.raw`\\server\UserPrinter` }, 'TERMINAL');
  assert.equal(result.status, 'USER_SESSION_REQUIRED'); assert.equal(result.code, 'USER_SESSION_REQUIRED');
  assert.equal(result.executionContext, 'USER_SESSION_REQUIRED'); assert.deepEqual(calls, []);
  assert.match(result.message, /nenhum diagnóstico de ausência ou correção/);
});
test('Agent não reporta SYSTEM como usuário conectado nem inventa impressora ausente', async () => {
  const run = createRulesRuntime(op => { assert.equal(op, 'snapshot'); return snapshot(); });
  const result = await run('machine.refresh', {}, 'SERVER');
  assert.equal(result.system.username, ''); assert.equal(result.printers.error, 'USER_SESSION_REQUIRED');
  assert.deepEqual(result.printers.items, []); assert.equal(result.sessionContext.currentUser.code, 'USER_SESSION_REQUIRED');
});
test('comando não cadastrado e perfil inválido não chegam à ponte nativa', async () => {
  const run = createRulesRuntime(() => { throw Error('unexpected effect'); });
  await assert.rejects(run('execute_shell', {}, 'TERMINAL'), /não suportado/);
  await assert.rejects(run('machine.refresh', {}, 'OTHER'), /não suportado/);
});
