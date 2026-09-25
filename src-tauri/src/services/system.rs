use serde::Deserialize;
use wmi::WMIConnection;

use crate::models::machine::{BiosSnapshot, MachineSystemSnapshot};

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct OperatingSystemRow {
    caption: Option<String>,
    version: Option<String>,
    build_number: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ComputerSystemRow {
    manufacturer: Option<String>,
    model: Option<String>,
    total_physical_memory: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ProcessorRow {
    name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct BiosRow {
    manufacturer: Option<String>,
    #[serde(rename = "SMBIOSBIOSVersion")]
    smbios_bios_version: Option<String>,
    release_date: Option<String>,
}

pub fn collect(connection: &WMIConnection, result: &mut MachineSystemSnapshot) {
    let mut issues = Vec::new();

    match connection.raw_query::<OperatingSystemRow>(
        "SELECT Caption, Version, BuildNumber FROM Win32_OperatingSystem",
    ) {
        Ok(rows) => {
            if let Some(row) = rows.into_iter().next() {
                result.operating_system = row.caption;
                result.windows_version = row.version.map(|version| match row.build_number {
                    Some(build) => format!("{version} (build {build})"),
                    None => version,
                });
            }
        }
        Err(error) => issues.push(format!("Sistema operacional: {error}")),
    }

    match connection.raw_query::<ComputerSystemRow>(
        "SELECT Manufacturer, Model, TotalPhysicalMemory FROM Win32_ComputerSystem",
    ) {
        Ok(rows) => {
            if let Some(row) = rows.into_iter().next() {
                result.manufacturer = row.manufacturer;
                result.model = row.model;
                result.ram_bytes = row.total_physical_memory;
            }
        }
        Err(error) => issues.push(format!("Fabricante/modelo/memória: {error}")),
    }

    match connection.raw_query::<ProcessorRow>("SELECT Name FROM Win32_Processor") {
        Ok(rows) => {
            let names = rows
                .into_iter()
                .filter_map(|row| row.name)
                .collect::<Vec<_>>();
            result.cpu = (!names.is_empty()).then(|| names.join("; "));
        }
        Err(error) => issues.push(format!("CPU: {error}")),
    }

    match connection
        .raw_query::<BiosRow>("SELECT Manufacturer, SMBIOSBIOSVersion, ReleaseDate FROM Win32_BIOS")
    {
        Ok(rows) => {
            if let Some(row) = rows.into_iter().next() {
                result.bios = Some(BiosSnapshot {
                    manufacturer: row.manufacturer,
                    version: row.smbios_bios_version,
                    release_date: row.release_date,
                });
            }
        }
        Err(error) => issues.push(format!("BIOS: {error}")),
    }

    if !issues.is_empty() {
        result.error = Some(issues.join(" | "));
    }
}
