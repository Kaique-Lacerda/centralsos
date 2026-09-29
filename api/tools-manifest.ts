import { loadToolsManifestFromRelease, ToolsManifestProxyError, type ManifestFetcher } from '../server/ToolsManifestProxy';

interface VercelRequest {
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

export default createToolsManifestHandler();
