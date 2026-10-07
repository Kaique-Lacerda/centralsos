import type { MachineSnapshot, SnapshotCollection, WindowsServiceSnapshot } from '../../../packages/contracts/machine';
import type { PrinterDiagnosticSnapshot, SpoolerState } from '../../../packages/contracts/printer-diagnostic';
import type { FirebirdSnapshot, NetworkSupportSnapshot, SoftwareInfo, SystemSupportSnapshot } from '../../types/support';
import type { MachineValidationRun } from '../../../packages/contracts/validation';

export const diagnosisAreas = ['system', 'network', 'services', 'firebird', 'printing', 'dependencies', 'compliance'] as const;
export type DiagnosisArea = typeof diagnosisAreas[number];
export type Severity = 'problem' | 'warning' | 'info';
export type Confidence = 'confirmed' | 'probable' | 'inconclusive';
export type ActionId = 'spooler.start' | 'printer.resume' | 'printer.cancelErrors' | 'service.start' | 'system.syncTime' | 'network.flushDns';
export interface Remediation {
  kind: 'none' | 'automatic' | 'assisted' | 'manual';
  actionId?: ActionId;
  target?: string;
  requiresConfirmation: boolean;
  safeToBatch: boolean;
  revalidationTargets: DiagnosisArea[];
}
export interface Finding {
  id: string;
  source: DiagnosisArea;
  correlationKey: string;
  title: string;
  description: string;
  severity: Severity;
  confidence: Confidence;
  evidence: string[];
  suggestedAction: string;
  toolRoute: string;
  remediation: Remediation;
}
export interface Incident extends Finding { findingIds: string[] }
export interface PrintingObservation {
  spooler: SpoolerState;
  elevated: boolean;
  printers: { name: string; isDefault: boolean; snapshot: PrinterDiagnosticSnapshot | null; error: string | null }[];
  inventoryError: string | null;
}
export interface DiagnosisObservations {
  machine: MachineSnapshot | null;
  system: SystemSupportSnapshot | null;
  network: NetworkSupportSnapshot | null;
  services: SnapshotCollection<WindowsServiceSnapshot> | null;
  firebird: FirebirdSnapshot | null;
  printing: PrintingObservation | null;
  dependencies: SnapshotCollection<SoftwareInfo> | null;
  compliance: MachineValidationRun | null;
  errors: Partial<Record<DiagnosisArea, string>>;
}
export interface AreaResult { area: DiagnosisArea; state: 'healthy' | 'issues' | 'inconclusive' | 'skipped'; detail: string }
export interface DiagnosisResult {
  capturedAt: number;
  findings: Finding[];
  incidents: Incident[];
  areas: AreaResult[];
  summary: { problems: number; warnings: number; healthyAreas: number; inconclusiveAreas: number };
}
export interface RemediationAttempt {
  incidentId: string;
  title: string;
  actionId: ActionId;
  state: 'resolved' | 'improved' | 'unresolved' | 'failed' | 'requires_manual_action';
  message: string;
  commandAccepted: boolean;
  revalidated: boolean;
}
export type Progress = (area: DiagnosisArea, state: 'collecting' | 'done') => void;
