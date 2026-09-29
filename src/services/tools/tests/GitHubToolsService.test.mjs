import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../GitHubToolsService.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false
});
const {
  getGitHubToolsCatalog,
  getToolsManifestRequest,
  selectToolsRelease,
  validateToolsManifest
} = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

const assetUrl = tag => `https://api.github.com/repos/Kaique-Lacerda/centralsos/releases/assets/${tag === 'tools-v0.1.0' ? 10 : 20}`;
const downloadUrl = (tag, name) => `https://github.com/Kaique-Lacerda/centralsos/releases/download/${tag}/${name}`;
const manifestFor = (release = 'tools-v0.1.0', overrides = {}) => ({
  schemaVersion: 1,
  release,
  tools: [{
    id: 'firebird-2-5-9',
    name: 'Firebird 2.5.9',
    description: 'Servidor de banco de dados utilizado nos ambientes.',
    version: '2.5.9',
    type: 'installer',
    assetName: 'Firebird-2.5.9.exe',
    requiresAdmin: true,
    architecture: 'x64',
    sha256: 'a'.repeat(64),
    ...overrides
  }]
});
const releaseWith = (tag = 'tools-v0.1.0', assets = [], publishedAt = '2026-09-28T12:00:00Z', overrides = {}) => ({
  tag_name: tag,
  published_at: publishedAt,
  assets,
  ...overrides
});
const releaseAsset = (tag, name, id, size = 1024) => ({
  name,
  url: assetUrl(tag),
  browser_download_url: downloadUrl(tag, name),
  size
});
const response = (body, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
  text: async () => typeof body === 'string' ? body : JSON.stringify(body)
});

function catalogFetcher(releases, manifest, manifestStatus = 200) {
  return async (url, init) => {
    if (String(url).includes('/releases?')) return response(releases);
    if (String(url).startsWith('/api/tools-manifest?')) {
      assert.equal(init.headers.Accept, 'application/json');
      return response(manifest, manifestStatus);
    }
    if (String(url).includes('/releases/assets/')) {
      assert.equal(init.headers.Accept, 'application/octet-stream');
      return response(manifest, manifestStatus);
    }
    throw new Error(`URL inesperada no teste: ${url}`);
  };
}

test('usa a rota same-origin no browser e preserva o endpoint do asset no Desktop', () => {
  const releaseManifestUrl = assetUrl('tools-v0.1.0');
  assert.deepEqual(getToolsManifestRequest('tools-v0.1.0', releaseManifestUrl, 'web'), {
    url: '/api/tools-manifest?tag=tools-v0.1.0',
    accept: 'application/json'
  });
  assert.deepEqual(getToolsManifestRequest('tools-v0.1.0', releaseManifestUrl, 'desktop'), {
    url: releaseManifestUrl,
    accept: 'application/octet-stream'
  });
});

test('filtra apenas tags tools-* e seleciona a maior versão sem confundir releases do app', () => {
  const selected = selectToolsRelease([
    releaseWith('v9.9.9'),
    releaseWith('tools-v0.9.0'),
    releaseWith('tools-v0.10.0'),
    releaseWith('tools-v0.99.0', [], '2026-01-01T00:00:00Z', { draft: true })
  ]);
  assert.equal(selected.tag_name, 'tools-v0.10.0');
  assert.equal(selectToolsRelease([releaseWith('v0.1.0')]), null);
});

test('usa somente tags tools-vMAJOR.MINOR.PATCH na seleção do catálogo', () => {
  const selected = selectToolsRelease([
    releaseWith('v0.1.0'),
    releaseWith('tools-v0.1.0'),
    releaseWith('v0.0.1'),
    releaseWith('tools-v0.2.0')
  ]);
  assert.equal(selected.tag_name, 'tools-v0.2.0');
  assert.equal(selectToolsRelease([
    releaseWith('tools-0.9.0'),
    releaseWith('tools-v0.10.0-beta.1'),
    releaseWith('tools-v00.10.0')
  ]), null);
});

test('valida manifesto e vincula manifesto à tag da Release', () => {
  const parsed = validateToolsManifest(manifestFor(), 'tools-v0.1.0');
  assert.equal(parsed.valid, true);
  assert.equal(parsed.tools[0].id, 'firebird-2-5-9');
  assert.equal(validateToolsManifest(manifestFor('tools-v0.2.0'), 'tools-v0.1.0').valid, false);
});

