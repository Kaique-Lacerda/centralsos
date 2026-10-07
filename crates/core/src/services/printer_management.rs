use crate::models::printer_operation::{
    PrinterConfigurationSnapshot, PrinterPermissionChangeResult, PrinterPermissionValues,
    PrinterPermissionsSnapshot, SetPrinterPermissionRequest,
};

#[cfg(windows)]
mod platform {
    use super::*;
    use serde::{Deserialize, Serialize};
    use std::{ffi::c_void, mem::size_of, ptr};
    use wmi::WMIConnection;

    const ERROR_ACCESS_DENIED: u32 = 5;
    const PRINTER_ATTRIBUTE_SHARED: u32 = 0x0000_0008;
    const PRINTER_ATTRIBUTE_TS: u32 = 0x0000_8000;
    const PRINTER_STATUS_PAUSED: u32 = 0x0000_0001;
    const PRINTER_ACCESS_ADMINISTER: u32 = 0x0000_0004;
    const PRINTER_ACCESS_USE: u32 = 0x0000_0008;
    const READ_CONTROL: u32 = 0x0002_0000;
    const WRITE_DAC: u32 = 0x0004_0000;
    const PRINTER_ACCESS_MANAGE: u32 = 0x0000_0004;
    const JOB_ACCESS_ADMINISTER: u32 = 0x0000_0010;
    const KNOWN_PERMISSION_BITS: u32 = PRINTER_ACCESS_USE | PRINTER_ACCESS_MANAGE | JOB_ACCESS_ADMINISTER;
    const SET_ACCESS: u32 = 2;
    const NO_INHERITANCE: u32 = 0;
    const TRUSTEE_IS_SID: u32 = 0;
    const TRUSTEE_IS_UNKNOWN: u32 = 0;
    const ACE_ACCESS_ALLOWED: u8 = 0;
    const ACE_ACCESS_DENIED: u8 = 1;
    const INHERITED_ACE: u8 = 0x10;
    const OBJECT_INHERIT_ACE: u8 = 0x01;
    const INHERIT_ONLY_ACE: u8 = 0x08;
    // Windows Print Spooler access values (MS-RPRN 2.2.3.1).
    const PRINTER_ALL_ACCESS: u32 = 0x000F_000C;
    const JOB_ALL_ACCESS: u32 = 0x000F_0030;
    const EVERYONE_SID: &str = "S-1-1-0";
    const ADMIN_REQUIRED: &str = "Esta operação exige que o CENTRAL SOS seja executado como administrador.";

    #[repr(C)]
    struct PrinterDefaultsW { datatype: *mut u16, devmode: *mut c_void, desired_access: u32 }
    #[repr(C)]
    struct PrinterInfo2W {
        server_name: *mut u16, printer_name: *mut u16, share_name: *mut u16,
        port_name: *mut u16, driver_name: *mut u16, comment: *mut u16,
        location: *mut u16, devmode: *mut c_void, sep_file: *mut u16,
        print_processor: *mut u16, datatype: *mut u16, parameters: *mut u16,
        security_descriptor: *mut c_void, attributes: u32, priority: u32,
        default_priority: u32, start_time: u32, until_time: u32, status: u32,
        jobs: u32, average_ppm: u32,
    }
    #[repr(C)]
    struct PrinterInfo3W { security_descriptor: *mut c_void }
    #[repr(C)]
    struct AclSizeInformation { ace_count: u32, acl_bytes_in_use: u32, acl_bytes_free: u32 }
    #[repr(C)]
    struct AceHeader { ace_type: u8, ace_flags: u8, ace_size: u16 }
    #[repr(C)]
    struct AccessAce { header: AceHeader, mask: u32, sid_start: u32 }
    #[repr(C)]
    struct TrusteeW {
        multiple_trustee: *mut c_void,
        multiple_trustee_operation: u32,
        trustee_form: u32,
        trustee_type: u32,
        trustee_name: *mut u16,
    }
    #[repr(C)]
    struct ExplicitAccessW { permissions: u32, access_mode: u32, inheritance: u32, trustee: TrusteeW }

    #[link(name = "winspool")]
    extern "system" {
        fn OpenPrinterW(name: *const u16, printer: *mut *mut c_void, defaults: *const c_void) -> i32;
        fn ClosePrinter(printer: *mut c_void) -> i32;
        fn GetPrinterW(printer: *mut c_void, level: u32, buffer: *mut u8, buffer_size: u32, needed: *mut u32) -> i32;
        fn SetPrinterW(printer: *mut c_void, level: u32, buffer: *const u8, command: u32) -> i32;
        fn SetDefaultPrinterW(name: *const u16) -> i32;
    }
    #[link(name = "advapi32")]
    extern "system" {
        fn GetSecurityDescriptorDacl(sd: *const c_void, present: *mut i32, dacl: *mut *mut c_void, defaulted: *mut i32) -> i32;
        fn GetAclInformation(acl: *mut c_void, info: *mut AclSizeInformation, length: u32, class: u32) -> i32;
        fn GetAce(acl: *mut c_void, index: u32, ace: *mut *mut c_void) -> i32;
        fn EqualSid(first: *const c_void, second: *const c_void) -> i32;
        fn ConvertSidToStringSidW(sid: *const c_void, text: *mut *mut u16) -> i32;
        fn ConvertStringSidToSidW(text: *const u16, sid: *mut *mut c_void) -> i32;
        fn LookupAccountSidW(system: *const u16, sid: *const c_void, name: *mut u16, name_length: *mut u32, domain: *mut u16, domain_length: *mut u32, use_type: *mut u32) -> i32;
        fn SetEntriesInAclW(count: u32, entries: *const ExplicitAccessW, old_acl: *mut c_void, new_acl: *mut *mut c_void) -> u32;
        fn InitializeAcl(acl: *mut c_void, length: u32, revision: u32) -> i32;
        fn AddAce(acl: *mut c_void, revision: u32, index: u32, ace_list: *const c_void, length: u32) -> i32;
        fn GetLengthSid(sid: *const c_void) -> u32;
        fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
        fn GetTokenInformation(token: *mut c_void, class: u32, info: *mut c_void, length: u32, returned: *mut u32) -> i32;
        fn MakeAbsoluteSD(self_relative: *const c_void, absolute: *mut c_void, absolute_length: *mut u32,
            dacl: *mut c_void, dacl_length: *mut u32, sacl: *mut c_void, sacl_length: *mut u32,
            owner: *mut c_void, owner_length: *mut u32, group: *mut c_void, group_length: *mut u32) -> i32;
        fn SetSecurityDescriptorDacl(sd: *mut c_void, present: i32, dacl: *mut c_void, defaulted: i32) -> i32;
        fn SetSecurityDescriptorOwner(sd: *mut c_void, owner: *mut c_void, defaulted: i32) -> i32;
        fn SetSecurityDescriptorGroup(sd: *mut c_void, group: *mut c_void, defaulted: i32) -> i32;
        fn SetSecurityDescriptorSacl(sd: *mut c_void, present: i32, sacl: *mut c_void, defaulted: i32) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(memory: *mut c_void) -> *mut c_void;
        fn GetLastError() -> u32;
        fn GetCurrentProcess() -> *mut c_void;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }

    struct PrinterHandle(*mut c_void);
    impl Drop for PrinterHandle { fn drop(&mut self) { unsafe { ClosePrinter(self.0); } } }
    struct LocalMemory(*mut c_void);
    impl Drop for LocalMemory { fn drop(&mut self) { if !self.0.is_null() { unsafe { LocalFree(self.0); } } } }
    struct AbsoluteSecurityDescriptor { descriptor: Vec<u64>, _dacl: Vec<u64>, _sacl: Vec<u64>, _owner: Vec<u64>, _group: Vec<u64> }

    fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(std::iter::once(0)).collect() }
    fn open_printer(name: &str, access: u32) -> Result<PrinterHandle, String> {
        open_printer_with_context(name, access, false)
    }
    fn open_printer_with_context(name: &str, access: u32, redirected: bool) -> Result<PrinterHandle, String> {
        let name = wide(name);
        let defaults = PrinterDefaultsW { datatype: ptr::null_mut(), devmode: ptr::null_mut(), desired_access: access };
        let mut handle = ptr::null_mut();
        if unsafe { OpenPrinterW(name.as_ptr(), &mut handle, &defaults as *const _ as *const c_void) } == 0 {
            return Err(map_printer_context_error(unsafe { GetLastError() }, redirected));
        }
        Ok(PrinterHandle(handle))
    }
    fn map_error(code: u32) -> String {
        match code {
            ERROR_ACCESS_DENIED => "O Windows negou permissão para alterar esta impressora.".into(),
            1801 | 1802 => "A impressora não foi encontrada.".into(),
            1722 => "Não foi possível alcançar o servidor de impressão.".into(),
            _ => format!("A operação da impressora falhou (erro do Windows {code})."),
        }
    }
    fn map_printer_context_error(code: u32, redirected: bool) -> String {
        // Access denied alone does not establish that redirection caused the denial.
        if redirected && matches!(code, 50 | 1803) {
            return "Esta impressora é redirecionada e o Windows não permite alterar esta configuração nesta sessão.".into();
        }
        format!("{} (código Windows: {code})", map_error(code))
    }
    fn is_elevated() -> Result<bool, String> {
        struct TokenHandle(*mut c_void);
        impl Drop for TokenHandle { fn drop(&mut self) { unsafe { CloseHandle(self.0); } } }
        let mut token = ptr::null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), 0x0008, &mut token) } == 0 {
            return Err(format!("Não foi possível verificar os privilégios administrativos (erro {}).", unsafe { GetLastError() }));
        }
        let token = TokenHandle(token);
        let mut elevated = 0u32; let mut returned = 0;
        // TOKEN_QUERY (0x0008), TokenElevation (20), TOKEN_ELEVATION::TokenIsElevated.
        if unsafe { GetTokenInformation(token.0, 20, &mut elevated as *mut _ as *mut c_void, size_of::<u32>() as u32, &mut returned) } == 0 {
            return Err(format!("Não foi possível verificar a elevação do processo (erro {}).", unsafe { GetLastError() }));
        }
        Ok(elevated != 0)
    }
    fn ensure_elevated(elevated: bool) -> Result<(), String> {
        if elevated { Ok(()) } else { Err(ADMIN_REQUIRED.into()) }
    }
    fn open_sensitive_printer(name: &str, access: u32) -> Result<(PrinterHandle, bool), String> {
        ensure_elevated(is_elevated()?)?;
        let read_handle = open_printer(name, PRINTER_ACCESS_USE)?;
        let (buffer, _) = get_printer_info2(&read_handle)?;
        let redirected = unsafe { (*(buffer.as_ptr() as *const PrinterInfo2W)).attributes & PRINTER_ATTRIBUTE_TS != 0 };
        Ok((open_printer_with_context(name, access, redirected)?, redirected))
    }
    fn get_printer_info2(handle: &PrinterHandle) -> Result<(Vec<u64>, u32), String> {
        let mut needed = 0;
        unsafe { GetPrinterW(handle.0, 2, ptr::null_mut(), 0, &mut needed); }
        if needed == 0 { return Err(map_error(unsafe { GetLastError() })); }
        let mut buffer = vec![0u64; (needed as usize + size_of::<u64>() - 1) / size_of::<u64>()];
        if unsafe { GetPrinterW(handle.0, 2, buffer.as_mut_ptr() as *mut u8, needed, &mut needed) } == 0 {
            return Err(map_error(unsafe { GetLastError() }));
        }
        Ok((buffer, needed))
    }
    unsafe fn text(pointer: *const u16) -> Option<String> {
        if pointer.is_null() { return None; }
        let mut length = 0;
        while *pointer.add(length) != 0 { length += 1; }
        let value = String::from_utf16_lossy(std::slice::from_raw_parts(pointer, length)).trim().to_owned();
        (!value.is_empty()).then_some(value)
    }
    fn validate_printer_name(value: &str) -> Result<(), String> {
        let value = value.trim();
        if value.is_empty() { return Err("Informe um nome para a impressora.".into()); }
        if value.chars().count() > 220 || value.chars().any(|c| c.is_control() || matches!(c, '\\' | '/')) {
            return Err("O nome da impressora contém caracteres inválidos ou excede 220 caracteres.".into());
        }
        Ok(())
    }
    fn validate_share_name(value: &str) -> Result<(), String> {
        let value = value.trim();
        if value.is_empty() { return Err("Informe um nome de compartilhamento.".into()); }
        if value.chars().count() > 80 || value.chars().any(|c| c.is_control() || matches!(c, '\\' | '/' | ',')) {
            return Err("O nome compartilhado contém caracteres inválidos ou excede 80 caracteres.".into());
        }
        Ok(())
    }
    fn validate_metadata(value: &str, field: &str) -> Result<(), String> {
        if value.chars().count() > 1024 || value.chars().any(|c| c == '\0') {
            return Err(format!("{field} excede 1024 caracteres ou contém conteúdo inválido."));
        }
        Ok(())
    }
    fn write_info2(handle: &PrinterHandle, buffer: &mut [u64], bytes: u32) -> Result<(), String> {
        // These property updates must not reapply the printer's security descriptor.
        let info = unsafe { &mut *(buffer.as_mut_ptr() as *mut PrinterInfo2W) };
        let redirected = info.attributes & PRINTER_ATTRIBUTE_TS != 0;
        info.security_descriptor = ptr::null_mut();
        if unsafe { SetPrinterW(handle.0, 2, buffer.as_mut_ptr() as *const u8, 0) } == 0 {
            let code = unsafe { GetLastError() };
            let _ = bytes;
            return Err(map_printer_context_error(code, redirected));
        }
        Ok(())
    }
    fn wmi_instance_path(printer_name: &str) -> Result<String, String> {
        #[derive(Deserialize)]
        #[allow(non_snake_case, non_camel_case_types)]
        struct Win32_Printer { __Path: String }
        let escaped = printer_name.replace('\\', "\\\\").replace('\'', "\\'");
        let query = format!("SELECT __Path FROM Win32_Printer WHERE Name = '{escaped}'");
        let connection = WMIConnection::new().map_err(|error| format!("Não foi possível consultar a impressora: {error}"))?;
        connection.raw_query::<Win32_Printer>(&query).map_err(|error| error.to_string())?.into_iter().next().map(|row| row.__Path).ok_or_else(|| "A impressora não foi encontrada.".into())
    }

    pub fn get_configuration(printer_name: String) -> Result<PrinterConfigurationSnapshot, String> {
        let name = printer_name.trim();
        if name.is_empty() { return Err("Selecione uma impressora válida.".into()); }
        let handle = open_printer(name, PRINTER_ACCESS_USE)?;
        let (buffer, _) = get_printer_info2(&handle)?;
        let info = unsafe { &*(buffer.as_ptr() as *const PrinterInfo2W) };
        let permissions = match open_printer(name, READ_CONTROL | PRINTER_ACCESS_USE) {
            Ok(acl_handle) => get_permissions_for_handle(&acl_handle),
            Err(error) => Err(error),
        }.unwrap_or_else(|error| PrinterPermissionsSnapshot { state: "unavailable".into(), entries: Vec::new(), notice: Some(error) });
        Ok(PrinterConfigurationSnapshot {
            printer_name: unsafe { text(info.printer_name) }.unwrap_or_else(|| name.to_owned()),
            server: unsafe { text(info.server_name) },
            shared: info.attributes & PRINTER_ATTRIBUTE_SHARED != 0,
            share_name: unsafe { text(info.share_name) },
            location: unsafe { text(info.location) },
            comment: unsafe { text(info.comment) },
            port: unsafe { text(info.port_name) },
            driver: unsafe { text(info.driver_name) },
            paused: info.status & PRINTER_STATUS_PAUSED != 0,
            is_elevated: is_elevated()?,
            redirected: info.attributes & PRINTER_ATTRIBUTE_TS != 0,
            permissions,
        })
    }

    pub fn is_paused(printer_name: String) -> Result<bool, String> {
        let name = printer_name.trim();
        if name.is_empty() { return Err("Selecione uma impressora válida.".into()); }
        let handle = open_printer(name, PRINTER_ACCESS_USE)?;
        let (buffer, _) = get_printer_info2(&handle)?;
        let info = unsafe { &*(buffer.as_ptr() as *const PrinterInfo2W) };
        Ok(info.status & PRINTER_STATUS_PAUSED != 0)
    }

    pub fn native_state(name: String) -> Result<crate::models::printer_diagnostic::PrinterNativeState, String> {
        if name.trim().is_empty() { return Err("Selecione uma impressora válida.".into()); }
        let handle = open_printer(&name, PRINTER_ACCESS_USE)?;
        let (buffer, _) = get_printer_info2(&handle)?;
        let info = unsafe { &*(buffer.as_ptr() as *const PrinterInfo2W) };
        Ok(crate::models::printer_diagnostic::PrinterNativeState { name, port: unsafe { text(info.port_name) }, driver: unsafe { text(info.driver_name) },
            server: unsafe { text(info.server_name) }, share_name: unsafe { text(info.share_name) }, attributes: info.attributes, status_bits: info.status, job_count: info.jobs })
    }
    pub fn elevated_context() -> Result<bool, String> { is_elevated() }
    pub fn require_elevation() -> Result<(), String> { ensure_elevated(is_elevated()?) }
    pub fn set_port(name: String, port: String) -> Result<(), String> {
        if port.trim().is_empty() || port.contains('\0') { return Err("Selecione uma porta registrada válida.".into()); }
        let (handle, redirected) = open_sensitive_printer(&name, PRINTER_ACCESS_ADMINISTER)?;
        if redirected { return Err("A alteração de porta de uma impressora redirecionada deve ser realizada na máquina de origem.".into()); }
        let (mut buffer, bytes) = get_printer_info2(&handle)?;
        let info = unsafe { &mut *(buffer.as_mut_ptr() as *mut PrinterInfo2W) };
        let server = unsafe { text(info.server_name) };
        let inventory = crate::services::printer_diagnostics::enumerate_ports(server.as_deref())?;
        if !inventory.iter().any(|item| item.name.eq_ignore_ascii_case(&port)) { return Err("A porta escolhida não está registrada no servidor desta impressora.".into()); }
        let port_name = wide(&port); info.port_name = port_name.as_ptr() as *mut u16;
        write_info2(&handle, &mut buffer, bytes)
    }

    pub fn set_default_printer(printer_name: String) -> Result<(), String> {
        let name = printer_name.trim();
        if name.is_empty() { return Err("Selecione uma impressora válida.".into()); }
        let _handle = open_printer(name, PRINTER_ACCESS_USE)?;
        if unsafe { SetDefaultPrinterW(wide(name).as_ptr()) } == 0 { return Err(map_error(unsafe { GetLastError() })); }
        Ok(())
    }

    pub fn rename_printer(printer_name: String, new_name: String) -> Result<(), String> {
        validate_printer_name(&new_name)?;
        let current = printer_name.trim();
        if current.is_empty() { return Err("Selecione uma impressora válida.".into()); }
        let (_handle, redirected) = open_sensitive_printer(current, PRINTER_ACCESS_ADMINISTER)?;
        #[derive(Serialize)] #[allow(non_snake_case)] struct RenameInput { NewPrinterName: String }
        #[derive(Deserialize)] #[allow(non_snake_case)] struct RenameOutput { ReturnValue: u32 }
        #[derive(Deserialize)] #[allow(non_camel_case_types)] struct Win32_Printer;
        let connection = WMIConnection::new().map_err(|error| format!("Não foi possível conectar ao serviço WMI: {error}"))?;
        let output: RenameOutput = connection.exec_instance_method::<Win32_Printer, _>(
            &wmi_instance_path(current)?, "RenamePrinter", RenameInput { NewPrinterName: new_name.trim().to_owned() }
        ).map_err(|error| format!("O Windows não conseguiu renomear a impressora: {error}"))?;
        if output.ReturnValue != 0 {
            return Err(match output.ReturnValue {
                1 => map_printer_context_error(50, redirected),
                2 | 5 => map_printer_context_error(ERROR_ACCESS_DENIED, redirected),
                code => format!("O Windows recusou o novo nome (código WMI {code})."),
            });
        }
        Ok(())
    }

    pub fn set_share(printer_name: String, enabled: bool, share_name: Option<String>) -> Result<(), String> {
        let name = printer_name.trim();
        if name.is_empty() { return Err("Selecione uma impressora válida.".into()); }
        let share_name = if enabled {
            let value = share_name.unwrap_or_default(); validate_share_name(&value)?; Some(value.trim().to_owned())
        } else { None };
        let (handle, _) = open_sensitive_printer(name, PRINTER_ACCESS_ADMINISTER)?;
        let (mut buffer, bytes) = get_printer_info2(&handle)?;
        let info = unsafe { &mut *(buffer.as_mut_ptr() as *mut PrinterInfo2W) };
        let share_wide = share_name.as_ref().map(|value| wide(value));
        update_share_info(info, enabled, share_wide.as_ref().map_or(ptr::null_mut(), |value| value.as_ptr() as *mut u16));
        write_info2(&handle, &mut buffer, bytes)
    }

    pub fn set_location(printer_name: String, location: String) -> Result<(), String> {
        set_metadata(printer_name, location, true)
    }
    fn update_share_info(info: &mut PrinterInfo2W, enabled: bool, share_name: *mut u16) {
        info.attributes = if enabled { info.attributes | PRINTER_ATTRIBUTE_SHARED } else { info.attributes & !PRINTER_ATTRIBUTE_SHARED };
        info.share_name = if enabled { share_name } else { ptr::null_mut() };
    }
    pub fn set_comment(printer_name: String, comment: String) -> Result<(), String> {
        set_metadata(printer_name, comment, false)
    }
    fn set_metadata(printer_name: String, value: String, location: bool) -> Result<(), String> {
        let name = printer_name.trim();
        if name.is_empty() { return Err("Selecione uma impressora válida.".into()); }
        let field = if location { "A localização" } else { "O comentário" };
        validate_metadata(&value, field)?;
        let (handle, _) = open_sensitive_printer(name, PRINTER_ACCESS_ADMINISTER)?;
        let (mut buffer, bytes) = get_printer_info2(&handle)?;
        let info = unsafe { &mut *(buffer.as_mut_ptr() as *mut PrinterInfo2W) };
        let value = if value.is_empty() { None } else { Some(wide(&value)) };
        let pointer = value.as_ref().map_or(ptr::null_mut(), |text| text.as_ptr() as *mut u16);
        if location { info.location = pointer; } else { info.comment = pointer; }
        write_info2(&handle, &mut buffer, bytes)
    }

    pub fn get_printer_permissions(printer_name: String) -> Result<PrinterPermissionsSnapshot, String> {
        let name = printer_name.trim();
        if name.is_empty() { return Err("Selecione uma impressora válida.".into()); }
        let handle = open_printer(name, READ_CONTROL | PRINTER_ACCESS_USE)?;
        get_permissions_for_handle(&handle)
    }

    pub fn configure_permissions(printer_name: String) -> Result<(), String> {
        let name = printer_name.trim();
        if name.is_empty() { return Err("Selecione uma impressora válida.".into()); }
        let (handle, redirected) = open_sensitive_printer(name, READ_CONTROL | WRITE_DAC | PRINTER_ACCESS_ADMINISTER)?;
        let (mut source, _) = get_printer_level3(&handle)?;
        let source_sd = unsafe { (*(source.as_mut_ptr() as *mut PrinterInfo3W)).security_descriptor };
        if source_sd.is_null() { return Err("O Windows não retornou o descritor de segurança da impressora.".into()); }
        let (present, old_acl) = get_dacl(source_sd)?;
        if !present || old_acl.is_null() {
            return Err("A DACL está ausente ou nula e representa acesso irrestrito; não é seguro substituí-la por uma ACL simplificada.".into());
        }
        let mut updated_acl = build_everyone_acl(old_acl)?;
        let mut absolute = make_absolute_sd(source_sd)?;
        let sd = absolute.descriptor.as_mut_ptr() as *mut c_void;
        prepare_dacl_update(sd, updated_acl.as_mut_ptr() as *mut c_void)?;
        let info = PrinterInfo3W { security_descriptor: sd };
        if unsafe { SetPrinterW(handle.0, 3, &info as *const _ as *const u8, 0) } == 0 {
            return Err(map_printer_context_error(unsafe { GetLastError() }, redirected));
        }
        let (mut verification, _) = get_printer_level3(&handle).map_err(|error| format!("A alteração foi enviada ao Windows, mas a leitura final falhou: {error}"))?;
        let sd = unsafe { (*(verification.as_mut_ptr() as *mut PrinterInfo3W)).security_descriptor };
        if sd.is_null() { return Err("A alteração foi enviada ao Windows, mas o descritor final não foi retornado.".into()); }
        let (present, acl) = get_dacl(sd)?;
        if !present || acl.is_null() || !everyone_has_required_permissions(acl)? {
            return Err("O Windows não confirmou todas as permissões esperadas para o grupo Todos. Consulte os detalhes técnicos.".into());
        }
        Ok(())
    }

    fn allow_ace(sid: *const c_void, mask: u32, flags: u8) -> Vec<u8> {
        let sid_length = unsafe { GetLengthSid(sid) } as usize;
        let mut bytes = vec![0u8; 8 + sid_length];
        bytes[0] = ACE_ACCESS_ALLOWED;
        bytes[1] = flags;
        let length = bytes.len() as u16;
        bytes[2..4].copy_from_slice(&length.to_le_bytes());
        bytes[4..8].copy_from_slice(&mask.to_le_bytes());
        bytes[8..].copy_from_slice(unsafe { std::slice::from_raw_parts(sid as *const u8, sid_length) });
        bytes
    }

    fn ace_sid(ace: *mut c_void) -> Option<*const c_void> {
        let header = unsafe { &*(ace as *const AceHeader) };
        // Basic and callback ACEs have the SID after Header + Mask. Object ACEs
        // additionally have object flags and zero, one or two GUIDs before the SID.
        let offset = match header.ace_type {
            0 | 1 | 9 | 10 => 8,
            5 | 6 | 11 | 12 if header.ace_size >= 12 => {
                let flags = unsafe { ptr::read_unaligned((ace as *const u8).add(8) as *const u32) };
                12 + if flags & 1 != 0 { 16 } else { 0 } + if flags & 2 != 0 { 16 } else { 0 }
            }
            _ => return None,
        };
        if offset + 8 > header.ace_size as usize { return None; }
        Some(unsafe { (ace as *const u8).add(offset) as *const c_void })
    }

    fn build_everyone_acl(old_acl: *mut c_void) -> Result<Vec<u64>, String> {
        let everyone = sid_from_string(EVERYONE_SID)?;
        let mut entries = Vec::new();
        let mut printer_found = false; let mut jobs_found = false;
        for index in 0..acl_size_info(old_acl)?.ace_count {
            let ace = get_ace(old_acl, index)?;
            let header = unsafe { &*(ace as *const AceHeader) };
            let mut bytes = unsafe { std::slice::from_raw_parts(ace as *const u8, header.ace_size as usize) }.to_vec();
            let is_everyone = ace_sid(ace).is_some_and(|sid| unsafe { EqualSid(sid, everyone.0) } != 0);
            if is_everyone {
                let mask = u32::from_le_bytes(bytes[4..8].try_into().unwrap());
                if matches!(header.ace_type, 1 | 6 | 10 | 12) && mask & (PRINTER_ALL_ACCESS | JOB_ALL_ACCESS | 0xF000_0000) != 0 {
                    return Err("Há uma ACE de negação para Todos que impede garantir as permissões solicitadas. A negação e todas as outras entradas foram preservadas; nenhuma alteração foi aplicada.".into());
                }
                if header.ace_type == ACE_ACCESS_ALLOWED && header.ace_flags & INHERITED_ACE == 0 {
                    let required = if header.ace_flags & INHERIT_ONLY_ACE == 0 && !printer_found {
                        printer_found = true; PRINTER_ALL_ACCESS
                    } else if header.ace_flags & (INHERIT_ONLY_ACE | OBJECT_INHERIT_ACE) == (INHERIT_ONLY_ACE | OBJECT_INHERIT_ACE) && !jobs_found {
                        jobs_found = true; JOB_ALL_ACCESS
                    } else { 0 };
                    bytes[4..8].copy_from_slice(&(mask | required).to_le_bytes());
                }
            }
            // Preserve all other ACEs byte-for-byte, including Creator Owner,
            // App Packages, inherited, deny, callback and object-specific entries.
            entries.push(bytes);
        }
        let mut additions = Vec::new();
        if !printer_found { additions.push(allow_ace(everyone.0, PRINTER_ALL_ACCESS, 0)); }
        // Jobs are child objects: the job access mask must be inheritable and
        // inherit-only rather than being interpreted as printer access rights.
        if !jobs_found { additions.push(allow_ace(everyone.0, JOB_ALL_ACCESS, OBJECT_INHERIT_ACE | INHERIT_ONLY_ACE)); }
        let insertion = entries.iter().position(|bytes| bytes[1] & INHERITED_ACE != 0).unwrap_or(entries.len());
        entries.splice(insertion..insertion, additions);
        let length = 8 + entries.iter().map(Vec::len).sum::<usize>();
        if length > u16::MAX as usize { return Err("A ACL excede o tamanho permitido pelo Windows; nenhuma alteração foi aplicada.".into()); }
        let revision = unsafe { *(old_acl as *const u8) } as u32;
        let mut result = vec![0u64; (length + 7) / 8];
        let acl = result.as_mut_ptr() as *mut c_void;
        if unsafe { InitializeAcl(acl, length as u32, revision) } == 0 { return Err(map_error(unsafe { GetLastError() })); }
        for entry in entries {
            if unsafe { AddAce(acl, revision, u32::MAX, entry.as_ptr() as *const c_void, entry.len() as u32) } == 0 {
                return Err(map_error(unsafe { GetLastError() }));
            }
        }
        Ok(result)
    }

    fn everyone_has_required_permissions(acl: *mut c_void) -> Result<bool, String> {
        let everyone = sid_from_string(EVERYONE_SID)?;
        let mut printer = 0; let mut jobs = 0;
        for index in 0..acl_size_info(acl)?.ace_count {
            let ace = get_ace(acl, index)?;
            let header = unsafe { &*(ace as *const AceHeader) };
            if header.ace_type != ACE_ACCESS_ALLOWED || unsafe { EqualSid(sid_at(ace), everyone.0) } == 0 { continue; }
            let mask = unsafe { (*(ace as *const AccessAce)).mask };
            if header.ace_flags & INHERIT_ONLY_ACE == 0 { printer |= mask; }
            if header.ace_flags & (OBJECT_INHERIT_ACE | INHERIT_ONLY_ACE) == (OBJECT_INHERIT_ACE | INHERIT_ONLY_ACE) { jobs |= mask; }
        }
        Ok(printer & PRINTER_ALL_ACCESS == PRINTER_ALL_ACCESS && jobs & JOB_ALL_ACCESS == JOB_ALL_ACCESS)
    }

    pub fn set_printer_permissions(request: SetPrinterPermissionRequest) -> Result<PrinterPermissionChangeResult, String> {
        let name = request.printer_name.trim();
        if name.is_empty() || request.trustee_sid.trim().is_empty() { return Err("Selecione uma impressora e uma entrada de permissão válida.".into()); }
        let (handle, redirected) = open_sensitive_printer(name, READ_CONTROL | WRITE_DAC | PRINTER_ACCESS_ADMINISTER)?;
        let (mut source, _) = get_printer_level3(&handle)?;
        let source_sd = unsafe { (*(source.as_mut_ptr() as *mut PrinterInfo3W)).security_descriptor };
        if source_sd.is_null() { return Err("O Windows não retornou um descritor de segurança editável.".into()); }
        let (present, dacl) = get_dacl(source_sd)?;
        if !present || dacl.is_null() { return Err("A impressora não possui uma ACL explícita que possa ser editada com segurança.".into()); }
        let target_sid = sid_from_string(&request.trustee_sid)?;
        let target_sid_ptr = target_sid.0;
        let acl_info = acl_size_info(dacl)?;
        let mut matching = Vec::new();
        for index in 0..acl_info.ace_count {
            let ace = get_ace(dacl, index)?;
            let header = unsafe { &*(ace as *const AceHeader) };
            if !matches!(header.ace_type, ACE_ACCESS_ALLOWED | ACE_ACCESS_DENIED) {
                return Err("A ACL contém entradas especiais que esta versão não consegue preservar com segurança. A consulta continua disponível, mas a edição foi bloqueada.".into());
            }
            let allowed = unsafe { &*(ace as *const AccessAce) };
            let sid = &allowed.sid_start as *const u32 as *const c_void;
            if unsafe { EqualSid(sid, target_sid_ptr) } != 0 { matching.push((index, header.ace_type, header.ace_flags, allowed.mask)); }
        }
        if matching.len() != 1 || matching[0].1 != ACE_ACCESS_ALLOWED || matching[0].2 != 0 {
            return Err("Esta entrada possui ACEs duplicadas, negadas ou flags de herança. Por segurança, ela só pode ser consultada nesta versão.".into());
        }
        let (_, _, _, old_mask) = matching[0];
        let before = values_from_mask(old_mask);
        if before != request.expected_before { return Err("As permissões foram alteradas desde a consulta. Atualize a seção e tente novamente.".into()); }
        let requested_mask = (old_mask & !KNOWN_PERMISSION_BITS) | mask_from_values(&request.after);
        let explicit = ExplicitAccessW {
            permissions: requested_mask,
            access_mode: SET_ACCESS,
            inheritance: NO_INHERITANCE,
            trustee: TrusteeW { multiple_trustee: ptr::null_mut(), multiple_trustee_operation: 0, trustee_form: TRUSTEE_IS_SID, trustee_type: TRUSTEE_IS_UNKNOWN, trustee_name: target_sid_ptr as *mut u16 },
        };
        let mut replacement_acl = ptr::null_mut();
        let acl_result = unsafe { SetEntriesInAclW(1, &explicit, dacl, &mut replacement_acl) };
        if acl_result != 0 { return Err(map_error(acl_result)); }
        let replacement_acl = LocalMemory(replacement_acl);
        let mut absolute = make_absolute_sd(source_sd)?;
        let absolute_sd = absolute.descriptor.as_mut_ptr() as *mut c_void;
        prepare_dacl_update(absolute_sd, replacement_acl.0)?;
        let info3 = PrinterInfo3W { security_descriptor: absolute_sd };
        if unsafe { SetPrinterW(handle.0, 3, &info3 as *const _ as *const u8, 0) } == 0 { return Err(map_printer_context_error(unsafe { GetLastError() }, redirected)); }
        let account = account_for_sid(target_sid_ptr).unwrap_or_else(|| request.trustee_sid.clone());
        let (actual_after, verified) = match get_permissions_for_handle(&handle) {
            Ok(snapshot) => match snapshot.entries.iter().find(|entry| entry.sid.as_deref() == Some(request.trustee_sid.as_str()) && entry.access_type == "Permitir")
                .and_then(|entry| entry.permissions.clone()) {
                    Some(values) => (values, true),
                    None => (request.after, false),
                },
            Err(_) => (request.after, false),
        };
        Ok(PrinterPermissionChangeResult { account, sid: request.trustee_sid, before, after: actual_after, verified })
    }

    fn get_printer_level3(handle: &PrinterHandle) -> Result<(Vec<u64>, u32), String> {
        let mut needed = 0;
        unsafe { GetPrinterW(handle.0, 3, ptr::null_mut(), 0, &mut needed); }
        if needed == 0 { return Err(map_error(unsafe { GetLastError() })); }
        let mut buffer = vec![0u64; (needed as usize + size_of::<u64>() - 1) / size_of::<u64>()];
        if unsafe { GetPrinterW(handle.0, 3, buffer.as_mut_ptr() as *mut u8, needed, &mut needed) } == 0 { return Err(map_error(unsafe { GetLastError() })); }
        Ok((buffer, needed))
    }
    fn get_dacl(sd: *const c_void) -> Result<(bool, *mut c_void), String> {
        let mut present = 0; let mut dacl = ptr::null_mut(); let mut defaulted = 0;
        if unsafe { GetSecurityDescriptorDacl(sd, &mut present, &mut dacl, &mut defaulted) } == 0 { return Err(map_error(unsafe { GetLastError() })); }
        Ok((present != 0, dacl))
    }
    fn acl_size_info(dacl: *mut c_void) -> Result<AclSizeInformation, String> {
        let mut info = AclSizeInformation { ace_count: 0, acl_bytes_in_use: 0, acl_bytes_free: 0 };
        if unsafe { GetAclInformation(dacl, &mut info, size_of::<AclSizeInformation>() as u32, 2) } == 0 { return Err(map_error(unsafe { GetLastError() })); }
        Ok(info)
    }
    fn get_ace(dacl: *mut c_void, index: u32) -> Result<*mut c_void, String> {
        let mut ace = ptr::null_mut();
        if unsafe { GetAce(dacl, index, &mut ace) } == 0 { return Err(map_error(unsafe { GetLastError() })); }
        Ok(ace)
    }
    unsafe fn sid_at(ace: *mut c_void) -> *const c_void {
        &(*(ace as *const AccessAce)).sid_start as *const u32 as *const c_void
    }
    fn string_for_sid(sid: *const c_void) -> Option<String> {
        let mut output = ptr::null_mut();
        if unsafe { ConvertSidToStringSidW(sid, &mut output) } == 0 { return None; }
        let allocation = LocalMemory(output as *mut c_void);
        let result = unsafe { text(output) };
        drop(allocation);
        result
    }
    fn account_for_sid(sid: *const c_void) -> Option<String> {
        let mut name_len = 0; let mut domain_len = 0; let mut use_type = 0;
        unsafe { LookupAccountSidW(ptr::null(), sid, ptr::null_mut(), &mut name_len, ptr::null_mut(), &mut domain_len, &mut use_type); }
        if name_len == 0 { return None; }
        let mut name = vec![0u16; name_len as usize]; let mut domain = vec![0u16; domain_len.max(1) as usize];
        if unsafe { LookupAccountSidW(ptr::null(), sid, name.as_mut_ptr(), &mut name_len, domain.as_mut_ptr(), &mut domain_len, &mut use_type) } == 0 { return None; }
        let account = String::from_utf16_lossy(&name[..name_len as usize]);
        let domain = String::from_utf16_lossy(&domain[..domain_len as usize]);
        Some(if domain.is_empty() { account } else { format!("{domain}\\{account}") })
    }
    fn sid_from_string(value: &str) -> Result<LocalMemory, String> {
        let mut sid = ptr::null_mut();
        if unsafe { ConvertStringSidToSidW(wide(value).as_ptr(), &mut sid) } == 0 { return Err("A identificação SID da permissão é inválida.".into()); }
        Ok(LocalMemory(sid))
    }
    fn values_from_mask(mask: u32) -> PrinterPermissionValues {
        PrinterPermissionValues { print: mask & PRINTER_ACCESS_USE != 0, manage_printer: mask & PRINTER_ACCESS_MANAGE != 0, manage_documents: mask & JOB_ACCESS_ADMINISTER != 0 }
    }
    fn mask_from_values(values: &PrinterPermissionValues) -> u32 {
        (if values.print { PRINTER_ACCESS_USE } else { 0 }) |
        (if values.manage_printer { PRINTER_ACCESS_MANAGE } else { 0 }) |
        (if values.manage_documents { JOB_ACCESS_ADMINISTER } else { 0 })
    }
    fn has_editable_direct_allow(ace_type: u8, ace_flags: u8, same_sid_count: usize, sid_resolvable: bool) -> bool {
        ace_type == ACE_ACCESS_ALLOWED && ace_flags == 0 && same_sid_count == 1 && sid_resolvable
    }
    fn get_permissions_for_handle(handle: &PrinterHandle) -> Result<PrinterPermissionsSnapshot, String> {
        let (mut buffer, _) = get_printer_level3(handle)?;
        let sd = unsafe { (*(buffer.as_mut_ptr() as *mut PrinterInfo3W)).security_descriptor };
        if sd.is_null() { return Ok(PrinterPermissionsSnapshot { state: "unavailable".into(), entries: Vec::new(), notice: Some("O Windows não retornou o descritor de segurança.".into()) }); }
        let (present, dacl) = get_dacl(sd)?;
        if !present { return Ok(PrinterPermissionsSnapshot { state: "unrestricted".into(), entries: Vec::new(), notice: Some("A DACL está ausente, o que representa acesso irrestrito segundo o descritor do Windows.".into()) }); }
        if dacl.is_null() { return Ok(PrinterPermissionsSnapshot { state: "unrestricted".into(), entries: Vec::new(), notice: Some("A DACL está nula, o que representa acesso irrestrito segundo o descritor do Windows.".into()) }); }
        let info = acl_size_info(dacl)?;
        let mut has_unsupported_ace = false;
        for index in 0..info.ace_count {
            let header = unsafe { &*(get_ace(dacl, index)? as *const AceHeader) };
            if !matches!(header.ace_type, ACE_ACCESS_ALLOWED | ACE_ACCESS_DENIED) { has_unsupported_ace = true; }
        }
        let mut entries = Vec::with_capacity(info.ace_count as usize);
        for index in 0..info.ace_count {
            let ace = get_ace(dacl, index)?;
            let header = unsafe { &*(ace as *const AceHeader) };
            if matches!(header.ace_type, ACE_ACCESS_ALLOWED | ACE_ACCESS_DENIED) {
                let parsed = unsafe { &*(ace as *const AccessAce) };
                let sid = unsafe { sid_at(ace) };
                let sid_text = string_for_sid(sid);
                let mut same_sid_count = 0;
                for other_index in 0..info.ace_count {
                    let other = get_ace(dacl, other_index)?;
                    let other_header = unsafe { &*(other as *const AceHeader) };
                    if matches!(other_header.ace_type, ACE_ACCESS_ALLOWED | ACE_ACCESS_DENIED) && unsafe { EqualSid(sid, sid_at(other)) } != 0 { same_sid_count += 1; }
                }
                let inherited = header.ace_flags & INHERITED_ACE != 0;
                let allowed = header.ace_type == ACE_ACCESS_ALLOWED;
                entries.push(crate::models::printer_operation::PrinterPermissionEntry {
                    ace_index: index,
                    sid: sid_text,
                    account: account_for_sid(sid).or_else(|| string_for_sid(sid)).unwrap_or_else(|| "Identidade não resolvida".into()),
                    access_type: if allowed { "Permitir".into() } else { "Negar".into() },
                    permissions: Some(values_from_mask(parsed.mask)),
                    special_permissions: parsed.mask & !KNOWN_PERMISSION_BITS != 0,
                    inherited,
                    editable: !has_unsupported_ace && has_editable_direct_allow(header.ace_type, header.ace_flags, same_sid_count, string_for_sid(sid).is_some()),
                });
            } else {
                entries.push(crate::models::printer_operation::PrinterPermissionEntry {
                    ace_index: index, sid: None, account: "Entrada especial não interpretada".into(), access_type: "Não interpretada".into(),
                    permissions: None, special_permissions: true, inherited: header.ace_flags & INHERITED_ACE != 0, editable: false,
                });
            }
        }
        let notice = if has_unsupported_ace {
            "Há entradas especiais de ACL que não foram interpretadas nesta leitura técnica. A configuração de Todos preserva essas entradas. Grupos aninhados e permissões efetivas dependem de associação e herança do Windows."
        } else {
            "São exibidas as entradas diretas da ACL. Grupos aninhados e permissões efetivas podem depender de associação e herança do Windows."
        };
        Ok(PrinterPermissionsSnapshot { state: "available".into(), entries, notice: Some(notice.into()) })
    }
    fn prepare_dacl_update(sd: *mut c_void, dacl: *mut c_void) -> Result<(), String> {
        // Send only the DACL. Owner/group/SACL remain unchanged on the printer.
        if unsafe {
            SetSecurityDescriptorOwner(sd, ptr::null_mut(), 0) == 0
                || SetSecurityDescriptorGroup(sd, ptr::null_mut(), 0) == 0
                || SetSecurityDescriptorSacl(sd, 0, ptr::null_mut(), 0) == 0
                || SetSecurityDescriptorDacl(sd, 1, dacl, 0) == 0
        } { return Err(map_error(unsafe { GetLastError() })); }
        Ok(())
    }

    fn make_absolute_sd(source: *const c_void) -> Result<AbsoluteSecurityDescriptor, String> {
        let mut sd_len = 0; let mut dacl_len = 0; let mut sacl_len = 0; let mut owner_len = 0; let mut group_len = 0;
        unsafe { MakeAbsoluteSD(source, ptr::null_mut(), &mut sd_len, ptr::null_mut(), &mut dacl_len, ptr::null_mut(), &mut sacl_len, ptr::null_mut(), &mut owner_len, ptr::null_mut(), &mut group_len); }
        if sd_len == 0 { return Err(map_error(unsafe { GetLastError() })); }
        let mut sd = vec![0u64; (sd_len as usize + 7) / 8];
        let mut dacl = vec![0u64; (dacl_len as usize + 7) / 8];
        let mut sacl = vec![0u64; (sacl_len as usize + 7) / 8];
        let mut owner = vec![0u64; (owner_len as usize + 7) / 8];
        let mut group = vec![0u64; (group_len as usize + 7) / 8];
        if unsafe { MakeAbsoluteSD(source, sd.as_mut_ptr() as *mut c_void, &mut sd_len, dacl.as_mut_ptr() as *mut c_void, &mut dacl_len, sacl.as_mut_ptr() as *mut c_void, &mut sacl_len, owner.as_mut_ptr() as *mut c_void, &mut owner_len, group.as_mut_ptr() as *mut c_void, &mut group_len) } == 0 {
            return Err(map_error(unsafe { GetLastError() }));
        }
        Ok(AbsoluteSecurityDescriptor { descriptor: sd, _dacl: dacl, _sacl: sacl, _owner: owner, _group: group })
    }

    #[cfg(test)]
    mod tests {
        use super::{has_editable_direct_allow, map_error, mask_from_values, validate_metadata, validate_printer_name, validate_share_name, values_from_mask, ACE_ACCESS_ALLOWED, ACE_ACCESS_DENIED, ERROR_ACCESS_DENIED, INHERITED_ACE, KNOWN_PERMISSION_BITS};
        use crate::models::printer_operation::PrinterPermissionValues;
        #[test] fn printer_and_share_names_reject_empty_invalid_and_overlong_values() {
            assert!(validate_printer_name("  ").is_err());
            assert!(validate_printer_name("HP/Shared").is_err());
            assert!(validate_printer_name(&"x".repeat(221)).is_err());
            assert!(validate_printer_name("HP Atendimento").is_ok());
            assert!(validate_share_name("Share/Name").is_err());
            assert!(validate_share_name(&"s".repeat(81)).is_err());
            assert!(validate_share_name("Financeiro").is_ok());
        }
        #[test] fn metadata_has_a_bounded_length() {
            assert!(validate_metadata(&"x".repeat(1025), "Comentário").is_err());
            assert!(validate_metadata("Recepção", "Localização").is_ok());
        }
        #[test] fn permission_mapping_preserves_known_and_special_bits() {
            let values = PrinterPermissionValues { print: true, manage_printer: false, manage_documents: true };
            assert_eq!(mask_from_values(&values), 0x18);
            assert_eq!(values_from_mask(0x18).print, true);
            assert_ne!(0x80 & !KNOWN_PERMISSION_BITS, 0);
        }
        #[test] fn permission_edit_is_limited_to_one_resolved_direct_allow_entry() {
            assert!(has_editable_direct_allow(ACE_ACCESS_ALLOWED, 0, 1, true));
            assert!(!has_editable_direct_allow(ACE_ACCESS_DENIED, 0, 1, true));
            assert!(!has_editable_direct_allow(ACE_ACCESS_ALLOWED, INHERITED_ACE, 1, true));
            assert!(!has_editable_direct_allow(ACE_ACCESS_ALLOWED, 0x01, 1, true));
            assert!(!has_editable_direct_allow(ACE_ACCESS_ALLOWED, 0, 2, true));
            assert!(!has_editable_direct_allow(ACE_ACCESS_ALLOWED, 0, 1, false));
        }
        #[test] fn explains_access_denied_from_windows() {
            assert!(map_error(ERROR_ACCESS_DENIED).contains("negou permissão"));
        }
        #[test] fn dacl_update_excludes_owner_group_and_audit_permissions() {
            use super::*;
            #[link(name = "advapi32")]
            extern "system" {
                fn InitializeSecurityDescriptor(sd: *mut c_void, revision: u32) -> i32;
                fn GetSecurityDescriptorOwner(sd: *const c_void, owner: *mut *mut c_void, defaulted: *mut i32) -> i32;
                fn GetSecurityDescriptorGroup(sd: *const c_void, group: *mut *mut c_void, defaulted: *mut i32) -> i32;
                fn GetSecurityDescriptorSacl(sd: *const c_void, present: *mut i32, sacl: *mut *mut c_void, defaulted: *mut i32) -> i32;
                fn InitializeAcl(acl: *mut c_void, length: u32, revision: u32) -> i32;
            }
            let mut descriptor = [0u64; 8];
            let sd = descriptor.as_mut_ptr() as *mut c_void;
            let mut acl = [0u64; 1];
            let acl = acl.as_mut_ptr() as *mut c_void;
            let sid = sid_from_string("S-1-5-32-545").unwrap();
            unsafe {
                assert_ne!(InitializeSecurityDescriptor(sd, 1), 0);
                assert_ne!(InitializeAcl(acl, 8, 2), 0);
                assert_ne!(SetSecurityDescriptorOwner(sd, sid.0, 0), 0);
                assert_ne!(SetSecurityDescriptorGroup(sd, sid.0, 0), 0);
                assert_ne!(SetSecurityDescriptorSacl(sd, 1, acl, 0), 0);
            }
            prepare_dacl_update(sd, acl).unwrap();
            let mut owner = sid.0; let mut group = sid.0; let mut sacl = acl;
            let mut defaulted = 0; let mut present = 1;
            unsafe {
                assert_ne!(GetSecurityDescriptorOwner(sd, &mut owner, &mut defaulted), 0);
                assert_ne!(GetSecurityDescriptorGroup(sd, &mut group, &mut defaulted), 0);
                assert_ne!(GetSecurityDescriptorSacl(sd, &mut present, &mut sacl, &mut defaulted), 0);
            }
            assert!(owner.is_null() && group.is_null());
            assert_eq!(present, 0);
            assert_eq!(get_dacl(sd).unwrap(), (true, acl));
        }
        #[test] fn targeted_acl_edit_preserves_other_accounts() {
            use super::*;
            let first = sid_from_string("S-1-5-32-545").unwrap();
            let second = sid_from_string("S-1-5-32-544").unwrap();
            let entry = |sid: *mut c_void, permissions| ExplicitAccessW {
                permissions, access_mode: SET_ACCESS, inheritance: NO_INHERITANCE,
                trustee: TrusteeW { multiple_trustee: ptr::null_mut(), multiple_trustee_operation: 0, trustee_form: TRUSTEE_IS_SID, trustee_type: TRUSTEE_IS_UNKNOWN, trustee_name: sid as *mut u16 },
            };
            let original = [entry(first.0, 0x20008), entry(second.0, 0xF000C)];
            let mut old_acl = ptr::null_mut();
            assert_eq!(unsafe { SetEntriesInAclW(2, original.as_ptr(), ptr::null_mut(), &mut old_acl) }, 0);
            let old_acl = LocalMemory(old_acl);
            let updated = entry(first.0, 0x20018);
            let mut new_acl = ptr::null_mut();
            assert_eq!(unsafe { SetEntriesInAclW(1, &updated, old_acl.0, &mut new_acl) }, 0);
            let new_acl = LocalMemory(new_acl);
            assert_eq!(acl_size_info(new_acl.0).unwrap().ace_count, 2);
            let mut observed = Vec::new();
            for index in 0..2 {
                let ace = unsafe { &*(get_ace(new_acl.0, index).unwrap() as *const AccessAce) };
                let sid = &ace.sid_start as *const u32 as *const c_void;
                observed.push((unsafe { EqualSid(sid, second.0) } != 0, ace.mask));
            }
            assert!(observed.contains(&(true, 0xF000C)));
            assert!(observed.contains(&(false, 0x20018)));
        }

        fn fixture_acl(entries: &[Vec<u8>]) -> Vec<u64> {
            use super::*;
            let size = 8 + entries.iter().map(Vec::len).sum::<usize>();
            let mut storage = vec![0u64; (size + 7) / 8];
            let acl = storage.as_mut_ptr() as *mut c_void;
            assert_ne!(unsafe { InitializeAcl(acl, size as u32, 4) }, 0);
            for entry in entries {
                assert_ne!(unsafe { AddAce(acl, 4, u32::MAX, entry.as_ptr() as *const c_void, entry.len() as u32) }, 0);
            }
            storage
        }
        fn raw_entries(acl: *mut std::ffi::c_void) -> Vec<Vec<u8>> {
            use super::*;
            (0..acl_size_info(acl).unwrap().ace_count).map(|index| {
                let ace = get_ace(acl, index).unwrap();
                let header = unsafe { &*(ace as *const AceHeader) };
                unsafe { std::slice::from_raw_parts(ace as *const u8, header.ace_size as usize) }.to_vec()
            }).collect()
        }
        #[test] fn everyone_missing_adds_printer_and_job_aces_preserving_other_accounts() {
            use super::*;
            let accounts = ["S-1-5-32-544", "S-1-5-21-10-20-30-1001", "S-1-3-0", "S-1-15-2-1"];
            let entries: Vec<_> = accounts.iter().map(|sid| {
                let sid = sid_from_string(sid).unwrap();
                allow_ace(sid.0, PRINTER_ALL_ACCESS, 0)
            }).collect();
            let mut source = fixture_acl(&entries);
            let mut updated = build_everyone_acl(source.as_mut_ptr() as *mut c_void).unwrap();
            let ptr = updated.as_mut_ptr() as *mut c_void;
            assert!(everyone_has_required_permissions(ptr).unwrap());
            let actual = raw_entries(ptr);
            assert_eq!(actual.len(), entries.len() + 2);
            for original in entries { assert!(actual.contains(&original)); }
        }
        #[test] fn everyone_existing_is_updated_without_duplicates_or_lost_special_bits() {
            use super::*;
            let everyone = sid_from_string(EVERYONE_SID).unwrap();
            let initial = vec![allow_ace(everyone.0, READ_CONTROL | PRINTER_ACCESS_USE | 0x80, 0), allow_ace(everyone.0, JOB_ACCESS_ADMINISTER, OBJECT_INHERIT_ACE | INHERIT_ONLY_ACE)];
            let mut source = fixture_acl(&initial);
            let mut updated = build_everyone_acl(source.as_mut_ptr() as *mut c_void).unwrap();
            let acl = updated.as_mut_ptr() as *mut c_void;
            assert!(everyone_has_required_permissions(acl).unwrap());
            let actual = raw_entries(acl);
            assert_eq!(actual.len(), 2);
            assert_eq!(u32::from_le_bytes(actual[0][4..8].try_into().unwrap()), PRINTER_ALL_ACCESS | 0x80);
            assert_eq!(u32::from_le_bytes(actual[1][4..8].try_into().unwrap()), JOB_ALL_ACCESS);
            let mut again = build_everyone_acl(acl).unwrap();
            assert_eq!(raw_entries(again.as_mut_ptr() as *mut c_void), actual);
        }
        #[test] fn everyone_print_only_gets_separate_inheritable_manage_documents_entry() {
            use super::*;
            let everyone = sid_from_string(EVERYONE_SID).unwrap();
            let mut source = fixture_acl(&[allow_ace(everyone.0, PRINTER_ACCESS_USE, 0)]);
            let mut updated = build_everyone_acl(source.as_mut_ptr() as *mut c_void).unwrap();
            let entries = raw_entries(updated.as_mut_ptr() as *mut c_void);
            assert_eq!(entries.len(), 2);
            assert_eq!(entries[1][1], OBJECT_INHERIT_ACE | INHERIT_ONLY_ACE);
            assert_eq!(u32::from_le_bytes(entries[1][4..8].try_into().unwrap()), JOB_ALL_ACCESS);
        }
        #[test] fn preserves_deny_inherited_and_callback_aces_for_other_accounts() {
            use super::*;
            let other = sid_from_string("S-1-5-32-545").unwrap();
            let mut deny = allow_ace(other.0, PRINTER_ACCESS_ADMINISTER, 0); deny[0] = ACE_ACCESS_DENIED;
            let mut callback = allow_ace(other.0, PRINTER_ACCESS_USE, 0); callback[0] = 9;
            callback.extend_from_slice(&[0u8; 4]);
            let size = callback.len() as u16; callback[2..4].copy_from_slice(&size.to_le_bytes());
            let inherited = allow_ace(other.0, PRINTER_ACCESS_USE, INHERITED_ACE);
            let originals = vec![deny, callback, inherited.clone()];
            let mut source = fixture_acl(&originals);
            let mut updated = build_everyone_acl(source.as_mut_ptr() as *mut c_void).unwrap();
            let actual = raw_entries(updated.as_mut_ptr() as *mut c_void);
            for original in originals { assert!(actual.contains(&original)); }
            assert_eq!(actual.last().unwrap(), &inherited);
        }
        #[test] fn conflicting_everyone_deny_blocks_configuration_without_changing_source() {
            use super::*;
            let everyone = sid_from_string(EVERYONE_SID).unwrap();
            let mut deny = allow_ace(everyone.0, PRINTER_ACCESS_USE, 0); deny[0] = ACE_ACCESS_DENIED;
            let mut source = fixture_acl(&[deny]);
            let before = raw_entries(source.as_mut_ptr() as *mut c_void);
            assert!(build_everyone_acl(source.as_mut_ptr() as *mut c_void).unwrap_err().contains("negação"));
            assert_eq!(raw_entries(source.as_mut_ptr() as *mut c_void), before);
        }
        #[test] fn admin_gate_and_redirected_errors_do_not_mask_access_denied() {
            use super::*;
            assert_eq!(ensure_elevated(false).unwrap_err(), ADMIN_REQUIRED);
            assert!(ensure_elevated(true).is_ok());
            assert!(map_printer_context_error(ERROR_ACCESS_DENIED, true).contains("negou permissão"));
            assert!(!map_printer_context_error(ERROR_ACCESS_DENIED, true).contains("redirecionada"));
            assert!(map_printer_context_error(50, true).contains("redirecionada"));
            assert!(map_printer_context_error(1803, true).contains("redirecionada"));
            assert!(!map_printer_context_error(50, false).contains("redirecionada"));
        }
        #[test] fn shared_and_share_name_change_together_preserving_other_properties() {
            use super::*;
            let mut name = wide("Impressora"); let mut port = wide("USB001"); let mut driver = wide("Driver");
            let mut location = wide("Recepção"); let mut comment = wide("Comentário"); let mut share = wide("Balcao");
            let mut info: PrinterInfo2W = unsafe { std::mem::zeroed() };
            info.printer_name = name.as_mut_ptr(); info.port_name = port.as_mut_ptr(); info.driver_name = driver.as_mut_ptr();
            info.location = location.as_mut_ptr(); info.comment = comment.as_mut_ptr();
            info.attributes = PRINTER_ATTRIBUTE_TS | 0x40; info.priority = 5; info.jobs = 3; info.status = PRINTER_STATUS_PAUSED;
            update_share_info(&mut info, true, share.as_mut_ptr());
            assert_eq!(info.attributes, PRINTER_ATTRIBUTE_TS | 0x40 | PRINTER_ATTRIBUTE_SHARED);
            assert_eq!(unsafe { text(info.share_name) }.as_deref(), Some("Balcao"));
            let mut renamed = wide("Caixa"); update_share_info(&mut info, true, renamed.as_mut_ptr());
            assert_eq!(unsafe { text(info.share_name) }.as_deref(), Some("Caixa"));
            update_share_info(&mut info, false, renamed.as_mut_ptr());
            assert_eq!(info.attributes, PRINTER_ATTRIBUTE_TS | 0x40); assert!(info.share_name.is_null());
            assert_eq!(info.printer_name, name.as_mut_ptr()); assert_eq!(info.port_name, port.as_mut_ptr()); assert_eq!(info.driver_name, driver.as_mut_ptr());
            assert_eq!(info.location, location.as_mut_ptr()); assert_eq!(info.comment, comment.as_mut_ptr());
            assert_eq!((info.priority, info.jobs, info.status), (5, 3, PRINTER_STATUS_PAUSED));
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::*;
    pub fn get_configuration(_: String) -> Result<PrinterConfigurationSnapshot, String> { Err("Esta operação exige o Desktop Windows.".into()) }
    pub fn is_paused(_: String) -> Result<bool, String> { Err("Esta operação exige o Desktop Windows.".into()) }
    pub fn native_state(_: String) -> Result<crate::models::printer_diagnostic::PrinterNativeState, String> { Err("Esta operação exige o Desktop Windows.".into()) }
    pub fn elevated_context() -> Result<bool, String> { Err("Esta operação exige o Desktop Windows.".into()) }
    pub fn require_elevation() -> Result<(), String> { Err("Esta operação exige o Desktop Windows.".into()) }
    pub fn set_port(_: String, _: String) -> Result<(), String> { Err("Esta operação exige o Desktop Windows.".into()) }
    pub fn set_default_printer(_: String) -> Result<(), String> { Err("Esta operação exige o Desktop Windows.".into()) }
    pub fn rename_printer(_: String, _: String) -> Result<(), String> { Err("Esta operação exige o Desktop Windows.".into()) }
    pub fn set_share(_: String, _: bool, _: Option<String>) -> Result<(), String> { Err("Esta operação exige o Desktop Windows.".into()) }
    pub fn set_location(_: String, _: String) -> Result<(), String> { Err("Esta operação exige o Desktop Windows.".into()) }
    pub fn set_comment(_: String, _: String) -> Result<(), String> { Err("Esta operação exige o Desktop Windows.".into()) }
    pub fn get_printer_permissions(_: String) -> Result<PrinterPermissionsSnapshot, String> { Err("Esta operação exige o Desktop Windows.".into()) }
    pub fn configure_permissions(_: String) -> Result<(), String> { Err("Esta operação exige o Desktop Windows.".into()) }
    pub fn set_printer_permissions(_: SetPrinterPermissionRequest) -> Result<PrinterPermissionChangeResult, String> { Err("Esta operação exige o Desktop Windows.".into()) }
}

