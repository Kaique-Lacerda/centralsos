import type { WindowsServiceSnapshot } from '../../types/machine';
import type { FirebirdSnapshot, ProcessInfo, SoftwareInfo, SystemSupportSnapshot } from '../../types/support';
export function isOperationalService(service: WindowsServiceSnapshot): boolean {
  const name = service.name?.toLowerCase() ?? ''; const path = service.pathName?.toLowerCase() ?? '';
  return name === 'spooler' || name.startsWith('firebird') && /(?:fbserver|fbguard|firebird)\.exe/.test(path) || name.startsWith('cobian') && path.includes('cobian');
}
export function canCorrectService(service: WindowsServiceSnapshot): boolean { return isOperationalService(service) && service.state === 'Stopped' && service.startMode?.toLowerCase() !== 'disabled'; }
export function serviceState(service: WindowsServiceSnapshot): string { return service.startMode?.toLowerCase() === 'disabled' ? 'Desabilitado' : service.state === 'Running' ? 'Executando' : service.state === 'Stopped' ? 'Parado' : service.state || 'Não informado'; }
export function interpretFirebird(s: FirebirdSnapshot) {
  const stopped = s.services.items.filter(canCorrectService);
  const conflicting = s.port.listeners.filter(l => l.processName != null && !/^(fbserver|fb_inet_server|firebird)\.exe$/i.test(l.processName));
  return { installed: s.installations.items.length > 0 || s.services.items.length > 0, installationUnknown: !!s.installations.error || !!s.services.error, stopped, conflicting, databaseMissing: s.database.exists === false, databaseUnknown: s.database.exists === null, multipleInstallations: new Set(s.installations.items.map(i => i.location?.toLowerCase()).filter(Boolean)).size > 1 };
}
export function interpretSystem(s: SystemSupportSnapshot) {
  return { lowSpace: s.volumes.items.filter(v => v.totalBytes != null && v.totalBytes > 0 && v.freeBytes != null && (v.freeBytes < 2 * 1024 ** 3 || v.freeBytes / v.totalBytes < .05)), inaccessible: s.volumes.items.filter(v => v.freeBytes == null), rebootPending: s.rebootReasons.length > 0, tempBytes: s.temporary.reduce((n, t) => n + t.eligibleBytes, 0), timeStopped: s.timeService?.state === 'Stopped' };
}
export const knownProcessNames = new Set(['central-sos.exe', 'troia.exe', 'fbserver.exe', 'fbguard.exe', 'fb_inet_server.exe', 'firebird.exe', 'cobian.exe', 'cbservice.exe', 'cbinterface.exe']);
export const criticalProcessNames = new Set(['system', 'idle', 'registry', 'secure system', 'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe', 'lsass.exe', 'lsaiso.exe', 'services.exe', 'svchost.exe', 'dwm.exe', 'fontdrvhost.exe', 'spoolsv.exe', 'audiodg.exe', 'msmpeng.exe', 'sihost.exe', 'taskhostw.exe', 'explorer.exe', 'central-sos.exe']);
export function canTerminateProcess(process: ProcessInfo): boolean { return !process.critical && !criticalProcessNames.has(process.name.toLowerCase()) && Number.isInteger(process.pid) && process.pid > 4 && process.startTime > 0; }
export function processGroups(processes: ProcessInfo[]) { return [...knownProcessNames].map(name => ({ name, instances: processes.filter(p => p.name.toLowerCase() === name) })).filter(g => g.instances.length > 0); }
export function processPathWarning(process: ProcessInfo, expectedPaths: Readonly<Record<string, string>> = {}): string | null {
  const expected = expectedPaths[process.name.toLowerCase()];
  return expected && process.path && process.path.toLowerCase() !== expected.toLowerCase() ? 'Caminho diferente do esperado explicitamente configurado.' : null;
}
export function expectedProcessesMissing(processes: ProcessInfo[], expected: readonly string[] = []): string[] { return expected.filter(name => !processes.some(p => p.name.toLowerCase() === name.toLowerCase())); }
export function dependencyFamily(software: SoftwareInfo): string { const name = software.name.toLowerCase(); return name.includes('webview2') ? 'WebView2' : name.includes('visual c++') ? 'Visual C++ Redistributable' : name.includes('framework') ? '.NET Framework' : name.includes('desktop runtime') ? '.NET Desktop Runtime' : software.name; }
export function dependencyState(items: SoftwareInfo[], family: string, collectionError: string | null): string { return items.some(s => dependencyFamily(s) === family) ? 'Instalado' : collectionError ? 'Não foi possível confirmar' : 'Não encontrado nas fontes consultadas'; }
