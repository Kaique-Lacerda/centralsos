import { createServer } from 'node:http';
import { createServer as createViteServer } from 'vite';
import { load } from '../tests/control/load.mjs';
import { loadDevelopmentConfiguration } from './catalog-dev-configuration.mjs';

let api, frontend, services, stopping = false;
async function stop() {
    if (stopping) return;
    stopping = true;
    console.log('[dev] Encerrando frontend e API…');
    await frontend?.close();
    if (api?.listening) { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); }
    await services?.pool.end();
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
try {
    const config = await loadDevelopmentConfiguration(process.env.CATALOG_DEV_CONFIG ?? '.control-build/catalog-development.local.json', process.argv.slice(2));
    const { catalogServices, handleCatalogApi } = await load('server/catalog/HttpApi.ts');
    services = catalogServices();
    const configured = await services.pool.query('SELECT role FROM catalog_credentials WHERE enabled ORDER BY role');
    if (configured.rows.length !== 2) throw new Error('CATALOG_CREDENTIALS_REQUIRED');
    api = createServer((request, response) => {
        const started = Date.now();
        response.once('finish', () => console.log(`[api] ${request.method} ${response.statusCode} ${Date.now() - started}ms`));
        void handleCatalogApi(request, response);
    });
    await new Promise((resolve, reject) => { api.once('error', reject); api.listen(1432, config.host, resolve); });
    frontend = await createViteServer({ mode: 'web', server: { host: config.host, port: config.port, strictPort: true, https: config.tls, open: false } });
    await frontend.listen();
    console.log(`[dev] Portal: ${config.origin}/catalog`);
    console.log('[dev] API: http://127.0.0.1:1432 via proxy HTTPS; Neon/Blob de homologação. Ctrl+C encerra os dois.');
} catch (failure) {
    const safeCodes = ['EADDRINUSE', 'ENOENT', 'USE_ONLY_PORT_OPTION', 'INVALID_LOCAL_PORT', 'HOMOLOGATION_PROJECT_REQUIRED', 'HOMOLOGATION_RESOURCES_REQUIRED', 'DEVELOPMENT_OIDC_REFRESH_REQUIRED', 'CATALOG_CREDENTIALS_REQUIRED'];
    const code = failure?.code ?? failure?.message;
    console.error(`[dev] Não foi possível iniciar: ${safeCodes.includes(code) ? code : 'CONFIGURATION_OR_CONNECTION_FAILED'}. Confira a configuração privada e as portas locais.`);
    await stop(); process.exitCode = 1;
}
