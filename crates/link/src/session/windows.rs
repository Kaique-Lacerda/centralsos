//! Windows-only local transport. All peer identities come from kernel handles/tokens.
use super::*;
use std::{
    ffi::c_void,
    mem::{size_of, zeroed},
    path::{Path, PathBuf},
    ptr::{null, null_mut},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    Storage::FileSystem::*,
    System::{Pipes::*, RemoteDesktop::*, Services::*, Threading::*, IO::*},
};

mod image_security;
pub use image_security::trusted_image;
use image_security::TrustedImage;

pub struct Handle(pub HANDLE);
impl Handle {
    fn checked(handle: HANDLE, code: ErrorCode) -> Result<Self> {
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            Err(SessionError::new(code, "Handle Windows indisponível"))
        } else {
            Ok(Self(handle))
        }
    }
}
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
fn error(code: ErrorCode, message: &str) -> SessionError {
    SessionError::new(code, message)
}
pub fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}
fn sid_text(sid: PSID) -> Result<String> {
    unsafe {
        let mut value = null_mut();
        if IsValidSid(sid) == 0 || ConvertSidToStringSidW(sid, &mut value) == 0 {
            return Err(error(ErrorCode::SessionPeerRejected, "SID inválido"));
        }
        let text = read_wide(value, 184);
        LocalFree(value.cast());
        text
    }
}
pub unsafe fn read_wide(ptr: *const u16, maximum: usize) -> Result<String> {
    if ptr.is_null() {
        return Ok(String::new());
    }
    for n in 0..maximum {
        if *ptr.add(n) == 0 {
            return String::from_utf16(std::slice::from_raw_parts(ptr, n))
                .map_err(|_| error(ErrorCode::SessionCollectionFailed, "Texto Windows inválido"));
        }
    }
    Err(error(
        ErrorCode::SessionCollectionFailed,
        "Texto Windows acima do limite",
    ))
}
fn token_bytes(token: HANDLE, class: TOKEN_INFORMATION_CLASS) -> Result<Vec<usize>> {
    unsafe {
        let mut length = 0;
        GetTokenInformation(token, class, null_mut(), 0, &mut length);
        if length == 0 || length > 65536 {
            return Err(error(
                ErrorCode::SessionPeerRejected,
                "Token não verificável",
            ));
        }
        let mut bytes = vec![0usize; (length as usize).div_ceil(size_of::<usize>())];
        if GetTokenInformation(token, class, bytes.as_mut_ptr().cast(), length, &mut length) == 0 {
            return Err(error(
                ErrorCode::SessionPeerRejected,
                "Token não verificável",
            ));
        }
        Ok(bytes)
    }
}
pub fn token_identity(token: HANDLE) -> Result<Identity> {
    let user = token_bytes(token, TokenUser)?;
    let session = token_bytes(token, TokenSessionId)?;
    let groups = token_bytes(token, TokenGroups)?;
    unsafe {
        let user_sid = sid_text((*(user.as_ptr().cast::<TOKEN_USER>())).User.Sid)?;
        let group = &*groups.as_ptr().cast::<TOKEN_GROUPS>();
        let count = group.GroupCount as usize;
        if count > 1024
            || size_of::<u32>() + count * size_of::<SID_AND_ATTRIBUTES>()
                > groups.len() * size_of::<usize>()
        {
            return Err(error(
                ErrorCode::SessionPeerRejected,
                "Grupos de token inválidos",
            ));
        }
        let entries = std::slice::from_raw_parts(group.Groups.as_ptr(), count);
        const LOGON_ID_ATTRIBUTES: u32 = 0xc0000000; // SE_GROUP_LOGON_ID, WinNT.h
        let logon = entries
            .iter()
            .find(|g| g.Attributes & LOGON_ID_ATTRIBUTES == LOGON_ID_ATTRIBUTES);
        let logon_sid = logon
            .map(|g| sid_text(g.Sid))
            .transpose()?
            .unwrap_or_default();
        Ok(Identity {
            session_id: *(session.as_ptr().cast::<u32>()),
            user_sid,
            logon_sid,
        })
    }
}
pub fn process_identity(pid: u32) -> Result<(Handle, Identity)> {
    unsafe {
        let process = Handle::checked(
            OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid),
            ErrorCode::SessionPeerRejected,
        )?;
        let mut token = null_mut();
        if OpenProcessToken(process.0, TOKEN_QUERY, &mut token) == 0 {
            return Err(error(
                ErrorCode::SessionPeerRejected,
                "Token da contraparte indisponível",
            ));
        }
        let token = Handle::checked(token, ErrorCode::SessionPeerRejected)?;
        let identity = token_identity(token.0)?;
        Ok((process, identity))
    }
}
pub fn own_identity() -> Result<Identity> {
    process_identity(unsafe { GetCurrentProcessId() }).map(|(_, identity)| identity)
}

