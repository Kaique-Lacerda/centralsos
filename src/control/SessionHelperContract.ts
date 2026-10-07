import type { CommandType } from './CommandPolicy';
/** Contract only. No helper, pipe listener, impersonation or TCP endpoint is implemented. */
export interface SessionHelperRequest {
    protocolVersion: number;
    commandId: string;
    deviceId: string;
    sessionId: number;
    userSid: string;
    nonce: string;
    expiresAt: string;
    type: Extract<CommandType, 'printer.check' | 'printer.auto_fix'>;
    payload: { printerName?: string };
}
export interface SessionHelperResponse {
    protocolVersion: number;
    commandId: string;
    deviceId: string;
    sessionId: number;
    userSid: string;
    nonce: string;
    status: 'COMPLETED' | 'USER_SESSION_REQUIRED' | 'REJECTED';
    details: unknown;
}
export const SESSION_HELPER_TRANSPORT = 'AUTHENTICATED_LOCAL_NAMED_PIPE' as const;
