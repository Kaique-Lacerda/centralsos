import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { load } from '../control/load.mjs';
import { developmentOptions } from '../../scripts/catalog-dev-configuration.mjs';
const { CatalogAccess } = await load('src/apps/web/catalog/CatalogAccess.tsx');
const { catalogRequest } = await load('src/apps/web/catalog/CatalogApi.ts');
const { CatalogService } = await load('server/catalog/CatalogService.ts');

test('nenhuma página ou catálogo monta antes de confirmar a sessão', () => {
    let mounted = false;
    function PrivateContent() { mounted = true; return createElement('div', null, 'PRIVATE_CATALOG'); }
    const html = renderToStaticMarkup(createElement(CatalogAccess, null, createElement(PrivateContent)));
    assert.equal(mounted, false); assert.doesNotMatch(html, /PRIVATE_CATALOG/);
    assert.match(html, /Logo CENTRAL SOS/); assert.match(html, /Verificando acesso/);
});
test('todas as rotas Web estão dentro do mesmo gate; Control/Agent/updater permanecem separados', async () => {
    const router = await readFile('src/apps/web/WebRouter.tsx', 'utf8');
    assert.match(router, /<Route element={<CatalogAccess><WebShell \/><\/CatalogAccess>}>/);
    for (const route of ['catalog', 'download/client', 'download/support', 'tools', '*']) assert.ok(router.includes(`path="${route}"`));
    assert.doesNotMatch(router, /Control|Agent|app-update/);
});
test('API indisponível/HTML/vazio/rede: nenhuma mensagem crua de parsing', async () => {
    const original = globalThis.fetch;
    try {
        for (const response of [new Response('', { status: 502 }), new Response('<html>Bad gateway</html>', { status: 503 }), new Response('null')]) {
            globalThis.fetch = async () => response;
            await assert.rejects(catalogRequest('tools', null), error => !/JSON|Unexpected|SyntaxError/.test(error.message));
        }
        globalThis.fetch = async () => { throw new Error('Failed to fetch'); };
        await assert.rejects(catalogRequest('tools', null), /Não foi possível conectar ao catálogo/);
        globalThis.fetch = async () => Response.json({ error: 'Entre novamente.' }, { status: 401 });
        await assert.rejects(catalogRequest('tools', null), error => error.status === 401 && error.message === 'Entre novamente.');
    } finally { globalThis.fetch = original; }
});
test('leituras e downloads anônimos falham antes do banco ou Blob, inclusive visibilidade legada', async () => {
    const service = new CatalogService({ query() { throw new Error('MUST_NOT_ACCESS_DATABASE'); }, connect() { throw new Error('MUST_NOT_ACCESS_DATABASE'); } }, {});
    for (const operation of ['tools', 'categories', 'download']) await assert.rejects(service[operation](null, 'unused'), /SESSION_REQUIRED/);
});
test('comando conjunto usa somente loopback/HTTPS e rejeita bind externo e portas inválidas', () => {
    assert.deepEqual(developmentOptions([]), { host: '127.0.0.1', port: 1423, origin: 'https://localhost:1423' });
    assert.equal(developmentOptions(['--port', '1424']).origin, 'https://localhost:1424');
    for (const args of [['--host','0.0.0.0'], ['--port','1432'], ['--port','NaN'], ['--port','80']]) assert.throws(() => developmentOptions(args));
});
