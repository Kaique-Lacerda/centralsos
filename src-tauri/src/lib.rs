mod commands;
pub use central_sos_core::{models, services};
fn updater_config(config: &tauri::Config)->Option<serde_json::Value>{
    use base64::Engine;
    let updater = config.plugins.0.get("updater")?;
    let key=updater.get("pubkey")?.as_str()?.trim();
    let endpoints=updater.get("endpoints")?.as_array()?;
    if endpoints.len()!=1 { return None; }
    let endpoint=endpoints[0].as_str()?.trim();
    let decoded=base64::engine::general_purpose::STANDARD.decode(key).ok()?;let text=String::from_utf8(decoded).ok()?;
    if !text.starts_with("untrusted comment:"){return None;}
    let raw_key=base64::engine::general_purpose::STANDARD.decode(text.lines().nth(1)?).ok()?;
    if raw_key.len()!=42 || ![b"Ed".as_slice(),b"ED".as_slice()].contains(&&raw_key[..2]) {return None;}
    let url=reqwest::Url::parse(endpoint).ok()?;if url.scheme()!="https"||url.host_str().is_none()||url.password().is_some()||!url.username().is_empty()||url.path()!="/api/app-update"||url.query().is_some()||url.fragment().is_some(){return None;}
    for flag in ["dangerousInsecureTransportProtocol", "dangerousAcceptInvalidCerts", "dangerousAcceptInvalidHostnames", "allowDowngrades"] {
        if updater.get(flag).is_some_and(|v| v.as_bool()!=Some(false)) { return None; }
    }
    if updater.get("requireSignedVersion").and_then(|v|v.as_bool())!=Some(true) { return None; }
    Some(updater.clone())
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context=tauri::generate_context!();
    let config=updater_config(context.config());
    tauri::Builder::default()
        .setup(move|app|{if config.is_some(){app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;}Ok(())})
        .invoke_handler(tauri::generate_handler![
            commands::control::agent_status,
            commands::control::agent_enroll,
            commands::control::agent_unlink,
            commands::control::updater_configuration,
            commands::control::restart_after_update,
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
        .run(context)
        .expect("falha ao iniciar CENTRAL SOS");
}
