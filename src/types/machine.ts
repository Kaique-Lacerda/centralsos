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
  architecture: string;
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
}

export interface SnapshotCollection<T> {
  items: T[];
  error: string | null;
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
