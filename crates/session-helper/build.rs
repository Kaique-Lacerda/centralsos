fn main() {
    println!("cargo:rerun-if-changed=app.manifest");
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        let manifest = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
            .join("app.manifest");
        // Only the Helper executable; do not elevate tests or dependent binaries.
        println!("cargo:rustc-link-arg-bin=central-sos-session-helper=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-bin=central-sos-session-helper=/MANIFESTINPUT:{}",
            manifest.display()
        );
    }
}
