import type { CatalogSession } from '../../../../packages/contracts/catalog';
export class CatalogApiError extends Error { constructor(message: string, public readonly status: number) { super(message); } }
export async function catalogRequest<T>(route: string, session: CatalogSession | null, method = 'GET', data?: unknown): Promise<T> {
    let response: Response;
    try { response = await fetch('/api/catalog/' + route, { method, credentials: 'same-origin', headers: {
        ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(session && method !== 'GET' ? { 'X-Catalog-CSRF': session.csrfToken } : {})
    }, body: data === undefined ? undefined : JSON.stringify(data) }); }
    catch { throw new CatalogApiError('Não foi possível conectar ao catálogo. Verifique se os serviços locais estão iniciados e tente novamente.', 0); }
    let result: unknown;
    try { result = await response.json(); }
    catch { throw new CatalogApiError('O serviço do catálogo não respondeu corretamente. Tente novamente em instantes.', response.status); }
    if (!result || typeof result !== 'object') throw new CatalogApiError('Resposta indisponível do catálogo. Tente novamente.', response.status);
    if (!response.ok) {
        if (response.status === 401 && session && typeof window !== 'undefined') window.dispatchEvent(new Event('catalog-session-expired'));
        throw new CatalogApiError('error' in result && typeof result.error === 'string' ? result.error : 'Não foi possível concluir a operação.', response.status);
    }
    return result as T;
}
