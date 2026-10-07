mod engine;
mod journal;
mod logging;
mod runner;
mod session;
#[cfg(windows)]
mod service;
fn main() {
    #[cfg(windows)]
    if let Err(error) = service::dispatch() {
        eprintln!(
            "{}",
            serde_json::json!({"event":"agent.start_failed","error":error.to_string()})
        );
        std::process::exit(1);
    }
    #[cfg(not(windows))]
    eprintln!("CENTRAL SOS Agent exige Windows Service.");
}
