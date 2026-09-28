use crate::models::validation::{
    FirebirdService, InspectionValue, InstallationSnapshot, InstalledSoftware,
    SoftwareRegistrySource,
};
use std::{collections::BTreeMap, fs, path::Path, process::Command};
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x08000000;
const UNINSTALL_ROOT: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
const DATABASE: &str = r"C:\SoS Soluções\Troia\Banco\autocom.fdb";
const TROIA_DIR: &str = r"C:\SoS Soluções\Troia";
// Configurar somente quando o procedimento informar o nome exato da DLL.
const PROCEDURE_DLL_FILE_NAME: Option<&str> = None;

pub fn collect() -> InstallationSnapshot {
    let uac_enable_lua = registry_value(
        r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System",
        "EnableLUA",
    );
    let unknown_setting = InspectionValue {
        value: None,
        error: Some("O estado efetivo dessa opção não pôde ser determinado com segurança.".into()),
    };
    let dll_unknown = InspectionValue {
        value: None,
        error: Some(
            "O procedimento não especificou o nome da DLL; nenhum arquivo foi presumido.".into(),
        ),
    };
    let network_discovery = firewall_group_state("@FirewallAPI.dll,-32752");
    let file_printer_sharing = firewall_group_state("@FirewallAPI.dll,-28502");
    let automatic_network_device_setup = registry_bool(
        r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\NcdAutoSetup\Private",
        "AutoSetup",
    );
    let database_exists = path_exists(DATABASE);
    let (firebird_services, firebird_error) = collect_firebird();
    let (programs, program_error) = collect_installed_software();
    let (ibconsole_executables, ibconsole_error) = list_executables(TROIA_DIR);
    let cobian = programs
        .as_ref()
        .map(|p| find_software(p, |n| n.to_ascii_lowercase().contains("cobian")))
        .unwrap_or_default();
    let nube_contabil = programs
        .as_ref()
        .map(|p| find_software(p, is_target_software))
        .unwrap_or_default();
    InstallationSnapshot {
        uac_enable_lua,
        network_discovery,
        automatic_network_device_setup,
        file_printer_sharing,
        password_protected_sharing: unknown_setting,
        dll_file_name: PROCEDURE_DLL_FILE_NAME.map(str::to_owned),
        dll_system32_exists: PROCEDURE_DLL_FILE_NAME
            .map(|n| path_exists(&format!(r"C:\Windows\System32\{n}")))
            .unwrap_or_else(|| dll_unknown.clone()),
        dll_syswow64_exists: PROCEDURE_DLL_FILE_NAME
            .map(|n| path_exists(&format!(r"C:\Windows\SysWOW64\{n}")))
            .unwrap_or(dll_unknown),
        database_exists,
        firebird_services,
        firebird_error,
        cobian,
        cobian_error: program_error.clone(),
        ibconsole_executables,
        ibconsole_error,
        nube_contabil,
        nube_contabil_error: program_error,
    }
}

fn path_exists(path: &str) -> InspectionValue {
    match Path::new(path).try_exists() {
        Ok(v) => InspectionValue {
            value: Some(v.to_string()),
            error: None,
        },
        Err(e) => InspectionValue {
            value: None,
            error: Some(format!("Não foi possível consultar {path}: {e}")),
        },
    }
}

fn registry_value(key: &str, name: &str) -> InspectionValue {
    match reg_command()
        .args(["query", key, "/v", name])
        .output()
    {
        Ok(output) if output.status.success() => {
            let value = decode_registry_output(&output.stdout)
                .lines()
                .find_map(|line| {
                    let mut columns = line.split_whitespace();
                    if !columns.next()?.eq_ignore_ascii_case(name) {
                        return None;
                    }
                    let _kind = columns.next()?;
                    columns.next().map(str::to_owned)
                });
            InspectionValue { value, error: None }
        }
        Ok(output) => InspectionValue {
            value: None,
            error: Some(decode_registry_output(&output.stderr).trim().to_owned()),
        },
        Err(error) => InspectionValue {
            value: None,
            error: Some(format!("Falha ao consultar o Registro: {error}")),
        },
    }
}

#[link(name = "kernel32")]
extern "system" {
    fn GetACP() -> u32;
    fn GetOEMCP() -> u32;
    fn MultiByteToWideChar(
        code_page: u32,
        flags: u32,
        source: *const u8,
        source_length: i32,
        destination: *mut u16,
        destination_length: i32,
    ) -> i32;
}

