import matrix from './command-policy.json' with { type: 'json' };
export type ExecutionContext = 'MACHINE_SYSTEM_SAFE' | 'USER_SESSION_REQUIRED' | 'USER_SESSION_PREFERRED' | 'UNSUPPORTED_REMOTE';
export type RiskLevel = 'SAFE_READ' | 'SAFE_FIX' | 'CONFIRM_REQUIRED' | 'LOCAL_ONLY';
export type CommandType = keyof typeof matrix;
export interface CommandDefinition {
    executionContext: ExecutionContext;
    riskLevel: RiskLevel;
    requiresInteractiveUser: boolean;
    requiresConfirmation: boolean;
    /** Seconds; checked before each native operation, not forced cancellation of Windows calls. */
    timeout: number;
    idempotent: boolean;
    allowedDeviceProfiles: readonly ('TERMINAL' | 'SERVER')[];
    auditCategory: string;
    nativeOperations: readonly string[];
}
/** The same file is embedded by Rust: a build-time whitelist, never remote configuration. */
export const commandDefinitions = matrix as Record<CommandType, CommandDefinition>;
export const PROTOCOL_VERSION = 1;
export const operationContexts = {
    'session.info': 'USER_SESSION_REQUIRED', 'session.processes': 'USER_SESSION_REQUIRED', 'session.printers': 'USER_SESSION_REQUIRED',
    snapshot: 'USER_SESSION_PREFERRED', installation: 'USER_SESSION_PREFERRED', diagnostic: 'USER_SESSION_REQUIRED',
    startSpooler: 'MACHINE_SYSTEM_SAFE', restartSpooler: 'MACHINE_SYSTEM_SAFE', resume: 'USER_SESSION_REQUIRED',
    cancelProblemJob: 'USER_SESSION_REQUIRED', services: 'MACHINE_SYSTEM_SAFE', settle: 'MACHINE_SYSTEM_SAFE',
    system: 'MACHINE_SYSTEM_SAFE', hardware: 'MACHINE_SYSTEM_SAFE', localVolumes: 'MACHINE_SYSTEM_SAFE',
    adapters: 'MACHINE_SYSTEM_SAFE', hklm: 'MACHINE_SYSTEM_SAFE', machineServices: 'MACHINE_SYSTEM_SAFE',
    spooler: 'MACHINE_SYSTEM_SAFE', hkcu: 'USER_SESSION_REQUIRED', currentUser: 'USER_SESSION_REQUIRED',
    defaultPrinter: 'USER_SESSION_REQUIRED', userPrinters: 'USER_SESSION_REQUIRED', redirectedPrinters: 'USER_SESSION_REQUIRED',
    remoteQueues: 'USER_SESSION_REQUIRED', winInet: 'USER_SESSION_REQUIRED', mappedDrives: 'USER_SESSION_REQUIRED',
    smbUserAccess: 'USER_SESSION_REQUIRED', profilePaths: 'USER_SESSION_REQUIRED', processes: 'USER_SESSION_PREFERRED',
    localPrinterQueues: 'USER_SESSION_PREFERRED', interactiveUI: 'UNSUPPORTED_REMOTE', arbitraryExecution: 'UNSUPPORTED_REMOTE'
} as const satisfies Record<string, ExecutionContext>;
