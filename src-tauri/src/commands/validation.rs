use crate::models::validation::InstallationSnapshot;

#[tauri::command]
pub fn get_installation_snapshot() -> InstallationSnapshot {
    #[cfg(windows)]
    {
        return crate::services::installation::collect();
    }
    #[cfg(not(windows))]
    {
        InstallationSnapshot::unavailable("A consulta de configuração e programas requer Windows.")
    }
}
