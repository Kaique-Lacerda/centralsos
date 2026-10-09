import { spawnSync, execFileSync } from 'node:child_process';
import { readFile, mkdir, mkdtemp, writeFile, copyFile, stat, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { components, sha256, inspectExecutable, readExecutable, validateEmbeddedPackage, clientImageForNsis } from './client-package.mjs';
import { projectVersion } from './release-config.mjs';

const target = 'x86_64-pc-windows-msvc';
const directory = root => resolve(root, '.installer-build');
const payload = (root, prepared) => {
  if (!/^stage-[a-zA-Z0-9]{6}$/.test(prepared.stage ?? '')) throw Error('INSTALLER_STALE_STAGE');
  return join(directory(root), prepared.stage);
};
const json = async file => JSON.parse(await readFile(file, 'utf8'));
function run(executable, args, root, environment = process.env) {
  const result = spawnSync(executable, args, { cwd: root, env: environment, stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw Error('INSTALLER_BUILD_FAILED');
}
export async function sourceFingerprint(root) {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root }).toString().split('\0').filter(Boolean).sort();
  const items = [];
  for (const file of new Set(files)) items.push([file, sha256(await readFile(resolve(root, file)))]);
  return sha256(Buffer.from(JSON.stringify(items)));
}
function nsisPath(path) {
  if (/["$\r\n\0]/.test(path)) throw Error('INSTALLER_BUILD_PATH_REJECTED');
  return path.replaceAll('/', '\\');
}
export function buildCompanions(root, environment, execute = run) {
  for (const crate of ['agent', 'session-helper']) execute('cargo', ['build', '--locked', '--release', '--target', target, '--manifest-path', `crates/${crate}/Cargo.toml`], root, environment);
}
export async function stageExecutable(source, destination, level) {
  const metadata = await lstat(source);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 512 * 1024 * 1024) throw Error('INSTALLER_IMAGE_INVALID');
  // Cargo's top-level output is normally hardlinked to deps. Never deploy that link.
  // The destination is a new, exclusive file in a fresh staging directory.
  const original = inspectExecutable(await readFile(source), level);
  await copyFile(source, destination, constants.COPYFILE_EXCL);
  const { bytes, ...copied } = await readExecutable(destination, level);
  if (original.sha256 !== copied.sha256) throw Error('INSTALLER_STAGE_CHANGED');
  return copied;
}
export function validatePrepared(prepared, version, fingerprint) {
  if (!/^stage-[a-zA-Z0-9]{6}$/.test(prepared.stage ?? '') || prepared.version !== version || prepared.target !== target || prepared.fingerprint !== fingerprint
    || prepared.files?.length !== 2 || components.slice(1).some(component => prepared.files.filter(file => file.name === component.name && file.destination === component.destination && file.manifestLevel === component.level && file.architecture === 'x64' && /^[a-f0-9]{64}$/.test(file.sha256)).length !== 1)) throw Error('INSTALLER_STALE_STAGE');
}
export async function prepareClient(root = process.cwd(), environment = process.env) {
  if (process.platform !== 'win32') throw Error('INSTALLER_WINDOWS_MSVC_REQUIRED');
  const version = await projectVersion(root);
  const fingerprint = await sourceFingerprint(root);
  await mkdir(directory(root), { recursive: true });
  await writeFile(join(directory(root), 'prepared.json'), JSON.stringify({ incomplete: true }));
  const stage = await mkdtemp(join(directory(root), 'stage-'));
  const cache = join(directory(root), 'cargo-target');
  const env = { ...environment, CARGO_TARGET_DIR: cache, CARGO_BUILD_JOBS: '1',
    CARGO_ENCODED_RUSTFLAGS: ['-C', 'target-feature=+crt-static', '--remap-path-prefix', `${root}=/central-sos`].join('\x1f') };
  delete env.RUSTFLAGS;
  delete env.TAURI_SIGNING_PRIVATE_KEY; delete env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
  buildCompanions(root, env);
  const files = [];
  for (const component of components.slice(1)) {
    const source = join(cache, target, 'release', component.name);
    const metadata = await stageExecutable(source, join(stage, component.name), component.level);
    files.push({ name: component.name, destination: component.destination, ...metadata });
  }
  if (fingerprint !== await sourceFingerprint(root)) throw Error('INSTALLER_SOURCE_CHANGED_DURING_BUILD');
  await writeFile(join(directory(root), 'prepared.json'), JSON.stringify({ version: version.version, fingerprint, target, stage: basename(stage), files }, null, 2));
}
export async function finalizeClient(root = process.cwd()) {
  const prepared = await json(join(directory(root), 'prepared.json'));
  const { version } = await projectVersion(root);
  validatePrepared(prepared, version, await sourceFingerprint(root));
  const triple = process.env.TAURI_ENV_TARGET_TRIPLE;
  if (triple && triple !== target) throw Error('INSTALLER_WINDOWS_MSVC_REQUIRED');
  const cargo = JSON.parse(execFileSync('cargo', ['metadata', '--no-deps', '--format-version', '1', '--manifest-path', 'src-tauri/Cargo.toml'], { cwd: root, encoding: 'utf8' }));
  if (resolve(cargo.target_directory).toLowerCase() !== resolve(root, 'src-tauri/target').toLowerCase()) throw Error('INSTALLER_TARGET_DIRECTORY_MISMATCH');
  // The bundler still has to patch/sign the Client. Hash it at NSIS compiler time,
  // not here, or the receipt would describe the pre-patch PE instead of installed bytes.
  await mkdir(join(directory(root), 'payload'), { recursive: true });
  await writeFile(join(directory(root), 'payload/package-build.nsh'), [
    `!define SOS_BUILD_NODE "${nsisPath(process.execPath)}"`,
    `!define SOS_BUILD_SCRIPT "${nsisPath(resolve(root, 'scripts/client-bundle.mjs'))}"`,
    `!define SOS_BUILD_ROOT "${nsisPath(root)}"`,
  ].join('\n') + '\n');
}
export async function stageBundledClient(source, destination) {
  const bytes = await readFile(source);
  const marker = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS');
  const index = bytes.indexOf(marker);
  if (index < 0 || bytes.indexOf(marker, index + 1) >= 0 || bytes.includes(Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK'))) throw Error('INSTALLER_CLIENT_NOT_BUNDLED');
  try {
    const existing = await readExecutable(destination, components[0].level);
    if (existing.sha256 !== sha256(bytes)) throw Error('INSTALLER_STAGE_CHANGED');
    const { bytes: ignored, ...metadata } = existing;
    return metadata; // A second compiler pass may reuse only the exact same sealed PE.
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return stageExecutable(source, destination, components[0].level);
}
export async function sealClient(root = process.cwd()) {
  const prepared = await json(join(directory(root), 'prepared.json'));
  const { version } = await projectVersion(root);
  validatePrepared(prepared, version, await sourceFingerprint(root));
  const client = resolve(root, 'src-tauri/target', target, 'release/central-sos.exe');
  const stage = payload(root, prepared);
  const metadata = await stageBundledClient(client, join(stage, components[0].name));
  for (const file of prepared.files) {
    const actual = await readExecutable(join(stage, file.name), file.manifestLevel);
    if (actual.sha256 !== file.sha256) throw Error('INSTALLER_STAGE_CHANGED');
  }
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const manifest = { schemaVersion: 1, product: 'br.com.centralsos.desktop', version, architecture: 'x64',
    protocolVersion: 1, commit, sourceFingerprint: prepared.fingerprint,
    files: [{ name: components[0].name, destination: components[0].destination, ...metadata, bytes: undefined }, ...prepared.files] };
  await writeFile(join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  const defines = [
    ...components.map((file, i) => `!define SOS_SOURCE_${i} "${nsisPath(join(stage, file.name))}"`),
    `!define SOS_SOURCE_MANIFEST "${nsisPath(join(stage, 'package.json'))}"`,
  ];
  await mkdir(join(directory(root), 'payload'), { recursive: true });
  await writeFile(join(directory(root), 'payload/package-files.nsh'), defines.join('\n') + '\n');
}
export async function inspectClientInstaller(file, root = process.cwd()) {
  const prepared = await json(join(directory(root), 'prepared.json'));
  const stage = payload(root, prepared);
  const manifest = await json(join(stage, 'package.json'));
  if (prepared.fingerprint !== await sourceFingerprint(root) || manifest.sourceFingerprint !== prepared.fingerprint) throw Error('INSTALLER_STALE_STAGE');
  const images = {};
  for (const component of components) images[component.name] = (await readExecutable(join(stage, component.name), component.level)).bytes;
  const output = await readFile(file);
  const checked = validateEmbeddedPackage(output, images, manifest);
  const nsis = await readFile(resolve(root, 'src-tauri/target', file.includes(`target${process.platform === 'win32' ? '\\' : '/'}${target}`) ? target : '', 'release/nsis/x64/installer.nsi'), 'utf8');
  if (!/!define INSTALLMODE "perMachine"/.test(nsis) || !/!define ARCH "x64"/.test(nsis)
    || !nsis.includes('client-agent-hooks.nsh') || /^!define VERSION "([^"]+)"/m.exec(nsis)?.[1] !== manifest.version) throw Error('INSTALLER_TEMPLATE_MISMATCH');
  const mainSource = /^!define MAINBINARYSRCPATH "([^"]+)"/m.exec(nsis)?.[1];
  if (!mainSource || resolve(mainSource).toLowerCase() !== resolve(root, 'src-tauri/target', target, 'release/central-sos.exe').toLowerCase()
    || inspectExecutable(clientImageForNsis(await readFile(mainSource)), components[0].level).sha256 !== manifest.files.find(image => image.name === components[0].name)?.sha256) throw Error('INSTALLER_MAIN_BINARY_MISMATCH');
  const hooks = await readFile(resolve(root, 'src-tauri/windows/client-agent-hooks.nsh'), 'utf8');
  for (const [index, component] of components.entries()) {
    if (!hooks.includes(`File /oname=${component.name} "\${SOS_SOURCE_${index}}"`)) throw Error('INSTALLER_TEMPLATE_MISMATCH');
  }
  const report = { ...checked, version: manifest.version, commit: manifest.commit, installer: file,
    size: (await stat(file)).size, sha256: sha256(output), sourceFingerprint: manifest.sourceFingerprint };
  await writeFile(join(directory(root), 'inspection.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  return report;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [mode, file] = process.argv.slice(2);
    if (mode === 'prepare') {
      run(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-b'], process.cwd());
      run(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'build', '--mode', 'client'], process.cwd());
      await prepareClient();
    } else if (mode === 'finalize') await finalizeClient();
    else if (mode === 'seal' && file) await sealClient(resolve(file));
    else if (mode === 'inspect' && file) await inspectClientInstaller(resolve(file));
    else throw Error('Use client-bundle.mjs prepare|finalize|seal <root>|inspect <NSIS>.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
