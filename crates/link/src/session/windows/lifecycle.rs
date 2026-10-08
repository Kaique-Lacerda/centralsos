//! Fixed-image launch under a verified non-elevated WTS token. No shell or caller-supplied path.
use super::*;
use windows_sys::Win32::System::{Environment::*, JobObjects::*};

pub const HELPER_IMAGE: &str = "central-sos-session-helper.exe";
pub const AGENT_IMAGE: &str = "central-sos-agent.exe";

fn process_token(process: HANDLE) -> Result<Handle> {
    unsafe {
        let mut token = null_mut();
        if OpenProcessToken(process, TOKEN_QUERY, &mut token) == 0 {
            return Err(error(ErrorCode::SessionPeerRejected, "Token indisponível"));
        }
        Handle::checked(token, ErrorCode::SessionPeerRejected)
    }
}
fn unelevated(token: HANDLE, expected: &Identity) -> Result<()> {
    const MEDIUM_INTEGRITY_RID: u32 = 0x2000; // SECURITY_MANDATORY_MEDIUM_RID, WinNT.h
    let actual = token_identity(token)?;
    let elevation = token_bytes(token, TokenElevation)?;
    let integrity = token_bytes(token, TokenIntegrityLevel)?;
    unsafe {
        let label = &*integrity.as_ptr().cast::<TOKEN_MANDATORY_LABEL>();
        if IsValidSid(label.Label.Sid) == 0 {
            return Err(error(
                ErrorCode::SessionPeerRejected,
                "Integridade não verificável",
            ));
        }
        let count = *GetSidSubAuthorityCount(label.Label.Sid);
        if count == 0
            || actual != *expected
            || actual.session_id == 0
            || actual.user_sid == "S-1-5-18"
            || actual.logon_sid.is_empty()
            || (*(elevation.as_ptr().cast::<TOKEN_ELEVATION>())).TokenIsElevated != 0
            || *GetSidSubAuthority(label.Label.Sid, u32::from(count - 1)) > MEDIUM_INTEGRITY_RID
        {
            return Err(error(
                ErrorCode::SessionPeerRejected,
                "Helper exige usuário não elevado",
            ));
        }
    }
    Ok(())
}
pub fn verify_user_process() -> Result<()> {
    let token = process_token(unsafe { GetCurrentProcess() })?;
    unelevated(token.0, &own_identity()?)
}
/// Pin both images and every ancestor; keep these handles while the service runs.
pub fn service_images() -> Result<(TrustedImage, TrustedImage)> {
    let agent = service_context()?;
    if unsafe { GetCurrentProcessId() } != agent_pid()? {
        return Err(error(
            ErrorCode::SessionPeerRejected,
            "Agent não corresponde ao SCM",
        ));
    }
    Ok((agent, trusted_image(&expected_sibling(HELPER_IMAGE)?)?))
}
pub fn service_context() -> Result<TrustedImage> {
    let identity = own_identity()?;
    if identity.user_sid != "S-1-5-18" || identity.session_id != 0 {
        return Err(error(
            ErrorCode::SessionPeerRejected,
            "Agent exige SCM/LocalSystem/Session 0",
        ));
    }
    let current = std::env::current_exe()
        .map_err(|_| error(ErrorCode::SessionPeerRejected, "Imagem Agent indisponível"))?;
    if !current
        .to_string_lossy()
        .eq_ignore_ascii_case(&expected_sibling(AGENT_IMAGE)?.to_string_lossy())
    {
        return Err(error(
            ErrorCode::SessionPeerRejected,
            "Imagem Agent divergente",
        ));
    }
    trusted_image(&current)
}
pub fn administrative_installer() -> Result<()> {
    let token = process_token(unsafe { GetCurrentProcess() })?;
    let elevation = token_bytes(token.0, TokenElevation)?;
    if unsafe { (*(elevation.as_ptr().cast::<TOKEN_ELEVATION>())).TokenIsElevated } == 0
        || unsafe { windows_sys::Win32::UI::Shell::IsUserAnAdmin() } == 0
    {
        return Err(error(
            ErrorCode::SessionPeerRejected,
            "Instalação exige administrador elevado",
        ));
    }
    Ok(())
}
pub fn installation_images() -> Result<(TrustedImage, TrustedImage)> {
    let current = std::env::current_exe()
        .map_err(|_| error(ErrorCode::SessionPeerRejected, "Imagem Agent indisponível"))?;
    let expected = expected_sibling(AGENT_IMAGE)?;
    if !current
        .to_string_lossy()
        .eq_ignore_ascii_case(&expected.to_string_lossy())
    {
        return Err(error(
            ErrorCode::SessionPeerRejected,
            "Imagem Agent divergente",
        ));
    }
    Ok((
        trusted_image(&expected)?,
        trusted_image(&expected_sibling(HELPER_IMAGE)?)?,
    ))
}

