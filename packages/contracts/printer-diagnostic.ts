import type { PrintJobSnapshot, SnapshotCollection } from './machine';

export interface PrinterNativeState { name:string;port:string|null;driver:string|null;server:string|null;shareName:string|null;attributes:number;statusBits:number;jobCount:number }
export interface PrintPort { name:string;monitor:string|null;description:string|null;portType:number }
export interface SerialPrintDevice { deviceId:string|null;name:string|null;description:string|null;pnpDeviceId:string|null;status:string|null;configManagerErrorCode:number|null }
export interface TcpPrintPort { name:string;hostAddress:string|null;portNumber:number|null;protocol:number|null;queue:string|null;snmpEnabled:boolean|null;status:string|null }
export interface PrintDriver { name:string|null;environment:string|null;version:string|null;hardwareId:string|null;provider:string|null }
export interface PresentPrintDevice { portName:string|null;friendlyName:string|null;instanceId:string|null;statusFlags:number|null;configManagerErrorCode:number|null;queryError:string|null }
export interface PrinterPresentDevices { com:SnapshotCollection<PresentPrintDevice>;usb:SnapshotCollection<PresentPrintDevice> }
export interface SpoolerState { state:number|null;startMode:number|null;error:string|null }
export interface PrinterDiagnosticSnapshot {
  deviceStatus?: {detectedErrorState:number|null;extendedDetectedErrorState:number|null;extendedPrinterStatus:number|null} | null;
  deviceStatusError?: string|null;
  printer:PrinterNativeState|null;printerError:string|null;queue:SnapshotCollection<PrintJobSnapshot>;
  ports:SnapshotCollection<PrintPort>;serial:SnapshotCollection<SerialPrintDevice>;tcp:SnapshotCollection<TcpPrintPort>;
  presentDevices:PrinterPresentDevices;
  driver:PrintDriver|null;driverError:{code:number;message:string}|null;spooler:SpoolerState;isElevated:boolean;
}
export interface TcpPrintProbe { host:string;port:number;reachable:boolean;detail:string }
export interface SpoolerActionResult { before:SpoolerState;after:SpoolerState;removedFiles:number;failedFiles:string[] }
export interface QueueMonitorEvent { mode:string;changed:boolean;detail:string|null }
