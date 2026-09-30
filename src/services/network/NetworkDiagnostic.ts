import type { NetworkAdapterSnapshot, SnapshotCollection } from '../../types/machine';

export type NetworkAdapterKind = 'Físico' | 'Virtual' | 'VPN' | 'Sistema' | 'Não determinado';
export type NetworkConnectionState = 'connected' | 'disconnected' | 'connecting' | 'unknown';

const vpnIndicators = ['tailscale', 'wireguard', 'wintun', 'openvpn', 'fortinet', 'anyconnect', 'globalprotect', 'pangp', 'vpn tunnel'];
const wanMiniportIndicators = ['wan miniport'];

function normalized(value: string | null): string {
  return value?.trim().toLocaleLowerCase('pt-BR') ?? '';
}

function adapterEvidence(adapter: NetworkAdapterSnapshot): string[] {
  return [adapter.manufacturer, adapter.productName, adapter.serviceName, adapter.pnpDeviceId, adapter.adapterType]
    .map(normalized)
    .filter(Boolean);
}

export function classifyNetworkAdapter(adapter: NetworkAdapterSnapshot): NetworkAdapterKind {
  const evidence = adapterEvidence(adapter);
  const manufacturer = normalized(adapter.manufacturer);
  const product = normalized(adapter.productName);
  const pnpId = normalized(adapter.pnpDeviceId);
  const adapterName = normalized(adapter.name);
  const deviceDescriptions = [adapterName, product];

  // A tunnel's device/vendor data takes precedence over WMI's PhysicalAdapter flag.
  if (evidence.some(value => vpnIndicators.some(indicator => value.includes(indicator)))) return 'VPN';

  const windowsDevice = manufacturer.includes('microsoft') || pnpId.startsWith('root\\') || pnpId.startsWith('swd\\') || pnpId.startsWith('bth\\');
  const isWanMiniport = deviceDescriptions.some(value => wanMiniportIndicators.some(indicator => value.includes(indicator)));
  const isKernelDebug = deviceDescriptions.some(value => value.includes('kernel debug')) && windowsDevice;
  const isVirtualInfrastructure = deviceDescriptions.some(value =>
    value.includes('wi-fi direct') || value.includes('wifi direct') || value.includes('bluetooth pan') || value.includes('personal area network')
  );
  const isUnusedVirtualInfrastructure = isVirtualInfrastructure && (adapter.physicalAdapter === false || windowsDevice);
  if (isWanMiniport || isKernelDebug || isUnusedVirtualInfrastructure) return 'Sistema';

  if (adapter.physicalAdapter === true) return 'Físico';
  if (adapter.physicalAdapter === false) return 'Virtual';
  return 'Não determinado';
}

export function networkConnectionState(status: string | null): NetworkConnectionState {
  const value = normalized(status);
  if (['conectado', 'autenticado'].includes(value)) return 'connected';
  if (['conectando', 'desconectando', 'autenticando'].includes(value)) return 'connecting';
  if ([
    'desconectado', 'hardware ausente', 'hardware desabilitado', 'desabilitado',
    'falha de hardware', 'mídia desconectada', 'falha de autenticação',
    'endereço inválido', 'credenciais necessárias'
  ].includes(value)) return 'disconnected';
  return 'unknown';
}

export function isUsableIpv4(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  const [first, second] = parts.map(Number);
  return first !== 0 && first !== 127 && !(first === 169 && second === 254) && first < 224;
}

function ipv4Gateway(adapter: NetworkAdapterSnapshot): string | null {
  return adapter.gateways.find(isUsableIpv4) ?? null;
}

export function selectPrimaryAdapter(adapters: readonly NetworkAdapterSnapshot[]): {
  adapter: NetworkAdapterSnapshot | null;
  candidateCount: number;
} {
  const candidates = adapters.filter(adapter => isRelevantNetworkAdapter(adapter) &&
    networkConnectionState(adapter.status) === 'connected' &&
    adapter.ipv4.some(isUsableIpv4) &&
    ipv4Gateway(adapter) !== null
  );
  return { adapter: candidates.length === 1 ? candidates[0] : null, candidateCount: candidates.length };
}

export function isRelevantNetworkAdapter(adapter: NetworkAdapterSnapshot): boolean {
  const kind = classifyNetworkAdapter(adapter);
  if (kind === 'Físico') return true;
  if (kind === 'Sistema') return false;
  return networkConnectionState(adapter.status) === 'connected';
}

export function splitNetworkAdapters(adapters: readonly NetworkAdapterSnapshot[]): {
  visibleAdapters: NetworkAdapterSnapshot[];
  otherAdapters: NetworkAdapterSnapshot[];
} {
  return adapters.reduce<{ visibleAdapters: NetworkAdapterSnapshot[]; otherAdapters: NetworkAdapterSnapshot[] }>((result, adapter) => {
    result[isRelevantNetworkAdapter(adapter) ? 'visibleAdapters' : 'otherAdapters'].push(adapter);
    return result;
  }, { visibleAdapters: [], otherAdapters: [] });
}

export function summarizeNetwork(collection: SnapshotCollection<NetworkAdapterSnapshot>) {
  const { visibleAdapters } = splitNetworkAdapters(collection.items);
  const counts = visibleAdapters.reduce((result, adapter) => {
    const state = networkConnectionState(adapter.status);
    if (state === 'connected') result.connectedCount++;
    if (state === 'disconnected' && classifyNetworkAdapter(adapter) === 'Físico') result.disconnectedPhysicalCount++;
    const kind = classifyNetworkAdapter(adapter);
    if (kind === 'VPN') result.activeVpnCount++;
    return result;
  }, { connectedCount: 0, disconnectedPhysicalCount: 0, activeVpnCount: 0 });
  const infrastructureCount = collection.items.filter(adapter => classifyNetworkAdapter(adapter) === 'Sistema').length;
  const primary = selectPrimaryAdapter(visibleAdapters);
  return {
    relevantCount: visibleAdapters.length,
    ...counts,
    infrastructureCount,
    otherCount: collection.items.length - visibleAdapters.length,
    primary: primary.adapter,
    primaryCandidateCount: primary.candidateCount
  };
}

export function partialNetworkNotice(collection: SnapshotCollection<NetworkAdapterSnapshot>): string | null {
  return collection.error ? `A coleta de rede foi parcial: ${collection.error}` : null;
}
