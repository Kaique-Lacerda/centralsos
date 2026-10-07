import type { CommandStatus, Device, Environment, RemoteCommand, RemoteCommandResult } from '../../src/control/contracts.js';
export interface Actor {
    id: string;
    name: string;
    memberships: {
        companyId: string;
        role: 'viewer' | 'operator' | 'admin';
    }[];
}
export interface ControlState {
    environments: Environment[];
    devices: (Device & {
        credentialHash: string;
        fingerprint: string;
        revokedAt: string | null;
    })[];
    commands: RemoteCommand[];
    results: RemoteCommandResult[];
    pairing: {
        hash: string;
        environmentId: string;
        companyId: string;
        profile: 'SERVER' | 'TERMINAL';
        serverDeviceId: string | null;
        expiresAt: string;
        usedAt: string | null;
        createdBy: string;
    }[];
    audit: {
        id: string;
        actorId: string;
        deviceId: string | null;
        commandId: string | null;
        action: string;
        timestamp: string;
        parameters: unknown;
        outcome: CommandStatus | string;
        durationMs: number | null;
    }[];
}
export interface Repository {
    transaction<T>(operation: (state: ControlState) => T | Promise<T>): Promise<T>;
}
/** Test adapter only: never selected by the production HTTP entrypoint. */
export class MemoryRepository implements Repository {
    state: ControlState = { environments: [], devices: [], commands: [], results: [], pairing: [], audit: [] };
    private tail: Promise<unknown> = Promise.resolve();
    transaction<T>(operation: (state: ControlState) => T | Promise<T>): Promise<T> {
        const run = this.tail.then(async () => { const copy = structuredClone(this.state); const result = await operation(copy); this.state = copy; return result; });
        this.tail = run.catch(() => undefined);
        return run;
    }
}
