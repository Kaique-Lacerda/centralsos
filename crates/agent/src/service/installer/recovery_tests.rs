use super::*;
use std::cell::{Cell, RefCell};
use std::rc::Rc;

struct ProcessPin(Rc<Cell<usize>>);
impl Drop for ProcessPin {
    fn drop(&mut self) {
        self.0.set(self.0.get() - 1);
    }
}

struct Fake {
    state: Cell<ServiceState>,
    foreign: Cell<bool>,
    changed: Cell<bool>,
    invalid_process: Cell<bool>,
    delete_failure: Cell<bool>,
    stop_failure: Cell<bool>,
    timeout: Cell<bool>,
    process_exit_timeout: Cell<bool>,
    calls: RefCell<Vec<&'static str>>,
    pins: Rc<Cell<usize>>,
}
impl Fake {
    fn new(state: ServiceState) -> Self {
        Self {
            state: Cell::new(state),
            foreign: Cell::new(false),
            changed: Cell::new(false),
            invalid_process: Cell::new(false),
            delete_failure: Cell::new(false),
            stop_failure: Cell::new(false),
            timeout: Cell::new(false),
            process_exit_timeout: Cell::new(false),
            calls: RefCell::new(vec![]),
            pins: Rc::new(Cell::new(0)),
        }
    }
}
impl RecoveryService for Fake {
    type Guard = ProcessPin;
    fn verify(&self) -> Result<(ServiceState, ProcessPin), String> {
        let mut calls = self.calls.borrow_mut();
        let repeated = calls.contains(&"verify");
        calls.push("verify");
        if self.foreign.get() || (self.changed.get() && repeated) {
            return Err("SCM_FOREIGN_CONFIGURATION_REJECTED".into());
        }
        if self.invalid_process.get() {
            return Err("SCM_PROCESS_IDENTITY_REJECTED".into());
        }
        self.pins.set(self.pins.get() + 1);
        Ok((self.state.get(), ProcessPin(self.pins.clone())))
    }
    fn stop(&self) -> Result<(), String> {
        assert!(
            self.pins.get() > 0,
            "SCM process must stay pinned during stop"
        );
        self.calls.borrow_mut().push("stop");
        if self.stop_failure.get() {
            return Err("SCM_OPERATION_FAILED".into());
        }
        self.state.set(ServiceState::StopPending);
        Ok(())
    }
    fn wait_stopped(&self) -> Result<(), String> {
        assert!(
            self.pins.get() > 0,
            "SCM process must stay pinned during wait"
        );
        self.calls.borrow_mut().push("wait");
        if self.timeout.get() {
            return Err("SCM_STOP_TIMEOUT".into());
        }
        self.state.set(ServiceState::Stopped);
        Ok(())
    }
    fn delete(&self) -> Result<(), String> {
        assert!(
            self.pins.get() > 0,
            "verification guards must stay pinned until deletion"
        );
        self.calls.borrow_mut().push("delete");
        if self.delete_failure.get() {
            return Err("SCM_OPERATION_FAILED".into());
        }
        Ok(())
    }
    fn wait_process_exit(&self, _guard: &ProcessPin) -> Result<(), String> {
        assert!(self.pins.get() > 0);
        if self.process_exit_timeout.get() {
            Err("SCM_PROCESS_EXIT_TIMEOUT".into())
        } else {
            Ok(())
        }
    }
}

#[test]
fn scm_stopped_is_not_proof_of_process_exit() {
    let service = Fake::new(ServiceState::Running);
    service.process_exit_timeout.set(true);
    assert_eq!(
        recover("--stop-service", Some(&service)).unwrap_err(),
        "SCM_PROCESS_EXIT_TIMEOUT"
    );
    assert!(!service.calls.borrow().contains(&"delete"));
    assert_eq!(service.pins.get(), 0);
}

#[test]
fn recovery_keeps_verification_pins_alive_through_mutations_and_releases_on_return() {
    let service = Fake::new(ServiceState::Running);
    recover("--stop-service", Some(&service)).unwrap();
    assert_eq!(service.pins.get(), 0);
    recover("--uninstall-service", Some(&service)).unwrap();
    assert_eq!(service.pins.get(), 0);
    service.state.set(ServiceState::Running);
    service.timeout.set(true);
    assert!(recover("--stop-service", Some(&service)).is_err());
    assert_eq!(service.pins.get(), 0);
}

