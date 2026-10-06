use serde::{Deserialize, Serialize};
use super::{machine::SnapshotCollection, printer_operation::PrintJobSnapshot};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all="camelCase")]
pub struct DiscoveredPrinter { pub name:String, pub server:String, pub path:String, pub description:Option<String> }

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterNativeState {
    pub name: String, pub port: Option<String>, pub driver: Option<String>, pub server: Option<String>,
    pub share_name: Option<String>, pub attributes: u32, pub status_bits: u32, pub job_count: u32,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintPort { pub name: String, pub monitor: Option<String>, pub description: Option<String>, pub port_type: u32 }
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all(deserialize = "PascalCase", serialize = "camelCase"))]
pub struct SerialPrintDevice {
    #[serde(rename(deserialize = "DeviceID"))] pub device_id: Option<String>,
    pub name: Option<String>, pub description: Option<String>,
    #[serde(rename(deserialize = "PNPDeviceID"))] pub pnp_device_id: Option<String>,
    pub status: Option<String>, pub config_manager_error_code: Option<u32>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all(deserialize = "PascalCase", serialize = "camelCase"))]
pub struct TcpPrintPort {
    pub name: String, pub host_address: Option<String>, pub port_number: Option<u16>, pub protocol: Option<u32>,
    pub queue: Option<String>, #[serde(rename(deserialize = "SNMPEnabled"))] pub snmp_enabled: Option<bool>, pub status: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintDriver { pub name: Option<String>, pub environment: Option<String>, pub version: Option<String>, pub hardware_id: Option<String>, pub provider: Option<String> }
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpoolerState { pub state: Option<u32>, pub start_mode: Option<u32>, pub error: Option<String> }
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintQueryError { pub code: u32, pub message: String }
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresentPrintDevice {
    pub port_name: Option<String>, pub friendly_name: Option<String>, pub instance_id: Option<String>,
    pub status_flags: Option<u32>, pub config_manager_error_code: Option<u32>, pub query_error: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterPresentDevices {
    pub com: SnapshotCollection<PresentPrintDevice>, pub usb: SnapshotCollection<PresentPrintDevice>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterDiagnosticSnapshot {
    pub device_status: Option<PrinterDeviceStatus>, pub device_status_error: Option<String>,
    pub printer: Option<PrinterNativeState>, pub printer_error: Option<String>, pub queue: SnapshotCollection<PrintJobSnapshot>,
    pub ports: SnapshotCollection<PrintPort>, pub serial: SnapshotCollection<SerialPrintDevice>, pub tcp: SnapshotCollection<TcpPrintPort>,
    pub present_devices: PrinterPresentDevices,
    pub driver: Option<PrintDriver>, pub driver_error: Option<PrintQueryError>, pub spooler: SpoolerState, pub is_elevated: bool,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all(deserialize = "PascalCase", serialize = "camelCase"))]
pub struct PrinterDeviceStatus {
    pub detected_error_state: Option<u16>, pub extended_detected_error_state: Option<u16>, pub extended_printer_status: Option<u16>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TcpPrintProbe { pub host: String, pub port: u16, pub reachable: bool, pub detail: String }
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpoolerActionResult { pub before: SpoolerState, pub after: SpoolerState, pub removed_files: u32, pub failed_files: Vec<String> }
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueMonitorEvent { pub mode: String, pub changed: bool, pub detail: Option<String> }
