import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

async function load(entry) {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL(entry, import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
}
const { classifyPrinter, getPrinterHealth, getPrinterSignals, getPrinterTechnicalDetails, partialCollectionNotice, printerAvailability, summarizePrinters } = await load('../PrinterDiagnostic.ts');
const printer = (overrides = {}) => ({ name: 'Impressora', isDefault: false, driver: 'Driver', port: 'USB001', server: null, status: 'Ociosa', local: true, network: false, shared: false, shareName: null, location: null, comment: null, ...overrides });

test('classifica somente por propriedades coletadas, sem inferir tipo por nome', () => {
  assert.equal(classifyPrinter(printer({ local: true })), 'Local');
  assert.equal(classifyPrinter(printer({ local: false, network: true })), 'Remota');
  assert.equal(classifyPrinter(printer({ local: true, shared: true })), 'Compartilhada');
  assert.equal(classifyPrinter(printer({ name: 'Microsoft Print to PDF', local: null, network: null, shared: null })), 'Não determinado');
});

test('resume a impressora padrão e sinaliza as demais sem transformar ausência em falha', () => {
  const result = summarizePrinters({ items: [printer({ isDefault: true })], error: null });
  assert.deepEqual(result.defaultPrinters, ['Impressora']);
  assert.equal(result.available, 1);
  const signals = getPrinterSignals(printer({ driver: null, port: null, status: null }));
  assert.equal(signals.find(signal => signal.id === 'driver').state, 'attention');
  assert.equal(signals.find(signal => signal.id === 'status').detail, 'Não conclusivo');
  assert.equal(signals.find(signal => signal.id === 'status').state, 'attention');
});

test('status só indica disponibilidade quando o valor é reconhecido', () => {
  assert.equal(printerAvailability('Offline'), false);
  assert.equal(printerAvailability('Imprimindo'), true);
  assert.equal(printerAvailability('Desconhecido'), null);
  assert.equal(printerAvailability(null), null);
});

test('classifica impressora pronta, atenção, problema e não validada', () => {
  assert.equal(getPrinterHealth(printer()).status, 'ok');
  assert.equal(getPrinterHealth(printer({ driver: 'Driver', port: null, status: 'Ociosa' })).status, 'attention');
  assert.equal(getPrinterHealth(printer({ driver: 'Driver', port: 'USB001', status: 'Offline' })).status, 'problem');
  assert.equal(getPrinterHealth(printer({ driver: null, port: null, status: null })).status, 'not-validated');
});

test('detalhes técnicos informam caminho compartilhado e origem sem presumir configuração', () => {
  const details = getPrinterTechnicalDetails(printer({ server: 'PRINT01', shareName: 'Financeiro' }));
  assert.equal(details.find(item => item.label === 'Caminho do compartilhamento')?.detected, '\\\\PRINT01\\Financeiro');
  assert.match(details.find(item => item.label === 'Estado').source, /PrinterStatus/);
  assert.match(details.find(item => item.label === 'Estado').expected, /não define/);
});

test('lista vazia e erro parcial permanecem explícitos no resumo', () => {
  const empty = { items: [], error: null };
  assert.deepEqual(summarizePrinters(empty), { total: 0, available: 0, determinedStatusCount: 0, sharedOrRemote: 0, defaultPrinters: [] });
  const partial = { items: [printer({ isDefault: true }), printer({ name: 'Falha', status: null, local: null })], error: 'consulta parcial' };
  assert.match(partialCollectionNotice(partial), /consulta parcial/);
  assert.equal(partialCollectionNotice({ items: partial.items, error: null }), null);
  assert.equal(summarizePrinters(partial).total, 2);
  assert.equal(summarizePrinters(partial).determinedStatusCount, 1);
});

test('resume múltiplas impressoras e conta somente remotas/compartilhadas determináveis', () => {
  const result = summarizePrinters({ items: [printer({ isDefault: true }), printer({ name: 'Compartilhada', local: false, shared: true, network: true }), printer({ name: 'Remota', local: false, network: true, server: '\\\\servidor' })], error: null });
  assert.equal(result.total, 3);
  assert.equal(result.available, 3);
  assert.equal(result.sharedOrRemote, 2);
});
