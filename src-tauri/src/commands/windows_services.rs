use crate::models::{machine::SnapshotCollection, windows_service::WindowsServiceSnapshot};

#[tauri::command]
pub async fn get_windows_services() -> SnapshotCollection<WindowsServiceSnapshot> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(crate::services::windows_services::collect)
            .await
            .unwrap_or_else(|error| SnapshotCollection {
                items: Vec::new(),
                error: Some(format!("Falha na consulta de serviços: {error}")),
            })
    }
    #[cfg(not(windows))]
    {
        SnapshotCollection {
            items: Vec::new(),
            error: Some("A consulta de serviços exige o Desktop Windows.".into()),
        }
    }
}
