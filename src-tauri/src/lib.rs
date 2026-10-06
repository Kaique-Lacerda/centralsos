mod commands;
pub mod models;
mod services;
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::system::get_machine_snapshot,
            commands::support::support_get_network,
            commands::support::support_test_connectivity,
            commands::support::support_network_action,
            commands::support::support_service_action,
            commands::support::support_get_firebird,
            commands::support::support_test_share,
            commands::support::support_list_shares,
            commands::support::support_get_system,
            commands::support::support_cleanup_temp,
            commands::support::support_sync_time,
            commands::support::support_get_processes,
            commands::support::support_terminate_process,
            commands::support::support_get_dependencies,
            commands::system::get_system_info,
            commands::printer::get_printer_queue,
            commands::printer::discover_network_printers,
            commands::printer::add_printer_connection,
            commands::printer::remove_printer,
            commands::printer::get_printer_diagnostic,
            commands::printer::get_printer_native_state,
            commands::printer::get_print_spooler,
            commands::printer::probe_printer_connection,
            commands::printer::set_printer_port,
            commands::printer::start_print_spooler,
            commands::printer::restart_print_spooler,
            commands::printer::reset_print_spooler,
            commands::printer::start_printer_queue_monitor,
            commands::printer::stop_printer_queue_monitor,
            commands::printer::print_printer_test_page,
            commands::printer::cancel_printer_job,
            commands::printer::cancel_problem_printer_job,
            commands::printer::clear_printer_queue,
            commands::printer::pause_printer,
            commands::printer::resume_printer,
            commands::printer::set_default_printer,
            commands::printer::rename_printer,
            commands::printer::set_printer_share,
            commands::printer::set_printer_location,
            commands::printer::set_printer_comment,
            commands::printer::get_printer_configuration,
            commands::printer::get_printer_pause_state,
            commands::printer::get_printer_permissions,
            commands::printer::configure_printer_permissions,
            commands::printer::set_printer_permissions,
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
