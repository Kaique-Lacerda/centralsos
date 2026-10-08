import type { CommandRequest, Device, Environment, RemoteCommand, RemoteCommandResult } from '../../../packages/contracts/control/contracts';
import { createControlBrowserTransport } from './ControlBrowserTransport';
import type { ControlTransport } from '../../../packages/contracts/control/NativeAuthentication';
export { controlBrowserAuth } from './ControlBrowserTransport';
export function createControlApi(request: ControlTransport) {
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
export function createControlClient(fetcher: typeof fetch = fetch) { return createControlApi(createControlBrowserTransport(fetcher)); }
export const ControlService = createControlClient();
