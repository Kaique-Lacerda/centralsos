use super::*;

fn descriptor(sddl: &str, role: ObjectRole) -> Result<()> {
    unsafe {
        let mut sd = null_mut();
        assert_ne!(
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide(sddl).as_ptr(),
                1,
                &mut sd,
                null_mut()
            ),
            0
        );
        let _guard = Descriptor(sd);
        let (mut owner, mut defaulted, mut present, mut acl) = (null_mut(), 0, 0, null_mut());
        assert_ne!(
            GetSecurityDescriptorOwner(sd, &mut owner, &mut defaulted),
            0
        );
        assert_ne!(
            GetSecurityDescriptorDacl(sd, &mut present, &mut acl, &mut defaulted),
            0
        );
        validate_descriptor(owner, acl, role)
    }
}
fn rejected(sddl: &str, role: ObjectRole) {
    assert_eq!(
        descriptor(sddl, role).unwrap_err().code,
        ErrorCode::SessionPeerRejected
    );
}

#[test]
fn typical_protected_program_files_chain_and_read_execute_users_are_accepted() {
    let file = "O:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;BU)(A;;FRFX;;;AC)(A;;FRFX;;;S-1-15-2-2)";
    descriptor(file, ObjectRole::Image).unwrap();
    let directory = "O:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;BU)(A;OICIIO;GRGX;;;BU)(A;OICIIO;GA;;;CO)(A;;FRFX;;;AC)(A;OICIIO;GRGX;;;AC)";
    descriptor(directory, ObjectRole::Installation).unwrap();
    descriptor(directory, ObjectRole::Ancestor).unwrap();
    // Typical volume ACL: AU may create unrelated directories, not replace protected children.
    let root = "O:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FRFX;;;BU)(A;OICIIO;FA;;;CO)(A;OICIIO;0x1301bf;;;AU)(A;;0x100004;;;AU)";
    descriptor(root, ObjectRole::VolumeRoot).unwrap();
}

#[test]
fn all_three_trusted_owners_are_supported_and_unknown_effective_aces_fail_closed() {
    for owner in [
        "SY",
        "BA",
        "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
    ] {
        descriptor(
            &format!("O:{owner}D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FRFX;;;BU)"),
            ObjectRole::Image,
        )
        .unwrap();
    }
    rejected(
        "O:BAD:P(OA;;GW;00000000-0000-0000-0000-000000000001;;BU)",
        ObjectRole::Image,
    );
}

#[test]
fn executable_mutation_rights_and_untrusted_owner_are_rejected() {
    for right in [
        FILE_WRITE_DATA,
        FILE_APPEND_DATA,
        FILE_WRITE_EA,
        FILE_WRITE_ATTRIBUTES,
        DELETE,
        WRITE_DAC,
        WRITE_OWNER,
        GENERIC_WRITE,
        GENERIC_ALL,
    ] {
        rejected(
            &format!("O:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x{right:x};;;BU)"),
            ObjectRole::Image,
        );
    }
    rejected("O:BUD:P(A;;FA;;;SY)(A;;FRFX;;;BU)", ObjectRole::Image);
}

#[test]
fn installation_directory_creation_mutation_or_child_deletion_is_rejected() {
    for right in [
        FILE_ADD_FILE,
        FILE_ADD_SUBDIRECTORY,
        FILE_DELETE_CHILD,
        FILE_WRITE_EA,
        FILE_WRITE_ATTRIBUTES,
        DELETE,
        WRITE_DAC,
        WRITE_OWNER,
        GENERIC_WRITE,
        GENERIC_ALL,
    ] {
        rejected(
            &format!("O:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x{right:x};;;BU)"),
            ObjectRole::Installation,
        );
    }
}

#[test]
fn ancestors_creation_is_distinct_from_replacing_the_existing_protected_child() {
    descriptor(
        "O:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x6;;;AU)",
        ObjectRole::Ancestor,
    )
    .unwrap();
    for right in [
        DELETE,
        FILE_DELETE_CHILD,
        WRITE_DAC,
        WRITE_OWNER,
        FILE_WRITE_ATTRIBUTES,
        FILE_WRITE_EA,
    ] {
        rejected(
            &format!("O:BAD:P(A;;FA;;;SY)(A;;0x{right:x};;;AU)"),
            ObjectRole::Ancestor,
        );
    }
}

#[test]
fn observed_everyone_full_control_on_volume_root_is_not_a_false_positive() {
    let failure = descriptor("O:SYD:P(A;OICI;FA;;;WD)(A;OICIIO;0x1301bf;;;AU)(A;;0x100004;;;AU)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FRFX;;;BU)", ObjectRole::VolumeRoot).unwrap_err();
    assert!(failure.message.contains("ACE=0"));
    assert!(failure.message.contains("0x000C0150")); // WRITE_DAC/OWNER, write attrs/EA, delete-child
}

#[test]
fn ordered_deny_is_respected_only_when_it_provably_covers_the_allow_trustee() {
    descriptor(
        "O:BAD:P(D;;GW;;;BU)(A;;GW;;;BU)(A;;FA;;;SY)",
        ObjectRole::Image,
    )
    .unwrap();
    descriptor(
        "O:BAD:P(D;;GW;;;WD)(A;;GW;;;BU)(A;;FA;;;SY)",
        ObjectRole::Image,
    )
    .unwrap();
    // A later deny cannot retract a right already granted; unrelated group denies prove nothing.
    rejected("O:BAD:P(A;;GW;;;BU)(D;;GW;;;BU)", ObjectRole::Image);
    rejected("O:BAD:P(D;;GW;;;AU)(A;;GW;;;BU)", ObjectRole::Image);
    rejected("O:BAD:P(D;IOCI;GW;;;BU)(A;;GW;;;BU)", ObjectRole::Image);
    rejected("O:BAD:P(D;;0x2;;;BU)(A;;GW;;;BU)", ObjectRole::Image);
}

