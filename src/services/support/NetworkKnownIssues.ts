import type { NetworkAction, NetworkSupportSnapshot } from '../../types/support';
import { classifyNetworkAdapter, isUsableIpv4, networkConnectionState } from '../network/NetworkDiagnostic';

export const networkIssueIds = ['NETWORK_ADAPTER_DISABLED', 'NETWORK_MEDIA_DISCONNECTED', 'APIPA_ADDRESS', 'DHCP_FAILED', 'DEFAULT_GATEWAY_MISSING', 'DNS_MISSING', 'DNS_UNREACHABLE', 'DNS_RESOLUTION_FAILED', 'INTERNET_UNREACHABLE', 'PROXY_CONFIGURED', 'MULTIPLE_DEFAULT_GATEWAYS', 'VPN_DISCONNECTED', 'WINSOCK_SUSPECT', 'ROUTE_SUSPECT'] as const;
export interface NetworkKnownIssue { id: typeof networkIssueIds[number]; severity: 'info' | 'warning' | 'error'; evidence: string[]; description: string; autoFix: boolean; requiresConfirmation: boolean; suggestedAction: string; action?: NetworkAction; index?: number }
export function collectNetworkIssues(snapshot: NetworkSupportSnapshot): NetworkKnownIssue[] {
  const issues: NetworkKnownIssue[] = [];
  const add = (id: NetworkKnownIssue['id'], description: string, evidence: string[], suggestedAction: string, action?: NetworkAction, index?: number) => issues.push({ id, description, evidence, suggestedAction, severity: 'warning', autoFix: action === 'flushDns', requiresConfirmation: !!action && action !== 'flushDns', action, index });
  for (const adapter of snapshot.adapters.items) {
    const kind = classifyNetworkAdapter(adapter);
    if (kind === 'Sistema') continue;
    const connected = networkConnectionState(adapter.status) === 'connected';
    const evidence = [`${adapter.name}: ${adapter.status ?? 'estado não informado'}`];
    if (adapter.netEnabled === false && kind === 'Físico') add('NETWORK_ADAPTER_DISABLED', `${adapter.name} está desabilitado.`, evidence, 'Habilitar somente esta interface, após confirmação.', adapter.index != null ? 'enableAdapter' : undefined, adapter.index ?? undefined);
    if (adapter.status === 'Mídia desconectada' || kind === 'Físico' && adapter.status === 'Desconectado') add('NETWORK_MEDIA_DISCONNECTED', `${adapter.name} está desconectado.`, evidence, 'Confira cabo, Wi-Fi e conexão física. Não é necessariamente um problema se outra interface estiver em uso.');
    if (kind === 'VPN' && !connected) add('VPN_DISCONNECTED', `${adapter.name}: VPN não conectada.`, evidence, 'Confirme se esta VPN precisa estar ativa. Não será conectada automaticamente.');
    const apipa = connected && adapter.ipv4.some(ip => /^169\.254\.\d+\.\d+$/.test(ip));
    if (apipa) add('APIPA_ADDRESS', `${adapter.name} recebeu endereço APIPA.`, adapter.ipv4, 'Confira DHCP e enlace; um endereço APIPA não identifica sozinho a causa.');
    if (apipa && adapter.dhcpEnabled === true) add('DHCP_FAILED', `${adapter.name}: DHCP ativo, mas sem IPv4 utilizável.`, [...adapter.ipv4, 'DHCPEnabled=true'], 'Renovar a concessão desta interface após confirmação; pode interromper conexões.', adapter.index != null ? 'renewDhcp' : undefined, adapter.index ?? undefined);
    if (connected && !snapshot.adapters.error && !adapter.gateways.some(isUsableIpv4)) add('DEFAULT_GATEWAY_MISSING', `${adapter.name}: gateway IPv4 não informado.`, evidence, 'Pode ser uma rede local ou VPN sem rota externa. Não atribuir um gateway automaticamente.');
    if (connected && !snapshot.adapters.error && adapter.dnsServers.length === 0) add('DNS_MISSING', `${adapter.name}: DNS não informado.`, evidence, 'Confira o DNS esperado para esta rede. Nenhum DNS público será imposto.');
  }
  for (const server of snapshot.dnsServers) if (server.dns.state === 'timeout') add('DNS_UNREACHABLE', `Sem resposta UDP do DNS ${server.host}.`, [server.dns.message], 'Verifique servidor e filtros. UDP sem resposta não prova indisponibilidade total do DNS.');
  if (snapshot.external.dns.state === 'error' || snapshot.external.dns.state === 'timeout') add('DNS_RESOLUTION_FAILED', 'O Windows não resolveu github.com.', [snapshot.external.dns.message], 'Limpar cache somente se um DNS configurado respondeu diretamente; depois consultar novamente.', snapshot.dnsServers.some(s => s.dns.state === 'success') ? 'flushDns' : undefined);
  if (snapshot.external.dns.state === 'success' && ['error', 'timeout'].includes(snapshot.external.tcp.state)) add('INTERNET_UNREACHABLE', 'O teste TCP externo para github.com:443 não conectou.', [snapshot.external.tcp.message], 'Verifique rota, política e o destino. Este teste não comprova falha de toda a Internet.');
  for (const proxy of snapshot.proxies) if (proxy.enabled === true || proxy.pac?.trim()) add('PROXY_CONFIGURED', `Proxy configurado: ${proxy.source}.`, [proxy.server || proxy.pac || 'Configuração ativa'], 'Proxy pode ser intencional. Remover somente a configuração manual após confirmação.', proxy.enabled === true ? proxy.source.startsWith('WinINET') ? 'removeWininetProxy' : 'removeWinhttpProxy' : undefined);
  if (!snapshot.routes.error && snapshot.routes.items.length > 1) add('MULTIPLE_DEFAULT_GATEWAYS', 'Mais de uma rota padrão IPv4 está configurada.', snapshot.routes.items.map(r => `${r.gateway} · interface ${r.interfaceIndex} · métrica ${r.metric}`), 'Pode ser intencional. Confira prioridade e VPN; nenhuma rota será removida.');
  // Winsock/route corruption requires specific evidence not supplied by these probes.
  // Catalog IDs remain reserved; a failed ping/TCP never creates WINSOCK_SUSPECT or ROUTE_SUSPECT.
  return issues;
}