#[test]
fn recovery_does_not_consult_missing_corrupt_or_untrusted_helper() {
    for helper_error in ["MISSING", "CORRUPT", "UNTRUSTED"] {
        for command in ["--service-status", "--stop-service", "--uninstall-service"] {
            authorize_images(
                command,
                || Ok(()),
                || Ok(()),
                || -> Result<(), String> {
                    panic!("recovery must not open or execute {helper_error} Helper")
                },
            )
            .unwrap();
            for state in [ServiceState::Stopped, ServiceState::Running] {
                let service = Fake::new(state);
                let result = recover(command, Some(&service));
                if command == "--uninstall-service" && state == ServiceState::Running {
                    assert_eq!(result.unwrap_err(), "SCM_STOP_REQUIRED");
                    assert!(!service.calls.borrow().contains(&"delete"));
                } else {
                    result.unwrap();
                }
            }
        }
    }
}
#[test]
fn install_and_start_still_require_trusted_helper() {
    for command in ["--install-service", "--start-service"] {
        for failure in ["MISSING", "CORRUPT", "UNTRUSTED"] {
            let result = authorize_images(
                command,
                || Ok(()),
                || Ok(()),
                || Err::<(), _>(failure.into()),
            );
            assert_eq!(result.unwrap_err(), failure);
        }
    }
}
#[test]
fn authorization_and_agent_trust_are_required_even_for_recovery() {
    for command in ["--service-status", "--stop-service", "--uninstall-service"] {
        assert_eq!(
            authorize_images(
                command,
                || Err("INSTALL_ADMIN_REQUIRED".into()),
                || -> Result<(), String> { panic!("unauthorized image access") },
                || -> Result<(), String> { panic!("unauthorized Helper access") }
            )
            .unwrap_err(),
            "INSTALL_ADMIN_REQUIRED"
        );
        assert_eq!(
            authorize_images(
                command,
                || Ok(()),
                || Err::<(), _>("INSTALL_TRUST_REJECTED".into()),
                || -> Result<(), String> { panic!("untrusted Agent must not proceed") }
            )
            .unwrap_err(),
            "INSTALL_TRUST_REJECTED"
        );
    }
}
#[test]
fn missing_service_recovery_is_idempotent() {
    for command in ["--service-status", "--stop-service", "--uninstall-service"] {
        assert_eq!(recover::<Fake>(command, None).unwrap(), "Absent");
        assert_eq!(recover::<Fake>(command, None).unwrap(), "Absent");
    }
}
#[test]
fn partial_provisioning_can_be_inspected_stopped_and_removed_explicitly() {
    let service = Fake::new(ServiceState::Stopped); // create succeeded; configuration/recovery failed
    assert_eq!(
        recover("--service-status", Some(&service)).unwrap(),
        "Stopped"
    );
    recover("--stop-service", Some(&service)).unwrap();
    recover("--uninstall-service", Some(&service)).unwrap();
    assert_eq!(
        service
            .calls
            .borrow()
            .iter()
            .filter(|c| **c == "delete")
            .count(),
        1
    );
    assert!(!service.calls.borrow().contains(&"stop"));
}
#[test]
fn rollback_failure_is_reported_and_retry_can_remove_the_same_partial_installation() {
    let service = Fake::new(ServiceState::Stopped);
    service.delete_failure.set(true);
    assert_eq!(
        recover("--uninstall-service", Some(&service)).unwrap_err(),
        "SCM_OPERATION_FAILED"
    );
    assert_eq!(
        recover("--service-status", Some(&service)).unwrap(),
        "Stopped"
    );
    service.delete_failure.set(false);
    recover("--uninstall-service", Some(&service)).unwrap();
}
#[test]
fn foreign_configuration_or_process_is_rejected_before_any_mutation() {
    for command in ["--service-status", "--stop-service", "--uninstall-service"] {
        for invalid_process in [false, true] {
            let service = Fake::new(ServiceState::Running);
            service.foreign.set(!invalid_process);
            service.invalid_process.set(invalid_process);
            assert!(recover(command, Some(&service)).is_err());
            assert_eq!(*service.calls.borrow(), vec!["verify"]);
        }
    }
}
#[test]
fn configuration_is_rechecked_immediately_before_stop_or_delete() {
    for (command, state) in [
        ("--stop-service", ServiceState::Running),
        ("--uninstall-service", ServiceState::Stopped),
    ] {
        let service = Fake::new(state);
        service.changed.set(true);
        assert_eq!(
            recover(command, Some(&service)).unwrap_err(),
            "SCM_FOREIGN_CONFIGURATION_REJECTED"
        );
        assert_eq!(*service.calls.borrow(), vec!["verify", "verify"]);
    }
}
#[test]
fn failed_stop_and_timeout_never_delete_or_report_success() {
    for timeout in [false, true] {
        let service = Fake::new(ServiceState::Running);
        service.timeout.set(timeout);
        service.stop_failure.set(!timeout);
        assert!(recover("--stop-service", Some(&service)).is_err());
        assert!(recover("--uninstall-service", Some(&service)).is_err());
        assert!(!service.calls.borrow().contains(&"delete"));
    }
}
#[test]
fn pending_stop_is_waited_without_repeated_stop_and_unknown_commands_are_rejected() {
    let service = Fake::new(ServiceState::StopPending);
    assert_eq!(
        recover("--stop-service", Some(&service)).unwrap(),
        "Stopped"
    );
    assert!(!service.calls.borrow().contains(&"stop"));
    let calls = service.calls.borrow().len();
    assert!(recover("--arbitrary", Some(&service)).is_err());
    assert_eq!(service.calls.borrow().len(), calls);
}
