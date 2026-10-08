use crate::http::{Failure, Result};
use serde::Deserialize;
use serde_json::{json, Value};

// This dispatcher has no URL/header/token/path fields. Control's shared policy remains authoritative.
#[derive(Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ControlRequest {
    Environments {},
    Devices {},
    Device {
        id: uuid::Uuid,
    },
    Command {
        id: uuid::Uuid,
    },
    Send {
        id: uuid::Uuid,
        command: Value,
    },
    Pair {
        environment_id: uuid::Uuid,
        profile: Profile,
        server_device_id: Option<uuid::Uuid>,
    },
}
#[derive(Deserialize, serde::Serialize)]
pub enum Profile {
    TERMINAL,
    SERVER,
}
pub fn validate_command(command: &Value) -> Result<()> {
    let bad = || Failure::new("INVALID_REQUEST", 400);
    let obj = command.as_object().ok_or_else(bad)?;
    if obj.len() != 3 {
        return Err(bad());
    }
    let kind = obj.get("type").and_then(Value::as_str).ok_or_else(bad)?;
    let policies: Value = serde_json::from_str(include_str!(
        "../../packages/contracts/control/command-policy.json"
    ))
    .expect("compiled policy");
    let policy = policies.get(kind).ok_or_else(bad)?;
    if policy["riskLevel"] == "LOCAL_ONLY" || policy["executionContext"] == "UNSUPPORTED_REMOTE" {
        return Err(Failure::new("COMMAND_BLOCKED", 403));
    }
    let confirmed = obj
        .get("confirmed")
        .and_then(Value::as_bool)
        .ok_or_else(bad)?;
    if policy["requiresConfirmation"] == true && !confirmed {
        return Err(Failure::new("CONFIRMATION_REQUIRED", 400));
    }
    let payload = obj
        .get("payload")
        .and_then(Value::as_object)
        .ok_or_else(bad)?;
    let key = match kind {
        "printer.check" | "printer.auto_fix" => Some("printerName"),
        "service.check" => Some("name"),
        _ => None,
    };
    if payload.len() > 1 || payload.keys().any(|k| Some(k.as_str()) != key) {
        return Err(bad());
    }
    if kind == "printer.auto_fix" && !payload.contains_key("printerName") {
        return Err(bad());
    }
    if let Some(key) = key {
        if let Some(value) = payload.get(key) {
            let s = value.as_str().ok_or_else(bad)?;
            let max = if key == "printerName" { 220 } else { 256 };
            if s.trim().is_empty()
                || s.chars().count() > max
                || s.chars().any(char::is_control)
                || key == "name"
                    && !s
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || "_. -".contains(c))
            {
                return Err(bad());
            }
        }
    }
    Ok(())
}
impl ControlRequest {
    pub fn wire(self) -> Result<(String, Option<Value>)> {
        Ok(match self {
            Self::Environments {} => ("/environments".into(), None),
            Self::Devices {} => ("/devices".into(), None),
            Self::Device { id } => (format!("/devices/{id}"), None),
            Self::Command { id } => (format!("/commands/{id}"), None),
            Self::Send { id, command } => {
                validate_command(&command)?;
                (format!("/devices/{id}/commands"), Some(command))
            }
            Self::Pair {
                environment_id,
                profile,
                server_device_id,
            } => {
                if matches!(profile, Profile::SERVER) && server_device_id.is_some() {
                    return Err(Failure::new("INVALID_REQUEST", 400));
                }
                (
                    "/pairing".into(),
                    Some(
                        json!({ "environmentId": environment_id, "profile": profile, "serverDeviceId": server_device_id }),
                    ),
                )
            }
        })
    }
}
// Reject credential-bearing fields even inside untrusted result details; never return HTTP auth bodies.
pub fn safe_response(value: &Value) -> bool {
    match value {
        Value::Object(o) => o.iter().all(|(key, v)| {
            !matches!(
                key.to_ascii_lowercase().replace(['_', '-'], "").as_str(),
                "accesstoken"
                    | "devicecode"
                    | "codeverifier"
                    | "authorization"
                    | "cookie"
                    | "clientsecret"
                    | "credential"
                    | "credentialhash"
                    | "token"
                    | "password"
                    | "secret"
                    | "privatekey"
            ) && safe_response(v)
        }),
        Value::Array(a) => a.iter().all(safe_response),
        _ => true,
    }
}
