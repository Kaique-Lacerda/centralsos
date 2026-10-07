import { invoke } from '@tauri-apps/api/core';
import { runtimeEnvironment } from '../runtime/environment';
import type { RuntimeEnvironment } from '../../types';
import type { SnapshotCollection } from '../../types/machine';
import type { CleanupResult, ConnectivitySnapshot, FirebirdSnapshot, NetworkAction, NetworkSupportSnapshot, ProcessInfo, ServiceAction, ServiceActionResult, ShareInfo, ShareSnapshot, SoftwareInfo, SupportCheck, SystemSupportSnapshot } from '../../types/support';
import { canTerminateProcess } from './SupportInterpretation';

type NativeInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
export function validateDestination(host: string, port?: number | null): string | null {
  const value = host.trim();
  if (!value || value.length > 253 || /[\s\\/\x00]/.test(value) || value.includes('://')) return 'Informe somente um hostname ou IP.';
  if (port != null && (!Number.isInteger(port) || port < 1 || port > 65535)) return 'A porta deve estar entre 1 e 65535.';
  return null;
}
export function validateSharePath(path: string): string | null {
  const match = /^\\\\([^\\]+)\\([^\\]+)$/.exec(path.trim());
  if (!match || validateDestination(match[1]) || ['.', '?', '..'].includes(match[1]) || ['.', '..'].includes(match[2]) || /[\x00-\x1f/:*?"<>|]/.test(match[2])) return 'Use um caminho UNC com servidor e compartilhamento, sem subpastas.';
  return null;
}
export function createSupportClient(runtime: RuntimeEnvironment, nativeInvoke: NativeInvoke) {
  const call = <T>(command: string, args?: Record<string, unknown>) => {
    if (runtime !== 'desktop') return Promise.reject(new Error('Esta ferramenta requer o aplicativo Desktop.'));
    return nativeInvoke<T>(command, args);
  };
  return {
    network: () => call<NetworkSupportSnapshot>('support_get_network'),
    connectivity: (host: string, port: number | null) => {
      const error = validateDestination(host, port);
      return error ? Promise.reject(new Error(error)) : call<ConnectivitySnapshot>('support_test_connectivity', { host: host.trim(), port });
    },
    networkAction: (action: NetworkAction, index: number | null, confirmed = false) => call<string>('support_network_action', { action, index, confirmed }),
    serviceAction: (name: string, action: ServiceAction, confirmed = false) => call<ServiceActionResult>('support_service_action', { name, action, confirmed }),
    firebird: () => call<FirebirdSnapshot>('support_get_firebird'),
    share: (path: string) => validateSharePath(path) ? Promise.reject(new Error(validateSharePath(path)!)) : call<ShareSnapshot>('support_test_share', { path: path.trim() }),
    listShares: (host: string) => validateDestination(host) ? Promise.reject(new Error(validateDestination(host)!)) : call<SnapshotCollection<ShareInfo>>('support_list_shares', { host: host.trim() }),
    system: () => call<SystemSupportSnapshot>('support_get_system'),
    cleanup: (confirmed: boolean) => call<CleanupResult>('support_cleanup_temp', { confirmed }),
    syncTime: (confirmed: boolean) => call<SupportCheck>('support_sync_time', { confirmed }),
    processes: () => call<SnapshotCollection<ProcessInfo>>('support_get_processes'),
    terminate: (process: ProcessInfo, confirmed: boolean) => {
      if (!confirmed || !canTerminateProcess(process)) return Promise.reject(new Error('Confirme um processo não crítico com identidade válida.'));
      return call<string>('support_terminate_process', { pid: process.pid, expectedName: process.name, expectedStart: process.startTime, confirmed });
    },
    dependencies: () => call<SnapshotCollection<SoftwareInfo>>('support_get_dependencies')
  };
}
export const SupportService = createSupportClient(runtimeEnvironment, invoke);
export type SupportClient = ReturnType<typeof createSupportClient>;
