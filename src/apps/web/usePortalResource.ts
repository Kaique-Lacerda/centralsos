import { useCallback, useEffect, useRef, useState } from 'react';

type Loader<T> = (refresh: boolean) => Promise<T>;
const pending = new WeakMap<object, Promise<unknown>>();
/** Coalesce StrictMode/remount requests. Persistent caching remains in existing services. */
export function loadPortalResource<T>(loader: Loader<T>, refresh: boolean): Promise<T> {
    const existing = pending.get(loader);
    if (existing) return existing as Promise<T>;
    const request = Promise.resolve().then(() => loader(refresh));
    pending.set(loader, request);
    const clear = () => { if (pending.get(loader) === request) pending.delete(loader); };
    void request.then(clear, clear);
    return request;
}
export type PortalResource<T> = { data: T | null; loading: boolean; error: string; refresh: () => void };
export function usePortalResource<T>(loader: Loader<T>): PortalResource<T> {
    const [data, setData] = useState<T | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const generation = useRef(0);
    const load = useCallback(async (refresh: boolean) => {
        const current = ++generation.current;
        setLoading(true); setError('');
        try {
            const result = await loadPortalResource(loader, refresh);
            if (generation.current === current) setData(result);
        } catch {
            if (generation.current === current) setError('Verifique a conexão e tente novamente.');
        } finally { if (generation.current === current) setLoading(false); }
    }, [loader]);
    useEffect(() => { void load(false); return () => { generation.current++; }; }, [load]);
    return { data, loading, error, refresh: () => { void load(true); } };
}
