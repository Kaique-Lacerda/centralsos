use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BiosSnapshot {
    pub manufacturer: Option<String>,
    pub version: Option<String>,
    pub release_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MachineSystemSnapshot {
    pub hostname: String,
    pub username: String,
    pub operating_system: Option<String>,
    pub windows_version: Option<String>,
    pub architecture: String,
    pub manufacturer: Option<String>,
    pub model: Option<String>,
    pub cpu: Option<String>,
    pub ram_bytes: Option<u64>,
    pub bios: Option<BiosSnapshot>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VolumeSnapshot {
    pub unit: String,
    pub label: Option<String>,
    pub total_bytes: Option<u64>,
    pub free_bytes: Option<u64>,
    pub used_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct NetworkAdapterSnapshot {
    pub name: String,
    pub status: Option<String>,
    pub mac: Option<String>,
    pub ipv4: Vec<String>,
    pub ipv6: Vec<String>,
    pub gateways: Vec<String>,
    pub dns_servers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PrinterSnapshot {
    pub name: String,
    pub is_default: bool,
    pub driver: Option<String>,
    pub port: Option<String>,
    pub server: Option<String>,
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotCollection<T> {
    pub items: Vec<T>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MachineSnapshot {
    /// Milliseconds since Unix epoch when collection began.
    pub captured_at: u64,
    pub system: MachineSystemSnapshot,
    pub storage: SnapshotCollection<VolumeSnapshot>,
    pub network: SnapshotCollection<NetworkAdapterSnapshot>,
    pub printers: SnapshotCollection<PrinterSnapshot>,
}

/// Request shape reserved for future targeted service lookups. No services are enumerated in a snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceQuery {
    pub names: Vec<String>,
}

/// Request shape reserved for future targeted process lookups. No processes are enumerated in a snapshot.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProcessQuery {
    pub name: Option<String>,
    pub process_id: Option<u32>,
}
