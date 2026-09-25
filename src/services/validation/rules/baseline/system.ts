import type { MachineRole } from '../../../../types';
import type { ValidationContext, ValidationResult, ValidationRule } from '../../types';

const bothProfiles: readonly MachineRole[] = ['terminal', 'server'];

function availableFieldRule(
  id: string,
  name: string,
  field: 'hostname' | 'username' | 'operatingSystem' | 'architecture'
): ValidationRule {
  return {
    id,
    name,
    category: 'system',
    profiles: bothProfiles,
    validate({ snapshot }: ValidationContext): ValidationResult {
      const value = snapshot.system[field]?.trim();
      if (value) {
        return { ruleId: id, title: name, category: 'system', status: 'success', severity: 'info', description: `${name} disponível.`, expected: 'Informação disponível', actual: value };
      }
      if (snapshot.system.error) {
        return { ruleId: id, title: name, category: 'system', status: 'skipped', severity: 'info', description: `Não foi possível verificar ${name.toLowerCase()} devido a uma falha parcial da coleta.`, expected: 'Informação disponível', actual: 'Não verificado' };
      }
      return { ruleId: id, title: name, category: 'system', status: 'warning', severity: 'warning', description: `${name} não foi informado pelo sistema.`, expected: 'Informação disponível', actual: 'Indisponível', suggestedAction: 'Verifique se a fonte de dados do sistema está acessível.' };
    }
  };
}

export const systemRules: readonly ValidationRule[] = [
  availableFieldRule('system-hostname', 'Hostname disponível', 'hostname'),
  availableFieldRule('system-username', 'Usuário disponível', 'username'),
  availableFieldRule('system-operating-system', 'Sistema operacional disponível', 'operatingSystem'),
  availableFieldRule('system-architecture', 'Arquitetura disponível', 'architecture')
];
