import { check, type Update } from '@tauri-apps/plugin-updater';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { runtimeEnvironment } from '../runtime/environment';
import { compareVersions } from './UpdateContract';
export interface UpdateState {
    configured: boolean;
    currentVersion: string;
    availableVersion: string | null;
    checkedAt: string | null;
    busy: boolean;
    message: string;
}
type Candidate = Pick<Update, 'version' | 'downloadAndInstall' | 'close'>;
export function createUpdater(runtime: string, config: () => Promise<{
    configured: boolean;
}>, current: () => Promise<string>, checker: () => Promise<Candidate | null>, restart: () => Promise<void>) {
    let candidate: Candidate | null = null;
    let state: UpdateState = { configured: false, currentVersion: '', availableVersion: null, checkedAt: null, busy: false, message: '' };
    const subscribers = new Set<() => void>();
    const publish = () => subscribers.forEach(fn => fn());
    return { getState: () => state, subscribe: (fn: () => void) => { subscribers.add(fn); return () => { subscribers.delete(fn); }; },
        async verify() { if (runtime !== 'desktop' || state.busy)
            return; state = { ...state, busy: true, message: '' }; publish(); try {
            state = { ...state, currentVersion: await current(), configured: (await config()).configured };
            if (!state.configured) {
                state = { ...state, message: 'Atualizações não configuradas: faltam chave pública e endpoint HTTPS no build.' };
                return;
            }
            const next = await checker();
            await candidate?.close();
            candidate = next;
            if (next && compareVersions(next.version, state.currentVersion) <= 0) {
                await next.close();
                candidate = null;
            }
            state = { ...state, availableVersion: candidate?.version ?? null, checkedAt: new Date().toISOString(), message: candidate ? 'Nova versão disponível.' : 'Nenhuma atualização disponível.' };
        }
        catch (e) {
            await candidate?.close().catch(() => undefined);
            candidate = null;
            state = { ...state, availableVersion: null, message: String(e) };
        }
        finally {
            state = { ...state, busy: false };
            publish();
        } },
        async install(confirmed: boolean) { if (!confirmed || runtime !== 'desktop' || state.busy || !state.configured || !candidate)
            throw Error('Atualização requer configuração, candidato válido e confirmação.'); state = { ...state, busy: true, message: 'Baixando e validando assinatura…' }; publish(); try {
            await candidate.downloadAndInstall(undefined, { timeout: 120000 });
            await restart();
        }
        catch (e) {
            state = { ...state, message: `Atualização recusada ou não concluída: ${String(e)}` };
            throw e;
        }
        finally {
            state = { ...state, busy: false };
            publish();
        } }
    };
}
export const UpdaterService = createUpdater(runtimeEnvironment, () => invoke('updater_configuration'), getVersion, () => check({ timeout: 15000 }), () => invoke('restart_after_update'));
