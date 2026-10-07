//! Independent, bounded local IPC protocol. No remote path/script or mutator exists here.
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[cfg(windows)]
pub mod windows;
pub const SESSION_PROTOCOL_VERSION: u16 = 1;
pub const MAX_MESSAGE_BYTES: usize = 262_144;
pub const MAX_VALIDITY_MS: i64 = 30_000;
pub const PIPE_TIMEOUT_MS: u32 = 5_000;
pub const MAX_PROCESSES: usize = 512;
pub const MAX_PRINTERS: usize = 128;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    SessionRequired,
    SessionLocked,
    SessionDisconnected,
    SessionAmbiguous,
    SessionStateUnknown,
    SessionHelperUnavailable,
    SessionProtocolMismatch,
    SessionPeerRejected,
    SessionInvalidRequest,
    SessionExpired,
    SessionMessageTooLarge,
    SessionTimeout,
    SessionReplay,
    SessionCollectionFailed,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SessionError {
    pub code: ErrorCode,
    pub message: String,
}
impl SessionError {
    pub fn new(code: ErrorCode, message: &str) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
impl std::fmt::Display for SessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}
impl std::error::Error for SessionError {}
pub type Result<T> = std::result::Result<T, SessionError>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Identity {
    pub session_id: u32,
    pub user_sid: String,
    pub logon_sid: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct EmptyPayload {}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "operation", content = "payload")]