struct Environment(*mut c_void);
impl Drop for Environment {
    fn drop(&mut self) {
        unsafe {
            DestroyEnvironmentBlock(self.0);
        }
    }
}
fn user_environment(block: &Environment) -> Result<Vec<u16>> {
    // Do not forward arbitrary machine/user environment variables (including credentials).
    const ALLOWED: &[&str] = &[
        "SYSTEMROOT",
        "WINDIR",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "TEMP",
        "TMP",
        "COMPUTERNAME",
        "USERNAME",
        "USERDOMAIN",
        "HOMEDRIVE",
        "HOMEPATH",
    ];
    let mut output = Vec::new();
    let mut offset = 0;
    while offset < 32_767 {
        let entry = unsafe { read_wide(block.0.cast::<u16>().add(offset), 32_767 - offset)? };
        if entry.is_empty() {
            output.push(0);
            if output.len() == 1 {
                output.push(0);
            }
            return Ok(output);
        }
        offset += entry.encode_utf16().count() + 1;
        if entry
            .split_once('=')
            .is_some_and(|(key, _)| ALLOWED.contains(&key.to_ascii_uppercase().as_str()))
        {
            output.extend(wide(&entry));
        }
    }
    Err(error(
        ErrorCode::SessionHelperUnavailable,
        "Ambiente excede limite",
    ))
}
struct Attributes {
    bytes: Vec<usize>,
}
impl Attributes {
    fn new(job: &Handle) -> Result<Self> {
        unsafe {
            let mut size = 0;
            InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut size);
            if size == 0 || size > 65_536 {
                return Err(error(
                    ErrorCode::SessionHelperUnavailable,
                    "Atributos indisponíveis",
                ));
            }
            let mut bytes = vec![0usize; size.div_ceil(size_of::<usize>())];
            let ptr = bytes.as_mut_ptr().cast();
            if InitializeProcThreadAttributeList(ptr, 1, 0, &mut size) == 0 {
                return Err(error(
                    ErrorCode::SessionHelperUnavailable,
                    "Atributos indisponíveis",
                ));
            }
            let attributes = Self { bytes };
            if UpdateProcThreadAttribute(
                ptr,
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                (&job.0 as *const HANDLE).cast(),
                size_of::<HANDLE>(),
                null_mut(),
                null(),
            ) == 0
            {
                return Err(error(
                    ErrorCode::SessionHelperUnavailable,
                    "Job atômico indisponível",
                ));
            }
            Ok(attributes)
        }
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.bytes.as_mut_ptr().cast());
        }
    }
}

pub enum Probe {
    Ready,
    Busy,
    Starting,
    Exited,
}
/// Not constructible by a PID from the network: only launch() owns process/job handles.
pub struct Child {
    process: Handle,
    job: Handle,
    pid: u32,
    identity: Identity,
    startup_error: Option<SessionError>,
    _agent_image: TrustedImage,
    _helper_image: TrustedImage,
}
impl Child {
    pub fn pid(&self) -> u32 {
        self.pid
    }
    pub fn identity(&self) -> &Identity {
        &self.identity
    }
    fn exited(&self) -> bool {
        unsafe { WaitForSingleObject(self.process.0, 0) == WAIT_OBJECT_0 }
    }
    fn verify(&self) -> Result<()> {
        let token = process_token(self.process.0)?;
        unelevated(token.0, &self.identity)?;
        let _image = check_image(self.process.0, &expected_sibling(HELPER_IMAGE)?)?;
        let mut belongs = 0;
        unsafe {
            if GetProcessId(self.process.0) != self.pid
                || IsProcessInJob(self.process.0, self.job.0, &mut belongs) == 0
                || belongs == 0
            {
                return Err(error(
                    ErrorCode::SessionPeerRejected,
                    "Processo fora do lifecycle",
                ));
            }
        }
        Ok(())
    }
    pub fn retire(&self) -> Result<()> {
        if self.exited() {
            return Ok(());
        }
        self.verify()?;
        unsafe {
            if TerminateJobObject(self.job.0, 0) == 0
                || WaitForSingleObject(self.process.0, 2_000) != WAIT_OBJECT_0
            {
                return Err(error(
                    ErrorCode::SessionHelperUnavailable,
                    "Encerramento Helper pendente",
                ));
            }
        }
        Ok(())
    }
    pub fn probe(&self) -> Result<Probe> {
        if self.exited() {
            return Ok(Probe::Exited);
        }
        if let Some(error) = &self.startup_error {
            return Err(error.clone());
        }
        self.verify()?;
        if discover()? != self.identity {
            return Err(error(
                ErrorCode::SessionPeerRejected,
                "Sessão do lifecycle expirou",
            ));
        }
        let path = wide(&pipe_name(&self.identity));
        unsafe {
            if WaitNamedPipeW(path.as_ptr(), 1) == 0 {
                return match GetLastError() {
                    ERROR_FILE_NOT_FOUND => Ok(Probe::Starting),
                    ERROR_SEM_TIMEOUT | ERROR_PIPE_BUSY => Ok(Probe::Busy),
                    _ => Err(error(
                        ErrorCode::SessionHelperUnavailable,
                        "Named Pipe indisponível",
                    )),
                };
            }
        }
        let now = chrono::Utc::now().timestamp_millis();
        let request = Request::new(
            Operation::Info(EmptyPayload {}),
            self.identity.clone(),
            now,
            now + i64::from(PIPE_TIMEOUT_MS),
        );
        let response = exchange_owned(&request, self.pid)?;
        match response.outcome {
            Outcome::Completed {
                result: Data::Info(_),
            } => Ok(Probe::Ready),
            Outcome::Rejected { error } => Err(error),
            _ => Err(error(
                ErrorCode::SessionInvalidRequest,
                "Resposta de saúde divergente",
            )),
        }
    }
}
impl Drop for Child {
    fn drop(&mut self) {
        if !self.exited() && self.verify().is_err() {
            // A compromised/foreign process is quarantined, never killed by name or PID.
            // Disarm automatic termination; require administrative investigation.
            unsafe {
                let limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
                SetInformationJobObject(
                    self.job.0,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    size_of_val(&limits) as u32,
                );
            }
        }
        // Owned live children are killed when the last private job handle closes, including crashes.
    }
}

