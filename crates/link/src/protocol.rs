use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum Profile {
    TERMINAL,
    SERVER,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Enrollment {
    pub protocol_version: u16,
    pub company_id: String,
    pub device_id: String,
    pub credential: String,
    pub environment_id: String,
    pub environment_name: String,
    pub profile: Profile,
    pub server_device_id: Option<String>,
    pub server_name: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Link {
    pub backend: String,
    pub enrollment: Enrollment,
    pub app_version: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Command {
    pub protocol_version: u16,
    pub id: String,
    pub device_id: String,
    pub r#type: String,
    pub payload: serde_json::Value,
    pub confirmed: bool,
    pub requested_by: String,
    pub created_at: String,
    pub expires_at: String,
    pub status: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommandResult {
    pub protocol_version: u16,
    pub command_id: String,
    pub success: bool,
    pub status: String,
    pub summary: String,
    pub details: serde_json::Value,
    pub started_at: String,
    pub finished_at: String,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunicationStatus {
    pub agent_version: Option<String>,
    pub core_version: Option<String>,
    pub protocol_version: Option<u16>,
    pub last_communication: Option<String>,
    pub device_id: Option<String>,
}
impl Command {
    pub fn validate(
        &self,
        device_id: &str,
        now: chrono::DateTime<chrono::Utc>,
    ) -> Result<(), String> {
        if self.protocol_version != crate::policy::PROTOCOL_VERSION { return Err("PROTOCOL_INCOMPATIBLE".into()); }
        let policy = crate::policy::command_policy(&self.r#type).ok_or("REJECTED: comando não suportado")?;
        uuid::Uuid::parse_str(&self.id).map_err(|_| "ID inválido")?;
        if self.device_id != device_id {
            return Err("Dispositivo divergente".into());
        }
        if !["PENDING", "RECEIVED", "RUNNING"].contains(&self.status.as_str()) {
            return Err("Estado não executável".into());
        }
        let expires = chrono::DateTime::parse_from_rfc3339(&self.expires_at)
            .map_err(|_| "Expiração inválida")?;
        let created = chrono::DateTime::parse_from_rfc3339(&self.created_at)
            .map_err(|_| "Criação inválida")?;
        if expires <= now {
            return Err("EXPIRED".into());
        }
        if expires.signed_duration_since(created).num_seconds() > 300
            || expires <= created
            || created > now + chrono::Duration::seconds(60)
        {
            return Err("Janela de comando inválida".into());
        }
        let payload = self
            .payload
            .as_object()
            .ok_or("Payload precisa ser objeto")?;
        let keys: &[&str] = match self.r#type.as_str() {
            "machine.refresh" | "machine.validate" | "spooler.restart" => &[],
            "printer.check" | "printer.auto_fix" => &["printerName"],
            "service.check" => &["name"],
            _ => return Err("REJECTED: comando não suportado".into()),
        };
        if payload.keys().any(|k| !keys.contains(&k.as_str())) {
            return Err("Payload contém campos não permitidos".into());
        }
        if self.r#type == "printer.auto_fix" && !payload.contains_key("printerName") {
            return Err("Selecione uma impressora".into());
        }
        for (key, value) in payload {
            let text = value.as_str().ok_or("Parâmetro precisa ser texto")?;
            let maximum = if key == "name" { 256 } else { 220 };
            if text.trim().is_empty()
                || text.encode_utf16().count() > maximum
                || text.chars().any(char::is_control)
            {
                return Err("Parâmetro inválido".into());
            }
            if key == "name"
                && !text
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-. ".contains(&b))
            {
                return Err("Nome interno de serviço inválido".into());
            }
        }
        if policy.requires_confirmation && !self.confirmed
        {
            return Err("Confirmação obrigatória".into());
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn whitelist_and_expiration() {
        let now = chrono::Utc::now();
        let mut c = Command {
            protocol_version: crate::policy::PROTOCOL_VERSION,
            id: uuid::Uuid::new_v4().to_string(),
            device_id: "d".into(),
            r#type: "machine.refresh".into(),
            payload: serde_json::json!({}),
            confirmed: false,
            requested_by: "tech".into(),
            created_at: now.to_rfc3339(),
            expires_at: (now + chrono::Duration::seconds(60)).to_rfc3339(),
            status: "PENDING".into(),
            started_at: None,
            finished_at: None,
        };
        assert!(c.validate("d", now).is_ok());
        c.protocol_version = 2;
        assert_eq!(c.validate("d", now).unwrap_err(), "PROTOCOL_INCOMPATIBLE");
        c.protocol_version = 1;
        assert!(c.validate("other-device", now).is_err());
        c.r#type = "execute_shell".into();
        assert!(c.validate("d", now).is_err());
        c.r#type = "machine.refresh".into();
        c.expires_at = (now - chrono::Duration::seconds(1)).to_rfc3339();
        assert_eq!(c.validate("d", now).unwrap_err(), "EXPIRED");
    }
}
