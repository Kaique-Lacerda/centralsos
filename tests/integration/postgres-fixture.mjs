import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';

/** Starts a NEW disposable cluster using explicitly supplied local binaries.
 * Never reads any production or test database URL, and never registers a service.
 * All processes/SQL target this cluster, bound exclusively to IPv4 loopback. */
export async function postgresFixture(bin) {
    const root = resolve('.control-build');
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, 'postgres-test-'));
    const data = join(directory, 'data'), passwordFile = join(directory, 'temporary.password');
    const password = randomBytes(32).toString('hex');
    const binary = name => join(resolve(bin), name + (process.platform === 'win32' ? '.exe' : ''));
    // pg_ctl's server can inherit pipe handles on Windows, keeping spawnSync
    // waiting after pg_ctl exits. Server diagnostics go to its private log.
    const run = (name, args) => execFileSync(binary(name), args, { windowsHide: true, stdio: name === 'pg_ctl' ? 'ignore' : 'pipe', timeout: 30000 });
    const probe = createServer();
    await new Promise((ok, fail) => { probe.once('error', fail); probe.listen(0, '127.0.0.1', ok); });
    const port = probe.address().port;
    await new Promise(ok => probe.close(ok));
    const options = { host: '127.0.0.1', port, user: 'control_test', password, ssl: false, connectionTimeoutMillis: 5000 };
    const pools = [];
    let starting = false;
    async function close() {
        try { await Promise.all(pools.map(pool => pool.end())); }
        finally { if (starting) run('pg_ctl', ['-D', data, '-w', '-t', '15', 'stop', '-m', 'fast']); }
    }
    try {
        await writeFile(passwordFile, password, { mode: 0o600 });
        // This cluster is disposable: skip initdb's initial filesystem sync.
        // PostgreSQL itself keeps normal fsync/transaction behavior for tests.
        try { run('initdb', ['-D', data, '-U', 'control_test', '--auth=scram-sha-256', '--pwfile=' + passwordFile, '--encoding=UTF8', '--locale=C', '--no-sync']); }
        finally { await unlink(passwordFile); }
        starting = true;
        run('pg_ctl', ['-D', data, '-l', join(directory, 'postgres.log'), '-w', '-t', '15', 'start', '-o', `-h 127.0.0.1 -p ${port}`]);
        const bootstrap = new Pool({ ...options, database: 'postgres' }); pools.push(bootstrap);
        // Prove the connected server owns our generated data directory before DDL.
        const actual = (await bootstrap.query('SHOW data_directory')).rows[0].data_directory;
        if (resolve(actual) !== resolve(data)) throw new Error('TEST_POSTGRES_IDENTITY_MISMATCH');
        await bootstrap.query('CREATE DATABASE central_sos_test_migrations');
        const createPool = () => { const pool = new Pool({ ...options, database: 'central_sos_test_migrations' }); pools.push(pool); return pool; };
        const adminEnvironment = schema => {
            if (!/^migration_[a-f0-9]{32}$/.test(schema)) throw new Error('TEST_SCHEMA_INVALID');
            const url = new URL(`postgresql://127.0.0.1:${port}/central_sos_test_migrations`);
            url.username = options.user; url.password = password;
            url.searchParams.set('options', '-c search_path=' + schema);
            return { CONTROL_ADMIN_ENABLED: '1', CONTROL_ADMIN_ACTOR: 'integration-test', CONTROL_DATABASE_TLS: 'disable', CONTROL_ADMIN_DATABASE_URL: url.href };
        };
        return { createPool, adminEnvironment, close, version: (await bootstrap.query('SHOW server_version')).rows[0].server_version };
    } catch (error) {
        await close();
        throw error;
    }
}
