import type { DiagnosisObservations, DiagnosisResult, Finding, Incident } from './types';
import { areaResults, collectFindings } from './Findings';

export function correlateFindings(findings: readonly Finding[]): Incident[] {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    if (finding.severity === 'info' || finding.source === 'compliance') continue;
    const group = groups.get(finding.correlationKey) ?? [];
    group.push(finding); groups.set(finding.correlationKey, group);
  }
  return [...groups.values()].map(group => {
    const lead = group[0];
    const sameAction = group.every(f => f.remediation.actionId === lead.remediation.actionId && f.remediation.target === lead.remediation.target);
    return {
      ...lead, id: lead.correlationKey, findingIds: group.map(f => f.id),
      evidence: [...new Set(group.flatMap(f => f.evidence))],
      severity: group.some(f => f.severity === 'problem') ? 'problem' as const : 'warning' as const,
      confidence: group.some(f => f.confidence === 'inconclusive') ? 'inconclusive' as const : group.some(f => f.confidence === 'probable') ? 'probable' as const : 'confirmed' as const,
      remediation: sameAction ? lead.remediation : { kind: 'manual' as const, requiresConfirmation: false, safeToBatch: false, revalidationTargets: [] },
    };
  }).sort((a, b) => Number(b.severity === 'problem') - Number(a.severity === 'problem'));
}
export function analyzeDiagnosis(data: DiagnosisObservations): DiagnosisResult {
  const findings = collectFindings(data);
  const incidents = correlateFindings(findings);
  const areas = areaResults(data, findings);
  return { capturedAt: Date.now(), findings, incidents, areas, summary: {
    problems: incidents.filter(i => i.severity === 'problem').length,
    warnings: incidents.filter(i => i.severity === 'warning').length,
    healthyAreas: areas.filter(a => a.state === 'healthy').length,
    inconclusiveAreas: areas.filter(a => a.state === 'inconclusive').length,
  } };
}
