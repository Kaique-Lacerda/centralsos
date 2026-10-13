import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { loadToolsManifestFromRelease, ToolsManifestProxyError } from './server/ToolsManifestProxy';
import { createAppUpdateHandler } from './api/app-update';
import { getProductBuild } from './config/products';

const appUpdateDevRoute: Plugin = {
  name: 'app-update-dev-route',
  configureServer(server) {
    const handler = createAppUpdateHandler();
    server.middlewares.use('/api/app-update', (request, response, next) => {
      if ((request.url ?? '/').split('?')[0] !== '/') { next(); return; }
      const adapter = {
        status(code: number) { response.statusCode = code; return adapter; },
        setHeader(name: string, value: string) { response.setHeader(name, value); return adapter; },
        json(body: unknown) { response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.end(JSON.stringify(body)); },
        end() { response.end(); }
      };
      void handler({ method: request.method }, adapter).catch(next);
    });
  }
};

const toolsManifestDevRoute: Plugin = {
  name: 'tools-manifest-dev-route',
  configureServer(server) {
    let manifestCatalogServices: ReturnType<typeof import('./server/catalog/HttpApi')['catalogServices']> | undefined;
    server.httpServer?.once('close', () => { void manifestCatalogServices?.pool.end(); });
    server.middlewares.use('/api/tools-manifest', async (request, response) => {
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      const httpRequest = request as typeof request & { method?: string; url?: string };
      if (httpRequest.method !== 'GET') {
        response.statusCode = 405;
        response.setHeader('Allow', 'GET');
        response.end(JSON.stringify({ error: 'Método não permitido.' }));
        return;
      }

      const query = (httpRequest.url ?? '/').split('?')[1] ?? '';
      const encodedTag = /(?:^|&)tag=([^&]*)/.exec(query)?.[1];
      let tag: string | null = null;
      try {
        if (!manifestCatalogServices) manifestCatalogServices = (await import('./server/catalog/HttpApi')).catalogServices();
        let actor;
        try { actor = await manifestCatalogServices.auth.authenticate(request.headers.cookie); }
        catch { actor = null; }
        if (!actor) {
          response.statusCode = 401;
          response.end(JSON.stringify({ code: 'SESSION_REQUIRED', error: 'Entre no CENTRAL SOS para acessar o catálogo.' }));
          return;
        }
        if (encodedTag !== undefined) tag = decodeURIComponent(encodedTag.replace(/\+/g, ' '));
      } catch {
        tag = null;
      }
      try {
        if (tag === null) throw new ToolsManifestProxyError(400, 'Informe uma tag de Release de ferramentas válida.');
        const manifest = await loadToolsManifestFromRelease(tag);
        response.statusCode = 200;
        response.end(JSON.stringify(manifest));
      } catch (error) {
        response.statusCode = error instanceof ToolsManifestProxyError ? error.statusCode : 502;
        const message = error instanceof Error ? error.message : 'Falha ao carregar o manifesto.';
        response.end(JSON.stringify({ error: message }));
      }
    });
  }
};

export default defineConfig(({ mode }) => {
  const product = getProductBuild(mode);
  const entrypoint: Plugin = {
    name: 'product-entrypoint',
    transformIndexHtml: { order: 'pre', handler: html => html.replace('/src/main.tsx', product.entry) }
  };
  return {
    plugins: [entrypoint, react(), toolsManifestDevRoute, appUpdateDevRoute], clearScreen: false,
    build: { outDir: product.outDir },
    server: {
      host: mode === 'web' ? '127.0.0.1' : undefined,
      strictPort: true, port: product.port,
      // Rust's own watcher handles this application; avoid watching its build tree from Vite.
      watch: mode === 'support' ? { ignored: ['**/src-tauri-support/**'] } : undefined,
      proxy: { '/api/catalog': {
        target: 'http://127.0.0.1:1432',
        configure(proxy) {
          proxy.on('error', (_error, _request, response) => {
            if ('writeHead' in response && !response.headersSent) {
              response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
              response.end(JSON.stringify({ code: 'CATALOG_UNAVAILABLE', error: 'A API do catálogo não está disponível. Inicie frontend e API com npm run dev:web.' }));
            }
          });
        }
      }, '/api/control': 'http://127.0.0.1:1431', '/api/agent': 'http://127.0.0.1:1431' }
    }
  };
});
