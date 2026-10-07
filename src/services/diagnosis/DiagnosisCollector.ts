import type { MachineSnapshot, SnapshotCollection, WindowsServiceSnapshot } from '../../../packages/contracts/machine';
import type { PrinterDiagnosticSnapshot, SpoolerState } from '../../../packages/contracts/printer-diagnostic';
import type { FirebirdSnapshot, NetworkSupportSnapshot, SoftwareInfo, SystemSupportSnapshot } from '../../types/support';
import type { MachineValidationRun } from '../../../packages/contracts/validation';
import { diagnosisAreas, type DiagnosisArea, type DiagnosisObservations, type Progress } from './types';

export interface CollectionClients {
  machine(): Promise<MachineSnapshot>;
  system(): Promise<SystemSupportSnapshot>;
  network(): Promise<NetworkSupportSnapshot>;
  services(): Promise<SnapshotCollection<WindowsServiceSnapshot>>;
  firebird(): Promise<FirebirdSnapshot>;
  dependencies(): Promise<SnapshotCollection<SoftwareInfo>>;
  spooler(): Promise<[SpoolerState, boolean]>;
  printer(name: string): Promise<PrinterDiagnosticSnapshot>;
  compliance(snapshot: MachineSnapshot): Promise<MachineValidationRun>;
  hasProfile(): boolean;
}
export const emptyObservations = (): DiagnosisObservations => ({
  machine: null, system: null, network: null, services: null, firebird: null,
  printing: null, dependencies: null, compliance: null, errors: {},
});

export function createDiagnosisCollector(clients: CollectionClients) {
  return async (previous = emptyObservations(), targets: readonly DiagnosisArea[] = diagnosisAreas, progress?: Progress) => {
    const data: DiagnosisObservations = { ...previous, errors: { ...previous.errors } };
    let machineError: string | undefined;
    // One base snapshot per explicit full run. Revalidation uses targeted existing services.
    if (targets === diagnosisAreas || !data.machine) {
      progress?.('system', 'collecting');
      try { data.machine = await clients.machine(); delete data.errors.system; }
      catch (error) { machineError = String(error); data.errors.system = machineError; }
    }
    for (const area of targets) {
      progress?.(area, 'collecting');
      // Retain previous evidence on failed revalidation; an error cannot prove resolution.
      const baseError = area === 'system' ? machineError : undefined;
      delete data.errors[area];
      try {
        switch (area) {
          case 'system': data.system = await clients.system(); if (baseError) data.errors.system = baseError; break;
          case 'network': data.network = await clients.network(); break;
          case 'services': data.services = await clients.services(); break;
          case 'firebird': data.firebird = await clients.firebird(); break;
          case 'dependencies': data.dependencies = await clients.dependencies(); break;
          case 'compliance':
            data.compliance = null;
            if (clients.hasProfile()) {
              if (!data.machine) throw new Error('Snapshot da máquina indisponível.');
              data.compliance = await clients.compliance(data.machine);
            }
            break;
          case 'printing': {
            const [spooler, elevated] = await clients.spooler();
            const printers = [];
            for (const printer of data.machine?.printers.items ?? []) {
              try { printers.push({ name: printer.name, isDefault: printer.isDefault, snapshot: await clients.printer(printer.name), error: null }); }
              catch (error) { printers.push({ name: printer.name, isDefault: printer.isDefault, snapshot: null, error: String(error) }); }
            }
            data.printing = { spooler, elevated, printers, inventoryError: data.machine?.printers.error ?? (!data.machine ? 'Inventário de impressoras indisponível.' : null) };
            break;
          }
        }
      } catch (error) { data.errors[area] = error instanceof Error ? error.message : String(error); }
      progress?.(area, 'done');
    }
    return data;
  };
}
