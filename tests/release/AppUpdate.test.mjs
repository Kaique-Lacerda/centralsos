import test from 'node:test';
import assert from 'node:assert/strict';
import { loadReleaseModule } from '../../scripts/release-config.mjs';
const { APPLICATION_API, selectStableApplicationRelease, loadApplicationUpdate, validateReleaseUpdate } = await loadReleaseModule('server/AppUpdateService.ts');
const { createAppUpdateHandler } = await loadReleaseModule('api/app-update.ts');
const { applicationVersion, compareVersions } = await loadReleaseModule();

export function releaseFixture(tag = 'v0.1.0') {
  const name = 'CENTRAL SOS_0.1.0_x64-setup.exe';
  const prefix = `https://github.com/Kaique-Lacerda/centralsos/releases/download/${tag}/`;
  const asset = (name, id) => ({ name, url: `${APPLICATION_API}/releases/assets/${id}`, browser_download_url: prefix + encodeURIComponent(name) });
  const release = { id: 17, tag_name: tag, draft: false, prerelease: false, assets: [asset('latest.json', 1), asset(name, 2), asset(name + '.sig', 3)] };
  const manifest = { version: tag.slice(1), notes: 'Release fixture', pub_date: '2026-10-07T12:00:00Z', platforms: { 'windows-x86_64': { url: release.assets[1].browser_download_url, signature: 'mock-signature-not-operational' } } };
  return { release, manifest };
}
export const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => typeof value === 'string' ? value : JSON.stringify(value), json: async () => value });
function fixtureFetcher(fixture, options = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (options.network) throw Error('network fixture');
    if (options.http) return response({}, options.http);
    if (url.includes('/releases?')) return response(options.releases ?? [fixture.release]);
    if (url.endsWith('/1')) return response(options.manifest ?? fixture.manifest);
    if (url.endsWith('/3')) return response(options.signature ?? fixture.manifest.platforms['windows-x86_64'].signature);
    throw Error(`Unexpected URL: ${url}`);
  };
  return { fetcher, calls };
}

