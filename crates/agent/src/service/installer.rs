//! Explicit local administrative entrypoints for PR #21. Never called by dispatch/build/tests.
use super::NAME;
use central_sos_link::session::windows::lifecycle as win;
use std::{
    ffi::OsString,
    time::{Duration, Instant},
};
use windows_service::{
    service::*,
    service_manager::{ServiceManager, ServiceManagerAccess},
    Error,
};

#[cfg(test)]
fn configuration() -> Result<ServiceInfo, String> {
    configuration_at(std::env::current_exe().map_err(|_| "INSTALL_IMAGE_UNAVAILABLE")?)
}
fn configuration_at(image: std::path::PathBuf) -> Result<ServiceInfo, String> {
    Ok(ServiceInfo {
        name: NAME.into(),
        display_name: "CENTRAL SOS Agent".into(),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: image,
        launch_arguments: vec![],
        dependencies: vec![],
        account_name: None,
        account_password: None,
    })
}
fn recovery() -> ServiceFailureActions {
    ServiceFailureActions {
        reset_period: ServiceFailureResetPeriod::After(Duration::from_secs(86_400)),
        reboot_msg: Some(OsString::new()),
        command: Some(OsString::new()),
        actions: Some(
            [10, 30, 60]
                .map(|seconds| ServiceAction {
                    action_type: ServiceActionType::Restart,
                    delay: Duration::from_secs(seconds),
                })
                .into(),
        ),
    }
}
fn matches_recovery(actual: &ServiceFailureActions) -> bool {
    let expected = recovery();
    actual.reset_period == expected.reset_period
        && actual.actions == expected.actions
        && actual
            .command
            .as_ref()
            .is_none_or(|command| command.is_empty())
        && actual
            .reboot_msg
            .as_ref()
            .is_none_or(|message| message.is_empty())
}
fn matches_install(config: &ServiceConfig, image: &std::path::Path) -> bool {
    let path = config.executable_path.to_string_lossy();
    // SCM stores a quoted command line for paths with spaces; no arguments are permitted.
    let fixed = format!("\"{}\"", image.display());
    (path.eq_ignore_ascii_case(&fixed) || path.eq_ignore_ascii_case(&image.to_string_lossy()))
        && config.service_type == ServiceType::OWN_PROCESS
        && config
            .account_name
            .as_ref()
            .is_some_and(|a| a.to_string_lossy().eq_ignore_ascii_case("LocalSystem"))
        && config.dependencies.is_empty()
}
fn missing(error: &Error) -> bool {
    matches!(error, Error::Winapi(e) if e.raw_os_error() == Some(1060))
}
fn scm<T>(result: windows_service::Result<T>) -> Result<T, String> {
    result.map_err(|_| "SCM_OPERATION_FAILED".into())
}
fn wait_stopped(service: &Service) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if scm(service.query_status())?.current_state == ServiceState::Stopped {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("SCM_STOP_TIMEOUT".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn requires_helper(command: &str) -> bool {
    matches!(command, "--install-service" | "--start-service")
}
fn authorize_images<A, H>(
    command: &str,
    authorize: impl FnOnce() -> Result<(), String>,
    agent: impl FnOnce() -> Result<A, String>,
    images: impl FnOnce() -> Result<H, String>,
) -> Result<(A, Option<H>), String> {
    authorize()?;
    let agent = agent()?;
    let helper = if requires_helper(command) {
        Some(images()?)
    } else {
        None
    };
    Ok((agent, helper))
}

// The recovery controller is shared by the real SCM adapter and failure-injection tests.
// No automatic rollback: an interrupted provisioning step leaves an inspectable installation.
trait RecoveryService {
    type Guard;
    fn verify(&self) -> Result<(ServiceState, Self::Guard), String>;
    fn stop(&self) -> Result<(), String>;
    fn wait_stopped(&self) -> Result<(), String>;
    fn delete(&self) -> Result<(), String>;
    fn wait_process_exit(&self, _guard: &Self::Guard) -> Result<(), String> {
        Ok(())
    }
}
struct CheckedService<'a> {
    service: &'a Service,
    image: &'a std::path::Path,
}
impl RecoveryService for CheckedService<'_> {
    type Guard = Option<win::ServiceProcess>;
    fn verify(&self) -> Result<(ServiceState, Self::Guard), String> {
        let config = scm(self.service.query_config())?;
        if !matches_install(&config, self.image) {
            return Err("SCM_FOREIGN_CONFIGURATION_REJECTED".into());
        }
        let status = scm(self.service.query_status())?;
        if status.service_type != ServiceType::OWN_PROCESS {
            return Err("SCM_FOREIGN_CONFIGURATION_REJECTED".into());
        }
        let pid = status.process_id.filter(|pid| *pid != 0);
        if (status.current_state == ServiceState::Stopped && pid.is_some())
            || (status.current_state == ServiceState::Running && pid.is_none())
        {
            return Err("SCM_PROCESS_IDENTITY_REJECTED".into());
        }
        let process = pid
            .map(|pid| win::administrative_service_process_at(pid, self.image))
            .transpose()
            .map_err(|_| "SCM_PROCESS_IDENTITY_REJECTED")?;
        Ok((status.current_state, process))
    }
    fn stop(&self) -> Result<(), String> {
        scm(self.service.stop()).map(|_| ())
    }
    fn wait_stopped(&self) -> Result<(), String> {
        wait_stopped(self.service)
    }
    fn delete(&self) -> Result<(), String> {
        scm(self.service.delete())
    }
    fn wait_process_exit(&self, guard: &Self::Guard) -> Result<(), String> {
        if let Some(process) = guard {
            process
                .wait_exit()
                .map_err(|_| "SCM_PROCESS_EXIT_TIMEOUT")?;
        }
        Ok(())
    }
}

