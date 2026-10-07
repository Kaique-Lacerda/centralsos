import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prepareBuildConfiguration } from './release-config.mjs';

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
  const metadata = JSON.parse(await readFile(resolve('node_modules/@tauri-apps/cli/package.json'), 'utf8'));
  const executable = resolve('node_modules/@tauri-apps/cli', metadata.bin.tauri);
  const environment = { ...process.env };
  if (mode !== 'release') { delete environment.TAURI_SIGNING_PRIVATE_KEY; delete environment.TAURI_SIGNING_PRIVATE_KEY_PASSWORD; }
  // Use the Tauri 2 config option, retaining the equivalent legacy value if a local shell supplied it.
  delete environment.STATIC_VCRUNTIME;
  const args = [executable, mode === 'dev' ? 'dev' : 'build', '--config', prepared.configPath];
  if (mode === 'release') args.push('--bundles', 'nsis', '--target', 'x86_64-pc-windows-msvc');
  else args.push(...options);
  const child = spawn(process.execPath, args, { stdio: 'inherit', env: environment, windowsHide: true });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} catch (error) { console.error(error.message); process.exitCode = 1; }
