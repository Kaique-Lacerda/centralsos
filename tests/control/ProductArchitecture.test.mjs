import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoutesFromElements, matchRoutes, Navigate } from 'react-router-dom';
import { StaticRouter } from 'react-router-dom/server.js';
import { load } from './load.mjs';

const products = ['client', 'support', 'web'];
const graphs = Object.fromEntries(await Promise.all(products.map(async product => {
    const bundle = await build({ entryPoints: [`src/apps/${product}/main.tsx`], bundle: true,
        platform: 'browser', format: 'esm', jsx: 'automatic', loader: { '.css': 'empty', '.webp': 'dataurl' },
        metafile: true, write: false });
    return [product, Object.keys(bundle.metafile.inputs).map(path => path.replaceAll('\\', '/'))];
})));

test('cada produto possui entrypoint, app, router e shell próprios no grafo real', async () => {
    for (const product of products) {
        const name = product[0].toUpperCase() + product.slice(1);
        for (const suffix of ['main', `${name}App`, `${name}Router`, `${name}Shell`]) {
            const path = `src/apps/${product}/${suffix}.tsx`;
            await access(path);
            assert.ok(graphs[product].includes(path), path);
        }
        assert.ok(!graphs[product].some(path => products.filter(other => other !== product)
            .some(other => path.startsWith(`src/apps/${other}/`))), product);
    }
});

test('Cliente mantém ferramentas locais, enrollment e updater, sem Control operacional', () => {
    const graph = graphs.client.join('\n');
    assert.doesNotMatch(graph, /pages\/control\/ControlPage|services\/control\/ControlService|ControlBrowserTransport/);
    for (const source of ['PrinterDiagnosticPage', 'NetworkDiagnosticPage', 'WindowsServicesDiagnosticPage',
        'AgentLinkService', 'UpdaterService', 'MachineSnapshotService']) assert.ok(graph.includes(source), source);
});

