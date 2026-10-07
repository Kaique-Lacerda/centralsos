use super::{
    machine::{NetworkAdapterSnapshot, SnapshotCollection, VolumeSnapshot},
    windows_service::WindowsServiceSnapshot,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub state: String,
    pub message: String,
    pub code: Option<u32>,
    pub latency_ms: Option<u64>,
}
impl Check {
    pub fn new(state: &str, message: impl Into<String>) -> Self {
        Self {
            state: state.into(),
            message: message.into(),
            code: None,
            latency_ms: None,
        }
    }
    pub fn error(code: u32, message: impl Into<String>) -> Self {
        Self {
            code: Some(code),
            ..Self::new("error", message)
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectivitySnapshot {
    pub host: String,
    pub port: Option<u16>,
    pub addresses: Vec<String>,
    pub dns: Check,
    pub ping: Check,
    pub tcp: Check,
    pub listeners: Vec<Listener>,
    pub listener_error: Option<String>,
    pub firewall_rules: SnapshotCollection<FirewallRule>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Listener {
    pub address: String,
    pub port: u16,
    pub pid: u32,
    pub process_name: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FirewallRule {
    pub name: Option<String>,
    pub enabled: Option<u16>,
    pub direction: Option<u16>,
    pub action: Option<u16>,
    pub local_port: Option<String>,
    pub application: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub interface_index: Option<u32>,
    pub gateway: Option<String>,
    pub metric: Option<u32>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proxy {
    pub source: String,
    pub enabled: Option<bool>,
    pub server: Option<String>,
    pub pac: Option<String>,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSupportSnapshot {
    pub adapters: SnapshotCollection<NetworkAdapterSnapshot>,
    pub routes: SnapshotCollection<Route>,
    pub proxies: Vec<Proxy>,
    pub gateway: Option<ConnectivitySnapshot>,
    pub dns_servers: Vec<ConnectivitySnapshot>,
    pub external: ConnectivitySnapshot,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceActionResult {
    pub before: WindowsServiceSnapshot,
    pub after: WindowsServiceSnapshot,
    pub message: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Software {
    pub name: String,
    pub version: Option<String>,
    pub architecture: Option<String>,
    pub location: Option<String>,
    pub source: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseInfo {
    pub path: String,
    pub exists: Option<bool>,
    pub size_bytes: Option<u64>,
    pub modified_at: Option<u64>,
    pub read_access: Option<bool>,
    pub write_access: Option<bool>,
    pub locked: Option<bool>,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub name: String,
    pub pid: u32,
    pub path: Option<String>,
    pub memory_bytes: u64,
    pub cpu_percent: Option<f32>,
    pub runtime_seconds: u64,
    pub start_time: u64,
    pub user: Option<String>,
    pub critical: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FirebirdSnapshot {
    pub installations: SnapshotCollection<Software>,
    pub services: SnapshotCollection<WindowsServiceSnapshot>,
    pub processes: SnapshotCollection<ProcessInfo>,
    pub port: ConnectivitySnapshot,
    pub database: DatabaseInfo,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareInfo {
    pub name: String,
    pub path: String,
    pub comment: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareSnapshot {
    pub path: String,
    pub connectivity: ConnectivitySnapshot,
    pub existence: Check,
    pub access: Check,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TempSummary {
    pub root: String,
    pub scanned_bytes: u64,
    pub eligible_bytes: u64,
    pub eligible_files: u32,
    pub errors: u32,
    pub truncated: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupResult {
    pub removed_bytes: u64,
    pub removed_files: u32,
    pub skipped_files: u32,
    pub failures: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemSupportSnapshot {
    pub volumes: SnapshotCollection<VolumeSnapshot>,
    pub uptime_seconds: u64,
    pub reboot_reasons: Vec<String>,
    pub reboot_error: Option<String>,
    pub timezone: Option<String>,
    pub time_service: Option<WindowsServiceSnapshot>,
    pub time_sync: Check,
    pub temporary: Vec<TempSummary>,
}
