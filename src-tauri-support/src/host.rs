use crate::{
    control::{safe_response, ControlRequest},
    http::{Failure, Http, Result},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Utc};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AuthView {
    pub state: String,
    pub operator_name: Option<String>,
    pub expires_at: Option<String>,
    pub comparison_code: Option<String>,
    pub backend_origin: Option<String>,
    pub message: Option<String>,
    pub interval_seconds: u64,
    pub revocation_pending: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Start {
    protocol_version: u8,
    transaction_id: uuid::Uuid,
    device_code: String,
    user_code: String,
    authorization_url: String,
    expires_at: DateTime<Utc>,
    interval_seconds: u64,
}
#[derive(Deserialize)]
#[serde(tag = "state", rename_all = "camelCase", deny_unknown_fields)]
enum Poll {
    Pending {
        #[serde(rename = "intervalSeconds")]
        interval: u64,
    },
    Approved {
        operator: Operator,
        #[serde(rename = "intervalSeconds")]
        interval: u64,
    },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Operator {
    subject: String,
    name: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Credential {
    access_token: String,
    token_type: String,
    scope: String,
    expires_at: DateTime<Utc>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Session {
    subject: String,
    name: String,
    memberships: Vec<Membership>,
    expires_at: DateTime<Utc>,
    scope: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Membership {
    company_id: uuid::Uuid,
    role: Role,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Role {
    Viewer,
    Operator,
    Admin,
}
struct Pending {
    transaction: uuid::Uuid,
    device: Zeroizing<String>,
    verifier: Zeroizing<String>,
    subject: Option<String>,
    expiry: DateTime<Utc>,
    next_poll: Instant,
}
struct Stored {
    token: Zeroizing<String>,
    expiry: DateTime<Utc>,
    subject: String,
}
struct State {
    view: AuthView,
    pending: Option<Pending>,
    credential: Option<Stored>,
    epoch: u64,
    busy: bool,
}
pub struct Host {
    http: Option<Arc<dyn Http>>,
    state: Mutex<State>,
}
pub fn proof() -> (Zeroizing<String>, String) {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let verifier = Zeroizing::new(URL_SAFE_NO_PAD.encode(bytes));
    (
        verifier.clone(),
        URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())),
    )
}
pub fn authorization_url(origin: &str, value: &str, code: &str) -> Result<()> {
    if code.len() != 14
        || !code.split('-').all(|s| {
            s.len() == 4
                && s.bytes()
                    .all(|c| c.is_ascii_digit() || (b'A'..=b'F').contains(&c))
        })
        || value != format!("{origin}/api/control/auth/native/authorize?user_code={code}")
    {
        return Err(Failure::new("INVALID_RESPONSE", 0));
    }
    Ok(())
}
fn decode<T: serde::de::DeserializeOwned>(v: Value) -> Result<T> {
    serde_json::from_value(v).map_err(|_| Failure::new("INVALID_RESPONSE", 0))
}
fn interval(n: u64) -> Result<u64> {
    if (5..=60).contains(&n) {
        Ok(n)
    } else {
        Err(Failure::new("INVALID_RESPONSE", 0))
    }
}
fn safe_name(name: &str) -> bool {
    !name.trim().is_empty() && name.chars().count() <= 256 && !name.chars().any(char::is_control)
}
impl Host {
    pub fn new(origin: Option<String>, http: Option<Arc<dyn Http>>) -> Self {
        Self {
            http,
            state: Mutex::new(State {
                view: AuthView {
                    state: if origin.is_some() {
                        "signed_out"
                    } else {
                        "unconfigured"
                    }
                    .into(),
                    operator_name: None,
                    expires_at: None,
                    comparison_code: None,
                    backend_origin: origin,
                    message: None,
                    interval_seconds: 5,
                    revocation_pending: false,
                },
                pending: None,
                credential: None,
                epoch: 0,
                busy: false,
            }),
        }
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }
    fn expire(s: &mut State) {
        if s.credential
            .as_ref()
            .is_some_and(|c| c.expiry <= Utc::now())
        {
            Self::clear(s, "session_expired");
        } else if s.pending.as_ref().is_some_and(|p| p.expiry <= Utc::now()) {
            Self::clear(s, "login_expired");
        }
    }
    fn clear(s: &mut State, state: &str) {
        s.epoch += 1;
        s.busy = false;
        s.pending = None;
        s.credential = None;
        s.view.state = state.into();
        s.view.operator_name = None;
        s.view.expires_at = None;
        s.view.comparison_code = None;
    }
    pub fn status(&self) -> AuthView {
        let mut s = self.lock();
        Self::expire(&mut s);
        s.view.clone()
    }
    fn http(&self) -> Result<&dyn Http> {
        self.http
            .as_deref()
            .ok_or(Failure::new("BACKEND_NOT_CONFIGURED", 0))
    }
    fn failure(&self, epoch: u64, error: &Failure) {
        let mut s = self.lock();
        if s.epoch != epoch {
            return;
        }
        s.busy = false;
        if error.status == 401 {
            Self::clear(&mut s, "session_expired");
        } else if error.status == 403 {
            Self::clear(&mut s, "unauthorized");
        } else if s.pending.is_none() && s.credential.is_none() {
            s.view.state = "unavailable".into();
        }
        s.view.message = Some(error.code.into());
    }
    pub fn start(&self, open: impl FnOnce(&str) -> Result<()>) -> Result<AuthView> {
        let (epoch, origin) = {
            let mut s = self.lock();
            if s.busy || s.pending.is_some() || s.credential.is_some() {
                return Err(Failure::new("AUTH_BUSY", 409));
            }
            let origin = s
                .view
                .backend_origin
                .clone()
                .ok_or(Failure::new("BACKEND_NOT_CONFIGURED", 0))?;
            Self::clear(&mut s, "starting");
            s.busy = true;
            s.view.message = None;
            (s.epoch, origin)
        };
        let result = (|| {
            let (verifier, challenge) = proof();
            let start: Start = decode(self.http()?.json("/auth/native/start", Some(&json!({"protocolVersion":1,"codeChallenge":challenge,"codeChallengeMethod":"S256"})), None)?)?;
            let duration = start.expires_at - Utc::now();
            if start.protocol_version != 1
                || duration.num_seconds() <= 0
                || duration.num_seconds() > 305
                || start.device_code.len() != 43
                || !start
                    .device_code
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            {
                return Err(Failure::new("INVALID_RESPONSE", 0));
            }
            let seconds = interval(start.interval_seconds)?;
            authorization_url(&origin, &start.authorization_url, &start.user_code)?;
            if self.lock().epoch != epoch {
                return Err(Failure::new("SESSION_CHANGED", 409));
            }
            // Never open a URL supplied by React, or a redirect/callback outside the configured origin.
            open(&start.authorization_url)?;
            let mut s = self.lock();
            if s.epoch != epoch {
                return Err(Failure::new("SESSION_CHANGED", 409));
            }
            s.busy = false;
            s.view.state = "awaiting_browser".into();
            s.view.comparison_code = Some(start.user_code);
            s.view.expires_at = Some(start.expires_at.to_rfc3339());
            s.view.interval_seconds = seconds;
            s.pending = Some(Pending {
                transaction: start.transaction_id,
                device: Zeroizing::new(start.device_code),
                verifier,
                subject: None,
                expiry: start.expires_at,
                next_poll: Instant::now() + Duration::from_secs(seconds),
            });
            Ok(s.view.clone())
        })();
        if let Err(ref e) = result {
            self.failure(epoch, e);
        }
        result
    }
    pub fn poll(&self) -> Result<AuthView> {
        let (epoch, body) = {
            let mut s = self.lock();
            Self::expire(&mut s);
            if s.busy {
                return Ok(s.view.clone());
            }
            let seconds = s.view.interval_seconds;
            let p = match s.pending.as_mut() {
                Some(p) if p.subject.is_none() && Instant::now() >= p.next_poll => p,
                _ => return Ok(s.view.clone()),
            };
            p.next_poll = Instant::now() + Duration::from_secs(seconds);
            let body = json!({"transactionId":p.transaction,"deviceCode":p.device.as_str(),"codeVerifier":p.verifier.as_str()});
            s.busy = true;
            (s.epoch, body)
        };
        let result = (|| {
            let response: Poll = decode(self.http()?.json(
                "/auth/native/status",
                Some(&body),
                None,
            )?)?;
            let mut s = self.lock();
            if s.epoch != epoch {
                return Err(Failure::new("SESSION_CHANGED", 409));
            }
            s.busy = false;
            let seconds = interval(match &response {
                Poll::Pending { interval } | Poll::Approved { interval, .. } => *interval,
            })?;
            s.view.interval_seconds = seconds;
            if let Some(p) = s.pending.as_mut() {
                p.next_poll = Instant::now() + Duration::from_secs(seconds);
            }
            if let Poll::Approved { operator, .. } = response {
                if !safe_name(&operator.name) || !safe_name(&operator.subject) {
                    return Err(Failure::new("INVALID_RESPONSE", 0));
                }
                s.pending
                    .as_mut()
                    .ok_or(Failure::new("INVALID_TRANSACTION", 400))?
                    .subject = Some(operator.subject);
                s.view.operator_name = Some(operator.name);
                s.view.state = "awaiting_identity".into();
            }
            s.view.message = None;
            Ok(s.view.clone())
        })();
        if let Err(ref e) = result {
            self.failure(epoch, e);
        }
        result
    }
    pub fn complete(&self, confirmed: bool) -> Result<AuthView> {
        let (epoch, p) = {
            let mut s = self.lock();
            Self::expire(&mut s);
            if !confirmed {
                return Err(Failure::new("CONFIRMATION_REQUIRED", 400));
            }
            if s.busy
                || s.pending
                    .as_ref()
                    .and_then(|p| p.subject.as_ref())
                    .is_none()
            {
                return Err(Failure::new("INVALID_TRANSACTION", 400));
            }
            // Take once BEFORE sending. A lost response requires a new login, never a second redeem.
            let p = s.pending.take().unwrap();
            s.busy = true;
            (s.epoch, p)
        };
        let result = (|| {
            let credential: Credential = decode(self.http()?.json("/auth/native/complete", Some(&json!({"transactionId":p.transaction,"deviceCode":p.device.as_str(),"codeVerifier":p.verifier.as_str(),"expectedSubject":p.subject})), None)?)?;
            let token = Zeroizing::new(credential.access_token);
            let suffix = token
                .strip_prefix("sos_operator_")
                .ok_or(Failure::new("INVALID_RESPONSE", 0))?;
            if credential.token_type != "Bearer"
                || credential.scope != "control"
                || suffix.len() != 43
                || !suffix
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                || credential.expires_at <= Utc::now()
                || (credential.expires_at - Utc::now()).num_seconds() > 28805
            {
                return Err(Failure::new("INVALID_RESPONSE", 0));
            }
            let checked = self.session_with(&token).and_then(|session| {
                if Some(session.subject.as_str()) != p.subject.as_deref()
                    || session.expires_at != credential.expires_at
                {
                    Err(Failure::new("IDENTITY_MISMATCH", 400))
                } else {
                    Ok(session)
                }
            });
            let session = match checked {
                Ok(session) => session,
                Err(error) => {
                    let failed = self
                        .http()?
                        .json("/auth/native/logout", Some(&json!({})), Some(&token))
                        .is_err();
                    if failed {
                        self.lock().view.revocation_pending = true;
                    }
                    return Err(error);
                }
            };
            let mut s = self.lock();
            if s.epoch != epoch {
                drop(s);
                let failed = self
                    .http()?
                    .json("/auth/native/logout", Some(&json!({})), Some(&token))
                    .is_err();
                if failed {
                    self.lock().view.revocation_pending = true;
                }
                return Err(Failure::new("SESSION_CHANGED", 409));
            }
            s.busy = false;
            s.credential = Some(Stored {
                token,
                expiry: session.expires_at,
                subject: session.subject,
            });
            s.view.state = "authenticated".into();
            s.view.operator_name = Some(session.name);
            s.view.expires_at = Some(session.expires_at.to_rfc3339());
            s.view.comparison_code = None;
            s.view.message = None;
            Ok(s.view.clone())
        })();
        if let Err(ref e) = result {
            self.failure(epoch, e);
        }
        result
    }
    fn session_with(&self, token: &str) -> Result<Session> {
        let session: Session = decode(self.http()?.json(
            "/auth/native/session",
            None,
            Some(token),
        )?)?;
        if session.scope != "control"
            || session.expires_at <= Utc::now()
            || !safe_name(&session.name)
            || !safe_name(&session.subject)
        {
            return Err(Failure::new("INVALID_RESPONSE", 0));
        }
        // Deserialize all memberships (including role), but they are never returned as auth credentials.
        for m in &session.memberships {
            let _ = (m.company_id, &m.role);
        }
        Ok(session)
    }
    fn credential(&self) -> Result<(u64, Zeroizing<String>)> {
        let mut s = self.lock();
        Self::expire(&mut s);
        Ok((
            s.epoch,
            s.credential
                .as_ref()
                .ok_or(Failure::new("SESSION_EXPIRED", 401))?
                .token
                .clone(),
        ))
    }
    pub fn session(&self) -> Result<AuthView> {
        let (epoch, token) = self.credential()?;
        let result = (|| {
            let session = self.session_with(&token)?;
            let mut s = self.lock();
            if s.epoch != epoch {
                return Err(Failure::new("SESSION_CHANGED", 409));
            }
            Self::expire(&mut s);
            if s.epoch != epoch {
                return Err(Failure::new("SESSION_EXPIRED", 401));
            }
            if s.credential
                .as_ref()
                .is_none_or(|c| c.subject != session.subject || c.expiry != session.expires_at)
            {
                Self::clear(&mut s, "session_expired");
                return Err(Failure::new("IDENTITY_MISMATCH", 400));
            }
            s.view.operator_name = Some(session.name);
            s.view.expires_at = Some(session.expires_at.to_rfc3339());
            if let Some(c) = s.credential.as_mut() {
                c.expiry = session.expires_at;
            }
            s.view.message = None;
            Ok(s.view.clone())
        })();
        if let Err(ref e) = result {
            self.failure(epoch, e);
        }
        result
    }
    pub fn logout(&self) -> AuthView {
        let (epoch, token) = {
            let mut s = self.lock();
            let token = s.credential.take().map(|c| c.token);
            let next = if s.view.backend_origin.is_some() {
                "signed_out"
            } else {
                "unconfigured"
            };
            Self::clear(&mut s, next);
            s.view.revocation_pending = false;
            s.view.message = None;
            (s.epoch, token)
        };
        // No mutex is held during HTTP; all other IPC calls already see a cleared credential.
        let failed = token.is_some_and(|token| {
            self.http()
                .and_then(|h| h.json("/auth/native/logout", Some(&json!({})), Some(&token)))
                .is_err()
        });
        let mut s = self.lock();
        if s.epoch == epoch {
            s.view.revocation_pending = failed;
        }
        s.view.clone()
    }
    pub fn control(&self, request: ControlRequest) -> Result<Value> {
        let (path, body) = request.wire()?;
        let (epoch, token) = self.credential()?;
        let result = self
            .http()?
            .json(&path, body.as_ref(), Some(&token))
            .and_then(|v| {
                let mut s = self.lock();
                Self::expire(&mut s);
                if s.epoch != epoch {
                    return Err(Failure::new("SESSION_CHANGED", 409));
                }
                drop(s);
                if !safe_response(&v)
                    || serde_json::to_string(&v).map_or(true, |s| s.contains(token.as_str()))
                {
                    return Err(Failure::new("INVALID_RESPONSE", 0));
                }
                Ok(v)
            });
        if let Err(ref e) = result {
            self.failure(epoch, e);
        }
        result
    }
}

#[cfg(test)]
mod tests;
