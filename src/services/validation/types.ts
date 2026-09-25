import type { MachineRole } from '../../types';
import type { MachineSnapshot } from '../../types/machine';

export type ValidationStatus = 'success' | 'warning' | 'error' | 'skipped' | 'ignored';
export type ValidationSeverity = 'info' | 'warning' | 'error';
export type ValidationCategory = 'system' | 'network' | 'sharing' | 'files' | 'printers' | 'storage' | 'database' | 'firebird' | 'backup' | 'ibconsole' | 'cloud_accounting';
export type OverallValidationStatus = 'operational' | 'attention' | 'action_required';

export interface ValidationResult {
  ruleId: string;
  title: string;
  category: ValidationCategory;
  status: ValidationStatus;
  severity: ValidationSeverity;
  description: string;
  expected?: string;
  actual?: string;
  suggestedAction?: string;
}

export interface ValidationRule {
  id: string;
  name: string;
  category: ValidationCategory;
  profiles: readonly MachineRole[];
  validate(context: ValidationContext): ValidationResult;
}

export interface InspectionValue { value: string | null; error: string | null }
export interface InstalledSoftware { name: string; version: string | null; location: string | null }
export interface FirebirdService { serviceName: string; displayName: string; state: string | null; path: string | null; version: string | null; architecture: string | null }
export interface InstallationSnapshot {
  uacEnableLua: InspectionValue;
  networkDiscovery: InspectionValue;
  automaticNetworkDeviceSetup: InspectionValue;
  filePrinterSharing: InspectionValue;
  passwordProtectedSharing: InspectionValue;
  dllFileName: string | null;
  dllSystem32Exists: InspectionValue;
  dllSyswow64Exists: InspectionValue;
  databaseExists: InspectionValue;
  firebirdServices: FirebirdService[];
  firebirdError: string | null;
  cobian: InstalledSoftware[];
  cobianError: string | null;
  ibconsoleExecutables: string[];
  ibconsoleError: string | null;
  nubeContabil: InstalledSoftware[];
  nubeContabilError: string | null;
}

export interface ValidationContext { snapshot: MachineSnapshot; installation: InstallationSnapshot | null }
export interface ValidationSummary {
  total: number; success: number; warning: number; error: number; skipped: number;
  overallStatus: OverallValidationStatus;
}
export interface MachineValidationRun {
  profile: MachineRole;
  snapshot: MachineSnapshot;
  results: ValidationResult[];
  summary: ValidationSummary;
}