pub fn get_configuration(name: String) -> Result<PrinterConfigurationSnapshot, String> { platform::get_configuration(name) }
pub fn is_paused(name: String) -> Result<bool, String> { platform::is_paused(name) }
pub fn native_state(name: String) -> Result<crate::models::printer_diagnostic::PrinterNativeState, String> { platform::native_state(name) }
pub fn elevated_context() -> Result<bool, String> { platform::elevated_context() }
pub fn require_elevation() -> Result<(), String> { platform::require_elevation() }
pub fn set_port(name: String, port: String) -> Result<(), String> { platform::set_port(name, port) }
pub fn set_default_printer(name: String) -> Result<(), String> { platform::set_default_printer(name) }
pub fn rename_printer(name: String, new_name: String) -> Result<(), String> { platform::rename_printer(name, new_name) }
pub fn set_share(name: String, enabled: bool, share_name: Option<String>) -> Result<(), String> { platform::set_share(name, enabled, share_name) }
pub fn set_location(name: String, location: String) -> Result<(), String> { platform::set_location(name, location) }
pub fn set_comment(name: String, comment: String) -> Result<(), String> { platform::set_comment(name, comment) }
pub fn get_printer_permissions(name: String) -> Result<PrinterPermissionsSnapshot, String> { platform::get_printer_permissions(name) }
pub fn configure_permissions(name: String) -> Result<(), String> { platform::configure_permissions(name) }
pub fn set_printer_permissions(request: SetPrinterPermissionRequest) -> Result<PrinterPermissionChangeResult, String> { platform::set_printer_permissions(request) }