#[test]
fn inherited_effective_ace_is_checked_and_inherit_only_does_not_grant_on_parent() {
    rejected("O:BAD:P(A;ID;GW;;;BU)", ObjectRole::Image);
    descriptor(
        "O:BAD:P(A;OICIIO;GA;;;BU)(A;;FRFX;;;BU)",
        ObjectRole::Ancestor,
    )
    .unwrap();
    descriptor("O:BAD:P(A;;GRGX;;;BU)", ObjectRole::Image).unwrap();
    // Null DACL is unrestricted, never equivalent to an empty deny-all DACL.
    rejected("O:BAD:NO_ACCESS_CONTROL", ObjectRole::Image);
    descriptor("O:BAD:P", ObjectRole::Image).unwrap();
}

#[test]
fn diagnostics_only_expose_fixed_deployment_paths_without_user_sids() {
    let known = deployment_error(
        Path::new(r"C:\Program Files\CENTRAL SOS\Agent"),
        ObjectRole::Installation,
        1,
        "ACL recusada",
    );
    assert!(known
        .message
        .contains(r"C:\Program Files\CENTRAL SOS\Agent"));
    let hidden = deployment_error(
        Path::new(r"C:\Users\private-user\S-1-5-21-private\helper.exe"),
        ObjectRole::Image,
        0,
        "ACL recusada",
    );
    assert!(hidden.message.contains("[omitido]"));
    assert!(!hidden.message.contains("private-user"));
    assert!(!hidden.message.contains("S-1-5-21"));
}

struct FixtureDirectory(PathBuf);
impl FixtureDirectory {
    fn new() -> Self {
        let parent = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/image-security-tests");
        std::fs::create_dir_all(&parent).unwrap();
        let path = parent.join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for FixtureDirectory {
    fn drop(&mut self) {
        let parent = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/image-security-tests");
        assert!(self.0.starts_with(parent));
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn real_ntfs_hardlinked_image_is_rejected_before_acl_evaluation() {
    let fixture = FixtureDirectory::new();
    let image = fixture.0.join("fixture.exe");
    std::fs::write(&image, b"not an executable, metadata fixture only").unwrap();
    std::fs::hard_link(&image, fixture.0.join("alias.exe")).unwrap();
    let failure = trusted_image(&image).unwrap_err();
    assert_eq!(failure.code, ErrorCode::SessionPeerRejected);
    assert!(failure.message.contains("hardlinks"));
}

#[test]
fn real_ntfs_junction_is_rejected_without_following_or_modifying_system_paths() {
    let fixture = FixtureDirectory::new();
    let destination = fixture.0.join("destination");
    let junction = fixture.0.join("junction");
    std::fs::create_dir(&destination).unwrap();
    std::fs::create_dir(&junction).unwrap();
    // Mount-point reparse buffer; fixture lives exclusively inside ignored Cargo target.
    let substitute = wide(&format!(r"\??\{}", destination.display()));
    let printed = wide(&destination.display().to_string());
    let path_bytes = (substitute.len() + printed.len()) * 2;
    let mut buffer = Vec::new();
    buffer.extend_from_slice(&0xa0000003u32.to_le_bytes()); // IO_REPARSE_TAG_MOUNT_POINT
    buffer.extend_from_slice(&((8 + path_bytes) as u16).to_le_bytes());
    buffer.extend_from_slice(&0u16.to_le_bytes());
    buffer.extend_from_slice(&0u16.to_le_bytes());
    buffer.extend_from_slice(&((substitute.len() * 2 - 2) as u16).to_le_bytes());
    buffer.extend_from_slice(&((substitute.len() * 2) as u16).to_le_bytes());
    buffer.extend_from_slice(&((printed.len() * 2 - 2) as u16).to_le_bytes());
    for unit in substitute.into_iter().chain(printed) {
        buffer.extend_from_slice(&unit.to_le_bytes());
    }
    unsafe {
        let handle = Handle::checked(
            CreateFileW(
                wide(&junction.display().to_string()).as_ptr(),
                GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            ),
            ErrorCode::SessionPeerRejected,
        )
        .unwrap();
        let mut returned = 0;
        assert_ne!(
            DeviceIoControl(
                handle.0,
                0x000900a4,
                buffer.as_ptr().cast(),
                buffer.len() as u32,
                null_mut(),
                0,
                &mut returned,
                null_mut()
            ),
            0,
            "fixture junction creation failed: {}",
            GetLastError()
        );
    }
    let failure = trusted_image(&junction).unwrap_err();
    assert_eq!(failure.code, ErrorCode::SessionPeerRejected);
    assert!(failure.message.contains("Reparse point"));
}

#[test]
#[ignore = "Read-only installed-path probe; requires an existing protected Agent/Helper deployment"]
fn installed_images_read_only_trust_probe() {
    let mut failures = Vec::new();
    for name in ["central-sos-agent.exe", "central-sos-session-helper.exe"] {
        let image = Path::new(r"C:\Program Files\CENTRAL SOS\Agent").join(name);
        if let Err(error) = trusted_image(&image) {
            eprintln!("{name}: {error}");
            failures.push(error);
        }
    }
    assert!(
        failures.is_empty(),
        "Instalação recusada: consulte os diagnósticos de ACL acima"
    );
}