pub enum Operation {
    #[serde(rename = "session.info")]
    Info(EmptyPayload),
    #[serde(rename = "session.processes")]
    Processes(EmptyPayload),
    #[serde(rename = "session.printers")]
    Printers(EmptyPayload),
}
impl Operation {
    pub fn from_name(name: &str) -> Result<Self> {
        match name {
            "session.info" => Ok(Self::Info(EmptyPayload {})),
            "session.processes" => Ok(Self::Processes(EmptyPayload {})),
            "session.printers" => Ok(Self::Printers(EmptyPayload {})),
            _ => Err(SessionError::new(
                ErrorCode::SessionInvalidRequest,
                "Operação de sessão não permitida",
            )),
        }
    }
    pub fn name(&self) -> &'static str {
        match self {
            Self::Info(_) => "session.info",
            Self::Processes(_) => "session.processes",
            Self::Printers(_) => "session.printers",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub request_id: String,
    pub protocol_version: u16,
    pub timestamp: i64,
    pub expires_at: i64,
    pub nonce: String,
    pub session: Identity,
    #[serde(flatten)]
    pub operation: Operation,
}
impl Request {
    pub fn new(operation: Operation, session: Identity, now: i64, expires_at: i64) -> Self {
        Self {
            request_id: uuid::Uuid::new_v4().to_string(),
            nonce: uuid::Uuid::new_v4().to_string(),
            protocol_version: SESSION_PROTOCOL_VERSION,
            timestamp: now,
            expires_at: expires_at.min(now + MAX_VALIDITY_MS),
            session,
            operation,
        }
    }
    pub fn validate(&self, own: &Identity, now: i64) -> Result<()> {
        if self.protocol_version != SESSION_PROTOCOL_VERSION {
            return Err(SessionError::new(
                ErrorCode::SessionProtocolMismatch,
                "Protocolo do Session Helper incompatível",
            ));
        }
        if self.expires_at <= now {
            return Err(SessionError::new(
                ErrorCode::SessionExpired,
                "Request de sessão expirado",
            ));
        }
        if self.timestamp > now.saturating_add(2000)
            || self.expires_at <= self.timestamp
            || self.expires_at.saturating_sub(self.timestamp) > MAX_VALIDITY_MS
            || uuid::Uuid::parse_str(&self.request_id).is_err()
            || uuid::Uuid::parse_str(&self.nonce).is_err()
        {
            return Err(SessionError::new(
                ErrorCode::SessionInvalidRequest,
                "Janela ou identificador de IPC inválido",
            ));
        }
        if &self.session != own
            || own.session_id == 0
            || !own.user_sid.starts_with("S-1-")
            || !own.logon_sid.starts_with("S-1-5-5-")
        {
            return Err(SessionError::new(
                ErrorCode::SessionPeerRejected,
                "Sessão/SID divergente",
            ));
        }
        Ok(())
    }
}
pub fn decode_request(bytes: &[u8]) -> Result<Request> {
    size(bytes.len())?;
    // Flatten + deny_unknown_fields is not supported by serde: check envelope keys explicitly.
    let value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|_| SessionError::new(ErrorCode::SessionInvalidRequest, "JSON de IPC inválido"))?;
    let object = value.as_object().ok_or_else(|| {
        SessionError::new(
            ErrorCode::SessionInvalidRequest,
            "Envelope precisa ser objeto",
        )
    })?;
    if object.len() != 8
        || object.keys().any(|key| {
            ![
                "requestId",
                "protocolVersion",
                "timestamp",
                "expiresAt",
                "nonce",
                "session",
                "operation",
                "payload",
            ]
            .contains(&key.as_str())
        })
    {
        return Err(SessionError::new(
            ErrorCode::SessionInvalidRequest,
            "Campos de envelope não permitidos",
        ));
    }
    if !object
        .get("payload")
        .and_then(|payload| payload.as_object())
        .is_some_and(|payload| payload.is_empty())
    {
        return Err(SessionError::new(
            ErrorCode::SessionInvalidRequest,
            "Payload de sessão deve ser objeto vazio",
        ));
    }
    serde_json::from_slice(bytes).map_err(|_| {
        SessionError::new(
            ErrorCode::SessionInvalidRequest,
            "Operação ou payload de IPC inválido",
        )
    })
}
pub fn size(bytes: usize) -> Result<()> {
    if bytes == 0 || bytes > MAX_MESSAGE_BYTES {
        Err(SessionError::new(
            ErrorCode::SessionMessageTooLarge,
            "Mensagem fora do limite de IPC",
        ))
    } else {
        Ok(())
    }
}
pub fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    let bytes = serde_json::to_vec(value).map_err(|_| {
        SessionError::new(
            ErrorCode::SessionInvalidRequest,
            "Resposta não serializável",
        )
    })?;
    size(bytes.len())?;
    Ok(bytes)
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Info {
    pub session: Identity,
    pub username: String,
    pub domain: String,
    pub state: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Process {
    pub pid: u32,
    pub name: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Printer {
    pub name: String,
    pub server: Option<String>,
    pub is_default: Option<bool>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Inventory<T> {
    pub items: Vec<T>,
    pub truncated: bool,
    pub incomplete: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "operation", content = "data")]
pub enum Data {
    #[serde(rename = "session.info")]
    Info(Info),
    #[serde(rename = "session.processes")]
    Processes(Inventory<Process>),
    #[serde(rename = "session.printers")]
    Printers(Inventory<Printer>),
}
impl Data {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Info(_) => "session.info",
            Self::Processes(_) => "session.processes",
            Self::Printers(_) => "session.printers",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase", deny_unknown_fields)]
pub enum Outcome {
    Completed { result: Data },
    Rejected { error: SessionError },
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Response {
    pub request_id: String,
    pub protocol_version: u16,
    pub timestamp: i64,
    pub nonce: String,
    pub session: Identity,
    pub outcome: Outcome,
}
impl Response {
    pub fn for_request(request: &Request, outcome: Outcome, now: i64) -> Self {
        Self {
            request_id: request.request_id.clone(),
            protocol_version: SESSION_PROTOCOL_VERSION,
            timestamp: now,
            nonce: request.nonce.clone(),
            session: request.session.clone(),
            outcome,
        }
    }
    pub fn validate(&self, request: &Request, now: i64) -> Result<()> {
        if self.protocol_version != SESSION_PROTOCOL_VERSION {
            return Err(SessionError::new(
                ErrorCode::SessionProtocolMismatch,
                "Resposta com protocolo incompatível",
            ));
        }
        request.validate(&request.session, now)?;
        if self.request_id != request.request_id
            || self.nonce != request.nonce
            || self.session != request.session
            || self.timestamp < request.timestamp
            || self.timestamp > now.saturating_add(2000)
        {
            return Err(SessionError::new(
                ErrorCode::SessionPeerRejected,
                "Resposta não corresponde ao request autenticado",
            ));
        }
        if let Outcome::Completed { result } = &self.outcome {
            if result.name() != request.operation.name() {
                return Err(SessionError::new(
                    ErrorCode::SessionInvalidRequest,
                    "Tipo de resposta divergente",
                ));
            }
            let valid = match result {
                Data::Info(info) => {
                    info.session == request.session
                        && info.state == "active"
                        && info.username.len() <= 2048
                        && info.domain.len() <= 2048
                }
                Data::Processes(inventory) => {
                    inventory.items.len() <= MAX_PROCESSES
                        && inventory
                            .items
                            .iter()
                            .all(|p| p.pid > 0 && p.name.len() <= 4096)
                }
                Data::Printers(inventory) => {
                    inventory.items.len() <= MAX_PRINTERS
                        && inventory.items.iter().all(|p| {
                            !p.name.is_empty()
                                && p.name.len() <= 4096
                                && p.server.as_ref().is_none_or(|s| s.len() <= 4096)
                        })
                }
            };
            if !valid {
                return Err(SessionError::new(
                    ErrorCode::SessionInvalidRequest,
                    "Dados de resposta fora do contrato",
                ));
            }
        }
        Ok(())
    }
}
// Reserved future design, deliberately absent from Operation and remote policy.
#[derive(Debug, Serialize, Deserialize)]
pub enum FutureProduct {
    TROIA,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionState {
    Active,
    Locked,
    Disconnected,
    Unknown,
}
#[derive(Debug, Clone)]
pub struct Candidate {
    pub identity: Identity,
    pub state: SessionState,
}
pub fn select_session(sessions: &[Candidate]) -> Result<Identity> {
    let users: Vec<_> = sessions
        .iter()
        .filter(|s| s.identity.session_id != 0)
        .collect();
    if users.is_empty() {
        return Err(SessionError::new(
            ErrorCode::SessionRequired,
            "Nenhum usuário interativo logado",
        ));
    }
    if users.len() != 1 {
        return Err(SessionError::new(
            ErrorCode::SessionAmbiguous,
            "Múltiplas sessões; nenhuma foi selecionada arbitrariamente",
        ));
    }
    match users[0].state {
        SessionState::Active => Ok(users[0].identity.clone()),
        SessionState::Locked => Err(SessionError::new(
            ErrorCode::SessionLocked,
            "Sessão bloqueada",
        )),
        SessionState::Disconnected => Err(SessionError::new(
            ErrorCode::SessionDisconnected,
            "Sessão desconectada/RDP",
        )),
        SessionState::Unknown => Err(SessionError::new(
            ErrorCode::SessionStateUnknown,
            "Estado da sessão não verificável",
        )),
    }
}
#[derive(Default)]
pub struct ReplayGuard {
    seen: HashSet<String>,
    expires: Vec<(String, i64)>,
}
impl ReplayGuard {
    pub fn accept(&mut self, request: &Request, identity: &Identity, now: i64) -> Result<()> {
        request.validate(identity, now)?;
        self.expires.retain(|(nonce, expiry)| {
            if *expiry <= now {
                self.seen.remove(nonce);
                false
            } else {
                true
            }
        });
        if self.seen.contains(&request.nonce) {
            return Err(SessionError::new(
                ErrorCode::SessionReplay,
                "Nonce de IPC já usado",
            ));
        }
        if self.seen.len() >= 1024 {
            return Err(SessionError::new(
                ErrorCode::SessionInvalidRequest,
                "Limite de requests simultâneos",
            ));
        }
        self.seen.insert(request.nonce.clone());
        self.expires
            .push((request.nonce.clone(), request.expires_at));
        Ok(())
    }
}
pub fn execute_frame(
    bytes: &[u8],
    identity: &Identity,
    guard: &mut ReplayGuard,
    now: i64,
    executor: impl FnOnce(&Operation) -> Result<Data>,
) -> Result<Data> {
    let request = decode_request(bytes)?;
    guard.accept(&request, identity, now)?;
    executor(&request.operation)
}
#[cfg(test)]
mod tests;
