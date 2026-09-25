import { invoke } from '@tauri-apps/api/core';
import { runtimeEnvironment } from '../../runtime/environment';
import type { InstallationSnapshot } from '../types';

export const InstallationSnapshotService = {
  async getSnapshot(): Promise<InstallationSnapshot | null> {
    if (runtimeEnvironment !== 'desktop') return Promise.reject(new Error('As verificações de configuração exigem o aplicativo Desktop.'));
    try {
      return await invoke<InstallationSnapshot>('get_installation_snapshot');
    } catch {
      // Uma falha nesta coleta complementar não pode impedir as regras do MachineSnapshot.
      return null;
    }
  }
};
