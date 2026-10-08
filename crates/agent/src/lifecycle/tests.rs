use super::*;
use central_sos_link::session::{select_session, Candidate, SessionError, SessionState};
fn identity(logon: u32) -> Identity {
    Identity {
        session_id: 2,
        user_sid: "S-1-5-21-42".into(),
        logon_sid: format!("S-1-5-5-42-{logon}"),
    }
}
fn error(code: ErrorCode) -> SessionError {
    SessionError::new(code, "fixture")
}
struct Mock {
    selected: Result<Identity>,
    launches: u32,
    stops: u32,
    ready: bool,
    launch_error: Option<ErrorCode>,
    health_error: Option<ErrorCode>,
    exited: bool,
    busy: bool,
    foreign: bool,
    occupied: bool,
    available: bool,
}
impl Default for Mock {
    fn default() -> Self {
        Self {
            selected: Ok(identity(1)),
            launches: 0,
            stops: 0,
            ready: true,
            launch_error: None,
            health_error: None,
            exited: false,
            busy: false,
            foreign: false,
            occupied: false,
            available: false,
        }
    }
}
impl Platform for Mock {
    type Child = Identity;
    fn discover(&mut self) -> Result<Identity> {
        self.selected.clone()
    }
    fn launch(&mut self, id: &Identity) -> Result<Identity> {
        self.launches += 1;
        if self.occupied {
            return Err(error(ErrorCode::SessionHelperUnavailable));
        }
        if let Some(code) = &self.launch_error {
            return Err(error(code.clone()));
        }
        self.exited = false;
        Ok(id.clone())
    }
    fn health(&mut self, _: &Identity) -> Result<Health> {
        if let Some(code) = &self.health_error {
            return Err(error(code.clone()));
        }
        Ok(if self.busy {
            Health::Busy
        } else if self.exited {
            Health::Exited
        } else if self.ready {
            Health::Ready
        } else {
            Health::Starting
        })
    }
    fn retire(&mut self, _: &Identity) -> Result<()> {
        if self.foreign {
            return Err(error(ErrorCode::SessionPeerRejected));
        }
        self.stops += 1;
        Ok(())
    }
    fn available(&mut self, child: Option<&Identity>) {
        self.available = child.is_some();
    }
}
#[test]
fn service_lifecycle_starts_without_desktop_backend_or_enrollment() {
    let mut s = Supervisor::new(Mock::default());
    s.tick(0);
    assert_eq!(s.state, State::Available);
    assert_eq!(s.platform.launches, 1);
    assert!(s.platform.available);
}
#[test]
fn stop_and_shutdown_revoke_before_cleanup_and_never_restart() {
    for _control in ["Stop", "Shutdown"] {
        let mut s = Supervisor::new(Mock::default());
        s.tick(0);
        s.shutdown();
        s.tick(100_000);
        assert_eq!(s.state, State::Stopped);
        assert_eq!(s.platform.stops, 1);
        assert_eq!(s.platform.launches, 1);
        assert!(!s.platform.available);
    }
}
#[test]
fn no_user_locked_disconnected_ambiguous_and_unknown_never_launch() {
    for code in [
        ErrorCode::SessionRequired,
        ErrorCode::SessionLocked,
        ErrorCode::SessionDisconnected,
        ErrorCode::SessionAmbiguous,
        ErrorCode::SessionStateUnknown,
    ] {
        let mut s = Supervisor::new(Mock {
            selected: Err(error(code.clone())),
            ..Mock::default()
        });
        s.tick(0);
        assert_eq!(s.state, State::Unavailable(code));
        assert_eq!(s.platform.launches, 0);
    }
}
#[test]
fn system_session_zero_or_unverifiable_identity_is_refused_before_launch() {
    for selected in [
        Identity {
            session_id: 0,
            ..identity(1)
        },
        Identity {
            user_sid: "S-1-5-18".into(),
            ..identity(1)
        },
        Identity {
            logon_sid: String::new(),
            ..identity(1)
        },
    ] {
        let mut s = Supervisor::new(Mock {
            selected: Ok(selected),
            ..Mock::default()
        });
        s.tick(0);
        assert_eq!(s.platform.launches, 0);
        assert!(!s.platform.available);
        assert_eq!(s.state, State::Unavailable(ErrorCode::SessionPeerRejected));
    }
}
#[test]
fn wts_candidates_do_not_choose_first_user_or_disconnected_rdp() {
    let active = Candidate {
        identity: identity(1),
        state: SessionState::Active,
    };
    let rdp = Candidate {
        identity: Identity {
            session_id: 3,
            ..identity(2)
        },
        state: SessionState::Disconnected,
    };
    assert_eq!(
        select_session(&[active, rdp.clone()]).unwrap_err().code,
        ErrorCode::SessionAmbiguous
    );
    assert_eq!(
        select_session(&[rdp]).unwrap_err().code,
        ErrorCode::SessionDisconnected
    );
}
#[test]
fn helper_crash_recovers_with_backoff_and_single_child() {
    let mut s = Supervisor::new(Mock::default());
    s.tick(0);
    s.platform.exited = true;
    s.tick(15_000);
    assert_eq!(s.platform.stops, 1);
    assert!(!s.platform.available);
    s.tick(16_999);
    assert_eq!(s.platform.launches, 1);
    s.tick(17_000);
    assert_eq!(s.platform.launches, 2);
    assert_eq!(s.state, State::Available);
    s.tick(18_000);
    assert_eq!(s.platform.launches, 2);
}
#[test]
fn repeated_failure_cools_down_for_five_minutes_without_spin() {
    let mut s = Supervisor::new(Mock {
        launch_error: Some(ErrorCode::SessionHelperUnavailable),
        ..Mock::default()
    });
    for t in [0, 2_000, 6_000, 14_000, 30_000] {
        s.tick(t);
    }
    assert_eq!(s.platform.launches, 5);
    assert_eq!(s.state, State::RepeatedFailure);
    for t in [31_000, 60_000, 329_999] {
        s.tick(t);
    }
    assert_eq!(s.platform.launches, 5);
    s.tick(330_000);
    assert_eq!(s.platform.launches, 6);
}
#[test]
fn existing_unknown_instance_after_agent_restart_is_not_adopted_or_killed() {
    let mut s = Supervisor::new(Mock {
        occupied: true,
        ..Mock::default()
    });
    s.tick(0);
    s.tick(1_000);
    assert_eq!(s.platform.launches, 1);
    assert_eq!(s.platform.stops, 0);
    assert!(!s.platform.available);
}
#[test]
fn untrusted_image_or_permissive_acl_never_makes_helper_available() {
    let mut s = Supervisor::new(Mock {
        launch_error: Some(ErrorCode::SessionPeerRejected),
        ..Mock::default()
    });
    s.tick(0);
    assert_eq!(s.state, State::Unavailable(ErrorCode::SessionPeerRejected));
    assert!(!s.platform.available);
}
#[test]
fn foreign_process_is_quarantined_not_terminated_or_replaced() {
    let mut s = Supervisor::new(Mock::default());
    s.tick(0);
    s.platform.foreign = true;
    s.platform.health_error = Some(ErrorCode::SessionPeerRejected);
    s.tick(15_000);
    assert_eq!(s.state, State::Quarantined);
    assert_eq!(s.platform.stops, 0);
    s.tick(500_000);
    s.shutdown();
    assert_eq!(s.platform.launches, 1);
    assert_eq!(s.platform.stops, 0);
    assert!(!s.platform.available);
}
#[test]
fn failed_post_creation_verification_retains_ownership_without_duplicate_retries() {
    let mut s = Supervisor::new(Mock {
        foreign: true,
        health_error: Some(ErrorCode::SessionPeerRejected),
        ..Mock::default()
    });
    s.tick(0);
    assert_eq!(s.state, State::Quarantined);
    assert!(s.child.is_some());
    s.tick(1_000_000);
    assert_eq!(s.platform.launches, 1);
    assert_eq!(s.platform.stops, 0);
    assert!(!s.platform.available);
}
#[test]
fn logoff_lock_and_rdp_disconnect_retire_only_current_lifecycle() {
    for code in [
        ErrorCode::SessionRequired,
        ErrorCode::SessionLocked,
        ErrorCode::SessionDisconnected,
        ErrorCode::SessionAmbiguous,
    ] {
        let mut s = Supervisor::new(Mock::default());
        s.tick(0);
        s.platform.selected = Err(error(code.clone()));
        s.tick(100);
        assert_eq!(s.platform.stops, 1);
        assert!(!s.platform.available);
        assert_eq!(s.state, State::Unavailable(code));
    }
}
#[test]
fn new_logon_identity_never_reuses_old_helper() {
    let mut s = Supervisor::new(Mock::default());
    s.tick(0);
    s.platform.selected = Ok(identity(2));
    s.tick(1_000);
    assert_eq!(s.platform.stops, 1);
    assert_eq!(s.platform.launches, 2);
    assert_eq!(s.child.as_ref(), Some(&identity(2)));
}
#[test]
fn pipe_timeout_protocol_mismatch_and_authentication_failure_revoke_availability() {
    for code in [
        ErrorCode::SessionTimeout,
        ErrorCode::SessionProtocolMismatch,
        ErrorCode::SessionPeerRejected,
    ] {
        let mut s = Supervisor::new(Mock::default());
        s.tick(0);
        s.platform.health_error = Some(code.clone());
        s.tick(15_000);
        assert_eq!(s.state, State::Unavailable(code));
        assert!(!s.platform.available);
        assert_eq!(s.platform.stops, 1);
    }
}
#[test]
fn startup_grace_is_bounded_and_never_exposes_unready_child() {
    let mut s = Supervisor::new(Mock {
        ready: false,
        ..Mock::default()
    });
    s.tick(0);
    s.tick(9_000);
    assert_eq!(s.platform.stops, 0);
    assert!(!s.platform.available);
    s.tick(10_000);
    assert_eq!(s.platform.stops, 1);
    assert_eq!(s.platform.launches, 1);
}
#[test]
fn machine_commands_do_not_consult_lifecycle_or_gain_system_fallback() {
    let policy = central_sos_link::policy::command_policy("machine.refresh");
    // Existing typed policy remains authoritative; machine-safe and session commands stay separate.
    assert!(policy.is_some());
    assert!(!policy.unwrap().requires_interactive_user);
    assert!(
        central_sos_link::policy::command_policy("session.info")
            .unwrap()
            .requires_interactive_user
    );
}
#[test]
fn busy_pipe_does_not_kill_a_normal_command_but_cannot_hide_a_hang_forever() {
    let mut s = Supervisor::new(Mock::default());
    s.tick(0);
    s.platform.busy = true;
    s.tick(15_000);
    s.tick(44_000);
    assert_eq!(s.platform.stops, 0);
    assert!(s.platform.available);
    s.tick(45_000);
    assert_eq!(s.platform.stops, 1);
    assert!(!s.platform.available);
    let mut starting = Supervisor::new(Mock {
        busy: true,
        ..Mock::default()
    });
    starting.tick(0);
    starting.tick(10_000);
    assert_eq!(starting.platform.stops, 1);
}
#[test]
fn owned_resources_are_released_on_recovery_and_shutdown_without_accumulation() {
    use std::{cell::Cell, rc::Rc};
    struct Resource(Rc<Cell<u32>>);
    impl Drop for Resource {
        fn drop(&mut self) {
            self.0.set(self.0.get() - 1);
        }
    }
    struct Resources {
        live: Rc<Cell<u32>>,
        exited: bool,
    }
    impl Platform for Resources {
        type Child = Resource;
        fn discover(&mut self) -> Result<Identity> {
            Ok(identity(1))
        }
        fn launch(&mut self, _: &Identity) -> Result<Resource> {
            self.exited = false;
            self.live.set(self.live.get() + 1);
            Ok(Resource(self.live.clone()))
        }
        fn health(&mut self, _: &Resource) -> Result<Health> {
            Ok(if self.exited {
                Health::Exited
            } else {
                Health::Ready
            })
        }
        fn retire(&mut self, _: &Resource) -> Result<()> {
            Ok(())
        }
        fn available(&mut self, _: Option<&Resource>) {}
    }
    let live = Rc::new(Cell::new(0));
    let mut s = Supervisor::new(Resources {
        live: live.clone(),
        exited: false,
    });
    s.tick(0);
    for i in 1..=30 {
        s.platform.exited = true;
        s.tick(i * 1_000_000);
        assert_eq!(live.get(), 0);
        s.tick(i * 1_000_000 + 300_000);
        assert_eq!(live.get(), 1);
    }
    s.shutdown();
    assert_eq!(live.get(), 0);
}
