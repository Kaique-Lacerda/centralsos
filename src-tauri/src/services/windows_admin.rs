#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostnameChangeResult {
    pub hostname: String,
    pub restart_required: bool,
}

#[cfg(windows)]
mod platform {
    use super::HostnameChangeResult;
    use std::ffi::c_void;

    const COMPUTER_NAME_PHYSICAL_NETBIOS: i32 = 4;
    const SW_SHOWNORMAL: i32 = 1;

    #[link(name = "kernel32")]
    extern "system" {
        fn SetComputerNameExW(name_type: i32, buffer: *const u16) -> i32;
        fn GetLastError() -> u32;
    }

    #[link(name = "shell32")]
    extern "system" {
        fn IsUserAnAdmin() -> i32;
        fn ShellExecuteW(
            window: *mut c_void,
            operation: *const u16,
            file: *const u16,
            parameters: *const u16,
            directory: *const u16,
            show_command: i32,
        ) -> isize;
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn validate_hostname(hostname: &str) -> Result<(), String> {
        let valid = !hostname.is_empty()
            && hostname.len() <= 15
            && hostname
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            && hostname.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
            && hostname.as_bytes().last().is_some_and(u8::is_ascii_alphanumeric);
        if valid {
            Ok(())
        } else {
            Err("Use de 1 a 15 letras, números ou hífens; o nome deve começar e terminar com letra ou número.".into())
        }
    }

    pub fn change_hostname(hostname: String) -> Result<HostnameChangeResult, String> {
        let hostname = hostname.trim();
        validate_hostname(hostname)?;
        if unsafe { IsUserAnAdmin() } == 0 {
            return Err("Esta alteração exige elevação. Feche e abra a CENTRAL SOS como administrador e tente novamente.".into());
        }
        let name = wide(hostname);
        if unsafe { SetComputerNameExW(COMPUTER_NAME_PHYSICAL_NETBIOS, name.as_ptr()) } == 0 {
            let code = unsafe { GetLastError() };
            return Err(format!("O Windows recusou a alteração do hostname (erro {code})."));
        }
        Ok(HostnameChangeResult { hostname: hostname.to_owned(), restart_required: true })
    }

    fn open_fixed_target(file: &str, elevated: bool) -> Result<(), String> {
        let operation = wide(if elevated { "runas" } else { "open" });
        let file = wide(file);
        let empty = wide("");
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(), operation.as_ptr(), file.as_ptr(), empty.as_ptr(),
                std::ptr::null(), SW_SHOWNORMAL,
            )
        };
        if result > 32 {
            Ok(())
        } else {
            Err(format!("O Windows não conseguiu abrir a ferramenta (código {result})."))
        }
    }

    pub fn open_computer_management() -> Result<(), String> { open_fixed_target("compmgmt.msc", false) }
    pub fn open_services_console() -> Result<(), String> { open_fixed_target("services.msc", false) }
    pub fn open_registry_editor() -> Result<(), String> { open_fixed_target("regedit.exe", false) }
    pub fn open_network_settings() -> Result<(), String> { open_fixed_target("ms-settings:network", false) }
    pub fn open_admin_terminal() -> Result<(), String> { open_fixed_target("cmd.exe", true) }
}

#[cfg(not(windows))]
mod platform {
    use super::HostnameChangeResult;
    pub fn change_hostname(_: String) -> Result<HostnameChangeResult, String> { Err("A alteração do hostname exige Windows Desktop.".into()) }
    pub fn open_computer_management() -> Result<(), String> { Err("Esta ferramenta exige Windows Desktop.".into()) }
    pub fn open_services_console() -> Result<(), String> { Err("Esta ferramenta exige Windows Desktop.".into()) }
    pub fn open_registry_editor() -> Result<(), String> { Err("Esta ferramenta exige Windows Desktop.".into()) }
    pub fn open_network_settings() -> Result<(), String> { Err("Esta ferramenta exige Windows Desktop.".into()) }
    pub fn open_admin_terminal() -> Result<(), String> { Err("Esta ferramenta exige Windows Desktop.".into()) }
}

pub use platform::{change_hostname, open_admin_terminal, open_computer_management, open_network_settings, open_registry_editor, open_services_console};
