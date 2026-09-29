import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../../../../api/tools-manifest.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false
});
const { createToolsManifestHandler } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);

const releaseUrl = 'https://api.github.com/repos/Kaique-Lacerda/centralsos/releases/tags/tools-v0.1.0';
const assetUrl = 'https://api.github.com/repos/Kaique-Lacerda/centralsos/releases/assets/598660683';
const manifest = { schemaVersion: 1, release: 'tools-v0.1.0', tools: [] };
const response = (body, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
  text: async () => typeof body === 'string' ? body : JSON.stringify(body)
});

function responseSink() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('Vercel GET expõe o manifesto pela rota same-origin e habilita cache público curto', async () => {
  const fetcher = async url => String(url) === releaseUrl
    ? response({ tag_name: 'tools-v0.1.0', assets: [{ name: 'tools-manifest.json', url: assetUrl }] })
    : response(JSON.stringify(manifest));
  const res = responseSink();
  await createToolsManifestHandler(fetcher)({ method: 'GET', query: { tag: 'tools-v0.1.0' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Cache-Control'], 'public, s-maxage=300, stale-while-revalidate=600');
  assert.deepEqual(res.body, manifest);
});

test('Vercel route aceita somente GET e exige tag de ferramenta', async () => {
  const handler = createToolsManifestHandler(async () => response({}));
  const methodResponse = responseSink();
  await handler({ method: 'POST', query: { tag: 'tools-v0.1.0' } }, methodResponse);
  assert.equal(methodResponse.statusCode, 405);
  assert.equal(methodResponse.headers.Allow, 'GET');

  const tagResponse = responseSink();
  await handler({ method: 'GET', query: { tag: 'main' } }, tagResponse);
  assert.equal(tagResponse.statusCode, 400);
});
