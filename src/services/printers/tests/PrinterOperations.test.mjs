import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

async function load(entry) {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL(entry, import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
}

const { classifyPrinterConnection, getPrinterOperationalState } = await load('../PrinterDiagnostic.ts');
const { getPrinterActionAvailability, getPrinterTestErrorMessage, getQueueEmptyMessage, getQueuePagesLabel, getQueueSizeLabel, getQueueStatus, getQueueClearMessage, getQueueCountLabel } = await load('../PrinterOperations.ts');
const printer = (overrides = {}) => ({ name: 'Impressora', isDefault: false, driver: 'Driver', port: 'USB001', server: null, status: 'Ociosa', local: true, network: false, shared: false, shareName: null, location: null, comment: null, ...overrides });
const job = (overrides = {}) => ({ jobId: 12, document: 'Relatorio.pdf', user: 'Suporte', status: 'Imprimindo', statusDetail: null, sizeBytes: 250880, totalPages: 2, pagesPrinted: 1, submittedAt: '2026-09-30 13:20 UTC', position: 1, ...overrides });

test('classifica conexões somente com evidência fornecida pelo Windows', () => {
  assert.equal(classifyPrinterConnection(printer({ port: 'USB006' })), 'USB');
  assert.equal(classifyPrinterConnection(printer({ port: 'COM4' })), 'COM');
  assert.equal(classifyPrinterConnection(printer({ port: 'IP_192.168.1.36' })), 'TCP-IP');
  assert.equal(classifyPrinterConnection(printer({ local: false, network: true })), 'Rede');
  assert.equal(classifyPrinterConnection(printer({ local: false, network: true, server: '\\\\192.168.1.36' })), 'Rede');
  assert.equal(classifyPrinterConnection(printer({ shared: true, network: true })), 'Compartilhada');
  assert.equal(classifyPrinterConnection(printer({ local: true, port: null })), 'Local');
  assert.equal(classifyPrinterConnection(printer({ name: 'Wi-Fi Printer', local: null, network: null, shared: null, port: 'WSD-12' })), 'Não identificado');
});

test('mostra estados da impressora em linguagem operacional e preserva ausência como desconhecida', () => {
  assert.deepEqual(getPrinterOperationalState(printer({ status: 'Ociosa' })), { label: 'Ociosa', tone: 'success' });
  assert.deepEqual(getPrinterOperationalState(printer({ status: 'Imprimindo' })), { label: 'Imprimindo', tone: 'success' });
  assert.deepEqual(getPrinterOperationalState(printer({ status: 'Offline' })), { label: 'Desconectada', tone: 'error' });
  assert.deepEqual(getPrinterOperationalState(printer({ status: 'Parada' })), { label: 'Erro', tone: 'error' });
  assert.deepEqual(getPrinterOperationalState(printer({ status: null })), { label: 'Desconhecido', tone: 'unknown' });
});

test('separa recursos locais do Desktop das ações indisponíveis na Web', () => {
  assert.deepEqual(getPrinterActionAvailability('desktop'), { available: true, message: null });
  assert.deepEqual(getPrinterActionAvailability('web'), { available: false, message: 'Disponível no Desktop' });
});

test('representa fila vazia e trabalhos sem preencher informações ausentes', () => {
  assert.equal(getQueueEmptyMessage([]), 'Nenhum trabalho na fila.');
  assert.equal(getQueueEmptyMessage([job()]), null);
  assert.deepEqual(job({ user: null, submittedAt: null, totalPages: null, pagesPrinted: null }), {
    jobId: 12, document: 'Relatorio.pdf', user: null, status: 'Imprimindo', statusDetail: null, sizeBytes: 250880, totalPages: null,
    pagesPrinted: null, submittedAt: null, position: 1
  });
  assert.equal(getQueueSizeLabel(250880), '245 KB');
  assert.equal(getQueuePagesLabel(4, 2), '2/4');
  assert.equal(getQueuePagesLabel(null, 2), '2 impressas');
  assert.equal(getQueuePagesLabel(null, null), 'Não informado');
});

test('normaliza os estados reais retornados pelo contrato do spooler', () => {
  for (const status of ['Imprimindo', 'Aguardando', 'Pausado', 'Erro', 'Cancelando', 'Concluído']) {
    assert.equal(getQueueStatus(status), status);
  }
  assert.equal(getQueueStatus(''), 'Desconhecido');
  assert.equal(getQueueStatus('estado inventado'), 'Desconhecido');
});

test('apresenta erros identificáveis da operação de página de teste', () => {
  assert.equal(getPrinterTestErrorMessage(new Error('A impressora não foi encontrada.')), 'A impressora não foi encontrada.');
  assert.equal(getPrinterTestErrorMessage(new Error('A impressora está indisponível.')), 'A impressora está indisponível.');
  assert.equal(getPrinterTestErrorMessage(new Error('falha interna')), 'Não foi possível enviar a página de teste.');
});

test('resume fila limpa, fila vazia e falhas parciais sem esconder trabalhos restantes', () => {
  assert.equal(getQueueCountLabel([]), 'Nenhum trabalho');
  assert.equal(getQueueCountLabel([job()]), '1 trabalho');
  assert.equal(getQueueCountLabel([job(), job({ jobId: 13 })]), '2 trabalhos');
  assert.equal(getQueueClearMessage({ removedCount: 0, failedJobIds: [] }), 'Nenhum trabalho na fila.');
  assert.equal(getQueueClearMessage({ removedCount: 3, failedJobIds: [] }), '3 trabalhos removidos da fila.');
  assert.equal(getQueueClearMessage({ removedCount: 2, failedJobIds: [13] }), '2 trabalhos removidos; 1 trabalho não pôde ser removido.');
});
