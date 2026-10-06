use super::windows::*;
use crate::models::{machine::SnapshotCollection, support::Software};
pub fn installed_software() -> SnapshotCollection<Software> {
    let mut items = vec![];
    let mut errors = vec![];
    let root = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
    for (hive, label) in [(HKLM, "HKLM"), (HKCU, "HKCU")] {
        for (view, bits) in [(0x100, "64"), (0x200, "32")] {
            match subkeys(hive, root, view) {
                Ok(keys) => {
                    for key in keys {
                        let path = format!("{root}\\{key}");
                        let mut read = |name: &str| match value(hive, &path, name, view) {
                            Ok(v) => v,
                            Err(e) => {
                                errors.push(format!("{label} {path}, {name}: Windows {e}"));
                                None
                            }
                        };
                        if let Some(name) = read("DisplayName") {
                            let architecture = if name.to_ascii_lowercase().contains("x64") {
                                Some("x64".into())
                            } else if name.to_ascii_lowercase().contains("x86") {
                                Some("x86".into())
                            } else {
                                None
                            };
                            items.push(Software {
                                name,
                                version: read("DisplayVersion"),
                                architecture,
                                location: read("InstallLocation").filter(|s| !s.is_empty()),
                                source: format!("{label}, visão {bits} bits: {path}"),
                            })
                        }
                    }
                }
                Err(e) => errors.push(format!("{label} Uninstall {bits}: Windows {e}")),
            }
        }
    }
    items.sort_by(|a, b| a.name.cmp(&b.name));
    items.dedup_by(|a, b| a.name == b.name && a.version == b.version && a.location == b.location);
    SnapshotCollection {
        items,
        error: (!errors.is_empty()).then(|| errors.join("; ")),
    }
}
pub fn collect() -> SnapshotCollection<Software> {
    let mut c = installed_software();
    c.items.retain(|s| dependency_name(&s.name));
    let webview = r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F1E7E3BB-6BE8-4739-95AD-C73FCBE860B0}";
    for hive in [HKLM, HKCU] {
        for view in [0x100, 0x200] {
            match value(hive, webview, "pv", view) {
                Ok(Some(version)) if version != "0.0.0.0" => c.items.push(Software {
                    name: "WebView2 Runtime".into(),
                    version: Some(version),
                    architecture: None,
                    location: None,
                    source: format!(
                        "EdgeUpdate, visão {} bits",
                        if view == 0x100 { 64 } else { 32 }
                    ),
                }),
                Err(e) => append_error(&mut c.error, format!("WebView2: Windows {e}")),
                _ => {}
            }
        }
    }
    let ndp = r"SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full";
    match value(HKLM, ndp, "Release", 0x100) {
        Ok(Some(release)) => c.items.push(Software {
            name: ".NET Framework 4".into(),
            version: value(HKLM, ndp, "Version", 0x100).ok().flatten(),
            architecture: None,
            location: None,
            source: format!("Registro NDP; Release={release}"),
        }),
        Err(e) => append_error(&mut c.error, format!(".NET Framework: Windows {e}")),
        _ => {}
    }
    for framework in ["v2.0.50727", "v3.5"] {
        let path = format!(r"SOFTWARE\Microsoft\NET Framework Setup\NDP\{framework}");
        match value(HKLM, &path, "Install", 0x100) {
            Ok(Some(installed)) if installed == "1" => c.items.push(Software {
                name: format!(".NET Framework {framework}"),
                version: value(HKLM, &path, "Version", 0x100).ok().flatten(),
                architecture: None,
                location: None,
                source: path,
            }),
            Err(e) => append_error(
                &mut c.error,
                format!(".NET Framework {framework}: Windows {e}"),
            ),
            _ => {}
        }
    }
    for architecture in ["x64", "x86", "arm64"] {
        let path = format!(
            r"SOFTWARE\dotnet\Setup\InstalledVersions\{architecture}\sharedfx\Microsoft.WindowsDesktop.App"
        );
        match value_names(HKLM, &path, 0x100) {
            Ok(versions) => {
                for version in versions {
                    c.items.push(Software {
                        name: ".NET Desktop Runtime".into(),
                        version: Some(version),
                        architecture: Some(architecture.into()),
                        location: None,
                        source: path.clone(),
                    })
                }
            }
            Err(e) => append_error(
                &mut c.error,
                format!(".NET Runtime {architecture}: Windows {e}"),
            ),
        }
    }
    c.items.sort_by(|a, b| {
        (&a.name, &a.version, &a.architecture).cmp(&(&b.name, &b.version, &b.architecture))
    });
    c.items.dedup_by(|a, b| {
        a.name == b.name && a.version == b.version && a.architecture == b.architecture
    });
    c
}
fn append_error(error: &mut Option<String>, text: String) {
    *error = Some(match error.take() {
        Some(e) => format!("{e}; {text}"),
        None => text,
    })
}
fn dependency_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.contains("visual c++") && n.contains("redistributable")
        || n.contains("webview2")
        || n.contains(".net") && n.contains("desktop runtime")
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dependency_detection_does_not_invent_requirements() {
        for name in [
            "Microsoft Visual C++ 2015-2022 Redistributable (x64)",
            "Microsoft Edge WebView2 Runtime",
            "Microsoft .NET Desktop Runtime 8.0.1 (x86)",
        ] {
            assert!(dependency_name(name))
        }
        for name in ["Other App", ".NET SDK", "Microsoft Visual Studio"] {
            assert!(!dependency_name(name))
        }
    }
}
