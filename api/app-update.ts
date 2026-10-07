import { AppUpdateError, loadApplicationUpdate, type UpdateFetcher } from '../server/AppUpdateService.js';

interface Request { method?: string }
interface Response {
    status(code: number): Response;
    setHeader(name: string, value: string): Response;
    json(body: unknown): void;
    end(): void;
}
export function createAppUpdateHandler(fetcher?: UpdateFetcher) {
    return async (req: Request, res: Response): Promise<void> => {
        res.setHeader('Cache-Control', 'no-store');
        if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); res.status(405).json({ error: 'Método não permitido.' }); return; }
        try {
            const update = await loadApplicationUpdate(fetcher);
            if (!update) { res.status(204).end(); return; }
            res.setHeader('Cache-Control', 'public, s-maxage=60');
            res.status(200).json(update);
        } catch (error) {
            res.status(error instanceof AppUpdateError ? error.statusCode : 502).json({ error: error instanceof AppUpdateError ? error.message : 'Falha ao consultar atualização.' });
        }
    };
}
export default createAppUpdateHandler();
