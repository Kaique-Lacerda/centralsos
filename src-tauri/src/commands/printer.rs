use crate::models::printer_operation::{
    PrintJobSnapshot, PrinterConfigurationSnapshot, PrinterPermissionChangeResult,
    PrinterPermissionsSnapshot, PrinterQueueActionResult, SetPrinterPermissionRequest,
};
use crate::models::printer_diagnostic::*;

#[tauri::command]
pub async fn discover_network_printers()->Result<crate::models::machine::SnapshotCollection<DiscoveredPrinter>,String>{
    tauri::async_runtime::spawn_blocking(crate::services::printer_connections::discover).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn add_printer_connection(path:String)->Result<(),String>{
    tauri::async_runtime::spawn_blocking(move||crate::services::printer_connections::add(path)).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn remove_printer(printer_name:String,confirmed:bool)->Result<(),String>{
    tauri::async_runtime::spawn_blocking(move||crate::services::printer_connections::remove(printer_name,confirmed)).await.map_err(|e|e.to_string())?
}

#[tauri::command]
pub async fn get_printer_diagnostic(printer_name:String)->Result<PrinterDiagnosticSnapshot,String> {
    tauri::async_runtime::spawn_blocking(move||crate::services::printer_diagnostics::diagnose(printer_name)).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn get_printer_native_state(printer_name:String)->Result<PrinterNativeState,String> {
    tauri::async_runtime::spawn_blocking(move||crate::services::printer_management::native_state(printer_name)).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn get_print_spooler()->Result<(SpoolerState,bool),String> {
    tauri::async_runtime::spawn_blocking(||(crate::services::printer_spooler::snapshot(),crate::services::printer_management::elevated_context().unwrap_or(false))).await.map_err(|e|e.to_string())
}
#[tauri::command]
pub async fn probe_printer_connection(printer_name:String)->Result<TcpPrintProbe,String> {
    tauri::async_runtime::spawn_blocking(move||crate::services::printer_diagnostics::probe(printer_name)).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn set_printer_port(printer_name:String,port:String)->Result<(),String> {
    tauri::async_runtime::spawn_blocking(move||crate::services::printer_management::set_port(printer_name,port)).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn start_print_spooler()->Result<SpoolerActionResult,String> {
    tauri::async_runtime::spawn_blocking(||crate::services::printer_spooler::action("start",false)).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn restart_print_spooler()->Result<SpoolerActionResult,String> {
    tauri::async_runtime::spawn_blocking(||crate::services::printer_spooler::action("restart",false)).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn reset_print_spooler(confirm_all_jobs:bool)->Result<SpoolerActionResult,String> {
    tauri::async_runtime::spawn_blocking(move||crate::services::printer_spooler::action("reset",confirm_all_jobs)).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub fn start_printer_queue_monitor(printer_name:String,channel:tauri::ipc::Channel<QueueMonitorEvent>)->Result<String,String> { crate::services::printer_queue_monitor::start(printer_name,channel) }
#[tauri::command]
pub fn stop_printer_queue_monitor(monitor_id:String)->Result<(),String> { crate::services::printer_queue_monitor::stop(monitor_id) }

#[tauri::command]
pub async fn get_printer_queue(printer_name: String) -> Result<Vec<PrintJobSnapshot>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::services::printer_operations::get_printer_queue(printer_name)
    })
    .await
    .map_err(|error| format!("A consulta da fila foi interrompida: {error}"))?
}

#[tauri::command]
pub async fn print_printer_test_page(printer_name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::services::printer_operations::print_test_page(printer_name)
    })
    .await
    .map_err(|error| format!("A impressão da página de teste foi interrompida: {error}"))?
}

#[tauri::command]
pub async fn cancel_printer_job(printer_name: String, job_id: u32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::services::printer_operations::cancel_printer_job(printer_name, job_id))
        .await.map_err(|error| format!("O cancelamento do trabalho foi interrompido: {error}"))?
}
#[tauri::command]
pub async fn cancel_problem_printer_job(printer_name:String,job_id:u32)->Result<bool,String>{
    tauri::async_runtime::spawn_blocking(move||crate::services::printer_operations::cancel_problem_job(printer_name,job_id)).await.map_err(|e|e.to_string())?
}

#[tauri::command]
pub async fn clear_printer_queue(printer_name: String) -> Result<PrinterQueueActionResult, String> {
    tauri::async_runtime::spawn_blocking(move || crate::services::printer_operations::clear_printer_queue(printer_name))
        .await.map_err(|error| format!("A limpeza da fila foi interrompida: {error}"))?
}

#[tauri::command]
pub async fn pause_printer(printer_name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::services::printer_operations::set_printer_paused(printer_name, true))
        .await.map_err(|error| format!("A pausa da impressora foi interrompida: {error}"))?
}

#[tauri::command]
pub async fn resume_printer(printer_name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::services::printer_operations::set_printer_paused(printer_name, false))
        .await.map_err(|error| format!("A retomada da impressora foi interrompida: {error}"))?
}

#[tauri::command]
pub async fn set_default_printer(printer_name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::services::printer_management::set_default_printer(printer_name))
        .await.map_err(|error| format!("A definição da impressora padrão foi interrompida: {error}"))?
}

#[tauri::command]
pub async fn rename_printer(printer_name: String, new_name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::services::printer_management::rename_printer(printer_name, new_name))
        .await.map_err(|error| format!("A alteração do nome foi interrompida: {error}"))?
}

#[tauri::command]
pub async fn set_printer_share(printer_name: String, enabled: bool, share_name: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::services::printer_management::set_share(printer_name, enabled, share_name))
        .await.map_err(|error| format!("A alteração do compartilhamento foi interrompida: {error}"))?
}

#[tauri::command]
pub async fn set_printer_location(printer_name: String, location: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::services::printer_management::set_location(printer_name, location))
        .await.map_err(|error| format!("A alteração da localização foi interrompida: {error}"))?
}

#[tauri::command]
pub async fn set_printer_comment(printer_name: String, comment: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::services::printer_management::set_comment(printer_name, comment))
        .await.map_err(|error| format!("A alteração do comentário foi interrompida: {error}"))?
}

#[tauri::command]
pub async fn get_printer_configuration(printer_name: String) -> Result<PrinterConfigurationSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || crate::services::printer_management::get_configuration(printer_name))
        .await.map_err(|error| format!("A consulta das configurações foi interrompida: {error}"))?
}

#[tauri::command]
pub async fn get_printer_pause_state(printer_name: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || crate::services::printer_management::is_paused(printer_name))
        .await.map_err(|error| format!("A consulta do estado da impressora foi interrompida: {error}"))?
}

#[tauri::command]
pub async fn get_printer_permissions(printer_name: String) -> Result<PrinterPermissionsSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || crate::services::printer_management::get_printer_permissions(printer_name))
        .await.map_err(|error| format!("A consulta das permissões foi interrompida: {error}"))?
}

#[tauri::command]
pub async fn configure_printer_permissions(printer_name: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || crate::services::printer_management::configure_permissions(printer_name))
        .await.map_err(|error| format!("A configuração das permissões foi interrompida: {error}"))?
}

#[tauri::command]
pub async fn set_printer_permissions(request: SetPrinterPermissionRequest) -> Result<PrinterPermissionChangeResult, String> {
    tauri::async_runtime::spawn_blocking(move || crate::services::printer_management::set_printer_permissions(request))
        .await.map_err(|error| format!("A alteração das permissões foi interrompida: {error}"))?
}
