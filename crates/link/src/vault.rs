use super::protocol::{CommunicationStatus, Link};
use std::path::PathBuf;
pub fn fingerprint() -> Result<String, String> {
    #[cfg(windows)]
    unsafe {
        use sha2::{Digest, Sha256};
        use windows_sys::Win32::System::Registry::*;
        let path = "SOFTWARE\\Microsoft\\Cryptography"
            .encode_utf16()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let value = "MachineGuid"
            .encode_utf16()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let mut b = [0u16; 256];
        let mut size = 512;
        let rc = RegGetValueW(
            HKEY_LOCAL_MACHINE,
            path.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY,
            std::ptr::null_mut(),
            b.as_mut_ptr().cast(),
            &mut size,
        );
        if rc != 0 {
            return Err("Identificador mínimo da máquina indisponível".into());
        }
        let n = b.iter().position(|v| *v == 0).unwrap_or(256);
        Ok(format!(
            "{:x}",
            Sha256::digest(String::from_utf16_lossy(&b[..n]).as_bytes())
        ))
    }
    #[cfg(not(windows))]
    {
        Err("Fingerprint exige Windows".into())
    }
}
pub fn root() -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Shell::SHGetFolderPathW;
        let mut path = [0u16; 260];
        let rc = unsafe {
            SHGetFolderPathW(
                std::ptr::null_mut(),
                0x23,
                std::ptr::null_mut(),
                0,
                path.as_mut_ptr(),
            )
        };
        if rc != 0 {
            return Err("ProgramData oficial indisponível".into());
        }
        let n = path.iter().position(|c| *c == 0).unwrap_or(260);
        Ok(PathBuf::from(String::from_utf16_lossy(&path[..n]))
            .join("CENTRAL SOS")
            .join("Agent"))
    }
    #[cfg(not(windows))]
    {
        Err("O Agent exige Windows".into())
    }
}
pub fn secure_root() -> Result<PathBuf, String> {
    let root = root()?;
    // Never follow a pre-existing link/junction when creating the credential directory.
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        for path in root.ancestors() {
            if let Ok(meta) = std::fs::symlink_metadata(path) {
                if meta.file_attributes() & 0x400 != 0 {
                    return Err("Diretório do Agent contém um ponto de redirecionamento".into());
                }
            }
        }
    }
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::{
            Foundation::LocalFree,
            Security::Authorization::{
                ConvertStringSecurityDescriptorToSecurityDescriptorW, SetNamedSecurityInfoW,
                SE_FILE_OBJECT,
            },
            Security::{
                GetSecurityDescriptorDacl, GetSecurityDescriptorOwner, OWNER_SECURITY_INFORMATION, DACL_SECURITY_INFORMATION,
                PROTECTED_DACL_SECURITY_INFORMATION,
            },
        };
        let sddl = "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
            .encode_utf16()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let mut sd = std::ptr::null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut sd,
            std::ptr::null_mut(),
        ) == 0
        {
            return Err("ACL do Agent indisponível".into());
        }
        let (mut present, mut defaulted) = (0, 0);
        let mut acl = std::ptr::null_mut(); let mut owner = std::ptr::null_mut();
        let ok = GetSecurityDescriptorDacl(sd, &mut present, &mut acl, &mut defaulted);
        let owner_ok = GetSecurityDescriptorOwner(sd, &mut owner, &mut defaulted);
        if ok == 0 || owner_ok == 0 { LocalFree(sd); return Err("ACL/owner do Agent indisponível".into()); }
        let protect = |target: &std::path::Path, create: bool| -> Result<(), String> {
            if target.exists() { trusted_owner(target)?; }
            else if create { std::fs::create_dir(target).map_err(|e|e.to_string())?; }
            else { return Err("Estado local mudou durante a verificação".into()); }
            reject_reparse(target)?;
            let path=target.as_os_str().to_string_lossy().encode_utf16().chain(Some(0)).collect::<Vec<_>>();
            let rc=SetNamedSecurityInfoW(path.as_ptr(),SE_FILE_OBJECT,DACL_SECURITY_INFORMATION|OWNER_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION,owner,std::ptr::null_mut(),acl,std::ptr::null_mut());
            if rc!=0 { return Err("Não foi possível proteger pasta/estado do Agent (owner Administradores, DACL SYSTEM/Administradores)".into()); }
            Ok(())
        };
        // Secure the application parent before creating/reading anything underneath it.
        let result: Result<(), String>=(|| {
            protect(root.parent().ok_or("Diretório local inválido")?,true)?;
            protect(&root,true)?;
            for entry in std::fs::read_dir(&root).map_err(|e|e.to_string())? {
                let path=entry.map_err(|e|e.to_string())?.path();
                protect(&path,false)?;
            }
            Ok(())
        })();
        LocalFree(sd);
        result?;
    }
    #[cfg(not(windows))]
    return Err("Estado do Agent exige Windows".into());

    Ok(root)
}
#[cfg(windows)]
fn reject_reparse(path: &std::path::Path) -> Result<(),String> {
    use windows_sys::Win32::{Foundation::{CloseHandle,INVALID_HANDLE_VALUE},Storage::FileSystem::*};
    let path=path.as_os_str().to_string_lossy().encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    unsafe {
        let handle=CreateFileW(path.as_ptr(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,std::ptr::null(),OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,std::ptr::null_mut());
        if handle==INVALID_HANDLE_VALUE { return Err("Estado local não verificável".into()); }
        let mut info:BY_HANDLE_FILE_INFORMATION=std::mem::zeroed();
        let rc=GetFileInformationByHandle(handle,&mut info); CloseHandle(handle);
        if rc==0 { return Err("Metadados do estado local indisponíveis".into()); }
        if info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT!=0 || info.nNumberOfLinks>1 { return Err("Link/reparse point não permitido no estado do Agent".into()); }
    }
    Ok(())
}
#[cfg(windows)]
fn trusted_owner(path: &std::path::Path) -> Result<(),String> {
    use windows_sys::Win32::{Foundation::LocalFree, Security::{EqualSid, GetAce, ACCESS_ALLOWED_ACE, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, Authorization::{GetNamedSecurityInfoW,ConvertStringSidToSidW,SE_FILE_OBJECT}}};
    reject_reparse(path)?;
    let path=path.as_os_str().to_string_lossy().encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let mut owner=std::ptr::null_mut(); let mut descriptor=std::ptr::null_mut(); let mut acl=std::ptr::null_mut();
    unsafe {
        let rc=GetNamedSecurityInfoW(path.as_ptr(),SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION,&mut owner,std::ptr::null_mut(),&mut acl,std::ptr::null_mut(),&mut descriptor);
        if rc!=0 { if !descriptor.is_null() { LocalFree(descriptor); } return Err("Owner do estado local indisponível".into()); }
        let mut trusted=false; let mut sids=Vec::new();
        for value in ["S-1-5-18","S-1-5-32-544"] {
            let value=value.encode_utf16().chain(Some(0)).collect::<Vec<_>>(); let mut sid=std::ptr::null_mut();
            if ConvertStringSidToSidW(value.as_ptr(),&mut sid)!=0 { trusted |= EqualSid(owner,sid)!=0; sids.push(sid); }
        }
        // Machine DPAPI is not a substitute for file access control: reject broad/unknown ACLs.
        let mut strict= !acl.is_null() && sids.len()==2;
        if strict {
            for index in 0..(*acl).AceCount {
                let mut ace=std::ptr::null_mut();
                if GetAce(acl,u32::from(index),&mut ace)==0 || ace.is_null() { strict=false; break; }
                let row=&*(ace as *const ACCESS_ALLOWED_ACE);
                if row.Header.AceType!=0 || !sids.iter().any(|sid| EqualSid(*sid,std::ptr::addr_of!(row.SidStart).cast_mut().cast())!=0) { strict=false; break; }
            }
        }
        for sid in sids { LocalFree(sid); }
        LocalFree(descriptor);
        if !trusted || !strict { return Err("Estado/pasta do Agent com proprietário ou ACL não confiável. Provisionamento administrativo seguro necessário; nenhum arquivo foi aceito ou apagado.".into()); }
    }
    Ok(())
}

#[cfg(windows)]
fn protect(data: &[u8], decrypt: bool) -> Result<Vec<u8>, String> {
    unsafe {
        use windows_sys::Win32::{
            Foundation::LocalFree,
            Security::Cryptography::{
                CryptProtectData, CryptUnprotectData, CRYPTPROTECT_LOCAL_MACHINE,
                CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
            },
        };
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = if decrypt {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        } else {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                CRYPTPROTECT_LOCAL_MACHINE | CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };
        if ok == 0 {
            return Err("DPAPI não conseguiu proteger/ler a credencial".into());
        }
        let result = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
        LocalFree(out.pbData.cast());
        Ok(result)
    }
}
#[cfg(not(windows))]
fn protect(_: &[u8], _: bool) -> Result<Vec<u8>, String> {
    Err("DPAPI exige Windows".into())
}
pub fn atomic_write(name: &str, data: &[u8]) -> Result<(), String> {
    use std::io::Write;
    if name.contains(['/', '\\']) || name.contains("..") {
        return Err("Nome local inválido".into());
    }
    let root = secure_root()?;
    let tmp = root.join(format!("{name}.{}.new", uuid::Uuid::new_v4()));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&tmp)
        .map_err(|e| e.to_string())?;
    file.write_all(data).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    std::fs::rename(tmp, root.join(name)).map_err(|e| e.to_string())
}
pub fn save(link: &Link) -> Result<(), String> {
    if link.enrollment.protocol_version != crate::policy::PROTOCOL_VERSION || link.enrollment.company_id.is_empty() { return Err("Resposta de pareamento incompatível".into()); }
    let raw = serde_json::to_vec(link).map_err(|e| e.to_string())?;
    atomic_write("device.dpapi", &protect(&raw, false)?)
}
pub fn load() -> Result<Option<Link>, String> {
    let root=root()?; let path = root.join("device.dpapi");
    if !path.exists() { return Ok(None); }
    #[cfg(windows)] {
        trusted_owner(root.parent().ok_or("Diretório local inválido")?)?;
        trusted_owner(&root)?; trusted_owner(&path)?;
    }
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let link: Link = serde_json::from_slice(&protect(&bytes, true)?)
        .map_err(|_| "Estado de pareamento inválido")?;
    super::validate_backend(&link.backend)?;
    uuid::Uuid::parse_str(&link.enrollment.device_id)
        .map_err(|_| "Device ID protegido inválido")?;
    if link.enrollment.credential.len() != 43 {
        return Err("Credencial protegida inválida".into());
    }
    Ok(Some(link))
}
pub fn remove() -> Result<(), String> {
    std::fs::remove_file(root()?.join("device.dpapi")).map_err(|e| e.to_string())
}
pub fn read_status() -> Result<CommunicationStatus, String> {
    let path=root()?.join("status.json");
    #[cfg(windows)] trusted_owner(&path)?;
    serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
pub fn service_installed() -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Registry::*;
        let key = "SYSTEM\\CurrentControlSet\\Services\\CentralSOSAgent"
            .encode_utf16()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let mut h = std::ptr::null_mut();
        let ok =
            unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, key.as_ptr(), 0, KEY_READ, &mut h) } == 0;
        if ok {
            unsafe {
                RegCloseKey(h);
            }
        }
        ok
    }
    #[cfg(not(windows))]
    {
        false
    }
}
#[cfg(all(test, windows))]
mod metadata_tests {
    use super::*;
    #[test]
    fn hardlinked_state_is_rejected_without_changing_permissions() {
        let directory = std::env::temp_dir().join(format!("central-vault-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let first=directory.join("state.json"); let second=directory.join("alias.json");
        std::fs::write(&first,b"fixture").unwrap();
        assert!(reject_reparse(&first).is_ok());
        std::fs::hard_link(&first,&second).unwrap();
        assert!(reject_reparse(&first).is_err()); assert!(reject_reparse(&second).is_err());
        assert_eq!(std::fs::read(&first).unwrap(),b"fixture");
        std::fs::remove_file(second).unwrap(); std::fs::remove_file(first).unwrap(); std::fs::remove_dir(directory).unwrap();
    }
}
