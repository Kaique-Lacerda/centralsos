import { useCallback, useEffect, useRef, useState } from 'react';
import { ToolsCatalogPage } from '../components/distribution/ToolsCatalogPage';
import { getGitHubToolsCatalog, type CatalogTool } from '../services/tools/GitHubToolsService';
import { getToolInstallationStatus } from '../services/tools/ToolInstallationStatus';
import { runtimeEnvironment } from '../services/runtime/environment';
import { InstallationSnapshotService } from '../services/validation/installation/InstallationSnapshotService';
import type { InstallationSnapshot } from '../../packages/contracts/validation';

const loadClientCatalog = (refresh: boolean) => getGitHubToolsCatalog({ refresh, runtime: runtimeEnvironment });
export function InstallationsPage() {
    const [installation, setInstallation] = useState<InstallationSnapshot | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const mounted = useRef(true);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const collect = useCallback(() => {
        if (runtimeEnvironment !== 'desktop') return;
        setLoading(true); setError(null);
        void InstallationSnapshotService.getSnapshot().then(snapshot => {
            if (!mounted.current) return;
            setInstallation(snapshot);
            if (!snapshot) setError('A consulta local de instalações não retornou dados.');
        }).catch(cause => {
            if (!mounted.current) return;
            setInstallation(null);
            setError(cause instanceof Error ? cause.message : 'Falha ao consultar as instalações locais.');
        }).finally(() => { if (mounted.current) setLoading(false); });
    }, []);
    const renderInstallation = (tool: CatalogTool) => {
        const detection = getToolInstallationStatus(tool, installation, runtimeEnvironment, error);
        const state = tool.assetStatus === 'available' ? detection : { ...detection, state: 'unavailable', label: 'Indisponível' };
        return <><div className={`installation-state-badge ${state.state}`}>{loading ? 'Consultando instalação…' : state.label}</div>
            <div className="installation-tool-metadata">
                <span>Instalada: {state.installedVersion ?? (state.state === 'not-installed' ? 'Não instalada' : 'Não detectada')}</span>
                {state.installedLocation && <span>Local: {state.installedLocation}</span>}
                {state.installedArchitecture && <span>Arquitetura instalada: {state.installedArchitecture}</span>}
            </div></>;
    };
    return <ToolsCatalogPage loadCatalog={loadClientCatalog} onRefresh={collect} renderInstallation={renderInstallation} />;
}
