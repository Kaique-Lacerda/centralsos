import { analyzeDiagnosis } from './Correlation';
import { createDiagnosisCollector, emptyObservations, type CollectionClients } from './DiagnosisCollector';
import { isProblemJob } from '../../../packages/agent-rules/printers/PrinterAutoFix';
import { canExecuteRemediation, remediationResolved, revalidationComplete } from './RemediationPolicy';
import type { DiagnosisResult, Incident, Progress, RemediationAttempt } from './types';

export interface RemediationClients {
  startSpooler(): Promise<unknown>;
  startService(name: string): Promise<unknown>;
  syncTime(): Promise<unknown>;
  flushDns(): Promise<unknown>;
  resumePrinter(name: string): Promise<unknown>;
  cancelProblemJob(name: string, jobId: number): Promise<boolean>;
}

export function createDiagnosisEngine(collection: CollectionClients, actions: RemediationClients) {
  const collect = createDiagnosisCollector(collection);
  let observations = emptyObservations();
  let result: DiagnosisResult | null = null;
  let busy = false;
  const unverified = new Map<string, Incident>();
  const summarize = () => {
    result = analyzeDiagnosis(observations);
    for (const [id, incident] of unverified) {
      if (remediationResolved(incident, observations)) unverified.delete(id);
      else preserveIncident(incident);
    }
    return result;
  };
  const preserveIncident = (incident: Incident) => {
    if (!result!.incidents.some(i => i.id === incident.id)) {
      result!.incidents.push({ ...incident, confidence: 'inconclusive', evidence: [...incident.evidence, 'A nova coleta não confirmou a resolução.'] });
      result!.summary.problems = result!.incidents.filter(i => i.severity === 'problem').length;
      result!.summary.warnings = result!.incidents.filter(i => i.severity === 'warning').length;
      const area = result!.areas.find(a => a.area === incident.source);
      if (area) { area.state = 'inconclusive'; area.detail = 'A recuperação do último incidente não foi confirmada.'; }
      result!.summary.healthyAreas = result!.areas.filter(a => a.state === 'healthy').length;
      result!.summary.inconclusiveAreas = result!.areas.filter(a => a.state === 'inconclusive').length;
    }
  };
  const plan = (ids?: readonly string[]) => {
    const unique = new Set<string>();
    return (result?.incidents ?? []).filter(i => {
      if (ids && !ids.includes(i.id) || !canExecuteRemediation(i, observations)) return false;
      const key = `${i.remediation.actionId}:${i.remediation.target ?? ''}`;
      if (unique.has(key)) return false;
      unique.add(key); return true;
    });
  };
  return {
    get result() { return result; },
    get observations() { return observations; },
    preview(ids?: readonly string[]) { return plan(ids).map(i => ({ id: i.id, title: i.title, actionId: i.remediation.actionId!, target: i.remediation.target, description: i.suggestedAction })); },
    async run(progress?: Progress): Promise<DiagnosisResult> {
      if (busy) throw new Error('Uma verificação ou correção já está em execução.');
      busy = true;
      try { observations = await collect(emptyObservations(), undefined, progress); return summarize(); }
      finally { busy = false; }
    },
    async remediate(ids: readonly string[], confirmed: boolean, progress?: Progress): Promise<{ result: DiagnosisResult; attempts: RemediationAttempt[] }> {
      if (!confirmed) throw new Error('Confirme o plano de correção antes de executar.');
      if (busy) throw new Error('Uma verificação ou correção já está em execução.');
      if (!result) throw new Error('Execute o diagnóstico antes de corrigir.');
      const selected = plan(ids);
      if (!selected.length || ids.some(id => !selected.some(i => i.id === id))) throw new Error('O plano contém um incidente sem correção automática permitida.');
      busy = true;
      const attempts: RemediationAttempt[] = [];
      try {
        for (const original of selected) {
          const attempt: RemediationAttempt = { incidentId: original.id, title: original.title, actionId: original.remediation.actionId!, state: 'unresolved', commandAccepted: false, revalidated: false, message: '' };
          observations = await collect(observations, original.remediation.revalidationTargets, progress);
          summarize();
          const fresh = result!.incidents.find(i => i.id === original.id);
          if (!revalidationReadable(original)) {
            unverified.set(original.id, original);
            preserveIncident(original);
            attempt.state = 'requires_manual_action'; attempt.message = 'Consulta anterior à ação inconclusiva; nenhuma alteração foi executada.';
            attempts.push(attempt); continue;
          }
          if (!fresh && remediationResolved(original, observations)) {
            attempt.state = 'resolved'; attempt.revalidated = true; attempt.message = 'A consulta confirmou que este incidente já não está presente; nenhuma ação foi executada.';
            attempts.push(attempt); continue;
          }
          if (!fresh || !canExecuteRemediation(fresh, observations)) {
            if (!fresh) { unverified.set(original.id, original); preserveIncident(original); }
            attempt.state = 'requires_manual_action'; attempt.message = 'O estado mudou ou a policy recusou a ação. Abra a ferramenta especializada.';
            attempts.push(attempt); continue;
          }
          let failure = '';
          try {
            switch (fresh.remediation.actionId) {
              case 'spooler.start': await actions.startSpooler(); break;
              case 'service.start': await actions.startService(fresh.remediation.target!); break;
              case 'system.syncTime': await actions.syncTime(); break;
              case 'network.flushDns': await actions.flushDns(); break;
              case 'printer.resume': await actions.resumePrinter(fresh.remediation.target!); break;
              case 'printer.cancelErrors': {
                const printer = observations.printing!.printers.find(p => p.name === fresh.remediation.target)!;
                for (const job of printer.snapshot!.queue.items.filter(isProblemJob)) await actions.cancelProblemJob(printer.name, job.jobId);
                break;
              }
              default: throw new Error('Ação não permitida.');
            }
            attempt.commandAccepted = true;
          } catch (error) { failure = error instanceof Error ? error.message : String(error); }
          observations = await collect(observations, fresh.remediation.revalidationTargets, progress);
          summarize();
          const complete = revalidationComplete(fresh, observations);
          const resolved = remediationResolved(fresh, observations);
          attempt.revalidated = complete;
          if (!complete || !resolved && !result!.incidents.some(i => i.id === fresh.id)) { unverified.set(fresh.id, fresh); preserveIncident(fresh); }
          const remaining = result!.incidents.find(i => i.id === fresh.id);
          if (failure) { attempt.state = 'failed'; attempt.message = `Ação falhou: ${failure}. ${complete ? 'Nova consulta concluída.' : 'Revalidação inconclusiva; incidente mantido.'}`; }
          else if (!complete) { attempt.state = 'unresolved'; attempt.message = 'Correção executada, mas a revalidação não confirmou a resolução. Incidente mantido.'; }
          else if (!remaining && resolved) { attempt.state = 'resolved'; attempt.message = 'Nova consulta confirmou a resolução deste incidente.'; }
          else { attempt.state = remaining?.severity === 'warning' && fresh.severity === 'problem' ? 'improved' : 'unresolved'; attempt.message = 'Correção executada, mas o problema permanece na nova consulta.'; }
          attempts.push(attempt);
        }
        return { result: result!, attempts };
      } finally { busy = false; }
    },
  };

  function revalidationReadable(incident: Incident) {
    // A stopped Spooler can legitimately make queues unreadable before starting.
    if (incident.remediation.actionId === 'spooler.start') return !observations.errors.printing && !!observations.printing && !observations.printing.spooler.error && observations.printing.spooler.state !== null;
    return revalidationComplete(incident, observations);
  }
}
