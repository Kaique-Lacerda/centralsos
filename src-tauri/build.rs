fn main() {
    let attributes = tauri_build::Attributes::new();
    #[cfg(windows)]
    let attributes = {
        println!("cargo:rerun-if-changed=windows-app-manifest.xml");
        attributes.windows_attributes(
            tauri_build::WindowsAttributes::new()
                .app_manifest(include_str!("windows-app-manifest.xml")),
        )
    };
    tauri_build::try_build(attributes).expect("failed to run Tauri build script");
}