test('rejeita manifesto inválido, campos ausentes e hash fora do formato SHA-256', () => {
  assert.equal(validateToolsManifest(null, 'tools-v0.1.0').valid, false);
  assert.equal(validateToolsManifest({ ...manifestFor(), schemaVersion: 2 }, 'tools-v0.1.0').valid, false);
  assert.equal(validateToolsManifest(manifestFor('tools-v0.1.0', { sha256: 'invalid' }), 'tools-v0.1.0').valid, false);
  assert.equal(validateToolsManifest(manifestFor('tools-v0.1.0', { requiresAdmin: 'yes' }), 'tools-v0.1.0').valid, false);
});

test('consulta Releases sem usar o endpoint latest do aplicativo', async () => {
  let requestUrl = '';
  const fetcher = async url => { requestUrl = String(url); return response([]); };
  const result = await getGitHubToolsCatalog({ refresh: true, fetcher });
  assert.equal(result.status, 'not-published');
  assert.equal(requestUrl, 'https://api.github.com/repos/Kaique-Lacerda/centralsos/releases?per_page=100');
  assert.equal(requestUrl.endsWith('/releases/latest'), false);
});

test('retorna estado sem Release de Tools e não trata Release normal do app como catálogo', async () => {
  const result = await getGitHubToolsCatalog({ refresh: true, fetcher: async () => response([releaseWith('v0.1.0')]) });
  assert.deepEqual(result, { status: 'not-published' });
});

test('trata Release de Tools sem tools-manifest.json', async () => {
  const result = await getGitHubToolsCatalog({ refresh: true, fetcher: async () => response([releaseWith('tools-v0.1.0', [releaseAsset('tools-v0.1.0', 'tool.exe', 1)])]) });
  assert.equal(result.status, 'manifest-missing');
});

test('resolve asset pelo nome exato e retorna URL e tamanho oficiais da Release', async () => {
  const manifestAsset = { name: 'tools-manifest.json', url: assetUrl('tools-v0.1.0') };
  const binary = releaseAsset('tools-v0.1.0', 'Firebird-2.5.9.exe', 12, 2_000_000);
  const result = await getGitHubToolsCatalog({
    refresh: true,
    fetcher: catalogFetcher([releaseWith('tools-v0.1.0', [manifestAsset, binary])], manifestFor())
  });
  assert.equal(result.status, 'available');
  assert.equal(result.release.tagName, 'tools-v0.1.0');
  assert.equal(result.tools[0].assetStatus, 'available');
  assert.equal(result.tools[0].downloadUrl, binary.browser_download_url);
  assert.equal(result.tools[0].sizeBytes, 2_000_000);
  assert.equal(result.tools[0].sha256, 'a'.repeat(64));
});

test('asset ausente mantém ferramenta visível e bloqueia o download', async () => {
  const result = await getGitHubToolsCatalog({
    refresh: true,
    fetcher: catalogFetcher([releaseWith('tools-v0.1.0', [{ name: 'tools-manifest.json', url: assetUrl('tools-v0.1.0') }])], manifestFor())
  });
  assert.equal(result.status, 'available');
  assert.equal(result.tools[0].assetStatus, 'missing');
  assert.equal(result.tools[0].downloadUrl, null);
});

test('nome do asset divergente é sinalizado e não associado', async () => {
  const result = await getGitHubToolsCatalog({
    refresh: true,
    fetcher: catalogFetcher([releaseWith('tools-v0.1.0', [
      { name: 'tools-manifest.json', url: assetUrl('tools-v0.1.0') },
      releaseAsset('tools-v0.1.0', 'Firebird-2.5.9-x64.exe', 11)
    ])], manifestFor())
  });
  assert.equal(result.status, 'available');
  assert.equal(result.tools[0].assetStatus, 'name-mismatch');
  assert.equal(result.tools[0].actualAssetName, 'Firebird-2.5.9-x64.exe');
  assert.equal(result.tools[0].downloadUrl, null);
});

test('JSON inválido no asset do manifesto gera estado específico', async () => {
  const result = await getGitHubToolsCatalog({
    refresh: true,
    fetcher: catalogFetcher([releaseWith('tools-v0.1.0', [{ name: 'tools-manifest.json', url: assetUrl('tools-v0.1.0') }])], '{ invalid json')
  });
  assert.equal(result.status, 'manifest-invalid');
  assert.match(result.reason, /JSON válido/);
});

test('erro HTTP e falha de rede são reportados ao chamador', async () => {
  await assert.rejects(getGitHubToolsCatalog({ refresh: true, fetcher: async () => response({}, 503) }), /HTTP 503/);
  await assert.rejects(getGitHubToolsCatalog({ refresh: true, fetcher: async () => { throw new Error('offline'); } }), /offline/);
});