fn recover<S: RecoveryService>(command: &str, service: Option<&S>) -> Result<String, String> {
    if !matches!(
        command,
        "--stop-service" | "--uninstall-service" | "--service-status"
    ) {
        return Err("INSTALL_ARGUMENTS_REJECTED".into());
    }
    let Some(service) = service else {
        return Ok("Absent".into());
    };
    // Pin any running SCM process through the operation; never act on a caller-provided PID.
    let (state, _process) = service.verify()?;
    match command {
        "--service-status" => return Ok(format!("{state:?}")),
        "--uninstall-service" => {
            if state != ServiceState::Stopped {
                return Err("SCM_STOP_REQUIRED".into());
            }
            let (fresh, _guard) = service.verify()?;
            if fresh != ServiceState::Stopped {
                return Err("SCM_STOP_REQUIRED".into());
            }
            service.delete()?;
            return Ok("Absent".into());
        }
        "--stop-service" => match state {
            ServiceState::Running => {
                let (fresh, _guard) = service.verify()?;
                if fresh != ServiceState::Running {
                    return Err("SCM_TRANSITION_REJECTED".into());
                }
                service.stop()?;
                service.wait_stopped()?;
            }
            ServiceState::StopPending => service.wait_stopped()?,
            ServiceState::Stopped => {}
            _ => return Err("SCM_TRANSITION_REJECTED".into()),
        },
        _ => unreachable!(),
    }
    let (fresh, _guard) = service.verify()?;
    if fresh != ServiceState::Stopped {
        return Err("SCM_STOP_REQUIRED".into());
    }
    service.wait_process_exit(&_process)?;
    Ok("Stopped".into())
}
pub fn installer_command() -> Result<(), String> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 1 {
        return Err("INSTALL_ARGUMENTS_REJECTED".into());
    }
    let command = args[0].to_str().ok_or("INSTALL_ARGUMENTS_REJECTED")?;
    if [
        "--installer-prepare",
        "--installer-commit",
        "--installer-rollback",
        "--installer-uninstall",
        "--installer-status",
    ]
    .contains(&command)
    {
        return crate::installation::native::execute(command);
    }
    if ![
        "--install-service",
        "--uninstall-service",
        "--start-service",
        "--stop-service",
        "--service-status",
    ]
    .contains(&command)
    {
        return Err("INSTALL_ARGUMENTS_REJECTED".into());
    }
    run_service_command(
        command,
        &std::env::current_exe().map_err(|_| "INSTALL_IMAGE_UNAVAILABLE")?,
    )
}
pub(crate) fn run_service_command(command: &str, image: &std::path::Path) -> Result<(), String> {
    if ![
        "--install-service",
        "--uninstall-service",
        "--start-service",
        "--stop-service",
        "--service-status",
    ]
    .contains(&command)
    {
        return Err("INSTALL_ARGUMENTS_REJECTED".into());
    }
    let _images = authorize_images(
        command,
        || win::administrative_installer().map_err(|_| "INSTALL_ADMIN_REQUIRED".into()),
        || win::installation_agent_image().map_err(|_| "INSTALL_TRUST_REJECTED".into()),
        || win::installation_images().map_err(|_| "INSTALL_TRUST_REJECTED".into()),
    )?;
    let expected = configuration_at(image.into())?;
    let manager = scm(ServiceManager::local_computer(
        None::<&str>,
        ServiceManagerAccess::CONNECT
            | if command == "--install-service" {
                ServiceManagerAccess::CREATE_SERVICE
            } else {
                ServiceManagerAccess::empty()
            },
    ))?;
    let access = ServiceAccess::QUERY_CONFIG
        | ServiceAccess::QUERY_STATUS
        | match command {
            "--install-service" => ServiceAccess::CHANGE_CONFIG | ServiceAccess::START,
            "--uninstall-service" => ServiceAccess::DELETE,
            "--start-service" => ServiceAccess::START,
            "--stop-service" => ServiceAccess::STOP,
            _ => ServiceAccess::empty(),
        };
    let service = match manager.open_service(NAME, access) {
        Ok(service) => service,
        Err(error) if missing(&error) && command == "--install-service" => {
            scm(manager.create_service(&expected, access))?
        }
        Err(error) if missing(&error) && !requires_helper(command) => {
            let state = recover::<CheckedService<'_>>(command, None)?;
            if command == "--service-status" {
                println!("{}", serde_json::json!({"service":NAME,"state":state}));
            }
            return Ok(());
        }
        Err(_) => return Err("SCM_SERVICE_UNAVAILABLE".into()),
    };
    let checked = CheckedService {
        service: &service,
        image: &expected.executable_path,
    };
    if !requires_helper(command) {
        let state = recover(command, Some(&checked))?;
        if command == "--service-status" {
            println!("{}", serde_json::json!({"service":NAME,"state":state}));
        }
        return Ok(());
    }
    let (state, _process) = checked.verify()?;
    let config = scm(service.query_config())?;
    if !matches_install(&config, &expected.executable_path) {
        return Err("SCM_FOREIGN_CONFIGURATION_REJECTED".into());
    }
    match command {
        "--install-service" => {
            if state != ServiceState::Stopped {
                if state == ServiceState::Running
                    && config.start_type == ServiceStartType::AutoStart
                    && matches_recovery(&scm(service.get_failure_actions())?)
                    && scm(service.get_failure_actions_on_non_crash_failures())?
                {
                    return Ok(());
                }
                return Err("SCM_STOP_REQUIRED".into());
            }
            scm(service.change_config(&expected))?;
            scm(service.update_failure_actions(recovery()))?;
            scm(service.set_failure_actions_on_non_crash_failures(true))?;
        }
        "--start-service" if state == ServiceState::Stopped => scm(service.start::<OsString>(&[]))?,
        "--start-service" if state == ServiceState::Running => {}
        _ => return Err("SCM_TRANSITION_REJECTED".into()),
    }
    Ok(())
}
pub(crate) fn observe_service(
    image: &std::path::Path,
) -> Result<crate::installation::ServiceSnapshot, String> {
    use crate::installation::{ServiceSnapshot, StartMode, State};
    let manager = scm(ServiceManager::local_computer(
        None::<&str>,
        ServiceManagerAccess::CONNECT,
    ))?;
    let service = match manager.open_service(
        NAME,
        ServiceAccess::QUERY_CONFIG | ServiceAccess::QUERY_STATUS,
    ) {
        Ok(service) => service,
        Err(error) if missing(&error) => {
            return Ok(ServiceSnapshot {
                state: State::Absent,
                start_mode: None,
            })
        }
        Err(_) => return Err("SCM_SERVICE_UNAVAILABLE".into()),
    };
    let checked = CheckedService {
        service: &service,
        image,
    };
    let (state, _process) = checked.verify()?;
    let config = scm(service.query_config())?;
    if !matches_install(&config, image) {
        return Err("SCM_FOREIGN_CONFIGURATION_REJECTED".into());
    }
    let start_mode = match config.start_type {
        ServiceStartType::AutoStart => StartMode::Automatic,
        ServiceStartType::OnDemand => StartMode::Manual,
        ServiceStartType::Disabled => StartMode::Disabled,
        _ => return Err("SCM_FOREIGN_CONFIGURATION_REJECTED".into()),
    };
    let state = match state {
        ServiceState::Stopped => State::Stopped,
        ServiceState::Running => State::Running,
        _ => return Err("SCM_TRANSITION_PENDING".into()),
    };
    Ok(ServiceSnapshot {
        state,
        start_mode: Some(start_mode),
    })
}
pub(crate) fn set_start_mode(
    image: &std::path::Path,
    mode: crate::installation::StartMode,
) -> Result<(), String> {
    win::administrative_installer().map_err(|_| "INSTALL_ADMIN_REQUIRED")?;
    let _agent = win::installation_agent_image().map_err(|_| "INSTALL_TRUST_REJECTED")?;
    let manager = scm(ServiceManager::local_computer(
        None::<&str>,
        ServiceManagerAccess::CONNECT,
    ))?;
    let service = match manager.open_service(
        NAME,
        ServiceAccess::QUERY_CONFIG | ServiceAccess::QUERY_STATUS | ServiceAccess::CHANGE_CONFIG,
    ) {
        Ok(service) => service,
        Err(error) if missing(&error) => return Ok(()),
        Err(_) => return Err("SCM_SERVICE_UNAVAILABLE".into()),
    };
    let checked = CheckedService {
        service: &service,
        image,
    };
    let (_state, _process) = checked.verify()?;
    let mut config = configuration_at(image.into())?;
    config.start_type = match mode {
        crate::installation::StartMode::Automatic => ServiceStartType::AutoStart,
        crate::installation::StartMode::Manual => ServiceStartType::OnDemand,
        crate::installation::StartMode::Disabled => ServiceStartType::Disabled,
    };
    scm(service.change_config(&config))
}
pub(crate) fn verify_running_configuration(image: &std::path::Path) -> Result<(), String> {
    let manager = scm(ServiceManager::local_computer(
        None::<&str>,
        ServiceManagerAccess::CONNECT,
    ))?;
    let service = scm(manager.open_service(
        NAME,
        ServiceAccess::QUERY_CONFIG | ServiceAccess::QUERY_STATUS,
    ))?;
    let checked = CheckedService {
        service: &service,
        image,
    };
    let (state, _process) = checked.verify()?;
    let config = scm(service.query_config())?;
    if state != ServiceState::Running
        || config.start_type != ServiceStartType::AutoStart
        || !matches_install(&config, image)
        || !matches_recovery(&scm(service.get_failure_actions())?)
        || !scm(service.get_failure_actions_on_non_crash_failures())?
    {
        return Err("SCM_FINAL_CONFIGURATION_REJECTED".into());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    #[test]
    fn recovery_rerun_accepts_scm_empty_or_null_fields_without_external_commands() {
        let mut actual = recovery();
        assert!(matches_recovery(&actual));
        actual.command = None;
        actual.reboot_msg = None;
        assert!(matches_recovery(&actual));
        actual.command = Some("arbitrary.exe".into());
        assert!(!matches_recovery(&actual));
        actual = recovery();
        actual.actions.as_mut().unwrap()[0].action_type = ServiceActionType::RunCommand;
        assert!(!matches_recovery(&actual));
    }
    #[test]
    fn installer_contract_is_fixed_system_automatic_without_secrets_or_arguments() {
        let info = configuration().unwrap();
        assert_eq!(info.name, NAME);
        assert_eq!(info.start_type, ServiceStartType::AutoStart);
        assert_eq!(info.service_type, ServiceType::OWN_PROCESS);
        assert!(info.launch_arguments.is_empty() && info.dependencies.is_empty());
        assert!(info.account_name.is_none() && info.account_password.is_none());
        let recovery = recovery();
        assert!(recovery.command.unwrap().is_empty());
        assert!(recovery
            .actions
            .unwrap()
            .iter()
            .all(|a| a.action_type == ServiceActionType::Restart));
    }
    #[test]
    fn installer_refuses_foreign_image_arguments_account_and_service_type() {
        let image = PathBuf::from(r"C:\Managed\central-sos-agent.exe");
        let mut config = ServiceConfig {
            service_type: ServiceType::OWN_PROCESS,
            start_type: ServiceStartType::AutoStart,
            error_control: ServiceErrorControl::Normal,
            executable_path: PathBuf::from(format!("\"{}\"", image.display())),
            load_order_group: None,
            tag_id: 0,
            dependencies: vec![],
            account_name: Some("LocalSystem".into()),
            display_name: NAME.into(),
        };
        assert!(matches_install(&config, &image));
        config.executable_path = PathBuf::from(r"C:\OtherInstallation\central-sos-agent.exe");
        assert!(!matches_install(&config, &image));
        config.executable_path = PathBuf::from(format!("\"{}\" --arbitrary", image.display()));
        assert!(!matches_install(&config, &image));
        config.executable_path = image.clone();
        config.account_name = Some("user".into());
        assert!(!matches_install(&config, &image));
        config.account_name = Some("LocalSystem".into());
        config
            .dependencies
            .push(ServiceDependency::Service("ForeignService".into()));
        assert!(!matches_install(&config, &image));
        config.dependencies.clear();
        config.service_type = ServiceType::SHARE_PROCESS;
        assert!(!matches_install(&config, &image));
    }
}

#[cfg(test)]
#[path = "installer/recovery_tests.rs"]
mod recovery_tests;
