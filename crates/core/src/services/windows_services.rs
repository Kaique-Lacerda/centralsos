use serde::Deserialize;
use wmi::WMIConnection;

use crate::models::{machine::SnapshotCollection, windows_service::WindowsServiceSnapshot};

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct WindowsServiceRow {
    name: Option<String>,
    display_name: Option<String>,
    state: Option<String>,
    start_mode: Option<String>,
    status: Option<String>,
    path_name: Option<String>,
    description: Option<String>,
    start_name: Option<String>,
}

pub fn collect() -> SnapshotCollection<WindowsServiceSnapshot> {
    let connection = match WMIConnection::new() {
        Ok(connection) => connection,
        Err(error) => {
            return SnapshotCollection {
                items: Vec::new(),
                error: Some(format!("Não foi possível conectar ao provedor WMI: {error}")),
            }
        }
    };

    let query = "SELECT Name, DisplayName, State, StartMode, Status, PathName, Description, StartName FROM Win32_Service";
    match connection.raw_query::<WindowsServiceRow>(query) {
        Ok(rows) => SnapshotCollection {
            items: rows.into_iter().map(map_service).collect(),
            error: None,
        },
        Err(error) => SnapshotCollection {
            items: Vec::new(),
            error: Some(format!("Não foi possível consultar Win32_Service: {error}")),
        },
    }
}

fn map_service(row: WindowsServiceRow) -> WindowsServiceSnapshot {
    WindowsServiceSnapshot {
        name: row.name,
        display_name: row.display_name,
        state: row.state,
        start_mode: row.start_mode,
        status: row.status,
        path_name: row.path_name,
        description: row.description,
        start_name: row.start_name,
    }
}
