fn main() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    println!("cargo:rerun-if-changed=app.manifest");
    println!(
        "cargo:rerun-if-changed={}",
        root.join("package.json").display()
    );
    let package: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(root.join("package.json")).unwrap()).unwrap();
    println!(
        "cargo:rustc-env=CENTRAL_SOS_CLIENT_VERSION={}",
        package["version"].as_str().unwrap()
    );
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rustc-link-arg-bin=central-sos-agent=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-bin=central-sos-agent=/MANIFESTINPUT:{}",
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("app.manifest")
                .display()
        );
    }
    for source in [
        "packages/contracts",
        "packages/agent-rules",
        "scripts/build-agent-rules.mjs",
    ] {
        println!("cargo:rerun-if-changed={}", root.join(source).display());
    }
    let output = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("rules.js");
    let status = std::process::Command::new("node")
        .arg(root.join("scripts/build-agent-rules.mjs"))
        .env("CENTRAL_SOS_RULES_OUTPUT", output)
        .current_dir(root)
        .status()
        .expect("Node/esbuild são necessários apenas no build do Agent");
    assert!(
        status.success(),
        "Falha ao compilar regras compartilhadas do Agent"
    );
}
