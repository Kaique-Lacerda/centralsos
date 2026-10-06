import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

async function load(entry) {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL(entry, import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
}

const actions = await load('../PrinterActionClient.ts');
const validation = await load('../PrinterOperations.ts');
const permissions = { print: true, managePrinter: false, manageDocuments: true };

test('ações de gerenciamento no Desktop chamam comandos específicos com parâmetros estruturados', async () => {
  const calls = [];
  const client = actions.createPrinterActionClient('desktop', async (command, args) => { calls.push({ command, args }); return undefined; });
  await client.cancelJob('HP Balcão', 42);
  await client.clearQueue('HP Balcão');
  await client.pause('HP Balcão');
  await client.resume('HP Balcão');
  await client.setDefault('HP Balcão');
  await client.rename('HP Balcão', 'HP Recepção');
  await client.setShare('HP Balcão', true, 'Recepcao');
  await client.setShare('HP Balcão', false, null);
  await client.setLocation('HP Balcão', 'Recepção');
  await client.setComment('HP Balcão', 'Impressora do balcão');
  await client.getConfiguration('HP Balcão');
  await client.getPauseState('HP Balcão');
  await client.getPermissions('HP Balcão');
  await client.setPermissions('HP Balcão', 'S-1-5-32-545', permissions, { ...permissions, managePrinter: true });
  assert.deepEqual(calls.map(call => call.command), [
    'cancel_printer_job', 'clear_printer_queue', 'pause_printer', 'resume_printer', 'set_default_printer',
    'rename_printer', 'set_printer_share', 'set_printer_share', 'set_printer_location', 'set_printer_comment',
    'get_printer_configuration', 'get_printer_pause_state', 'get_printer_permissions', 'set_printer_permissions',
  ]);
  assert.deepEqual(calls[0].args, { printerName: 'HP Balcão', jobId: 42 });
  assert.deepEqual(calls[6].args, { printerName: 'HP Balcão', enabled: true, shareName: 'Recepcao' });
  assert.deepEqual(calls[7].args, { printerName: 'HP Balcão', enabled: false, shareName: null });
  assert.deepEqual(calls[13].args.request, {
    printerName: 'HP Balcão', trusteeSid: 'S-1-5-32-545', expectedBefore: permissions,
    after: { print: true, managePrinter: true, manageDocuments: true },
  });
});

test('Web não invoca operações locais de impressora', async () => {
  let invoked = false;
  const client = actions.createPrinterActionClient('web', async () => { invoked = true; });
  assert.throws(() => client.clearQueue('HP'), /Disponível no Desktop/);
  assert.throws(() => client.setDefault('HP'), /Disponível no Desktop/);
  assert.throws(() => client.getPermissions('HP'), /Disponível no Desktop/);
  assert.throws(() => client.configurePermissions('HP'), /Disponível no Desktop/);
  assert.equal(invoked, false);
});

test('configurar Todos usa um comando específico sem aceitar ACL, SID ou shell da interface', async () => {
  const calls = [];
  const client = actions.createPrinterActionClient('desktop', async (command, args) => { calls.push({ command, args }); });
  await client.configurePermissions('MP-4200 TH');
  assert.deepEqual(calls, [{ command: 'configure_printer_permissions', args: { printerName: 'MP-4200 TH' } }]);
});

test('configurações protegidas exigem elevação e falham fechadas se o contexto for desconhecido', () => {
  assert.equal(validation.getPrinterConfigurationActionAvailability('desktop', true).available, true);
  assert.deepEqual(validation.getPrinterConfigurationActionAvailability('desktop', false), { available: false, message: 'Esta operação exige que o CENTRAL SOS seja executado como administrador.' });
  assert.equal(validation.getPrinterConfigurationActionAvailability('desktop', undefined).available, false);
  assert.equal(validation.getPrinterConfigurationActionAvailability('web', true).available, false);
});

test('valida nome da impressora e nome compartilhado antes de enviar ao Windows', () => {
  assert.match(validation.validatePrinterName('  '), /Informe/);
  assert.match(validation.validatePrinterName('HP\\Recepção'), /caracteres inválidos/);
  assert.match(validation.validatePrinterName('x'.repeat(221)), /220/);
  assert.equal(validation.validatePrinterName('HP Recepção'), null);
  assert.match(validation.validatePrinterShareName(''), /Informe/);
  assert.match(validation.validatePrinterShareName('Setor/Financeiro'), /caracteres inválidos/);
  assert.equal(validation.validatePrinterShareName('Financeiro'), null);
});

test('limites de localização e comentário são verificáveis sem preencher dados ausentes', () => {
  assert.match(validation.validatePrinterMetadata('x'.repeat(1025), 'Comentário'), /1024/);
  assert.equal(validation.validatePrinterMetadata('', 'Localização'), null);
});

test('erros nativos de acesso e impressora inexistente chegam ao chamador sem simular sucesso', async () => {
  for (const message of ['A impressora não foi encontrada.', 'O Windows negou permissão para alterar esta impressora.']) {
    const client = actions.createPrinterActionClient('desktop', async () => { throw message; });
    await assert.rejects(client.setDefault('HP'), cause => cause === message);
    await assert.rejects(client.rename('HP', 'Recepção'), cause => cause === message);
    await assert.rejects(client.cancelJob('HP', 42), cause => cause === message);
  }
});

test('consulta retorna ACL real e alterações retornam antes/depois e confirmação da leitura', async () => {
  const entry = { aceIndex: 0, sid: 'S-1-5-32-545', account: 'BUILTIN\\Users', accessType: 'Permitir', permissions, specialPermissions: true, inherited: false, editable: true };
  const snapshot = { state: 'available', entries: [entry], notice: null };
  const result = { account: entry.account, sid: entry.sid, before: permissions, after: { ...permissions, managePrinter: true }, verified: true };
  const client = actions.createPrinterActionClient('desktop', async command => command === 'get_printer_permissions' ? snapshot : result);
  assert.deepEqual(await client.getPermissions('HP'), snapshot);
  assert.deepEqual(await client.setPermissions('HP', entry.sid, permissions, result.after), result);
});
