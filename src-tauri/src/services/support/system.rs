use super::windows::{exists, value, wide, HKLM};
use crate::models::{machine::SnapshotCollection, support::*};
use std::{
    ffi::c_void,
    fs,
    os::windows::{fs::MetadataExt, process::CommandExt},
    path::{Path, PathBuf},
    ptr,
    time::{Duration, SystemTime},
};
const AGE: u64 = 7 * 24 * 3600;
fn eligible_values(
    extension: &str,
    is_file: bool,
    attributes: u32,
    readonly: bool,
    age: Option<u64>,
) -> bool {
    is_file
        && attributes & 0x400 == 0
        && !readonly
        && (extension.eq_ignore_ascii_case("tmp") || extension.eq_ignore_ascii_case("temp"))
        && age.is_some_and(|a| a >= AGE)
}
pub fn eligible(path: &Path, metadata: &fs::Metadata, now: SystemTime) -> bool {
    eligible_values(
        path.extension().and_then(|s| s.to_str()).unwrap_or(""),
        metadata.is_file(),
        metadata.file_attributes(),
        metadata.permissions().readonly(),
        metadata
            .modified()
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .map(|a| a.as_secs()),
    )
}
fn roots() -> Vec<PathBuf> {
    #[link(name = "shell32")]
    extern "system" {
        fn SHGetFolderPathW(
            window: *mut c_void,
            folder: i32,
            token: *mut c_void,
            flags: u32,
            path: *mut u16,
        ) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetWindowsDirectoryW(path: *mut u16, size: u32) -> u32;
    }
    let mut r = vec![];
    let mut b = [0u16; 260];
    if unsafe { SHGetFolderPathW(ptr::null_mut(), 0x1c, ptr::null_mut(), 0, b.as_mut_ptr()) } == 0 {
        let n = b.iter().position(|c| *c == 0).unwrap_or(b.len());
        r.push(PathBuf::from(String::from_utf16_lossy(&b[..n])).join("Temp"))
    }
    let n = unsafe { GetWindowsDirectoryW(b.as_mut_ptr(), 260) };
    if n > 0 && n < 260 {
        r.push(PathBuf::from(String::from_utf16_lossy(&b[..n as usize])).join("Temp"))
    }
    r
}
fn scan(root: &Path) -> (TempSummary, Vec<PathBuf>) {
    let mut s = TempSummary {
        root: root.to_string_lossy().into(),
        scanned_bytes: 0,
        eligible_bytes: 0,
        eligible_files: 0,
        errors: 0,
        truncated: false,
    };
    let mut files = vec![];
    let meta = match fs::symlink_metadata(root) {
        Ok(m) if m.is_dir() && m.file_attributes() & 0x400 == 0 => m,
        _ => {
            s.errors += 1;
            return (s, files);
        }
    };
    drop(meta);
    let mut stack = vec![(root.to_path_buf(), 0)];
    let mut count = 0;
    while let Some((dir, depth)) = stack.pop() {
        match fs::read_dir(&dir) {
            Ok(entries) => {
                for e in entries {
                    count += 1;
                    if count > 10000 {
                        s.truncated = true;
                        return (s, files);
                    }
                    let e = match e {
                        Ok(e) => e,
                        Err(_) => {
                            s.errors += 1;
                            continue;
                        }
                    };
                    let p = e.path();
                    let m = match fs::symlink_metadata(&p) {
                        Ok(m) => m,
                        Err(_) => {
                            s.errors += 1;
                            continue;
                        }
                    };
                    if m.file_attributes() & 0x400 != 0 {
                        continue;
                    }
                    if m.is_dir() {
                        if depth < 4 {
                            stack.push((p, depth + 1))
                        } else {
                            s.truncated = true
                        }
                    } else if m.is_file() {
                        s.scanned_bytes += m.len();
                        if eligible(&p, &m, SystemTime::now()) {
                            s.eligible_bytes += m.len();
                            s.eligible_files += 1;
                            files.push(p)
                        }
                    }
                }
            }
            Err(_) => s.errors += 1,
        }
    }
    (s, files)
}
fn pending() -> (Vec<String>, Option<String>) {
    let mut reasons = vec![];
    let mut errors = vec![];
    for (path, label) in [
        (
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending",
            "Component Based Servicing",
        ),
        (
            r"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired",
            "Windows Update",
        ),
    ] {
        match exists(HKLM, path) {
            Ok(true) => reasons.push(label.into()),
            Ok(false) => {}
            Err(e) => errors.push(format!("{label}: Windows {e}")),
        }
    }
    match value(
        HKLM,
        r"SYSTEM\CurrentControlSet\Control\Session Manager",
        "PendingFileRenameOperations",
        0,
    ) {
        Ok(Some(v)) if !v.trim_matches('\0').is_empty() => {
            reasons.push("PendingFileRenameOperations".into())
        }
        Err(e) => errors.push(format!("PendingFileRenameOperations: {e}")),
        _ => {}
    }
    (reasons, (!errors.is_empty()).then(|| errors.join("; ")))
}
pub fn collect() -> Result<SystemSupportSnapshot, String> {
    let c = wmi::WMIConnection::new().map_err(|e| e.to_string())?;
    let volumes = match crate::services::storage::collect(&c) {
        Ok(items) => SnapshotCollection { items, error: None },
        Err(error) => SnapshotCollection {
            items: vec![],
            error: Some(error),
        },
    };
    let (reboot_reasons, reboot_error) = pending();
    let timezone = value(
        HKLM,
        r"SYSTEM\CurrentControlSet\Control\TimeZoneInformation",
        "TimeZoneKeyName",
        0,
    )
    .ok()
    .flatten();
    let time_service = crate::services::windows_services::collect()
        .items
        .into_iter()
        .find(|s| s.name.as_deref() == Some("W32Time"));
    let time_sync = time_status();
    let temporary = roots().iter().map(|r| scan(r).0).collect();
    Ok(SystemSupportSnapshot {
        volumes,
        uptime_seconds: sysinfo::System::uptime(),
        reboot_reasons,
        reboot_error,
        timezone,
        time_service,
        time_sync,
        temporary,
    })
}
fn decode_console_with_codepage(bytes: &[u8], codepage: u32) -> String {
    if bytes.starts_with(&[0xff, 0xfe]) {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.trim_start_matches('\u{feff}').to_owned();
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn MultiByteToWideChar(
            cp: u32,
            flags: u32,
            input: *const u8,
            len: i32,
            output: *mut u16,
            capacity: i32,
        ) -> i32;
    }
    let Ok(len) = i32::try_from(bytes.len()) else {
        return String::from_utf8_lossy(bytes).into_owned();
    };
    let size = unsafe { MultiByteToWideChar(codepage, 0, bytes.as_ptr(), len, ptr::null_mut(), 0) };
    if size <= 0 {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    let mut units = vec![0u16; size as usize];
    let converted =
        unsafe { MultiByteToWideChar(codepage, 0, bytes.as_ptr(), len, units.as_mut_ptr(), size) };
    if converted <= 0 {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    String::from_utf16_lossy(&units[..converted as usize])
}
fn decode_console(bytes: &[u8]) -> String {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetConsoleOutputCP() -> u32;
        fn GetOEMCP() -> u32;
    }
    let console_cp = unsafe { GetConsoleOutputCP() };
    let cp = if console_cp == 0 {
        unsafe { GetOEMCP() }
    } else {
        console_cp
    };
    decode_console_with_codepage(bytes, cp)
}
fn fixed_time_command(args: &[&str]) -> Result<(bool, String), String> {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
    }
    let mut buf = [0u16; 32768];
    let n = unsafe { GetSystemDirectoryW(buf.as_mut_ptr(), 32768) };
    if n == 0 || n >= 32768 {
        return Err("Diretório oficial do Windows indisponível.".into());
    }
    let executable = PathBuf::from(String::from_utf16_lossy(&buf[..n as usize])).join("w32tm.exe");
    let mut child = std::process::Command::new(executable)
        .args(args)
        .creation_flags(0x08000000)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let start = std::time::Instant::now();
    loop {
        if child.try_wait().map_err(|e| e.to_string())?.is_some() {
            break;
        }
        if start.elapsed() > Duration::from_secs(8) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Tempo limite do w32tm (8 segundos).".into());
        }
        std::thread::sleep(Duration::from_millis(100))
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let text = format!(
        "{}{}",
        decode_console(&out.stdout),
        decode_console(&out.stderr)
    );
    Ok((out.status.success(), text.chars().take(8000).collect()))
}
pub fn interpret_time(text: &str, ok: bool) -> Check {
    if !ok {
        return Check::new("warning", text);
    }
    let leap = text.lines().find_map(|line| {
        let lower = line.trim_start().to_lowercase();
        if lower.starts_with("leap indicator:") || lower.starts_with("indicador de salto:") {
            line.split(':')
                .nth(1)?
                .trim()
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse::<u32>()
                .ok()
                .filter(|value| *value <= 3)
        } else {
            None
        }
    });
    let mut check = Check::new(
        match leap {
            Some(0..=2) => "success",
            Some(3) => "warning",
            _ => "unknown",
        },
        text,
    );
    // For this check, code carries the parsed leap indicator (0..3).
    // Failed commands and unrecognized locales have no indicator.
    check.code = leap;
    check
}
fn time_status() -> Check {
    match fixed_time_command(&["/query", "/status"]) {
        Ok((ok, text)) => interpret_time(&text, ok),
        Err(e) => Check::new("unknown", e),
    }
}
pub fn sync_time(confirmed: bool) -> Result<Check, String> {
    super::require_confirmation(confirmed)?;
    super::elevated()?;
    let service = crate::services::windows_services::collect()
        .items
        .into_iter()
        .find(|s| s.name.as_deref() == Some("W32Time"))
        .ok_or("Serviço Windows Time não encontrado.")?;
    if service.state.as_deref() == Some("Stopped") {
        super::services::action("W32Time".into(), "start".into(), true)?;
    }
    let (ok, text) = fixed_time_command(&["/resync"])?;
    if !ok {
        return Err(text);
    }
    Ok(time_status())
}
#[link(name = "kernel32")]
extern "system" {
    fn CreateFileW(
        name: *const u16,
        access: u32,
        share: u32,
        security: *const c_void,
        creation: u32,
        flags: u32,
        template: *mut c_void,
    ) -> *mut c_void;
    fn GetFinalPathNameByHandleW(h: *mut c_void, path: *mut u16, len: u32, flags: u32) -> u32;
    fn GetFileInformationByHandle(h: *mut c_void, info: *mut FileInformation) -> i32;
    fn SetFileInformationByHandle(
        h: *mut c_void,
        class: u32,
        info: *const c_void,
        size: u32,
    ) -> i32;
    fn CloseHandle(h: *mut c_void) -> i32;
}
#[repr(C)]
#[derive(Default)]
struct FileInformation {
    attributes: u32,
    creation_time: [u32; 2],
    access_time: [u32; 2],
    write_time: [u32; 2],
    volume: u32,
    size_high: u32,
    size_low: u32,
    links: u32,
    index_high: u32,
    index_low: u32,
}
struct Handle(*mut c_void);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
fn delete_candidate(root: &Path, path: &Path) -> Result<u64, String> {
    // Open only the selected existing file, do not follow a final reparse point.
    // The handle's resolved target must stay under the official temporary root.
    let h = Handle(unsafe {
        CreateFileW(
            wide(&path.to_string_lossy()).as_ptr(),
            0x10000 | 0x80,
            0,
            ptr::null(),
            3,
            0x00200000,
            ptr::null_mut(),
        )
    });
    if h.0 as isize == -1 {
        return Err(super::windows::failure("Temporário em uso ou sem acesso"));
    }
    let mut b = [0u16; 32768];
    let n = unsafe { GetFinalPathNameByHandleW(h.0, b.as_mut_ptr(), 32768, 0) };
    if n == 0 || n >= 32768 {
        return Err("Caminho final indisponível; exclusão bloqueada.".into());
    }
    let final_path = PathBuf::from(String::from_utf16_lossy(&b[..n as usize]));
    let canonical = root.canonicalize().map_err(|e| e.to_string())?;
    if !final_path.starts_with(&canonical) {
        return Err("Temporário fora da raiz permitida; exclusão bloqueada.".into());
    }
    let mut metadata = FileInformation::default();
    if unsafe { GetFileInformationByHandle(h.0, &mut metadata) } == 0 {
        return Err(super::windows::failure(
            "Metadados do temporário indisponíveis",
        ));
    }
    let modified =
        ((metadata.write_time[1] as u64) << 32 | metadata.write_time[0] as u64) / 10_000_000;
    let age = modified.checked_sub(11_644_473_600).and_then(|seconds| {
        SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_secs()
            .checked_sub(seconds)
    });
    if !eligible_values(
        final_path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or(""),
        metadata.attributes & 0x10 == 0,
        metadata.attributes,
        metadata.attributes & 1 != 0,
        age,
    ) {
        return Err("Arquivo não elegível após revalidação.".into());
    }
    // FILE_DISPOSITION_INFO (BOOL). A held file handle protects the identity from rename/replacement.
    let delete = 1i32;
    if unsafe { SetFileInformationByHandle(h.0, 4, (&delete as *const i32).cast(), 4) } == 0 {
        return Err(super::windows::failure("Arquivo em uso ou exclusão negada"));
    }
    Ok((metadata.size_high as u64) << 32 | metadata.size_low as u64)
}
pub fn cleanup(confirmed: bool) -> Result<CleanupResult, String> {
    super::require_confirmation(confirmed)?;
    super::elevated()?;
    let mut result = CleanupResult {
        removed_bytes: 0,
        removed_files: 0,
        skipped_files: 0,
        failures: 0,
    };
    for root in roots() {
        if root.ancestors().any(|p| {
            fs::symlink_metadata(p)
                .map(|m| m.file_attributes() & 0x400 != 0)
                .unwrap_or(true)
        }) {
            result.failures += 1;
            continue;
        }
        let hold = Handle(unsafe {
            CreateFileW(
                wide(&root.to_string_lossy()).as_ptr(),
                0x80,
                1 | 2,
                ptr::null(),
                3,
                0x02000000 | 0x00200000,
                ptr::null_mut(),
            )
        });
        if hold.0 as isize == -1 {
            result.failures += 1;
            continue;
        }
        let (_, files) = scan(&root);
        for path in files {
            match delete_candidate(&root, &path) {
                Ok(bytes) => {
                    result.removed_bytes += bytes;
                    result.removed_files += 1
                }
                Err(_) => result.skipped_files += 1,
            }
        }
    }
    Ok(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn time_states() {
        assert_eq!(
            interpret_time("Leap Indicator: 0(no warning)", true).state,
            "success"
        );
        assert_eq!(
            interpret_time("Indicador de salto: 3", true).state,
            "warning"
        );
        assert_eq!(interpret_time("Unknown locale", true).state, "unknown");
        assert_eq!(interpret_time("erro", false).state, "warning")
    }
    #[test]
    fn cleanup_requires_confirmation() {
        assert!(super::super::require_confirmation(false).is_err());
        assert_eq!(AGE, 604800);
    }
    #[test]
    fn console_encoding_preserves_portuguese_and_indicator() {
        assert_eq!(
            decode_console_with_codepage("Sincronização".as_bytes(), 850),
            "Sincronização"
        );
        assert_eq!(
            decode_console_with_codepage(b"Sincroniza\x87\xc6o", 850),
            "Sincronização"
        );
        let mut utf16 = vec![0xff, 0xfe];
        for unit in "Última sincronização".encode_utf16() {
            utf16.extend(unit.to_le_bytes());
        }
        assert_eq!(
            decode_console_with_codepage(&utf16, 850),
            "Última sincronização"
        );
        assert_eq!(
            interpret_time("  Indicador de salto: 3", true).code,
            Some(3)
        );
        assert_eq!(interpret_time("Indicador de salto: 3", false).code, None);
        assert_eq!(interpret_time("Unknown locale", true).code, None);
        assert_eq!(interpret_time("Indicador de salto: 30", true).code, None);
    }
    #[test]
    fn temporary_policy_is_conservative() {
        assert!(eligible_values("tmp", true, 0, false, Some(AGE)));
        for ext in ["log", "fdb", "pdf", "exe", "txt"] {
            assert!(!eligible_values(ext, true, 0, false, Some(AGE * 2)))
        }
        assert!(!eligible_values("tmp", true, 0x400, false, Some(AGE * 2)));
        assert!(!eligible_values("tmp", true, 0, false, Some(10)));
        assert!(!eligible_values("tmp", true, 0, false, None));
        assert!(!eligible_values("tmp", false, 0, false, Some(AGE * 2)));
        assert!(!eligible_values("tmp", true, 0, true, Some(AGE * 2)));
    }
}
