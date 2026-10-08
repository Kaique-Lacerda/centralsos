use super::*;
use crate::{
    control::validate_command,
    http::{bounded, known_path, origin},
};
use std::{collections::VecDeque, io::Cursor};
struct Fake {
    responses: Mutex<VecDeque<Result<Value>>>,
    calls: Mutex<Vec<(String, Option<Value>, Option<String>)>>,
    on_complete: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
}
impl Http for Fake {
    fn json(&self, path: &str, body: Option<&Value>, bearer: Option<&str>) -> Result<Value> {
        self.calls
            .lock()
            .unwrap()
            .push((path.into(), body.cloned(), bearer.map(str::to_owned)));
        if path == "/auth/native/complete" {
            if let Some(hook) = self.on_complete.lock().unwrap().as_ref() {
                hook();
            }
        }
        self.responses
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Err(Failure::new("CONNECTION_FAILED", 0)))
    }
}
const ORIGIN: &str = "https://support.example.test";
const ID: &str = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
fn fixture() -> (Host, Arc<Fake>, DateTime<Utc>) {
    let fake = Arc::new(Fake {
        responses: Mutex::new(VecDeque::new()),
        calls: Mutex::new(Vec::new()),
        on_complete: Mutex::new(None),
    });
    (
        Host::new(Some(ORIGIN.into()), Some(fake.clone())),
        fake,
        Utc::now() + chrono::Duration::hours(1),
    )
}
fn add(fake: &Fake, v: Value) {
    fake.responses.lock().unwrap().push_back(Ok(v));
}
fn start_body() -> Value {
    json!({"protocolVersion":1,"transactionId":ID,"deviceCode":"D".repeat(43),"userCode":"ABCD-1234-ABCD","authorizationUrl":format!("{ORIGIN}/api/control/auth/native/authorize?user_code=ABCD-1234-ABCD"),"expiresAt":(Utc::now()+chrono::Duration::minutes(5)).to_rfc3339(),"intervalSeconds":5})
}
fn ready(host: &Host, fake: &Fake) {
    add(fake, start_body());
    host.start(|_| Ok(())).unwrap();
    host.lock().pending.as_mut().unwrap().next_poll = Instant::now();
    add(
        fake,
        json!({"state":"approved","operator":{"subject":"operator-id","name":"Técnico"},"intervalSeconds":5}),
    );
    host.poll().unwrap();
}
fn session(expiry: DateTime<Utc>) -> Value {
    json!({"subject":"operator-id","name":"Técnico","memberships":[{"companyId":ID,"role":"operator"}],"expiresAt":expiry.to_rfc3339(),"scope":"control"})
}
fn login(host: &Host, fake: &Fake, expiry: DateTime<Utc>) {
    ready(host, fake);
    add(
        fake,
        json!({"accessToken":format!("sos_operator_{}","T".repeat(43)),"tokenType":"Bearer","scope":"control","expiresAt":expiry.to_rfc3339()}),
    );
    add(fake, session(expiry));
    host.complete(true).unwrap();
}
#[test]
fn secure_random_s256() {
    let (v, c) = proof();
    let (v2, _) = proof();
    assert_eq!(v.len(), 43);
    assert_ne!(*v, *v2);
    assert_eq!(c, URL_SAFE_NO_PAD.encode(Sha256::digest(v.as_bytes())));
}
#[test]
fn cancellation_during_redeem_revokes_late_credential_and_never_authenticates() {
    let (h, f, expiry) = fixture();
    let h = Arc::new(h);
    ready(&h, &f);
    let weak = Arc::downgrade(&h);
    *f.on_complete.lock().unwrap() = Some(Box::new(move || {
        weak.upgrade().unwrap().logout();
    }));
    add(
        &f,
        json!({"accessToken":format!("sos_operator_{}","T".repeat(43)),"tokenType":"Bearer","scope":"control","expiresAt":expiry.to_rfc3339()}),
    );
    add(&f, session(expiry));
    add(&f, json!({"revoked":true}));
    assert_eq!(h.complete(true).unwrap_err().code, "SESSION_CHANGED");
    assert!(h.lock().credential.is_none());
    assert_eq!(h.status().state, "signed_out");
    assert_eq!(
        f.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.0 == "/auth/native/logout")
            .count(),
        1
    );
}
#[test]
fn start_opens_only_validated_url_and_keeps_private_proof() {
    let (h, f, _) = fixture();
    add(&f, start_body());
    let v = h
        .start(|url| {
            assert!(url.starts_with(ORIGIN));
            Ok(())
        })
        .unwrap();
    assert_eq!(v.state, "awaiting_browser");
    assert_eq!(v.comparison_code.as_deref(), Some("ABCD-1234-ABCD"));
    let calls = f.calls.lock().unwrap();
    assert_eq!(calls[0].1.as_ref().unwrap()["codeChallengeMethod"], "S256");
    assert!(calls[0].2.is_none());
    let public = serde_json::to_string(&v).unwrap();
    for secret in [
        "deviceCode",
        "codeVerifier",
        "accessToken",
        "authorizationUrl",
        "transactionId",
        "Authorization",
    ] {
        assert!(!public.contains(secret));
    }
}
#[test]
fn polling_interval_and_expiry_enforced_natively() {
    let (h, f, _) = fixture();
    add(&f, start_body());
    h.start(|_| Ok(())).unwrap();
    h.poll().unwrap();
    h.poll().unwrap();
    assert_eq!(f.calls.lock().unwrap().len(), 1);
    h.lock().pending.as_mut().unwrap().expiry = Utc::now() - chrono::Duration::seconds(1);
    assert_eq!(h.poll().unwrap().state, "login_expired");
    assert!(h.lock().pending.is_none());
}
#[test]
fn identity_confirmation_and_single_redeem() {
    let (h, f, expiry) = fixture();
    ready(&h, &f);
    assert_eq!(h.complete(false).unwrap_err().code, "CONFIRMATION_REQUIRED");
    add(
        &f,
        json!({"accessToken":format!("sos_operator_{}","T".repeat(43)),"tokenType":"Bearer","scope":"control","expiresAt":expiry.to_rfc3339()}),
    );
    add(&f, session(expiry));
    let view = h.complete(true).unwrap();
    assert_eq!(view.state, "authenticated");
    assert!(h.complete(true).is_err());
    let calls = f.calls.lock().unwrap();
    assert_eq!(
        calls[2].1.as_ref().unwrap()["expectedSubject"],
        "operator-id"
    );
    assert_eq!(
        calls
            .iter()
            .filter(|c| c.0 == "/auth/native/complete")
            .count(),
        1
    );
}
#[test]
fn absent_and_expired_credentials_block_control_and_session() {
    let (h, f, expiry) = fixture();
    assert_eq!(
        h.control(ControlRequest::Devices {}).unwrap_err().code,
        "SESSION_EXPIRED"
    );
    assert!(f.calls.lock().unwrap().is_empty());
    login(&h, &f, expiry);
    h.lock().credential.as_mut().unwrap().expiry = Utc::now() - chrono::Duration::seconds(1);
    assert!(h.session().is_err());
    assert_eq!(h.status().state, "session_expired");
}
#[test]
fn control_uses_operator_token_and_logout_prevents_future_calls() {
    let (h, f, expiry) = fixture();
    login(&h, &f, expiry);
    add(&f, json!([]));
    h.control(ControlRequest::Devices {}).unwrap();
    assert!(f
        .calls
        .lock()
        .unwrap()
        .last()
        .unwrap()
        .2
        .as_ref()
        .unwrap()
        .starts_with("sos_operator_"));
    add(&f, json!({"revoked":true}));
    assert_eq!(h.logout().state, "signed_out");
    let n = f.calls.lock().unwrap().len();
    assert!(h.control(ControlRequest::Devices {}).is_err());
    assert!(h.session().is_err());
    assert_eq!(f.calls.lock().unwrap().len(), n);
}
#[test]
fn logout_failure_warns_and_never_restores_credential() {
    let (h, f, expiry) = fixture();
    login(&h, &f, expiry);
    assert!(h.logout().revocation_pending);
    assert!(h.lock().credential.is_none());
    assert!(h.control(ControlRequest::Devices {}).is_err());
}
#[test]
fn logout_clears_before_revocation_http_and_cancels_inflight_results() {
    struct Observe {
        h: Mutex<Option<std::sync::Weak<Host>>>,
    }
    impl Http for Observe {
        fn json(&self, _: &str, _: Option<&Value>, _: Option<&str>) -> Result<Value> {
            let h = self.h.lock().unwrap().as_ref().unwrap().upgrade().unwrap();
            assert!(h.lock().credential.is_none());
            assert_eq!(h.status().state, "signed_out");
            Ok(json!({"revoked":true}))
        }
    }
    let f = Arc::new(Observe {
        h: Mutex::new(None),
    });
    let h = Arc::new(Host::new(Some(ORIGIN.into()), Some(f.clone())));
    *f.h.lock().unwrap() = Some(Arc::downgrade(&h));
    h.lock().credential = Some(Stored {
        token: Zeroizing::new("test-memory-only".into()),
        expiry: Utc::now() + chrono::Duration::minutes(1),
        subject: "operator-id".into(),
    });
    assert!(!h.logout().revocation_pending);
}
#[test]
fn invalid_start_never_opens_browser_or_exposes_server_errors() {
    let (h, f, _) = fixture();
    let mut body = start_body();
    body["authorizationUrl"] = json!("https://evil.test/");
    add(&f, body);
    assert_eq!(
        h.start(|_| panic!("must not open")).unwrap_err().code,
        "INVALID_RESPONSE"
    );
    assert!(h.lock().pending.is_none());
    assert!(h.start(|_| Ok(())).is_err());
    assert_eq!(h.status().state, "unavailable");
}
#[test]
fn agent_credentials_and_secret_control_responses_rejected() {
    let (h, f, expiry) = fixture();
    ready(&h, &f);
    add(
        &f,
        json!({"accessToken":"sos_agent_secret","tokenType":"Bearer","scope":"control","expiresAt":expiry.to_rfc3339()}),
    );
    assert!(h.complete(true).is_err());
    assert!(h.lock().credential.is_none());
    assert!(!safe_response(
        &json!({"details":{"Authorization":"Bearer secret"}})
    ));
    assert!(!safe_response(&json!({"accessToken":"secret"})));
}
#[test]
fn permission_failure_and_expiration_remove_local_session() {
    for status in [401, 403] {
        let (h, f, expiry) = fixture();
        login(&h, &f, expiry);
        f.responses
            .lock()
            .unwrap()
            .push_back(Err(Failure::new("UNAUTHORIZED", status)));
        assert!(h.control(ControlRequest::Devices {}).is_err());
        assert!(h.lock().credential.is_none());
        assert_eq!(
            h.status().state,
            if status == 401 {
                "session_expired"
            } else {
                "unauthorized"
            }
        );
    }
}
#[test]
fn native_origin_path_bounds_and_authorization_whitelist() {
    for bad in [
        "http://example.test",
        "https://user:pass@example.test",
        "https://example.test/path",
        "https://example.test?q=1",
        "https://example.test#frag",
    ] {
        assert!(origin(bad).is_err());
    }
    assert_eq!(origin(ORIGIN).unwrap(), ORIGIN);
    for bad in [
        "/../agent/commands",
        "/devices?url=evil",
        "/auth/native/authorize",
        "/shell",
        "/devices/invalid",
    ] {
        assert!(!known_path(bad, false));
    }
    assert!(known_path(&format!("/devices/{ID}/commands"), true));
    assert!(bounded(Cursor::new(vec![0; 11]), 10).is_err());
    assert_eq!(bounded(Cursor::new(vec![0; 10]), 10).unwrap().len(), 10);
    assert!(authorization_url(ORIGIN, "https://evil.test", "ABCD-1234-ABCD").is_err());
}
#[test]
fn dispatcher_rejects_unknown_operations_destinations_payloads_and_unconfirmed_commands() {
    for value in [
        json!({"operation":"shell","path":"cmd.exe"}),
        json!({"operation":"devices","url":"https://evil.test"}),
        json!({"operation":"device","id":"invalid"}),
    ] {
        assert!(serde_json::from_value::<ControlRequest>(value).is_err());
    }
    for value in [
        json!({"type":"shell","payload":{},"confirmed":true}),
        json!({"type":"machine.refresh","payload":{"script":"x"},"confirmed":false}),
        json!({"type":"printer.auto_fix","payload":{},"confirmed":true}),
    ] {
        assert!(validate_command(&value).is_err());
    }
    assert_eq!(
        validate_command(&json!({"type":"spooler.restart","payload":{},"confirmed":false}))
            .unwrap_err()
            .code,
        "CONFIRMATION_REQUIRED"
    );
    validate_command(&json!({"type":"spooler.restart","payload":{},"confirmed":true})).unwrap();
    validate_command(&json!({"type":"machine.refresh","payload":{},"confirmed":false})).unwrap();
}
#[test]
fn native_http_rejects_redirect_and_maps_http_errors_without_body_leak() {
    use crate::http::{http_failure, validate_response_destination, NativeHttp};
    assert_eq!(
        validate_response_destination(302, ORIGIN, ORIGIN)
            .unwrap_err()
            .code,
        "REDIRECT_REJECTED"
    );
    assert!(validate_response_destination(200, ORIGIN, "https://evil.test").is_err());
    assert!(validate_response_destination(200, ORIGIN, ORIGIN).is_ok());
    for (status, code) in [
        (401, "SESSION_EXPIRED"),
        (403, "UNAUTHORIZED"),
        (429, "RATE_LIMITED"),
        (503, "BACKEND_UNAVAILABLE"),
    ] {
        assert_eq!(http_failure(status).code, code);
    }
    let http = NativeHttp::new(ORIGIN).unwrap();
    assert_eq!(
        http.json("/shell", None, None).unwrap_err().code,
        "INVALID_PATH"
    );
}
#[test]
fn connection_failure_and_failed_redeem_require_new_login() {
    let (h, f, _) = fixture();
    assert!(h.start(|_| Ok(())).is_err());
    assert_eq!(h.status().state, "unavailable");
    ready(&h, &f);
    assert!(h.complete(true).is_err());
    assert!(h.lock().pending.is_none());
    let n = f.calls.lock().unwrap().len();
    assert!(h.complete(true).is_err());
    assert_eq!(f.calls.lock().unwrap().len(), n);
}
