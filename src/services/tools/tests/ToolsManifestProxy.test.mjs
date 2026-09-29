import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../../../../server/ToolsManifestProxy.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false
});
const { loadToolsManifestFromRelease, ToolsManifestProxyError } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

const releaseUrl = 'https://api.github.com/repos/Kaique-Lacerda/centralsos/releases/tags/tools-v0.1.0';
const assetUrl = 'https://api.github.com/repos/Kaique-Lacerda/centralsos/releases/assets/598660683';
const manifest = { schemaVersion: 1, release: 'tools-v0.1.0', tools: [] };
const response = (body, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
  text: async () => typeof body === 'string' ? body : JSON.stringify(body)
});

test('proxy consulta a Release e asset de manifesto fixos no servidor', async () => {
  const requests = [];
  const payload = await loadToolsManifestFromRelease('tools-v0.1.0', async (url, init) => {
    requests.push({ url: String(url), headers: init.headers });
    if (String(url) === releaseUrl) {
      return response({
        tag_name: 'tools-v0.1.0',
        assets: [{ name: 'tools-manifest.json', url: assetUrl }]
      });
    }
    if (String(url) === assetUrl) return response(JSON.stringify(manifest));
    throw new Error(`URL inesperada: ${url}`);
  });

  assert.deepEqual(payload, manifest);
  assert.deepEqual(requests, [
    { url: releaseUrl, headers: { Accept: 'application/vnd.github+json' } },
    { url: assetUrl, headers: { Accept: 'application/octet-stream' } }
  ]);
});

test('não aceita tag fora do formato e não permite transformar o proxy em URL arbitrária', async () => {
  let requested = false;
  await assert.rejects(
    loadToolsManifestFromRelease('https://example.com/manifest.json', async () => { requested = true; return response({}); }),
    error => error instanceof ToolsManifestProxyError && error.statusCode === 400
  );
  assert.equal(requested, false);
});

test('retorna 404 lógico quando a Release não existe', async () => {
  await assert.rejects(
    loadToolsManifestFromRelease('tools-v0.1.0', async () => response({}, 404)),
    error => error instanceof ToolsManifestProxyError && error.statusCode === 404
  );
});

test('exige tag exata, Release publicada e um único manifesto na URL oficial de asset', async () => {
  const wrongTagFetcher = async () => response({ tag_name: 'tools-v0.2.0', assets: [] });
  await assert.rejects(loadToolsManifestFromRelease('tools-v0.1.0', wrongTagFetcher), error => error.statusCode === 404);

  const draftFetcher = async () => response({ tag_name: 'tools-v0.1.0', draft: true, assets: [] });
  await assert.rejects(loadToolsManifestFromRelease('tools-v0.1.0', draftFetcher), error => error.statusCode === 404);

  const duplicateManifestsFetcher = async () => response({
    tag_name: 'tools-v0.1.0',
    assets: [
      { name: 'tools-manifest.json', url: assetUrl },
      { name: 'tools-manifest.json', url: assetUrl }
    ]
  });
  await assert.rejects(loadToolsManifestFromRelease('tools-v0.1.0', duplicateManifestsFetcher), error => error.statusCode === 404);

  const externalAssetFetcher = async () => response({
    tag_name: 'tools-v0.1.0',
    assets: [{ name: 'tools-manifest.json', url: 'https://example.com/manifest.json' }]
  });
  await assert.rejects(loadToolsManifestFromRelease('tools-v0.1.0', externalAssetFetcher), error => error.statusCode === 404);
});

test('recusa conteúdo que não seja JSON e trata falhas do GitHub como erro de proxy', async () => {
  const invalidJsonFetcher = async url => String(url) === releaseUrl
    ? response({ tag_name: 'tools-v0.1.0', assets: [{ name: 'tools-manifest.json', url: assetUrl }] })
    : response('{ invalid json');
  await assert.rejects(loadToolsManifestFromRelease('tools-v0.1.0', invalidJsonFetcher), error => error.statusCode === 502);

  const failedAssetFetcher = async url => String(url) === releaseUrl
    ? response({ tag_name: 'tools-v0.1.0', assets: [{ name: 'tools-manifest.json', url: assetUrl }] })
    : response({}, 503);
  await assert.rejects(loadToolsManifestFromRelease('tools-v0.1.0', failedAssetFetcher), error => error.statusCode === 502);
});