fn decode_registry_output(bytes: &[u8]) -> String {
    if let Some(utf16) = bytes.strip_prefix(&[0xff, 0xfe]) {
        let words = utf16.chunks_exact(2).map(|pair| u16::from_le_bytes([pair[0], pair[1]])).collect::<Vec<_>>();
        return String::from_utf16_lossy(&words);
    }
    if let Ok(utf8) = std::str::from_utf8(bytes) {
        return utf8.to_owned();
    }
    for code_page in [unsafe { GetOEMCP() }, unsafe { GetACP() }] {
        let needed = unsafe {
            MultiByteToWideChar(code_page, 0, bytes.as_ptr(), bytes.len() as i32, std::ptr::null_mut(), 0)
        };
        if needed <= 0 { continue; }
        let mut wide = vec![0u16; needed as usize];
        let written = unsafe {
            MultiByteToWideChar(code_page, 0, bytes.as_ptr(), bytes.len() as i32, wide.as_mut_ptr(), needed)
        };
        if written > 0 { return String::from_utf16_lossy(&wide[..written as usize]); }
    }
    String::from_utf8_lossy(bytes).into_owned()
}

fn registry_bool(key: &str, name: &str) -> InspectionValue {
    let inspected = registry_value(key, name);
    let Some(value) = inspected.value else {
        return inspected;
    };
    let enabled = match value.to_ascii_lowercase().as_str() {
        "0x1" | "1" => true,
        "0x0" | "0" => false,
        _ => {
            return InspectionValue {
                value: None,
                error: Some(format!("Valor inesperado no Registro: {value}")),
            }
        }
    };
    InspectionValue {
        value: Some(enabled.to_string()),
        error: None,
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "PascalCase")]
struct FirewallRuleRow {
    rule_group: Option<String>,
    enabled: Option<u16>,
}

fn firewall_group_state(group: &str) -> InspectionValue {
    let connection = match wmi::WMIConnection::with_namespace_path("ROOT\\StandardCimv2") {
        Ok(connection) => connection,
        Err(error) => {
            return InspectionValue {
                value: None,
                error: Some(format!(
                    "Consulta das regras do Firewall indisponível: {error}"
                )),
            }
        }
    };
    let query =
        format!("SELECT RuleGroup, Enabled FROM MSFT_NetFirewallRule WHERE RuleGroup = '{group}'");
    match connection.raw_query::<FirewallRuleRow>(&query) {
        Ok(rows) => {
            let states = rows
                .into_iter()
                .filter_map(|row| {
                    row.rule_group
                        .filter(|g| g.eq_ignore_ascii_case(group))
                        .and(row.enabled)
                })
                .collect::<Vec<_>>();
            if states.is_empty() {
                return InspectionValue {
                    value: None,
                    error: Some(
                        "O grupo de regras não foi retornado pelo provedor do Firewall.".into(),
                    ),
                };
            }
            if states.iter().all(|state| *state == 1) {
                return InspectionValue {
                    value: Some("true".into()),
                    error: None,
                };
            }
            if states.iter().all(|state| *state == 2) {
                return InspectionValue {
                    value: Some("false".into()),
                    error: None,
                };
            }
            InspectionValue { value: None, error: Some("As regras do grupo apresentam estados mistos; não é possível inferir a configuração do grupo com segurança.".into()) }
        }
        Err(error) => InspectionValue {
            value: None,
            error: Some(format!(
                "Não foi possível consultar o grupo do Firewall: {error}"
            )),
        },
    }
}

#[link(name = "version")]
extern "system" {
    fn GetFileVersionInfoSizeW(file_name: *const u16, handle: *mut u32) -> u32;
    fn GetFileVersionInfoW(
        file_name: *const u16,
        handle: u32,
        length: u32,
        data: *mut std::ffi::c_void,
    ) -> i32;
    fn VerQueryValueW(
        data: *const std::ffi::c_void,
        sub_block: *const u16,
        buffer: *mut *mut std::ffi::c_void,
        length: *mut u32,
    ) -> i32;
}

#[repr(C)]
struct FixedFileInfo {
    signature: u32,
    structure_version: u32,
    file_version_ms: u32,
    file_version_ls: u32,
    product_version_ms: u32,
    product_version_ls: u32,
    flags_mask: u32,
    flags: u32,
    file_os: u32,
    file_type: u32,
    file_subtype: u32,
    file_date_ms: u32,
    file_date_ls: u32,
}

