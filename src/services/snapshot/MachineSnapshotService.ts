import { invoke } from '@tauri-apps/api/core';
import { runtimeEnvironment } from '../runtime/environment';
import type { MachineSnapshot } from '../../types/machine';

export const MachineSnapshotService = {
  getSnapshot(): Promise<MachineSnapshot> {
    if (runtimeEnvironment !== 'desktop') {
      return Promise.reject(new Error('A coleta da máquina exige o aplicativo Desktop.'));
    }
    return invoke<MachineSnapshot>('get_machine_snapshot');
  }
};