fn query_session(id: u32, class: WTS_INFO_CLASS) -> Result<Vec<u8>> {
    unsafe {
        let (mut buffer, mut bytes) = (null_mut(), 0);
        if WTSQuerySessionInformationW(null_mut(), id, class, &mut buffer, &mut bytes) == 0
            || buffer.is_null()
        {
            return Err(error(
                ErrorCode::SessionStateUnknown,
                "WTS não confirmou o estado da sessão",
            ));
        }
        let data = std::slice::from_raw_parts(buffer.cast::<u8>(), bytes as usize).to_vec();
        WTSFreeMemory(buffer.cast());
        Ok(data)
    }
}
fn session_text(id: u32, class: WTS_INFO_CLASS) -> Result<String> {
    let data = query_session(id, class)?;
    if data.len() % 2 != 0 || data.len() > 2048 {
        return Err(error(ErrorCode::SessionStateUnknown, "Campo WTS inválido"));
    }
    let units: Vec<u16> = data
        .chunks_exact(2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .take_while(|u| *u != 0)
        .collect();
    String::from_utf16(&units)
        .map_err(|_| error(ErrorCode::SessionStateUnknown, "Texto WTS inválido"))
}
pub fn session_state(id: u32) -> Result<SessionState> {
    let data = query_session(id, WTSSessionInfoEx)?;
    if data.len() < size_of::<WTSINFOEXW>() {
        return Err(error(
            ErrorCode::SessionStateUnknown,
            "WTSINFOEX incompleto",
        ));
    }
    let info = unsafe { std::ptr::read_unaligned(data.as_ptr().cast::<WTSINFOEXW>()) };
    if info.Level != 1 {
        return Ok(SessionState::Unknown);
    }
    let detail = unsafe { info.Data.WTSInfoExLevel1 };
    if detail.SessionId != id {
        return Ok(SessionState::Unknown);
    }
    if detail.SessionState == WTSDisconnected {
        return Ok(SessionState::Disconnected);
    }
    if detail.SessionState != WTSActive {
        return Ok(SessionState::Unknown);
    }
    // Windows 10/11 and current Windows Server; Windows 7/2008 R2 are unsupported.
    Ok(match detail.SessionFlags {
        0 => SessionState::Locked,
        1 => SessionState::Active,
        _ => SessionState::Unknown,
    })
}
pub fn discover() -> Result<Identity> {
    if own_identity()?.user_sid != "S-1-5-18" {
        return Err(error(
            ErrorCode::SessionPeerRejected,
            "Descoberta exige Agent LocalSystem",
        ));
    }
    unsafe {
        let (mut entries, mut count) = (null_mut(), 0);
        if WTSEnumerateSessionsW(null_mut(), 0, 1, &mut entries, &mut count) == 0 {
            return Err(error(
                ErrorCode::SessionStateUnknown,
                "Enumeração WTS indisponível",
            ));
        }
        let rows = if count == 0 {
            Vec::new()
        } else {
            std::slice::from_raw_parts(entries, count as usize).to_vec()
        };
        if !entries.is_null() {
            WTSFreeMemory(entries.cast());
        }
        let mut candidates = Vec::new();
        for row in rows {
            if row.SessionId == 0 || row.State == WTSListen || row.State == WTSDown {
                continue;
            }
            if session_text(row.SessionId, WTSUserName)?.is_empty() {
                continue;
            }
            let mut token = null_mut();
            if WTSQueryUserToken(row.SessionId, &mut token) == 0 {
                return Err(error(
                    ErrorCode::SessionStateUnknown,
                    "Token interativo não verificável; nenhuma sessão presumida",
                ));
            }
            let token = Handle::checked(token, ErrorCode::SessionStateUnknown)?;
            let identity = token_identity(token.0)?;
            if identity.session_id != row.SessionId {
                return Err(error(
                    ErrorCode::SessionPeerRejected,
                    "Token WTS de outra sessão",
                ));
            }
            candidates.push(Candidate {
                identity,
                state: session_state(row.SessionId)?,
            });
        }
        select_session(&candidates)
    }
}
pub fn info(identity: &Identity) -> Result<Info> {
    if own_identity()? != *identity {
        return Err(error(
            ErrorCode::SessionPeerRejected,
            "Token da sessão mudou antes da coleta",
        ));
    }
    select_session(&[Candidate {
        identity: identity.clone(),
        state: session_state(identity.session_id)?,
    }])?;
    Ok(Info {
        session: identity.clone(),
        username: session_text(identity.session_id, WTSUserName)?,
        domain: session_text(identity.session_id, WTSDomainName)?,
        state: "active".into(),
    })
}
pub fn pipe_name(identity: &Identity) -> String {
    use sha2::{Digest, Sha256};
    format!(
        r"\\.\pipe\CENTRAL-SOS-Session-v1-{}-{:x}",
        identity.session_id,
        Sha256::digest(identity.logon_sid.as_bytes())
    )
}

fn trusted_sid(sid: &str) -> bool {
    [
        "S-1-5-18",
        "S-1-5-32-544",
        "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
    ]
    .contains(&sid)
}
fn image_path(process: HANDLE) -> Result<PathBuf> {
    unsafe {
        let mut path = vec![0u16; 32768];
        let mut count = path.len() as u32;
        if QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut count) == 0 {
            return Err(error(
                ErrorCode::SessionPeerRejected,
                "Imagem da contraparte indisponível",
            ));
        }
        Ok(PathBuf::from(String::from_utf16_lossy(
            &path[..count as usize],
        )))
    }
}
fn expected_sibling(name: &str) -> Result<PathBuf> {
    let current = std::env::current_exe()
        .map_err(|_| error(ErrorCode::SessionPeerRejected, "Imagem atual indisponível"))?;
    Ok(current
        .parent()
        .ok_or_else(|| {
            error(
                ErrorCode::SessionPeerRejected,
                "Diretório de instalação ausente",
            )
        })?
        .join(name))
}
fn check_image(process: HANDLE, expected: &Path) -> Result<TrustedImage> {
    let actual = image_path(process)?;
    if !actual
        .to_string_lossy()
        .eq_ignore_ascii_case(&expected.to_string_lossy())
    {
        return Err(error(
            ErrorCode::SessionPeerRejected,
            "Imagem da contraparte não é o binário instalado esperado",
        ));
    }
    trusted_image(expected)
}
fn agent_pid() -> Result<u32> {
    unsafe {
        let manager = OpenSCManagerW(null(), null(), SC_MANAGER_CONNECT);
        if manager.is_null() {
            return Err(error(ErrorCode::SessionPeerRejected, "SCM indisponível"));
        }
        let service = OpenServiceW(
            manager,
            wide("CentralSOSAgent").as_ptr(),
            SERVICE_QUERY_STATUS,
        );
        CloseServiceHandle(manager);
        if service.is_null() {
            return Err(error(
                ErrorCode::SessionPeerRejected,
                "Agent não registrado no SCM",
            ));
        }
        let mut status: SERVICE_STATUS_PROCESS = zeroed();
        let mut needed = 0;
        let ok = QueryServiceStatusEx(
            service,
            SC_STATUS_PROCESS_INFO,
            (&mut status as *mut SERVICE_STATUS_PROCESS).cast(),
            size_of::<SERVICE_STATUS_PROCESS>() as u32,
            &mut needed,
        );
        CloseServiceHandle(service);
        if ok == 0 || status.dwCurrentState != SERVICE_RUNNING || status.dwProcessId == 0 {
            return Err(error(
                ErrorCode::SessionPeerRejected,
                "Agent não está executando no SCM",
            ));
        }
        Ok(status.dwProcessId)
    }
}
struct AuthenticatedPeer {
    _process: Handle,
    _image: TrustedImage,
}
fn authenticate_agent(pipe: HANDLE) -> Result<AuthenticatedPeer> {
    unsafe {
        let (mut pid, mut session) = (0, 0);
        if GetNamedPipeClientProcessId(pipe, &mut pid) == 0
            || GetNamedPipeClientSessionId(pipe, &mut session) == 0
            || pid != agent_pid()?
            || session != 0
        {
            return Err(error(
                ErrorCode::SessionPeerRejected,
                "Cliente não é o Agent Service",
            ));
        }
        let (process, identity) = process_identity(pid)?;
        if identity.user_sid != "S-1-5-18" || identity.session_id != 0 {
            return Err(error(
                ErrorCode::SessionPeerRejected,
                "Agent precisa de LocalSystem/Session 0",
            ));
        }
        let image = check_image(process.0, &expected_sibling("central-sos-agent.exe")?)?;
        Ok(AuthenticatedPeer {
            _process: process,
            _image: image,
        })
    }
}
fn authenticate_helper(pipe: HANDLE, expected: &Identity) -> Result<AuthenticatedPeer> {
    unsafe {
        let (mut pid, mut session) = (0, 0);
        if GetNamedPipeServerProcessId(pipe, &mut pid) == 0
            || GetNamedPipeServerSessionId(pipe, &mut session) == 0
            || session != expected.session_id
        {
            return Err(error(
                ErrorCode::SessionPeerRejected,
                "Servidor pertence a outra sessão",
            ));
        }
        let (process, identity) = process_identity(pid)?;
        if &identity != expected {
            return Err(error(
                ErrorCode::SessionPeerRejected,
                "Token do Helper divergente",
            ));
        }
        let image = check_image(
            process.0,
            &expected_sibling("central-sos-session-helper.exe")?,
        )?;
        Ok(AuthenticatedPeer {
            _process: process,
            _image: image,
        })
    }
}

