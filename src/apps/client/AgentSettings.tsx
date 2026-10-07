import { useEffect, useState, useSyncExternalStore } from 'react';
import { AgentLinkService, type AgentLinkStatus } from '../../services/control/AgentLinkService';
import { UpdaterService } from '../../services/updater/UpdaterService';
import { runtimeEnvironment } from '../../services/runtime/environment';
import { useSupportConfirmation } from '../../pages/support/SupportUI';
export function ControlIndicator() { const [status, setStatus] = useState<AgentLinkStatus | null>(null); useEffect(() => { if (runtimeEnvironment !== 'desktop')
    return; let live = true; const refresh = () => AgentLinkService.status().then(s => { if (live)
    setStatus(s); }).catch(() => { if (live)
    setStatus(null); }); void refresh(); const timer = setInterval(refresh, 30000); const update = setTimeout(() => void UpdaterService.verify(), 2000); return () => { live = false; clearInterval(timer); clearTimeout(update); }; }, []); return runtimeEnvironment === 'desktop' ? <small className="control-indicator">Control · {status?.connected ? '● Conectado' : status?.linked ? '○ Offline' : '○ Não vinculado'}</small> : null; }
export function DesktopControlSettings() {
    const [status, setStatus] = useState<AgentLinkStatus | null>(null);
    const [url, setUrl] = useState('');
    const [code, setCode] = useState('');
    const [profile, setProfile] = useState<'TERMINAL' | 'SERVER'>('TERMINAL');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const { confirm, dialog } = useSupportConfirmation();
    const update = useSyncExternalStore(UpdaterService.subscribe, UpdaterService.getState);
    useEffect(() => { if (runtimeEnvironment === 'desktop')
        void AgentLinkService.status().then(setStatus).catch(e => setError(String(e))); }, []);
    const run = async (work: () => Promise<unknown>) => { if (busy)
        return; setBusy(true); setError(''); try {
        await work();
        setStatus(await AgentLinkService.status());
    }
    catch (e) {
        setError(String(e));
    }
    finally {
        setBusy(false);
    } };
    if (runtimeEnvironment !== 'desktop')
        return null;
    return <><section className="support-card"><h2>CENTRAL SOS Control</h2><p>{status?.connected ? 'Conectado' : status?.linked ? 'Offline' : 'Não vinculado'}</p>{status?.linked ? <><p>Device ID: {status.deviceId}</p><p>Ambiente: {status.environment} · Perfil: {status.profile} · Servidor: {status.serverName ?? status.serverDeviceId ?? 'Não associado'}</p><p>Agent: {status.agentVersion ?? 'Ainda não observado'} · Core: {status.coreVersion ?? 'Não informado'} · Protocolo: {status.protocolVersion ?? 'Não informado'} · Última comunicação: {status.lastCommunication ? new Date(status.lastCommunication).toLocaleString() : 'Ainda não registrada'}</p>{!status.serviceInstalled && <p>Agent ainda não instalado como serviço. O pareamento não instala/inicia o serviço.</p>}<button className="linkbtn" disabled={busy} onClick={async () => { if (await confirm('Desvincular este dispositivo e revogar a credencial no backend? Exige conexão; as ferramentas locais continuam disponíveis.'))
        void run(() => AgentLinkService.unlink(true)); }}>Desvincular dispositivo</button></> : <form className="support-form" onSubmit={e => { e.preventDefault(); void run(() => AgentLinkService.enroll(url, code, profile)); }}><label>Backend HTTPS<input required type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="Origem HTTPS configurada pelo suporte"/></label><label>Código temporário<input required value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="SOS-XXXX-XXXX" maxLength={13}/></label><label>Perfil<select value={profile} onChange={e => setProfile(e.target.value as typeof profile)}><option value="TERMINAL">Terminal</option><option value="SERVER">Servidor</option></select></label><button className="primary" disabled={busy}>Vincular este dispositivo</button></form>}{error && <p className="error">{error}</p>}</section><section className="support-card"><h2>Sobre / Atualizações</h2><p>Versão atual: {update.currentVersion || 'Consultando…'}</p><p>Verificação automática: {update.configured ? 'Ativada; instalação manual' : 'Aguardando configuração de assinatura'}</p><p>Última verificação: {update.checkedAt ? new Date(update.checkedAt).toLocaleString() : 'Ainda não realizada'}</p><p>{update.message}</p><button className="linkbtn" disabled={update.busy} onClick={() => void UpdaterService.verify()}>Verificar atualizações</button>{update.availableVersion && <><p>Nova versão disponível: {update.availableVersion}</p><button className="primary" disabled={update.busy} onClick={async () => { if (await confirm('Baixar a atualização assinada, instalar e reiniciar o CENTRAL SOS?'))
        try {
            await UpdaterService.install(true);
        }
        catch { /* State retains the verification/install error. */ } }}>Atualizar agora</button></>}</section>{dialog}</>;
}
