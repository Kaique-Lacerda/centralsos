import type { MachineRole } from '../../types';
import type { ValidationContext, OverallValidationStatus, ValidationResult, ValidationRule, ValidationSummary } from './types';
import { ValidationRegistry } from './ValidationRegistry';

function overallStatus(summary: Omit<ValidationSummary, 'overallStatus'>): OverallValidationStatus {
  if (summary.error > 0) return 'action_required';
  if (summary.warning > 0 || summary.skipped > 0 || summary.success === 0) return 'attention';
  return 'operational';
}

export const ValidationEngine = {
  run(context: ValidationContext, profile: MachineRole): ValidationResult[] {
    return this.runRules(context, ValidationRegistry.getApplicableRules(profile));
  },

  runRules(context: ValidationContext, rules: readonly ValidationRule[]): ValidationResult[] {
    return rules.map(rule => {
      try {
        return rule.validate(context);
      } catch (error) {
        return { ruleId: rule.id, title: rule.name, category: rule.category, status: 'error', severity: 'error',
          description: `A regra falhou sem interromper as demais: ${error instanceof Error ? error.message : String(error)}` };
      }
    });
  },

  summarize(results: readonly ValidationResult[]): ValidationSummary {
    const counts = {
      total: results.length, success: results.filter(r => r.status === 'success').length,
      warning: results.filter(r => r.status === 'warning').length, error: results.filter(r => r.status === 'error').length,
      skipped: results.filter(r => r.status === 'skipped' || r.status === 'ignored').length
    };
    return { ...counts, overallStatus: overallStatus(counts) };
  }
};
