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
}

pub fn collect(connection: &WMIConnection) -> Result<Vec<VolumeSnapshot>, String> {
    connection
        .raw_query::<LogicalDiskRow>(
            "SELECT DeviceID, VolumeName, Size, FreeSpace FROM Win32_LogicalDisk",
        )
        .map(|rows| {
            rows.into_iter()
                .map(|row| VolumeSnapshot {
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
