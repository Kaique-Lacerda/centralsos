import { invoke } from '@tauri-apps/api/core';
import { runtimeEnvironment } from '../runtime/environment';
import type { HostnameValidation } from './Hostname';
import { validateHostname } from './Hostname';

export interface HostnameChangeResult { hostname: string; restartRequired: boolean }
export type WindowsAdminAction = 'computerManagement' | 'services' | 'registry' | 'networkSettings' | 'adminTerminal';

const commands: Record<WindowsAdminAction, string> = {
  computerManagement: 'open_computer_management',
  services: 'open_services_console',
  registry: 'open_registry_editor',
  networkSettings: 'open_network_settings',
  adminTerminal: 'open_admin_terminal'
};

export const WindowsAdminService = {
  validateHostname(value: string): HostnameValidation { return validateHostname(value); },
  async changeHostname(value: string): Promise<HostnameChangeResult> {
    if (runtimeEnvironment !== 'desktop') throw new Error('A alteração de hostname exige o aplicativo Desktop.');
    const validation = validateHostname(value);
    if (!validation.valid) throw new Error(validation.message);
    return invoke<HostnameChangeResult>('change_hostname', { hostname: value.trim() });
  },
  async open(action: WindowsAdminAction): Promise<void> {
    if (runtimeEnvironment !== 'desktop') throw new Error('As ferramentas administrativas exigem o aplicativo Desktop.');
    await invoke<void>(commands[action]);
  }
};
