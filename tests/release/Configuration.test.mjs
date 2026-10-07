import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm, copyFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { publicUpdaterConfiguration, projectVersion, prepareBuildConfiguration, assertPublicationSource } from '../../scripts/release-config.mjs';

// Structural encoding fixture only: zero bytes are NOT a generated or operational key.
function publicFixture() {
  const bytes = Buffer.alloc(42); bytes.write('Ed');
  return { CENTRAL_SOS_UPDATER_PUBLIC_KEY: Buffer.from(`untrusted comment: structural test only\n${bytes.toString('base64')}\n`).toString('base64'), CENTRAL_SOS_UPDATER_URL: 'https://updates.example.test/api/app-update' };
}
async function temporary(run) {
  const parent = resolve('.release-build'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'test-'));
  try { return await run(directory); }
  finally { assert.ok(!relative(parent, directory).startsWith('..')); await rm(directory, { recursive: true, force: true }); }
}
async function projectFixture(root) {
  for (const file of ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src/services/updater/UpdateContract.ts']) {
    await mkdir(resolve(root, file, '..'), { recursive: true }); await copyFile(resolve(file), resolve(root, file));
  }
}
test('release exige configuração real; valida HTTPS, pubkey e segurança; nada privado no overlay', () => {
  assert.throws(() => publicUpdaterConfiguration({}), /exige/);
  const env = publicFixture(), config = publicUpdaterConfiguration(env);
  assert.equal(config.allowDowngrades, false); assert.equal(config.requireSignedVersion, true);
  assert.equal(config.dangerousInsecureTransportProtocol, false);
  assert.deepEqual(config.endpoints, [env.CENTRAL_SOS_UPDATER_URL]);
  assert.doesNotMatch(JSON.stringify(config), /PRIVATE_KEY|PASSWORD/);
  for (const url of ['http://example.test/api/app-update', 'https://user:password@example.test/api/app-update', 'https://example.test/wrong', 'https://example.test/api/app-update?token=x']) {
    assert.throws(() => publicUpdaterConfiguration({ ...env, CENTRAL_SOS_UPDATER_URL: url }));
  }
  for (const key of ['placeholder', 'C:\\private.key', '']) assert.throws(() => publicUpdaterConfiguration({ ...env, CENTRAL_SOS_UPDATER_PUBLIC_KEY: key }));
});
test('dev/local sem chave funcionam; release mantém artifacts e exige públicos; STATIC migra sem mudar valor', () => temporary(async root => {
  await projectFixture(root);
  for (const mode of ['dev', 'local']) {
    const result = await prepareBuildConfiguration(root, mode, {});
    assert.equal(result.config.bundle.createUpdaterArtifacts, false);
    assert.equal(result.config.plugins.updater, null);
  }
  await assert.rejects(prepareBuildConfiguration(root, 'release', {}), /exige/);
  const release = await prepareBuildConfiguration(root, 'release', publicFixture(), 'v0.1.0');
  assert.equal(release.config.bundle.createUpdaterArtifacts, true);
  assert.equal(release.config.bundle.windows.allowDowngrades, false);
  const migrated = await prepareBuildConfiguration(root, 'local', { STATIC_VCRUNTIME: 'false' });
  assert.equal(migrated.config.build.windows.staticVCRuntime, false);
  const base = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
  assert.equal(base.bundle.createUpdaterArtifacts, true);
  assert.equal(base.build.windows.staticVCRuntime, true);
}));
test('versão 0.1.0 é preservada e versões/tag divergentes são recusadas', () => temporary(async root => {
  await projectFixture(root); assert.equal((await projectVersion(root, 'v0.1.0')).version, '0.1.0');
  for (const tag of ['tools-v0.1.0', 'v0.2.0', 'v0.1.0-test']) await assert.rejects(projectVersion(root, tag));
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  await writeFile(resolve(root, 'package.json'), JSON.stringify({ ...pkg, version: '0.2.0' }));
  await assert.rejects(projectVersion(root), /divergentes/);
}));
const ci = { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'Kaique-Lacerda/centralsos', GITHUB_SHA: 'a'.repeat(40), GITHUB_TOKEN: 'test-only-not-operational' };
test('publicação explícita somente main; recusa tag existente e versão não crescente', async () => {
  const fetcher = async url => url.includes('/releases?') ? { ok: true, status: 200, json: async () => [{ tag_name: 'tools-v9.0.0' }, { tag_name: 'v0.0.1' }] } : { ok: false, status: 404 };
  await assertPublicationSource(ci, 'v0.1.0', '0.1.0', fetcher);
  for (const env of [{ ...ci, GITHUB_REF: 'refs/heads/feature/test' }, { ...ci, GITHUB_ACTIONS: 'false' }, { ...ci, GITHUB_TOKEN: '' }]) await assert.rejects(assertPublicationSource(env, 'v0.1.0', '0.1.0', fetcher));
  await assert.rejects(assertPublicationSource(ci, 'v0.1.0', '0.1.0', async () => ({ ok: true, status: 200 })), /já existe/);
  await assert.rejects(assertPublicationSource(ci, 'v0.1.0', '0.1.0', async url => url.includes('/releases?') ? { ok: true, status: 200, json: async () => [{ tag_name: 'v0.2.0' }] } : { ok: false, status: 404 }), /maior/);
});
test('Function compila em NodeNext e o JavaScript resolve imports .js sem bundler', () => temporary(async root => {
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', 'api/app-update.ts', '--target', 'ES2023', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--skipLibCheck', '--strict', '--outDir', root], { stdio: 'pipe' });
  await writeFile(resolve(root, 'package.json'), '{"type":"module"}');
  const compiled = await import(pathToFileURL(resolve(root, 'api/app-update.js')).href);
  assert.equal(typeof compiled.default, 'function');
  for (const file of ['api/app-update.js', 'server/AppUpdateService.js', 'src/services/updater/UpdateContract.js']) {
    const text = await readFile(resolve(root, file), 'utf8');
    for (const match of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) assert.ok(match[1].endsWith('.js'), match[1]);
  }
}));
test('workflow manual verifica tudo antes de publicar; chaves restritas e sem bypass de assinatura', async () => {
  const workflow = await readFile('.github/workflows/release.yml', 'utf8');
  assert.match(workflow, /workflow_dispatch:/); assert.doesNotMatch(workflow, /^\s+(?:push|pull_request):/m);
  assert.match(workflow, /refs\/heads\/main/); assert.match(workflow, /releaseDraft: true/);
  assert.match(workflow, /secrets\.TAURI_SIGNING_PRIVATE_KEY/); assert.match(workflow, /vars\.CENTRAL_SOS_UPDATER_PUBLIC_KEY/);
  assert.match(workflow, /requireSignedVersion|Verificar assinatura criptográfica/);
  assert.ok(workflow.indexOf('test:release') < workflow.indexOf('uses: tauri-apps/tauri-action'));
  assert.ok(workflow.indexOf('cargo run --locked') < workflow.indexOf('node scripts/release-publish.mjs'));
  assert.doesNotMatch(workflow, /--no-sign|dangerousInsecureTransportProtocol:\s*true/);
  const runner = await readFile('scripts/tauri-build.mjs', 'utf8');
  assert.match(runner, /delete environment.TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(runner, /delete environment.STATIC_VCRUNTIME/);
});
