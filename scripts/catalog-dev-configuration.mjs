import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

export function developmentOptions(args) {
    if (args.length && (args.length !== 2 || args[0] !== '--port')) throw new Error('USE_ONLY_PORT_OPTION');
    const port = args.length ? Number(args[1]) : 1423;
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 1432) throw new Error('INVALID_LOCAL_PORT');
    return { port, origin: `https://localhost:${port}`, host: '127.0.0.1' };
}
export async function loadDevelopmentConfiguration(file, args) {
    const options = developmentOptions(args), config = JSON.parse(await readFile(file, 'utf8'));
    let env = parseEnv(await readFile(config.envFile, 'utf8'));
    const project = JSON.parse(await readFile('.vercel/project.json', 'utf8'));
    if (project.projectName !== 'centralsos-2xh9' || project.projectId !== config.projectId) throw new Error('HOMOLOGATION_PROJECT_REQUIRED');
    const oidcExpired = () => {
        try { return JSON.parse(Buffer.from(env.VERCEL_OIDC_TOKEN.split('.')[1], 'base64url')).exp * 1000 < Date.now() + 15 * 60_000; }
        catch { return true; }
    };
    if (oidcExpired()) {
        if (!config.vercelCli) throw new Error('DEVELOPMENT_OIDC_REFRESH_REQUIRED');
        const refreshedFile = join(dirname(config.rateSecretFile), 'catalog-development.env');
        execFileSync(config.vercelCli, ['env', 'pull', refreshedFile, '--environment', 'development', '--yes', '--scope', config.team], { windowsHide: true, stdio: 'pipe' });
        env = parseEnv(await readFile(refreshedFile, 'utf8'));
        console.log('[config] Credencial de desenvolvimento Blob renovada; nenhum segredo foi exibido.');
    }
    if (env.CATALOG_NEON_PROJECT_ID !== config.neonProjectId || env.BLOB_STORE_ID !== config.blobStoreId) throw new Error('HOMOLOGATION_RESOURCES_REQUIRED');
    const allowed = ['CATALOG_DATABASE_URL', 'CATALOG_DATABASE_URL_UNPOOLED', 'CATALOG_DATABASE_CA', 'BLOB_STORE_ID', 'VERCEL_OIDC_TOKEN', 'BLOB_WEBHOOK_PUBLIC_KEY'];
    for (const key of allowed) if (env[key]) process.env[key] = env[key];
    process.env.CATALOG_ORIGIN = options.origin;
    process.env.CATALOG_RATE_SECRET = (await readFile(config.rateSecretFile, 'utf8')).trim();
    return { ...options, tls: { key: await readFile(config.tlsKey), cert: await readFile(config.tlsCert) } };
}
