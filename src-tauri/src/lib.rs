mod commands;
pub mod models;
mod services;
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::system::get_machine_snapshot,
            commands::system::get_system_info,
            commands::validation::get_installation_snapshot,
            commands::windows_services::get_windows_services,
            commands::windows_admin::change_hostname,
            commands::windows_admin::open_computer_management,
            commands::windows_admin::open_services_console,
            commands::windows_admin::open_registry_editor,
            commands::windows_admin::open_network_settings,
            commands::windows_admin::open_admin_terminal
        ])
        .run(tauri::generate_context!())
        .expect("falha ao iniciar CENTRAL SOS");
}
