//! Read-only image trust policy. File and parent-directory rights have different meanings.
use super::*;
use std::path::{Component, Prefix};

/// Retain handles without FILE_SHARE_DELETE until the authenticated transaction ends.
/// This pins the checked image and path components rather than trusting a later name lookup.
pub struct TrustedImage {
    _objects: Vec<Handle>,
}
impl std::fmt::Debug for TrustedImage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TrustedImage")
    }
}

#[derive(Clone, Copy, Debug)]
enum ObjectRole {
    Image,
    Installation,
    Ancestor,
    VolumeRoot,
}
impl ObjectRole {
    fn mutation(self) -> u32 {
        let common = WRITE_DAC | WRITE_OWNER | FILE_WRITE_ATTRIBUTES | FILE_WRITE_EA;
        match self {
            Self::Image => common | DELETE | FILE_WRITE_DATA | FILE_APPEND_DATA,
            Self::Installation => {
                common | DELETE | FILE_DELETE_CHILD | FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY
            }
            // Creation alone cannot replace an existing, separately protected path component.
            // DELETE on that child, or DELETE_CHILD on this parent, can. Never skip parents.
            Self::Ancestor => common | DELETE | FILE_DELETE_CHILD,
            // A volume root cannot itself be renamed/deleted; its DACL/children still matter.
            Self::VolumeRoot => common | FILE_DELETE_CHILD,
        }
    }
}

fn deployment_error(path: &Path, role: ObjectRole, depth: usize, reason: &str) -> SessionError {
    // Only fixed deployment component names may appear. Never print profile paths, SIDs or requests.
    let safe = path.components().all(|component| match component {
        Component::Prefix(_) | Component::RootDir => true,
        Component::Normal(name) => [
            "Program Files",
            "Program Files (x86)",
            "CENTRAL SOS",
            "Agent",
            "central-sos-agent.exe",
            "central-sos-session-helper.exe",
        ]
        .iter()
        .any(|known| name.to_string_lossy().eq_ignore_ascii_case(known)),
        _ => false,
    });
    error(
        ErrorCode::SessionPeerRejected,
        &format!(
            "{reason}; etapa={role:?}, ancestral={depth}, caminho={}",
            if safe {
                path.display().to_string()
            } else {
                "[omitido]".into()
            }
        ),
    )
}

fn mapped(mut mask: u32) -> u32 {
    let mapping = GENERIC_MAPPING {
        GenericRead: FILE_GENERIC_READ,
        GenericWrite: FILE_GENERIC_WRITE,
        GenericExecute: FILE_GENERIC_EXECUTE,
        GenericAll: FILE_ALL_ACCESS,
    };
    unsafe {
        MapGenericMask(&mut mask, &mapping);
    }
    mask
}

// Conservative, ordered upper bound for every untrusted trustee, not just the current user.
// A preceding deny only subtracts rights when it provably covers that allow trustee:
// identical SID or Everyone. Do not infer memberships or union unrelated deny ACEs.
unsafe fn validate_descriptor(owner: PSID, acl: *mut ACL, role: ObjectRole) -> Result<()> {
    if !trusted_sid(&sid_text(owner)?) {
        return Err(error(
            ErrorCode::SessionPeerRejected,
            "Owner não confiável (exige SYSTEM/Administradores/TrustedInstaller)",
        ));
    }
    if acl.is_null() || IsValidAcl(acl) == 0 {
        return Err(error(
            ErrorCode::SessionPeerRejected,
            "DACL ausente ou inválida",
        ));
    }
    let mut stats: ACL_SIZE_INFORMATION = zeroed();
    if GetAclInformation(
        acl,
        (&mut stats as *mut ACL_SIZE_INFORMATION).cast(),
        size_of::<ACL_SIZE_INFORMATION>() as u32,
        AclSizeInformation,
    ) == 0
    {
        return Err(error(
            ErrorCode::SessionPeerRejected,
            "DACL não verificável",
        ));
    }
    let mut denied: Vec<(String, u32)> = Vec::new();
    for index in 0..stats.AceCount {
        let mut ace = null_mut();
        if GetAce(acl, index, &mut ace) == 0 || ace.is_null() {
            return Err(error(ErrorCode::SessionPeerRejected, "ACE não verificável"));
        }
        let header = &*ace.cast::<ACE_HEADER>();
        if header.AceFlags & INHERIT_ONLY_ACE as u8 != 0 {
            continue;
        }
        // Inherited effective ACEs are evaluated exactly like explicit ACEs, in stored order.
        if ![0, 1].contains(&header.AceType) || header.AceSize < 16 {
            return Err(error(
                ErrorCode::SessionPeerRejected,
                "Tipo/tamanho de ACE não suportado",
            ));
        }
        let entry = &*ace.cast::<ACCESS_ALLOWED_ACE>(); // basic allow/deny share mask/SID layout
        let sid = (&entry.SidStart as *const u32).cast_mut().cast();
        if IsValidSid(sid) == 0 || GetLengthSid(sid) as usize > header.AceSize as usize - 8 {
            return Err(error(
                ErrorCode::SessionPeerRejected,
                "ACE contém SID inválido",
            ));
        }
        let trustee = sid_text(sid)?;
        let mask = mapped(entry.Mask);
        if header.AceType == 1 {
            denied.push((trustee, mask));
            continue;
        }
        if trusted_sid(&trustee) {
            continue;
        }
        if mask & !FILE_ALL_ACCESS != 0 {
            return Err(error(
                ErrorCode::SessionPeerRejected,
                "ACE contém direitos não suportados",
            ));
        }
        let blocked = denied
            .iter()
            .filter(|(sid, _)| sid == &trustee || sid == "S-1-1-0")
            .fold(0, |bits, (_, mask)| bits | mask);
        let effective = mask & !blocked & role.mutation();
        if effective != 0 {
            return Err(error(ErrorCode::SessionPeerRejected,
                &format!("Imagem/diretório modificável por principal não confiável (ACE={index}, direitos=0x{effective:08X})")));
        }
    }
    Ok(())
}