fn wait_io(
    pipe: HANDLE,
    overlap: &mut OVERLAPPED,
    immediate: i32,
    deadline: Instant,
) -> Result<u32> {
    unsafe {
        if immediate == 0 && GetLastError() != ERROR_IO_PENDING {
            return Err(error(
                ErrorCode::SessionHelperUnavailable,
                "Operação Named Pipe falhou",
            ));
        }
        let ms = deadline
            .saturating_duration_since(Instant::now())
            .as_millis()
            .min(u128::from(u32::MAX - 1)) as u32;
        let wait = WaitForSingleObject(overlap.hEvent, ms);
        if wait != WAIT_OBJECT_0 {
            CancelIoEx(pipe, overlap);
            let mut ignored = 0;
            GetOverlappedResult(pipe, overlap, &mut ignored, 1);
            return Err(error(ErrorCode::SessionTimeout, "Timeout do Named Pipe"));
        }
        let mut transferred = 0;
        if GetOverlappedResult(pipe, overlap, &mut transferred, 0) == 0 {
            return Err(error(
                ErrorCode::SessionHelperUnavailable,
                "Transferência Named Pipe falhou",
            ));
        }
        Ok(transferred)
    }
}
fn io(pipe: HANDLE, bytes: &mut [u8], write: bool, deadline: Instant) -> Result<()> {
    let mut offset = 0;
    while offset < bytes.len() {
        if Instant::now() >= deadline {
            return Err(error(ErrorCode::SessionTimeout, "Timeout de IPC"));
        }
        unsafe {
            let event = Handle::checked(
                CreateEventW(null(), 1, 0, null()),
                ErrorCode::SessionHelperUnavailable,
            )?;
            let mut overlap: OVERLAPPED = zeroed();
            overlap.hEvent = event.0;
            let length = (bytes.len() - offset) as u32;
            let immediate = if write {
                WriteFile(
                    pipe,
                    bytes[offset..].as_ptr(),
                    length,
                    null_mut(),
                    &mut overlap,
                )
            } else {
                ReadFile(
                    pipe,
                    bytes[offset..].as_mut_ptr(),
                    length,
                    null_mut(),
                    &mut overlap,
                )
            };
            let count = wait_io(pipe, &mut overlap, immediate, deadline)? as usize;
            if count == 0 {
                return Err(error(ErrorCode::SessionHelperUnavailable, "Pipe encerrado"));
            }
            offset += count;
        }
    }
    Ok(())
}
fn read_frame(pipe: HANDLE, deadline: Instant) -> Result<Vec<u8>> {
    let mut prefix = [0u8; 4];
    io(pipe, &mut prefix, false, deadline)?;
    let length = u32::from_le_bytes(prefix) as usize;
    size(length)?;
    let mut bytes = vec![0; length];
    io(pipe, &mut bytes, false, deadline)?;
    Ok(bytes)
}
fn write_frame(pipe: HANDLE, mut bytes: Vec<u8>, deadline: Instant) -> Result<()> {
    size(bytes.len())?;
    let mut prefix = (bytes.len() as u32).to_le_bytes();
    io(pipe, &mut prefix, true, deadline)?;
    io(pipe, &mut bytes, true, deadline)
}
pub fn exchange(request: &Request) -> Result<Response> {
    request.validate(&request.session, chrono::Utc::now().timestamp_millis())?;
    let fresh = discover()?;
    if fresh != request.session {
        return Err(error(
            ErrorCode::SessionPeerRejected,
            "Sessão mudou antes do IPC",
        ));
    }
    let deadline = Instant::now()
        + Duration::from_millis(
            u64::from(PIPE_TIMEOUT_MS).min(
                request
                    .expires_at
                    .saturating_sub(chrono::Utc::now().timestamp_millis())
                    .max(0) as u64,
            ),
        );
    let path = wide(&pipe_name(&fresh));
    unsafe {
        // Explicit identification-only SQOS: a user-owned server cannot impersonate SYSTEM.
        let pipe = Handle::checked(
            CreateFileW(
                path.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                null_mut(),
            ),
            ErrorCode::SessionHelperUnavailable,
        )?;
        let _peer = authenticate_helper(pipe.0, &fresh)?;
        write_frame(pipe.0, encode(request)?, deadline)?;
        let response: Response = serde_json::from_slice(&read_frame(pipe.0, deadline)?)
            .map_err(|_| error(ErrorCode::SessionInvalidRequest, "Resposta IPC inválida"))?;
        response.validate(request, chrono::Utc::now().timestamp_millis())?;
        // Do not disconnect the server while its response is still buffered in the pipe.
        io(pipe.0, &mut [1u8], true, deadline)?;
        if discover()? != fresh {
            return Err(error(
                ErrorCode::SessionPeerRejected,
                "Sessão mudou durante o IPC",
            ));
        }
        Ok(response)
    }
}
pub fn serve(mut executor: impl FnMut(&Operation, &Identity) -> Result<Data>) -> Result<()> {
    let identity = own_identity()?;
    if identity.session_id == 0 || identity.user_sid == "S-1-5-18" || identity.logon_sid.is_empty()
    {
        return Err(error(
            ErrorCode::SessionRequired,
            "Helper exige token do usuário interativo; SYSTEM recusado",
        ));
    }
    let _installed_image = trusted_image(
        &std::env::current_exe()
            .map_err(|_| error(ErrorCode::SessionPeerRejected, "Imagem Helper indisponível"))?,
    )?;
    let pipe_path = wide(&pipe_name(&identity));
    // Only SYSTEM can connect; owner is the real helper user. No Everyone/BA/user clients.
    let sddl = wide(&format!("O:{}D:P(A;;GA;;;SY)", identity.user_sid));
    let mut replay = ReplayGuard::default();
    unsafe {
        let mut descriptor = null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            null_mut(),
        ) == 0
        {
            return Err(error(
                ErrorCode::SessionPeerRejected,
                "DACL do pipe indisponível",
            ));
        }
        struct Descriptor(*mut c_void);
        impl Drop for Descriptor {
            fn drop(&mut self) {
                unsafe {
                    LocalFree(self.0);
                }
            }
        }
        let _descriptor = Descriptor(descriptor);
        let attributes = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        // Keep this first instance open across requests; no namespace takeover gap.
        let pipe = Handle::checked(
            CreateNamedPipeW(
                pipe_path.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                8192,
                8192,
                PIPE_TIMEOUT_MS,
                &attributes,
            ),
            ErrorCode::SessionHelperUnavailable,
        )?;
        loop {
            if own_identity()? != identity {
                return Err(error(
                    ErrorCode::SessionPeerRejected,
                    "Token do Helper mudou",
                ));
            }
            let event = Handle::checked(
                CreateEventW(null(), 1, 0, null()),
                ErrorCode::SessionHelperUnavailable,
            )?;
            let mut overlap: OVERLAPPED = zeroed();
            overlap.hEvent = event.0;
            let connected = ConnectNamedPipe(pipe.0, &mut overlap);
            let rc = GetLastError();
            if connected == 0 && rc != ERROR_PIPE_CONNECTED {
                if rc != ERROR_IO_PENDING {
                    return Err(error(
                        ErrorCode::SessionHelperUnavailable,
                        "ConnectNamedPipe falhou",
                    ));
                }
                // Idle wait has no request; polls permit graceful return if process session vanished.
                loop {
                    match WaitForSingleObject(event.0, 1000) {
                        WAIT_OBJECT_0 => break,
                        WAIT_TIMEOUT => continue,
                        _ => {
                            CancelIoEx(pipe.0, &overlap);
                            let mut n = 0;
                            GetOverlappedResult(pipe.0, &overlap, &mut n, 1);
                            return Err(error(
                                ErrorCode::SessionHelperUnavailable,
                                "Espera do pipe falhou",
                            ));
                        }
                    }
                }
                let mut n = 0;
                if GetOverlappedResult(pipe.0, &overlap, &mut n, 0) == 0 {
                    return Err(error(
                        ErrorCode::SessionHelperUnavailable,
                        "Conexão do pipe falhou",
                    ));
                }
            }
            let deadline = Instant::now() + Duration::from_millis(u64::from(PIPE_TIMEOUT_MS));
            let mut retire = false;
            let transaction = (|| -> Result<()> {
                let _peer = authenticate_agent(pipe.0)?;
                let frame = read_frame(pipe.0, deadline)?;
                let request = decode_request(&frame)?;
                let result = (|| {
                    let data = execute_frame(
                        &frame,
                        &identity,
                        &mut replay,
                        chrono::Utc::now().timestamp_millis(),
                        |operation| {
                            info(&identity)?;
                            executor(operation, &identity)
                        },
                    )?;
                    request.validate(&identity, chrono::Utc::now().timestamp_millis())?;
                    info(&identity)?;
                    if data.name() != request.operation.name() {
                        return Err(error(
                            ErrorCode::SessionInvalidRequest,
                            "Executor retornou operação divergente",
                        ));
                    }
                    Ok(data)
                })();
                let outcome = match result {
                    Ok(result) => Outcome::Completed { result },
                    Err(error) => {
                        retire = error.code == ErrorCode::SessionTimeout;
                        Outcome::Rejected { error }
                    }
                };
                let response =
                    Response::for_request(&request, outcome, chrono::Utc::now().timestamp_millis());
                let bytes = encode(&response).or_else(|e| {
                    encode(&Response::for_request(
                        &request,
                        Outcome::Rejected { error: e },
                        chrono::Utc::now().timestamp_millis(),
                    ))
                })?;
                write_frame(pipe.0, bytes, deadline)?;
                let mut consumed = [0u8];
                io(pipe.0, &mut consumed, false, deadline)?;
                if consumed != [1] {
                    return Err(error(
                        ErrorCode::SessionInvalidRequest,
                        "ACK de consumo inválido",
                    ));
                }
                Ok(())
            })();
            // Never log user inventories/SIDs/credentials. Invalid unauthenticated frames are closed.
            if let Err(e) = transaction {
                eprintln!("Session Helper IPC: {e}");
            }
            DisconnectNamedPipe(pipe.0);
            if retire {
                return Err(error(
                    ErrorCode::SessionTimeout,
                    "Helper encerrado após timeout de coleta",
                ));
            }
        }
    }
}
#[cfg(test)]
mod transport_tests {
    use super::*;
    #[test]
    fn rejects_agent_and_helper_images_other_than_the_expected_siblings() {
        for name in ["central-sos-agent.exe", "central-sos-session-helper.exe"] {
            let expected = expected_sibling(name).unwrap();
            let failure = check_image(unsafe { GetCurrentProcess() }, &expected).unwrap_err();
            assert_eq!(failure.code, ErrorCode::SessionPeerRejected);
            assert_eq!(
                failure.message,
                "Imagem da contraparte não é o binário instalado esperado"
            );
        }
    }
    #[test]
    fn real_windows_pipe_framing_timeout_and_fake_helper_rejection() {
        let name = wide(&format!(
            r"\\.\pipe\CENTRAL-SOS-test-{}",
            uuid::Uuid::new_v4()
        ));
        // Isolated read-only fixture. No Agent service/enrollment/production endpoint involved.
        unsafe {
            let sid = own_identity().unwrap().user_sid;
            let mut descriptor = null_mut();
            let sddl = wide(&format!("D:P(A;;GA;;;{})", sid));
            assert_ne!(
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    1,
                    &mut descriptor,
                    null_mut()
                ),
                0
            );
            let attributes = SECURITY_ATTRIBUTES {
                nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor,
                bInheritHandle: 0,
            };
            let server = Handle::checked(
                CreateNamedPipeW(
                    name.as_ptr(),
                    PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
                    PIPE_TYPE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                    1,
                    8192,
                    8192,
                    100,
                    &attributes,
                ),
                ErrorCode::SessionHelperUnavailable,
            )
            .unwrap();
            LocalFree(descriptor);
            let event = Handle(CreateEventW(null(), 1, 0, null()));
            let mut overlap: OVERLAPPED = zeroed();
            overlap.hEvent = event.0;
            assert_eq!(ConnectNamedPipe(server.0, &mut overlap), 0);
            assert_eq!(GetLastError(), ERROR_IO_PENDING);
            let client = Handle::checked(
                CreateFileW(
                    name.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    null(),
                    OPEN_EXISTING,
                    FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                    null_mut(),
                ),
                ErrorCode::SessionHelperUnavailable,
            )
            .unwrap();
            wait_io(
                server.0,
                &mut overlap,
                1,
                Instant::now() + Duration::from_secs(1),
            )
            .unwrap();
            let deadline = Instant::now() + Duration::from_secs(1);
            write_frame(client.0, b"fixture".to_vec(), deadline).unwrap();
            assert_eq!(read_frame(server.0, deadline).unwrap(), b"fixture");
            let fake_identity = Identity {
                session_id: u32::MAX,
                user_sid: "S-1-5-21-1".into(),
                logon_sid: "S-1-5-5-1-1".into(),
            };
            assert!(matches!(
                authenticate_helper(client.0, &fake_identity),
                Err(SessionError {
                    code: ErrorCode::SessionPeerRejected,
                    ..
                })
            ));
            assert!(matches!(
                authenticate_agent(server.0),
                Err(SessionError {
                    code: ErrorCode::SessionPeerRejected,
                    ..
                })
            ));
            let mut oversized = (MAX_MESSAGE_BYTES as u32 + 1).to_le_bytes();
            io(client.0, &mut oversized, true, deadline).unwrap();
            assert_eq!(
                read_frame(server.0, deadline).unwrap_err().code,
                ErrorCode::SessionMessageTooLarge
            );
            assert_eq!(
                read_frame(server.0, Instant::now() + Duration::from_millis(20))
                    .unwrap_err()
                    .code,
                ErrorCode::SessionTimeout
            );
            DisconnectNamedPipe(server.0);
        }
    }
}