fn executable_file_version(path: &str) -> Option<String> {
    let file_name = path
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut handle = 0;
    let length = unsafe { GetFileVersionInfoSizeW(file_name.as_ptr(), &mut handle) };
    if length == 0 {
        return None;
    }
    let mut data = vec![0u8; length as usize];
    if unsafe { GetFileVersionInfoW(file_name.as_ptr(), handle, length, data.as_mut_ptr().cast()) }
        == 0
    {
        return None;
    }
    let sub_block = "\\"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let mut buffer = std::ptr::null_mut();
    let mut value_length = 0;
    if unsafe {
        VerQueryValueW(
            data.as_ptr().cast(),
            sub_block.as_ptr(),
            &mut buffer,
            &mut value_length,
        )
    } == 0
        || value_length < std::mem::size_of::<FixedFileInfo>() as u32
    {
        return None;
    }
    let info = unsafe { std::ptr::read_unaligned(buffer.cast::<FixedFileInfo>()) };
    if info.signature != 0xFEEF04BD {
        return None;
    }
    Some(format!(
        "{}.{}.{}.{}",
        info.file_version_ms >> 16,
        info.file_version_ms & 0xffff,
        info.file_version_ls >> 16,
        info.file_version_ls & 0xffff
    ))
}

fn collect_installed_software() -> (Result<Vec<InstalledSoftware>, String>, Option<String>) {
    let mut found = vec![];
    let mut issues = vec![];
    let mut successful_queries = 0;
    for hive in ["HKLM", "HKCU"] {
        for view in ["64", "32"] {
            let key = format!(r"{hive}\{UNINSTALL_ROOT}");
            match reg_command()
                .arg("query")
                .arg(&key)
                .arg("/s")
                .arg(format!("/reg:{view}"))
                .output()
            {
            Ok(output) if output.status.success() => {
                    successful_queries += 1;
                    parse_uninstall_entries(
                        &decode_registry_output(&output.stdout),
                        hive,
                        view,
                        &mut found,
                    )
            }
            Ok(output) => issues.push(format!(
                    "{key} (view {view}): {}",
                decode_registry_output(&output.stderr).trim()
            )),
            Err(error) => issues.push(format!(
                    "Não foi possível consultar {key} (view {view}): {error}"
            )),
            }
        }
    }
    if successful_queries == 0 {
        (Err(issues.join("; ")), Some(issues.join("; ")))
    } else {
        (Ok(found), (!issues.is_empty()).then(|| issues.join("; ")))
    }
}

fn reg_command() -> Command {
    let mut command = Command::new("reg.exe");
    command.creation_flags(reg_creation_flags());
    command
}

fn reg_creation_flags() -> u32 {
    CREATE_NO_WINDOW
}

fn parse_uninstall_entries(output: &str, hive: &str, view: &str, entries: &mut Vec<InstalledSoftware>) {
    let mut current_key = String::new();
    let mut values = BTreeMap::<String, String>::new();
    let finish = |key: &str, values: &BTreeMap<String, String>, entries: &mut Vec<InstalledSoftware>| {
            let Some(name) = values.get("displayname").filter(|name| is_target_software(name)) else {
                return;
            };
            let location = software_location(values);
            let (version, version_source) = software_version(name, values, location.as_deref());
            let source = SoftwareRegistrySource {
                hive: hive.to_owned(),
                view: format!("{view}-bit"),
                key: key.to_owned(),
                display_name: name.clone(),
                display_version: values.get("displayversion").cloned(),
                install_location: values.get("installlocation").cloned(),
            };
            let family = software_family(name);
            let duplicate = entries.iter_mut().find(|item| {
                software_family(&item.name) == family
                    && (item.version == version || item.version.is_none() || version.is_none())
                    && (item.location == location || item.location.is_none() || location.is_none())
            });
            if let Some(existing) = duplicate {
                if existing.location.is_none() { existing.location = location; }
                if existing.version_source.is_none() { existing.version_source = version_source; }
                if !existing.registry_sources.iter().any(|item| item.hive == source.hive && item.view == source.view && item.key.eq_ignore_ascii_case(&source.key)) {
                    existing.registry_sources.push(source);
                }
            } else {
                entries.push(InstalledSoftware {
                    name: name.clone(),
                    version,
                    version_source,
                    location,
                    registry_sources: vec![source],
                });
            }
        };
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("HKEY") {
            finish(&current_key, &values, entries);
            current_key = trimmed.to_owned();
            values.clear();
            continue;
        }
        let mut parts = trimmed
            .splitn(3, char::is_whitespace)
            .filter(|v| !v.is_empty());
        if let (Some(name), Some(kind), Some(value)) = (parts.next(), parts.next(), parts.next()) {
            if kind.starts_with("REG_") {
                values.insert(name.to_ascii_lowercase(), value.trim().to_owned());
            }
        }
    }
    finish(&current_key, &values, entries);
}