struct Descriptor(*mut c_void);
impl Drop for Descriptor {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

pub fn trusted_image(path: &Path) -> Result<TrustedImage> {
    let mut components = path.components();
    if !matches!(components.next(), Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
        || !matches!(components.next(), Some(Component::RootDir))
        || components
            .any(|c| !matches!(c, Component::Normal(n) if !n.to_string_lossy().contains(':')))
    {
        return Err(error(
            ErrorCode::SessionPeerRejected,
            "Imagem exige caminho absoluto local sem ADS ou redirecionamento",
        ));
    }
    let mut objects = Vec::new();
    for (depth, target) in path.ancestors().enumerate() {
        let role = if depth == 0 {
            ObjectRole::Image
        } else if depth == 1 {
            ObjectRole::Installation
        } else if target.parent().is_none() {
            ObjectRole::VolumeRoot
        } else {
            ObjectRole::Ancestor
        };
        let fail = |reason: &str| deployment_error(target, role, depth, reason);
        unsafe {
            // OPEN_REPARSE_POINT inspects the object itself; no junction/symlink is followed silently.
            let raw = CreateFileW(
                wide(&target.to_string_lossy()).as_ptr(),
                READ_CONTROL | FILE_READ_ATTRIBUTES,
                if depth == 0 {
                    FILE_SHARE_READ
                } else {
                    FILE_SHARE_READ | FILE_SHARE_WRITE
                },
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            );
            let handle = Handle::checked(raw, ErrorCode::SessionPeerRejected)
                .map_err(|_| fail("Imagem/diretório não verificável (abertura read-only)"))?;
            let mut info: BY_HANDLE_FILE_INFORMATION = zeroed();
            if GetFileInformationByHandle(handle.0, &mut info) == 0 {
                return Err(fail("Metadados da imagem/diretório indisponíveis"));
            }
            if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(fail("Reparse point recusado"));
            }
            if (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != (depth > 0) {
                return Err(fail("Tipo de objeto não corresponde à imagem/caminho"));
            }
            if depth == 0 && info.nNumberOfLinks != 1 {
                return Err(fail(
                    "Imagem com hardlinks/contagem de links não verificável",
                ));
            }
            let (mut owner, mut acl, mut sd) = (null_mut(), null_mut(), null_mut());
            let rc = GetSecurityInfo(
                handle.0,
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                null_mut(),
                &mut acl,
                null_mut(),
                &mut sd,
            );
            if rc != 0 {
                return Err(fail("ACL da imagem/diretório indisponível"));
            }
            let _descriptor = Descriptor(sd);
            if sd.is_null() || IsValidSecurityDescriptor(sd) == 0 {
                return Err(fail("Security descriptor inválido"));
            }
            validate_descriptor(owner, acl, role).map_err(|e| fail(&e.message))?;
            objects.push(handle);
        }
    }
    Ok(TrustedImage { _objects: objects })
}

#[cfg(test)]
mod tests;
