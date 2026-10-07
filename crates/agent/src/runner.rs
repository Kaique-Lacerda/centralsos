use crate::journal::{Journal, Receipt};
use central_sos_link::{protocol::*, vault, Transport};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::Receiver,
        Arc,
    },
    time::Duration,
};
fn heartbeat(shutdown: Arc<AtomicBool>) {
    let mut attempts = 0;
    while !shutdown.load(Ordering::SeqCst) {
        let send = || -> Result<(), central_sos_link::HttpFailure> {
            let Some(link) = vault::load()? else {
                return Ok(());
            };
            let meta = central_sos_core::services::agent_metadata::collect();
            let health = std::fs::read(vault::root()?.join("health.json"))
                .ok()
                .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok());
            let _: serde_json::Value = Transport::new(&link.backend)?.request_detailed(reqwest::Method::POST, "/api/agent/heartbeat", Some(&link.enrollment.credential), Some(&serde_json::json!({"deviceId":link.enrollment.device_id,"timestamp":chrono::Utc::now().to_rfc3339(),"hostname":meta.hostname,"profile":link.enrollment.profile,"appVersion":link.app_version,"agentVersion":env!("CARGO_PKG_VERSION"),"coreVersion":central_sos_core::CORE_VERSION,"protocolVersion":central_sos_link::policy::PROTOCOL_VERSION,"osVersion":meta.os_version,"uptime":meta.uptime,"localIp":meta.local_ip,"healthSummary":health.filter(|v|v["deviceId"].as_str()==Some(&link.enrollment.device_id)&&v["at"].as_str().and_then(|t|chrono::DateTime::parse_from_rfc3339(t).ok()).is_some_and(|t|(0..600).contains(&chrono::Utc::now().signed_duration_since(t).num_seconds()))).and_then(|v|v.get("summary").cloned())})))?;
            vault::atomic_write(
                "status.json",
                &serde_json::to_vec(&CommunicationStatus {
                    agent_version: Some(env!("CARGO_PKG_VERSION").into()),
                    core_version: Some(central_sos_core::CORE_VERSION.into()),
                    protocol_version: Some(central_sos_link::policy::PROTOCOL_VERSION),
                    last_communication: Some(chrono::Utc::now().to_rfc3339()),
                    device_id: Some(link.enrollment.device_id.clone()),
                })
                .map_err(|e| e.to_string())?,
            )?;
            Ok(())
        };
        let delay = match send() {
            Ok(()) => {
                attempts = 0;
                central_sos_link::retry_delay(30, 0, None, central_sos_link::jitter()).as_secs()
            }
            Err(error) => {
                attempts += 1;
                crate::logging::event(
                    "agent.heartbeat_failed",
                    serde_json::json!({"attempt":attempts}),
                );
                central_sos_link::retry_delay(30, attempts - 1, Some(&error), central_sos_link::jitter()).as_secs()
            }
        };
        for _ in 0..delay {
            if shutdown.load(Ordering::SeqCst) {
                return;
            }
            std::thread::sleep(Duration::from_secs(1));
        }
    }
}
pub fn run(stop: Receiver<()>, shutdown: Arc<AtomicBool>) -> Result<(), String> {
    let root = vault::secure_root()?;
    let mut journal: Option<(String, Journal)> = None;
    let flag = shutdown.clone();
    let worker = std::thread::spawn(move || heartbeat(flag));
    struct Guard {
        flag: Arc<AtomicBool>,
        worker: Option<std::thread::JoinHandle<()>>,
    }
    impl Drop for Guard {
        fn drop(&mut self) {
            self.flag.store(true, Ordering::SeqCst);
            if let Some(w) = self.worker.take() {
                let _ = w.join();
            }
        }
    }
    let _guard = Guard {
        flag: shutdown.clone(),
        worker: Some(worker),
    };
    let mut attempts = 0;
    loop {
        if shutdown.load(Ordering::SeqCst) || stop.try_recv().is_ok() {
            return Ok(());
        }
        let mut iteration = || -> Result<(), central_sos_link::HttpFailure> {
            let Some(link) = vault::load()? else {
                return Ok(());
            };
            let transport = Transport::new(&link.backend)?;
            if journal
                .as_ref()
                .is_none_or(|(id, _)| id != &link.enrollment.device_id)
            {
                journal = Some((
                    link.enrollment.device_id.clone(),
                    Journal::open(
                        root.join(format!("commands-{}.sqlite", link.enrollment.device_id)),
                    )?,
                ));
            }
            let journal = &mut journal.as_mut().unwrap().1;
            for result in journal.outbox()? {
                let _: serde_json::Value = transport.request_detailed(
                    reqwest::Method::POST,
                    &format!("/api/agent/commands/{}/result", result.command_id),
                    Some(&link.enrollment.credential),
                    Some(&serde_json::to_value(&result).map_err(|e| e.to_string())?),
                )?;
                journal.delivered(&result.command_id)?;
            }
            let commands: Vec<Command> = transport.request_detailed(
                reqwest::Method::GET,
                "/api/agent/commands",
                Some(&link.enrollment.credential),
                None,
            )?;
            for c in commands.into_iter().take(1) {
                if shutdown.load(Ordering::SeqCst) {
                    return Ok(());
                }
                let started = chrono::Utc::now().to_rfc3339();
                uuid_check(&c.id)?;
                let receipt = journal.receive(&c)?;
                if let Receipt::Finished(r) = receipt {
                    let _: serde_json::Value = transport.request_detailed(
                        reqwest::Method::POST,
                        &format!("/api/agent/commands/{}/result", c.id),
                        Some(&link.enrollment.credential),
                        Some(&serde_json::to_value(r).map_err(|e| e.to_string())?),
                    )?;
                    continue;
                }
                let failed = |status: &str, message: String| CommandResult {
            protocol_version: central_sos_link::policy::PROTOCOL_VERSION,
                    command_id: c.id.clone(),
                    success: false,
                    status: status.into(),
                    summary: message.chars().take(2000).collect(),
                    details: serde_json::json!({"code":if message.starts_with("TIMEOUT") {"TIMEOUT"} else if message.starts_with("EXPIRED_DURING_EXECUTION") {"EXPIRED_DURING_EXECUTION"} else if message.starts_with("PROTOCOL_INCOMPATIBLE") {"PROTOCOL_INCOMPATIBLE"} else {"EXECUTION_NOT_COMPLETED"},"manualReviewRequired":status=="FAILED"}),
                    started_at: started.clone(),
                    finished_at: chrono::Utc::now().to_rfc3339(),
                };
                let result = if matches!(receipt, Receipt::Interrupted) || c.status == "RUNNING" {
                    failed(if c.status=="PENDING"{"REJECTED"}else{"FAILED"},"Execução anterior interrompida ou ACK sem confirmação. Intervenção manual necessária; o efeito não será repetido.".into())
                } else if let Err(error) =
                    c.validate(&link.enrollment.device_id, chrono::Utc::now())
                {
                    failed(
                        if error == "EXPIRED" {
                            "EXPIRED"
                        } else {
                            "REJECTED"
                        },
                        error,
                    )
                } else {
                    let mut server_expiry=std::time::Instant::now();
                    for status in ["RECEIVED", "RUNNING"] {
                        let request_started=std::time::Instant::now();
                        let ack: serde_json::Value = transport.request_detailed(
                            reqwest::Method::POST,
                            &format!("/api/agent/commands/{}/ack", c.id),
                            Some(&link.enrollment.credential),
                            Some(&serde_json::json!({"status":status})),
                        )?;
                        if ack["id"].as_str()!=Some(&c.id) || ack["deviceId"].as_str()!=Some(&c.device_id) || ack["protocolVersion"].as_u64()!=Some(u64::from(central_sos_link::policy::PROTOCOL_VERSION)) { return Err("ACK incompatível com o comando".into()); }
                        if status=="RUNNING" {
                            let remaining=central_sos_link::remaining_validity(&c.expires_at,ack["startedAt"].as_str().ok_or("ACK sem horário do servidor")?,request_started.elapsed())?;
                            server_expiry=std::time::Instant::now()+remaining;
                        }
                    }
                    if vault::load()?
                        .as_ref()
                        .is_none_or(|fresh| fresh.enrollment.device_id != link.enrollment.device_id)
                    {
                        failed("REJECTED", "Pareamento mudou antes da execução".into())
                    } else {
                        crate::logging::event(
                            "agent.command_started",
                            serde_json::json!({"commandId":c.id,"type":c.r#type}),
                        );
                        match crate::engine::execute(&c, &link.enrollment.profile, shutdown.clone(), server_expiry)
                        {
                            Ok(details) => {
                                let needs_session = details["code"].as_str() == Some("USER_SESSION_REQUIRED");
                                let problem = needs_session || details
                                    .get("status")
                                    .and_then(|v| v.as_str())
                                    .is_some_and(|v| ["failed", "partial"].contains(&v));
                                if c.r#type == "machine.validate" {
                                    let health = match details["summary"]["overallStatus"].as_str()
                                    {
                                        Some("operational") if details["coverage"].as_str() == Some("PARTIAL_USER_SESSION_REQUIRED") => Some("warnings"),
                                        Some("operational") => Some("ok"),
                                        Some("attention") => Some("warnings"),
                                        Some("action_required") => Some("critical"),
                                        _ => None,
                                    };
                                    let _=vault::atomic_write("health.json",serde_json::json!({"summary":health,"at":chrono::Utc::now().to_rfc3339(),"deviceId":link.enrollment.device_id}).to_string().as_bytes());
                                }
                                CommandResult {
            protocol_version: central_sos_link::policy::PROTOCOL_VERSION,
                                    command_id: c.id.clone(),
                                    success: !problem,
                                    status: if needs_session { "REJECTED" } else if problem { "FAILED" } else { "SUCCEEDED" }.into(),
                                    summary: details
                                        .get("message")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or(
                                            "Consulta/execução concluída; confira os detalhes.",
                                        )
                                        .chars()
                                        .take(2000)
                                        .collect(),
                                    details,
                                    started_at: started.clone(),
                                    finished_at: chrono::Utc::now().to_rfc3339(),
                                }
                            }
                            Err(e) => failed("FAILED", e),
                        }
                    }
                };
                journal.finish(&result)?;
                crate::logging::event(
                    "agent.command_finished",
                    serde_json::json!({"commandId":c.id,"status":result.status}),
                );
            }
            Ok(())
        };
        let delay = match iteration() {
            Ok(()) => {
                attempts = 0;
                central_sos_link::retry_delay(7, 0, None, central_sos_link::jitter())
            }
            Err(error) => {
                attempts += 1;
                crate::logging::event(
                    "agent.communication_failed",
                    serde_json::json!({"attempt":attempts}),
                );
                central_sos_link::retry_delay(7, attempts - 1, Some(&error), central_sos_link::jitter())
            }
        };
        if stop.recv_timeout(delay).is_ok() {
            return Ok(());
        }
    }
}

fn uuid_check(id: &str) -> Result<(), String> {
    // Validate before using a received identifier in any HTTP path or durable receipt.
    if id.len()!=36 || !id.bytes().all(|b| b.is_ascii_hexdigit() || b==b'-') { return Err("Command ID inválido".into()); }
    Ok(())
}
