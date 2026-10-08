use super::*;
use central_sos_link::session::{
    windows::{self, lifecycle as win},
    Request, Response, SessionError,
};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

#[derive(Clone)]
struct Permit {
    identity: Identity,
    pid: u32,
}
struct Availability {
    permit: Option<Permit>,
    reason: ErrorCode,
}
impl Availability {
    fn selected(&self, identity: &Identity) -> Result<&Permit> {
        if let Some(permit) = &self.permit {
            if &permit.identity == identity {
                return Ok(permit);
            }
            return Err(SessionError::new(
                ErrorCode::SessionHelperUnavailable,
                "Helper de outro lifecycle",
            ));
        }
        Err(SessionError::new(
            self.reason.clone(),
            "Helper recusado ou indisponível no lifecycle",
        ))
    }
}
static PERMIT: OnceLock<Mutex<Availability>> = OnceLock::new();
static CHANGED: AtomicBool = AtomicBool::new(false);
fn gate() -> &'static Mutex<Availability> {
    PERMIT.get_or_init(|| {
        Mutex::new(Availability {
            permit: None,
            reason: ErrorCode::SessionHelperUnavailable,
        })
    })
}
pub fn invalidate() {
    if let Ok(mut permit) = gate().lock() {
        permit.permit = None;
        permit.reason = ErrorCode::SessionHelperUnavailable;
    }
}
pub fn wake() {
    CHANGED.store(true, Ordering::SeqCst);
}
pub fn exchange(request: &Request) -> Result<Response> {
    // Hold the gate through bounded IPC; shutdown/session retirement cannot release ownership
    // and allow PID reuse in the middle of the exchange.
    let permit = gate().lock().map_err(|_| {
        SessionError::new(
            ErrorCode::SessionHelperUnavailable,
            "Supervisor indisponível",
        )
    })?;
    let permit = permit.selected(&request.session)?;
    windows::exchange_owned(request, permit.pid)
}
struct Native;
impl Platform for Native {
    type Child = win::Child;
    fn discover(&mut self) -> Result<Identity> {
        windows::discover()
    }
    fn launch(&mut self, identity: &Identity) -> Result<Self::Child> {
        win::launch(identity)
    }
    fn health(&mut self, child: &Self::Child) -> Result<Health> {
        let _permit = match gate().try_lock() {
            Ok(permit) => permit,
            Err(std::sync::TryLockError::WouldBlock) => return Ok(Health::Busy),
            Err(_) => {
                return Err(SessionError::new(
                    ErrorCode::SessionHelperUnavailable,
                    "Supervisor indisponível",
                ))
            }
        };
        Ok(match child.probe()? {
            win::Probe::Ready => Health::Ready,
            win::Probe::Busy => Health::Busy,
            win::Probe::Starting => Health::Starting,
            win::Probe::Exited => Health::Exited,
        })
    }
    fn retire(&mut self, child: &Self::Child) -> Result<()> {
        child.retire()
    }
    fn available(&mut self, child: Option<&Self::Child>) {
        if let Ok(mut permit) = gate().lock() {
            permit.reason = ErrorCode::SessionHelperUnavailable;
            permit.permit = child.map(|c| Permit {
                identity: c.identity().clone(),
                pid: c.pid(),
            });
        }
    }
}
pub fn supervise(shutdown: Arc<AtomicBool>) {
    struct Clear;
    impl Drop for Clear {
        fn drop(&mut self) {
            invalidate();
        }
    }
    let _clear = Clear;
    let mut supervisor = Supervisor::new(Native);
    let start = Instant::now();
    let mut previous = None;
    while !shutdown.load(Ordering::SeqCst) {
        supervisor.tick(start.elapsed().as_millis().min(u64::MAX as u128) as u64);
        if let Ok(mut availability) = gate().lock() {
            if availability.permit.is_none() {
                match &supervisor.state {
                    State::Unavailable(code) => availability.reason = code.clone(),
                    State::Quarantined => availability.reason = ErrorCode::SessionPeerRejected,
                    State::Starting => availability.reason = ErrorCode::SessionHelperUnavailable,
                    _ => {} // Preserve the finite cause through backoff; never expose an inventory.
                }
            }
        }
        if previous.as_ref() != Some(&supervisor.state) {
            // Enum-only transition diagnostics; no identity/PID/token/command/inventory.
            crate::logging::event(
                "agent.helper_state",
                serde_json::json!({"state": format!("{:?}", supervisor.state)}),
            );
            previous = Some(supervisor.state.clone());
        }
        for _ in 0..10 {
            if shutdown.load(Ordering::SeqCst) || CHANGED.swap(false, Ordering::SeqCst) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    supervisor.shutdown();
    crate::logging::event(
        "agent.helper_state",
        serde_json::json!({"state": format!("{:?}", supervisor.state)}),
    );
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unavailable_helper_preserves_known_protocol_or_trust_error_without_fallback() {
        let identity = Identity {
            session_id: 1,
            user_sid: "S-1-5-21-1".into(),
            logon_sid: "S-1-5-5-1-1".into(),
        };
        for reason in [
            ErrorCode::SessionProtocolMismatch,
            ErrorCode::SessionPeerRejected,
            ErrorCode::SessionHelperUnavailable,
        ] {
            let availability = Availability {
                permit: None,
                reason: reason.clone(),
            };
            let error = availability.selected(&identity).err().unwrap();
            assert_eq!(error.code, reason);
            assert!(serde_json::to_string(&error).unwrap().contains("SESSION_"));
        }
    }
}