fn software_family(name: &str) -> &'static str {
    let normalized = name.to_ascii_lowercase();
    if normalized.contains("cobian") { "cobian" } else { "nuvem-contabil" }
}

fn is_target_software(name: &str) -> bool {
    let normalized = name.to_lowercase();
    normalized.contains("cobian")
        || normalized.contains("nuvem") && normalized.contains("cont") && normalized.contains("bil")
}

fn software_location(values: &BTreeMap<String, String>) -> Option<String> {
    if let Some(location) = values.get("installlocation").filter(|value| !value.trim().is_empty()) {
        return Some(location.trim().to_owned());
    }
    ["uninstallstring", "quietuninstallstring", "displayicon"]
        .iter()
        .filter_map(|name| values.get(*name))
        .find_map(|command| {
            let executable = command_executable_path(command)?;
            let path = Path::new(&executable);
            let parent = path.parent()?;
            parent.is_dir().then(|| parent.to_string_lossy().into_owned())
        })
}

fn command_executable_path(command: &str) -> Option<String> {
    let value = command.trim();
    if let Some(quoted) = value.strip_prefix('"') {
        let executable = quoted.split('"').next()?.trim();
        return executable.to_ascii_lowercase().ends_with(".exe").then(|| executable.to_owned());
    }
    let lower = value.to_ascii_lowercase();
    let end = lower.find(".exe")? + 4;
    Some(value[..end].trim().trim_matches('"').to_owned())
}

fn display_name_version(name: &str) -> Option<String> {
    name.split(|character: char| !(character.is_ascii_digit() || character == '.'))
        .find(|token| {
            let parts = token.split('.').collect::<Vec<_>>();
            parts.len() >= 3 && parts.iter().all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()))
        })
        .map(str::to_owned)
}

fn software_version(name: &str, values: &BTreeMap<String, String>, location: Option<&str>) -> (Option<String>, Option<String>) {
    if let Some(version) = values.get("displayversion").filter(|value| !value.trim().is_empty()) {
        return (Some(version.trim().to_owned()), Some("DisplayVersion do Registro".into()));
    }
    if let Some(version) = display_name_version(name) {
        return (Some(version), Some("versão informada no DisplayName do Registro".into()));
    }
    if name.to_ascii_lowercase().contains("cobian") {
        if let Some(version) = location.and_then(|directory| executable_file_version(&Path::new(directory).join("cbInterface.exe").to_string_lossy())) {
            return (Some(version), Some("FileVersion de cbInterface.exe".into()));
        }
    }
    (None, None)
}

fn find_software(
    programs: &[InstalledSoftware],
    matches: impl Fn(&str) -> bool,
) -> Vec<InstalledSoftware> {
    programs
        .iter()
        .filter(|p| matches(&p.name))
        .cloned()
        .collect()
}

