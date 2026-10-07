import type { WindowsServiceSnapshot } from '../../types/machine';

// Mirrors the existing native deny-list. Native policy remains authoritative.
export const criticalWindowsServices = new Set([
  'rpcss', 'dcomlaunch', 'eventlog', 'winmgmt', 'plugplay', 'power', 'samss',
  'lsm', 'nsi', 'bfe', 'mpssvc', 'windefend', 'securityhealthservice', 'rpceptmapper',
]);
export function isReadOnlyService(service: WindowsServiceSnapshot): boolean {
  return !service.name || criticalWindowsServices.has(service.name.toLowerCase());
}
