import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { loadToolsManifestFromRelease, ToolsManifestProxyError } from './server/ToolsManifestProxy';
import { createAppUpdateHandler } from './api/app-update';

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

export default defineConfig({ plugins: [react(), toolsManifestDevRoute, appUpdateDevRoute], clearScreen: false, server: {
  strictPort: true, port: 1420,
  proxy: { '/api/control': 'http://127.0.0.1:1431', '/api/agent': 'http://127.0.0.1:1431' }
} });
