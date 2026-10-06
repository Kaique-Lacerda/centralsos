export interface BiosSnapshot {
  manufacturer: string | null;
  version: string | null;
  releaseDate: string | null;
}

export interface MachineSystemSnapshot {
  hostname: string;
  username: string;
  operatingSystem: string | null;
  windowsVersion: string | null;
  windowsBuild: string | null;
  architecture: string;
  domainOrWorkgroup: string | null;
  joinedToDomain: boolean | null;
  uptimeSeconds: number | null;
  manufacturer: string | null;
  model: string | null;
  cpu: string | null;
  ramBytes: number | null;
  bios: BiosSnapshot | null;
  error: string | null;
}

export interface VolumeSnapshot {
  unit: string;
  label: string | null;
  totalBytes: number | null;
  freeBytes: number | null;
  usedBytes: number | null;
}

export interface NetworkAdapterSnapshot {
  name: string;
  status: string | null;
  mac: string | null;
  physicalAdapter: boolean | null;
  manufacturer: string | null;
  productName: string | null;
  serviceName: string | null;
  pnpDeviceId: string | null;
  adapterType: string | null;
  ipv4: string[];
  ipv6: string[];
  gateways: string[];
  dnsServers: string[];
}

export interface PrinterSnapshot {
  name: string;
  isDefault: boolean;
  driver: string | null;
  port: string | null;
  server: string | null;
  status: string | null;
  local: boolean | null;
  network: boolean | null;
  shared: boolean | null;
  shareName: string | null;
  location: string | null;
  comment: string | null;
}

export interface PrintJobSnapshot {
  jobId: number;
  document: string | null;
  user: string | null;
  status: string;
  statusBits?: number;
  statusDetail: string | null;
  sizeBytes: number;
  totalPages: number | null;
  pagesPrinted: number | null;
  submittedAt: string | null;
  position: number;
}

export interface PrinterQueueActionResult {
  removedCount: number;
  failedJobIds: number[];
}

export interface PrinterPermissionValues {
  print: boolean;
  managePrinter: boolean;
  manageDocuments: boolean;
}

export interface PrinterPermissionEntry {
  aceIndex: number;
  sid: string | null;
  account: string;
  accessType: string;
  permissions: PrinterPermissionValues | null;
  specialPermissions: boolean;
  inherited: boolean;
  editable: boolean;
}

export interface PrinterPermissionsSnapshot {
  state: 'available' | 'unrestricted' | 'unavailable' | string;
  entries: PrinterPermissionEntry[];
  notice: string | null;
}

export interface PrinterPermissionChangeResult {
  account: string;
  sid: string;
  before: PrinterPermissionValues;
  after: PrinterPermissionValues;
  verified: boolean;
}

export interface PrinterConfigurationSnapshot {
  printerName: string;
  server: string | null;
  shared: boolean;
  shareName: string | null;
  location: string | null;
  comment: string | null;
  port: string | null;
  driver: string | null;
  paused: boolean;
  isElevated: boolean;
  redirected: boolean;
  permissions: PrinterPermissionsSnapshot;
}

export interface SnapshotCollection<T> {
  items: T[];
  error: string | null;
}

export interface WindowsServiceSnapshot {
  name: string | null;
  displayName: string | null;
  state: string | null;
  startMode: string | null;
  status: string | null;
  pathName: string | null;
  description: string | null;
  startName: string | null;
}

export interface MachineSnapshot {
  /** Milliseconds since Unix epoch when collection began. */
  capturedAt: number;
  system: MachineSystemSnapshot;
  storage: SnapshotCollection<VolumeSnapshot>;
  network: SnapshotCollection<NetworkAdapterSnapshot>;
  printers: SnapshotCollection<PrinterSnapshot>;
}

/** Query shapes reserved for explicit, targeted collection in a later step. */
export interface ServiceQuery { names: string[] }
export interface ProcessQuery { name?: string; processId?: number }
