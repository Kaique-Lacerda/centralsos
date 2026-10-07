import { MachineSnapshotService } from '../snapshot/MachineSnapshotService';
import { WindowsServicesService } from '../windows-services/WindowsServicesService';
import { SupportService } from '../support/SupportService';
import { PrinterService } from '../printers/PrinterService';
import { LocalConfigService } from '../runtime/localConfig';
import { runMachineValidation } from '../validation/runMachineValidation';
import { createDiagnosisEngine } from './DiagnosisEngine';

export const GeneralDiagnosisService = createDiagnosisEngine({
  machine: () => MachineSnapshotService.getSnapshot(),
  system: SupportService.system, network: SupportService.network, services: () => WindowsServicesService.getServices(),
  firebird: SupportService.firebird, dependencies: SupportService.dependencies,
  spooler: PrinterService.getSpooler, printer: PrinterService.getDiagnostic,
  compliance: runMachineValidation, hasProfile: () => !!LocalConfigService.load(),
}, {
  startSpooler: PrinterService.startSpooler,
  startService: name => SupportService.serviceAction(name, 'start', true),
  syncTime: () => SupportService.syncTime(true),
  flushDns: () => SupportService.networkAction('flushDns', null, true),
  resumePrinter: PrinterService.resume,
  cancelProblemJob: PrinterService.cancelProblemJob,
});
