use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintJobSnapshot {
    pub job_id: u32,
    pub document: Option<String>,
    pub user: Option<String>,
    pub status: String,
    pub status_bits: u32,
    pub status_detail: Option<String>,
    pub size_bytes: u64,
    pub total_pages: Option<u32>,
    pub pages_printed: Option<u32>,
    /// Hora UTC retornada pelo spooler, sem conversão de fuso.
    pub submitted_at: Option<String>,
    pub position: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterQueueActionResult {
    pub removed_count: u32,
    pub failed_job_ids: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrinterPermissionValues {
    pub print: bool,
    pub manage_printer: bool,
    pub manage_documents: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterPermissionEntry {
    pub ace_index: u32,
    pub sid: Option<String>,
    pub account: String,
    pub access_type: String,
    pub permissions: Option<PrinterPermissionValues>,
    pub special_permissions: bool,
    pub inherited: bool,
    pub editable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterPermissionsSnapshot {
    pub state: String,
    pub entries: Vec<PrinterPermissionEntry>,
    pub notice: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterPermissionChangeResult {
    pub account: String,
    pub sid: String,
    pub before: PrinterPermissionValues,
    pub after: PrinterPermissionValues,
    pub verified: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterConfigurationSnapshot {
    pub printer_name: String,
    pub server: Option<String>,
    pub shared: bool,
    pub share_name: Option<String>,
    pub location: Option<String>,
    pub comment: Option<String>,
    pub port: Option<String>,
    pub driver: Option<String>,
    pub paused: bool,
    pub is_elevated: bool,
    pub redirected: bool,
    pub permissions: PrinterPermissionsSnapshot,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetPrinterPermissionRequest {
    pub printer_name: String,
    pub trustee_sid: String,
    pub expected_before: PrinterPermissionValues,
    pub after: PrinterPermissionValues,
}