test('Web não importa Control, Tauri, enrollment nem serviços Windows locais', () => {
    const graph = graphs.web.join('\n');
    assert.doesNotMatch(graph, /@tauri-apps|pages\/control|services\/control|services\/runtime|services\/updater/);
    assert.doesNotMatch(graph, /src\/services\/(?:printers|network|snapshot|validation|diagnosis|support|windows|windows-services|system|processes|storage)\//);
    assert.doesNotMatch(graph, /src\/tools\/registry|src\/pages\//);
    assert.match(graph, /GitHubToolsService/);
    assert.match(graph, /GitHubReleaseService/);
});

test('consumidores locais do catálogo continuam escolhendo o transporte Desktop explicitamente', async () => {
    for (const path of ['src/pages/InstallationsPage.tsx', 'src/pages/support/DependenciesPage.tsx']) {
        const source = await readFile(path, 'utf8');
        assert.match(source, /runtimeEnvironment/, path);
        assert.match(source, /getGitHubToolsCatalog\(\{[^}]*runtime: runtimeEnvironment/, path);
        assert.doesNotMatch(source, /getGitHubToolsCatalog\(\)/, path);
    }
});

test('Suporte possui Control e bridge Tauri própria, sem diagnósticos locais ou enrollment', async () => {
    const graph = graphs.support.join('\n');
    assert.match(graph, /ControlPage/);
    assert.match(graph, /ControlBrowserTransport/);
    assert.match(graph, /packages\/contracts\/control\/contracts/);
    assert.match(graph, /SupportDesktopBridge|@tauri-apps\/api/);
    assert.doesNotMatch(graph, /AgentLinkService|AgentSettings|UpdaterService|MachineSnapshotService|@tauri-apps\/plugin/);
    assert.doesNotMatch(graph, /src\/pages\/(?:support|Printer|Network|WindowsServices|Diagnosis)|src\/tools\/registry/);
    assert.doesNotMatch(graph, /src\/services\/(?:runtime|printers|network|snapshot|validation|diagnosis|support|windows|windows-services|system|processes|storage)\//);
    const { getProductRuntime } = await load('src/apps/product.ts');
    assert.equal(getProductRuntime('support', 'web').identity, 'support-web-preview');
    assert.equal(getProductRuntime('support', 'web').localMachineAccess, false);
    assert.equal(getProductRuntime('client', 'desktop').identity, 'client-desktop');
    assert.equal(getProductRuntime('support', 'desktop').identity, 'support-desktop');
    assert.equal(getProductRuntime('web', 'web').identity, 'public-web');
});

test('rotas são próprias: /control somente no Suporte, rotas públicas não simulam ferramentas locais', async () => {
    const exports = await Promise.all(products.map(product => {
        const name = product[0].toUpperCase() + product.slice(1);
        return load(`src/apps/${product}/${name}Router.tsx`).then(module => [product, module[`${name}Router`]]);
    }));
    for (const [product, Router] of exports) {
        const routes = createRoutesFromElements(Router().props.children);
        const leaf = path => matchRoutes(routes, path).at(-1).route;
        if (product === 'support') {
            assert.equal(leaf('/control').element.type.name, 'SupportControlPage');
            assert.equal(leaf('/').element.type, Navigate);
            assert.equal(leaf('/').element.props.to, '/control');
        } else {
            assert.equal(leaf('/control').path, '*');
            assert.equal(leaf('/control').element.type, Navigate);
            assert.equal(leaf('/control').element.props.to, '/');
        }
        if (product === 'web') {
            for (const path of ['/settings', '/validation', '/tools/printer-diagnostic']) assert.equal(leaf(path).path, '*');
            assert.equal(leaf('/').element.type.name, 'PortalHome');
            for (const path of ['/download/client', '/download/support', '/download']) {
                assert.equal(leaf(path).element.type, Navigate);
                assert.equal(leaf(path).element.props.to, '/#downloads');
            }
            for (const path of ['/tools', '/installations']) {
                assert.equal(leaf(path).element.type, Navigate);
                assert.equal(leaf(path).element.props.to, '/#tools');
            }
        }
        if (product === 'client') {
            for (const path of ['/settings', '/validation', '/installations', '/tools/printer-diagnostic']) assert.notEqual(leaf(path).path, '*');
        }
    }
});

test('portal distingue os produtos; Suporte indisponível não reutiliza instalador do Cliente', async () => {
    const { PortalHome, SupportDownloadPage } = await load('src/apps/web/PortalPages.tsx');
    const home = renderToStaticMarkup(createElement(StaticRouter, {}, createElement(PortalHome)));
    assert.match(home, /Baixar Cliente/);
    assert.match(home, /Baixar Suporte/);
    assert.match(home, /id="tools"/);
    assert.match(home, /Ferramentas/);
    assert.doesNotMatch(home, /href="\/download\/(?:client|support)"|href="\/tools"/);
    assert.doesNotMatch(home, /href="\/control"|href="\/settings"/);
    const support = renderToStaticMarkup(createElement(SupportDownloadPage));
    assert.match(support, /Em desenvolvimento/);
    assert.match(support, /disabled/);
    assert.doesNotMatch(support, /href=|setup\.exe|releases\/download/);
    const { distributionProducts } = await load('src/services/distribution/products.ts');
    assert.equal(distributionProducts.support.state, 'in-development');
    assert.equal(distributionProducts.client.state, 'published-source');
});

test('configuração Vite efetiva transforma o HTML para o entrypoint do produto selecionado', async () => {
    const { resolveConfig } = await import('vite');
    const template = await readFile('index.html', 'utf8');
    for (const product of products) {
        const config = await resolveConfig({ mode: product }, 'build');
        const hook = config.plugins.find(plugin => plugin.name === 'product-entrypoint').transformIndexHtml;
        const html = hook.handler(template);
        assert.ok(html.includes(`/src/apps/${product}/main.tsx`), product);
        assert.ok(!html.includes('/src/main.tsx'), product);
        assert.ok(config.build.outDir.endsWith(`dist/${product}`), product);
        assert.equal(config.server.strictPort, true);
    }
});

test('transporte Suporte preserva auth browser same-origin sem credential nativa', async () => {
    const { controlBrowserAuth, createControlBrowserTransport } = await load('src/services/control/ControlBrowserTransport.ts');
    assert.deepEqual(controlBrowserAuth, { loginUrl: '/api/control/auth/login', callbackPath: '/control' });
    const calls = [];
    const request = createControlBrowserTransport(async (url, init) => {
        calls.push({ url, init }); return { ok: true, json: async () => ({ result: true }) };
    });
    assert.deepEqual(await request('/devices'), { result: true });
    await request('/pairing', { profile: 'TERMINAL' });
    assert.equal(calls[0].url, '/api/control/devices');
    assert.equal(calls[0].init.credentials, 'same-origin');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[1].init.method, 'POST');
    assert.equal(calls[1].init.body, '{"profile":"TERMINAL"}');
    assert.equal(calls[1].init.headers['Content-Type'], 'application/json');
    assert.ok(calls[0].init.signal instanceof AbortSignal);
    await assert.rejects(createControlBrowserTransport(async () => ({ ok: false, json: async () => ({ error: 'Não autorizado' }) }))('/devices'), /Não autorizado/);
});

test('build seleciona entrypoint isolado; Tauri é Cliente e Vercel é Web sem capturar /api', async () => {
    const { getProductBuild } = await load('config/products.ts');
    for (const product of products) {
        assert.equal(getProductBuild(product).entry, `/src/apps/${product}/main.tsx`);
        assert.equal(getProductBuild(product).outDir, `dist/${product}`);
    }
    assert.equal(getProductBuild('production'), getProductBuild('web'));
    assert.throws(() => getProductBuild('unknown'), /desconhecido/);
    const tauri = JSON.parse(await readFile('src-tauri/tauri.conf.json', 'utf8'));
    assert.equal(tauri.build.beforeBuildCommand, 'node scripts/client-bundle.mjs prepare');
    assert.equal(tauri.build.beforeBundleCommand, 'node scripts/client-bundle.mjs finalize');
    const clientBundle = await readFile('scripts/client-bundle.mjs', 'utf8');
    assert.match(clientBundle, /'build', '--mode', 'client'/);
    assert.equal(tauri.build.beforeDevCommand, 'npm run dev:client');
    assert.equal(tauri.build.frontendDist, '../dist/client');
    assert.equal(tauri.build.devUrl, `http://localhost:${getProductBuild('client').port}`);
    const vercel = JSON.parse(await readFile('vercel.json', 'utf8'));
    assert.equal(vercel.buildCommand, 'npm run build:web');
    assert.equal(vercel.outputDirectory, 'dist/web');
    const fallback = new RegExp(`^${vercel.rewrites[0].source}$`);
    for (const path of ['/api', '/api/control/devices', '/api/agent/heartbeat', '/api/tools-manifest', '/api/app-update']) assert.equal(fallback.test(path), false, path);
    for (const path of ['/', '/download/client', '/download/support', '/tools', '/api-public']) assert.equal(fallback.test(path), true, path);
    for (const path of ['api/control/[...path].ts', 'api/agent/[...path].ts', 'api/tools-manifest.ts', 'api/app-update.ts']) await access(path);
});
