import type { NetworkAdapterSnapshot } from '../../types/machine';
import { classifyNetworkAdapter, splitNetworkAdapters, type NetworkAdapterKind } from './NetworkDiagnostic';

export interface ComputerNetworkSummaryAdapter {
  name: string;
  kind: NetworkAdapterKind;
  status: string | null;
  ipv4: string[];
  gateways: string[];
  dnsServers: string[];
}

function ipv4Only(values: string[]): string[] {
  return values.filter(value => !value.includes(':'));
}

export function getComputerNetworkSummaryAdapters(
  adapters: readonly NetworkAdapterSnapshot[]
): ComputerNetworkSummaryAdapter[] {
  const { visibleAdapters } = splitNetworkAdapters(adapters);
  return visibleAdapters.map(adapter => ({
    name: adapter.name,
    kind: classifyNetworkAdapter(adapter),
    status: adapter.status,
    ipv4: ipv4Only(adapter.ipv4),
    gateways: ipv4Only(adapter.gateways),
    dnsServers: ipv4Only(adapter.dnsServers)
  }));
}
