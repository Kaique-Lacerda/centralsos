use crate::models::machine::{MachineSnapshot, MachineSystemSnapshot};

#[tauri::command]
pub fn get_machine_snapshot() -> MachineSnapshot {
    crate::services::snapshot::collect_machine_snapshot()
}

#[tauri::command]
pub fn get_system_info() -> MachineSystemSnapshot {
    crate::services::snapshot::collect_machine_snapshot().system
}
