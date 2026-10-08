#![cfg_attr(windows, windows_subsystem = "windows")]
mod engine;
mod journal;
mod lifecycle;
mod logging;
mod runner;
#[cfg(windows)]
mod service;
mod session;
fn main() {
    #[cfg(windows)]
    if std::env::args_os().len() != 1 {
        if let Err(code) = service::installer_command() {
            eprintln!(
                "{}",
                serde_json::json!({"event":"agent.installation_failed","code":code})
            );
            std::process::exit(1);
        }
        return;
    }
    #[cfg(windows)]
    if let Err(error) = service::dispatch() {
        eprintln!(
            "{}",
            serde_json::json!({"event":"agent.start_failed","code":"SCM_DISPATCH_FAILED"})
        );
        let _ = error;
        std::process::exit(1);
    }
    #[cfg(not(windows))]
    eprintln!("CENTRAL SOS Agent exige Windows Service.");
}
