import { MachineSnapshotService } from '../snapshot/MachineSnapshotService';
import type { SnapshotCollection, PrinterSnapshot } from '../../types/machine';

export const PrinterService = {
  async getPrinters(): Promise<SnapshotCollection<PrinterSnapshot>> {
    return (await MachineSnapshotService.getSnapshot()).printers;
  }
};
