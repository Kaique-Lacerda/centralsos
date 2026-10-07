use crate::models::{support::ServiceActionResult, windows_service::WindowsServiceSnapshot};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
static ACTION: Mutex<()> = Mutex::new(());
pub fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.len() > 256
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-. ".contains(&b))
    {
        Err("Nome interno de serviço inválido.".into())
    } else {
        Ok(())
    }
}
pub fn automatic_service(service: &WindowsServiceSnapshot) -> bool {
    let name = service.name.as_deref().unwrap_or("").to_ascii_lowercase();
    let path = service
        .path_name
        .as_deref()
        .unwrap_or("")
        .to_ascii_lowercase();
    name == "spooler"
        || name.starts_with("firebird")
            && (path.contains("fbserver.exe")
                || path.contains("fbguard.exe")
                || path.contains("firebird.exe"))
        || name.starts_with("cobian") && path.contains("cobian")
}
pub fn policy(
    service: &WindowsServiceSnapshot,
    action: &str,
    confirmed: bool,
) -> Result<(), String> {
    let name = service.name.as_deref().unwrap_or("").to_ascii_lowercase();
    validate_name(&name)?;
    if !matches!(action, "start" | "restart" | "stop") {
        return Err("Ação de serviço inválida.".into());
    }
    if [
        "rpcss",
        "rpceptmapper",
        "dcomlaunch",
        "eventlog",
        "winmgmt",
        "plugplay",
        "power",
        "samss",
        "lsm",
        "nsi",
        "bfe",
        "mpssvc",
        "windefend",
        "securityhealthservice",
    ]
    .contains(&name.as_str())
    {
        return Err("Serviço essencial protegido; use a administração do Windows.".into());
    }
    if service
        .start_mode
        .as_deref()
        .is_some_and(|s| s.eq_ignore_ascii_case("disabled"))
    {
        return Err("Serviço desabilitado. A inicialização não será modificada.".into());
    }
    if !matches!(service.state.as_deref(), Some("Running" | "Stopped")) {
        return Err(
            "Estado do serviço transitório ou desconhecido; consulte novamente antes de agir."
                .into(),
        );
    }
    if !confirmed
        && !(action == "start"
            && automatic_service(service)
            && service.state.as_deref() == Some("Stopped"))
    {
        return Err(
            "Confirme a ação neste serviço; pode interromper aplicações e conexões.".into(),
        );
    }
    Ok(())
}
fn find(name: &str) -> Result<WindowsServiceSnapshot, String> {
    let col = crate::services::windows_services::collect();
    if let Some(e) = col.error {
        return Err(e);
    }
    col.items
        .into_iter()
        .find(|s| {
            s.name
                .as_deref()
                .is_some_and(|n| n.eq_ignore_ascii_case(name))
        })
        .ok_or_else(|| "Serviço não encontrado.".into())
}
pub fn action(
    name: String,
    action: String,
    confirmed: bool,
) -> Result<ServiceActionResult, String> {
    validate_name(&name)?;
    super::elevated()?;
    let _guard = ACTION
        .try_lock()
        .map_err(|_| "Outra ação de serviço está em andamento.".to_string())?;
    let before = find(&name)?;
    if action == "start" && automatic_service(&before) && before.state.as_deref() == Some("Running")
    {
        return Ok(ServiceActionResult {
            before: before.clone(),
            after: before,
            message: "Serviço já está em execução; nada foi alterado.".into(),
        });
    }
    policy(&before, &action, confirmed)?;
    let c = wmi::WMIConnection::new().map_err(|e| e.to_string())?;
    let object = format!("Win32_Service.Name=\"{name}\"");
    let method = |method: &str| -> Result<(), String> {
        let result = c
            .exec_method(&object, method, None)
            .map_err(|e| e.to_string())?
            .ok_or("O Windows não retornou o resultado da ação.")?
            .get_property("ReturnValue")
            .map_err(|e| e.to_string())?;
        match result {
            wmi::Variant::UI4(0) | wmi::Variant::I4(0) => Ok(()),
            v => Err(format!(
                "{method} retornou {v:?}. Nenhuma configuração de inicialização foi alterada."
            )),
        }
    };
    let wait = |state: &str| -> Result<WindowsServiceSnapshot, String> {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let s = find(&name)?;
            if s.state.as_deref() == Some(state) {
                return Ok(s);
            }
            if Instant::now() > deadline {
                return Err(format!(
                    "Tempo limite ao aguardar {state}; consulte novamente o serviço."
                ));
            }
            std::thread::sleep(Duration::from_millis(350))
        }
    };
    if action != "start" && before.state.as_deref() != Some("Stopped") {
        method("StopService")?;
        if let Err(e) = wait("Stopped") {
            return Err(format!(
                "{e} O serviço pode ter parado; verifique o estado antes de repetir."
            ));
        }
    }
    let after = if action == "stop" {
        wait("Stopped")?
    } else {
        if before.state.as_deref() != Some("Running") || action == "restart" {
            method("StartService").map_err(|e| format!("{e} O serviço pode permanecer parado."))?
        }
        wait("Running")?
    };
    Ok(ServiceActionResult {
        before,
        after,
        message: "Estado consultado novamente após a ação.".into(),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn s() -> WindowsServiceSnapshot {
        WindowsServiceSnapshot {
            name: Some("FirebirdServerDefaultInstance".into()),
            display_name: None,
            state: Some("Stopped".into()),
            start_mode: Some("Auto".into()),
            status: None,
            path_name: Some(r"C:\Firebird\fbserver.exe".into()),
            description: None,
            start_name: None,
        }
    }
    #[test]
    fn safe_service_policy() {
        let mut v = s();
        assert!(policy(&v, "start", false).is_ok());
        v.path_name = Some(r"C:\Firebird\firebird.exe".into());
        assert!(policy(&v, "start", false).is_ok());
        assert!(policy(&v, "restart", false).is_err());
        assert!(policy(&v, "stop", true).is_ok());
        v.start_mode = Some("Disabled".into());
        assert!(policy(&v, "start", true).is_err());
        v = s();
        v.name = Some("RpcSs".into());
        assert!(policy(&v, "stop", true).is_err());
        assert!(validate_name("x\";cmd").is_err())
    }
    #[test]
    fn structural_services_deny_every_mutation() {
        for name in [
            "RpcSs",
            "RpcEptMapper",
            "DcomLaunch",
            "EventLog",
            "LSM",
            "SamSs",
            "Winmgmt",
            "BFE",
            "MpsSvc",
            "WinDefend",
        ] {
            for action in ["start", "stop", "restart"] {
                let mut service = s();
                service.name = Some(name.into());
                service.state = Some(
                    if action == "start" {
                        "Stopped"
                    } else {
                        "Running"
                    }
                    .into(),
                );
                for confirmed in [false, true] {
                    assert!(
                        policy(&service, action, confirmed).is_err(),
                        "{name}: {action}"
                    );
                }
            }
        }
    }
}
