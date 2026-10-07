import type { PrinterDiagnosticSnapshot } from '../../contracts/printer-diagnostic';

export function diagnosticRecord(s:PrinterDiagnosticSnapshot):string {return JSON.stringify({spooler:s.spooler,printer:s.printer,queue:s.queue,presentDevices:s.presentDevices});}
