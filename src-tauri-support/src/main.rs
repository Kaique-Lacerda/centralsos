#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod control;
mod host;
mod http;
use host::{AuthView, Host};
use http::{Failure, Result};
use std::sync::Arc;
use tauri::Manager;

#[tauri::command]
fn support_status(host: tauri::State<'_, Arc<Host>>) -> AuthView {
    host.status()
}
async fn run<T: Send + 'static>(
    host: Arc<Host>,
    action: impl FnOnce(&Host) -> T + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(move || action(&host))
        .await
        .map_err(|_| Failure::new("HOST_UNAVAILABLE", 0))
}
#[tauri::command]
async fn support_login_start(host: tauri::State<'_, Arc<Host>>) -> Result<AuthView> {
    run(host.inner().clone(), |h| h.start(open_authorization)).await?
}
#[tauri::command]
async fn support_login_poll(host: tauri::State<'_, Arc<Host>>) -> Result<AuthView> {
    run(host.inner().clone(), Host::poll).await?
}
#[tauri::command]
async fn support_login_complete(
    host: tauri::State<'_, Arc<Host>>,
    confirmed: bool,
) -> Result<AuthView> {
    run(host.inner().clone(), move |h| h.complete(confirmed)).await?
}
#[tauri::command]
async fn support_session(host: tauri::State<'_, Arc<Host>>) -> Result<AuthView> {
    run(host.inner().clone(), Host::session).await?
}
#[tauri::command]
async fn support_logout(host: tauri::State<'_, Arc<Host>>) -> Result<AuthView> {
    run(host.inner().clone(), Host::logout).await
}
#[tauri::command]
async fn support_control(
    host: tauri::State<'_, Arc<Host>>,
    request: control::ControlRequest,
) -> Result<serde_json::Value> {
    run(host.inner().clone(), move |h| h.control(request)).await?
}

#[cfg(windows)]
fn open_authorization(url: &str) -> Result<()> {
    use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};
    let verb: Vec<u16> = "open\0".encode_utf16().collect();
    let file: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
    // This function is private: only the validated native auth flow can reach it.
    let value = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if value as isize <= 32 {
        Err(Failure::new("BROWSER_UNAVAILABLE", 0))
    } else {
        Ok(())
    }
}
#[cfg(not(windows))]
fn open_authorization(_: &str) -> Result<()> {
    Err(Failure::new("UNSUPPORTED_PLATFORM", 0))
}
fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let configured = app
                .path()
                .app_config_dir()
                .ok()
                .and_then(|p| http::configuration(&p.join("backend.json")).ok());
            let http = configured
                .as_deref()
                .and_then(|o| http::NativeHttp::new(o).ok())
                .map(|h| Arc::new(h) as Arc<dyn http::Http>);
            app.manage(Arc::new(Host::new(
                configured.filter(|_| http.is_some()),
                http,
            )));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            support_status,
            support_login_start,
            support_login_poll,
            support_login_complete,
            support_session,
            support_logout,
            support_control
        ])
        .run(tauri::generate_context!())
        .expect("Support application failed");
}
