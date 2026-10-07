import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { commandPolicies, commandDefinitions, PROTOCOL_VERSION, buildTopology, type Device, type Environment, type CommandType, type RemoteCommandResult } from '../../control/contracts';
import { ControlService } from '../../services/control/ControlService';
import { compareVersions } from '../../services/updater/UpdateContract';
import { getLatestWindowsRelease } from '../../services/releases/GitHubReleaseService';
import { useSupportConfirmation } from '../support/SupportUI';
import '../../support-tools.css';
import '../../control.css';
const labels: Record<CommandType, string> = { 'machine.refresh': 'Atualizar máquina', 'machine.validate': 'Validar máquina', 'printer.check': 'Verificar impressora', 'printer.auto_fix': 'Verificar e corrigir impressora', 'spooler.restart': 'Reiniciar Spooler', 'service.check': 'Consultar serviços' };
export function ControlPage() {
    const [devices, setDevices] = useState<Device[]>([]);
    const [environments, setEnvironments] = useState<Environment[]>([]);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [selected, setSelected] = useState('');
    const [printer, setPrinter] = useState('');
    const [commandId, setCommandId] = useState('');
    const [result, setResult] = useState<RemoteCommandResult | null>(null);
    const [state, setState] = useState('');
    const [latest, setLatest] = useState<string | null>(null);
    const [history, setHistory] = useState<Awaited<ReturnType<typeof ControlService.device>>['history']>([]);
    const [pair, setPair] = useState('');
    const [pairProfile, setPairProfile] = useState<'TERMINAL' | 'SERVER'>('TERMINAL');
    const [pairServer, setPairServer] = useState('');
    const { confirm, dialog } = useSupportConfirmation();
    const refresh = useCallback(async () => { setError(''); try {
        const [e, d] = await Promise.all([ControlService.environments(), ControlService.devices()]);
        setEnvironments(e);
        setDevices(d);
    }
    catch (e) {
        setError(String(e));
    } }, []);
    useEffect(() => { void refresh(); const timer = setInterval(refresh, 30000); void getLatestWindowsRelease().then(r => { if (r.status === 'available' && r.version)
        setLatest(r.version.replace(/^v/, '')); }).catch(() => undefined); return () => clearInterval(timer); }, [refresh]);
    useEffect(() => { if (!selected)
        return; let live = true; void ControlService.device(selected).then(r => { if (live)
        setHistory(r.history); }).catch(e => { if (live)
        setError(String(e)); }); return () => { live = false; }; }, [selected, state]);
    useEffect(() => { if (!commandId || ['SUCCEEDED', 'FAILED', 'REJECTED', 'EXPIRED'].includes(state))
        return; let live = true; const poll = () => ControlService.command(commandId).then(r => { if (live) {
        setState(r.command.status);
        setResult(r.result);
    } }).catch(e => { if (live)
        setError(String(e)); }); void poll(); const timer = setInterval(poll, 5000); return () => { live = false; clearInterval(timer); }; }, [commandId, state]);
    const send = async (type: CommandType) => { if (busy || !selected)
        return; if (commandPolicies[type] === 'CONFIRMATION_REQUIRED' && !await confirm(`${labels[type]} no dispositivo selecionado? Pode remover jobs comprovadamente problemáticos ou interromper temporariamente a impressão. A ação será auditada.`))
        return; setBusy(true); setError(''); setResult(null); try {
        const payload = type.startsWith('printer.') && printer.trim() ? { printerName: printer.trim() } : {};
        const c = await ControlService.send(selected, { type, payload, confirmed: commandPolicies[type] === 'CONFIRMATION_REQUIRED' } as Parameters<typeof ControlService.send>[1]);
        setCommandId(c.id);
        setState(c.status);
    }
    catch (e) {
        setError(String(e));
    }
    finally {
        setBusy(false);
    } };
    const outdated = devices.filter(d => latest && compareVersions(d.appVersion, latest) < 0).length;
    return <main className="control-page"><header className="support-heading"><div><small>CENTRAL SOS CONTROL</small><h1>Ambientes e dispositivos</h1><p>Suporte por comandos conhecidos, sem controle de tela.</p></div><div className="support-actions"><Link to="/">Ferramentas locais</Link><a href="/api/control/auth/login">Entrar</a><button className="primary" onClick={() => void refresh()}>Atualizar</button></div></header>{error && <p className="error">{error}</p>}<p>{devices.length} dispositivos · {devices.filter(d => d.status === 'OFFLINE').length} offline · {latest ? `${devices.length - outdated} na versão atual ou superior · ${outdated} desatualizados` : 'Versão publicada não confirmada'}</p>{environments.map(env => {
            const list = devices.filter(d => d.environmentId === env.id);
            const tree = buildTopology(list);
            const card = (d: Device) => <button key={d.id} className={`control-device ${d.status === 'OFFLINE' ? 'offline' : d.healthSummary ?? 'unknown'}`} onClick={() => setSelected(d.id)}><b>{d.displayName}</b><span>{d.status === 'NEVER_CONNECTED' ? 'Nunca conectado' : d.status === 'OFFLINE' ? 'Offline' : d.status === 'DEGRADED' ? 'Degradado · ver detalhes' : d.healthSummary === 'critical' ? 'Problema' : d.healthSummary === 'warnings' ? 'Atenção' : d.healthSummary === 'ok' ? 'OK' : 'Online · não verificado'}</span><small>{d.profile} · App {d.appVersion} · Agent {d.agentVersion} · Core {d.coreVersion} · Protocolo {d.protocolVersion}</small><small>Última comunicação: {d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : 'Nenhuma'}{latest && compareVersions(d.appVersion, latest) < 0 ? ' · Atualização disponível' : ''}</small></button>;
            return <section className="support-card" key={env.id}><h2>{env.name}</h2>{tree.servers.map(group => <div className="control-server" key={group.server.id}>{card(group.server)}<div className="control-terminals">{group.terminals.map(card)}</div></div>)}{tree.unassigned.length > 0 && <><h3>Terminais sem servidor associado</h3>{tree.unassigned.map(card)}</>}<details className="support-details"><summary>Vincular dispositivo a este ambiente</summary><div className="support-form"><select value={pairProfile} onChange={e => setPairProfile(e.target.value as typeof pairProfile)}><option value="TERMINAL">Terminal</option><option value="SERVER">Servidor</option></select>{pairProfile === 'TERMINAL' && <select value={pairServer} onChange={e => setPairServer(e.target.value)}><option value="">Sem associação</option>{list.filter(d => d.profile === 'SERVER').map(d => <option key={d.id} value={d.id}>{d.displayName}</option>)}</select>}<button className="primary" onClick={async () => { try {
                const p = await ControlService.pair(env.id, pairProfile, pairProfile === 'TERMINAL' ? pairServer || null : null);
                setPair(`${p.code} · Expira ${new Date(p.expiresAt).toLocaleTimeString()}`);
            }
            catch (e) {
                setError(String(e));
            } }}>Gerar código temporário</button></div>{pair && <p>{pair}</p>}</details></section>;
        })}{!environments.length && !error && <p>Nenhum ambiente autorizado cadastrado.</p>}{selected && <section className="support-card"><h2>Comandos · {devices.find(d => d.id === selected)?.displayName}</h2><label>Nome exato da impressora (obrigatório para corrigir)<input value={printer} onChange={e => setPrinter(e.target.value)}/></label><div className="support-actions">{(Object.keys(commandPolicies) as CommandType[]).map(type => <button className="primary" key={type} disabled={busy || !devices.some(d => d.id === selected && ['ONLINE', 'DEGRADED'].includes(d.status) && d.protocolVersion === PROTOCOL_VERSION && commandDefinitions[type].allowedDeviceProfiles.includes(d.profile)) || type === 'printer.auto_fix' && !printer.trim()} onClick={() => void send(type)}>{labels[type]}</button>)}</div>{commandId && <p>{state} · {commandId}</p>}{result && <><p>{result.summary}</p><details className="support-details"><summary>Resultado técnico</summary><pre>{JSON.stringify(result.details, null, 2)}</pre></details></>}<h3>Histórico</h3>{history.map(h => <p key={h.id}>{new Date(h.timestamp).toLocaleString()} · {h.actorId} · {h.action} · {h.outcome}{h.durationMs != null ? ` · ${h.durationMs} ms` : ''}</p>)}</section>}{dialog}</main>;
}
