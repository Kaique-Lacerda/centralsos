import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { observations, clients, actions, adapter, service, check, col, printer, job } from './fixtures.mjs';
async function load(path) {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL(path, import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
}
const { analyzeDiagnosis, correlateFindings } = await load('../Correlation.ts');
const { createDiagnosisEngine } = await load('../DiagnosisEngine.ts');
const { canExecuteRemediation } = await load('../RemediationPolicy.ts');
const { networkAdministrativeState, classifyNetworkAdapter } = await load('../../network/NetworkDiagnostic.ts');
const { collectNetworkIssues } = await load('../../support/NetworkKnownIssues.ts');
const { isReadOnlyService } = await load('../../support/ServiceSafety.ts');
const { volumeKind } = await load('../../system/VolumePresentation.ts');
const incidents = data => analyzeDiagnosis(data).incidents;
const stopped = () => { const data = observations(); data.printing.spooler.state = 1; return data; };

test('Wi-Fi saudável + Ethernet sem mídia: Rede saudável e Ethernet somente nos detalhes', () => {
  const data = observations(); data.network.adapters.items.push(adapter({ name: 'Ethernet', status: 'Mídia desconectada', ipv4: [], gateways: [], dnsServers: [] }));
  const result = analyzeDiagnosis(data);
  assert.equal(result.incidents.filter(i => i.source === 'network').length, 0);
  assert.equal(result.areas.find(a => a.area === 'network').state, 'healthy');
  assert.ok(result.findings.some(f => f.evidence.includes('NETWORK_MEDIA_DISCONNECTED') && f.severity === 'info'));
  assert.equal(networkAdministrativeState(data.network.adapters.items[1]), 'enabled');
  assert.equal(networkAdministrativeState(adapter({ netEnabled: null, status: 'Mídia desconectada' })), 'unknown');
});
test('Tailscale/Wintun/WireGuard conectado sem gateway ou DNS: nenhum warning genérico', () => {
  const data = observations(); const vpn = adapter({ name: 'Tailscale Tunnel', productName: 'Wintun Userspace Tunnel', manufacturer: 'WireGuard LLC', physicalAdapter: true, gateways: [], dnsServers: [] });
  data.network.adapters.items.push(vpn);
  assert.equal(classifyNetworkAdapter(vpn), 'VPN');
  assert.equal(incidents(data).filter(i => i.source === 'network').length, 0);
  assert.ok(!collectNetworkIssues(data.network).some(i => ['DEFAULT_GATEWAY_MISSING', 'DNS_MISSING'].includes(i.id)));
});
test('AUTOCOM presente + Firebird ausente + 3050 indisponível: um incidente com cinco evidências', () => {
  const data = observations(); data.firebird.database.exists = true;
  const found = incidents(data).filter(i => i.source === 'firebird');
  assert.equal(found.length, 1); assert.equal(found[0].title, 'Firebird indisponível');
  assert.equal(found[0].evidence.length, 5); assert.equal(found[0].severity, 'problem');
  assert.equal(found[0].confidence, 'confirmed'); assert.equal(found[0].findingIds.length, 5);
  assert.equal(found[0].remediation.kind, 'manual');
});
test('Spooler parado: incidente automático seguro com confirmação e revalidação de filas', () => {
  const data = stopped(); const incident = incidents(data)[0];
  assert.equal(incident.id, 'printing.spooler'); assert.equal(incident.remediation.actionId, 'spooler.start');
  assert.equal(incident.remediation.requiresConfirmation, true); assert.equal(canExecuteRemediation(incident, data), true);
  data.printing.elevated = false; assert.equal(canExecuteRemediation(incident, data), false);
  data.printing.elevated = true; data.printing.spooler.startMode = 4; assert.equal(canExecuteRemediation(incident, data), false);
});
test('Revalidação falhou depois de ação aceita: incidente permanece e não é marcado resolvido', async () => {
  const data = stopped(); let reads = 0; let calls = 0;
  const engine = createDiagnosisEngine(clients(data, { spooler: async () => { if (++reads >= 3) throw Error('SCM unavailable'); return [data.printing.spooler, true]; } }), actions({ startSpooler: async () => { calls++; } }));
  await engine.run(); const result = await engine.remediate(['printing.spooler'], true);
  assert.equal(calls, 1); assert.equal(result.attempts[0].commandAccepted, true);
  assert.equal(result.attempts[0].state, 'unresolved'); assert.equal(result.attempts[0].revalidated, false);
  assert.ok(result.result.incidents.some(i => i.id === 'printing.spooler'));
});
test('Comando aceito, mas Spooler continua parado: unresolved', async () => {
  const engine = createDiagnosisEngine(clients(stopped()), actions());
  await engine.run(); const result = await engine.remediate(['printing.spooler'], true);
  assert.equal(result.attempts[0].state, 'unresolved'); assert.ok(result.result.incidents.length);
});
test('Spooler iniciou mas fila não abre: incidente permanece', async () => {
  const data = stopped(); data.machine.printers.items = [{ name: 'Printer', isDefault: true }];
  data.printing.printers = [{ name: 'Printer', isDefault: true, snapshot: printer({ queue: col([], 'Access denied') }), error: null }];
  let running = false;
  const engine = createDiagnosisEngine(clients(data, { spooler: async () => [{ state: running ? 4 : 1, startMode: 2, error: null }, true] }), actions({ startSpooler: async () => { running = true; } }));
  await engine.run(); const result = await engine.remediate(['printing.spooler'], true);
  assert.equal(result.attempts[0].state, 'unresolved'); assert.ok(result.result.incidents.some(i => i.id === 'printing.spooler'));
});
test('Serviços críticos: UI somente leitura e policy recusa ação mesmo com plano adulterado', () => {
  for (const name of ['RpcSs', 'RpcEptMapper', 'EventLog', 'DcomLaunch', 'LSM', 'SamSs', 'Winmgmt', 'BFE']) {
    const data = observations(); data.services.items = [service({ name, state: 'Stopped' })];
    assert.equal(isReadOnlyService(data.services.items[0]), true);
    const original = incidents(data)[0] ?? { id: `service.${name}`, confidence: 'confirmed', source: 'services' };
    assert.equal(canExecuteRemediation({ ...original, remediation: { kind: 'automatic', actionId: 'service.start', target: name, safeToBatch: true, requiresConfirmation: true, revalidationTargets: ['services'] } }, data), false);
  }
});
test('Dependência detectada ou ausente sem requisito: inventário, nenhum incidente', () => {
  const data = observations(); data.dependencies.items = [{ name: 'Microsoft WebView2', version: '1', source: 'registry', location: null, architecture: null }];
  assert.equal(incidents(data).filter(i => i.source === 'dependencies').length, 0);
  assert.ok(analyzeDiagnosis(data).findings.some(f => f.source === 'dependencies' && f.severity === 'info'));
  data.dependencies.items = []; assert.equal(incidents(data).length, 0);
});
test('UAC fora do baseline: falha de Conformidade não vira causa operacional', () => {
  const data = observations(); data.compliance = { profile: 'terminal', snapshot: data.machine, results: [{ ruleId: 'uac', title: 'EnableLUA', category: 'system', status: 'error', severity: 'error', description: 'Fora do baseline', actual: '1', expected: '0' }], summary: { total: 1, error: 1 } };
  const result = analyzeDiagnosis(data); assert.equal(result.incidents.length, 0);
  assert.equal(result.findings.find(f => f.source === 'compliance').severity, 'info');
  assert.equal(data.compliance.results[0].status, 'error');
});
test('Volumes sem tamanho e CD-ROM não são incidentes; disco fixo com espaço crítico é', () => {
  const data = observations(); data.system.volumes.items = [{ unit: 'D:', driveType: 5, totalBytes: null, freeBytes: null }, { unit: 'E:', driveType: 2, totalBytes: null, freeBytes: null }];
  assert.equal(incidents(data).length, 0);
  assert.equal(volumeKind(5), 'CD-ROM'); assert.equal(volumeKind(3), 'Fixo'); assert.equal(volumeKind(4), 'Rede');
  data.system.volumes.items.push({ unit: 'C:', driveType: 3, totalBytes: 100 * 1024 ** 3, freeBytes: 1024 });
  assert.equal(incidents(data)[0].id, 'volume.space.C:');
});
test('Falha de coleta não fabrica ausência de Firebird e não conta área saudável', () => {
  const data = observations(); data.firebird = null; data.errors.firebird = 'WMI error';
  assert.equal(incidents(data).length, 0);
  assert.equal(analyzeDiagnosis(data).areas.find(a => a.area === 'firebird').state, 'inconclusive');
});
test('Resultados são serializáveis sem funções, Map ou contratos da UI', () => {
  const result = analyzeDiagnosis(stopped()); assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});
test('Correlação preserva evidências e recusa correções divergentes no mesmo incidente', () => {
  const f = analyzeDiagnosis(stopped()).findings.find(f => f.id === 'printing.spooler');
  const result = correlateFindings([f, { ...f, id: 'second', evidence: ['extra'], remediation: { kind: 'manual' } }]);
  assert.equal(result.length, 1); assert.equal(result[0].remediation.kind, 'manual'); assert.ok(result[0].evidence.includes('extra'));
});
test('Batch só age após confirmação, em sequência, e revalida cada ação', async () => {
  const data = stopped(); data.system.timeSync = check('warning', 3); const log = [];
  let printingFixed = false; let timeFixed = false; let active = 0;
  const engine = createDiagnosisEngine(clients(data, {
    spooler: async () => { log.push('read.printing'); return [{ state: printingFixed ? 4 : 1, startMode: 2, error: null }, true]; },
    system: async () => { log.push('read.system'); return { ...data.system, timeSync: timeFixed ? check() : check('warning', 3) }; },
  }), actions({
    startSpooler: async () => { assert.equal(active++, 0); log.push('action.printing'); printingFixed = true; active--; },
    syncTime: async () => { assert.equal(active++, 0); log.push('action.system'); timeFixed = true; active--; },
  }));
  await engine.run(); const ids = engine.preview().map(i => i.id); assert.equal(ids.length, 2);
  await assert.rejects(engine.remediate(ids, false), /Confirme/); assert.ok(!log.some(l => l.startsWith('action')));
  const result = await engine.remediate(ids, true); assert.deepEqual(result.attempts.map(a => a.state), ['resolved', 'resolved']);
  const first = log.indexOf('action.printing'); const second = log.indexOf('action.system');
  assert.ok(log.slice(first + 1, second).includes('read.printing')); assert.equal(result.result.incidents.length, 0);
});
test('Uma ação falha sem interromper as outras; nenhuma falha é escondida', async () => {
  const data = stopped(); data.system.timeSync = check('warning', 3); let synced = false;
  const engine = createDiagnosisEngine(clients(data, { system: async () => ({ ...data.system, timeSync: synced ? check() : check('warning', 3) }) }), actions({ startSpooler: async () => { throw Error('Denied'); }, syncTime: async () => { synced = true; } }));
  await engine.run(); const result = await engine.remediate(engine.preview().map(i => i.id), true);
  assert.deepEqual(result.attempts.map(a => a.state), ['failed', 'resolved']);
  assert.ok(result.result.incidents.some(i => i.id === 'printing.spooler'));
});
test('Mudança de estado antes da correção: ação desnecessária não é executada', async () => {
  const data = stopped(); let reads = 0; let calls = 0;
  const engine = createDiagnosisEngine(clients(data, { spooler: async () => [{ state: ++reads === 1 ? 1 : 4, startMode: 2, error: null }, true] }), actions({ startSpooler: async () => { calls++; } }));
  await engine.run(); const result = await engine.remediate(['printing.spooler'], true);
  assert.equal(calls, 0); assert.equal(result.attempts[0].state, 'resolved');
});
test('Ação desconhecida ou incidente manual é recusado antes de qualquer mutação', async () => {
  const data = observations(); data.firebird.database.exists = true;
  const engine = createDiagnosisEngine(clients(data), actions({ startService: async () => assert.fail('not allowed') }));
  await engine.run(); await assert.rejects(engine.remediate(['firebird.unavailable'], true), /sem correção/);
  await assert.rejects(engine.remediate(['shell.run'], true), /sem correção/);
});
test('Coleta base ocorre uma vez; progresso cobre as áreas; falha individual permite as demais', async () => {
  const data = observations(); let reads = 0; const progress = [];
  const engine = createDiagnosisEngine(clients(data, { machine: async () => { reads++; return data.machine; }, network: async () => { throw Error('Network failed'); } }), actions());
  const result = await engine.run((...args) => progress.push(args));
  assert.equal(reads, 1); assert.equal(result.areas.find(a => a.area === 'network').state, 'inconclusive');
  assert.equal(result.areas.find(a => a.area === 'dependencies').state, 'healthy');
  assert.equal(progress.filter(p => p[1] === 'done').length, 7);
});
test('Horário desconhecido não oferece correção; leap indicator 3 com serviço habilitado oferece', () => {
  const data = observations(); data.system.timeSync = check('warning');
  assert.equal(incidents(data)[0].remediation.kind, 'manual'); assert.equal(incidents(data)[0].confidence, 'inconclusive');
  data.system.timeSync = check('warning', 3); assert.equal(incidents(data)[0].remediation.actionId, 'system.syncTime');
});
test('Fila: cancelar apenas ERROR/BLOCKED_DEVQ, sem papel/offline/intervenção e sem limpar tudo', async () => {
  const data = observations(); data.machine.printers.items = [{ name: 'Printer', isDefault: true }];
  let fixed = false; const jobs = [job(1, 2), job(2, 2 | 0x40), job(3, 2 | 0x20)]; const calls = [];
  const engine = createDiagnosisEngine(clients(data, { printer: async () => printer({ queue: col(fixed ? jobs.slice(1) : jobs) }) }), actions({ cancelProblemJob: async (_name, id) => { calls.push(id); fixed = true; return true; } }));
  await engine.run();
  // Physical waiting signals block automatic cancellation of this whole printer.
  assert.equal(engine.preview().length, 0);
  const isolated = createDiagnosisEngine(clients(data, { printer: async () => printer({ queue: col(fixed ? [] : [job(1)]) }) }), actions({ cancelProblemJob: async (_name, id) => { calls.push(id); fixed = true; return true; } }));
  fixed = false; await isolated.run(); const result = await isolated.remediate(isolated.preview().map(i => i.id), true);
  assert.deepEqual(calls, [1]); assert.equal(result.attempts[0].state, 'resolved');
});
test('VPN, mídia e serviços críticos têm representação explícita na UI; abas preservam Conformidade', async () => {
  const page = await readFile(new URL('../../../pages/Pages.tsx', import.meta.url), 'utf8');
  const panel = await readFile(new URL('../../../pages/GeneralDiagnosisPanel.tsx', import.meta.url), 'utf8');
  const services = await readFile(new URL('../../../pages/WindowsServicesDiagnosticPage.tsx', import.meta.url), 'utf8');
  assert.match(page, /<CompliancePanel existingValidation=\{baseline\}/); assert.match(page, /<GeneralDiagnosisPanel/);
  assert.match(panel, /Confirmar plano de correção/); assert.match(panel, /Verificar computador/);
  assert.match(services, /isReadOnlyService\(service\)/);
});
test('Incidente sem revalidação persiste mesmo após próxima ação do batch resolver outra área', async () => {
  const data = stopped(); data.machine.printers.items = [{ name: 'Printer', isDefault: true }];
  data.system.timeSync = check('warning', 3);
  let running = false; let synced = false;
  const engine = createDiagnosisEngine(clients(data, {
    spooler: async () => [{ state: running ? 4 : 1, startMode: 2, error: null }, true],
    printer: async () => printer({ queue: col([], 'Queue unavailable') }),
    system: async () => ({ ...data.system, timeSync: synced ? check() : check('warning', 3) }),
  }), actions({ startSpooler: async () => { running = true; }, syncTime: async () => { synced = true; } }));
  await engine.run(); const result = await engine.remediate(engine.preview().map(i => i.id), true);
  assert.deepEqual(result.attempts.map(a => a.state), ['unresolved', 'resolved']);
  assert.ok(result.result.incidents.some(i => i.id === 'printing.spooler' && i.confidence === 'inconclusive'));
  assert.equal(result.result.areas.find(a => a.area === 'printing').state, 'inconclusive');
});
test('Banco presente e TCP desconhecido não vira indisponibilidade confirmada', () => {
  const data = observations(); data.firebird.database.exists = true; data.firebird.port.tcp = check('unknown');
  const incident = incidents(data).find(i => i.source === 'firebird');
  assert.equal(incident.confidence, 'inconclusive'); assert.equal(incident.severity, 'warning');
  assert.equal(incident.remediation.kind, 'manual');
});
test('TCP 3050 acessível sem identidade do servidor não fabrica Firebird ausente', () => {
  const data = observations(); data.firebird.database.exists = true; data.firebird.port.tcp = check();
  assert.ok(!incidents(data).some(i => i.id === 'firebird.unavailable'));
  assert.ok(analyzeDiagnosis(data).findings.some(f => f.id === 'firebird.tcp.context'));
});
test('Instância Firebird identificada: inicia somente serviço habilitado e confirma TCP após ação', async () => {
  const data = observations(); data.firebird.database.exists = true;
  data.firebird.services = col([service({ name: 'FirebirdServerDefaultInstance', pathName: 'C:\\Firebird\\fbserver.exe', state: 'Stopped' })]);
  let fixed = false; const calls = [];
  const engine = createDiagnosisEngine(clients(data, {
    firebird: async () => ({ ...data.firebird, services: col([{ ...data.firebird.services.items[0], state: fixed ? 'Running' : 'Stopped' }]), processes: col(fixed ? [{ name: 'fbserver.exe', pid: 123 }] : []), port: { ...data.firebird.port, tcp: fixed ? check() : check('error') } }),
  }), actions({ startService: async name => { calls.push(name); fixed = true; } }));
  await engine.run(); assert.equal(engine.preview()[0].actionId, 'service.start');
  const result = await engine.remediate(engine.preview().map(i => i.id), true);
  assert.deepEqual(calls, ['FirebirdServerDefaultInstance']); assert.equal(result.attempts[0].state, 'resolved');
});
test('Servidor responde só com serviço iniciado mas TCP continua falhando: incidente Firebird permanece', async () => {
  const data = observations(); data.firebird.database.exists = true;
  data.firebird.services = col([service({ name: 'FirebirdServerDefaultInstance', pathName: 'C:\\Firebird\\fbserver.exe', state: 'Stopped' })]);
  let started = false;
  const engine = createDiagnosisEngine(clients(data, { firebird: async () => ({ ...data.firebird, services: col([{ ...data.firebird.services.items[0], state: started ? 'Running' : 'Stopped' }]) }) }), actions({ startService: async () => { started = true; } }));
  await engine.run(); const result = await engine.remediate(['firebird.unavailable'], true);
  assert.equal(result.attempts[0].state, 'unresolved'); assert.ok(result.result.incidents.some(i => i.id === 'firebird.unavailable'));
});
test('Serviço não prioritário parado e serviço manual não são incidentes; Cobian Auto parado é', () => {
  const data = observations(); data.services.items = [service({ name: 'Generic', state: 'Stopped' }), service({ startMode: 'Manual', state: 'Stopped' })];
  assert.equal(incidents(data).length, 0);
  data.services.items.push(service({ state: 'Stopped' })); assert.equal(incidents(data).filter(i => i.source === 'services').length, 1);
});
test('DNS: limpeza de cache só com resposta direta confirmada e reconsulta do resolver', async () => {
  const data = observations(); data.network.external.dns = check('error'); let fixed = false; let calls = 0;
  const engine = createDiagnosisEngine(clients(data, { network: async () => ({ ...data.network, external: { ...data.network.external, dns: fixed ? check() : check('error') } }) }), actions({ flushDns: async () => { calls++; fixed = true; } }));
  await engine.run(); const result = await engine.remediate(engine.preview().map(i => i.id), true);
  assert.equal(calls, 1); assert.equal(result.attempts[0].state, 'resolved');
});
test('Coletas e remediações não podem se sobrepor', async () => {
  let release; const waiting = new Promise(resolve => { release = resolve; });
  const data = stopped(); const engine = createDiagnosisEngine(clients(data, { machine: async () => { await waiting; return data.machine; } }), actions());
  const first = engine.run(); await assert.rejects(engine.run(), /já está em execução/); release(); await first;
});
test('TCP voltou após iniciar Firebird, mas processo não foi encontrado: recuperação não confirmada', async () => {
  const data = observations(); data.firebird.database.exists = true;
  data.firebird.services = col([service({ name: 'FirebirdServerDefaultInstance', pathName: 'C:\\Firebird\\fbserver.exe', state: 'Stopped' })]);
  let started = false;
  const engine = createDiagnosisEngine(clients(data, { firebird: async () => ({ ...data.firebird, services: col([{ ...data.firebird.services.items[0], state: started ? 'Running' : 'Stopped' }]), port: { ...data.firebird.port, tcp: started ? check() : check('error') } }) }), actions({ startService: async () => { started = true; } }));
  await engine.run(); const result = await engine.remediate(['firebird.unavailable'], true);
  assert.equal(result.attempts[0].state, 'unresolved'); assert.ok(result.result.incidents.some(i => i.id === 'firebird.unavailable'));
});
