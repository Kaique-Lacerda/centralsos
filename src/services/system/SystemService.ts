import { MachineSnapshotService } from '../snapshot/MachineSnapshotService';
import type { MachineSystemSnapshot } from '../../../packages/contracts/machine';

export const SystemService = {
  async getSystemInfo(): Promise<MachineSystemSnapshot> {
    return (await MachineSnapshotService.getSnapshot()).system;
  }
};