test('seleciona maior versão APP; ignora Tools, beta, draft e tags inválidas', () => {
  const tags = ['v0.1.0', 'tools-v0.1.0', 'v0.0.1', 'tools-v0.2.0'];
  assert.equal(selectStableApplicationRelease(tags.map(tag_name => ({ tag_name }))).tag_name, 'v0.1.0');
  assert.equal(selectStableApplicationRelease([{ tag_name: 'v0.9.0' }, { tag_name: 'v0.10.0' }, { tag_name: 'v9.0.0', draft: true }, { tag_name: 'v8.0.0', prerelease: true }]).tag_name, 'v0.10.0');
  for (const tag of ['tools-v0.2.0', 'v0.1.0-test', 'v01.0.0', '0.1.0', 'v1.0', 'v1.2.3+build', 'v1.2.3\n']) assert.equal(applicationVersion(tag), null);
  assert.equal(selectStableApplicationRelease([{ tag_name: 'tools-v0.2.0' }]), null);
  assert.equal(compareVersions('999999999999999999999.0.0', '999999999999999999998.0.0'), 1);
});
test('maior versão duplicada é ambígua; duplicidade de versão antiga não afeta a maior', () => {
  assert.throws(() => selectStableApplicationRelease([{ tag_name: 'v0.2.0' }, { tag_name: 'v0.2.0' }]), /ambíguas/);
  assert.equal(selectStableApplicationRelease([{ tag_name: 'v0.1.0' }, { tag_name: 'v0.1.0' }, { tag_name: 'v0.2.0' }]).tag_name, 'v0.2.0');
});
test('reutiliza latest.json e .sig oficiais, sem /releases/latest ou credenciais', async () => {
  const f = releaseFixture(), { fetcher, calls } = fixtureFetcher(f);
  assert.deepEqual(await loadApplicationUpdate(fetcher), f.manifest);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].init.headers.Accept, 'application/octet-stream');
  assert.ok(calls.every(c => !c.url.endsWith('/latest') && !c.init.headers.Authorization));
});
test('paginação encontra versão em página posterior e não depende da ordem', async () => {
  const f = releaseFixture('v0.2.0');
  const { fetcher } = fixtureFetcher(f);
  const result = await loadApplicationUpdate((url, init) => url.endsWith('page=1')
    ? Promise.resolve(response(Array.from({ length: 100 }, () => ({ tag_name: 'tools-v0.1.0' })))) : fetcher(url, init));
  assert.equal(result.version, '0.2.0');
});
test('não faz fallback para versão antiga quando a maior não tem artefatos válidos', async () => {
  const f = releaseFixture(), { fetcher } = fixtureFetcher(f, { releases: [f.release, { tag_name: 'v0.2.0', assets: [] }] });
  await assert.rejects(loadApplicationUpdate(fetcher), /latest.json/);
});
test('latest.json precisa corresponder à tag, ao instalador e à assinatura na mesma Release', () => {
  const f = releaseFixture();
  assert.deepEqual(validateReleaseUpdate(f.manifest, f.release), f.manifest);
  assert.throws(() => validateReleaseUpdate({ ...f.manifest, version: '0.2.0' }, f.release), /diverge/);
  for (const url of ['http://github.com/app.exe', 'https://evil.example.test/app.exe', f.manifest.platforms['windows-x86_64'].url + '?other=1']) {
    assert.throws(() => validateReleaseUpdate({ ...f.manifest, platforms: { 'windows-x86_64': { url, signature: 'mock' } } }, f.release));
  }
  assert.throws(() => validateReleaseUpdate(f.manifest, { ...f.release, assets: f.release.assets.slice(0, 2) }), /\.sig/);
  assert.throws(() => validateReleaseUpdate({ ...f.manifest, platforms: { 'windows-x86_64': { ...f.manifest.platforms['windows-x86_64'], signature: '' } } }, f.release), /contrato/);
  assert.throws(() => validateReleaseUpdate({ ...f.manifest, pub_date: 'not-a-date' }, f.release), /contrato/);
});
test('recusa assinatura divergente, JSON inválido, HTTP e falha de conexão', async () => {
  for (const options of [{ signature: 'different' }, { manifest: '{invalid' }, { http: 403 }, { http: 500 }, { network: true }]) {
    const { fetcher } = fixtureFetcher(releaseFixture(), options);
    await assert.rejects(loadApplicationUpdate(fetcher));
  }
});
test('ausência de APP/404 retorna null, mesmo quando há Tools', async () => {
  for (const options of [{ releases: [] }, { releases: [{ tag_name: 'tools-v0.1.0' }] }, { http: 404 }]) {
    const { fetcher } = fixtureFetcher(releaseFixture(), options);
    assert.equal(await loadApplicationUpdate(fetcher), null);
  }
});
test('API devolve 200/204/405/502, com cache apenas na resposta válida', async () => {
  for (const { method, options, expected } of [
    { method: 'GET', options: {}, expected: 200 }, { method: 'GET', options: { releases: [] }, expected: 204 },
    { method: 'POST', options: {}, expected: 405 }, { method: 'GET', options: { http: 500 }, expected: 502 }
  ]) {
    const { fetcher, calls } = fixtureFetcher(releaseFixture(), options);
    const result = { headers: {}, body: undefined, code: 0 };
    const res = { status(code) { result.code = code; return this; }, setHeader(name, value) { result.headers[name] = value; return this; }, json(body) { result.body = body; }, end() {} };
    await createAppUpdateHandler(fetcher)({ method }, res);
    assert.equal(result.code, expected);
    assert.equal(result.headers['Cache-Control'], expected === 200 ? 'public, s-maxage=60' : 'no-store');
    if (expected === 204) assert.equal(result.body, undefined);
    if (expected === 405) { assert.equal(calls.length, 0); assert.equal(result.headers.Allow, 'GET'); }
  }
});
