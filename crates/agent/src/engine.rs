use boa_engine::{
    builtins::promise::PromiseState, object::builtins::JsPromise, Context, JsNativeError, JsString,
    JsValue, NativeFunction, Source, Script,
};
use central_sos_link::protocol::{Command, Profile};
use std::cell::RefCell;
thread_local! {static ACTIVE:RefCell<Option<(Command,std::sync::Arc<std::sync::atomic::AtomicBool>,std::time::Instant,std::time::Instant)>>=const{RefCell::new(None)};}
fn json<T: serde::Serialize>(v: T) -> Result<serde_json::Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}
fn native(operation: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
    let (c, shutdown, deadline, server_expiry) = ACTIVE
        .with(|a| a.borrow().clone())
        .ok_or("Comando ausente")?;
    if shutdown.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("Agent encerrando; nenhuma nova operação será iniciada".into());
    }
    if std::time::Instant::now() >= server_expiry { return Err("EXPIRED_DURING_EXECUTION: nenhuma nova operação; efeito não será repetido".into()); }
    if std::time::Instant::now() >= deadline { return Err("TIMEOUT: nenhuma nova operação será iniciada; efeitos em andamento exigem conferência manual".into()); }
    if chrono::DateTime::parse_from_rfc3339(&c.expires_at).map_err(|_| "Expiração inválida")? <= chrono::Utc::now() { return Err("EXPIRED_DURING_EXECUTION: efeito não será repetido".into()); }
    let policy = central_sos_link::policy::command_policy(&c.r#type).ok_or("REJECTED")?;
    if policy.requires_interactive_user { return Err("USER_SESSION_REQUIRED".into()); }
    if !policy.native_operations.iter().any(|v| v == operation) {
        return Err("Operação não permitida para este comando".into());
    }
    let name = || -> Result<String, String> {
        let n = args
            .get("name")
            .and_then(|v| v.as_str())
            .ok_or("Impressora inválida")?;
        if n.is_empty() || n.encode_utf16().count() > 220 || n.chars().any(char::is_control) {
            return Err("Impressora inválida".into());
        }
        if c.r#type == "printer.auto_fix" && c.payload["printerName"].as_str() != Some(n) {
            return Err("Impressora divergente".into());
        }
        Ok(n.into())
    };
    use central_sos_core::services as s;
    match operation {
        "snapshot" => json(s::snapshot::collect_machine_snapshot_for_agent()),
        "installation" => {
            #[cfg(windows)]
            {
                json(s::installation::collect_for_agent())
            }
            #[cfg(not(windows))]
            {
                Err("Windows necessário".into())
            }
        }
        "diagnostic" => json(s::printer_diagnostics::diagnose(name()?)?),
        "startSpooler" => json(s::printer_spooler::action("start", false)?),
        "restartSpooler" => {
            if c.r#type == "printer.auto_fix" && s::printer_spooler::snapshot().state != Some(7) {
                return Err("Spooler não está comprovadamente pausado".into());
            }
            json(s::printer_spooler::action("restart", c.confirmed)?)
        }
        "resume" => {
            s::printer_operations::set_printer_paused(name()?, false)?;
            Ok(serde_json::Value::Null)
        }
        "cancelProblemJob" => {
            let id = args
                .get("id")
                .and_then(|v| v.as_u64())
                .and_then(|v| u32::try_from(v).ok())
                .filter(|v| *v > 0)
                .ok_or("Job inválido")?;
            json(s::printer_operations::cancel_problem_job(name()?, id)?)
        }
        "settle" => {
            std::thread::sleep(std::time::Duration::from_millis(250));
            Ok(serde_json::Value::Null)
        }
        "services" => {
            #[cfg(windows)]
            {
                let mut col = s::windows_services::collect();
                if let Some(n) = args["name"].as_str() {
                    col.items
                        .retain(|v| v.name.as_deref().is_some_and(|v| v.eq_ignore_ascii_case(n)));
                }
                json(col)
            }
            #[cfg(not(windows))]
            {
                Err("Windows necessário".into())
            }
        }
        _ => Err("REJECTED".into()),
    }
}
fn bridge(_: &JsValue, args: &[JsValue], context: &mut Context) -> boa_engine::JsResult<JsValue> {
    let op = args
        .first()
        .ok_or_else(|| JsNativeError::typ().with_message("Operação ausente"))?
        .to_string(context)?
        .to_std_string_escaped();
    let data = args
        .get(1)
        .ok_or_else(|| JsNativeError::typ().with_message("Payload ausente"))?
        .to_string(context)?
        .to_std_string_escaped();
    let parsed = serde_json::from_str(&data)
        .map_err(|_| JsNativeError::typ().with_message("JSON inválido"))?;
    let result = native(&op, parsed).map_err(|e| JsNativeError::typ().with_message(e))?;
    Ok(JsString::from(result.to_string()).into())
}
pub fn execute(
    c: &Command,
    profile: &Profile,
    shutdown: std::sync::Arc<std::sync::atomic::AtomicBool>,
    server_expiry: std::time::Instant,
) -> Result<serde_json::Value, String> {
    let policy = central_sos_link::policy::command_policy(&c.r#type).ok_or("REJECTED")?;
    let profile_name = match profile { Profile::SERVER => "SERVER", Profile::TERMINAL => "TERMINAL" };
    if !policy.allowed_device_profiles.iter().any(|v| v == profile_name) { return Err("REJECTED: perfil não permitido".into()); }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(policy.timeout);
    ACTIVE.with(|a| *a.borrow_mut() = Some((c.clone(), shutdown, deadline, server_expiry)));
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            ACTIVE.with(|a| *a.borrow_mut() = None);
        }
    }
    let _reset = Reset;
    let mut context = Context::default();
    context
        .register_global_callable(
            JsString::from("__centralNative"),
            2,
            NativeFunction::from_fn_ptr(bridge),
        )
        .map_err(|e| e.to_string())?;
    let promise = call_rules(&mut context, &c.r#type, &c.payload, profile_name)?;
    let promise = JsPromise::from_object(
        promise
            .as_object()
            .ok_or("Resultado não é promise")?
            .clone(),
    )
    .map_err(|e| e.to_string())?;
    context.run_jobs();
    match promise.state() {
        PromiseState::Fulfilled(_) if std::time::Instant::now() >= server_expiry => Err("EXPIRED_DURING_EXECUTION: não repetir efeitos".into()),
        PromiseState::Fulfilled(_) if std::time::Instant::now() >= deadline => Err("TIMEOUT: operação excedeu limite; não repetir efeitos".into()),
        PromiseState::Fulfilled(_) if chrono::DateTime::parse_from_rfc3339(&c.expires_at).map_err(|_| "Expiração inválida")? <= chrono::Utc::now() => Err("EXPIRED_DURING_EXECUTION: não repetir efeitos".into()),
        PromiseState::Fulfilled(v) => serde_json::from_str(
            &v.to_string(&mut context)
                .map_err(|e| e.to_string())?
                .to_std_string_escaped(),
        )
        .map_err(|e| e.to_string()),
        PromiseState::Rejected(v) => Err(v
            .to_string(&mut context)
            .map_err(|e| e.to_string())?
            .to_std_string_escaped()),
        PromiseState::Pending => {
            Err("Regras não finalizaram; nenhuma nova tentativa de efeito será realizada".into())
        }
    }
}
fn call_rules(context: &mut Context, kind: &str, payload: &serde_json::Value, profile: &str) -> Result<JsValue, String> {
    // Only immutable, build-time source is parsed. Remote values are JS data, never source code.
    Script::parse(Source::from_bytes(include_str!(concat!(env!("OUT_DIR"), "/rules.js"))), None, context)
        .and_then(|script| script.evaluate(context)).map_err(|e| e.to_string())?;
    for name in ["eval", "Function"] {
        context.global_object().delete_property_or_throw(JsString::from(name), context).map_err(|e| e.to_string())?;
    }
    let namespace = context.global_object().get(JsString::from("CentralAgentRules"), context).map_err(|e| e.to_string())?;
    let namespace = namespace.as_object().ok_or("Rules ausentes")?;
    let function = namespace.get(JsString::from("executeAgentRules"), context).map_err(|e| e.to_string())?;
    let payload = JsValue::from_json(payload, context).map_err(|e| e.to_string())?;
    function.as_object().ok_or("Entrypoint ausente")?.call(&JsValue::undefined(), &[JsString::from(kind).into(), payload, JsString::from(profile).into()], context).map_err(|e| e.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn embedded_typescript_executes_in_boa_without_windows_calls() {
        let mut context = Context::default();
        Script::parse(Source::from_bytes(r#"function __centralNative(operation,args){if(operation!=='services')throw Error('unexpected effect');return JSON.stringify({items:[{name:JSON.parse(args).name,state:'Running'}],error:null});}"#), None, &mut context).unwrap().evaluate(&mut context).unwrap();
        let value = call_rules(&mut context, "service.check", &serde_json::json!({"name":"Spooler"}), "TERMINAL").unwrap();
        let promise = JsPromise::from_object(value.as_object().unwrap().clone()).unwrap();
        context.run_jobs();
        match promise.state() {
            PromiseState::Fulfilled(value) => {
                let result: serde_json::Value = serde_json::from_str(
                    &value
                        .to_string(&mut context)
                        .unwrap()
                        .to_std_string_escaped(),
                )
                .unwrap();
                assert_eq!(result["items"][0]["name"], "Spooler");
            }
            _ => panic!("embedded rules did not complete"),
        }
        assert!(context.global_object().get(JsString::from("eval"), &mut context).unwrap().is_undefined());
        assert!(context.global_object().get(JsString::from("Function"), &mut context).unwrap().is_undefined());
        let hostile = "Spooler');throw Error('remote code');('";
        let value = call_rules(&mut context, "service.check", &serde_json::json!({"name":hostile}), "TERMINAL").unwrap();
        let promise=JsPromise::from_object(value.as_object().unwrap().clone()).unwrap(); context.run_jobs();
        match promise.state() {
            PromiseState::Fulfilled(value) => {
                let result:serde_json::Value=serde_json::from_str(&value.to_string(&mut context).unwrap().to_std_string_escaped()).unwrap();
                assert_eq!(result["items"][0]["name"],hostile);
            }
            _ => panic!("payload was interpreted as code rather than data"),
        }
    }
    #[test]
    fn timeout_expiry_and_session_guard_precede_any_native_effect() {
        let now = chrono::Utc::now();
        let mut command = Command { protocol_version: 1, id:"fixture".into(), device_id:"device".into(), r#type:"spooler.restart".into(), payload:serde_json::json!({}), confirmed:true, requested_by:"subject".into(), created_at:now.to_rfc3339(), expires_at:(now+chrono::Duration::seconds(60)).to_rfc3339(), status:"RUNNING".into(), started_at:None, finished_at:None };
        let shutdown=std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        ACTIVE.with(|a| *a.borrow_mut()=Some((command.clone(),shutdown.clone(),std::time::Instant::now()-std::time::Duration::from_secs(1),std::time::Instant::now()+std::time::Duration::from_secs(60))));
        assert!(native("restartSpooler",serde_json::json!({})).unwrap_err().starts_with("TIMEOUT"));
        command.expires_at=(now-chrono::Duration::seconds(1)).to_rfc3339();
        ACTIVE.with(|a| *a.borrow_mut()=Some((command.clone(),shutdown.clone(),std::time::Instant::now()+std::time::Duration::from_secs(60),std::time::Instant::now()+std::time::Duration::from_secs(60))));
        assert!(native("restartSpooler",serde_json::json!({})).unwrap_err().starts_with("EXPIRED_DURING_EXECUTION"));
        command.expires_at=(now+chrono::Duration::seconds(60)).to_rfc3339(); command.r#type="printer.auto_fix".into();
        ACTIVE.with(|a| *a.borrow_mut()=Some((command,shutdown,std::time::Instant::now()+std::time::Duration::from_secs(60),std::time::Instant::now()+std::time::Duration::from_secs(60))));
        assert_eq!(native("resume",serde_json::json!({"name":"unobservable"})).unwrap_err(), "USER_SESSION_REQUIRED");
        ACTIVE.with(|a| *a.borrow_mut()=None);
    }
}
