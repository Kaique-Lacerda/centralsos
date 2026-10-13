import { loadToolsManifestFromRelease, ToolsManifestProxyError, type ManifestFetcher } from '../server/ToolsManifestProxy.js';

interface VercelRequest {
  headers?: { cookie?: string };
  method?: string;
  query?: Record<string, string | string[] | undefined>;
}

interface VercelResponse {
  status(code: number): VercelResponse;
  setHeader(name: string, value: string): VercelResponse;
  json(body: unknown): void;
}

export function createToolsManifestHandler(fetcher?: ManifestFetcher) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      res.status(405).json({ error: 'Método não permitido.' });
      return;
    }

    const tag = req.query?.tag;
    if (typeof tag !== 'string') {
      res.status(400).json({ error: 'Informe uma tag de Release de ferramentas válida.' });
      return;
    }

    try {
      const manifest = fetcher
        ? await loadToolsManifestFromRelease(tag, fetcher)
        : await loadToolsManifestFromRelease(tag);
      res.status(200).json(manifest);
    } catch (error) {
      const statusCode = error instanceof ToolsManifestProxyError ? error.statusCode : 502;
      const message = error instanceof Error ? error.message : 'Falha ao carregar o manifesto.';
      res.status(statusCode).json({ error: message });
    }
  };
}

// The legacy manifest is part of the authenticated Web catalog. Native Desktop
// still reads official GitHub assets independently; Control/Agent/updater are untouched.
export default async function authenticatedManifest(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (!req.headers?.cookie?.includes('__Secure-central_sos_catalog=')) {
    res.status(401).json({ code: 'SESSION_REQUIRED', error: 'Entre no CENTRAL SOS para acessar o catálogo.' }); return;
  }
  try {
    const { catalogServices } = await import('../server/catalog/HttpApi.js');
    const actor = await catalogServices().auth.authenticate(req.headers?.cookie);
    if (!actor) { res.status(401).json({ code: 'SESSION_REQUIRED', error: 'Entre no CENTRAL SOS para acessar o catálogo.' }); return; }
    const noCacheResponse: VercelResponse = {
      status(code) { res.status(code); return noCacheResponse; },
      setHeader(name, value) { if (name.toLowerCase() !== 'cache-control') res.setHeader(name, value); return noCacheResponse; },
      json(body) { res.json(body); }
    };
    await createToolsManifestHandler()(req, noCacheResponse);
  } catch (error) {
    const unauthorized = (error as { status?: number })?.status === 401;
    res.status(unauthorized ? 401 : 503).json({ code: unauthorized ? 'SESSION_REQUIRED' : 'CATALOG_UNAVAILABLE', error: unauthorized ? 'Entre novamente para acessar o catálogo.' : 'Catálogo temporariamente indisponível.' });
  }
}
