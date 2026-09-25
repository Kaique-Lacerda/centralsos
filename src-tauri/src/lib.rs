mod commands;
pub mod models;
mod services;
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::system::get_machine_snapshot,
            commands::system::get_system_info,
            commands::validation::get_installation_snapshot
        ])
        .run(tauri::generate_context!())
        .expect("falha ao iniciar CENTRAL SOS");
}
