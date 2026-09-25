import type { MachineRole } from '../../types';
import { resourceRules } from './rules/baseline/resources';
import { systemRules } from './rules/baseline/system';
import { serverRules } from './rules/server/installation';
import { terminalRules } from './rules/terminal/baseline';
import type { ValidationCategory, ValidationResult, ValidationRule } from './types';

const baselineRules: readonly ValidationRule[] = [...systemRules, ...resourceRules];
const rules: readonly ValidationRule[] = [...baselineRules, ...terminalRules, ...serverRules];

export const ValidationRegistry = {
  rules,
  getApplicableRules(profile: MachineRole): readonly ValidationRule[] {
    return rules.filter(rule => rule.profiles.includes(profile) || (profile === 'server' && rule.profiles.includes('terminal')));
  }
};

export function groupValidationResults(results: readonly ValidationResult[]): Record<ValidationCategory, ValidationResult[]> {
  return {
    system: results.filter(r => r.category === 'system'), network: results.filter(r => r.category === 'network'),
    sharing: results.filter(r => r.category === 'sharing'), files: results.filter(r => r.category === 'files'),
    printers: results.filter(r => r.category === 'printers'), storage: results.filter(r => r.category === 'storage'),
    database: results.filter(r => r.category === 'database'), firebird: results.filter(r => r.category === 'firebird'),
    backup: results.filter(r => r.category === 'backup'), ibconsole: results.filter(r => r.category === 'ibconsole'),
    cloud_accounting: results.filter(r => r.category === 'cloud_accounting')
  };
}
