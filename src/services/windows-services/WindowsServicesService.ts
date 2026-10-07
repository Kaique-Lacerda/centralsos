import { invoke } from '@tauri-apps/api/core';
import { runtimeEnvironment } from '../runtime/environment';
import type { SnapshotCollection, WindowsServiceSnapshot } from '../../../packages/contracts/machine';

export const WindowsServicesService = {
  getServices(): Promise<SnapshotCollection<WindowsServiceSnapshot>> {
    if (runtimeEnvironment !== 'desktop') {
      return Promise.reject(new Error('A consulta de serviços exige o aplicativo Desktop Windows.'));
    }
    return invoke<SnapshotCollection<WindowsServiceSnapshot>>('get_windows_services');
  }
};
