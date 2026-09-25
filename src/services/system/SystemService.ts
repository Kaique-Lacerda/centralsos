import { MachineSnapshotService } from '../snapshot/MachineSnapshotService';
import type { MachineSystemSnapshot } from '../../types/machine';

export const SystemService = {
  async getSystemInfo(): Promise<MachineSystemSnapshot> {
    return (await MachineSnapshotService.getSnapshot()).system;
  }
};
