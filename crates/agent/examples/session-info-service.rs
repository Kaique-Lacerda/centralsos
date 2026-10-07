//! Opt-in Windows integration fixture, never part of the production Agent binary.
//! SCM must run this renamed central-sos-agent.exe, next to the real user Helper.
//! One fixed session.info call; no backend, enrollment, shell, arguments or user inventory log.
#[cfg(windows)]
mod integration {
    use central_sos_link::session::{
        windows, EmptyPayload, ErrorCode, Operation, Outcome, Request,
    };
    use std::{
        ffi::OsString,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        time::{Duration, Instant},
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
    define_windows_service!(entry, service_main);

    fn check(stop: &AtomicBool) -> central_sos_link::session::Result<()> {
        let executable = std::env::current_exe().map_err(|_| {
            central_sos_link::session::SessionError::new(
                ErrorCode::SessionPeerRejected,
                "Imagem de teste indisponível",
            )
        })?;
        let _guard = windows::trusted_image(&executable)?;
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if stop.load(Ordering::SeqCst) || Instant::now() >= deadline {
                return Err(central_sos_link::session::SessionError::new(
                    ErrorCode::SessionTimeout,
                    "Teste interrompido/timeout",
                ));
            }
            let identity = windows::discover()?;
            let now = chrono::Utc::now().timestamp_millis();
            let request = Request::new(Operation::Info(EmptyPayload {}), identity, now, now + 5000);
            match windows::exchange(&request) {
                Ok(response) => match response.outcome {
                    Outcome::Completed { result } if result.name() == "session.info" => {
                        return Ok(())
                    }
                    Outcome::Rejected { error } => return Err(error),
                    _ => {
                        return Err(central_sos_link::session::SessionError::new(
                            ErrorCode::SessionInvalidRequest,
                            "Resposta divergente",
                        ))
                    }
                },
                Err(e) if e.code == ErrorCode::SessionHelperUnavailable => {
                    std::thread::sleep(Duration::from_millis(250))
                }
                Err(e) => return Err(e),
            }
        }
    }

    fn service_main(_: Vec<OsString>) {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let Ok(handle) =
            service_control_handler::register("CentralSOSAgent", move |control| match control {
                ServiceControl::Stop | ServiceControl::Shutdown => {
                    flag.store(true, Ordering::SeqCst);
                    ServiceControlHandlerResult::NoError
                }
                ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
                _ => ServiceControlHandlerResult::NotImplemented,
            })
        else {
            return;
        };
        let status = |state, code| ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: state,
            controls_accepted: if state == ServiceState::Running {
                ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN
            } else {
                ServiceControlAccept::empty()
            },
            exit_code: ServiceExitCode::Win32(code),
            checkpoint: 0,
            wait_hint: Duration::from_secs(30),
            process_id: None,
        };
        if handle
            .set_service_status(status(ServiceState::Running, 0))
            .is_err()
        {
            return;
        }
        let result = check(&stop);
        // Fixed marker only: no username, token/SID, request/response, process or printer content.
        let report = match &result {
            Ok(()) => {
                serde_json::json!({"operation":"session.info","peerAuthenticated":true,"responseValidated":true,"status":"PASSED"})
            }
            Err(error) => {
                serde_json::json!({"operation":"session.info","status":"FAILED","code":error.code})
            }
        };
        let written = (|| -> std::io::Result<()> {
            use std::io::Write;
            let executable = std::env::current_exe()?;
            let _guard = windows::trusted_image(&executable)
                .map_err(|_| std::io::ErrorKind::PermissionDenied)?;
            let parent = executable
                .parent()
                .ok_or(std::io::ErrorKind::NotFound)?
                .to_owned();
            // create_new rejects an existing marker, including a pre-created hardlink/symlink.
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(parent.join("session-info-test.result.json"))?;
            file.write_all(serde_json::to_string(&report)?.as_bytes())?;
            file.sync_all()
        })();
        let code = if result.is_ok() && written.is_ok() {
            0
        } else {
            1
        };
        let _ = handle.set_service_status(status(ServiceState::Stopped, code));
    }

    pub fn run() -> windows_service::Result<()> {
        service_dispatcher::start("CentralSOSAgent", entry)
    }
}

fn main() {
    if std::env::args_os().len() != 1 {
        eprintln!("Harness session.info não aceita argumentos.");
        std::process::exit(1);
    }
    #[cfg(windows)]
    if let Err(error) = integration::run() {
        eprintln!("Harness exige execução pelo SCM: {error}");
        std::process::exit(1);
    }
    #[cfg(not(windows))]
    {
        eprintln!("Harness session.info exige Windows.");
        std::process::exit(1);
    }
}
