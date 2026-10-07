import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

export async function loadReleaseModule(entry = 'src/services/updater/UpdateContract.ts', root = process.cwd()) {
  const result = await build({ entryPoints: [resolve(root, entry)], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
}

export function publicUpdaterConfiguration(environment, base = {}) {
  const key = (environment.CENTRAL_SOS_UPDATER_PUBLIC_KEY ?? base.pubkey ?? '').trim();
  const endpoint = (environment.CENTRAL_SOS_UPDATER_URL ?? base.endpoints?.[0] ?? '').trim();
  if (!key || !endpoint) throw Error('Release exige CENTRAL_SOS_UPDATER_PUBLIC_KEY e CENTRAL_SOS_UPDATER_URL reais.');
  const decoded = Buffer.from(key, 'base64');
  const lines = decoded.toString('utf8').split(/\r?\n/);
  const raw = Buffer.from(lines[1] ?? '', 'base64');
  if (decoded.toString('base64') !== key || !lines[0]?.startsWith('untrusted comment:')
    || raw.length !== 42 || !['Ed', 'ED'].includes(raw.subarray(0, 2).toString()) || raw.toString('base64') !== lines[1]) {
    throw Error('A chave pública deve ser o conteúdo .pub gerado pelo Tauri signer; caminhos/placeholders não são aceitos.');
  }
  let url;
  try { url = new URL(endpoint); } catch { throw Error('Endpoint de atualização inválido.'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== '/api/app-update') {
    throw Error('CENTRAL_SOS_UPDATER_URL deve ser https://<dominio-de-producao>/api/app-update, sem credenciais, query ou fragmento.');
  }
  return { pubkey: key, endpoints: [url.href], dangerousInsecureTransportProtocol: false,
    dangerousAcceptInvalidCerts: false, dangerousAcceptInvalidHostnames: false, allowDowngrades: false,
    requireSignedVersion: true, windows: { installMode: 'passive' } };
}

export async function projectVersion(root, tag) {
  const { applicationVersion, compareVersions } = await loadReleaseModule(undefined, root);
  const json = async name => JSON.parse(await readFile(resolve(root, name), 'utf8'));
  const pkg = await json('package.json'), lock = await json('package-lock.json'), tauri = await json('src-tauri/tauri.conf.json');
  const cargo = await readFile(resolve(root, 'src-tauri/Cargo.toml'), 'utf8');
  const cargoLock = await readFile(resolve(root, 'src-tauri/Cargo.lock'), 'utf8');
  const packageSection = cargo.split(/\[package\]\s*/)[1]?.split(/\n\[/)[0] ?? '';
  const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(packageSection)?.[1];
  const lockedPackage = cargoLock.split('[[package]]').find(section => /^name = "central-sos"\r?$/m.test(section));
  const lockedVersion = /^version = "([^"]+)"/m.exec(lockedPackage ?? '')?.[1];
  const versions = [pkg.version, lock.version, lock.packages?.['']?.version, tauri.version, cargoVersion, lockedVersion];
  if (!versions.every(value => value === pkg.version) || applicationVersion(`v${pkg.version}`) === null) {
    throw Error('Versões divergentes ou inválidas em package.json/lock, tauri.conf.json e Cargo.toml/lock.');
  }
  compareVersions(pkg.version, pkg.version);
  if (pkg.version.split('.').some(part => BigInt(part) > 65535n)) throw Error('Versão excede os campos de versão do instalador Windows.');
  if (tag !== undefined && applicationVersion(tag) !== pkg.version) throw Error('A tag precisa ser vMAJOR.MINOR.PATCH e corresponder à versão já existente no main.');
  return { version: pkg.version, tag: tag ?? `v${pkg.version}`, tauri };
}

export async function prepareBuildConfiguration(root, mode, environment, tag) {
  if (!['dev', 'local', 'release'].includes(mode)) throw Error('Modo de build inválido.');
  const version = await projectVersion(root, tag);
  let updater = null;
  try { updater = publicUpdaterConfiguration(environment, version.tauri.plugins?.updater); }
  catch (error) { if (mode === 'release') throw error; }
  const config = { bundle: { createUpdaterArtifacts: mode === 'release', windows: { allowDowngrades: false } }, plugins: { updater } };
  if (environment.STATIC_VCRUNTIME !== undefined) config.build = { windows: { staticVCRuntime: environment.STATIC_VCRUNTIME !== 'false' } };
  const directory = resolve(root, '.release-build');
  await mkdir(directory, { recursive: true });
  const configPath = resolve(directory, `tauri.${mode}.conf.json`);
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
  return { ...version, configPath, config };
}

export async function assertPublicationSource(environment, tag, version, fetcher = fetch) {
  const { applicationVersion, compareVersions } = await loadReleaseModule();
  if (environment.GITHUB_ACTIONS !== 'true' || environment.GITHUB_REF !== 'refs/heads/main'
    || environment.GITHUB_REPOSITORY !== 'Kaique-Lacerda/centralsos' || !/^[a-f0-9]{40}$/.test(environment.GITHUB_SHA ?? '')) {
    throw Error('Publicação permitida somente por workflow_dispatch no main deste repositório.');
  }
  if (applicationVersion(tag) !== version) throw Error('Tag divergente da versão do projeto.');
  const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${environment.GITHUB_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28' };
  if (!environment.GITHUB_TOKEN) throw Error('GITHUB_TOKEN do workflow está ausente.');
  const api = 'https://api.github.com/repos/Kaique-Lacerda/centralsos';
  for (const path of [`/releases/tags/${tag}`, `/git/ref/tags/${tag}`]) {
    const response = await fetcher(api + path, { headers, signal: AbortSignal.timeout(15000) });
    if (response.status !== 404) throw Error(response.ok ? 'Tag/Release já existe; não será sobrescrita.' : `GitHub respondeu com HTTP ${response.status}.`);
  }
  for (let page = 1; page <= 20; page++) {
    const response = await fetcher(`${api}/releases?per_page=100&page=${page}`, { headers, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw Error(`GitHub respondeu com HTTP ${response.status}.`);
    const releases = await response.json();
    if (!Array.isArray(releases)) throw Error('Lista de Releases inválida.');
    for (const release of releases) {
      const published = applicationVersion(release?.tag_name);
      if (published && !release.draft && !release.prerelease && compareVersions(version, published) <= 0) throw Error('A versão de publicação deve ser maior que todas as versões estáveis já publicadas.');
    }
    if (releases.length < 100) return;
  }
  throw Error('Lista de Releases incompleta; publicação recusada.');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    const tag = args[args.indexOf('--tag') + 1];
    if (args.indexOf('--tag') < 0 || !tag || args.some((arg, i) => arg !== '--ci' && arg !== '--tag' && i !== args.indexOf('--tag') + 1)) throw Error('Use release:prepare -- --tag vMAJOR.MINOR.PATCH [--ci].');
    const version = await projectVersion(process.cwd(), tag);
    if (args.includes('--ci')) {
      if (execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== process.env.GITHUB_SHA) throw Error('Checkout diverge do commit solicitado.');
      await assertPublicationSource(process.env, tag, version.version);
    }
    const prepared = await prepareBuildConfiguration(process.cwd(), 'release', process.env, tag);
    console.log(`Configuração pública de Release preparada: ${prepared.tag}.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
