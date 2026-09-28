import type { NetworkAdapterSnapshot, SnapshotCollection } from '../../types/machine';

export type NetworkAdapterKind = 'Físico' | 'Virtual' | 'VPN' | 'Sistema' | 'Não determinado';
export type NetworkConnectionState = 'connected' | 'disconnected' | 'connecting' | 'unknown';

const vpnIndicators = ['tailscale', 'wireguard', 'wintun', 'openvpn', 'fortinet', 'anyconnect', 'globalprotect', 'pangp', 'vpn'];
const systemAdapterIndicators = ['wan miniport', 'kernel debug'];

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
  if (adapter.physicalAdapter === true) return 'Físico';
  if (evidence.some(value => vpnIndicators.some(indicator => value.includes(indicator)))) return 'VPN';

  const manufacturer = normalized(adapter.manufacturer);
  const product = normalized(adapter.productName);
  const pnpId = normalized(adapter.pnpDeviceId);
  const microsoftSystemDevice = manufacturer.includes('microsoft') &&
    (pnpId.startsWith('root\\') || pnpId.startsWith('swd\\')) &&
    systemAdapterIndicators.some(indicator => product.includes(indicator));
  if (microsoftSystemDevice) return 'Sistema';
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
  const candidates = adapters.filter(adapter =>
    networkConnectionState(adapter.status) === 'connected' &&
    adapter.ipv4.some(isUsableIpv4) &&
    ipv4Gateway(adapter) !== null
  );
  return { adapter: candidates.length === 1 ? candidates[0] : null, candidateCount: candidates.length };
}

export function summarizeNetwork(collection: SnapshotCollection<NetworkAdapterSnapshot>) {
  const counts = collection.items.reduce((result, adapter) => {
    const state = networkConnectionState(adapter.status);
    if (state === 'connected') result.connected++;
    if (state === 'disconnected') result.disconnected++;
    const kind = classifyNetworkAdapter(adapter);
    if (kind === 'VPN') result.vpns++;
    if (kind === 'Virtual' || kind === 'Sistema') result.virtualOrSystem++;
    return result;
  }, { connected: 0, disconnected: 0, vpns: 0, virtualOrSystem: 0 });
  const primary = selectPrimaryAdapter(collection.items);
  return { total: collection.items.length, ...counts, primary: primary.adapter, primaryCandidateCount: primary.candidateCount };
}

export function partialNetworkNotice(collection: SnapshotCollection<NetworkAdapterSnapshot>): string | null {
  return collection.error ? `A coleta de rede foi parcial: ${collection.error}` : null;
}
