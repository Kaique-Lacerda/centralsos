import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../GitHubReleaseService.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false
});
const { getLatestWindowsRelease, parseLatestWindowsRelease, selectWindowsInstaller } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const asset = (name, overrides = {}) => ({ name, browser_download_url: `https://github.com/Kaique-Lacerda/centralsos/releases/download/v0.1.0/${name}`, size: 1000, ...overrides });

test('release válida usa tag, data e instalador exe publicados', () => {
  const result = parseLatestWindowsRelease({ tag_name: 'v0.1.0', published_at: '2026-09-28T12:00:00Z', assets: [asset('CENTRAL.SOS_0.1.0_x64-setup.exe')] });
  assert.equal(result.status, 'available');
  assert.equal(result.version, 'v0.1.0');
  assert.equal(result.publishedAt, '2026-09-28T12:00:00Z');
  assert.equal(result.asset.name, 'CENTRAL.SOS_0.1.0_x64-setup.exe');
  assert.equal(result.asset.sizeBytes, 1000);
});

test('ausência de release é diferente de release sem asset exe', () => {
  assert.deepEqual(parseLatestWindowsRelease(null), { status: 'not-published' });
  assert.deepEqual(parseLatestWindowsRelease({ tag_name: 'v1', assets: [] }), { status: 'no-installer' });
  assert.deepEqual(parseLatestWindowsRelease({ tag_name: 'v1', assets: [asset('installer.msi')] }), { status: 'no-installer' });
});

test('um exe é selecionado e msi não participa da escolha', () => {
  const result = selectWindowsInstaller([asset('helper.msi'), asset('tool.exe')]);
  assert.equal(result.name, 'tool.exe');
});

test('entre vários exe seleciona apenas o setup e não auxiliares', () => {
  const result = selectWindowsInstaller([asset('central-helper.exe'), asset('CENTRAL-NSIS-setup.exe'), asset('uninstall.exe')]);
  assert.equal(result.name, 'CENTRAL-NSIS-setup.exe');
});

test('aplica prioridade setup, installer e nsis nessa ordem', () => {
  assert.equal(selectWindowsInstaller([asset('app-installer.exe'), asset('app-setup.exe'), asset('app-nsis.exe')]).name, 'app-setup.exe');
  assert.equal(selectWindowsInstaller([asset('app-installer.exe'), asset('app-nsis.exe')]).name, 'app-installer.exe');
  assert.equal(selectWindowsInstaller([asset('app-nsis.exe'), asset('app.exe')]).name, 'app-nsis.exe');
});

test('múltiplos exe sem candidato setup único ficam ambíguos', () => {
  assert.equal(selectWindowsInstaller([asset('central.exe'), asset('client.exe')]), 'ambiguous');
  assert.equal(selectWindowsInstaller([asset('app-x64-setup.exe'), asset('app-x86-setup.exe')]), 'ambiguous');
});

test('dados incompletos não são inventados e asset inválido é ignorado', () => {
  const result = parseLatestWindowsRelease({ assets: [asset('installer.exe', { size: undefined })] });
  assert.equal(result.status, 'available');
  assert.equal(result.version, null);
  assert.equal(result.publishedAt, null);
  assert.equal(result.asset.sizeBytes, null);
  assert.deepEqual(parseLatestWindowsRelease({ assets: [asset('installer.exe', { browser_download_url: 'http://example.com/a.exe' })] }), { status: 'no-installer' });
});

test('404 representa ausência de release e erro HTTP é propagado para a interface', async () => {
  const missing = await getLatestWindowsRelease({ refresh: true, fetcher: async () => ({ status: 404, ok: false }) });
  assert.deepEqual(missing, { status: 'not-published' });
  await assert.rejects(
    getLatestWindowsRelease({ refresh: true, fetcher: async () => ({ status: 503, ok: false }) }),
    /HTTP 503/
  );
});

test('consulta a API pública do repositório e trata falha de rede', async () => {
  let requestedUrl = '';
  const result = await getLatestWindowsRelease({
    refresh: true,
    fetcher: async (url) => { requestedUrl = String(url); return { status: 200, ok: true, json: async () => ({ tag_name: 'v2', assets: [asset('setup.exe')] }) }; }
  });
  assert.equal(requestedUrl, 'https://api.github.com/repos/Kaique-Lacerda/centralsos/releases/latest');
  assert.equal(result.status, 'available');
  await assert.rejects(getLatestWindowsRelease({ refresh: true, fetcher: async () => { throw new Error('offline'); } }), /offline/);
});
