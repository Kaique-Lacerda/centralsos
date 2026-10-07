use central_sos_link::session::{
    windows::{self, Handle},
    *,
};
use std::{
    mem::{size_of, zeroed},
    ptr::{null, null_mut},
    sync::mpsc,
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::*,
    Graphics::Printing::*,
    System::{Diagnostics::ToolHelp::*, RemoteDesktop::*},
};

pub fn bounded_collect(operation: &Operation, identity: &Identity) -> Result<Data> {
    let (tx, rx) = mpsc::sync_channel(1);
    let operation = operation.clone();
    let identity = identity.clone();
    std::thread::spawn(move || {
        let _ = tx.send(collect(&operation, &identity));
    });
    // A stuck native read retires the entire Helper after the structured timeout reply.
    // This prevents leaked workers or later requests racing a hung spooler/provider call.
    rx.recv_timeout(Duration::from_millis(3500))
        .unwrap_or_else(|_| {
            Err(SessionError::new(
                ErrorCode::SessionTimeout,
                "Coleta de sessão excedeu o limite; Helper será encerrado",
            ))
        })
}
fn collect(operation: &Operation, identity: &Identity) -> Result<Data> {
    windows::info(identity)?;
    match operation {
        Operation::Info(_) => Ok(Data::Info(windows::info(identity)?)),
        Operation::Processes(_) => Ok(Data::Processes(processes(identity)?)),
        Operation::Printers(_) => Ok(Data::Printers(printers()?)),
    }
}
fn collection_error(message: &str) -> SessionError {
    SessionError::new(ErrorCode::SessionCollectionFailed, message)
}
fn processes(identity: &Identity) -> Result<Inventory<Process>> {
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(collection_error("Inventário de processos indisponível"));
        }
        let snapshot = Handle(snapshot);
        let mut row: PROCESSENTRY32W = zeroed();
        row.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        let mut next = Process32FirstW(snapshot.0, &mut row);
        let mut inventory = Inventory {
            items: Vec::new(),
            truncated: false,
            incomplete: false,
        };
        while next != 0 {
            let mut session = 0;
            if ProcessIdToSessionId(row.th32ProcessID, &mut session) != 0
                && session == identity.session_id
            {
                // Session number alone is not ownership. Exclude other users and privileged processes.
                match windows::process_identity(row.th32ProcessID) {
                    Ok((_process, owner)) if &owner == identity => {
                        if inventory.items.len() < MAX_PROCESSES {
                            inventory.items.push(Process {
                                pid: row.th32ProcessID,
                                name: windows::read_wide(
                                    row.szExeFile.as_ptr(),
                                    row.szExeFile.len(),
                                )?,
                            });
                        } else {
                            inventory.truncated = true;
                        }
                    }
                    Err(_) => inventory.incomplete = true,
                    _ => {}
                }
            }
            next = Process32NextW(snapshot.0, &mut row);
        }
        if GetLastError() != ERROR_NO_MORE_FILES {
            inventory.incomplete = true;
        }
        inventory.items.sort_by_key(|process| process.pid);
        Ok(inventory)
    }
}
fn default_printer() -> (Option<String>, bool) {
    unsafe {
        let mut length = 0;
        GetDefaultPrinterW(null_mut(), &mut length);
        if length == 0 {
            return (None, GetLastError() != ERROR_FILE_NOT_FOUND);
        }
        if length > 1024 {
            return (None, true);
        }
        let mut value = vec![0u16; length as usize];
        if GetDefaultPrinterW(value.as_mut_ptr(), &mut length) == 0 {
            return (None, true);
        }
        match windows::read_wide(value.as_ptr(), value.len()) {
            Ok(value) => (Some(value), false),
            Err(_) => (None, true),
        }
    }
}
fn printers() -> Result<Inventory<Printer>> {
    unsafe {
        // The calling process owns the interactive token: CONNECTIONS and Default are per-user.
        let flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
        let (mut needed, mut returned) = (0, 0);
        let first = EnumPrintersW(flags, null(), 4, null_mut(), 0, &mut needed, &mut returned);
        if first == 0 && GetLastError() != ERROR_INSUFFICIENT_BUFFER {
            return Err(collection_error(
                "Inventário de impressoras do usuário indisponível",
            ));
        }
        if needed > 4 * 1024 * 1024 {
            return Err(collection_error(
                "Inventário de impressoras excedeu o limite nativo",
            ));
        }
        let (default, default_error) = default_printer();
        if needed == 0 {
            return Ok(Inventory {
                items: Vec::new(),
                truncated: false,
                incomplete: default_error,
            });
        }
        let mut buffer = vec![0usize; (needed as usize).div_ceil(size_of::<usize>())];
        if EnumPrintersW(
            flags,
            null(),
            4,
            buffer.as_mut_ptr().cast(),
            needed,
            &mut needed,
            &mut returned,
        ) == 0
        {
            return Err(collection_error("EnumPrinters do usuário falhou"));
        }
        if returned as usize * size_of::<PRINTER_INFO_4W>() > buffer.len() * size_of::<usize>() {
            return Err(collection_error("Resposta de impressoras inválida"));
        }
        let rows = std::slice::from_raw_parts(
            buffer.as_ptr().cast::<PRINTER_INFO_4W>(),
            returned as usize,
        );
        let mut items = Vec::new();
        for row in rows.iter().take(MAX_PRINTERS) {
            let name = windows::read_wide(row.pPrinterName, 1024)?;
            let server = windows::read_wide(row.pServerName, 1024)?;
            let is_default = if default_error {
                None
            } else {
                Some(
                    default
                        .as_ref()
                        .is_some_and(|d| d.eq_ignore_ascii_case(&name)),
                )
            };
            items.push(Printer {
                name,
                server: if server.is_empty() {
                    None
                } else {
                    Some(server)
                },
                is_default,
            });
        }
        Ok(Inventory {
            items,
            truncated: rows.len() > MAX_PRINTERS,
            incomplete: default_error,
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn system_session_cannot_collect_user_resources() {
        let identity = Identity {
            session_id: 0,
            user_sid: "S-1-5-18".into(),
            logon_sid: String::new(),
        };
        assert!(collect(&Operation::Printers(EmptyPayload {}), &identity).is_err());
        assert!(collect(&Operation::Processes(EmptyPayload {}), &identity).is_err());
    }
    #[test]
    #[ignore = "Requires an unlocked Windows user session; read-only inventory"]
    fn live_user_read_only_results_obey_the_contract() {
        let identity = windows::own_identity().unwrap();
        assert_ne!(identity.session_id, 0);
        for name in ["session.info", "session.processes", "session.printers"] {
            let operation = Operation::from_name(name).unwrap();
            let now = chrono_for_fixture();
            let request = Request::new(operation.clone(), identity.clone(), now, now + 30_000);
            let data = bounded_collect(&operation, &identity).unwrap();
            let response =
                Response::for_request(&request, Outcome::Completed { result: data }, now);
            response.validate(&request, now).unwrap();
            assert!(!encode(&response).unwrap().is_empty());
        }
    }
    fn chrono_for_fixture() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64
    }
}
