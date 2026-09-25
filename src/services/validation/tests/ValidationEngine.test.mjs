import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

async function load(entry) {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL(entry, import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
}
const { ValidationEngine } = await load('../ValidationEngine.ts');
const { ValidationRegistry } = await load('../ValidationRegistry.ts');

const snapshot = {
  capturedAt: 0,
  system: { hostname: 'SOS-01', username: 'suporte', operatingSystem: 'Windows', windowsVersion: '10', architecture: 'x64', manufacturer: null, model: null, cpu: null, ramBytes: null, bios: null, error: null },
  storage: { items: [{ unit: 'C:', label: null, totalBytes: 100, freeBytes: 50, usedBytes: 50 }], error: null },
  network: { items: [{ name: 'Ethernet', status: 'Conectado', mac: null, ipv4: [], ipv6: [], gateways: [], dnsServers: [] }], error: null },
  printers: { items: [{ name: 'Impressora local', isDefault: false, driver: 'Driver', port: 'USB', server: null, status: null }], error: null }
};
function installation(overrides = {}) {
  const unknown = { value: null, error: 'não consultável' };
  return { uacEnableLua: { value: '0x0', error: null }, networkDiscovery: unknown, automaticNetworkDeviceSetup: unknown,
    filePrinterSharing: unknown, passwordProtectedSharing: unknown, dllFileName: null, dllSystem32Exists: unknown,
    dllSyswow64Exists: unknown, databaseExists: { value: 'true', error: null }, firebirdServices: [], firebirdError: null,
    cobian: [], cobianError: null, ibconsoleExecutables: [], ibconsoleError: null, nubeContabil: [], nubeContabilError: null, ...overrides };
}
const context = (ins = installation(), machine = snapshot) => ({ snapshot: machine, installation: ins });

test('seleciona regras por perfil e servidor herda todo o baseline Terminal', () => {
  const terminal = ValidationRegistry.getApplicableRules('terminal');
  const server = ValidationRegistry.getApplicableRules('server');
  const terminalIds = new Set(terminal.map(rule => rule.id));
  assert.ok(terminalIds.has('terminal-uac-enable-lua'));
  assert.ok(!terminalIds.has('server-firebird-installed'));
  for (const rule of terminal) assert.ok(server.some(serverRule => serverRule.id === rule.id), `servidor não herdou ${rule.id}`);
  assert.ok(server.some(rule => rule.id === 'server-firebird-installed'));
  const serverResults = ValidationEngine.run(context(), 'server');
  assert.ok(serverResults.length > 7, 'a execução real do perfil server deve incluir regras de instalação');
  assert.ok(serverResults.some(result => result.ruleId === 'server-database-file'));
  assert.equal(ValidationEngine.summarize(serverResults).total, serverResults.length);
});

test('uma regra passa e outra falha conforme os dados coletados', () => {
  const rules = ValidationRegistry.getApplicableRules('server');
  assert.equal(rules.find(rule => rule.id === 'terminal-uac-enable-lua').validate(context()).status, 'success');
  const missingDb = context(installation({ databaseExists: { value: 'false', error: null } }));
  assert.equal(rules.find(rule => rule.id === 'server-database-file').validate(missingDb).status, 'error');
});

test('divergência gera warning e dado não consultável fica skipped', () => {
  const printerRule = ValidationRegistry.getApplicableRules('terminal').find(rule => rule.id === 'terminal-printer-basics');
  const partialPrinter = { ...snapshot, printers: { items: [{ ...snapshot.printers.items[0], driver: null }], error: null } };
  assert.equal(printerRule.validate(context(installation(), partialPrinter)).status, 'warning');
  const dllRule = ValidationRegistry.getApplicableRules('terminal').find(rule => rule.id === 'terminal-procedure-dll-system32');
  assert.equal(dllRule.validate(context()).status, 'ignored');
  const versionRule = ValidationRegistry.getApplicableRules('server').find(rule => rule.id === 'server-cobian-version');
  const versionMismatch = context(installation({ cobian: [{ name: 'Cobian Backup', version: '9.5.0', location: null }] }));
  assert.equal(versionRule.validate(versionMismatch).status, 'warning');
});

test('falha isolada não interrompe regras posteriores e todos os estados são resumidos', () => {
  const make = (id, status, validate = () => ({ ruleId: id, title: id, category: 'system', status, severity: status === 'error' ? 'error' : 'info', description: id })) => ({ id, name: id, category: 'system', profiles: ['terminal'], validate });
  const rules = [make('success', 'success'), make('throws', 'success', () => { throw new Error('fault'); }), make('warning', 'warning'), make('error', 'error'), make('skipped', 'skipped')];
  const results = ValidationEngine.runRules(context(), rules);
  assert.equal(results.length, 5); assert.equal(results[1].status, 'error'); assert.equal(results[2].status, 'warning'); assert.equal(results[4].status, 'skipped');
  assert.deepEqual(ValidationEngine.summarize(results), { total: 5, success: 1, warning: 1, error: 2, skipped: 1, overallStatus: 'action_required' });
});
