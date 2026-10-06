import type { CommandRequest, Device, Environment, RemoteCommand, RemoteCommandResult } from '../../control/contracts';
export function createControlClient(fetcher: typeof fetch = fetch) {
    const request = async <T>(path: string, body?: unknown): Promise<T> => { const r = await fetcher('/api/control' + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(12000) }); const data = await r.json(); if (!r.ok)
        throw new Error(data.error ?? `Control HTTP ${r.status}`); return data as T; };
    return { environments: () => request<Environment[]>('/environments'), devices: () => request<Device[]>('/devices'),
        device: (id: string) => request<{
            device: Device;
            history: {
                id: string;
                timestamp: string;
                actorId: string;
                action: string;
                outcome: string;
                commandId: string | null;
                durationMs: number | null;
            }[];
        }>(`/devices/${encodeURIComponent(id)}`),
        send: (id: string, command: CommandRequest) => request<RemoteCommand>(`/devices/${encodeURIComponent(id)}/commands`, command),
        command: (id: string) => request<{
            command: RemoteCommand;
            result: RemoteCommandResult | null;
        }>(`/commands/${encodeURIComponent(id)}`),
        pair: (environmentId: string, profile: 'TERMINAL' | 'SERVER', serverDeviceId: string | null) => request<{
            code: string;
            expiresAt: string;
        }>('/pairing', { environmentId, profile, serverDeviceId }) };
}
export const ControlService = createControlClient();
