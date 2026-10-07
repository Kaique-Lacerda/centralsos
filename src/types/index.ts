import type { MachineRole } from '../../packages/contracts/profile';
export type { MachineRole } from '../../packages/contracts/profile';
export interface MachineEnvironment { companyName: string; machineName: string; machineRole: MachineRole }
export type RuntimeEnvironment = 'web' | 'desktop';
export type SystemInfo = import('../../packages/contracts/machine').MachineSystemSnapshot;
export type LogLevel = 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR';
export interface ToolDefinition { id: string; name: string; description: string; category: string; path: string; availableOn: RuntimeEnvironment[]; enabled: boolean }
