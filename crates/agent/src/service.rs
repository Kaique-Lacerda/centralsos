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
    let Ok(handle) = service_control_handler::register(NAME, move |event| match event {
        ServiceControl::Stop | ServiceControl::Shutdown => {
            stop_flag.store(true, Ordering::SeqCst);
            if let Some(handle) = *pending.lock().unwrap() {
                let _ = handle.set_service_status(ServiceStatus {
                    service_type: ServiceType::OWN_PROCESS,
                    current_state: ServiceState::StopPending,
                    controls_accepted: ServiceControlAccept::empty(),
                    exit_code: ServiceExitCode::Win32(0),
                    checkpoint: 1,
                    wait_hint: Duration::from_secs(30),
                    process_id: None,
                });
            }
            let _ = tx.send(());
            ServiceControlHandlerResult::NoError
        }
        ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
        _ => ServiceControlHandlerResult::NotImplemented,
    }) else {
        return;
    };
    *holder.lock().unwrap() = Some(handle);
    let status = |state, exit| ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: state,
        controls_accepted: if state == ServiceState::Running {
            ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN
        } else {
            ServiceControlAccept::empty()
        },
        exit_code: exit,
        checkpoint: 0,
        wait_hint: Duration::from_secs(30),
        process_id: None,
    };
    let _ = handle.set_service_status(status(ServiceState::Running, ServiceExitCode::Win32(0)));
    let result = crate::runner::run(rx, flag);
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
