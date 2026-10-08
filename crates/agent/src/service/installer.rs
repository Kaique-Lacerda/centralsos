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

fn configuration() -> Result<ServiceInfo, String> {
    Ok(ServiceInfo {
        name: NAME.into(),
        display_name: "CENTRAL SOS Agent".into(),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: std::env::current_exe().map_err(|_| "INSTALL_IMAGE_UNAVAILABLE")?,
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
pub fn installer_command() -> Result<(), String> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 1 {
        return Err("INSTALL_ARGUMENTS_REJECTED".into());
    }
    let command = args[0].to_str().ok_or("INSTALL_ARGUMENTS_REJECTED")?;
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
    win::administrative_installer().map_err(|_| "INSTALL_ADMIN_REQUIRED")?;
    let _images = win::installation_images().map_err(|_| "INSTALL_TRUST_REJECTED")?;
    let expected = configuration()?;
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
        Err(error) if missing(&error) && command == "--uninstall-service" => return Ok(()),
        Err(_) => return Err("SCM_SERVICE_UNAVAILABLE".into()),
    };
    let config = scm(service.query_config())?;
    if !matches_install(&config, &expected.executable_path) {
        return Err("SCM_FOREIGN_CONFIGURATION_REJECTED".into());
    }
    let state = scm(service.query_status())?.current_state;
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
        "--uninstall-service" => {
            if state != ServiceState::Stopped {
                return Err("SCM_STOP_REQUIRED".into());
            }
            scm(service.delete())?;
        }
        "--start-service" if state == ServiceState::Stopped => scm(service.start::<OsString>(&[]))?,
        "--start-service" if state == ServiceState::Running => {}
        "--stop-service" if state == ServiceState::Running => {
            scm(service.stop())?;
            wait_stopped(&service)?;
        }
        "--stop-service" if state == ServiceState::StopPending => wait_stopped(&service)?,
        "--stop-service" if state == ServiceState::Stopped => {}
        "--service-status" => println!(
            "{}",
            serde_json::json!({"service":NAME,"state":format!("{state:?}")})
        ),
        _ => return Err("SCM_TRANSITION_REJECTED".into()),
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
        config.executable_path = PathBuf::from(format!("\"{}\" --arbitrary", image.display()));
        assert!(!matches_install(&config, &image));
        config.executable_path = image.clone();
        config.account_name = Some("user".into());
        assert!(!matches_install(&config, &image));
        config.account_name = Some("LocalSystem".into());
        config.service_type = ServiceType::SHARE_PROCESS;
        assert!(!matches_install(&config, &image));
    }
}
