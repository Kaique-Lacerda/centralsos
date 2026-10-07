import { getPrinterActionAvailability } from './PrinterOperations';
import { validatePrinterUnc, type DiscoveredPrinter } from './PrinterConnections';
import type { SnapshotCollection } from '../../../packages/contracts/machine';
import type { PrinterDiagnosticSnapshot, PrinterNativeState, SpoolerState, SpoolerActionResult, TcpPrintProbe } from '../../../packages/contracts/printer-diagnostic';
import type {
  PrintJobSnapshot, PrinterQueueActionResult, PrinterConfigurationSnapshot,
  PrinterPermissionChangeResult, PrinterPermissionValues,
} from '../../../packages/contracts/machine';

type InvokeCommand = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export function createPrinterActionClient(environment: 'web' | 'desktop', invokeCommand: InvokeCommand) {
  const requireAvailable = () => {
    if (!getPrinterActionAvailability(environment).available) throw new Error('Disponível no Desktop.');
  };
  return {
    discoverNetworkPrinters(){ requireAvailable();return invokeCommand<SnapshotCollection<DiscoveredPrinter>>('discover_network_printers'); },
    addConnection(path:string){ requireAvailable();const error=validatePrinterUnc(path);if(error)throw new Error(error);return invokeCommand<void>('add_printer_connection',{path}); },
    removePrinter(printerName:string,confirmed:boolean){ requireAvailable();if(!confirmed)throw new Error('Confirme a remoção desta impressora.');return invokeCommand<void>('remove_printer',{printerName,confirmed}); },
    getDiagnostic(printerName:string) { requireAvailable();return invokeCommand<PrinterDiagnosticSnapshot>('get_printer_diagnostic',{printerName}); },
    getNativeState(printerName:string) { requireAvailable();return invokeCommand<PrinterNativeState>('get_printer_native_state',{printerName}); },
    getSpooler() { requireAvailable();return invokeCommand<[SpoolerState,boolean]>('get_print_spooler'); },
    probeConnection(printerName:string) { requireAvailable();return invokeCommand<TcpPrintProbe>('probe_printer_connection',{printerName}); },
    setPort(printerName:string,port:string) { requireAvailable();return invokeCommand<void>('set_printer_port',{printerName,port}); },
    startSpooler() { requireAvailable();return invokeCommand<SpoolerActionResult>('start_print_spooler'); },
    restartSpooler() { requireAvailable();return invokeCommand<SpoolerActionResult>('restart_print_spooler'); },
    resetSpooler(confirmAllJobs:boolean) { requireAvailable();if(!confirmAllJobs)throw new Error('Confirme a remoção de todos os trabalhos locais.');return invokeCommand<SpoolerActionResult>('reset_print_spooler',{confirmAllJobs}); },
    getQueue(printerName: string) { requireAvailable(); return invokeCommand<PrintJobSnapshot[]>('get_printer_queue', { printerName }); },
    printTestPage(printerName: string) { requireAvailable(); return invokeCommand<void>('print_printer_test_page', { printerName }); },
    cancelJob(printerName: string, jobId: number) { requireAvailable(); return invokeCommand<void>('cancel_printer_job', { printerName, jobId }); },
    cancelProblemJob(printerName:string,jobId:number){requireAvailable();return invokeCommand<boolean>('cancel_problem_printer_job',{printerName,jobId});},
    clearQueue(printerName: string) { requireAvailable(); return invokeCommand<PrinterQueueActionResult>('clear_printer_queue', { printerName }); },
    pause(printerName: string) { requireAvailable(); return invokeCommand<void>('pause_printer', { printerName }); },
    resume(printerName: string) { requireAvailable(); return invokeCommand<void>('resume_printer', { printerName }); },
    setDefault(printerName: string) { requireAvailable(); return invokeCommand<void>('set_default_printer', { printerName }); },
    rename(printerName: string, newName: string) { requireAvailable(); return invokeCommand<void>('rename_printer', { printerName, newName }); },
    setShare(printerName: string, enabled: boolean, shareName: string | null) { requireAvailable(); return invokeCommand<void>('set_printer_share', { printerName, enabled, shareName }); },
    setLocation(printerName: string, location: string) { requireAvailable(); return invokeCommand<void>('set_printer_location', { printerName, location }); },
    setComment(printerName: string, comment: string) { requireAvailable(); return invokeCommand<void>('set_printer_comment', { printerName, comment }); },
    getConfiguration(printerName: string) { requireAvailable(); return invokeCommand<PrinterConfigurationSnapshot>('get_printer_configuration', { printerName }); },
    getPauseState(printerName: string) { requireAvailable(); return invokeCommand<boolean>('get_printer_pause_state', { printerName }); },
    getPermissions(printerName: string) { requireAvailable(); return invokeCommand<PrinterConfigurationSnapshot['permissions']>('get_printer_permissions', { printerName }); },
    configurePermissions(printerName: string) { requireAvailable(); return invokeCommand<void>('configure_printer_permissions', { printerName }); },
    setPermissions(printerName: string, trusteeSid: string, expectedBefore: PrinterPermissionValues, after: PrinterPermissionValues) {
      requireAvailable();
      return invokeCommand<PrinterPermissionChangeResult>('set_printer_permissions', { request: { printerName, trusteeSid, expectedBefore, after } });
    },
  };
}
