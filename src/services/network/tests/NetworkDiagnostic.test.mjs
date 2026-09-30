import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

async function load(entry) {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL(entry, import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
}
const { classifyNetworkAdapter, isRelevantNetworkAdapter, networkConnectionState, partialNetworkNotice, selectPrimaryAdapter, splitNetworkAdapters, summarizeNetwork } = await load('../NetworkDiagnostic.ts');
const adapter = (overrides = {}) => ({ name: 'Ethernet', status: 'Conectado', mac: '00:11:22:33:44:55', physicalAdapter: true, manufacturer: 'Vendor', productName: 'Ethernet Controller', serviceName: 'e1', pnpDeviceId: 'PCI\\VEN_1234', adapterType: 'Ethernet 802.3', ipv4: ['192.168.1.20'], ipv6: [], gateways: ['192.168.1.1'], dnsServers: ['1.1.1.1'], ...overrides });

test('classifica interfaces usando propriedades do dispositivo, não o nome amigável', () => {
  assert.equal(classifyNetworkAdapter(adapter()), 'Físico');
  assert.equal(classifyNetworkAdapter(adapter({ name: 'Tailscale Tunnel', physicalAdapter: true, manufacturer: 'WireGuard LLC', productName: 'Wintun Userspace Tunnel', serviceName: 'Wintun', pnpDeviceId: 'ROOT\\Wintun' })), 'VPN');
  assert.equal(classifyNetworkAdapter(adapter({ physicalAdapter: false, manufacturer: 'Microsoft', productName: 'WAN Miniport (IKEv2)', pnpDeviceId: 'ROOT\\MS_NDISWANIP' })), 'Sistema');
  assert.equal(classifyNetworkAdapter(adapter({ physicalAdapter: false, manufacturer: 'Vendor', productName: 'Virtual Ethernet', pnpDeviceId: 'ROOT\\VIRTUAL' })), 'Virtual');
  assert.equal(classifyNetworkAdapter(adapter({ physicalAdapter: null, manufacturer: null, productName: null, serviceName: null, pnpDeviceId: null })), 'Não determinado');
});

test('reconhece miniports WAN, Kernel Debug e adaptadores Qualcomm/Realtek', () => {
  for (const protocol of ['IKEv2', 'L2TP', 'PPTP', 'SSTP', 'PPPOE', 'IP', 'IPv6', 'Network Monitor']) {
    assert.equal(classifyNetworkAdapter(adapter({ name: `WAN Miniport (${protocol})`, physicalAdapter: false, manufacturer: 'Microsoft', productName: `WAN Miniport (${protocol})`, pnpDeviceId: 'ROOT\\MS_NDISWANIP', status: 'Desconectado', ipv4: [], gateways: [], dnsServers: [] })), 'Sistema', protocol);
  }
  assert.equal(classifyNetworkAdapter(adapter({ name: 'Microsoft Kernel Debug Network Adapter', physicalAdapter: false, manufacturer: 'Microsoft', productName: 'Microsoft Kernel Debug Network Adapter', pnpDeviceId: 'ROOT\\KDNIC' })), 'Sistema');
  assert.equal(classifyNetworkAdapter(adapter({ name: 'Microsoft Wi-Fi Direct Virtual Adapter', physicalAdapter: false, manufacturer: 'Microsoft', productName: 'Microsoft Wi-Fi Direct Virtual Adapter', pnpDeviceId: 'ROOT\\WIFI' })), 'Sistema');
  assert.equal(classifyNetworkAdapter(adapter({ name: 'Bluetooth PAN', physicalAdapter: false, manufacturer: 'Microsoft', productName: 'Bluetooth Personal Area Network', pnpDeviceId: 'BTH\\MS_BTHPAN' })), 'Sistema');
  assert.equal(classifyNetworkAdapter(adapter({ physicalAdapter: true, manufacturer: 'Qualcomm Atheros', productName: 'Qualcomm Atheros AR956x Wireless Network Adapter' })), 'Físico');
  assert.equal(classifyNetworkAdapter(adapter({ physicalAdapter: true, manufacturer: 'Realtek', productName: 'Realtek PCIe GbE Family Controller' })), 'Físico');
});

test('normaliza estados sem tratar habilitado ou status desconhecido como conectado', () => {
  assert.equal(networkConnectionState('Autenticado'), 'connected');
  assert.equal(networkConnectionState('Mídia desconectada'), 'disconnected');
  assert.equal(networkConnectionState('Conectando'), 'connecting');
  assert.equal(networkConnectionState('Habilitado'), 'unknown');
});

test('seleciona uma única conexão conectada com IPv4 utilizável e gateway', () => {
  const primary = adapter();
  assert.deepEqual(selectPrimaryAdapter([adapter({ name: 'Sem gateway', gateways: [] }), primary]), { adapter: primary, candidateCount: 1 });
  assert.equal(selectPrimaryAdapter([adapter({ ipv4: ['169.254.2.3'] })]).adapter, null);
});

test('não escolhe arbitrariamente a principal quando há múltiplas rotas candidatas', () => {
  const result = selectPrimaryAdapter([adapter(), adapter({ name: 'Wi-Fi', productName: 'Wireless', adapterType: 'Wireless' })]);
  assert.equal(result.adapter, null);
  assert.equal(result.candidateCount, 2);
});

test('resume interface conectada, desconectada, VPN, sistema e erros parciais', () => {
  const collection = { items: [adapter(), adapter({ name: 'VPN', status: 'Conectado', physicalAdapter: false, manufacturer: 'Tailscale' }), adapter({ name: 'Down', status: 'Mídia desconectada', physicalAdapter: true })], error: 'consulta parcial' };
  const summary = summarizeNetwork(collection);
  assert.equal(summary.relevantCount, 3);
  assert.equal(summary.connectedCount, 2);
  assert.equal(summary.disconnectedPhysicalCount, 1);
  assert.equal(summary.activeVpnCount, 1);
  assert.match(partialNetworkNotice(collection), /consulta parcial/);
});

test('separa interfaces relevantes de infraestrutura sem perder desconectados ou VPN ativa', () => {
  const physical = adapter({ name: 'Qualcomm Atheros AR956x Wireless Network Adapter', productName: 'Qualcomm Atheros AR956x Wireless Network Adapter' });
  const disconnected = adapter({ name: 'Realtek PCIe GbE', productName: 'Realtek PCIe GbE Family Controller', status: 'Mídia desconectada', ipv4: [], gateways: [], dnsServers: [] });
  const tailscale = adapter({ name: 'Tailscale Tunnel', physicalAdapter: true, manufacturer: 'WireGuard LLC', productName: 'Wintun Userspace Tunnel', serviceName: 'Wintun', status: 'Conectado', ipv4: ['100.64.0.2'], gateways: [], dnsServers: [] });
  const infrastructureNames = [
    'Microsoft Kernel Debug Network Adapter',
    'WAN Miniport (SSTP)', 'WAN Miniport (IKEv2)', 'WAN Miniport (L2TP)', 'WAN Miniport (PPTP)',
    'WAN Miniport (PPPOE)', 'WAN Miniport (IP)', 'WAN Miniport (IPv6)', 'WAN Miniport (Network Monitor)',
    'Microsoft Wi-Fi Direct Virtual Adapter', 'Bluetooth PAN'
  ];
  const infrastructure = infrastructureNames.map(name => adapter({ name, productName: name, physicalAdapter: false, manufacturer: 'Microsoft', pnpDeviceId: 'ROOT\\WINDOWS_NETWORK', status: 'Desconectado', ipv4: [], gateways: [], dnsServers: [] }));
  const items = [physical, disconnected, tailscale, ...infrastructure];
  const { visibleAdapters, otherAdapters } = splitNetworkAdapters(items);
  const summary = summarizeNetwork({ items, error: null });

  assert.deepEqual(visibleAdapters.map(item => item.name), [physical.name, disconnected.name, tailscale.name]);
  assert.equal(otherAdapters.length, 11);
  assert.equal(summary.relevantCount, 3);
  assert.equal(summary.connectedCount, 2);
  assert.equal(summary.disconnectedPhysicalCount, 1);
  assert.equal(summary.activeVpnCount, 1);
  assert.equal(summary.infrastructureCount, 11);
  assert.equal(summary.otherCount, 11);
  assert.equal(summary.primary, physical);
  assert.equal(selectPrimaryAdapter(visibleAdapters).adapter, physical);

  const activeVirtual = adapter({ name: 'Virtual Ethernet', productName: 'Virtual Ethernet', physicalAdapter: false, status: 'Conectado' });
  const inactiveVirtual = adapter({ name: 'Virtual Ethernet desativada', productName: 'Virtual Ethernet', physicalAdapter: false, status: 'Desconectado' });
  const connectedSystem = adapter({ name: 'WAN Miniport (IKEv2)', productName: 'WAN Miniport (IKEv2)', physicalAdapter: false, manufacturer: 'Microsoft', pnpDeviceId: 'ROOT\\MS_NDISWANIP', status: 'Conectado' });
  const connectedUnknown = adapter({ name: 'Adaptador sem classificação', status: 'Conectado', physicalAdapter: null, manufacturer: null, productName: null, serviceName: null, pnpDeviceId: null, adapterType: null, ipv4: [], ipv6: [], gateways: [], dnsServers: [] });
  assert.equal(isRelevantNetworkAdapter(activeVirtual), true);
  assert.equal(isRelevantNetworkAdapter(inactiveVirtual), false);
  assert.equal(isRelevantNetworkAdapter(connectedSystem), false);
  assert.equal(isRelevantNetworkAdapter(connectedUnknown), true);
  assert.deepEqual(splitNetworkAdapters([activeVirtual, inactiveVirtual, connectedSystem, connectedUnknown]), {
    visibleAdapters: [activeVirtual, connectedUnknown],
    otherAdapters: [inactiveVirtual, connectedSystem]
  });
});
