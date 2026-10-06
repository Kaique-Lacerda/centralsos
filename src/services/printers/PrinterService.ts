import { invoke, Channel } from '@tauri-apps/api/core';
import type { QueueMonitorEvent } from '../../types/printer-diagnostic';
import { MachineSnapshotService } from '../snapshot/MachineSnapshotService';
import { runtimeEnvironment } from '../runtime/environment';
import { createPrinterActionClient } from './PrinterActionClient';
import { createPrinterQueryCoordinator } from './PrinterQueryCoordinator';
import { runPrinterAutoFix, type PrinterRepairResult } from './PrinterAutoFix';
import type {
  PrintJobSnapshot, SnapshotCollection, PrinterSnapshot, PrinterQueueActionResult,
  PrinterConfigurationSnapshot, PrinterPermissionChangeResult, PrinterPermissionValues,
} from '../../types/machine';

const actionClient = createPrinterActionClient(runtimeEnvironment, invoke);
const query=createPrinterQueryCoordinator();
const getDiagnostic=(name:string)=>query(name,()=>actionClient.getDiagnostic(name));
const cancelProblemJob=(name:string,id:number)=>query(name,()=>actionClient.cancelProblemJob(name,id));
const repairs=new Map<string,Promise<PrinterRepairResult>>();

export const PrinterService = {
  discoverNetworkPrinters:actionClient.discoverNetworkPrinters,
  addConnection:actionClient.addConnection,
  removePrinter:actionClient.removePrinter,
  getDiagnostic,
  repair(name:string,remoteHint=false):Promise<PrinterRepairResult> {
    const key=name.toLowerCase();const active=repairs.get(key);if(active)return active;
    const run=runPrinterAutoFix({...actionClient,getDiagnostic,cancelProblemJob},name,{remoteHint});repairs.set(key,run);
    void run.finally(()=>repairs.delete(key)).catch(()=>{});return run;
  },
  getNativeState:actionClient.getNativeState,
  getSpooler:actionClient.getSpooler,
  probeConnection:actionClient.probeConnection,
  setPort:actionClient.setPort,
  startSpooler:actionClient.startSpooler,
  restartSpooler:actionClient.restartSpooler,
  resetSpooler:actionClient.resetSpooler,
  async monitorQueue(printerName:string,receive:(event:QueueMonitorEvent)=>void):Promise<()=>void> {
    if(runtimeEnvironment!=='desktop')throw new Error('Disponível no Desktop.');
    const channel=new Channel<QueueMonitorEvent>();channel.onmessage=receive;
    const monitorId=await invoke<string>('start_printer_queue_monitor',{printerName,channel});
    return ()=>{channel.onmessage=()=>{};void invoke('stop_printer_queue_monitor',{monitorId}).catch(()=>{});};
  },
  async getPrinters(): Promise<SnapshotCollection<PrinterSnapshot>> {
    return (await MachineSnapshotService.getSnapshot()).printers;
  },
  async getQueue(printerName: string): Promise<PrintJobSnapshot[]> {
    return query(printerName,()=>actionClient.getQueue(printerName));
  },
  async printTestPage(printerName: string): Promise<void> {
    return actionClient.printTestPage(printerName);
  },
  async cancelJob(printerName: string, jobId: number): Promise<void> {
    return actionClient.cancelJob(printerName, jobId);
  },
  async clearQueue(printerName: string): Promise<PrinterQueueActionResult> {
    return actionClient.clearQueue(printerName);
  },
  async pause(printerName: string): Promise<void> {
    return actionClient.pause(printerName);
  },
  async resume(printerName: string): Promise<void> {
    return actionClient.resume(printerName);
  },
  async setDefault(printerName: string): Promise<void> {
    return actionClient.setDefault(printerName);
  },
  async rename(printerName: string, newName: string): Promise<void> {
    return actionClient.rename(printerName, newName);
  },
  async setShare(printerName: string, enabled: boolean, shareName: string | null): Promise<void> {
    return actionClient.setShare(printerName, enabled, shareName);
  },
  async setLocation(printerName: string, location: string): Promise<void> {
    return actionClient.setLocation(printerName, location);
  },
  async setComment(printerName: string, comment: string): Promise<void> {
    return actionClient.setComment(printerName, comment);
  },
  async getConfiguration(printerName: string): Promise<PrinterConfigurationSnapshot> {
    return actionClient.getConfiguration(printerName);
  },
  async getPauseState(printerName: string): Promise<boolean> {
    return actionClient.getPauseState(printerName);
  },
  async configurePermissions(printerName: string): Promise<void> {
    return actionClient.configurePermissions(printerName);
  },
  async setPermissions(
    printerName: string,
    trusteeSid: string,
    expectedBefore: PrinterPermissionValues,
    after: PrinterPermissionValues,
  ): Promise<PrinterPermissionChangeResult> {
    return actionClient.setPermissions(printerName, trusteeSid, expectedBefore, after);
  }
};
