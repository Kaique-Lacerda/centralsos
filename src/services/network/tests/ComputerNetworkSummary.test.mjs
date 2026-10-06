import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../ComputerNetworkSummary.ts', import.meta.url))],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false
});
const { getComputerNetworkSummaryAdapters } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`
);

const adapter = (overrides = {}) => ({
  name: 'Ethernet',
  status: 'Conectado',
  mac: '00:11:22:33:44:55',
  physicalAdapter: true,
  manufacturer: 'Vendor',
  productName: 'Ethernet Controller',
  serviceName: 'ethernet',
  pnpDeviceId: 'PCI\\VEN_1234',
  adapterType: 'Ethernet 802.3',
  ipv4: ['192.168.1.25'],
  ipv6: ['2001:db8::25'],
  gateways: ['192.168.1.1', 'fe80::1'],
  dnsServers: ['8.8.8.8', '2001:4860:4860::8888'],
  ...overrides
});

test('resumo mantém físico relevante, físico desconectado e VPN ativa com endereços principais', () => {
  const ethernet = adapter();
  const disconnectedWifi = adapter({
    name: 'Wi-Fi',
    productName: 'Qualcomm Atheros Wireless Adapter',
    manufacturer: 'Qualcomm Atheros',
    status: 'Mídia desconectada',
    ipv4: [],
    gateways: [],
    dnsServers: []
  });
  const tailscale = adapter({
    name: 'Tailscale Tunnel',
    physicalAdapter: true,
    manufacturer: 'WireGuard LLC',
    productName: 'Wintun Userspace Tunnel',
    serviceName: 'Wintun',
    pnpDeviceId: 'ROOT\\Wintun',
    ipv4: ['100.64.0.2']
  });

  assert.deepEqual(getComputerNetworkSummaryAdapters([ethernet, disconnectedWifi, tailscale]), [
    {
      name: 'Ethernet',
      kind: 'Físico',
      status: 'Conectado',
      ipv4: ['192.168.1.25'],
      gateways: ['192.168.1.1'],
      dnsServers: ['8.8.8.8']
    },
    {
      name: 'Wi-Fi',
      kind: 'Físico',
      status: 'Mídia desconectada',
      ipv4: [],
      gateways: [],
      dnsServers: []
    },
    {
      name: 'Tailscale Tunnel',
      kind: 'VPN',
      status: 'Conectado',
      ipv4: ['100.64.0.2'],
      gateways: ['192.168.1.1'],
      dnsServers: ['8.8.8.8']
    }
  ]);
});

test('exclui WAN Miniport, Kernel Debug, Wi-Fi Direct, Bluetooth e virtual secundário', () => {
  const noise = [
    adapter({ name: 'WAN Miniport (IKEv2)', productName: 'WAN Miniport (IKEv2)', physicalAdapter: false, manufacturer: 'Microsoft', pnpDeviceId: 'ROOT\\MS_NDISWANIP' }),
    adapter({ name: 'Microsoft Kernel Debug Network Adapter', productName: 'Microsoft Kernel Debug Network Adapter', physicalAdapter: false, manufacturer: 'Microsoft', pnpDeviceId: 'ROOT\\KDNIC' }),
    adapter({ name: 'Microsoft Wi-Fi Direct Virtual Adapter', productName: 'Microsoft Wi-Fi Direct Virtual Adapter', physicalAdapter: false, manufacturer: 'Microsoft', pnpDeviceId: 'ROOT\\WIFI' }),
    adapter({ name: 'Bluetooth PAN', productName: 'Bluetooth Personal Area Network', physicalAdapter: false, manufacturer: 'Microsoft', pnpDeviceId: 'BTH\\MS_BTHPAN' }),
    adapter({ name: 'Virtual Ethernet', physicalAdapter: false, status: 'Desconectado' })
  ];

  assert.deepEqual(getComputerNetworkSummaryAdapters(noise), []);
});

test('mantém MAC e IPv6 disponíveis na ferramenta específica de Diagnóstico de Rede', async () => {
  const page = await readFile(new URL('../../../pages/NetworkDiagnosticPage.tsx', import.meta.url), 'utf8');
  assert.match(page, /<summary>Detalhes de rede<\/summary>/);
  assert.match(page, /<dt>MAC<\/dt>/);
  assert.match(page, /<dt>IPv6<\/dt>/);
  assert.match(page, /otherAdapters\.map/);
});
