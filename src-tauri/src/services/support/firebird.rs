use crate::models::{machine::SnapshotCollection, support::*};
pub const DATABASE: &str = r"C:\SoS Soluções\Troia\Banco\autocom.fdb";
fn executable(line: &str) -> Option<String> {
    let s = line.trim();
    if let Some(rest) = s.strip_prefix('"') {
        return rest.split_once('"').map(|p| p.0.into());
    }
    let end = s.to_ascii_lowercase().find(".exe")? + 4;
    Some(s[..end].into())
}
fn installation_folder(exe: &str) -> Option<String> {
    let parent = std::path::Path::new(exe).parent()?;
    let folder = if parent
        .file_name()
        .is_some_and(|n| n.eq_ignore_ascii_case("bin"))
    {
        parent.parent().unwrap_or(parent)
    } else {
        parent
    };
    Some(folder.to_string_lossy().to_string())
}
pub fn collect() -> Result<FirebirdSnapshot, String> {
    let all = crate::services::windows_services::collect();
    let services = SnapshotCollection {
        items: all
            .items
            .into_iter()
            .filter(|s| {
                s.name
                    .as_deref()
                    .is_some_and(|n| n.to_ascii_lowercase().starts_with("firebird"))
            })
            .collect(),
        error: all.error,
    };
    let mut installations = super::dependencies::installed_software();
    installations
        .items
        .retain(|s| s.name.to_ascii_lowercase().contains("firebird"));
    for service in &services.items {
        if let Some(exe) = service.path_name.as_deref().and_then(executable) {
            let version = crate::services::installation::executable_file_version(&exe);
            let architecture = crate::services::installation::pe_architecture(&exe);
            let location = installation_folder(&exe);
            if let Some(existing) = installations.items.iter_mut().find(|s| {
                s.location
                    .as_ref()
                    .zip(location.as_ref())
                    .is_some_and(|(a, b)| a.trim_end_matches('\\').eq_ignore_ascii_case(b))
            }) {
                if existing.architecture.is_none() {
                    existing.architecture = architecture;
                }
                if existing.version.is_none() {
                    existing.version = version;
                }
            } else {
                installations.items.push(Software {
                    name: service
                        .display_name
                        .clone()
                        .unwrap_or_else(|| "Firebird (serviço registrado)".into()),
                    version,
                    architecture,
                    location,
                    source: format!("Executável do serviço, versão/cabeçalho PE: {exe}"),
                })
            }
        }
    }
    let mut processes = super::processes::collect();
    processes.items.retain(|p| {
        [
            "fbserver.exe",
            "fbguard.exe",
            "fb_inet_server.exe",
            "firebird.exe",
        ]
        .contains(&p.name.to_ascii_lowercase().as_str())
    });
    Ok(FirebirdSnapshot {
        installations,
        services,
        processes,
        port: super::connectivity::test("127.0.0.1".into(), Some(3050), true)?,
        database: database(),
    })
}
fn database() -> DatabaseInfo {
    let mut d = DatabaseInfo {
        path: DATABASE.into(),
        exists: None,
        size_bytes: None,
        modified_at: None,
        read_access: None,
        write_access: None,
        locked: None,
        error: None,
    };
    match std::fs::metadata(DATABASE) {
        Ok(m) => {
            if !m.is_file() {
                d.exists = Some(false);
                d.error = Some("O caminho esperado não é um arquivo de banco.".into());
                return d;
            }
            d.exists = Some(true);
            d.size_bytes = Some(m.len());
            d.modified_at = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|v| v.as_secs() * 1000);
            match super::windows::file_access(DATABASE) {
                Ok((read, write)) => {
                    d.read_access = Some(read);
                    d.write_access = Some(write && !m.permissions().readonly())
                }
                Err(e) => d.error = Some(e),
            }
        }
        Err(e) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                d.exists = Some(false)
            }
            d.error = Some(e.to_string())
        }
    }
    d
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn file_paths_are_not_commands() {
        assert_eq!(
            executable(r#""C:\Program Files\Firebird\fbserver.exe" -s"#),
            Some(r"C:\Program Files\Firebird\fbserver.exe".into())
        );
        assert_eq!(
            executable(r"C:\Program Files\Firebird\fbguard.exe -s"),
            Some(r"C:\Program Files\Firebird\fbguard.exe".into())
        );
        assert_eq!(executable("unknown"), None);
        assert!(DATABASE.ends_with("autocom.fdb"));
        assert_eq!(
            installation_folder(r"C:\Firebird\bin\fbguard.exe"),
            installation_folder(r"C:\Firebird\bin\fbserver.exe")
        );
    }
}
