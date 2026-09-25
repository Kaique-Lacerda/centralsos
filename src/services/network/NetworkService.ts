import { MachineSnapshotService } from '../snapshot/MachineSnapshotService';
import type { SnapshotCollection, NetworkAdapterSnapshot } from '../../types/machine';

export const NetworkService = {
  async getAdapters(): Promise<SnapshotCollection<NetworkAdapterSnapshot>> {
    return (await MachineSnapshotService.getSnapshot()).network;
  }
};
