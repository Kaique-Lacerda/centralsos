import { MachineSnapshotService } from '../snapshot/MachineSnapshotService';
import type { SnapshotCollection, VolumeSnapshot } from '../../../packages/contracts/machine';

export const StorageService = {
  async getVolumes(): Promise<SnapshotCollection<VolumeSnapshot>> {
    return (await MachineSnapshotService.getSnapshot()).storage;
  }
};
