import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { GeneralDiagnosisService } from '../services/diagnosis/GeneralDiagnosisService';
import { diagnosisAreas, type DiagnosisArea, type DiagnosisResult, type RemediationAttempt } from '../services/diagnosis/types';
import { runtimeEnvironment } from '../services/runtime/environment';
import '../general-diagnosis.css';

export const diagnosisAreaLabels: Record<DiagnosisArea, string> = {
  system: 'Sistema', network: 'Rede', services: 'Serviços', firebird: 'Firebird',
  printing: 'Impressão', dependencies: 'Dependências', compliance: 'Conformidade relevante',
};
const confidenceLabels = { confirmed: 'Confirmado', probable: 'Provável', inconclusive: 'Inconclusivo' };
const attemptLabels = { resolved: 'Resolvido', improved: 'Melhorou', unresolved: 'Não resolvido', failed: 'Falhou', requires_manual_action: 'Requer ação manual' };
const remediationLabels = { automatic: 'Correção conhecida com confirmação e revalidação', assisted: 'Procedimento assistido na ferramenta especializada', manual: 'Verificação manual na ferramenta especializada', none: 'Sem ação aplicável' };
type Plan = ReturnType<typeof GeneralDiagnosisService.preview>;

export function GeneralDiagnosisPanel({ onCompliance, onComplete, service = GeneralDiagnosisService }: { onCompliance: () => void; onComplete?: () => void; service?: typeof GeneralDiagnosisService }) {
  const [result, setResult] = useState<DiagnosisResult | null>(service.result);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<Partial<Record<DiagnosisArea, string>>>({});
  const [plan, setPlan] = useState<Plan | null>(null);
  const [attempts, setAttempts] = useState<RemediationAttempt[]>([]);
  const mounted = useRef(true);
  const running = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const reportProgress = (area: DiagnosisArea, state: 'collecting' | 'done') => {
    if (mounted.current) setProgress(previous => ({ ...previous, [area]: state === 'collecting' ? 'Verificando…' : 'Consultado' }));
  };
  const run = async () => {
    if (running.current || runtimeEnvironment !== 'desktop') return;
    running.current = true; setBusy(true); setError(''); setAttempts([]); setProgress({});
    try { const next = await service.run(reportProgress); if (mounted.current) { setResult(next); onComplete?.(); } }
    catch (cause) { if (mounted.current) setError(String(cause)); }
    finally { running.current = false; if (mounted.current) setBusy(false); }
  };
  const execute = async () => {
    if (!plan || running.current || runtimeEnvironment !== 'desktop') return;
    const ids = plan.map(step => step.id);
    setPlan(null); setError(''); running.current = true; setBusy(true);
    try {
      const next = await service.remediate(ids, true, reportProgress);
      if (mounted.current) { setResult(next.result); setAttempts(previous => [...previous, ...next.attempts]); }
    } catch (cause) { if (mounted.current) { setError(String(cause)); setResult(service.result); } }
    finally { running.current = false; if (mounted.current) setBusy(false); }
  };
  const safePlan = result ? service.preview() : [];
  return <section className="general-diagnosis" aria-label="Diagnóstico Geral">
    <div className="validation-toolbar"><p>Verificações locais somente leitura. Correções exigem um plano confirmado.</p><button className="primary" disabled={busy || runtimeEnvironment !== 'desktop'} onClick={() => void run()}>{busy ? 'Verificando / revalidando…' : 'Verificar computador'}</button></div>
    {runtimeEnvironment !== 'desktop' && <p className="notice">O diagnóstico local exige o CENTRAL SOS Desktop no Windows. Nenhum dado é simulado no navegador.</p>}
    {error && <p className="error">{error}</p>}
    {busy && <ol className="diagnosis-progress" aria-live="polite">{diagnosisAreas.map(area => <li key={area}>{diagnosisAreaLabels[area]} <small>{progress[area] ?? 'Aguardando'}</small></li>)}</ol>}
    {result && <>
      <h2>{busy ? 'Resultado anterior · verificação em andamento' : 'Diagnóstico concluído'}</h2>
      <p className="snapshot-note">Consultado em {new Date(result.capturedAt).toLocaleString('pt-BR')}.</p>
      <div className="diagnosis-summary" aria-live="polite"><span><b>{result.summary.problems}</b> problemas</span><span><b>{result.summary.warnings}</b> atenções</span><span><b>{result.summary.healthyAreas}</b> áreas saudáveis</span><span><b>{result.summary.inconclusiveAreas}</b> áreas inconclusivas</span></div>
      {!result.incidents.length && <p className="notice">Nenhum incidente nos dados verificados.{result.summary.inconclusiveAreas > 0 ? ' Existem áreas inconclusivas; a saúde completa não foi confirmada.' : ''}</p>}
      <div className="diagnosis-incidents">{result.incidents.map(incident => <article className={`panel diagnosis-incident ${incident.severity}`} key={incident.id}>
        <header><h3>{incident.severity === 'problem' ? '✕' : '⚠'} {incident.title}</h3><small>{confidenceLabels[incident.confidence]}</small></header>
        {incident.description !== incident.title && <p>{incident.description}</p>}
        <p>{incident.suggestedAction}</p>
        <div className="support-actions">{runtimeEnvironment === 'desktop' && service.preview([incident.id]).length > 0 && <button className="primary" disabled={busy} onClick={() => setPlan(service.preview([incident.id]))}>Corrigir</button>}<Link className="linkbtn" to={incident.toolRoute}>Abrir {diagnosisAreaLabels[incident.source]}</Link></div>
        <details className="support-details"><summary>{incident.remediation.kind === 'automatic' ? 'Ver detalhes' : 'Ver orientação e evidências'}</summary><ul>{incident.evidence.map((item, index) => <li key={index}>{item}</li>)}</ul><small>Tratamento: {remediationLabels[incident.remediation.kind]}</small></details>
      </article>)}</div>
      <button className="primary" disabled={busy || !safePlan.length || runtimeEnvironment !== 'desktop'} onClick={() => setPlan(service.preview())}>Corrigir tudo o que for possível ({safePlan.length})</button>
      <p className="snapshot-note">Somente ações conhecidas e permitidas. Uma ação por vez; cada resultado é consultado novamente.</p>
      {attempts.length > 0 && <section className="panel" aria-live="polite"><h3>Resultado das correções</h3>{attempts.map((attempt, index) => <p key={index}><b>{attempt.title} · {attemptLabels[attempt.state]}</b><br/>{attempt.message}</p>)}</section>}
      <details className="support-details"><summary>Verificações saudáveis ({result.summary.healthyAreas})</summary>{result.areas.filter(a => a.state === 'healthy').map(a => <p key={a.area}>✓ {diagnosisAreaLabels[a.area]} · {a.detail}</p>)}</details>
      <details className="support-details"><summary>Detalhes técnicos e inventário</summary>{result.areas.filter(a => a.state !== 'healthy').map(a => <p key={a.area}><b>{diagnosisAreaLabels[a.area]}</b> · {a.detail}</p>)}{result.findings.filter(f => f.severity === 'info').map((f, index) => <details key={`${f.id}-${index}`}><summary>{f.title}</summary><p>{f.suggestedAction}</p><ul>{f.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul></details>)}<pre>{JSON.stringify(service.observations, null, 2)}</pre></details>
      <button className="linkbtn" onClick={onCompliance}>Abrir Conformidade SOS</button>
    </>}
    {plan && <div className="support-modal-backdrop"><section className="support-modal diagnosis-plan" role="dialog" aria-modal="true" aria-labelledby="diagnosis-plan-title"><h2 id="diagnosis-plan-title">Confirmar plano de correção</h2><p>As ações serão executadas sequencialmente. Revise o impacto antes de confirmar.</p><ol>{plan.map(step => <li key={step.id}><b>{step.title}</b><p>{step.description}</p><small>Ação: {step.actionId}{step.target ? ` · ${step.target}` : ''}</small></li>)}</ol><div className="support-actions"><button className="linkbtn" autoFocus onClick={() => setPlan(null)}>Cancelar</button><button className="primary" onClick={() => void execute()}>Confirmar e corrigir</button></div></section></div>}
  </section>;
}
