pub fn event(name: &str, fields: serde_json::Value) {
    use std::io::Write;
    let entry = serde_json::json!({"timestamp":chrono::Utc::now().to_rfc3339(),"event":name,"fields":fields});
    if let Ok(root) = central_sos_link::vault::secure_root() {
        let path = root.join("agent.log");
        if std::fs::metadata(&path).is_ok_and(|m| m.len() > 5 * 1024 * 1024) {
            let previous = root.join("agent.previous.log");
            if previous.exists() {
                let _ = std::fs::remove_file(&previous);
            }
            let _ = std::fs::rename(&path, &previous);
        }
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(f, "{entry}");
        }
    }
}
