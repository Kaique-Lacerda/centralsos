import { runPrinterAutoFix, type AutoFixClient } from '../services/printers/PrinterAutoFix';
import { ValidationEngine } from '../services/validation/ValidationEngine';
import type { MachineSnapshot } from '../types/machine';
import type { InstallationSnapshot } from '../services/validation/types';
import type { CommandType, DeviceProfile } from '../control/contracts';
import { commandDefinitions } from '../control/CommandPolicy';
export const sessionRequired = (operation: string) => ({
    status: 'USER_SESSION_REQUIRED' as const, code: 'USER_SESSION_REQUIRED' as const,
    executionContext: 'USER_SESSION_REQUIRED' as const, operation,
    message: 'Esta consulta/ação depende da sessão do usuário. Session Helper autenticado não implementado; nenhum diagnóstico de ausência ou correção foi executado.'
});
/** Agent-only presentation adapter; the interactive MachineSnapshot/validation are unchanged. */
function machineSnapshot(native: RulesBridge) {
    const snapshot = native<MachineSnapshot>('snapshot');
    return { ...snapshot, system: { ...snapshot.system, username: '' },
        printers: { items: [], error: 'USER_SESSION_REQUIRED' },
        sessionContext: { currentUser: sessionRequired('currentUser'), printers: sessionRequired('printers'), mappedDrives: sessionRequired('mappedDrives'), hkcu: sessionRequired('hkcu'), winInet: sessionRequired('winInet') }
    };
}
export type NativeOperation = 'snapshot' | 'installation' | 'diagnostic' | 'startSpooler' | 'restartSpooler' | 'resume' | 'cancelProblemJob' | 'services' | 'settle';
export type RulesBridge = <T>(operation: NativeOperation, args?: Record<string, unknown>) => T;
export function createRulesRuntime(native: RulesBridge) {
    const client: AutoFixClient = {
        getDiagnostic: async (name) => native('diagnostic', { name }), startSpooler: async () => native('startSpooler'),
        restartSpooler: async () => native('restartSpooler'), resume: async (name) => native('resume', { name }),
        cancelProblemJob: async (name, id) => native('cancelProblemJob', { name, id })
        // ACL changes are LOCAL_ONLY: omit optional permission mutators, preserving the same pipeline.
    };
    return async function run(type: CommandType, payload: Record<string, unknown>, profile: DeviceProfile): Promise<unknown> {
        if (!Object.hasOwn(commandDefinitions, type)) throw new Error('REJECTED: comando não suportado');
        const policy = commandDefinitions[type];
        if (!policy || !policy.allowedDeviceProfiles.includes(profile)) throw new Error('REJECTED: comando não suportado');
        if (policy.requiresInteractiveUser) return sessionRequired(type);
        switch (type) {
            case 'machine.refresh': return machineSnapshot(native);
            case 'machine.validate': {
                const snapshot = machineSnapshot(native);
                const installation = native<InstallationSnapshot>('installation');
                const results = ValidationEngine.run({ snapshot, installation }, profile === 'SERVER' ? 'server' : 'terminal').map(result => {
                    const sessionOnly = result.ruleId === 'system-username' || result.category === 'printers'
                        || result.category === 'backup' && !installation.cobian.length
                        || result.category === 'cloud_accounting' && !installation.nubeContabil.length;
                    return sessionOnly ? { ...result, status: 'ignored' as const, severity: 'info' as const,
                        description: sessionRequired(result.ruleId).message, actual: 'USER_SESSION_REQUIRED', suggestedAction: undefined,
                        context: sessionRequired(result.ruleId) } : result;
                });
                return { profile, results, coverage: 'PARTIAL_USER_SESSION_REQUIRED', sessionContext: snapshot.sessionContext, summary: ValidationEngine.summarize(results) };
            }
            case 'printer.check': {
                const names = typeof payload.printerName === 'string' ? [payload.printerName] : native<MachineSnapshot>('snapshot').printers.items.map(p => p.name);
                const diagnostics: unknown[] = [];
                for (const name of names.slice(0, 50)) {
                    try {
                        diagnostics.push({ name, snapshot: await client.getDiagnostic(name) });
                    }
                    catch (error) {
                        diagnostics.push({ name, error: String(error) });
                    }
                }
                return { diagnostics, truncated: names.length > 50 };
            }
            case 'printer.auto_fix': return runPrinterAutoFix(client, payload.printerName as string, { settle: async () => { native('settle'); } });
            case 'spooler.restart': return client.restartSpooler();
            case 'service.check': return native('services', payload);
            default: throw new Error('REJECTED: comando não suportado');
        }
    };
}
declare const __centralNative: (operation: string, args: string) => string;
export const executeAgentRules = async (type: CommandType, payload: Record<string, unknown>, profile: DeviceProfile) => JSON.stringify(await createRulesRuntime(<T>(operation: NativeOperation, args: Record<string, unknown> = {}) => JSON.parse(__centralNative(operation, JSON.stringify(args))) as T)(type, payload, profile));
