import type { NetworkAdapterSnapshot, SnapshotCollection, VolumeSnapshot, WindowsServiceSnapshot } from './machine';

export interface SupportCheck { state: 'success' | 'warning' | 'error' | 'unknown' | 'timeout'; message: string; code: number | null; latencyMs: number | null }
export interface Listener { address: string; port: number; pid: number; processName: string | null }
export interface FirewallRule { name: string | null; enabled: number | null; direction: number | null; action: number | null; localPort: string | null; application: string | null }
export interface ConnectivitySnapshot { host: string; port: number | null; addresses: string[]; dns: SupportCheck; ping: SupportCheck; tcp: SupportCheck; listeners: Listener[]; listenerError: string | null; firewallRules: SnapshotCollection<FirewallRule> }
export interface NetworkRoute { interfaceIndex: number | null; gateway: string | null; metric: number | null }
export interface NetworkProxy { source: string; enabled: boolean | null; server: string | null; pac: string | null; error: string | null }
export interface NetworkSupportSnapshot { adapters: SnapshotCollection<NetworkAdapterSnapshot>; routes: SnapshotCollection<NetworkRoute>; proxies: NetworkProxy[]; gateway: ConnectivitySnapshot | null; dnsServers: ConnectivitySnapshot[]; external: ConnectivitySnapshot }
export interface ServiceActionResult { before: WindowsServiceSnapshot; after: WindowsServiceSnapshot; message: string }
export interface SoftwareInfo { name: string; version: string | null; architecture: string | null; location: string | null; source: string }
export interface DatabaseInfo { path: string; exists: boolean | null; sizeBytes: number | null; modifiedAt: number | null; readAccess: boolean | null; writeAccess: boolean | null; locked: boolean | null; error: string | null }
export interface ProcessInfo { name: string; pid: number; path: string | null; memoryBytes: number; cpuPercent: number | null; runtimeSeconds: number; startTime: number; user: string | null; critical: boolean }
export interface FirebirdSnapshot { installations: SnapshotCollection<SoftwareInfo>; services: SnapshotCollection<WindowsServiceSnapshot>; processes: SnapshotCollection<ProcessInfo>; port: ConnectivitySnapshot; database: DatabaseInfo }
export interface ShareInfo { name: string; path: string; comment: string | null }
export interface ShareSnapshot { path: string; connectivity: ConnectivitySnapshot; existence: SupportCheck; access: SupportCheck }
export interface TempSummary { root: string; scannedBytes: number; eligibleBytes: number; eligibleFiles: number; errors: number; truncated: boolean }
export interface CleanupResult { removedBytes: number; removedFiles: number; skippedFiles: number; failures: number }
export interface SystemSupportSnapshot { volumes: SnapshotCollection<VolumeSnapshot>; uptimeSeconds: number; rebootReasons: string[]; rebootError: string | null; timezone: string | null; timeService: WindowsServiceSnapshot | null; timeSync: SupportCheck; temporary: TempSummary[] }
export type NetworkAction = 'enableAdapter' | 'renewDhcp' | 'flushDns' | 'removeWininetProxy' | 'removeWinhttpProxy';
export type ServiceAction = 'start' | 'restart' | 'stop';
