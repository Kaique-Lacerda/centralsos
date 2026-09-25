use std::time::{SystemTime, UNIX_EPOCH};
use sysinfo::System;

use crate::models::machine::{MachineSnapshot, SnapshotCollection};

pub fn collect_machine_snapshot() -> MachineSnapshot {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let mut snapshot = MachineSnapshot {
        captured_at: now.as_millis().min(u64::MAX as u128) as u64,
        ..MachineSnapshot::default()
    };
    snapshot.system.hostname = System::host_name().unwrap_or_else(|| "Indisponível".into());
    snapshot.system.username = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "Indisponível".into());
    snapshot.system.architecture = std::env::consts::ARCH.into();

    #[cfg(windows)]
    {
        match wmi::WMIConnection::new() {
            Ok(connection) => {
                super::system::collect(&connection, &mut snapshot.system);
                snapshot.storage = collect_section(super::storage::collect(&connection));
                let (network, network_error) = super::network::collect(&connection);
                snapshot.network = SnapshotCollection {
                    items: network,
                    error: network_error,
                };
                snapshot.printers = collect_section(super::printers::collect(&connection));
            }
            Err(error) => {
                let reason = format!("Não foi possível conectar ao provedor WMI: {error}");
                snapshot.system.error = Some(reason.clone());
                snapshot.storage.error = Some(reason.clone());
                snapshot.network.error = Some(reason.clone());
                snapshot.printers.error = Some(reason);
            }
        }
    }

    #[cfg(not(windows))]
    {
        let reason = "A coleta detalhada do snapshot requer Windows.".to_string();
        snapshot.system.error = Some(reason.clone());
        snapshot.storage.error = Some(reason.clone());
        snapshot.network.error = Some(reason.clone());
        snapshot.printers.error = Some(reason);
    }

    snapshot
}

fn collect_section<T>(result: Result<Vec<T>, String>) -> SnapshotCollection<T> {
    match result {
        Ok(items) => SnapshotCollection { items, error: None },
        Err(error) => SnapshotCollection {
            items: Vec::new(),
            error: Some(error),
        },
    }
}
