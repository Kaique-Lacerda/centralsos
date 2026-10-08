fn main() {
    let attributes =
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "support_status",
            "support_login_start",
            "support_login_poll",
            "support_login_complete",
            "support_session",
            "support_logout",
            "support_control",
        ]));
    #[cfg(windows)]
    let attributes = attributes.windows_attributes(
        tauri_build::WindowsAttributes::new()
            .app_manifest(include_str!("windows-app-manifest.xml")),
    );
    println!("cargo:rerun-if-changed=windows-app-manifest.xml");
    tauri_build::try_build(attributes).expect("Support Tauri build failed");
}
