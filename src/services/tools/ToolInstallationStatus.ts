import type { InstallationSnapshot } from '../../../packages/contracts/validation';
import type { CatalogTool } from './GitHubToolsService';

export type ToolInstallationState = 'not-installed' | 'installed' | 'update-available' | 'unavailable' | 'error';
export interface ToolInstallationStatus {
  state: ToolInstallationState;
  label: string;
  installedVersion: string | null;
  installedLocation: string | null;
  installedArchitecture: string | null;
}

function normalizeName(value: string) { return value.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function sameVersion(installed: string | null, available: string) {
  return Boolean(installed && installed.trim().replace(/^v/i, '') === available.trim().replace(/^v/i, ''));
}

export function getToolInstallationStatus(
  tool: CatalogTool,
  installation: InstallationSnapshot | null,
  environment: 'web' | 'desktop',
  collectionError: string | null = null
): ToolInstallationStatus {
  const empty = { installedVersion: null, installedLocation: null, installedArchitecture: null };
  if (environment !== 'desktop') return { state: 'unavailable', label: 'Instalação local não detectável na Web', ...empty };
  if (collectionError) return { state: 'error', label: 'Erro na consulta local', ...empty };
  if (!installation) return { state: 'error', label: 'Não foi possível consultar a instalação', ...empty };
  const name = normalizeName(`${tool.id} ${tool.name}`);
  let version: string | null = null;
  let location: string | null = null;
  let architecture: string | null = null;
  let installed = false;
  let queryError: string | null = null;

  if (name.includes('firebird')) {
    installed = installation.firebirdServices.length > 0;
    queryError = installation.firebirdError;
    version = installation.firebirdServices.find(service => service.version)?.version ?? null;
    location = installation.firebirdServices.find(service => service.path)?.path ?? null;
    architecture = installation.firebirdServices.find(service => service.architecture)?.architecture ?? null;
  } else if (name.includes('iboconsole') || name.includes('ibo console')) {
    installed = installation.ibconsoleExecutables.length > 0;
    queryError = installation.ibconsoleError;
    location = installation.ibconsoleExecutables[0] ?? null;
  } else if (name.includes('cobian')) {
    installed = installation.cobian.length > 0;
    queryError = installation.cobianError;
    version = installation.cobian.find(app => app.version)?.version ?? null;
    location = installation.cobian.find(app => app.location)?.location ?? null;
  } else if (name.includes('nuvem') || name.includes('contabil')) {
    installed = installation.nubeContabil.length > 0;
    queryError = installation.nubeContabilError;
    version = installation.nubeContabil.find(app => app.version)?.version ?? null;
    location = installation.nubeContabil.find(app => app.location)?.location ?? null;
  } else {
    return { state: 'unavailable', label: 'Detecção local indisponível', ...empty };
  }

  if (queryError) return { state: 'error', label: 'Erro na consulta local', ...empty };
  if (!installed) return { state: 'not-installed', label: 'Não instalada', ...empty };
  const update = version !== null && !sameVersion(version, tool.version);
  return {
    state: update ? 'update-available' : 'installed',
    label: update ? 'Atualização disponível' : 'Instalada',
    installedVersion: version,
    installedLocation: location,
    installedArchitecture: architecture
  };
}
