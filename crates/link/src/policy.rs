use serde::Deserialize;
use std::{collections::BTreeMap, sync::OnceLock};
pub const PROTOCOL_VERSION: u16 = 1;
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandPolicy {
    pub execution_context: String,
    pub risk_level: String,
    pub requires_interactive_user: bool,
    pub requires_confirmation: bool,
    pub timeout: u64,
    pub idempotent: bool,
    pub allowed_device_profiles: Vec<String>,
    pub audit_category: String,
    pub native_operations: Vec<String>,
}
pub fn command_policy(name: &str) -> Option<&'static CommandPolicy> {
    static MATRIX: OnceLock<BTreeMap<String, CommandPolicy>> = OnceLock::new();
    MATRIX.get_or_init(|| serde_json::from_str(include_str!("../../../src/control/command-policy.json")).expect("invalid build-time command matrix")).get(name)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matrix_is_the_native_whitelist() {
        assert!(command_policy("execute_shell").is_none());
        let p = command_policy("printer.auto_fix").unwrap();
        assert!(p.requires_interactive_user && p.requires_confirmation && !p.idempotent);
        assert_eq!(p.execution_context, "USER_SESSION_REQUIRED");
        assert!(!p.native_operations.iter().any(|v| v == "shell" || v == "setPermissions"));
    }
}
