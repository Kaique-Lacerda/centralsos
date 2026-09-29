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
const { getLatestWindowsRelease, parseLatestWindowsRelease, selectApplicationRelease, selectWindowsInstaller } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const asset = (name, overrides = {}) => ({ name, browser_download_url: `https://github.com/Kaique-Lacerda/centralsos/releases/download/v0.1.0/${name}`, size: 1000, ...overrides });
const release = (tag_name, assets = [asset('CENTRAL.SOS_0.1.0_x64-setup.exe')], overrides = {}) => ({ tag_name, published_at: '2026-09-28T12:00:00Z', assets, ...overrides });

test('filtra tags de Tools e seleciona a maior versão semver do aplicativo', () => {
  const result = parseLatestWindowsRelease([
    release('v0.1.0'),
    release('tools-v0.1.0'),
    release('v0.0.1'),
    release('tools-v0.2.0')
  ]);
  assert.equal(result.status, 'available');
  assert.equal(result.version, 'v0.1.0');
  assert.equal(result.publishedAt, '2026-09-28T12:00:00Z');
  assert.equal(result.asset.name, 'CENTRAL.SOS_0.1.0_x64-setup.exe');
  assert.equal(result.asset.sizeBytes, 1000);
});

test('não há Release de aplicativo quando a lista está vazia ou contém apenas Tools', () => {
  assert.deepEqual(parseLatestWindowsRelease([]), { status: 'not-published' });
  assert.deepEqual(parseLatestWindowsRelease([release('tools-v0.1.0')]), { status: 'not-published' });
});

test('ignora tags inválidas, prereleases e drafts', () => {
  const releases = [
    release('v1'),
    release('v0.1.0-beta.1'),
    release('v00.1.0'),
    release('tools-v9.9.9'),
    release('v9.9.9', [], { draft: true })
  ];
  assert.deepEqual(selectApplicationRelease(releases), { status: 'not-published' });
  assert.deepEqual(parseLatestWindowsRelease(releases), { status: 'not-published' });
});

test('versão maior duplicada fica ambígua em vez de selecionar uma Release arbitrariamente', () => {
  const duplicateReleases = [release('v0.1.0'), release('v0.1.0')];
  assert.deepEqual(selectApplicationRelease(duplicateReleases), { status: 'ambiguous' });
  assert.deepEqual(parseLatestWindowsRelease(duplicateReleases), { status: 'ambiguous-release' });
});

test('seleção semver compara componentes numericamente', () => {
  const result = parseLatestWindowsRelease([release('v0.9.0'), release('v0.10.0')]);
  assert.equal(result.status, 'available');
  assert.equal(result.version, 'v0.10.0');
});

test('Release de aplicativo selecionada sem exe retorna estado distinto', () => {
  assert.deepEqual(parseLatestWindowsRelease([release('v0.1.0', [])]), { status: 'no-installer' });
  assert.deepEqual(parseLatestWindowsRelease([release('v0.1.0', [asset('installer.msi')])]), { status: 'no-installer' });
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
  const result = parseLatestWindowsRelease([release('v0.1.0', [asset('installer.exe', { size: undefined })], { published_at: undefined })]);
  assert.equal(result.status, 'available');
  assert.equal(result.version, 'v0.1.0');
  assert.equal(result.publishedAt, null);
  assert.equal(result.asset.sizeBytes, null);
  assert.deepEqual(parseLatestWindowsRelease([release('v0.1.0', [asset('installer.exe', { browser_download_url: 'http://example.com/a.exe' })])]), { status: 'no-installer' });
});

test('404 representa ausência de release e erro HTTP é propagado para a interface', async () => {
  const missing = await getLatestWindowsRelease({ refresh: true, fetcher: async () => ({ status: 404, ok: false }) });
  assert.deepEqual(missing, { status: 'not-published' });
  await assert.rejects(
    getLatestWindowsRelease({ refresh: true, fetcher: async () => ({ status: 503, ok: false }) }),
    /HTTP 503/
  );
});

test('consulta a lista de Releases sem usar /releases/latest', async () => {
  const requestedUrls = [];
  const result = await getLatestWindowsRelease({
    refresh: true,
    fetcher: async url => {
      requestedUrls.push(String(url));
      return { status: 200, ok: true, json: async () => [release('v0.1.0'), release('tools-v0.2.0'), release('v0.0.1')] };
    }
  });
  assert.deepEqual(requestedUrls, ['https://api.github.com/repos/Kaique-Lacerda/centralsos/releases?per_page=100&page=1']);
  assert.equal(result.status, 'available');
  assert.equal(result.version, 'v0.1.0');
  await assert.rejects(getLatestWindowsRelease({ refresh: true, fetcher: async () => { throw new Error('offline'); } }), /offline/);
});

test('consulta páginas seguintes para selecionar a maior versão semver', async () => {
  const requestedUrls = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => release(`v0.0.${index}`));
  const result = await getLatestWindowsRelease({
    refresh: true,
    fetcher: async url => {
      requestedUrls.push(String(url));
      return {
        status: 200,
        ok: true,
        json: async () => String(url).endsWith('page=1') ? firstPage : [release('v0.2.0')]
      };
    }
  });
  assert.equal(requestedUrls.length, 2);
  assert.match(requestedUrls[1], /page=2$/);
  assert.equal(result.status, 'available');
  assert.equal(result.version, 'v0.2.0');
});
