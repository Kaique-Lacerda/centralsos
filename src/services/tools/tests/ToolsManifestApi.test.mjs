import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';

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

test('a Function compilada em ESM resolve o módulo server pelo specifier .js', async () => {
  const projectRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const apiEntry = join(projectRoot, 'api', 'tools-manifest.ts');
  const outputRoot = await mkdtemp(join(tmpdir(), 'central-sos-tools-function-'));

  try {
    const program = ts.createProgram([apiEntry], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      rootDir: projectRoot,
      outDir: outputRoot,
      strict: true,
      skipLibCheck: true,
      noEmitOnError: true
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    assert.deepEqual(diagnostics, [], diagnostics.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')).join('\n'));

    const emitResult = program.emit();
    assert.equal(emitResult.emitSkipped, false);

    const compiledApi = join(outputRoot, 'api', 'tools-manifest.js');
    const compiledProxy = join(outputRoot, 'server', 'ToolsManifestProxy.js');
    await writeFile(join(outputRoot, 'package.json'), JSON.stringify({ type: 'module' }));
    const emittedApiSource = await readFile(compiledApi, 'utf8');
    const emittedProxySource = await readFile(compiledProxy, 'utf8');
    const relativeImports = [...emittedApiSource.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)].map(match => match[1]);
    assert.deepEqual(relativeImports, ['../server/ToolsManifestProxy.js']);
    assert.match(emittedProxySource, /loadToolsManifestFromRelease/);

    const { default: handler } = await import(`${pathToFileURL(compiledApi).href}?esm-smoke=${Date.now()}`);
    const res = responseSink();
    await handler({ method: 'GET' }, res);
    assert.equal(res.statusCode, 400);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});
