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
  let patches = 0;
  return { calls, release, manifest, fetcher: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/tags/v0.2.0')) return { ok: false, status: 404 };
    if (url.startsWith(`${api}/releases?per_page=100&page=`)) {
      if (options.listHttp) return { ok: false, status: options.listHttp };
      const page = Number(new URL(url).searchParams.get('page'));
      return response(options.pages?.[page - 1] ?? options.releases ?? [release]);
    }
    if (url.endsWith('/assets/1')) return response(options.manifest ?? manifest);
    if (url.endsWith('/assets/3')) return response(options.signature ?? 'mock-signature');
    if (url.endsWith('/releases/17') && init.method === 'PATCH') {
      if (options.patchFailureOnce && patches++ === 0) return { ok: false, status: 500 };
      return response({ ...release, draft: false, html_url: 'https://github.com/Kaique-Lacerda/centralsos/releases/tag/v0.2.0', ...options.published });
    }
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
  assert.deepEqual(f.calls.map(call => call.url), [`${api}/releases?per_page=100&page=1`, `${api}/releases/assets/1`, `${api}/releases/assets/3`, `${api}/releases/17`]);
  assert.ok(f.calls.every(call => call.init.headers.Authorization === `Bearer ${env.GITHUB_TOKEN}`));
});
test('draft com lookup por tag 404 é encontrado na listagem autenticada, sem depender do lookup', async () => {
  const f = fixture();
  assert.equal((await f.fetcher(`${api}/releases/tags/v0.2.0`, { headers: {} })).status, 404);
  f.calls.length = 0;
  await publishVerifiedRelease(env, f.fetcher);
  assert.equal(f.calls[0].url, `${api}/releases?per_page=100&page=1`);
  assert.ok(f.calls.every(call => !call.url.includes('/tags/')));
});
test('aceita metadata untagged de draft mas mantém latest.json apontando para a tag final', async () => {
  const f = fixture({ untagged: true });
  await publishVerifiedRelease(env, f.fetcher);
  assert.equal(f.calls.at(-1).init.method, 'PATCH');
  assert.ok(f.calls.every(call => !call.url.includes('untagged-')));
  assert.match(f.release.assets[1].browser_download_url, /untagged-fixture/);
  assert.match(f.manifest.platforms['windows-x86_64'].url, /\/download\/v0\.2\.0\//);
});
test('zero drafts compatíveis e dois drafts compatíveis recusam publicação', async () => {
  const compatible = fixture().release;
  for (const releases of [[], [{ ...compatible, tag_name: 'tools-v0.2.0' }], [compatible, { ...compatible, id: 18 }]]) {
    const f = fixture({ releases });
    await assert.rejects(publishVerifiedRelease(env, f.fetcher), /exatamente um draft/);
    assert.equal(f.calls.length, 1);
  }
});
test('draft de outro commit, prerelease, publicado ou ID inválido não é elegível', async () => {
  for (const release of [{ target_commitish: 'b'.repeat(40) }, { target_commitish: 'main' }, { prerelease: true }, { draft: false }, { id: 0 }, { id: '17' }]) {
    const f = fixture({ release });
    await assert.rejects(publishVerifiedRelease(env, f.fetcher));
    assert.equal(f.calls.length, 1);
  }
});
test('outra release da mesma tag é rejeitada mesmo quando só um draft é compatível', async () => {
  const release = fixture().release;
  const f = fixture({ releases: [release, { ...release, id: 18, target_commitish: 'b'.repeat(40) }] });
  await assert.rejects(publishVerifiedRelease(env, f.fetcher), /mesma tag/);
  assert.equal(f.calls.length, 1);
});
test('percorre todas as páginas antes de decidir e detecta ambiguidade na página seguinte', async () => {
  const release = fixture().release;
  const filler = Array.from({ length: 99 }, (_, id) => ({ id: id + 100, tag_name: `tools-v1.0.${id}` }));
  const f = fixture({ pages: [[...filler, release], []] });
  await publishVerifiedRelease(env, f.fetcher);
  assert.equal(f.calls[1].url, `${api}/releases?per_page=100&page=2`);
  const ambiguous = fixture({ pages: [[...filler, release], [{ ...release, id: 18 }]] });
  await assert.rejects(publishVerifiedRelease(env, ambiguous.fetcher), /exatamente um draft/);
  assert.equal(ambiguous.calls.length, 2);
});
test('lista incompleta, inválida ou HTTP de erro não permite publicar', async () => {
  for (const options of [{ listHttp: 403 }, { listHttp: 500 }, { releases: {} }, { releases: Array(100).fill(null) }]) {
    const f = fixture(options);
    await assert.rejects(publishVerifiedRelease(env, f.fetcher));
    assert.ok(f.calls.every(call => !call.init.method));
  }
});
test('latest.json, NSIS e .sig ausentes ou duplicados continuam bloqueando PATCH', async () => {
  const assets = fixture().release.assets;
  for (const index of [0, 1, 2]) {
    for (const invalid of [assets.filter((_, i) => i !== index), [...assets, { ...assets[index] }]]) {
      const f = fixture({ release: { assets: invalid } });
      await assert.rejects(publishVerifiedRelease(env, f.fetcher));
      assert.equal(f.calls.some(call => call.init.method === 'PATCH'), false);
    }
  }
});
test('manifesto precisa manter URLs finais e assinatura correspondente, sem reescrita de conteúdo', async () => {
  for (const change of [{ url: 'https://github.com/Kaique-Lacerda/centralsos/releases/download/untagged-fixture/setup.exe' }, { signature: '' }, { url: 'https://example.test/setup.exe' }]) {
    const manifest = fixture().manifest;
    Object.assign(manifest.platforms['windows-x86_64'], change);
    const f = fixture({ manifest });
    await assert.rejects(publishVerifiedRelease(env, f.fetcher));
    assert.equal(f.calls.some(call => call.init.method === 'PATCH'), false);
  }
});
test('rerun após falha na assinatura reutiliza o mesmo draft sem criar release ou assets', async () => {
  const options = { untagged: true, signature: 'wrong' }, f = fixture(options);
  const before = JSON.stringify(f.release);
  await assert.rejects(publishVerifiedRelease(env, f.fetcher), /Assinatura/);
  options.signature = 'mock-signature';
  await publishVerifiedRelease(env, f.fetcher);
  assert.equal(JSON.stringify(f.release), before);
  assert.equal(f.calls.filter(call => call.init.method === 'PATCH').length, 1);
  assert.ok(f.calls.every(call => !call.init.method || call.init.method === 'PATCH' && call.url === `${api}/releases/17`));
});
test('rerun após HTTP 500 na publicação revalida todos os assets e usa novamente o mesmo ID', async () => {
  const f = fixture({ patchFailureOnce: true });
  await assert.rejects(publishVerifiedRelease(env, f.fetcher), /publicação com HTTP 500/);
  await publishVerifiedRelease(env, f.fetcher);
  assert.equal(f.calls.filter(call => call.url === `${api}/releases/assets/1`).length, 2);
  assert.equal(f.calls.filter(call => call.url === `${api}/releases/assets/3`).length, 2);
  assert.equal(f.calls.filter(call => call.init.method === 'PATCH').length, 2);
  assert.ok(f.calls.every(call => !call.init.method || call.url === `${api}/releases/17`));
});
test('confirmação de publicação precisa preservar ID, tag, commit e estado', async () => {
  for (const published of [{ id: 18 }, { target_commitish: 'b'.repeat(40) }, { tag_name: 'v0.3.0' }, { draft: true }, { prerelease: true }]) {
    const f = fixture({ published });
    await assert.rejects(publishVerifiedRelease(env, f.fetcher), /não confirmou/);
  }
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
