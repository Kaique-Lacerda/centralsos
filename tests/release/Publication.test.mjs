import test from 'node:test';
import assert from 'node:assert/strict';
import { publishVerifiedRelease } from '../../scripts/release-publish.mjs';
const api = 'https://api.github.com/repos/Kaique-Lacerda/centralsos';
const env = { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'Kaique-Lacerda/centralsos', GITHUB_SHA: 'a'.repeat(40), GITHUB_TOKEN: 'mock-not-operational', RELEASE_TAG: 'v0.2.0' };
function fixture(options = {}) {
  const calls = [], name = 'CENTRAL SOS_0.2.0_x64-setup.exe', download = `https://github.com/Kaique-Lacerda/centralsos/releases/download/v0.2.0/${encodeURIComponent(name)}`;
  const asset = (name, id, browser_download_url) => ({ name, url: `${api}/releases/assets/${id}`, browser_download_url });
  const manifest = { version: '0.2.0', platforms: { 'windows-x86_64': { url: download, signature: 'mock-signature' } } };
  const release = { id: 17, tag_name: env.RELEASE_TAG, draft: true, prerelease: false, target_commitish: env.GITHUB_SHA,
    assets: [asset('latest.json', 1), asset(name, 2, download), asset(name + '.sig', 3)], ...options.release };
  if (options.untagged) release.assets[1].browser_download_url = download.replace('/download/v0.2.0/', '/download/untagged-fixture/');
  if (options.foreign) release.assets[1].browser_download_url = download.replace('github.com/Kaique-Lacerda/centralsos', 'github.com/other/repository');
  const response = value => ({ ok: true, status: 200, json: async () => value, text: async () => typeof value === 'string' ? value : JSON.stringify(value) });
  return { calls, fetcher: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/tags/v0.2.0')) return response(release);
    if (url.endsWith('/assets/1')) return response(options.manifest ?? manifest);
    if (url.endsWith('/assets/3')) return response(options.signature ?? 'mock-signature');
    if (url.endsWith('/releases/17') && init.method === 'PATCH') return response({ ...release, draft: false, html_url: 'https://github.com/Kaique-Lacerda/centralsos/releases/tag/v0.2.0' });
    throw Error('Unexpected request');
  } };
}
test('publica draft somente depois de validar manifesto e assinaturas oficiais', async () => {
  const f = fixture();
  assert.equal(await publishVerifiedRelease(env, f.fetcher), 'https://github.com/Kaique-Lacerda/centralsos/releases/tag/v0.2.0');
  const last = f.calls.at(-1);
  assert.equal(last.init.method, 'PATCH');
  assert.deepEqual(JSON.parse(last.init.body), { draft: false, prerelease: false, make_latest: 'true' });
  assert.ok(f.calls.slice(0, -1).every(call => !call.init.method || call.init.method === 'GET'));
});
test('aceita metadata untagged de draft mas mantém latest.json apontando para a tag final', async () => {
  const f = fixture({ untagged: true });
  await publishVerifiedRelease(env, f.fetcher);
  assert.equal(f.calls.at(-1).init.method, 'PATCH');
  assert.ok(f.calls.every(call => !call.url.includes('untagged-')));
});
test('falhas não executam PATCH: origem, draft, commit, manifesto ou assinatura', async () => {
  for (const options of [{ release: { draft: false } }, { release: { prerelease: true } }, { release: { target_commitish: 'b'.repeat(40) } }, { release: { assets: [] } }, { manifest: { version: '0.3.0' } }, { signature: 'wrong' }, { foreign: true }]) {
    const f = fixture(options); await assert.rejects(publishVerifiedRelease(env, f.fetcher));
    assert.equal(f.calls.some(call => call.init.method === 'PATCH'), false);
  }
  const f = fixture();
  await assert.rejects(publishVerifiedRelease({ ...env, GITHUB_REF: 'refs/heads/feature/test' }, f.fetcher));
  await assert.rejects(publishVerifiedRelease({ ...env, RELEASE_TAG: '' }, f.fetcher));
  assert.equal(f.calls.length, 0);
});
