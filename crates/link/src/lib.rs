pub mod protocol;
pub mod policy;
pub mod vault;
use reqwest::blocking::Client;
use std::io::Read;
use std::time::Duration;
pub const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");
pub fn validate_backend(base: &str) -> Result<String, String> {
    let url = reqwest::Url::parse(base).map_err(|_| "URL HTTPS inválida")?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("Informe a origem HTTPS do Control, sem credencial, caminho ou query.".into());
    }
    Ok(base.trim_end_matches('/').into())
}
pub struct Transport {
    client: Client,
    base: String,
}
#[derive(Debug)]
pub struct HttpFailure { pub status: Option<u16>, pub retry_after: Option<Duration>, message: String }
impl From<String> for HttpFailure { fn from(message: String) -> Self { Self { status: None, retry_after: None, message } } }
impl From<&str> for HttpFailure { fn from(message: &str) -> Self { message.to_owned().into() } }
impl std::fmt::Display for HttpFailure { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{}", self.message) } }
/// A failure keeps metadata, never the Bearer, body or request URL in logs/errors.
pub fn retry_after(value: &str, now: chrono::DateTime<chrono::Utc>) -> Option<Duration> {
    let seconds = value.parse::<u64>().ok().or_else(|| chrono::DateTime::parse_from_rfc2822(value).ok().map(|at| at.signed_duration_since(now).num_seconds().max(0) as u64))?;
    Some(Duration::from_secs(seconds))
}
pub fn retry_delay(base: u64, attempt: u32, error: Option<&HttpFailure>, random: f64) -> Duration {
    let factor = 0.8 + 0.4 * random.clamp(0.0, 1.0);
    let seconds = match error {
        None => base as f64 * (0.9 + 0.2 * random.clamp(0.0, 1.0)),
        Some(e) if matches!(e.status, Some(401 | 403)) => 300.0 * (1.0 + 0.2 * random.clamp(0.0, 1.0)),
        Some(_) => ((5u64.saturating_mul(2u64.pow(attempt.min(4)))).min(60) as f64 * factor).min(60.0),
    };
    Duration::from_secs_f64(seconds).max(error.and_then(|e| e.retry_after).unwrap_or_default())
}
pub fn jitter() -> f64 { (uuid::Uuid::new_v4().as_u128() & 0xffff) as f64 / 65535.0 }
/// Use the server's RUNNING timestamp, subtracting the entire ACK roundtrip conservatively.
/// A client's wall-clock offset cannot extend the approved execution window.
pub fn remaining_validity(expires: &str, approved_at: &str, elapsed: Duration) -> Result<Duration, String> {
    let end=chrono::DateTime::parse_from_rfc3339(expires).map_err(|_| "Expiração inválida")?;
    let start=chrono::DateTime::parse_from_rfc3339(approved_at).map_err(|_| "ACK sem horário válido do servidor")?;
    let available=end.signed_duration_since(start);
    if available.num_milliseconds() > 300_000 { return Err("Janela do ACK inválida".into()); }
    Ok(available.to_std().unwrap_or_default().saturating_sub(elapsed))
}
impl Transport {
    pub fn new(base: &str) -> Result<Self, String> {
        Ok(Self {
            base: validate_backend(base)?,
            client: Client::builder()
                .timeout(Duration::from_secs(12))
                .connect_timeout(Duration::from_secs(5))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|e| e.to_string())?,
        })
    }
    pub fn request<T: serde::de::DeserializeOwned>(
        &self,
        method: reqwest::Method,
        path: &str,
        credential: Option<&str>,
        data: Option<&serde_json::Value>,
    ) -> Result<T, String> {
        self.request_detailed(method, path, credential, data).map_err(|e| e.to_string())
    }
    pub fn request_detailed<T: serde::de::DeserializeOwned>(
        &self, method: reqwest::Method, path: &str, credential: Option<&str>, data: Option<&serde_json::Value>,
    ) -> Result<T, HttpFailure> {
        if !path.starts_with("/api/agent/") || path.contains("..") || path.contains('?') || path.contains('#') { return Err("Endpoint não permitido".to_string().into()); }
        let mut r = self.client.request(method, format!("{}{path}", self.base));
        if let Some(c) = credential {
            r = r.bearer_auth(c);
        }
        if let Some(d) = data {
            r = r.json(d);
        }
        let response = r
            .send()
            .map_err(|_| "Backend indisponível ou timeout; será tentado novamente.".to_string())?;
        if !response.status().is_success() {
            return Err(HttpFailure { status: Some(response.status().as_u16()), retry_after: response.headers().get(reqwest::header::RETRY_AFTER).and_then(|v| v.to_str().ok()).and_then(|v| retry_after(v, chrono::Utc::now())), message: format!("Control respondeu HTTP {}.", response.status().as_u16()) });
        }
        let mut bytes = Vec::new();
        response
            .take(2_000_001)
            .read_to_end(&mut bytes)
            .map_err(|_| "Resposta indisponível".to_string())?;
        if bytes.len() > 2_000_000 {
            return Err("Resposta excedeu o limite.".into());
        }
        serde_json::from_slice(&bytes).map_err(|_| HttpFailure::from("Contrato de resposta inválido."))
    }
}
pub fn status() -> Result<serde_json::Value, String> {
    let Some(link) = vault::load()? else {
        return Ok(serde_json::json!({"linked":false,"connected":false}));
    };
    let recorded = vault::read_status().unwrap_or_default();
    let last = if recorded.device_id.as_deref() == Some(&link.enrollment.device_id) {
        recorded
    } else {
        protocol::CommunicationStatus::default()
    };
    Ok(
        serde_json::json!({"linked":true,"deviceId":link.enrollment.device_id,"environment":link.enrollment.environment_name,"profile":link.enrollment.profile,"serverDeviceId":link.enrollment.server_device_id,"serverName":link.enrollment.server_name,"agentVersion":last.agent_version,"coreVersion":last.core_version,"protocolVersion":last.protocol_version,"lastCommunication":last.last_communication,"connected":last.device_id.as_deref()==Some(&link.enrollment.device_id)&&last.last_communication.as_ref().and_then(|t|chrono::DateTime::parse_from_rfc3339(t).ok()).is_some_and(|t|(0..90).contains(&chrono::Utc::now().signed_duration_since(t).num_seconds())),"serviceInstalled":vault::service_installed()}),
    )
}
pub fn status_for_app(version: &str) -> Result<serde_json::Value, String> {
    if let Some(mut link) = vault::load()? {
        if link.app_version != version {
            link.app_version = version.into();
            vault::save(&link)?;
        }
    }
    status()
}
pub fn unlink(confirmed: bool) -> Result<(), String> {
    if !confirmed {
        return Err("Confirme a desvinculação.".into());
    }
    let link = vault::load()?.ok_or("Dispositivo não vinculado")?;
    let _: serde_json::Value = Transport::new(&link.backend)?.request(
        reqwest::Method::POST,
        "/api/agent/revoke",
        Some(&link.enrollment.credential),
        Some(&serde_json::json!({})),
    )?;
    vault::remove()
}
pub fn backoff(attempt: u32) -> Duration {
    Duration::from_secs((5u64.saturating_mul(2u64.pow(attempt.min(4)))).min(60))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn https_only() {
        assert!(validate_backend("https://control.example.test").is_ok());
        for u in [
            "http://control.test",
            "https://u:p@control.test",
            "https://control.test/x",
            "https://control.test?q=1",
        ] {
            assert!(validate_backend(u).is_err());
        }
    }
    #[test]
    fn retry_is_bounded() {
        assert_eq!(backoff(0).as_secs(), 5);
        assert_eq!(backoff(99).as_secs(), 60);
        let error = HttpFailure::from("network");
        assert!(retry_delay(7, 0, Some(&error), 0.0) < retry_delay(7, 0, Some(&error), 1.0));
        assert!(retry_delay(7, 99, Some(&error), 1.0) <= Duration::from_secs(60));
        assert!(retry_delay(7, 0, None, 0.0) >= Duration::from_secs(6));
        assert!(retry_delay(7, 0, None, 1.0) <= Duration::from_secs(8));
        let denied = HttpFailure { status: Some(401), retry_after: None, message: "denied".into() };
        assert!(retry_delay(7, 0, Some(&denied), 0.0) >= Duration::from_secs(300));
        let forbidden = HttpFailure { status: Some(403), ..denied };
        assert!(retry_delay(30, 0, Some(&forbidden), 0.0) >= Duration::from_secs(300));
        let limited = HttpFailure { status: Some(429), retry_after: Some(Duration::from_secs(120)), message: "limited".into() };
        assert_eq!(retry_delay(7, 0, Some(&limited), 0.0), Duration::from_secs(120));
        assert_eq!(retry_after("120", chrono::Utc::now()), Some(Duration::from_secs(120)));
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-06T12:00:00Z").unwrap().with_timezone(&chrono::Utc);
        assert_eq!(retry_after("Tue, 06 Oct 2026 12:02:00 GMT", now), Some(Duration::from_secs(120)));
        assert!(retry_after("invalid", now).is_none());
        assert_eq!(remaining_validity("2026-10-06T12:00:30Z", "2026-10-06T12:00:00Z", Duration::from_secs(5)).unwrap(),Duration::from_secs(25));
        assert_eq!(remaining_validity("2026-10-06T12:00:30Z", "2026-10-06T12:00:00Z", Duration::from_secs(31)).unwrap(),Duration::ZERO);
        assert!(remaining_validity("2026-10-06T12:30:00Z", "2026-10-06T12:00:00Z", Duration::ZERO).is_err());
    }
}
