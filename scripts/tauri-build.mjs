import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prepareBuildConfiguration } from './release-config.mjs';
import { inspectClientInstaller } from './client-bundle.mjs';

const [mode, ...options] = process.argv.slice(2);
try {
  let tag;
  if (mode === 'release') {
    if (options.length && (options.length !== 2 || options[0] !== '--tag')) throw Error('Use release:build [-- --tag vMAJOR.MINOR.PATCH].');
    tag = options[1];
    if (!process.env.TAURI_SIGNING_PRIVATE_KEY?.trim()) throw Error('Build de Release exige TAURI_SIGNING_PRIVATE_KEY no ambiente; nenhuma chave será gerada.');
  } else if (options.some(arg => ['--config', '-c'].includes(arg) || arg.startsWith('--config='))) {
    throw Error('Configure o updater pelas variáveis públicas; não substitua o overlay do build.');
  }
  const prepared = await prepareBuildConfiguration(process.cwd(), mode, process.env, tag);
  if (mode === 'local' && options.some(arg => ['--bundles', '-b', '--target', '-t', '--no-bundle'].includes(arg) || /^(--bundles|--target)=/.test(arg))) {
    throw Error('O instalador integrado exige NSIS x64 MSVC; não substitua alvo ou bundle.');
  }
  const metadata = JSON.parse(await readFile(resolve('node_modules/@tauri-apps/cli/package.json'), 'utf8'));
  const executable = resolve('node_modules/@tauri-apps/cli', metadata.bin.tauri);
  const environment = { ...process.env };
  if (mode !== 'dev') delete environment.CARGO_TARGET_DIR;
  if (mode !== 'release') { delete environment.TAURI_SIGNING_PRIVATE_KEY; delete environment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD; }
  // Use the Tauri 2 config option, retaining the equivalent legacy value if a local shell supplied it.
  delete environment.STATIC_VCRUNTIME;
  const args = [executable, mode === 'dev' ? 'dev' : 'build', '--config', prepared.configPath];
  if (mode !== 'dev') args.push('--bundles', 'nsis', '--target', 'x86_64-pc-windows-msvc');
  if (mode !== 'release') args.push(...options);
  const child = spawn(process.execPath, args, { stdio: 'inherit', env: environment, windowsHide: true });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', async code => {
    process.exitCode = code ?? 1;
    if (code !== 0 || mode === 'dev') return;
    try {
      const directory = resolve('src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis');
      const files = (await readdir(directory)).filter(file => file.endsWith('.exe'));
      if (files.length !== 1) throw Error('INSTALLER_ARTIFACT_AMBIGUOUS');
      await inspectClientInstaller(resolve(directory, files[0]));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  });
} catch (error) { console.error(error.message); process.exitCode = 1; }
