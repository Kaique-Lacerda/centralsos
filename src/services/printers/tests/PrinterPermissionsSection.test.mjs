import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../../../pages/PrinterDiagnosticPage.tsx', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', write: false, jsx: 'automatic', loader: { '.css': 'empty' },
});
const { PrinterPermissionsSection } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const snapshot = {
  state: 'available', notice: 'Entradas diretas da ACL.',
  entries: [{ aceIndex: 0, sid: 'S-1-5-32-544', account: 'Administradores', accessType: 'Permitir', permissions: { print: true, managePrinter: true, manageDocuments: false }, specialPermissions: true, inherited: false, editable: true }],
};
const render = overrides => renderToStaticMarkup(createElement(PrinterPermissionsSection, { snapshot, available: true, busy: false, status: null, configure: () => {}, ...overrides }));

test('seção principal oferece somente configurar Todos e mantém ACL recolhida e não editável', () => {
  let calls = 0;
  const html = render({ configure: () => { calls += 1; } });
  assert.match(html, /Configurar permissões/);
  assert.match(html, /Configura o grupo/);
  assert.match(html, /Detalhes técnicos das permissões/);
  assert.match(html, /Administradores/);
  assert.ok(html.indexOf('</section>') < html.indexOf('<table'));
  assert.doesNotMatch(html, /Editar permissões|<input|<details[^>]* open/);
  assert.equal(calls, 0);
});

test('ação fica bloqueada sem acesso administrativo ou durante a aplicação', () => {
  assert.match(render({ available: false }), /<button[^>]*disabled/);
  assert.match(render({ busy: true }), /<button[^>]*disabled/);
});

test('resultado é legível e Access Denied fica em detalhe técnico expansível', () => {
  assert.match(render({ status: { success: true, message: 'Permissões configuradas com sucesso.', technical: null } }), /Permissões configuradas com sucesso/);
  const html = render({ status: { success: false, message: 'Não foi possível configurar as permissões da impressora.', technical: 'Access Denied (Windows 5)' } });
  assert.match(html, /Não foi possível configurar as permissões da impressora/);
  assert.match(html, /<details[^>]*><summary>Detalhe técnico da operação<\/summary><p>Access Denied/);
});
