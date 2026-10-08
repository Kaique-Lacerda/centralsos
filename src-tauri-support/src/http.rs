use reqwest::{blocking::Client, redirect::Policy, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{io::Read, time::Duration};

pub const LIMIT: usize = 2_000_000;
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub code: &'static str,
    pub status: u16,
}
impl Failure {
    pub fn new(code: &'static str, status: u16) -> Self {
        Self { code, status }
    }
}
pub type Result<T> = std::result::Result<T, Failure>;

pub fn origin(value: &str) -> Result<String> {
    let u = Url::parse(value).map_err(|_| Failure::new("BACKEND_NOT_CONFIGURED", 0))?;
    let canonical = u.origin().ascii_serialization();
    if u.scheme() != "https"
        || u.host_str().is_none()
        || !u.username().is_empty()
        || u.password().is_some()
        || u.path() != "/"
        || u.query().is_some()
        || u.fragment().is_some()
        || (value != canonical && value != format!("{canonical}/"))
    {
        return Err(Failure::new("BACKEND_NOT_CONFIGURED", 0));
    }
    Ok(canonical)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    origin: String,
}
pub fn configuration(path: &std::path::Path) -> Result<String> {
    let file = std::fs::File::open(path).map_err(|_| Failure::new("BACKEND_NOT_CONFIGURED", 0))?;
    let text = bounded(file, 4096)?;
    let config: Config =
        serde_json::from_slice(&text).map_err(|_| Failure::new("BACKEND_NOT_CONFIGURED", 0))?;
    origin(&config.origin)
}
pub fn bounded(reader: impl Read, limit: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Failure::new("CONNECTION_FAILED", 0))?;
    if bytes.len() > limit {
        return Err(Failure::new("RESPONSE_TOO_LARGE", 0));
    }
    Ok(bytes)
}
pub trait Http: Send + Sync {
    fn json(&self, path: &str, body: Option<&Value>, bearer: Option<&str>) -> Result<Value>;
}
pub struct NativeHttp {
    origin: String,
    client: Client,
}
pub fn validate_response_destination(status: u16, expected: &str, actual: &str) -> Result<()> {
    if (300..400).contains(&status) || expected != actual {
        Err(Failure::new("REDIRECT_REJECTED", status))
    } else {
        Ok(())
    }
}
pub fn http_failure(status: u16) -> Failure {
    Failure::new(
        match status {
            401 => "SESSION_EXPIRED",
            403 => "UNAUTHORIZED",
            429 => "RATE_LIMITED",
            503 => "BACKEND_UNAVAILABLE",
            _ => "REQUEST_REJECTED",
        },
        status,
    )
}
impl NativeHttp {
    pub fn new(value: &str) -> Result<Self> {
        Ok(Self {
            origin: origin(value)?,
            client: Client::builder()
                .https_only(true)
                .redirect(Policy::none())
                .timeout(Duration::from_secs(12))
                .connect_timeout(Duration::from_secs(5))
                .build()
                .map_err(|_| Failure::new("CONNECTION_FAILED", 0))?,
        })
    }
}
pub fn known_path(path: &str, post: bool) -> bool {
    if matches!(
        (path, post),
        ("/auth/native/start", true)
            | ("/auth/native/status", true)
            | ("/auth/native/complete", true)
            | ("/auth/native/logout", true)
            | ("/auth/native/session", false)
            | ("/environments", false)
            | ("/devices", false)
            | ("/pairing", true)
    ) {
        return true;
    }
    let p: Vec<_> = path.split('/').collect();
    let id = |s: &str| uuid::Uuid::parse_str(s).is_ok() && s.len() == 36;
    matches!(p.as_slice(), ["", "devices", v] if !post && id(v))
        || matches!(p.as_slice(), ["", "devices", v, "commands"] if post && id(v))
        || matches!(p.as_slice(), ["", "commands", v] if !post && id(v))
}
impl Http for NativeHttp {
    fn json(&self, path: &str, body: Option<&Value>, bearer: Option<&str>) -> Result<Value> {
        if !known_path(path, body.is_some()) {
            return Err(Failure::new("INVALID_PATH", 400));
        }
        let url = format!("{}/api/control{path}", self.origin);
        let mut request = if body.is_some() {
            self.client.post(&url)
        } else {
            self.client.get(&url)
        }
        .header("X-Central-Sos-Client", "support-native-v1")
        .header("Accept", "application/json");
        if let Some(token) = bearer {
            request = request.bearer_auth(token);
        }
        if let Some(data) = body {
            request = request.json(data);
        }
        let response = request.send().map_err(|e| {
            Failure::new(
                if e.is_timeout() {
                    "TIMEOUT"
                } else {
                    "CONNECTION_FAILED"
                },
                0,
            )
        })?;
        let status = response.status().as_u16();
        validate_response_destination(status, &url, response.url().as_str())?;
        // Limit while reading, including chunked bodies without Content-Length.
        let bytes = bounded(response, LIMIT)?;
        if !(200..300).contains(&status) {
            return Err(http_failure(status));
        }
        serde_json::from_slice(&bytes).map_err(|_| Failure::new("INVALID_RESPONSE", status))
    }
}
