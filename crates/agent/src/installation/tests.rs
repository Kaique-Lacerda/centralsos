use super::*;
use std::collections::{BTreeMap, HashSet};

// Failure-injection adapter only: no Windows APIs, filesystem, process launch or SCM.
struct Fake {
    calls: Vec<&'static str>,
    failures: HashSet<&'static str>,
    once: HashSet<&'static str>,
    service: ServiceSnapshot,
    transaction: Option<Transaction>,
    files: BTreeMap<String, String>,
    saved: BTreeMap<String, String>,
    persistent: Vec<String>,
    receipt: bool,
}
impl Fake {
    fn new(state: State) -> Self {
        let mut files = BTreeMap::new();
        if state != State::Absent {
            for (name, _, _) in FILES {
                files.insert(name.to_string(), "old".into());
            }
        }
        Self {
            calls: vec![],
            failures: HashSet::new(),
            once: HashSet::new(),
            service: ServiceSnapshot {
                state,
                start_mode: (state != State::Absent).then_some(StartMode::Automatic),
            },
            transaction: None,
            files,
            saved: BTreeMap::new(),
            persistent: vec!["identity".into(), "vault".into(), "journal".into()],
            receipt: state != State::Absent,
        }
    }
    fn step(&mut self, name: &'static str) -> Result<()> {
        self.calls.push(name);
        if self.failures.contains(name) || self.once.remove(name) {
            Err(format!("FAIL_{name}"))
        } else {
            Ok(())
        }
    }
}
fn image(name: &str, destination: &str, level: &str) -> Image {
    Image {
        name: name.into(),
        destination: destination.into(),
        architecture: "x64".into(),
        manifest_level: level.into(),
        size: 12,
        sha256: "a".repeat(64),
    }
}
fn manifest() -> Manifest {
    Manifest {
        schema_version: 1,
        product: "br.com.centralsos.desktop".into(),
        version: env!("CENTRAL_SOS_CLIENT_VERSION").into(),
        architecture: "x64".into(),
        protocol_version: central_sos_link::session::SESSION_PROTOCOL_VERSION,
        commit: "b".repeat(40),
        source_fingerprint: "c".repeat(64),
        files: FILES.iter().map(|(n, d, l)| image(n, d, l)).collect(),
    }
}
impl Platform for Fake {
    fn validate_package(&mut self) -> Result<()> {
        self.step("trust_package")
    }
    fn pending(&mut self) -> Result<Option<Transaction>> {
        self.step("pending")?;
        Ok(self.transaction.clone())
    }
    fn observe(&mut self) -> Result<ServiceSnapshot> {
        self.step("observe_identity")?;
        Ok(self.service.clone())
    }
    fn backup(&mut self, service: ServiceSnapshot) -> Result<Transaction> {
        self.step("backup")?;
        self.saved = self.files.clone();
        let tx = Transaction {
            schema: 1,
            phase: Phase::Preparing,
            previous_service: service,
            previous_files: vec![],
            previous_receipt: self.receipt.then(manifest),
        };
        self.transaction = Some(tx.clone());
        Ok(tx)
    }
    fn save(&mut self, tx: &Transaction) -> Result<()> {
        self.step("save")?;
        self.transaction = Some(tx.clone());
        Ok(())
    }
    fn disable(&mut self) -> Result<()> {
        self.step("disable")?;
        if self.service.state != State::Absent {
            self.service.start_mode = Some(StartMode::Disabled);
        }
        Ok(())
    }
    fn stop(&mut self) -> Result<()> {
        self.step("stop_and_wait_owned_process")?;
        if self.service.state != State::Absent {
            self.service.state = State::Stopped;
        }
        Ok(())
    }
    fn unlocked(&mut self) -> Result<()> {
        self.step("wait_helper_unlocked")
    }
    fn replace(&mut self) -> Result<()> {
        for (name, step) in [
            (FILES[0].0, "replace_client"),
            (FILES[1].0, "replace_agent"),
            (FILES[2].0, "replace_helper"),
        ] {
            self.step(step)?;
            self.files.insert(name.into(), "new".into());
        }
        Ok(())
    }
    fn validate_installed(&mut self) -> Result<()> {
        self.step("validate_all_images")?;
        assert!(self.files.len() == 3 && self.files.values().all(|v| v == "new"));
        Ok(())
    }
    fn install_start(&mut self) -> Result<()> {
        self.step("scm_register_recovery")?;
        self.service.state = State::Stopped;
        self.service.start_mode = Some(StartMode::Automatic);
        self.step("start")?;
        self.service.state = State::Running;
        Ok(())
    }
    fn wait_running(&mut self) -> Result<()> {
        self.step("verify_running_config")
    }
    fn write_receipt(&mut self) -> Result<()> {
        self.step("receipt")?;
        self.receipt = true;
        Ok(())
    }
    fn restore(&mut self, _: &Transaction) -> Result<()> {
        self.step("restore_files")?;
        self.files = self.saved.clone();
        Ok(())
    }
    fn restore_service(&mut self, previous: &ServiceSnapshot) -> Result<()> {
        self.step("restore_service")?;
        assert_eq!(self.files, self.saved);
        self.service = previous.clone();
        self.receipt = !self.files.is_empty();
        Ok(())
    }
    fn cleanup(&mut self, _: &Transaction) -> Result<()> {
        self.step("cleanup")?;
        self.transaction = None;
        self.saved.clear();
        Ok(())
    }
    fn validate_uninstall(&mut self) -> Result<()> {
        self.step("validate_managed_receipt")
    }
    fn remove_service(&mut self) -> Result<()> {
        self.step("remove_owned_service")?;
        self.service = ServiceSnapshot {
            state: State::Absent,
            start_mode: None,
        };
        Ok(())
    }
}

