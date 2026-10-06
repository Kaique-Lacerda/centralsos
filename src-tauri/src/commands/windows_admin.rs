use crate::services::windows_admin::HostnameChangeResult;

#[tauri::command]
pub fn change_hostname(hostname: String) -> Result<HostnameChangeResult, String> {
    crate::services::windows_admin::change_hostname(hostname)
}

#[tauri::command]
pub fn open_computer_management() -> Result<(), String> { crate::services::windows_admin::open_computer_management() }
#[tauri::command]
pub fn open_services_console() -> Result<(), String> { crate::services::windows_admin::open_services_console() }
#[tauri::command]
pub fn open_registry_editor() -> Result<(), String> { crate::services::windows_admin::open_registry_editor() }
#[tauri::command]
pub fn open_network_settings() -> Result<(), String> { crate::services::windows_admin::open_network_settings() }
#[tauri::command]
pub fn open_admin_terminal() -> Result<(), String> { crate::services::windows_admin::open_admin_terminal() }
