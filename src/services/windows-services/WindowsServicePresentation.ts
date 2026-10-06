import type { WindowsServiceSnapshot } from '../../types/machine';

const PRIORITY_SERVICE_NAMES = new Set([
  'rpcss',
  'eventlog',
  'winmgmt',
  'lanmanserver',
  'spooler',
  'firebirdserverdefaultinstance',
  'firebirdguardiandefaultinstance'
]);

export function isPriorityWindowsService(service: WindowsServiceSnapshot): boolean {
  return Boolean(service.name && PRIORITY_SERVICE_NAMES.has(service.name.trim().toLocaleLowerCase('en-US')));
}

export function isPriorityServiceStopped(service: WindowsServiceSnapshot): boolean {
  return isPriorityWindowsService(service) && service.state?.trim().toLocaleLowerCase('en-US') === 'stopped';
}
