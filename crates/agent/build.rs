fn main() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    for source in [
        "src/agent",
        "src/control",
        "src/services/printers",
        "src/services/validation",
        "src/types",
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
