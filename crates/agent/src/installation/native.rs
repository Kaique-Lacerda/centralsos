//! Fixed-path, elevated local adapter. No operation accepts a command, path, URL or credential.
use super::*;
use crate::service::installer as scm;
use central_sos_link::session::windows::{lifecycle as win, trusted_directory, trusted_image};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use windows_sys::Win32::{Foundation::*, Storage::FileSystem::*, UI::Shell::SHGetFolderPathW};

fn failure<T>(result: std::io::Result<T>) -> Result<T> {
    result.map_err(|_| "INSTALL_FILE_OPERATION_FAILED".into())
}
fn digest(path: &Path) -> Result<(u64, String)> {
    let _trust = trusted_image(path).map_err(|_| "INSTALL_PATH_OR_IMAGE_UNTRUSTED")?;
    if failure(fs::metadata(path))?.len() > 512 * 1024 * 1024 {
        return Err("INSTALL_IMAGE_TOO_LARGE".into());
    }
    let bytes = failure(fs::read(path))?;
    if bytes.len() > 512 * 1024 * 1024 {
        return Err("INSTALL_IMAGE_TOO_LARGE".into());
    }
    Ok((bytes.len() as u64, format!("{:x}", Sha256::digest(bytes))))
}
fn verify(path: &Path, image: &Image) -> Result<()> {
    let (size, hash) = digest(path)?;
    if size != image.size || hash != image.sha256 {
        return Err("INSTALL_IMAGE_MISSING_OR_CORRUPT".into());
    }
    Ok(())
}
fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let _trust = trusted_image(path).map_err(|_| "INSTALL_METADATA_UNTRUSTED")?;
    if failure(fs::metadata(path))?.len() > 16_384 {
        return Err("INSTALL_METADATA_INVALID".into());
    }
    serde_json::from_slice(&failure(fs::read(path))?).map_err(|_| "INSTALL_METADATA_INVALID".into())
}
fn exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("INSTALL_FILE_OPERATION_FAILED".into()),
    }
}
fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str()
        .to_string_lossy()
        .encode_utf16()
        .chain(Some(0))
        .collect()
}
fn atomic_json(path: &Path, value: &impl Serialize) -> Result<()> {
    if exists(path)? {
        let _pin = trusted_image(path).map_err(|_| "INSTALL_METADATA_UNTRUSTED")?;
    }
    let temporary = path.with_extension("next.json");
    if exists(&temporary)? {
        writable(&temporary)?;
        failure(fs::remove_file(&temporary))?;
    }
    let mut file = failure(
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary),
    )?;
    failure(file.write_all(&serde_json::to_vec(value).map_err(|_| "INSTALL_METADATA_INVALID")?))?;
    failure(file.sync_all())?;
    drop(file);
    let _check = trusted_image(&temporary).map_err(|_| "INSTALL_METADATA_UNTRUSTED")?;
    drop(_check);
    if unsafe {
        MoveFileExW(
            wide(&temporary).as_ptr(),
            wide(path).as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err("INSTALL_STATE_SAVE_INCOMPLETE".into());
    }
    Ok(())
}
fn writable(path: &Path) -> Result<()> {
    if !exists(path)? {
        return Ok(());
    }
    let _check = trusted_image(path).map_err(|_| "INSTALL_PATH_OR_IMAGE_UNTRUSTED")?;
    drop(_check);
    // Access probe only: never writes/deletes an image and never forces sharing/reboot replacement.
    let handle = unsafe {
        CreateFileW(
            wide(path).as_ptr(),
            FILE_GENERIC_WRITE | DELETE,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err("INSTALL_IMAGE_IN_USE_OR_UNAVAILABLE".into());
    }
    unsafe {
        CloseHandle(handle);
    }
    Ok(())
}
fn root() -> Result<PathBuf> {
    let mut bytes = [0u16; 260];
    if unsafe {
        SHGetFolderPathW(
            std::ptr::null_mut(),
            0x26,
            std::ptr::null_mut(),
            0,
            bytes.as_mut_ptr(),
        )
    } != 0
    {
        return Err("INSTALL_PROGRAM_FILES_UNAVAILABLE".into());
    }
    let folder = PathBuf::from(String::from_utf16_lossy(
        &bytes[..bytes.iter().position(|c| *c == 0).unwrap_or(260)],
    ));
    let volume = folder.ancestors().last().ok_or("INSTALL_PATH_UNSAFE")?;
    if unsafe { GetDriveTypeW(wide(volume).as_ptr()) } != 3
    /* DRIVE_FIXED */
    {
        return Err("INSTALL_LOCAL_FIXED_DRIVE_REQUIRED".into());
    }
    Ok(folder.join("CENTRAL SOS"))
}
struct Native {
    root: PathBuf,
    stage: PathBuf,
    manifest: Option<Manifest>,
    current_is_installed: bool,
}
struct OperationLock(HANDLE);
impl Drop for OperationLock {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
fn operation_lock(stage: &Path) -> Result<OperationLock> {
    let path = stage.join("operation.lock");
    if !exists(&path)? {
        failure(
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path),
        )?;
    }
    let guard = trusted_image(&path).map_err(|_| "INSTALL_LOCK_UNTRUSTED")?;
    drop(guard);
    let handle = unsafe {
        CreateFileW(
            wide(&path).as_ptr(),
            FILE_GENERIC_READ | FILE_GENERIC_WRITE,
            0,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err("INSTALL_OPERATION_IN_PROGRESS".into());
    }
    Ok(OperationLock(handle)) // Kernel releases the lock on crash; no stale create-new sentinel.
}
impl Native {
    fn target_agent(&self) -> PathBuf {
        self.root.join(FILES[1].1)
    }
    fn journal(&self) -> PathBuf {
        self.stage.join("transaction.json")
    }
    fn backup_dir(&self) -> PathBuf {
        self.stage.join("backup")
    }
    fn receipt(&self) -> PathBuf {
        self.root.join("client-package.json")
    }
    fn incoming(&self, name: &str) -> PathBuf {
        if name == FILES[0].0 {
            self.stage.join("incoming").join(name)
        } else {
            self.stage.join("incoming/Agent").join(name)
        }
    }
    fn safe_dir(&self, path: &Path) -> Result<()> {
        if !exists(path)? {
            failure(fs::create_dir(path))?;
        }
        let _pin = trusted_directory(path).map_err(|_| "INSTALL_PATH_UNSAFE")?;
        Ok(())
    }
    fn copy_verified(&self, source: &Path, target: &Path, image: &Image) -> Result<()> {
        verify(source, image)?;
        self.safe_dir(target.parent().ok_or("INSTALL_PATH_UNSAFE")?)?;
        writable(target)?;
        let temporary = target.with_extension("new.exe");
        if exists(&temporary)? {
            // A fixed staging name in our protected directory, not a caller-supplied file.
            // It is never executed. Validate owner/ACL/reparse/hardlinks before discarding
            // a failed or interrupted copy and retrying from the verified source.
            writable(&temporary)?;
            failure(fs::remove_file(&temporary))?;
        }
        // Destination is protected and fixed; never follow/overwrite a pre-existing temporary object.
        let mut output = failure(
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary),
        )?;
        failure(output.write_all(&failure(fs::read(source))?))?;
        failure(output.sync_all())?;
        drop(output);
        verify(&temporary, image)?;
        if unsafe {
            MoveFileExW(
                wide(&temporary).as_ptr(),
                wide(target).as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err("INSTALL_REPLACEMENT_FAILED".into());
        }
        verify(target, image)
    }
    fn installed_receipt(&self) -> Result<Option<Manifest>> {
        if exists(&self.receipt())? {
            let receipt: Manifest = read_json(&self.receipt())?;
            receipt.validate_receipt()?;
            Ok(Some(receipt))
        } else {
            Ok(None)
        }
    }
}
impl Platform for Native {
    fn validate_package(&mut self) -> Result<()> {
        if self.current_is_installed {
            return Err("INSTALL_INCOMING_AGENT_REQUIRED".into());
        }
        let manifest: Manifest = read_json(&self.stage.join("incoming/package.json"))?;
        manifest.validate()?;
        for image in &manifest.files {
            verify(&self.incoming(&image.name), image)?;
        }
        self.manifest = Some(manifest);
        Ok(())
    }
    fn pending(&mut self) -> Result<Option<Transaction>> {
        if !exists(&self.journal())? {
            return Ok(None);
        }
        let transaction: Transaction = read_json(&self.journal())?;
        if transaction.schema != 1 || transaction.previous_files.len() > 3 {
            return Err("INSTALL_TRANSACTION_INVALID".into());
        }
        let mut names = std::collections::HashSet::new();
        for image in &transaction.previous_files {
            if !FILES.iter().any(|(name, destination, level)| {
                image.name == *name
                    && image.destination == *destination
                    && image.manifest_level == *level
            }) || !names.insert(&image.name)
                || image.architecture != "x64"
                || !super::hash(&image.sha256, 64)
                || image.size == 0
                || image.size > 512 * 1024 * 1024
            {
                return Err("INSTALL_TRANSACTION_INVALID".into());
            }
        }
        if transaction.previous_service.state != State::Absent
            && !names.contains(&FILES[1].0.to_string())
        {
            return Err("INSTALL_TRANSACTION_INVALID".into());
        }
        if (transaction.previous_service.state == State::Absent)
            != transaction.previous_service.start_mode.is_none()
        {
            return Err("INSTALL_TRANSACTION_INVALID".into());
        }
        if let Some(receipt) = &transaction.previous_receipt {
            receipt.validate_receipt()?;
            if receipt.files.iter().any(|file| {
                !transaction.previous_files.iter().any(|previous| {
                    previous.name == file.name
                        && previous.sha256 == file.sha256
                        && previous.size == file.size
                })
            }) {
                return Err("INSTALL_TRANSACTION_INVALID".into());
            }
        }
        Ok(Some(transaction))
    }
    fn observe(&mut self) -> Result<ServiceSnapshot> {
        scm::observe_service(&self.target_agent())
    }
    fn backup(&mut self, service: ServiceSnapshot) -> Result<Transaction> {
        let receipt = self.installed_receipt()?;
        if let Some(previous) = &receipt {
            self.manifest
                .as_ref()
                .ok_or("INSTALL_PACKAGE_REQUIRED")?
                .check_previous(previous)?;
        }
        let mut files = Vec::new();
        for (name, destination, level) in FILES {
            let path = self.root.join(destination);
            if exists(&path)? {
                let (size, sha256) = digest(&path)?;
                if let Some(old) = &receipt {
                    let expected = old
                        .files
                        .iter()
                        .find(|file| file.name == *name)
                        .ok_or("INSTALL_RECEIPT_INVALID")?;
                    verify(&path, expected)?;
                }
                files.push(Image {
                    name: name.to_string(),
                    destination: destination.to_string(),
                    architecture: "x64".into(),
                    manifest_level: level.to_string(),
                    size,
                    sha256,
                });
            } else if receipt.is_some() {
                return Err("INSTALL_IMAGE_MISSING_OR_CORRUPT".into());
            }
        }
        if service.state != State::Absent
            && (!files.iter().any(|f| f.name == FILES[1].0)
                || !files.iter().any(|f| f.name == FILES[2].0))
        {
            return Err("INSTALL_HELPER_OR_AGENT_NOT_INSTALLED".into());
        }
        let transaction = Transaction {
            schema: 1,
            phase: Phase::Preparing,
            previous_service: service,
            previous_files: files,
            previous_receipt: receipt,
        };
        self.save(&transaction)?;
        self.safe_dir(&self.backup_dir())?;
        for image in &transaction.previous_files {
            let target = self.backup_dir().join(&image.name);
            if exists(&target)? {
                return Err("INSTALL_BACKUP_PENDING".into());
            }
            self.copy_verified(&self.root.join(&image.destination), &target, image)?;
        }
        Ok(transaction)
    }
    fn save(&mut self, transaction: &Transaction) -> Result<()> {
        atomic_json(&self.journal(), transaction)
    }
    fn disable(&mut self) -> Result<()> {
        scm::set_start_mode(&self.target_agent(), StartMode::Disabled)
    }
    fn stop(&mut self) -> Result<()> {
        scm::run_service_command("--stop-service", &self.target_agent())
    }
    fn unlocked(&mut self) -> Result<()> {
        if !self.current_is_installed {
            writable(&self.target_agent())?;
        }
        writable(&self.root.join(FILES[2].1))
    }
    fn replace(&mut self) -> Result<()> {
        let manifest = self.manifest.as_ref().ok_or("INSTALL_PACKAGE_REQUIRED")?;
        // NSIS has replaced the Client already. Refuse a partial/ignored NSIS File error.
        verify(
            &self.root.join(FILES[0].1),
            manifest
                .files
                .iter()
                .find(|f| f.name == FILES[0].0)
                .unwrap(),
        )?;
        self.safe_dir(&self.root.join("Agent"))?;
        for image in manifest.files.iter().filter(|f| f.name != FILES[0].0) {
            self.copy_verified(
                &self.incoming(&image.name),
                &self.root.join(&image.destination),
                image,
            )?;
        }
        Ok(())
    }
    fn validate_installed(&mut self) -> Result<()> {
        let manifest = self.manifest.as_ref().ok_or("INSTALL_PACKAGE_REQUIRED")?;
        for image in &manifest.files {
            verify(&self.root.join(&image.destination), image)?;
        }
        Ok(())
    }
    fn install_start(&mut self) -> Result<()> {
        scm::run_service_command("--install-service", &self.target_agent())?;
        scm::run_service_command("--start-service", &self.target_agent())
    }
    fn wait_running(&mut self) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            match self.observe() {
                Ok(service)
                    if service.state == State::Running
                        && service.start_mode == Some(StartMode::Automatic) =>
                {
                    return scm::verify_running_configuration(&self.target_agent())
                }
                Ok(_) => {}
                Err(code) if code == "SCM_TRANSITION_PENDING" => {}
                Err(code) => return Err(code),
            }
            if Instant::now() >= deadline {
                return Err("INSTALL_SERVICE_START_TIMEOUT".into());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    fn write_receipt(&mut self) -> Result<()> {
        atomic_json(
            &self.receipt(),
            self.manifest.as_ref().ok_or("INSTALL_PACKAGE_REQUIRED")?,
        )
    }
    fn restore(&mut self, transaction: &Transaction) -> Result<()> {
        if transaction.phase == Phase::Preparing {
            for image in &transaction.previous_files {
                verify(&self.root.join(&image.destination), image)?;
            }
            return Ok(());
        }
        // Validate ALL backups before restoring anything or starting a service.
        for image in &transaction.previous_files {
            verify(&self.backup_dir().join(&image.name), image)?;
        }
        for image in &transaction.previous_files {
            self.copy_verified(
                &self.backup_dir().join(&image.name),
                &self.root.join(&image.destination),
                image,
            )?;
        }
        let manifest: Manifest = read_json(&self.stage.join("incoming/package.json"))?;
        manifest.validate()?;
        for (name, destination, _) in FILES {
            if !transaction.previous_files.iter().any(|f| f.name == *name) {
                let path = self.root.join(destination);
                if exists(&path)? {
                    // First install: remove only an exact image created by this package, never an unknown file.
                    verify(
                        &path,
                        manifest.files.iter().find(|f| f.name == *name).unwrap(),
                    )?;
                    writable(&path)?;
                    failure(fs::remove_file(path))?;
                }
            }
        }
        if let Some(receipt) = &transaction.previous_receipt {
            atomic_json(&self.receipt(), receipt)?;
        } else if exists(&self.receipt())? {
            let _guard =
                trusted_image(&self.receipt()).map_err(|_| "INSTALL_METADATA_UNTRUSTED")?;
            drop(_guard);
            failure(fs::remove_file(self.receipt()))?;
        }
        Ok(())
    }
    fn restore_service(&mut self, previous: &ServiceSnapshot) -> Result<()> {
        if previous.state == State::Absent {
            return scm::run_service_command("--uninstall-service", &self.target_agent());
        }
        scm::run_service_command("--install-service", &self.target_agent())?;
        if previous.state == State::Running {
            scm::run_service_command("--start-service", &self.target_agent())?;
        }
        scm::set_start_mode(
            &self.target_agent(),
            previous.start_mode.ok_or("INSTALL_TRANSACTION_INVALID")?,
        )?;
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            match self.observe() {
                Ok(actual) if actual == *previous => return Ok(()),
                Ok(_) => {}
                Err(code) if code == "SCM_TRANSITION_PENDING" => {}
                Err(code) => return Err(code),
            }
            if Instant::now() >= deadline {
                return Err("INSTALL_RESTORE_SERVICE_TIMEOUT".into());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    fn cleanup(&mut self, transaction: &Transaction) -> Result<()> {
        // Reserved temporaries only, inside this authenticated installation, never recursive.
        for (_, destination, _) in FILES {
            let temporary = self.root.join(destination).with_extension("new.exe");
            if exists(&temporary)? {
                writable(&temporary)?;
                failure(fs::remove_file(temporary))?;
            }
        }
        for temporary in [
            self.receipt().with_extension("next.json"),
            self.journal().with_extension("next.json"),
        ] {
            if exists(&temporary)? {
                writable(&temporary)?;
                failure(fs::remove_file(temporary))?;
            }
        }
        for image in &transaction.previous_files {
            let path = self.backup_dir().join(&image.name);
            if exists(&path)? {
                verify(&path, image)?;
                failure(fs::remove_file(path))?;
            }
        }
        if exists(&self.backup_dir())? {
            failure(fs::remove_dir(self.backup_dir()))?;
        }
        // Journal removed LAST; any failure remains visible and blocks a new transaction.
        failure(fs::remove_file(self.journal()))
    }
    fn validate_uninstall(&mut self) -> Result<()> {
        let receipt = if let Some(receipt) = self.installed_receipt()? {
            receipt
        } else if exists(&self.stage.join("uninstall-receipt.json"))? {
            let receipt: Manifest = read_json(&self.stage.join("uninstall-receipt.json"))?;
            receipt.validate_receipt()?;
            receipt
        } else {
            if self.observe()?.state == State::Absent
                && FILES
                    .iter()
                    .all(|(_, path, _)| exists(&self.root.join(path)).is_ok_and(|present| !present))
            {
                return Ok(());
            }
            return Err("UNINSTALL_MANAGED_RECEIPT_REQUIRED".into());
        };
        // Helper may be absent/corrupt: do not execute it. Recovery authenticates the Agent and SCM.
        for image in receipt
            .files
            .iter()
            .filter(|image| image.name != FILES[2].0)
        {
            if !FILES.iter().any(|(name, destination, _)| {
                image.name == *name && image.destination == *destination
            }) {
                return Err("INSTALL_RECEIPT_INVALID".into());
            }
            if exists(&self.root.join(&image.destination))? {
                verify(&self.root.join(&image.destination), image)?;
            }
        }
        // Persist proof before NSIS deletes any files. Repeated interrupted uninstall can
        // authenticate its fixed resources even when the root receipt was already removed.
        atomic_json(&self.stage.join("uninstall-receipt.json"), &receipt)?;
        Ok(())
    }
    fn remove_service(&mut self) -> Result<()> {
        scm::run_service_command("--uninstall-service", &self.target_agent())
    }
}
pub fn execute(command: &str) -> Result<()> {
    win::administrative_installer().map_err(|_| "INSTALL_ADMIN_REQUIRED")?;
    let _agent = win::installation_agent_image().map_err(|_| "INSTALL_TRUST_REJECTED")?;
    let root = root()?;
    let _root = trusted_directory(&root).map_err(|_| "INSTALL_PATH_UNSAFE")?;
    let stage = root.join(".central-sos-installer");
    let _stage = trusted_directory(&stage).map_err(|_| "INSTALL_PATH_UNSAFE")?;
    let _lock = operation_lock(&stage)?;
    let current = std::env::current_exe().map_err(|_| "INSTALL_IMAGE_UNAVAILABLE")?;
    let installed = root.join(FILES[1].1);
    let incoming = stage.join("incoming/Agent").join(FILES[1].0);
    let same = |a: &Path, b: &Path| {
        a.to_string_lossy()
            .eq_ignore_ascii_case(&b.to_string_lossy())
    };
    if !same(&current, &installed) && !same(&current, &incoming) {
        return Err("INSTALL_CONTEXT_REJECTED".into());
    }
    let mut platform = Native {
        root,
        stage,
        manifest: None,
        current_is_installed: same(&current, &installed),
    };
    match command {
        "--installer-prepare" => prepare(&mut platform),
        "--installer-commit" => commit(&mut platform),
        "--installer-rollback" => rollback(&mut platform),
        "--installer-uninstall" => uninstall(&mut platform),
        "--installer-status" => {
            let pending = platform.pending()?;
            let service = platform.observe()?;
            let receipt = platform.installed_receipt()?;
            let helper_path = platform.root.join(FILES[2].1);
            let helper = if !exists(&helper_path)? {
                "not_installed"
            } else if receipt
                .as_ref()
                .and_then(|r| r.files.iter().find(|f| f.name == FILES[2].0))
                .is_some_and(|image| verify(&helper_path, image).is_ok())
            {
                "installed_availability_not_checked"
            } else {
                "corrupt_or_unverified"
            };
            let complete = pending.is_none()
                && receipt.as_ref().is_some_and(|r| {
                    r.files
                        .iter()
                        .all(|image| verify(&platform.root.join(&image.destination), image).is_ok())
                });
            println!(
                "{}",
                serde_json::json!({ "event":"client.installation_status", "service":service,
                "transaction":pending.map(|t| t.phase), "helper":helper, "completePackage":complete,
                "enrollmentAndBackend":"not_checked", "remoteRevocation":"not_requested" })
            );
            Ok(())
        }
        _ => Err("INSTALL_ARGUMENTS_REJECTED".into()),
    }
}
