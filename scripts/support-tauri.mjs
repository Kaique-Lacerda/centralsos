import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, delimiter } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [mode, ...extra] = process.argv.slice(2);
if (extra.length || !['dev', 'check', 'test', 'build', 'bundle'].includes(mode)) throw Error('Use support:dev/check/test/build/bundle sem overlays externos.');
const cwd = join(root, 'src-tauri-support');
const env = { ...process.env };
// Support has no connection to the Client signing/updater configuration.
for (const name of ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD', 'TAURI_CONFIG', 'CARGO_TARGET_DIR']) delete env[name];
let binary, args;
const rustup = join(process.env.USERPROFILE ?? '', '.cargo', 'bin');
// Windows has case-insensitive environment names, but Node's object may have "Path".
// Avoid emitting both Path/PATH (which can silently drop npm's directory).
const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path');
const inheritedPath = pathKey ? env[pathKey] : '';
for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
env.PATH = rustup + delimiter + inheritedPath;
if (mode === 'check' || mode === 'test') {
    binary = existsSync(join(rustup, 'cargo.exe')) ? join(rustup, 'cargo.exe') : 'cargo';
    args = [mode, '--manifest-path', join(cwd, 'Cargo.toml')];
} else {
    const metadata = JSON.parse(readFileSync(join(root, 'node_modules/@tauri-apps/cli/package.json'), 'utf8'));
    binary = process.execPath;
    args = [join(root, 'node_modules/@tauri-apps/cli', metadata.bin.tauri), mode === 'dev' ? 'dev' : 'build'];
    if (mode === 'build') args.push('--no-bundle');
    if (mode === 'bundle') args.push('--bundles', 'nsis');
}
const child = spawn(binary, args, { cwd, env, stdio: 'inherit', windowsHide: true });
child.on('error', e => { console.error(e.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
