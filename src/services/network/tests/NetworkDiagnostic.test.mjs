import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

async function load(entry) {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL(entry, import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
}
const { classifyNetworkAdapter, networkConnectionState, partialNetworkNotice, selectPrimaryAdapter, summarizeNetwork } = await load('../NetworkDiagnostic.ts');
const adapter = (overrides = {}) => ({ name: 'Ethernet', status: 'Conectado', mac: '00:11:22:33:44:55', physicalAdapter: true, manufacturer: 'Vendor', productName: 'Ethernet Controller', serviceName: 'e1', pnpDeviceId: 'PCI\\VEN_1234', adapterType: 'Ethernet 802.3', ipv4: ['192.168.1.20'], ipv6: [], gateways: ['192.168.1.1'], dnsServers: ['1.1.1.1'], ...overrides });

test('classifica interfaces usando propriedades do dispositivo, não o nome amigável', () => {
  assert.equal(classifyNetworkAdapter(adapter()), 'Físico');
  assert.equal(classifyNetworkAdapter(adapter({ name: 'Adaptador 3', physicalAdapter: false, manufacturer: 'Tailscale Inc.', productName: 'Tailscale Tunnel' })), 'VPN');
  assert.equal(classifyNetworkAdapter(adapter({ physicalAdapter: false, manufacturer: 'Microsoft', productName: 'WAN Miniport (IKEv2)', pnpDeviceId: 'ROOT\\MS_NDISWANIP' })), 'Sistema');
  assert.equal(classifyNetworkAdapter(adapter({ physicalAdapter: false, manufacturer: 'Vendor', productName: 'Virtual Ethernet', pnpDeviceId: 'ROOT\\VIRTUAL' })), 'Virtual');
  assert.equal(classifyNetworkAdapter(adapter({ physicalAdapter: null, manufacturer: null, productName: null, serviceName: null, pnpDeviceId: null })), 'Não determinado');
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
  const collection = { items: [adapter(), adapter({ name: 'VPN', status: 'Conectado', physicalAdapter: false, manufacturer: 'Tailscale' }), adapter({ name: 'Down', status: 'Mídia desconectada', physicalAdapter: false })], error: 'consulta parcial' };
  const summary = summarizeNetwork(collection);
  assert.equal(summary.total, 3);
  assert.equal(summary.connected, 2);
  assert.equal(summary.disconnected, 1);
  assert.equal(summary.vpns, 1);
  assert.match(partialNetworkNotice(collection), /consulta parcial/);
});
