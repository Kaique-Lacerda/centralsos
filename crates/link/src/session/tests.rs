use super::*;
fn identity() -> Identity {
    Identity {
        session_id: 1,
        user_sid: "S-1-5-21-1".into(),
        logon_sid: "S-1-5-5-1-1".into(),
    }
}
fn request() -> Request {
    Request::new(Operation::Info(EmptyPayload {}), identity(), 1000, 10000)
}
#[test]
fn whitelist_and_payload_are_closed() {
    for op in ["session.info", "session.processes", "session.printers"] {
        assert!(Operation::from_name(op).is_ok());
    }
    for op in [
        "shell",
        "cmd",
        "powershell",
        "application.restart",
        "printer.resume",
        "session.exec",
    ] {
        assert!(Operation::from_name(op).is_err());
    }
    let valid = serde_json::to_value(request()).unwrap();
    for bad in [
        serde_json::json!({"path":"cmd.exe"}),
        serde_json::json!([]),
        serde_json::Value::Null,
    ] {
        let mut value = valid.clone();
        value["payload"] = bad;
        assert_eq!(
            decode_request(&serde_json::to_vec(&value).unwrap())
                .unwrap_err()
                .code,
            ErrorCode::SessionInvalidRequest
        );
    }
    let mut value = valid;
    value["extra"] = true.into();
    assert!(decode_request(&serde_json::to_vec(&value).unwrap()).is_err());
}
#[test]
fn expiry_version_size_identity_and_replay_fail_closed() {
    let mut req = request();
    assert!(req.validate(&identity(), 2000).is_ok());
    assert_eq!(
        req.validate(&identity(), 10000).unwrap_err().code,
        ErrorCode::SessionExpired
    );
    req.protocol_version = 2;
    assert_eq!(
        req.validate(&identity(), 2000).unwrap_err().code,
        ErrorCode::SessionProtocolMismatch
    );
    req.protocol_version = 1;
    req.expires_at = 40000;
    assert_eq!(
        req.validate(&identity(), 2000).unwrap_err().code,
        ErrorCode::SessionInvalidRequest
    );
    assert_eq!(
        decode_request(&vec![b' '; MAX_MESSAGE_BYTES + 1])
            .unwrap_err()
            .code,
        ErrorCode::SessionMessageTooLarge
    );
    let req = request();
    let mut other = identity();
    other.session_id = 2;
    assert_eq!(
        req.validate(&other, 2000).unwrap_err().code,
        ErrorCode::SessionPeerRejected
    );
    let mut guard = ReplayGuard::default();
    guard.accept(&req, &identity(), 2000).unwrap();
    assert_eq!(
        guard.accept(&req, &identity(), 2000).unwrap_err().code,
        ErrorCode::SessionReplay
    );
}
#[test]
fn no_arbitrary_selection_among_interactive_sessions() {
    let candidate = |state| Candidate {
        identity: identity(),
        state,
    };
    assert_eq!(
        select_session(&[]).unwrap_err().code,
        ErrorCode::SessionRequired
    );
    assert_eq!(
        select_session(&[candidate(SessionState::Locked)])
            .unwrap_err()
            .code,
        ErrorCode::SessionLocked
    );
    assert_eq!(
        select_session(&[candidate(SessionState::Disconnected)])
            .unwrap_err()
            .code,
        ErrorCode::SessionDisconnected
    );
    assert_eq!(
        select_session(&[candidate(SessionState::Unknown)])
            .unwrap_err()
            .code,
        ErrorCode::SessionStateUnknown
    );
    assert_eq!(
        select_session(&[
            candidate(SessionState::Active),
            candidate(SessionState::Disconnected)
        ])
        .unwrap_err()
        .code,
        ErrorCode::SessionAmbiguous
    );
    assert_eq!(
        select_session(&[candidate(SessionState::Active)]).unwrap(),
        identity()
    );
}
#[test]
fn all_three_results_round_trip_and_bind_request_nonce_and_operation() {
    let cases = [
        Data::Info(Info {
            session: identity(),
            username: "fixture".into(),
            domain: "fixture".into(),
            state: "active".into(),
        }),
        Data::Processes(Inventory {
            items: vec![Process {
                pid: 123,
                name: "fixture.exe".into(),
            }],
            truncated: false,
            incomplete: false,
        }),
        Data::Printers(Inventory {
            items: vec![Printer {
                name: "fixture".into(),
                server: None,
                is_default: Some(true),
            }],
            truncated: false,
            incomplete: false,
        }),
    ];
    for data in cases {
        let req = Request::new(
            Operation::from_name(data.name()).unwrap(),
            identity(),
            1000,
            10000,
        );
        let response = Response::for_request(&req, Outcome::Completed { result: data }, 2000);
        let json = encode(&response).unwrap();
        let mut decoded: Response = serde_json::from_slice(&json).unwrap();
        decoded.validate(&req, 2000).unwrap();
        decoded.nonce = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            decoded.validate(&req, 2000).unwrap_err().code,
            ErrorCode::SessionPeerRejected
        );
    }
}
#[cfg(windows)]
#[test]
fn pipe_namespace_is_bound_to_logon_not_remote_input() {
    let original = windows::pipe_name(&identity());
    assert!(original.starts_with(r"\\.\pipe\CENTRAL-SOS-Session-v1-1-"));
    let mut next = identity();
    next.logon_sid = "S-1-5-5-2-2".into();
    assert_ne!(original, windows::pipe_name(&next));
}
#[test]
fn malformed_or_expired_frames_never_reach_executor() {
    let mut guard = ReplayGuard::default();
    let req = request();
    let valid = encode(&req).unwrap();
    assert!(
        execute_frame(&valid, &identity(), &mut guard, 10000, |_| panic!(
            "executor"
        ))
        .is_err()
    );
    let mut unknown = serde_json::to_value(&req).unwrap();
    unknown["operation"] = "session.exec".into();
    assert!(execute_frame(
        &encode(&unknown).unwrap(),
        &identity(),
        &mut guard,
        2000,
        |_| panic!("executor")
    )
    .is_err());
    let data = execute_frame(&valid, &identity(), &mut guard, 2000, |operation| {
        assert_eq!(operation.name(), "session.info");
        Ok(Data::Info(Info {
            session: identity(),
            username: "fixture".into(),
            domain: String::new(),
            state: "active".into(),
        }))
    })
    .unwrap();
    assert_eq!(data.name(), "session.info");
}
