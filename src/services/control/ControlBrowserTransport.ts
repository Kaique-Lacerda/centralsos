/** Current auth is same-origin browser cookies, not native Desktop authentication. */
export const controlBrowserAuth = { loginUrl: '/api/control/auth/login', callbackPath: '/control' } as const;

export function createControlBrowserTransport(fetcher: typeof fetch = fetch) {
    return async function request<T>(path: string, body?: unknown): Promise<T> {
        const response = await fetcher('/api/control' + path, {
            method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
            headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(12000)
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? `Control HTTP ${response.status}`);
        return data as T;
    };
}
