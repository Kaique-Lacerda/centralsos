import type { RuntimeEnvironment } from '../../types';
import { isTauri } from '@tauri-apps/api/core';

export const runtimeEnvironment: RuntimeEnvironment = isTauri() ? 'desktop' : 'web';
export const isDesktopRuntime = runtimeEnvironment === 'desktop';
export const isWebRuntime = runtimeEnvironment === 'web';
export const desktopOnlyMessage = 'Este recurso coleta dados do sistema local e só está disponível no aplicativo desktop do CENTRAL SOS.';
