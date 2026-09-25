import type { RuntimeEnvironment } from '../../types';
import { isTauri } from '@tauri-apps/api/core';

export const runtimeEnvironment: RuntimeEnvironment = isTauri() ? 'desktop' : 'web';
