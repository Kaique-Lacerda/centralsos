use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectionValue {
    pub value: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSoftware {
    pub name: String,
    pub version: Option<String>,
    pub location: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirebirdService {
    pub service_name: String,
    pub display_name: String,
    pub state: Option<String>,
    pub path: Option<String>,
    pub version: Option<String>,
    pub architecture: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallationSnapshot {
    pub uac_enable_lua: InspectionValue,
    pub network_discovery: InspectionValue,
    pub automatic_network_device_setup: InspectionValue,
    pub file_printer_sharing: InspectionValue,
    pub password_protected_sharing: InspectionValue,
    pub dll_file_name: Option<String>,
    pub dll_system32_exists: InspectionValue,
    pub dll_syswow64_exists: InspectionValue,
    pub database_exists: InspectionValue,
    pub firebird_services: Vec<FirebirdService>,
    pub firebird_error: Option<String>,
    pub cobian: Vec<InstalledSoftware>,
    pub cobian_error: Option<String>,
    pub ibconsole_executables: Vec<String>,
    pub ibconsole_error: Option<String>,
    pub nube_contabil: Vec<InstalledSoftware>,
    pub nube_contabil_error: Option<String>,
}

impl InstallationSnapshot {
    pub fn unavailable(reason: impl Into<String>) -> Self {
        let reason = reason.into();
        let unavailable = || InspectionValue {
            value: None,
            error: Some(reason.clone()),
        };
        Self {
            uac_enable_lua: unavailable(),
            network_discovery: unavailable(),
            automatic_network_device_setup: unavailable(),
            file_printer_sharing: unavailable(),
            password_protected_sharing: unavailable(),
            dll_file_name: None,
            dll_system32_exists: unavailable(),
            dll_syswow64_exists: unavailable(),
            database_exists: unavailable(),
            firebird_services: vec![],
            firebird_error: Some(reason.clone()),
            cobian: vec![],
            cobian_error: Some(reason.clone()),
            ibconsole_executables: vec![],
            ibconsole_error: Some(reason.clone()),
            nube_contabil: vec![],
            nube_contabil_error: Some(reason),
        }
    }
}
