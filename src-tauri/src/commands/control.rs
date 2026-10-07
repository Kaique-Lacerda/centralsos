#[tauri::command]
pub async fn agent_status() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| {
        central_sos_link::status_for_app(env!("CARGO_PKG_VERSION"))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn agent_enroll(
    backend: String,
    pairing_code: String,
    profile: String,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move||{
    crate::services::printer_management::require_elevation()?;
    central_sos_link::vault::secure_root()?;
    if central_sos_link::vault::load()?.is_some(){return Err("Este dispositivo já está vinculado; desvincule antes de parear novamente.".into());}
    let profile=match profile.as_str(){"TERMINAL"=>central_sos_link::protocol::Profile::TERMINAL,"SERVER"=>central_sos_link::protocol::Profile::SERVER,_=>return Err("Perfil inválido".into())};
    if pairing_code.len()!=13||!pairing_code.starts_with("SOS-")||!pairing_code.bytes().all(|v|v.is_ascii_uppercase()||v.is_ascii_digit()||v==b'-'){return Err("Código inválido".into());}
    let snapshot=crate::services::snapshot::collect_machine_snapshot();
    let fingerprint=central_sos_link::vault::fingerprint()?;
    let enrollment=central_sos_link::Transport::new(&backend)?.request(reqwest::Method::POST,"/api/agent/enroll",None,Some(&serde_json::json!({"pairingCode":pairing_code,"fingerprint":fingerprint,"hostname":snapshot.system.hostname,"profile":profile,"appVersion":env!("CARGO_PKG_VERSION"),"agentVersion":central_sos_link::AGENT_VERSION,"coreVersion":central_sos_core::CORE_VERSION,"protocolVersion":central_sos_link::policy::PROTOCOL_VERSION,"osVersion":snapshot.system.windows_version,"architecture":snapshot.system.architecture})))?;
    central_sos_link::vault::save(&central_sos_link::protocol::Link{backend:central_sos_link::validate_backend(&backend)?,enrollment,app_version:env!("CARGO_PKG_VERSION").into()})?;central_sos_link::status()
}).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn agent_unlink(confirmed: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::services::printer_management::require_elevation()?;
        central_sos_link::unlink(confirmed)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn updater_configuration(app: tauri::AppHandle) -> serde_json::Value {
    serde_json::json!({"configured":super::super::updater_config(app.config()).is_some(),"policy":"MANUAL"})
}
#[tauri::command]
pub fn restart_after_update(app: tauri::AppHandle) {
    app.restart();
}
