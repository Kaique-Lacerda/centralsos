import { build } from 'esbuild';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

// Administrative entrypoint only: never imported by API, React or Desktop.
const [command, ...args] = process.argv.slice(2);
const directory = resolve('.control-build');
await mkdir(directory, { recursive: true });
const file = resolve(directory, `admin-${randomUUID()}.mjs`);
let pool;
let diagnosticCode = () => 'ADMINISTRATION_FAILED';
try {
    const output = await build({ entryPoints: ['server/control/Administration.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false });
    await writeFile(file, output.outputFiles[0].contents);
    const admin = await import(pathToFileURL(file).href);
    diagnosticCode = admin.diagnosticCode;
    const actor = admin.requireAdministration(process.env);
    if (!['migrate', 'provision', 'diagnose'].includes(command)) throw new admin.AdministrativeError('ADMINISTRATIVE_ARGUMENT_INVALID');
    let inputFile;
    const flags = new Set();
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--file' && command === 'provision' && !inputFile && args[i + 1] && !args[i + 1].startsWith('--')) inputFile = args[++i];
        else if (['--apply', '--dry-run', '--confirm-role-change'].includes(arg) && !flags.has(arg)) flags.add(arg);
        else throw new admin.AdministrativeError('ADMINISTRATIVE_ARGUMENT_INVALID');
    }
    if ((flags.has('--apply') && flags.has('--dry-run')) || (command !== 'provision' && flags.has('--confirm-role-change')) || (command === 'diagnose' && flags.size)) throw new admin.AdministrativeError('ADMINISTRATIVE_ARGUMENT_INVALID');
    const migrations = await admin.readMigrations(resolve('server/control/migrations'));
    if (command === 'diagnose') {
        // Missing configuration is itself reportable, without opening a public endpoint.
        try { pool = admin.createControlPool(process.env, true); } catch {}
        console.log(JSON.stringify(await admin.administrativeDiagnostics(process.env, pool ?? null, migrations)));
    } else {
        let input;
        if (command === 'provision') {
            if (!inputFile) throw new admin.AdministrativeError('PROVISIONING_FILE_REQUIRED');
            const raw = await readFile(inputFile);
            if (raw.length > 16384) throw new admin.AdministrativeError('PROVISIONING_INPUT_INVALID');
            try { input = JSON.parse(raw.toString('utf8')); } catch { throw new admin.AdministrativeError('PROVISIONING_INPUT_INVALID'); }
        }
        pool = admin.createControlPool(process.env, true);
        const result = command === 'migrate'
            ? await admin.applyMigrations(pool, migrations, !flags.has('--apply'))
            : await admin.provision(pool, migrations, input, { actor, dryRun: !flags.has('--apply'), confirmRoleChange: flags.has('--confirm-role-change') });
        console.log(JSON.stringify(result));
    }
} catch (error) {
    console.error(JSON.stringify({ event: 'control.administration_failed', code: diagnosticCode(error) }));
    process.exitCode = 1;
} finally {
    await pool?.end();
    await unlink(file).catch(() => {});
}
