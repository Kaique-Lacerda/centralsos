use super::windows::failure;
use crate::models::{
    machine::SnapshotCollection,
    support::{Listener, ProcessInfo},
};
use std::{ffi::c_void, ptr};
pub fn protected_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    [
        "system",
        "idle",
        "registry",
        "secure system",
        "smss.exe",
        "csrss.exe",
        "wininit.exe",
        "winlogon.exe",
        "lsass.exe",
        "lsaiso.exe",
        "services.exe",
        "svchost.exe",
        "dwm.exe",
        "fontdrvhost.exe",
        "spoolsv.exe",
        "audiodg.exe",
        "msmpeng.exe",
        "sihost.exe",
        "taskhostw.exe",
        "explorer.exe",
        "central-sos.exe",
    ]
    .contains(&n.as_str())
}
pub fn collect() -> SnapshotCollection<ProcessInfo> {
    let mut s = sysinfo::System::new();
    s.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let users = sysinfo::Users::new_with_refreshed_list();
    let items = s
        .processes()
        .iter()
        .map(|(pid, p)| {
            let name = p.name().to_string_lossy().to_string();
            let path = p.exe().map(|p| p.to_string_lossy().to_string());
            let critical = protected_name(&name)
                || pid.as_u32() <= 4
                || pid.as_u32() == std::process::id()
                || path.as_ref().is_some_and(|p| system_path(p));
            ProcessInfo {
                name,
                pid: pid.as_u32(),
                path,
                memory_bytes: p.memory(),
                cpu_percent: None,
                runtime_seconds: p.run_time(),
                start_time: p.start_time(),
                user: p
                    .user_id()
                    .and_then(|id| users.list().iter().find(|u| u.id() == id))
                    .map(|u| u.name().into()),
                critical,
            }
        })
        .collect();
    SnapshotCollection { items, error: None }
}
fn system_path(path: &str) -> bool {
    static DIRECTORY: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    #[link(name = "kernel32")]
    extern "system" {
        fn GetWindowsDirectoryW(path: *mut u16, size: u32) -> u32;
    }
    let directory = DIRECTORY.get_or_init(|| {
        let mut b = [0u16; 32768];
        let n = unsafe { GetWindowsDirectoryW(b.as_mut_ptr(), 32768) };
        if n == 0 || n >= 32768 {
            None
        } else {
            Some(String::from_utf16_lossy(&b[..n as usize]).to_ascii_lowercase())
        }
    });
    let Some(w) = directory else { return true };
    let p = path.to_ascii_lowercase();
    p.starts_with(&format!("{w}\\system32\\")) || p.starts_with(&format!("{w}\\syswow64\\"))
}
#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
    fn CloseHandle(h: *mut c_void) -> i32;
    fn IsProcessCritical(h: *mut c_void, out: *mut i32) -> i32;
    fn QueryFullProcessImageNameW(h: *mut c_void, flags: u32, name: *mut u16, len: *mut u32)
        -> i32;
    fn GetProcessTimes(
        h: *mut c_void,
        created: *mut u64,
        exited: *mut u64,
        kernel: *mut u64,
        user: *mut u64,
    ) -> i32;
    fn TerminateProcess(h: *mut c_void, code: u32) -> i32;
    fn WaitForSingleObject(h: *mut c_void, timeout: u32) -> u32;
}
struct Handle(*mut c_void);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
pub fn validate_pid(pid: u32, name: &str, start: u64, confirmed: bool) -> Result<(), String> {
    super::require_confirmation(confirmed)?;
    if pid <= 4 || pid == std::process::id() || start == 0 || protected_name(name) {
        return Err("Processo protegido ou identidade inválida; encerramento bloqueado.".into());
    }
    Ok(())
}
pub fn terminate(
    pid: u32,
    expected_name: String,
    expected_start: u64,
    confirmed: bool,
) -> Result<String, String> {
    validate_pid(pid, &expected_name, expected_start, confirmed)?;
    super::elevated()?;
    let h = Handle(unsafe { OpenProcess(0x1000 | 1 | 0x100000, 0, pid) });
    if h.0.is_null() {
        return Err(failure("Não foi possível abrir o processo"));
    }
    let mut critical = 0;
    if unsafe { IsProcessCritical(h.0, &mut critical) } == 0 || critical != 0 {
        return Err(
            "O Windows não confirmou que o processo é não crítico; operação bloqueada.".into(),
        );
    }
    let mut path = [0u16; 32768];
    let mut len = 32768;
    if unsafe { QueryFullProcessImageNameW(h.0, 0, path.as_mut_ptr(), &mut len) } == 0 {
        return Err(failure("Identidade do executável indisponível"));
    }
    let path = String::from_utf16_lossy(&path[..len as usize]);
    let name = std::path::Path::new(&path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let (mut created, mut exit, mut kernel, mut user) = (0u64, 0u64, 0u64, 0u64);
    if unsafe { GetProcessTimes(h.0, &mut created, &mut exit, &mut kernel, &mut user) } == 0 {
        return Err(failure("Tempo de criação indisponível"));
    }
    let start = (created / 10_000_000)
        .checked_sub(11_644_473_600)
        .ok_or("Tempo de criação inválido; operação bloqueada.")?;
    if !name.eq_ignore_ascii_case(&expected_name)
        || start != expected_start
        || system_path(&path)
        || protected_name(name)
    {
        return Err(
            "O PID mudou de identidade ou aponta para processo protegido; operação bloqueada."
                .into(),
        );
    }
    if unsafe { TerminateProcess(h.0, 1) } == 0 {
        return Err(failure("Falha ao encerrar processo"));
    }
    if unsafe { WaitForSingleObject(h.0, 3000) } != 0 {
        return Err(
            "Encerramento solicitado, mas não confirmado em 3 segundos; consulte novamente.".into(),
        );
    }
    Ok(format!(
        "Processo {expected_name} (PID {pid}) encerrado e confirmado."
    ))
}
pub fn listeners(port: u16) -> Result<Vec<Listener>, String> {
    #[link(name = "iphlpapi")]
    extern "system" {
        fn GetExtendedTcpTable(
            table: *mut c_void,
            size: *mut u32,
            sort: i32,
            family: u32,
            class: u32,
            reserved: u32,
        ) -> u32;
    }
    let mut size = 0;
    let first = unsafe { GetExtendedTcpTable(ptr::null_mut(), &mut size, 0, 2, 3, 0) };
    if first != 122 && first != 0 {
        return Err(format!("Tabela TCP: Windows {first}"));
    }
    if size < 4 || size > 16 * 1024 * 1024 {
        return Err("Tamanho da tabela TCP inválido ou acima do limite.".into());
    }
    let mut data = vec![0u32; (size as usize + 3) / 4];
    let rc = unsafe { GetExtendedTcpTable(data.as_mut_ptr().cast(), &mut size, 0, 2, 3, 0) };
    if rc != 0 {
        return Err(format!("Tabela TCP: Windows {rc}"));
    }
    let processes = collect();
    let count = data.first().copied().unwrap_or(0) as usize;
    let mut rows = vec![];
    for row in data[1..].chunks_exact(6).take(count) {
        let p = (row[2] as u16).swap_bytes();
        if p == port {
            rows.push(Listener {
                address: std::net::Ipv4Addr::from(row[1].to_ne_bytes()).to_string(),
                port: p,
                pid: row[5],
                process_name: processes
                    .items
                    .iter()
                    .find(|p| p.pid == row[5])
                    .map(|p| p.name.clone()),
            })
        }
    }
    Ok(rows)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn process_safety() {
        for n in ["lsass.exe", "CSRSS.EXE", "System", "svchost.exe"] {
            assert!(protected_name(n));
            assert!(validate_pid(999, n, 1, true).is_err())
        }
        assert!(validate_pid(0, "test.exe", 1, true).is_err());
        assert!(validate_pid(999, "test.exe", 1, false).is_err());
        assert!(validate_pid(999, "test.exe", 1, true).is_ok())
    }
}
