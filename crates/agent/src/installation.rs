//! Local administrative installation transaction. Never used by the remote dispatcher.
use serde::{Deserialize, Serialize};
pub type Result<T> = std::result::Result<T, String>;
#[cfg(windows)]
pub mod native;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum State {
    Absent,
    Stopped,
    Running,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum StartMode {
    Automatic,
    Manual,
    Disabled,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServiceSnapshot {
    pub state: State,
    pub start_mode: Option<StartMode>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Phase {
    Preparing,
    Prepared,
    Replacing,
    RollingBack,
    RollbackFailed,
    RolledBack,
    Committed,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Image {
    pub name: String,
    pub destination: String,
    pub architecture: String,
    pub manifest_level: String,
    pub size: u64,
    pub sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u16,
    pub product: String,
    pub version: String,
    pub architecture: String,
    pub protocol_version: u16,
    pub commit: String,
    pub source_fingerprint: String,
    pub files: Vec<Image>,
}
pub const FILES: &[(&str, &str, &str)] = &[
    ("central-sos.exe", "central-sos.exe", "requireAdministrator"),
    (
        "central-sos-agent.exe",
        "Agent/central-sos-agent.exe",
        "asInvoker",
    ),
    (
        "central-sos-session-helper.exe",
        "Agent/central-sos-session-helper.exe",
        "asInvoker",
    ),
];
fn hash(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
impl Manifest {
    pub fn check_previous(&self, previous: &Manifest) -> Result<()> {
        self.validate()?;
        previous.validate_receipt()?;
        let parts = |version: &str| {
            version
                .split('.')
                .map(|part| part.parse::<u32>().unwrap())
                .collect::<Vec<_>>()
        };
        if parts(&previous.version) > parts(&self.version) {
            return Err("INSTALL_DOWNGRADE_REJECTED".into());
        }
        Ok(())
    }
    pub fn validate(&self) -> Result<()> {
        self.validate_receipt()?;
        if self.version != env!("CENTRAL_SOS_CLIENT_VERSION") {
            return Err("INSTALL_PACKAGE_INCOMPATIBLE".into());
        }
        Ok(())
    }
    pub fn validate_receipt(&self) -> Result<()> {
        let version: Vec<_> = self.version.split('.').collect();
        let canonical = version.len() == 3
            && version.iter().all(|part| {
                !part.is_empty()
                    && part.bytes().all(|b| b.is_ascii_digit())
                    && (part.len() == 1 || !part.starts_with('0'))
                    && part.parse::<u32>().is_ok()
            });
        if self.schema_version != 1
            || self.product != "br.com.centralsos.desktop"
            || !canonical
            || self.architecture != "x64"
            || self.protocol_version != central_sos_link::session::SESSION_PROTOCOL_VERSION
            || !hash(&self.commit, 40)
            || !hash(&self.source_fingerprint, 64)
            || self.files.len() != FILES.len()
        {
            return Err("INSTALL_PACKAGE_INCOMPATIBLE".into());
        }
        for (name, destination, level) in FILES {
            let entries: Vec<_> = self
                .files
                .iter()
                .filter(|file| file.name == *name)
                .collect();
            if entries.len() != 1 {
                return Err("INSTALL_PACKAGE_INCOMPATIBLE".into());
            }
            let file = entries[0];
            if file.destination != *destination
                || file.architecture != "x64"
                || file.manifest_level != *level
                || file.size == 0
                || file.size > 512 * 1024 * 1024
                || !hash(&file.sha256, 64)
            {
                return Err("INSTALL_PACKAGE_INCOMPATIBLE".into());
            }
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Transaction {
    pub schema: u16,
    pub phase: Phase,
    pub previous_service: ServiceSnapshot,
    pub previous_files: Vec<Image>,
    pub previous_receipt: Option<Manifest>,
}
pub trait Platform {
    fn validate_package(&mut self) -> Result<()>;
    fn pending(&mut self) -> Result<Option<Transaction>>;
    fn observe(&mut self) -> Result<ServiceSnapshot>;
    fn backup(&mut self, service: ServiceSnapshot) -> Result<Transaction>;
    fn save(&mut self, transaction: &Transaction) -> Result<()>;
    fn disable(&mut self) -> Result<()>;
    fn stop(&mut self) -> Result<()>;
    fn unlocked(&mut self) -> Result<()>;
    fn replace(&mut self) -> Result<()>;
    fn validate_installed(&mut self) -> Result<()>;
    fn install_start(&mut self) -> Result<()>;
    fn wait_running(&mut self) -> Result<()>;
    fn write_receipt(&mut self) -> Result<()>;
    fn restore(&mut self, transaction: &Transaction) -> Result<()>;
    fn restore_service(&mut self, previous: &ServiceSnapshot) -> Result<()>;
    fn cleanup(&mut self, transaction: &Transaction) -> Result<()>;
    fn validate_uninstall(&mut self) -> Result<()>;
    fn remove_service(&mut self) -> Result<()>;
}
pub fn prepare(platform: &mut impl Platform) -> Result<()> {
    platform.validate_package()?;
    if platform.pending()?.is_some() {
        return Err("INSTALL_INTERRUPTED_RECOVERY_REQUIRED".into());
    }
    let service = platform.observe()?; // Reject foreign installations before any backup or mutation.
    let mut transaction = platform.backup(service)?;
    let result = (|| {
        platform.disable()?; // Prevent SCM auto/recovery restart during partial replacement, even after reboot.
        platform.stop()?;
        platform.unlocked()?;
        transaction.phase = Phase::Prepared;
        platform.save(&transaction)
    })();
    if let Err(original) = result {
        rollback(platform)?;
        return Err(original);
    }
    Ok(())
}
pub fn commit(platform: &mut impl Platform) -> Result<()> {
    platform.validate_package()?;
    let mut transaction = platform.pending()?.ok_or("INSTALL_PREPARE_REQUIRED")?;
    if transaction.phase != Phase::Prepared {
        return Err("INSTALL_INTERRUPTED_RECOVERY_REQUIRED".into());
    }
    let result = (|| {
        let state = platform.observe()?;
        if state.state != State::Absent
            && (state.state != State::Stopped || state.start_mode != Some(StartMode::Disabled))
        {
            return Err("INSTALL_SERVICE_NOT_QUIESCENT".into());
        }
        platform.unlocked()?;
        transaction.phase = Phase::Replacing;
        platform.save(&transaction)?;
        platform.replace()?;
        platform.validate_installed()?;
        platform.install_start()?;
        platform.wait_running()?;
        platform.write_receipt()?;
        transaction.phase = Phase::Committed;
        platform.save(&transaction)
    })();
    if let Err(original) = result {
        rollback(platform)?;
        return Err(original);
    }
    platform
        .cleanup(&transaction)
        .map_err(|_| "INSTALL_COMPLETE_CLEANUP_PENDING".into())
}
pub fn rollback(platform: &mut impl Platform) -> Result<()> {
    let Some(mut transaction) = platform.pending()? else {
        return Ok(());
    };
    if transaction.phase == Phase::Committed || transaction.phase == Phase::RolledBack {
        return platform.cleanup(&transaction);
    }
    // Keep Preparing distinct: backup may be incomplete but program files have not been touched.
    let before_replacement = transaction.phase == Phase::Preparing;
    let result = (|| {
        platform.observe()?;
        platform.disable()?;
        platform.stop()?;
        platform.unlocked()?;
        if !before_replacement {
            transaction.phase = Phase::RollingBack;
            platform.save(&transaction)?;
        }
        platform.restore(&transaction)?;
        platform.restore_service(&transaction.previous_service)?;
        transaction.phase = Phase::RolledBack;
        platform.save(&transaction)
    })();
    if result.is_err() {
        if !before_replacement {
            transaction.phase = Phase::RollbackFailed;
        }
        let _ = platform.save(&transaction);
        return Err("INSTALL_ROLLBACK_INCOMPLETE".into());
    }
    platform
        .cleanup(&transaction)
        .map_err(|_| "INSTALL_RECOVERY_CLEANUP_PENDING".into())
}
pub fn uninstall(platform: &mut impl Platform) -> Result<()> {
    if platform.pending()?.is_some() {
        return Err("UNINSTALL_PENDING_TRANSACTION".into());
    }
    platform.validate_uninstall()?;
    platform.observe()?;
    platform.disable()?;
    platform.stop()?;
    platform.unlocked()?;
    platform.remove_service()?;
    if platform.observe()?.state != State::Absent {
        return Err("UNINSTALL_SERVICE_PENDING_DELETE".into());
    }
    Ok(()) // NSIS removes only the enumerated program resources after this succeeds.
}
#[cfg(test)]
#[path = "installation/tests.rs"]
mod tests;
