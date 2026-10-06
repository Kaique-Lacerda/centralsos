import { LocalConfigService } from '../runtime/localConfig';
import { MachineSnapshotService } from '../snapshot/MachineSnapshotService';
import { InstallationSnapshotService } from './installation/InstallationSnapshotService';
import { ValidationEngine } from './ValidationEngine';
import type { MachineValidationRun } from './types';
import type { MachineSnapshot } from '../../types/machine';

export async function runMachineValidation(existingSnapshot?: MachineSnapshot): Promise<MachineValidationRun> {
  const environment = LocalConfigService.load();
  if (!environment) throw new Error('Configure o perfil da máquina antes de executar a validação.');

  const [snapshot, installation] = await Promise.all([
    existingSnapshot ? Promise.resolve(existingSnapshot) : MachineSnapshotService.getSnapshot(),
    InstallationSnapshotService.getSnapshot()
  ]);
  const results = ValidationEngine.run({ snapshot, installation }, environment.machineRole);
  return {
    profile: environment.machineRole,
    snapshot,
    results,
    summary: ValidationEngine.summarize(results)
  };
}
