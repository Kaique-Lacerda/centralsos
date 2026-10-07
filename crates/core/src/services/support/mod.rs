pub mod connectivity;
pub mod dependencies;
pub mod firebird;
pub mod network;
pub mod processes;
pub mod services;
pub mod shares;
pub mod system;
pub mod windows;

pub fn require_confirmation(confirmed: bool) -> Result<(), String> {
    if confirmed {
        Ok(())
    } else {
        Err("Confirme explicitamente esta alteração.".into())
    }
}
pub fn elevated() -> Result<(), String> {
    crate::services::printer_management::require_elevation()
}
