use std::{
    ffi::OsString,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::Duration,
};
use windows_service::{
    define_windows_service,
    service::{
        ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus,
        ServiceType,
    },
    service_control_handler::{self, ServiceControlHandlerResult},
    service_dispatcher,
};
pub const NAME: &str = "CentralSOSAgent";
pub(crate) mod installer;
pub use installer::installer_command;
define_windows_service!(ffi_service_main, service_main);
pub fn dispatch() -> windows_service::Result<()> {
    service_dispatcher::start(NAME, ffi_service_main)
}
fn service_main(_: Vec<OsString>) {
    let (tx, rx) = mpsc::channel();
    let flag = Arc::new(AtomicBool::new(false));
    let stop_flag = flag.clone();
    let holder = Arc::new(std::sync::Mutex::new(
        None::<service_control_handler::ServiceStatusHandle>,
    ));
    let pending = holder.clone();
    let Ok(handle) = service_control_handler::register(NAME, move |event| {
        control(event, &stop_flag, &pending, &tx)
    }) else {
        return;
    };
    *holder.lock().unwrap() = Some(handle);
    if handle
        .set_service_status(status(
            ServiceState::StartPending,
            ServiceExitCode::Win32(0),
        ))
        .is_err()
    {
        return;
    }
    let _trusted_agent = match central_sos_link::session::windows::lifecycle::service_context() {
        Ok(image) => image,
        Err(error) => {
            crate::logging::event(
                "agent.start_failed",
                serde_json::json!({"code": error.code}),
            );
            let _ =
                handle.set_service_status(status(ServiceState::Stopped, ServiceExitCode::Win32(1)));
            return;
        }
    };
    if flag.load(Ordering::SeqCst) {
        let _ = handle.set_service_status(status(ServiceState::Stopped, ServiceExitCode::Win32(0)));
        return;
    }
    if handle
        .set_service_status(status(ServiceState::Running, ServiceExitCode::Win32(0)))
        .is_err()
    {
        return;
    }
    crate::logging::event(
        "agent.service_state",
        serde_json::json!({"state":"RUNNING"}),
    );
    // Keep SCM informed while existing bounded native operations unwind after Stop.
    let finished = Arc::new(AtomicBool::new(false));
    let monitor = {
        let finished = finished.clone();
        let flag = flag.clone();
        std::thread::spawn(move || {
            let mut checkpoint = 1;
            let mut ticks = 0;
            while !finished.load(Ordering::SeqCst) {
                if flag.load(Ordering::SeqCst) && ticks % 50 == 0 {
                    let mut pending = status(ServiceState::StopPending, ServiceExitCode::Win32(0));
                    checkpoint += 1;
                    pending.checkpoint = checkpoint;
                    let _ = handle.set_service_status(pending);
                }
                ticks += 1;
                std::thread::sleep(Duration::from_millis(100));
            }
        })
    };
    struct Monitor {
        finished: Arc<AtomicBool>,
        worker: Option<std::thread::JoinHandle<()>>,
    }
    impl Drop for Monitor {
        fn drop(&mut self) {
            self.finished.store(true, Ordering::SeqCst);
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
    }
    let monitor = Monitor {
        finished,
        worker: Some(monitor),
    };
    let result = crate::runner::run(rx, flag);
    drop(monitor);
    if result.is_err() {
        crate::logging::event(
            "agent.service_failed",
            serde_json::json!({"code":"LOCAL_STATE_ERROR"}),
        );
    }
    let _ = handle.set_service_status(status(
        ServiceState::Stopped,
        ServiceExitCode::Win32(if result.is_ok() { 0 } else { 1 }),
    ));
}
fn control(
    event: ServiceControl,
    stop_flag: &AtomicBool,
    pending: &std::sync::Mutex<Option<service_control_handler::ServiceStatusHandle>>,
    tx: &mpsc::Sender<()>,
) -> ServiceControlHandlerResult {
    match event {
        ServiceControl::Stop | ServiceControl::Shutdown => {
            stop_flag.store(true, Ordering::SeqCst);
            if let Some(handle) = *pending.lock().unwrap() {
                let _ = handle.set_service_status(status(
                    ServiceState::StopPending,
                    ServiceExitCode::Win32(0),
                ));
            }
            crate::lifecycle::wake();
            let _ = tx.send(());
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        ServiceControl::SessionChange(_) => {
            // Notification identity is never trusted for selection; requery WTS/kernel tokens.
            crate::lifecycle::wake();
            ServiceControlHandlerResult::NoError
        }
        _ => ServiceControlHandlerResult::NotImplemented,
    }
}
fn status(state: ServiceState, exit: ServiceExitCode) -> ServiceStatus {
    let pending = matches!(
        state,
        ServiceState::StartPending | ServiceState::StopPending
    );
    ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: state,
        controls_accepted: if state == ServiceState::Running {
            ServiceControlAccept::STOP
                | ServiceControlAccept::SHUTDOWN
                | ServiceControlAccept::SESSION_CHANGE
        } else {
            ServiceControlAccept::empty()
        },
        exit_code: exit,
        checkpoint: if pending { 1 } else { 0 },
        wait_hint: if pending {
            Duration::from_secs(30)
        } else {
            Duration::ZERO
        },
        process_id: None,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scm_stop_and_shutdown_signal_real_handler_without_installing_service() {
        for event in [ServiceControl::Stop, ServiceControl::Shutdown] {
            let flag = AtomicBool::new(false);
            let (tx, rx) = mpsc::channel();
            let holder = std::sync::Mutex::new(None);
            assert!(matches!(
                control(event, &flag, &holder, &tx),
                ServiceControlHandlerResult::NoError
            ));
            assert!(flag.load(Ordering::SeqCst));
            assert!(rx.try_recv().is_ok());
        }
    }
    #[test]
    fn scm_status_transitions_accept_session_change_only_when_running() {
        let pending = status(ServiceState::StartPending, ServiceExitCode::Win32(0));
        assert_eq!(pending.checkpoint, 1);
        assert!(pending.controls_accepted.is_empty());
        let running = status(ServiceState::Running, ServiceExitCode::Win32(0));
        assert!(running.controls_accepted.contains(
            ServiceControlAccept::STOP
                | ServiceControlAccept::SHUTDOWN
                | ServiceControlAccept::SESSION_CHANGE
        ));
        assert_eq!(running.wait_hint, Duration::ZERO);
        assert!(status(ServiceState::Stopped, ServiceExitCode::Win32(0))
            .controls_accepted
            .is_empty());
    }
    #[test]
    fn scm_session_notification_only_wakes_selection_without_trusting_supplied_session() {
        let flag = AtomicBool::new(false);
        let (tx, rx) = mpsc::channel();
        let holder = std::sync::Mutex::new(None);
        let event = ServiceControl::SessionChange(windows_service::service::SessionChangeParam {
            reason: windows_service::service::SessionChangeReason::SessionLock,
            notification: windows_service::service::SessionNotification {
                size: 8,
                session_id: 999,
            },
        });
        assert!(matches!(
            control(event, &flag, &holder, &tx),
            ServiceControlHandlerResult::NoError
        ));
        assert!(!flag.load(Ordering::SeqCst));
        assert!(rx.try_recv().is_err());
    }
}
