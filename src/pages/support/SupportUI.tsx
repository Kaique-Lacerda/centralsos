import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CircleAlert, RefreshCw, type LucideIcon } from 'lucide-react';
import { runtimeEnvironment } from '../../services/runtime/environment';
import type { SupportCheck } from '../../types/support';
import '../../support-tools.css';

export function useSupportTask<T>() {
  const [result, setResult] = useState<T | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  const running = useRef(false); const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = async (operation: () => Promise<T>) => {
    if (running.current || runtimeEnvironment !== 'desktop') return;
    running.current = true; setBusy(true); setError(''); setMessage('');
    try { const next = await operation(); if (mounted.current) setResult(next); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { running.current = false; if (mounted.current) setBusy(false); }
  };
  return { result, busy, error, message, run, setResult, setMessage };
}
export { useConfirmation as useSupportConfirmation } from '../../components/confirmation/useConfirmation';
export function SupportHeader({ title, description, icon: Icon, busy, action, actionLabel = 'Consultar' }: { title: string; description: string; icon: LucideIcon; busy: boolean; action?: () => void; actionLabel?: string }) {
  return <><header className="support-heading"><div><small>FERRAMENTAS</small><h1><Icon size={23}/>{title}</h1><p>{description}</p></div>{action && <button className="primary" disabled={busy || runtimeEnvironment !== 'desktop'} onClick={action}><RefreshCw size={14}/>{busy ? 'Consultando…' : actionLabel}</button>}</header>{runtimeEnvironment !== 'desktop' && <p className="notice">Esta ferramenta requer o aplicativo Desktop. Nenhum dado local é simulado no navegador.</p>}</>;
}
export function SupportFeedback({ error, message }: { error?: string; message?: string }) { return <>{error && <p className="error"><CircleAlert/>{error}</p>}{message && <p className="notice">{message}</p>}</>; }
export function CheckRow({ label, check }: { label: string; check: SupportCheck }) { const icon = check.state === 'success' ? '✓' : check.state === 'error' ? '✕' : check.state === 'unknown' ? '—' : '⚠'; return <div className={`support-check ${check.state}`}><b>{label}</b><span>{icon} {check.message}</span>{check.latencyMs != null && <small>{check.latencyMs} ms</small>}</div>; }
export function TechnicalDetails({ children, data }: { children?: ReactNode; data?: unknown }) { return <details className="support-details"><summary>Detalhes técnicos</summary>{children}{data !== undefined && <pre>{JSON.stringify(data, null, 2)}</pre>}</details>; }
export function InstallationsLink() { return <Link className="linkbtn" to="/installations">Abrir em Instalações</Link>; }
export const formatBytes = (bytes: number | null) => bytes == null ? 'Não informado' : `${(bytes / 1024 ** 3).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} GB`;
