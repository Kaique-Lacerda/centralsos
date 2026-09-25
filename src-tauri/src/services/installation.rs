use crate::models::validation::{
    FirebirdService, InspectionValue, InstallationSnapshot, InstalledSoftware,
};
use std::{collections::BTreeMap, fs, path::Path, process::Command};

const UNINSTALL_64: &str = r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
const UNINSTALL_32: &str = r"HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall";
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
        .map(|p| {
            find_software(p, |name| {
                let n = name.to_ascii_lowercase();
                n.contains("nuvem") && (n.contains("contábil") || n.contains("contabil"))
            })
        })
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
    match Command::new("reg.exe")
        .args(["query", key, "/v", name])
        .output()
    {
        Ok(output) if output.status.success() => {
            let value = String::from_utf8_lossy(&output.stdout)
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
            error: Some(String::from_utf8_lossy(&output.stderr).trim().to_owned()),
        },
        Err(error) => InspectionValue {
            value: None,
            error: Some(format!("Falha ao consultar o Registro: {error}")),
        },
    }
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
    for key in [UNINSTALL_64, UNINSTALL_32] {
        match Command::new("reg.exe").args(["query", key, "/s"]).output() {
            Ok(output) if output.status.success() => {
                parse_uninstall_entries(&String::from_utf8_lossy(&output.stdout), &mut found)
            }
            Ok(output) => issues.push(format!(
                "{key}: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )),
            Err(error) => issues.push(format!(
                "Não foi possível consultar os programas instalados: {error}"
            )),
        }
    }
    if found.is_empty() && issues.len() == 2 {
        (Err(issues.join("; ")), Some(issues.join("; ")))
    } else {
        (Ok(found), (!issues.is_empty()).then(|| issues.join("; ")))
    }
}

fn parse_uninstall_entries(output: &str, entries: &mut Vec<InstalledSoftware>) {
    let mut current_key = String::new();
    let mut values = BTreeMap::<String, String>::new();
    let finish =
        |_key: &str, values: &BTreeMap<String, String>, entries: &mut Vec<InstalledSoftware>| {
            let Some(name) = values.get("displayname").filter(|name| {
                let n = name.to_ascii_lowercase();
                n.contains("cobian")
                    || n.contains("nuvem") && (n.contains("contábil") || n.contains("contabil"))
            }) else {
                return;
            };
            let location = values
                .get("installlocation")
                .filter(|v| !v.trim().is_empty())
                .cloned()
                .or_else(|| {
                    values
                        .get("displayicon")
                        .and_then(|v| v.split(',').next())
                        .map(|v| v.trim().trim_matches('"').to_owned())
                });
            if !entries
                .iter()
                .any(|item| item.name.eq_ignore_ascii_case(name))
            {
                entries.push(InstalledSoftware {
                    name: name.clone(),
                    version: values.get("displayversion").cloned(),
                    location,
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
