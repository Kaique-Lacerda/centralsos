use central_sos_link::{protocol::Command, session::*};

pub fn delegate(
    command: &Command,
    discover: impl FnOnce() -> Result<Identity>,
    exchange: impl FnOnce(&Request) -> Result<Response>,
    now: i64,
) -> Result<Response> {
    // Resolve whitelist before discovery or IPC. No arbitrary native name crosses this boundary.
    if command.protocol_version != central_sos_link::policy::PROTOCOL_VERSION {
        return Err(SessionError::new(
            ErrorCode::SessionProtocolMismatch,
            "Protocolo remoto incompatível",
        ));
    }
    let operation = Operation::from_name(&command.r#type)?;
    if !command.payload.as_object().is_some_and(|p| p.is_empty()) {
        return Err(SessionError::new(
            ErrorCode::SessionInvalidRequest,
            "Payload de sessão deve ser objeto vazio",
        ));
    }
    let expiry = chrono::DateTime::parse_from_rfc3339(&command.expires_at)
        .map_err(|_| {
            SessionError::new(
                ErrorCode::SessionInvalidRequest,
                "Expiração remota inválida",
            )
        })?
        .timestamp_millis();
    if expiry <= now {
        return Err(SessionError::new(
            ErrorCode::SessionExpired,
            "Comando expirou antes do IPC",
        ));
    }
    let identity = discover()?;
    let request = Request::new(operation, identity, now, expiry);
    request.validate(&request.session, now)?;
    let response = exchange(&request)?;
    response.validate(&request, chrono::Utc::now().timestamp_millis())?;
    if let Outcome::Rejected { error } = &response.outcome {
        return Err(error.clone());
    }
    Ok(response)
}
pub fn execute(command: &Command, remaining: std::time::Duration) -> serde_json::Value {
    let mut command = command.clone();
    // Clamp IPC validity to the monotonic deadline confirmed by the backend ACK.
    let max_expiry = chrono::Utc::now()
        + chrono::Duration::milliseconds(remaining.as_millis().min(30_000) as i64);
    if let Ok(original) = chrono::DateTime::parse_from_rfc3339(&command.expires_at) {
        if original > max_expiry {
            command.expires_at = max_expiry.to_rfc3339();
        }
    }
    #[cfg(windows)]
    let result = delegate(
        &command,
        windows::discover,
        windows::exchange,
        chrono::Utc::now().timestamp_millis(),
    );
    #[cfg(not(windows))]
    let result: Result<Response> = Err(SessionError::new(
        ErrorCode::SessionHelperUnavailable,
        "Session Helper exige Windows",
    ));
    match result {
        Ok(response) => serde_json::json!(response),
        Err(error) => {
            serde_json::json!({ "status": "REJECTED", "code": error.code, "message": error.message, "executionContext": "USER_SESSION_REQUIRED", "operation": command.r#type })
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn command(kind: &str) -> Command {
        let now = chrono::Utc::now();
        Command {
            protocol_version: 1,
            id: "9feeb646-85f2-4aef-b793-cd9d8badf04f".into(),
            device_id: "device".into(),
            r#type: kind.into(),
            payload: serde_json::json!({}),
            confirmed: false,
            requested_by: "fixture".into(),
            created_at: now.to_rfc3339(),
            expires_at: (now + chrono::Duration::seconds(60)).to_rfc3339(),
            status: "RUNNING".into(),
            started_at: None,
            finished_at: None,
        }
    }
    fn identity() -> Identity {
        Identity {
            session_id: 2,
            user_sid: "S-1-5-21-1".into(),
            logon_sid: "S-1-5-5-1-1".into(),
        }
    }
    #[test]
    fn no_user_or_missing_helper_never_falls_back_to_system() {
        let c = command("session.printers");
        let unavailable = |_: &Request| -> Result<Response> {
            Err(SessionError::new(
                ErrorCode::SessionHelperUnavailable,
                "fixture",
            ))
        };
        let no_user = delegate(
            &c,
            || Err(SessionError::new(ErrorCode::SessionRequired, "fixture")),
            |_| panic!("IPC must not execute"),
            chrono::Utc::now().timestamp_millis(),
        );
        assert_eq!(no_user.unwrap_err().code, ErrorCode::SessionRequired);
        assert_eq!(
            delegate(
                &c,
                || Ok(identity()),
                unavailable,
                chrono::Utc::now().timestamp_millis()
            )
            .unwrap_err()
            .code,
            ErrorCode::SessionHelperUnavailable
        );
    }
    #[test]
    fn unknown_or_invalid_payload_is_rejected_before_session_discovery() {
        let c = command("application.restart");
        assert!(delegate(&c, || panic!("discovery"), |_| panic!("IPC"), 0).is_err());
        let mut c = command("session.info");
        c.payload = serde_json::json!({"path":"cmd.exe"});
        assert!(delegate(&c, || panic!("discovery"), |_| panic!("IPC"), 0).is_err());
    }
    #[test]
    fn valid_command_uses_allowlisted_ipc_and_preserves_structured_error() {
        let c = command("session.info");
        let result = delegate(
            &c,
            || Ok(identity()),
            |request| {
                assert_eq!(request.operation.name(), "session.info");
                Ok(Response::for_request(
                    request,
                    Outcome::Rejected {
                        error: SessionError::new(ErrorCode::SessionProtocolMismatch, "fixture"),
                    },
                    chrono::Utc::now().timestamp_millis(),
                ))
            },
            chrono::Utc::now().timestamp_millis(),
        );
        assert_eq!(result.unwrap_err().code, ErrorCode::SessionProtocolMismatch);
    }
}
