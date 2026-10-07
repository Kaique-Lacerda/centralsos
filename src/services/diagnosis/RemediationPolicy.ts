import { isReadOnlyService } from '../support/ServiceSafety';
import { isOperationalService } from '../support/SupportInterpretation';
import { isProblemJob } from '../printers/PrinterAutoFix';
import { isRemotePrinter, isRedirected } from '../printers/PrinterPresence';
import { needsPhysicalIntervention } from '../printers/PrinterKnownIssues';
import type { DiagnosisObservations, Incident } from './types';

export function canExecuteRemediation(incident: Incident, data: DiagnosisObservations): boolean {
  const r = incident.remediation;
  if (r.kind !== 'automatic' || !r.safeToBatch || !r.requiresConfirmation || incident.confidence === 'inconclusive'
    || r.revalidationTargets.some(area => !!data.errors[area])) return false;
  switch (r.actionId) {
    case 'spooler.start':
      return incident.id === 'printing.spooler' && !!data.printing?.elevated && !data.printing.spooler.error
        && data.printing.spooler.state === 1 && [2, 3].includes(data.printing.spooler.startMode ?? 0);
    case 'service.start': {
      const collection = incident.source === 'firebird' ? data.firebird?.services : data.services;
      const service = collection?.items.find(s => s.name === r.target);
      return !collection?.error && !!service && !isReadOnlyService(service) && isOperationalService(service)
        && service.state === 'Stopped' && service.startMode === 'Auto'
        && (incident.id === `service.${service.name}` || incident.id === 'firebird.unavailable');
    }
    case 'system.syncTime':
      return incident.id === 'system.time' && data.system?.timeSync.code === 3
        && ['Auto', 'Manual'].includes(data.system.timeService?.startMode ?? '');
    case 'network.flushDns':
      return incident.id === 'network.connectivity' && !!data.network
        && ['error', 'timeout'].includes(data.network.external.dns.state)
        && data.network.dnsServers.some(s => s.dns.state === 'success');
    case 'printer.resume':
    case 'printer.cancelErrors': {
      const printer = data.printing?.printers.find(p => p.name === r.target);
      const s = printer?.snapshot;
      if (!s || printer?.error || !s.isElevated || !s.printer || s.printerError || s.queue.error
        || isRemotePrinter(s) || isRedirected(s) || needsPhysicalIntervention(s)) return false;
      return r.actionId === 'printer.resume'
        ? incident.id === `printer.${encodeURIComponent(printer!.name)}.PRINTER_PAUSED` && !!(s.printer.statusBits & 1)
        : incident.id === `printer.${encodeURIComponent(printer!.name)}.jobs` && s.queue.items.some(isProblemJob);
    }
    default: return false;
  }
}

export function revalidationComplete(incident: Incident, data: DiagnosisObservations): boolean {
  if (incident.remediation.revalidationTargets.some(area => !!data.errors[area])) return false;
  switch (incident.remediation.actionId) {
    case 'spooler.start':
      return !!data.printing && !data.printing.inventoryError && !data.printing.spooler.error
        && [1, 4].includes(data.printing.spooler.state ?? 0)
        && (data.printing.spooler.state === 1 || data.printing.printers.every(p => !!p.snapshot && !p.error && !p.snapshot.queue.error && !p.snapshot.printerError));
    case 'printer.resume':
    case 'printer.cancelErrors': {
      const p = data.printing?.printers.find(p => p.name === incident.remediation.target);
      return !!p?.snapshot?.printer && !p.error && !p.snapshot.printerError && !p.snapshot.queue.error;
    }
    case 'service.start':
      if (incident.source === 'firebird') return !!data.firebird && !data.firebird.services.error && !data.firebird.processes.error
        && !data.firebird.installations.error && data.firebird.port.tcp.state !== 'unknown';
      return !!data.services && !data.services.error && data.services.items.some(s => s.name === incident.remediation.target && s.state !== null);
    case 'system.syncTime': return !!data.system && !['unknown', 'timeout'].includes(data.system.timeSync.state);
    case 'network.flushDns': return !!data.network && !['unknown', 'timeout'].includes(data.network.external.dns.state);
    default: return false;
  }
}

export function remediationResolved(incident: Incident, data: DiagnosisObservations): boolean {
  if (!revalidationComplete(incident, data)) return false;
  switch (incident.remediation.actionId) {
    case 'spooler.start': return data.printing?.spooler.state === 4;
    case 'service.start':
      if (incident.source === 'firebird') return !!data.firebird
        && data.firebird.services.items.some(s => s.name === incident.remediation.target && s.state === 'Running')
        && data.firebird.processes.items.some(p => ['fbserver.exe', 'fb_inet_server.exe', 'firebird.exe'].includes(p.name.toLowerCase()))
        && data.firebird.port.tcp.state === 'success';
      return !!data.services?.items.some(s => s.name === incident.remediation.target && s.state === 'Running');
    case 'system.syncTime': return data.system?.timeSync.state === 'success';
    case 'network.flushDns': return data.network?.external.dns.state === 'success';
    case 'printer.resume': return ((data.printing?.printers.find(p => p.name === incident.remediation.target)?.snapshot?.printer?.statusBits ?? 1) & 1) === 0;
    case 'printer.cancelErrors': return !!data.printing?.printers.find(p => p.name === incident.remediation.target)?.snapshot?.queue.items.every(job => !isProblemJob(job));
    default: return false;
  }
}
