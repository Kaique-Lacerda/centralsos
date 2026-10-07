import type { WindowsServiceSnapshot } from '../../../packages/contracts/machine';
import { isOperationalService } from '../support/SupportInterpretation';

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
  return Boolean(service.name && PRIORITY_SERVICE_NAMES.has(service.name.trim().toLocaleLowerCase('en-US'))) || isOperationalService(service);
}

export function isPriorityServiceStopped(service: WindowsServiceSnapshot): boolean {
  return isPriorityWindowsService(service) && service.state?.trim().toLocaleLowerCase('en-US') === 'stopped';
}
