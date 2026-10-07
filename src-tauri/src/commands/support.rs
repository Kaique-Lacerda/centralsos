use crate::models::{machine::SnapshotCollection, support::*};

macro_rules! desktop_task {
    ($task:expr) => {{
        #[cfg(windows)]
        {
            tauri::async_runtime::spawn_blocking($task)
                .await
                .map_err(|e| e.to_string())?
        }
        #[cfg(not(windows))]
        {
            Err("Esta ferramenta requer o aplicativo Desktop Windows.".into())
        }
    }};
}
#[tauri::command]
pub async fn support_get_network() -> Result<NetworkSupportSnapshot, String> {
    desktop_task!(crate::services::support::network::collect)
}
#[tauri::command]
pub async fn support_test_connectivity(
    host: String,
    port: Option<u32>,
) -> Result<ConnectivitySnapshot, String> {
    desktop_task!(move || crate::services::support::connectivity::test(host, port, true))
}
#[tauri::command]
pub async fn support_network_action(
    action: String,
    index: Option<u32>,
    confirmed: bool,
) -> Result<String, String> {
    desktop_task!(move || crate::services::support::network::repair(action, index, confirmed))
}
#[tauri::command]
pub async fn support_service_action(
    name: String,
    action: String,
    confirmed: bool,
) -> Result<ServiceActionResult, String> {
    desktop_task!(move || crate::services::support::services::action(name, action, confirmed))
}
#[tauri::command]
pub async fn support_get_firebird() -> Result<FirebirdSnapshot, String> {
    desktop_task!(crate::services::support::firebird::collect)
}
#[tauri::command]
pub async fn support_test_share(path: String) -> Result<ShareSnapshot, String> {
    desktop_task!(move || crate::services::support::shares::test(path))
}
#[tauri::command]
pub async fn support_list_shares(host: String) -> Result<SnapshotCollection<ShareInfo>, String> {
    desktop_task!(move || crate::services::support::shares::list(host))
}
#[tauri::command]
pub async fn support_get_system() -> Result<SystemSupportSnapshot, String> {
    desktop_task!(crate::services::support::system::collect)
}
#[tauri::command]
pub async fn support_cleanup_temp(confirmed: bool) -> Result<CleanupResult, String> {
    desktop_task!(move || crate::services::support::system::cleanup(confirmed))
}
#[tauri::command]
pub async fn support_sync_time(confirmed: bool) -> Result<Check, String> {
    desktop_task!(move || crate::services::support::system::sync_time(confirmed))
}
#[tauri::command]
pub async fn support_get_processes() -> Result<SnapshotCollection<ProcessInfo>, String> {
    desktop_task!(|| Ok(crate::services::support::processes::collect()))
}
#[tauri::command]
pub async fn support_terminate_process(
    pid: u32,
    expected_name: String,
    expected_start: u64,
    confirmed: bool,
) -> Result<String, String> {
    desktop_task!(move || crate::services::support::processes::terminate(
        pid,
        expected_name,
        expected_start,
        confirmed
    ))
}
#[tauri::command]
pub async fn support_get_dependencies() -> Result<SnapshotCollection<Software>, String> {
    desktop_task!(|| Ok(crate::services::support::dependencies::collect()))
}
