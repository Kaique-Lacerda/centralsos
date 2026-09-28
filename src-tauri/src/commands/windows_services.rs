use crate::models::{machine::SnapshotCollection, windows_service::WindowsServiceSnapshot};

#[tauri::command]
pub fn get_windows_services() -> SnapshotCollection<WindowsServiceSnapshot> {
    #[cfg(windows)]
    {
        crate::services::windows_services::collect()
    }
    #[cfg(not(windows))]
    {
        SnapshotCollection {
            items: Vec::new(),
            error: Some("A consulta de serviços exige o Desktop Windows.".into()),
        }
    }
}
