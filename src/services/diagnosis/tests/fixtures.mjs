export const col = (items = [], error = null) => ({ items, error });
export const check = (state = 'success', code = null) => ({ state, message: state, code, latencyMs: null });
export const probe = (overrides = {}) => ({ host: 'github.com', port: 443, addresses: ['1.2.3.4'], dns: check(), tcp: check(), ping: check('unknown'), listeners: [], listenerError: null, firewallRules: col(), ...overrides });
export const adapter = (overrides = {}) => ({ name: 'Wi-Fi', index: 1, interfaceIndex: 1, status: 'Conectado', netEnabled: true, physicalAdapter: true, manufacturer: 'Qualcomm', productName: 'Wireless', serviceName: 'NIC', pnpDeviceId: 'PCI\\1', adapterType: 'Ethernet', dhcpEnabled: true, mac: null, ipv4: ['192.168.1.25'], ipv6: [], gateways: ['192.168.1.1'], dnsServers: ['192.168.1.1'], ...overrides });
export const service = (overrides = {}) => ({ name: 'CobianBackup', displayName: 'Cobian Backup', state: 'Running', startMode: 'Auto', status: 'OK', pathName: 'C:\\Cobian\\cbservice.exe', description: null, startName: null, ...overrides });
export const printer = (overrides = {}) => ({ printer: { name: 'Printer', port: 'PORTPROMPT:', driver: 'Microsoft Print to PDF', attributes: 0, statusBits: 0, jobCount: 0, server: null, shareName: null }, printerError: null, queue: col(), ports: col([{ name: 'PORTPROMPT:', monitor: null, description: null, portType: 0 }]), serial: col(), tcp: col(), presentDevices: { com: col(), usb: col() }, driver: { name: 'Microsoft Print to PDF', version: '1', environment: null, hardwareId: null, provider: null }, driverError: null, spooler: { state: 4, startMode: 2, error: null }, isElevated: true, ...overrides });
export const job = (jobId = 1, statusBits = 2) => ({ jobId, statusBits, status: 'Error', statusDetail: null, document: 'Document', user: null, sizeBytes: null, totalPages: null, pagesPrinted: null, submittedAt: null, position: null });
export function observations(overrides = {}) {
  const volumes = col([{ unit: 'C:', label: null, driveType: 3, totalBytes: 100 * 1024 ** 3, freeBytes: 50 * 1024 ** 3, usedBytes: 50 * 1024 ** 3 }]);
  return {
    machine: { capturedAt: 1, system: { hostname: 'HOST', username: 'USER', operatingSystem: 'Windows', windowsVersion: '11', windowsBuild: '1', architecture: 'x64', manufacturer: null, model: null, cpu: null, ramBytes: null, bios: null, error: null, domainOrWorkgroup: null, joinedToDomain: false, uptimeSeconds: 1 }, storage: volumes, network: col([adapter()]), printers: col() },
    system: { volumes, uptimeSeconds: 1, rebootReasons: [], rebootError: null, timezone: null, timeService: service({ name: 'W32Time' }), timeSync: check(), temporary: [] },
    network: { adapters: col([adapter()]), routes: col([{ interfaceIndex: 1, gateway: '192.168.1.1', metric: 10 }]), proxies: [], gateway: probe(), dnsServers: [probe()], external: probe() },
    services: col([service()]),
    firebird: { installations: col(), services: col(), processes: col(), port: probe({ host: '127.0.0.1', port: 3050, tcp: check('error') }), database: { path: 'C:\\SoS Soluções\\Troia\\Banco\\autocom.fdb', exists: false, sizeBytes: null, modifiedAt: null, readAccess: null, writeAccess: null, locked: null, error: null } },
    printing: { spooler: { state: 4, startMode: 2, error: null }, elevated: true, printers: [], inventoryError: null },
    dependencies: col(), compliance: null, errors: {}, ...overrides,
  };
}
export function clients(data = observations(), overrides = {}) {
  return {
    machine: async () => data.machine, system: async () => data.system, network: async () => data.network,
    services: async () => data.services, firebird: async () => data.firebird, dependencies: async () => data.dependencies,
    spooler: async () => [data.printing.spooler, data.printing.elevated],
    printer: async name => data.printing.printers.find(p => p.name === name)?.snapshot ?? printer(),
    compliance: async () => data.compliance, hasProfile: () => !!data.compliance, ...overrides,
  };
}
export const actions = (overrides = {}) => ({ startSpooler: async () => {}, startService: async () => {}, syncTime: async () => {}, flushDns: async () => {}, resumePrinter: async () => {}, cancelProblemJob: async () => true, ...overrides });
