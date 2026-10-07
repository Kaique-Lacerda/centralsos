use serde::Deserialize;
use wmi::WMIConnection;

use crate::models::machine::VolumeSnapshot;

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct LogicalDiskRow {
    #[serde(rename = "DeviceID")]
    device_id: String,
    volume_name: Option<String>,
    size: Option<u64>,
    free_space: Option<u64>,
    drive_type: Option<u32>,
}

pub fn collect(connection: &WMIConnection) -> Result<Vec<VolumeSnapshot>, String> {
    query(
        connection,
        "SELECT DeviceID, VolumeName, Size, FreeSpace, DriveType FROM Win32_LogicalDisk",
    )
}
pub fn collect_local(connection: &WMIConnection) -> Result<Vec<VolumeSnapshot>, String> {
    query(connection, "SELECT DeviceID, VolumeName, Size, FreeSpace, DriveType FROM Win32_LogicalDisk WHERE DriveType=2 OR DriveType=3 OR DriveType=5 OR DriveType=6")
}
fn query(connection: &WMIConnection, query: &str) -> Result<Vec<VolumeSnapshot>, String> {
    connection
        .raw_query::<LogicalDiskRow>(query)
        .map(|rows| {
            rows.into_iter()
                .map(|row| VolumeSnapshot {
                    drive_type: row.drive_type,
                    unit: row.device_id,
                    label: row.volume_name,
                    total_bytes: row.size,
                    free_bytes: row.free_space,
                    used_bytes: row
                        .size
                        .zip(row.free_space)
                        .map(|(total, free)| total.saturating_sub(free)),
                })
                .collect()
        })
        .map_err(|error| error.to_string())
}