pub fn launch(identity: &Identity) -> Result<Child> {
    let (agent_image, helper_image) = service_images()?;
    if discover()? != *identity {
        return Err(error(
            ErrorCode::SessionPeerRejected,
            "Sessão mudou antes da criação",
        ));
    }
    let pipe = wide(&pipe_name(identity));
    unsafe {
        if WaitNamedPipeW(pipe.as_ptr(), 1) != 0 || GetLastError() != ERROR_FILE_NOT_FOUND {
            // Existing/unknown instance is not adopted or terminated.
            return Err(error(
                ErrorCode::SessionHelperUnavailable,
                "Pipe já ocupado ou não verificável",
            ));
        }
        let mut token = null_mut();
        if WTSQueryUserToken(identity.session_id, &mut token) == 0 {
            return Err(error(
                ErrorCode::SessionPeerRejected,
                "Token WTS indisponível",
            ));
        }
        let wts = Handle::checked(token, ErrorCode::SessionPeerRejected)?;
        let elevation = token_bytes(wts.0, TokenElevation)?;
        let linked = if (*(elevation.as_ptr().cast::<TOKEN_ELEVATION>())).TokenIsElevated != 0 {
            let bytes = token_bytes(wts.0, TokenLinkedToken)?;
            Some(Handle::checked(
                (*(bytes.as_ptr().cast::<TOKEN_LINKED_TOKEN>())).LinkedToken,
                ErrorCode::SessionPeerRejected,
            )?)
        } else {
            None
        };
        let source = linked.as_ref().unwrap_or(&wts);
        unelevated(source.0, identity)?;
        let mut primary = null_mut();
        if DuplicateTokenEx(
            source.0,
            TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY,
            null(),
            SecurityIdentification,
            TokenPrimary,
            &mut primary,
        ) == 0
        {
            return Err(error(
                ErrorCode::SessionPeerRejected,
                "Token primário indisponível",
            ));
        }
        let primary = Handle::checked(primary, ErrorCode::SessionPeerRejected)?;
        unelevated(primary.0, identity)?;
        let mut env = null_mut();
        if CreateEnvironmentBlock(&mut env, primary.0, 0) == 0 {
            return Err(error(
                ErrorCode::SessionHelperUnavailable,
                "Ambiente de usuário indisponível",
            ));
        }
        let env = Environment(env); // bInherit=false: no Agent/Backend secrets or handles inherited.
        let environment = user_environment(&env)?;
        let job = Handle::checked(
            CreateJobObjectW(null(), null()),
            ErrorCode::SessionHelperUnavailable,
        )?;
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
        limits.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
        limits.BasicLimitInformation.ActiveProcessLimit = 1;
        if SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of_val(&limits) as u32,
        ) == 0
        {
            return Err(error(
                ErrorCode::SessionHelperUnavailable,
                "Job privado indisponível",
            ));
        }
        let helper = expected_sibling(HELPER_IMAGE)?;
        let path = wide(&helper.to_string_lossy());
        let cwd = wide(
            &helper
                .parent()
                .ok_or_else(|| error(ErrorCode::SessionPeerRejected, "Instalação inválida"))?
                .to_string_lossy(),
        );
        let mut command = wide(&format!("\"{}\"", helper.display()));
        let mut desktop = wide("winsta0\\default");
        let mut attributes = Attributes::new(&job)?;
        let mut startup: STARTUPINFOEXW = zeroed();
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.lpDesktop = desktop.as_mut_ptr();
        startup.lpAttributeList = attributes.bytes.as_mut_ptr().cast();
        let mut created: PROCESS_INFORMATION = zeroed();
        if CreateProcessAsUserW(
            primary.0,
            path.as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            0,
            CREATE_SUSPENDED
                | CREATE_UNICODE_ENVIRONMENT
                | CREATE_NO_WINDOW
                | EXTENDED_STARTUPINFO_PRESENT,
            environment.as_ptr().cast(),
            cwd.as_ptr(),
            &startup.StartupInfo,
            &mut created,
        ) == 0
        {
            return Err(error(
                ErrorCode::SessionHelperUnavailable,
                "Criação Helper recusada",
            ));
        }
        let process = Handle::checked(created.hProcess, ErrorCode::SessionHelperUnavailable)?;
        let thread = Handle::checked(created.hThread, ErrorCode::SessionHelperUnavailable)?;
        drop(attributes);
        // Job assignment is atomic with creation, including Agent crashes before ResumeThread.
        let mut child = Child {
            process,
            job,
            pid: created.dwProcessId,
            identity: identity.clone(),
            startup_error: None,
            _agent_image: agent_image,
            _helper_image: helper_image,
        };
        // Once created, always transfer ownership to the supervisor, including failed verification.
        // It can retire a verified child or quarantine it without losing the handle and retrying
        // into an accumulation of suspended/unverifiable processes.
        let start = || -> Result<()> {
            child.verify()?;
            if discover()? != *identity || ResumeThread(thread.0) == u32::MAX {
                return Err(error(
                    ErrorCode::SessionHelperUnavailable,
                    "Sessão mudou ou início recusado",
                ));
            }
            Ok(())
        };
        child.startup_error = start().err();
        Ok(child)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn elevated_development_process_cannot_be_a_helper() {
        // Read-only token query. No process/service/ACL changes.
        let result = verify_user_process();
        let token = process_token(unsafe { GetCurrentProcess() }).unwrap();
        let elevation = token_bytes(token.0, TokenElevation).unwrap();
        if unsafe { (*(elevation.as_ptr().cast::<TOKEN_ELEVATION>())).TokenIsElevated } != 0 {
            assert_eq!(result.unwrap_err().code, ErrorCode::SessionPeerRejected);
        }
    }
    #[test]
    #[ignore = "opt-in: already installed/running Agent + Helper and eligible user; read-only kernel token/image queries"]
    fn installed_service_and_helper_have_matching_protected_user_context() {
        assert_eq!(
            std::env::var("CENTRAL_SOS_LIFECYCLE_TEST_AUTHORIZED").as_deref(),
            Ok("1")
        );
        let (agent, agent_identity) = process_identity(agent_pid().unwrap()).unwrap();
        assert_eq!(agent_identity.user_sid, "S-1-5-18");
        assert_eq!(agent_identity.session_id, 0);
        let agent_path = image_path(agent.0).unwrap();
        assert_eq!(
            agent_path.file_name().unwrap().to_string_lossy(),
            AGENT_IMAGE
        );
        let _agent_image = trusted_image(&agent_path).unwrap();
        let identity = own_identity().unwrap();
        assert_eq!(
            session_state(identity.session_id).unwrap(),
            SessionState::Active
        );
        // PID is only a test observation input, never a launch/termination/adoption input.
        let pid = std::env::var("CENTRAL_SOS_TEST_HELPER_PID")
            .unwrap()
            .parse::<u32>()
            .unwrap();
        let (helper, helper_identity) = process_identity(pid).unwrap();
        assert_eq!(helper_identity, identity);
        unelevated(process_token(helper.0).unwrap().0, &identity).unwrap();
        let _helper_image =
            check_image(helper.0, &agent_path.parent().unwrap().join(HELPER_IMAGE)).unwrap();
    }
    #[test]
    fn helper_environment_excludes_custom_secrets_and_credentials() {
        let mut bytes = wide("SystemRoot=C:\\Windows");
        bytes.extend(wide("CENTRAL_SOS_TOKEN=fixture"));
        bytes.extend(wide("PATH=untrusted"));
        bytes.extend(wide("APPDATA=C:\\User\\AppData"));
        bytes.push(0);
        let borrowed = Environment(bytes.as_mut_ptr().cast());
        let result = user_environment(&borrowed).unwrap();
        std::mem::forget(borrowed); // borrowed fixture is not a userenv allocation
        let text = String::from_utf16_lossy(&result);
        assert!(text.contains("SystemRoot=") && text.contains("APPDATA="));
        assert!(!text.contains("TOKEN") && !text.contains("PATH="));
    }
}
