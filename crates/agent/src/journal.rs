use central_sos_link::protocol::{Command, CommandResult};
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};
pub struct Journal {
    db: Connection,
}
pub enum Receipt {
    New,
    Finished(CommandResult),
    Interrupted,
}
impl Journal {
    pub fn open(path: impl AsRef<std::path::Path>) -> Result<Self, String> {
        let db = Connection::open(path).map_err(|e| e.to_string())?;
        db.busy_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, digest TEXT NOT NULL, result TEXT, sent INTEGER NOT NULL DEFAULT 0);").map_err(|e|e.to_string())?;
        Ok(Self { db })
    }
    pub fn receive(&mut self, c: &Command) -> Result<Receipt, String> {
        let fingerprint=format!("{:x}",Sha256::digest(serde_json::to_vec(&serde_json::json!({"protocolVersion":c.protocol_version,"deviceId":c.device_id,"type":c.r#type,"payload":c.payload,"confirmed":c.confirmed,"expiresAt":c.expires_at,"createdAt":c.created_at,"requestedBy":c.requested_by})).map_err(|e|e.to_string())?));
        let transaction = self.db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
        use rusqlite::OptionalExtension;
        let existing: Option<(String, Option<String>)> = transaction
            .query_row(
                "SELECT digest,result FROM commands WHERE id=?1",
                [&c.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some((hash, result)) = existing {
            if hash != fingerprint {
                return Err("REJECTED: commandId reutilizado com conteúdo diferente".into());
            }
            return match result {
                Some(r) => Ok(Receipt::Finished(
                    serde_json::from_str(&r).map_err(|e| e.to_string())?,
                )),
                None => Ok(Receipt::Interrupted),
            };
        }
        // Durable receipt precedes any native effect. A crash never replays an incomplete action.
        transaction
            .execute(
                "INSERT INTO commands(id,digest) VALUES(?1,?2)",
                params![c.id, fingerprint],
            )
            .map_err(|e| e.to_string())?;
        transaction.commit().map_err(|e| e.to_string())?;
        Ok(Receipt::New)
    }
    pub fn finish(&self, r: &CommandResult) -> Result<(), String> {
        let updated = self.db
            .execute(
                "UPDATE commands SET result=?1,sent=0 WHERE id=?2 AND result IS NULL",
                params![
                    serde_json::to_string(r).map_err(|e| e.to_string())?,
                    r.command_id
                ],
            )
            .map_err(|e| e.to_string())?;
        if updated == 0 {
            let existing: String = self.db.query_row("SELECT result FROM commands WHERE id=?1", [&r.command_id], |row| row.get(0)).map_err(|e| e.to_string())?;
            if serde_json::from_str::<serde_json::Value>(&existing).map_err(|e| e.to_string())? != serde_json::to_value(r).map_err(|e| e.to_string())? {
                return Err("Resultado final imutável; não sobrescrever".into());
            }
        }
        Ok(())
    }
    pub fn outbox(&self) -> Result<Vec<CommandResult>, String> {
        let mut q = self
            .db
            .prepare("SELECT result FROM commands WHERE result IS NOT NULL AND sent=0 LIMIT 20")
            .map_err(|e| e.to_string())?;
        let rows = q
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let result = rows
            .map(|r| {
                serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
            })
            .collect();
        result
    }
    pub fn delivered(&self, id: &str) -> Result<(), String> {
        self.db
            .execute("UPDATE commands SET sent=1 WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn duplicates_never_replay() {
        let mut j = Journal::open(":memory:").unwrap();
        let c = Command {
            protocol_version: central_sos_link::policy::PROTOCOL_VERSION,
            id: "id".into(),
            device_id: "d".into(),
            r#type: "printer.auto_fix".into(),
            payload: serde_json::json!({"printerName":"test"}),
            confirmed: true,
            requested_by: "t".into(),
            created_at: "a".into(),
            expires_at: "b".into(),
            status: "PENDING".into(),
            started_at: None,
            finished_at: None,
        };
        assert!(matches!(j.receive(&c).unwrap(), Receipt::New));
        assert!(matches!(j.receive(&c).unwrap(), Receipt::Interrupted));
        let r = CommandResult {
            protocol_version: central_sos_link::policy::PROTOCOL_VERSION,
            command_id: c.id.clone(),
            status: "FAILED".into(),
            success: false,
            summary: "interrompido".into(),
            details: serde_json::Value::Null,
            started_at: "a".into(),
            finished_at: "b".into(),
        };
        j.finish(&r).unwrap();
        assert!(matches!(j.receive(&c).unwrap(), Receipt::Finished(_)));
        assert_eq!(j.outbox().unwrap().len(), 1);
        j.delivered(&c.id).unwrap();
        assert!(j.outbox().unwrap().is_empty());
    }
}
#[cfg(test)]
mod collision_tests {
    use super::*;
    #[test]
    fn same_id_with_different_payload_is_rejected() {
        let mut journal = Journal::open(":memory:").unwrap();
        let mut command = Command {
            protocol_version: central_sos_link::policy::PROTOCOL_VERSION,
            id: "id".into(),
            device_id: "d".into(),
            r#type: "service.check".into(),
            payload: serde_json::json!({"name":"Spooler"}),
            confirmed: false,
            requested_by: "t".into(),
            created_at: "a".into(),
            expires_at: "b".into(),
            status: "PENDING".into(),
            started_at: None,
            finished_at: None,
        };
        journal.receive(&command).unwrap();
        command.payload = serde_json::json!({"name":"Other"});
        assert!(journal.receive(&command).is_err());
    }
}
#[cfg(test)]
mod durable_tests {
    use super::*;
    fn command() -> Command {
        Command { protocol_version: 1, id: "fixture".into(), device_id: "device".into(), r#type: "spooler.restart".into(), payload: serde_json::json!({}), confirmed: true, requested_by: "subject".into(), created_at: "a".into(), expires_at: "b".into(), status: "PENDING".into(), started_at: None, finished_at: None }
    }
    #[test]
    fn restart_before_ack_or_after_effect_never_repeats() {
        let dir = std::env::temp_dir().join(format!("central-journal-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir(&dir).unwrap(); let path = dir.join("journal.sqlite");
        let c = command();
        { let mut j = Journal::open(&path).unwrap(); assert!(matches!(j.receive(&c).unwrap(), Receipt::New)); }
        let r = CommandResult { protocol_version: 1, command_id: c.id.clone(), success: false, status: "FAILED".into(), summary: "unknown effect; no retry".into(), details: serde_json::json!({"manualReviewRequired":true}), started_at:"a".into(), finished_at:"b".into() };
        { let mut j = Journal::open(&path).unwrap(); assert!(matches!(j.receive(&c).unwrap(), Receipt::Interrupted)); j.finish(&r).unwrap(); }
        { let mut j = Journal::open(&path).unwrap(); assert!(matches!(j.receive(&c).unwrap(), Receipt::Finished(_))); assert_eq!(j.outbox().unwrap().len(),1); j.finish(&r).unwrap(); let mut changed=r.clone(); changed.success=true; assert!(j.finish(&changed).is_err()); j.delivered(&c.id).unwrap(); }
        { let mut j = Journal::open(&path).unwrap(); assert!(matches!(j.receive(&c).unwrap(), Receipt::Finished(_))); assert!(j.outbox().unwrap().is_empty()); }
        std::fs::remove_file(&path).unwrap();
        for name in ["journal.sqlite-wal", "journal.sqlite-shm"] { let _ = std::fs::remove_file(dir.join(name)); }
        std::fs::remove_dir(dir).unwrap();
    }
    #[test]
    fn two_polls_have_one_atomic_winner() {
        let path = std::env::temp_dir().join(format!("central-claim-{}.sqlite", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let mut a = Journal::open(&path).unwrap(); let mut b = Journal::open(&path).unwrap();
        let barrier=std::sync::Arc::new(std::sync::Barrier::new(2));
        let other=barrier.clone(); let c=command(); let d=c.clone();
        let worker=std::thread::spawn(move || { other.wait(); matches!(b.receive(&d).unwrap(), Receipt::New) });
        barrier.wait(); let first=matches!(a.receive(&c).unwrap(), Receipt::New); let second=worker.join().unwrap();
        assert_ne!(first,second); drop(a);
        std::fs::remove_file(&path).unwrap();
        let _=std::fs::remove_file(format!("{}-wal",path.display())); let _=std::fs::remove_file(format!("{}-shm",path.display()));
    }
}
