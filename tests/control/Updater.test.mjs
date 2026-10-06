import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from './load.mjs';
const { createUpdater } = await load('src/services/updater/UpdaterService.ts');
const { compareVersions, parseLatestManifest } = await load('src/services/updater/UpdateContract.ts');
test('comparação de versão numérica, sem usar ordem textual ou tags Tools', () => {
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1); assert.equal(compareVersions('0.1.0', '0.1.0'), 0); assert.equal(compareVersions('0.1.0', '1.0.0'), -1);
  assert.throws(() => compareVersions('tools-v0.2.0', '0.1.0'));
});
test('latest.json exige HTTPS, plataforma Windows e assinatura', () => {
  const manifest = { version: '0.2.0', platforms: { 'windows-x86_64': { url: 'https://example.test/app.exe', signature: 'fixture-signature' } } };
  assert.equal(parseLatestManifest(manifest).version, '0.2.0');
  for (const value of [null, {}, { version: 'tools-v0.1.0', platforms: {} }, { ...manifest, platforms: {} }, { ...manifest, platforms: { 'windows-x86_64': { url: 'http://example.test/app.exe', signature: 'x' } } }, { ...manifest, platforms: { 'windows-x86_64': { url: 'https://example.test/app.exe', signature: '' } } }]) assert.throws(() => parseLatestManifest(value));
});
function fixture({ runtime = 'desktop', configured = true, version = '0.2.0', signatureFails = false } = {}) {
  const calls = []; const candidate = version ? { version, close: async () => calls.push('close'), downloadAndInstall: async () => { calls.push('install'); if (signatureFails) throw Error('Invalid signature'); } } : null;
  return { calls, updater: createUpdater(runtime, async () => ({ configured }), async () => '0.1.0', async () => { calls.push('check'); return candidate; }, async () => calls.push('restart')) };
}
test('detecta update e só instala/reinicia com confirmação explícita', async () => {
  const f = fixture(); await f.updater.verify(); assert.equal(f.updater.getState().availableVersion, '0.2.0'); assert.deepEqual(f.calls, ['check']);
  await assert.rejects(f.updater.install(false), /confirmação/); assert.deepEqual(f.calls, ['check']);
  await f.updater.install(true); assert.deepEqual(f.calls, ['check', 'install', 'restart']);
});
test('sem update ou downgrade não existe candidato instalável', async () => {
  for (const version of [null, '0.1.0', '0.0.9']) { const f = fixture({ version }); await f.updater.verify(); assert.equal(f.updater.getState().availableVersion, null); await assert.rejects(f.updater.install(true)); }
});
test('chave/configuração ausente não dispara check e Web não chama Tauri', async () => {
  for (const config of [{ configured: false }, { runtime: 'web' }]) { const f = fixture(config); await f.updater.verify(); assert.deepEqual(f.calls, []); await assert.rejects(f.updater.install(true)); }
});
test('assinatura rejeitada pelo updater oficial impede reinício', async () => {
  const f = fixture({ signatureFails: true }); await f.updater.verify(); await assert.rejects(f.updater.install(true), /signature/); assert.deepEqual(f.calls, ['check', 'install']); assert.match(f.updater.getState().message, /recusada/);
});
test('candidato com versão inválida não fica disponível após falha de verificação', async () => {
  const f = fixture({ version: 'tools-v0.2.0' }); await f.updater.verify(); assert.equal(f.updater.getState().availableVersion, null); await assert.rejects(f.updater.install(true)); assert.equal(f.calls.includes('install'), false);
});