fn list_executables(folder: &str) -> (Vec<String>, Option<String>) {
    match fs::read_dir(folder) {
        Ok(entries) => {
            let mut names = entries
                .filter_map(Result::ok)
                .filter_map(|entry| {
                    let path = entry.path();
                    if path.is_file()
                        && path
                            .extension()
                            .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
                    {
                        path.file_name()
                            .map(|name| name.to_string_lossy().into_owned())
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>();
            names.sort_unstable_by_key(|n| n.to_ascii_lowercase());
            (names, None)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (vec![], None),
        Err(e) => (
            vec![],
            Some(format!("Não foi possível listar {folder}: {e}")),
        ),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ServiceRow {
    name: Option<String>,
    display_name: Option<String>,
    state: Option<String>,
    path_name: Option<String>,
}

fn collect_firebird() -> (Vec<FirebirdService>, Option<String>) {
    let connection = match wmi::WMIConnection::new() {
        Ok(c) => c,
        Err(e) => return (vec![], Some(format!("Consulta WMI indisponível: {e}"))),
    };
    match connection.raw_query::<ServiceRow>("SELECT Name, DisplayName, State, PathName FROM Win32_Service WHERE Name LIKE '%Firebird%' OR DisplayName LIKE '%Firebird%'"){
        Ok(rows)=>(rows.into_iter().filter_map(|row|{let path=row.path_name;let exe=path.as_deref().map(executable_path);let architecture=exe.as_deref().and_then(pe_architecture);let version=exe.as_deref().and_then(executable_file_version);Some(FirebirdService{service_name:row.name?,display_name:row.display_name.unwrap_or_default(),state:row.state,path,version,architecture})}).collect(),None),
        Err(e)=>(vec![],Some(format!("Não foi possível consultar os serviços Firebird por WMI: {e}")))
    }
}
fn executable_path(line: &str) -> String {
    let s = line.trim();
    if let Some(rest) = s.strip_prefix('"') {
        return rest.split('"').next().unwrap_or(rest).to_owned();
    }
    s.split_whitespace().next().unwrap_or(s).to_owned()
}
fn pe_architecture(path: &str) -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = fs::File::open(path).ok()?;
    let mut off = [0u8; 4];
    f.seek(SeekFrom::Start(0x3c)).ok()?;
    f.read_exact(&mut off).ok()?;
    f.seek(SeekFrom::Start(u32::from_le_bytes(off) as u64))
        .ok()?;
    let mut h = [0u8; 6];
    f.read_exact(&mut h).ok()?;
    if &h[..4] != b"PE\0\0" {
        return None;
    }
    match u16::from_le_bytes([h[4], h[5]]) {
        0x014c => Some("x86".into()),
        0x8664 => Some("x64".into()),
        0xaa64 => Some("ARM64".into()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registration(display_name: &str, display_version: &str, install_location: &str) -> String {
        format!(
            "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{display_name}\n    DisplayName    REG_SZ    {display_name}\n    DisplayVersion    REG_SZ    {display_version}\n    InstallLocation    REG_SZ    {install_location}\n"
        )
    }

    #[test]
    fn registry_process_uses_create_no_window_flag() {
        assert_eq!(reg_creation_flags() & CREATE_NO_WINDOW, CREATE_NO_WINDOW);
    }

    #[test]
    fn collects_all_hives_and_views_and_merges_duplicate_registration_sources() {
        let mut entries = Vec::new();
        for (hive, view) in [("HKLM", "64"), ("HKLM", "32"), ("HKCU", "64"), ("HKCU", "32")] {
            parse_uninstall_entries(
                &registration("Nuvem Contábil v 1.0.29", "", "C:\\SoS Soluções\\Nuvem Contábil"),
                hive,
                view,
                &mut entries,
            );
        }
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].version.as_deref(), Some("1.0.29"));
        assert_eq!(entries[0].version_source.as_deref(), Some("versão informada no DisplayName do Registro"));
        assert_eq!(entries[0].registry_sources.len(), 4);
        assert_eq!(entries[0].registry_sources[0].display_version, None);
        assert_eq!(entries[0].registry_sources[0].install_location.as_deref(), Some("C:\\SoS Soluções\\Nuvem Contábil"));
        assert!(entries[0].registry_sources.iter().any(|source| source.hive == "HKCU" && source.view == "32-bit"));
        assert!(entries[0].registry_sources.iter().any(|source| source.hive == "HKLM" && source.view == "64-bit"));
    }

    #[test]
    fn preserves_distinct_versions_instead_of_collapsing_them() {
        let mut entries = Vec::new();
        parse_uninstall_entries(
            &registration("Nuvem Contábil v 1.0.29", "", "C:\\SoS Soluções\\Nuvem Contábil"),
            "HKLM", "32", &mut entries,
        );
        parse_uninstall_entries(
            &registration("Nuvem Contábil v 1.0.30", "", "C:\\SoS Soluções\\Nuvem Contábil"),
            "HKCU", "64", &mut entries,
        );
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().any(|entry| entry.version.as_deref() == Some("1.0.29")));
        assert!(entries.iter().any(|entry| entry.version.as_deref() == Some("1.0.30")));
    }

    #[test]
    fn uses_registered_version_before_name_or_executable_fallback() {
        let mut values = BTreeMap::new();
        values.insert("displayversion".into(), "1.2.3".into());
        assert_eq!(software_version("Cobian Backup 9", &values, None).0.as_deref(), Some("1.2.3"));
        assert_eq!(software_version("Cobian Backup 9", &values, None).1.as_deref(), Some("DisplayVersion do Registro"));
        assert_eq!(display_name_version("Nuvem Contábil v 1.0.29").as_deref(), Some("1.0.29"));
        assert!(is_target_software("Nuvem Cont�bil v 1.0.29"));
        assert!(is_target_software("Cobian Backup 9"));
        assert!(!is_target_software("Nuvem Fiscal"));
    }

    #[test]
    fn locates_unquoted_uninstaller_paths_containing_spaces() {
        assert_eq!(
            command_executable_path(r"C:\Program Files (x86)\Cobian Backup 9\cbUninstall.exe"),
            Some(r"C:\Program Files (x86)\Cobian Backup 9\cbUninstall.exe".into())
        );
    }
}