#[test]
fn package_contract_is_exact_and_current() {
    manifest().validate().unwrap();
}
#[test]
fn package_rejects_missing_helper() {
    let mut m = manifest();
    m.files.pop();
    assert!(m.validate().is_err());
}
#[test]
fn package_rejects_incompatible_protocol() {
    let mut m = manifest();
    m.protocol_version += 1;
    assert!(m.validate().is_err());
}
#[test]
fn package_rejects_path_or_extra_payload() {
    let mut m = manifest();
    m.files[1].destination = "../foreign.exe".into();
    assert!(m.validate().is_err());
    m = manifest();
    m.files.push(m.files[0].clone());
    assert!(m.validate().is_err());
}
#[test]
fn package_preserves_elevation_levels() {
    let mut m = manifest();
    m.files[2].manifest_level = "requireAdministrator".into();
    assert!(m.validate().is_err());
}
#[test]
fn old_receipt_is_valid_but_cannot_be_used_as_current_package() {
    let mut m = manifest();
    m.version = "0.1.0".into();
    m.validate_receipt().unwrap();
    assert!(m.validate().is_err());
    m.version = "01.2.0".into();
    assert!(m.validate_receipt().is_err());
}
#[test]
fn manual_installer_cannot_bypass_downgrade_protection() {
    let current = manifest();
    let mut previous = current.clone();
    previous.version = "0.1.0".into();
    current.check_previous(&previous).unwrap();
    previous.version = "0.2.0".into();
    current.check_previous(&previous).unwrap();
    previous.version = "0.3.0".into();
    assert_eq!(
        current.check_previous(&previous).unwrap_err(),
        "INSTALL_DOWNGRADE_REJECTED"
    );
}
#[test]
fn fresh_install_starts_only_after_all_images() {
    let mut p = Fake::new(State::Absent);
    prepare(&mut p).unwrap();
    commit(&mut p).unwrap();
    assert_eq!(p.service.state, State::Running);
    let check = p
        .calls
        .iter()
        .position(|s| *s == "validate_all_images")
        .unwrap();
    let start = p.calls.iter().position(|s| *s == "start").unwrap();
    assert!(check < start);
    assert!(p.transaction.is_none());
}
#[test]
fn upgrade_running_stops_disables_before_replacing() {
    let mut p = Fake::new(State::Running);
    prepare(&mut p).unwrap();
    assert_eq!(p.service.start_mode, Some(StartMode::Disabled));
    assert_eq!(p.service.state, State::Stopped);
    commit(&mut p).unwrap();
    assert_eq!(p.service.start_mode, Some(StartMode::Automatic));
}
#[test]
fn upgrade_stopped_is_supported() {
    let mut p = Fake::new(State::Stopped);
    prepare(&mut p).unwrap();
    commit(&mut p).unwrap();
    assert_eq!(p.service.state, State::Running);
}
#[test]
fn upgrade_without_service_backs_up_client() {
    let mut p = Fake::new(State::Absent);
    p.files.insert(FILES[0].0.into(), "old".into());
    prepare(&mut p).unwrap();
    p.once.insert("start");
    assert!(commit(&mut p).is_err());
    assert_eq!(p.files.len(), 1);
    assert_eq!(p.service.state, State::Absent);
}
#[test]
fn foreign_service_is_rejected_before_any_mutation() {
    let mut p = Fake::new(State::Running);
    p.failures.insert("observe_identity");
    assert!(prepare(&mut p).is_err());
    assert!(!p.calls.contains(&"backup") && !p.calls.contains(&"disable"));
}
#[test]
fn absent_helper_or_unsafe_acl_refuses_before_scm() {
    let mut p = Fake::new(State::Absent);
    p.failures.insert("trust_package");
    assert!(prepare(&mut p).is_err());
    assert_eq!(p.calls, vec!["trust_package"]);
}
#[test]
fn interrupted_upgrade_blocks_new_transaction() {
    let mut p = Fake::new(State::Running);
    prepare(&mut p).unwrap();
    let calls = p.calls.len();
    assert_eq!(
        prepare(&mut p).unwrap_err(),
        "INSTALL_INTERRUPTED_RECOVERY_REQUIRED"
    );
    assert!(!p.calls[calls..].contains(&"disable"));
    rollback(&mut p).unwrap();
    assert_eq!(p.service.state, State::Running);
}
#[test]
fn replacing_interrupted_can_be_recovered() {
    let mut p = Fake::new(State::Running);
    prepare(&mut p).unwrap();
    p.transaction.as_mut().unwrap().phase = Phase::Replacing;
    p.files.insert(FILES[1].0.into(), "new".into());
    rollback(&mut p).unwrap();
    assert!(p.files.values().all(|v| v == "old"));
}
#[test]
fn each_copy_failure_restores_entire_previous_set() {
    for step in ["replace_client", "replace_agent", "replace_helper"] {
        let mut p = Fake::new(State::Running);
        prepare(&mut p).unwrap();
        p.once.insert(step);
        assert!(commit(&mut p).is_err());
        assert!(p.files.values().all(|v| v == "old"));
        assert_eq!(p.service.state, State::Running);
        assert!(p.transaction.is_none());
    }
}
#[test]
fn recovery_configuration_failure_rolls_back() {
    let mut p = Fake::new(State::Running);
    prepare(&mut p).unwrap();
    p.once.insert("scm_register_recovery");
    assert!(commit(&mut p).is_err());
    assert!(p.files.values().all(|v| v == "old"));
}
#[test]
fn start_failure_rolls_back_and_preserves_data() {
    let mut p = Fake::new(State::Running);
    let data = p.persistent.clone();
    prepare(&mut p).unwrap();
    p.once.insert("start");
    assert!(commit(&mut p).is_err());
    assert_eq!(p.persistent, data);
    assert_eq!(p.service.state, State::Running);
}
#[test]
fn exit_code_is_not_scm_running_proof() {
    let mut p = Fake::new(State::Running);
    prepare(&mut p).unwrap();
    p.once.insert("verify_running_config");
    assert!(commit(&mut p).is_err());
    assert!(p.files.values().all(|v| v == "old"));
}
#[test]
fn rollback_failure_retains_journal_and_never_starts_mixed_images() {
    let mut p = Fake::new(State::Running);
    prepare(&mut p).unwrap();
    p.once.insert("replace_helper");
    p.failures.insert("restore_files");
    assert_eq!(commit(&mut p).unwrap_err(), "INSTALL_ROLLBACK_INCOMPLETE");
    assert_eq!(p.transaction.as_ref().unwrap().phase, Phase::RollbackFailed);
    assert_eq!(p.service.state, State::Stopped);
    assert_eq!(p.service.start_mode, Some(StartMode::Disabled));
    assert!(!p.calls.contains(&"restore_service"));
}
#[test]
fn rollback_can_be_retried_after_transient_failure() {
    let mut p = Fake::new(State::Running);
    prepare(&mut p).unwrap();
    p.once.insert("replace_helper");
    p.failures.insert("restore_files");
    assert!(commit(&mut p).is_err());
    p.failures.clear();
    rollback(&mut p).unwrap();
    assert!(p.transaction.is_none());
    assert_eq!(p.service.state, State::Running);
}
#[test]
fn cleanup_failure_after_rollback_is_idempotent() {
    let mut p = Fake::new(State::Running);
    prepare(&mut p).unwrap();
    p.once.insert("start");
    p.failures.insert("cleanup");
    assert_eq!(
        commit(&mut p).unwrap_err(),
        "INSTALL_RECOVERY_CLEANUP_PENDING"
    );
    assert_eq!(p.transaction.as_ref().unwrap().phase, Phase::RolledBack);
    p.failures.clear();
    rollback(&mut p).unwrap();
    assert!(p.transaction.is_none());
}
#[test]
fn cleanup_failure_after_commit_does_not_roll_back_valid_install() {
    let mut p = Fake::new(State::Absent);
    prepare(&mut p).unwrap();
    p.failures.insert("cleanup");
    assert_eq!(
        commit(&mut p).unwrap_err(),
        "INSTALL_COMPLETE_CLEANUP_PENDING"
    );
    assert_eq!(p.transaction.as_ref().unwrap().phase, Phase::Committed);
    p.failures.clear();
    rollback(&mut p).unwrap();
    assert_eq!(p.service.state, State::Running);
}
#[test]
fn upgrade_does_not_regenerate_identity_or_touch_vault_journal() {
    let mut p = Fake::new(State::Running);
    let data = p.persistent.clone();
    prepare(&mut p).unwrap();
    commit(&mut p).unwrap();
    assert_eq!(p.persistent, data);
}
#[test]
fn uninstall_is_idempotent_and_preserves_persistent_data() {
    let mut p = Fake::new(State::Running);
    let data = p.persistent.clone();
    uninstall(&mut p).unwrap();
    uninstall(&mut p).unwrap();
    assert_eq!(p.service.state, State::Absent);
    assert_eq!(p.persistent, data);
}
#[test]
fn uninstall_foreign_service_does_not_stop_or_remove() {
    let mut p = Fake::new(State::Running);
    p.failures.insert("observe_identity");
    assert!(uninstall(&mut p).is_err());
    assert!(!p.calls.contains(&"disable") && !p.calls.contains(&"remove_owned_service"));
}
#[test]
fn uninstall_timeout_never_removes_service_or_files() {
    let mut p = Fake::new(State::Running);
    p.failures.insert("stop_and_wait_owned_process");
    assert!(uninstall(&mut p).is_err());
    assert!(!p.calls.contains(&"remove_owned_service"));
    assert_eq!(p.files.len(), 3);
}
#[test]
fn helper_still_in_use_prevents_uninstall() {
    let mut p = Fake::new(State::Running);
    p.failures.insert("wait_helper_unlocked");
    assert!(uninstall(&mut p).is_err());
    assert!(!p.calls.contains(&"remove_owned_service"));
}
#[test]
fn uninstall_pending_transaction_is_rejected() {
    let mut p = Fake::new(State::Running);
    prepare(&mut p).unwrap();
    assert_eq!(
        uninstall(&mut p).unwrap_err(),
        "UNINSTALL_PENDING_TRANSACTION"
    );
}
#[test]
fn administrative_access_failure_never_claims_success() {
    let mut p = Fake::new(State::Running);
    p.failures.insert("validate_managed_receipt");
    assert!(uninstall(&mut p).is_err());
    assert_eq!(p.calls, vec!["pending", "validate_managed_receipt"]);
}
#[test]
fn registration_not_deleted_means_incomplete_uninstall() {
    let mut p = Fake::new(State::Running);
    p.failures.insert("remove_owned_service");
    assert!(uninstall(&mut p).is_err());
    assert_eq!(p.service.state, State::Stopped);
}
#[test]
fn commit_requires_prepared_quiescent_service() {
    let mut p = Fake::new(State::Running);
    assert_eq!(commit(&mut p).unwrap_err(), "INSTALL_PREPARE_REQUIRED");
    prepare(&mut p).unwrap();
    p.service.state = State::Running;
    assert!(commit(&mut p).is_err());
    assert!(!p.calls.contains(&"replace_agent"));
}
