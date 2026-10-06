import { invoke } from '@tauri-apps/api/core';
import { runtimeEnvironment } from '../runtime/environment';
export interface AgentLinkStatus {
    linked: boolean;
    connected: boolean;
    deviceId?: string;
    environment?: string;
    profile?: 'TERMINAL' | 'SERVER';
    serverDeviceId?: string | null;
    serverName?: string | null;
    agentVersion?: string | null;
    coreVersion?: string | null;
    protocolVersion?: number | null;
    lastCommunication?: string | null;
    serviceInstalled?: boolean;
}
const desktop = <T>(command: string, args?: Record<string, unknown>) => runtimeEnvironment === 'desktop' ? invoke<T>(command, args) : Promise.reject(new Error('Pareamento local exige Desktop.'));
export const AgentLinkService = { status: () => desktop<AgentLinkStatus>('agent_status'), enroll: (backend: string, pairingCode: string, profile: 'TERMINAL' | 'SERVER') => desktop<AgentLinkStatus>('agent_enroll', { backend, pairingCode, profile }), unlink: (confirmed: boolean) => desktop<void>('agent_unlink', { confirmed }) };
