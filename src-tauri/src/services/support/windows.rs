use std::{ffi::c_void, ptr};
pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}
pub unsafe fn text(p: *const u16) -> Option<String> {
    if p.is_null() {
        return None;
    }
    let mut n = 0;
    while n < 32768 && *p.add(n) != 0 {
        n += 1
    }
    Some(String::from_utf16_lossy(std::slice::from_raw_parts(p, n)))
}
pub fn failure(context: &str) -> String {
    format!("{context}: {}", std::io::Error::last_os_error())
}
#[link(name = "advapi32")]
extern "system" {
    fn RegOpenKeyExW(
        key: *mut c_void,
        path: *const u16,
        options: u32,
        access: u32,
        out: *mut *mut c_void,
    ) -> i32;
    fn RegQueryValueExW(
        key: *mut c_void,
        name: *const u16,
        reserved: *mut u32,
        kind: *mut u32,
        data: *mut u8,
        length: *mut u32,
    ) -> i32;
    fn RegCloseKey(key: *mut c_void) -> i32;
    fn RegEnumKeyExW(
        key: *mut c_void,
        index: u32,
        name: *mut u16,
        length: *mut u32,
        reserved: *mut u32,
        class: *mut u16,
        class_length: *mut u32,
        time: *mut c_void,
    ) -> i32;
    fn RegSetValueExW(
        key: *mut c_void,
        name: *const u16,
        reserved: u32,
        kind: u32,
        data: *const u8,
        length: u32,
    ) -> i32;
    fn RegEnumValueW(
        key: *mut c_void,
        index: u32,
        name: *mut u16,
        length: *mut u32,
        reserved: *mut u32,
        kind: *mut u32,
        data: *mut u8,
        data_length: *mut u32,
    ) -> i32;
}
pub const HKLM: isize = 0x80000002u32 as i32 as isize;
pub const HKCU: isize = 0x80000001u32 as i32 as isize;
struct Key(*mut c_void);
impl Drop for Key {
    fn drop(&mut self) {
        unsafe {
            RegCloseKey(self.0);
        }
    }
}
fn open(hive: isize, path: &str, view: u32, access: u32) -> Result<Key, u32> {
    let mut h = ptr::null_mut();
    let rc = unsafe {
        RegOpenKeyExW(
            hive as *mut c_void,
            wide(path).as_ptr(),
            0,
            access | view,
            &mut h,
        )
    };
    if rc == 0 {
        Ok(Key(h))
    } else {
        Err(rc as u32)
    }
}
pub fn value(hive: isize, path: &str, name: &str, view: u32) -> Result<Option<String>, u32> {
    let key = match open(hive, path, view, 1) {
        Ok(k) => k,
        Err(2 | 3) => return Ok(None),
        Err(e) => return Err(e),
    };
    let mut kind = 0;
    let mut len = 0;
    let n = wide(name);
    let rc = unsafe {
        RegQueryValueExW(
            key.0,
            n.as_ptr(),
            ptr::null_mut(),
            &mut kind,
            ptr::null_mut(),
            &mut len,
        )
    };
    if rc == 2 {
        return Ok(None);
    }
    if rc != 0 {
        return Err(rc as u32);
    }
    if len > 65536 {
        return Err(234);
    }
    let mut b = vec![0u8; len as usize];
    let rc = unsafe {
        RegQueryValueExW(
            key.0,
            n.as_ptr(),
            ptr::null_mut(),
            &mut kind,
            b.as_mut_ptr(),
            &mut len,
        )
    };
    if rc != 0 {
        return Err(rc as u32);
    }
    Ok(match kind {
        4 if len >= 4 => Some(u32::from_le_bytes(b[..4].try_into().unwrap()).to_string()),
        1 | 2 | 7 => Some(
            String::from_utf16_lossy(
                &b[..len as usize]
                    .chunks_exact(2)
                    .map(|p| u16::from_le_bytes([p[0], p[1]]))
                    .collect::<Vec<_>>(),
            )
            .trim_end_matches('\0')
            .into(),
        ),
        _ => None,
    })
}
pub fn exists(hive: isize, path: &str) -> Result<bool, u32> {
    match open(hive, path, 0x100, 1) {
        Ok(_) => Ok(true),
        Err(2 | 3) => Ok(false),
        Err(e) => Err(e),
    }
}
pub fn subkeys(hive: isize, path: &str, view: u32) -> Result<Vec<String>, u32> {
    let key = match open(hive, path, view, 8) {
        Ok(k) => k,
        Err(2 | 3) => return Ok(vec![]),
        Err(e) => return Err(e),
    };
    let mut items = Vec::new();
    for index in 0..8192 {
        let mut b = [0u16; 512];
        let mut len = 512;
        let rc = unsafe {
            RegEnumKeyExW(
                key.0,
                index,
                b.as_mut_ptr(),
                &mut len,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        if rc == 259 {
            break;
        }
        if rc != 0 {
            return Err(rc as u32);
        }
        items.push(String::from_utf16_lossy(&b[..len as usize]));
    }
    Ok(items)
}
pub fn disable_user_proxy() -> Result<(), String> {
    let key = open(
        HKCU,
        r"Software\Microsoft\Windows\CurrentVersion\Internet Settings",
        0,
        2,
    )
    .map_err(|e| format!("Registro: {e}"))?;
    let zero = 0u32;
    let rc = unsafe {
        RegSetValueExW(
            key.0,
            wide("ProxyEnable").as_ptr(),
            0,
            4,
            (&zero as *const u32).cast(),
            4,
        )
    };
    if rc != 0 {
        return Err(format!("ProxyEnable: {rc}"));
    }
    Ok(())
}
pub fn value_names(hive: isize, path: &str, view: u32) -> Result<Vec<String>, u32> {
    let key = match open(hive, path, view, 1) {
        Ok(k) => k,
        Err(2 | 3) => return Ok(vec![]),
        Err(e) => return Err(e),
    };
    let mut result = vec![];
    for index in 0..512 {
        let mut b = [0u16; 512];
        let mut len = 512;
        let rc = unsafe {
            RegEnumValueW(
                key.0,
                index,
                b.as_mut_ptr(),
                &mut len,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
            )
        };
        if rc == 259 {
            break;
        }
        if rc != 0 {
            return Err(rc as u32);
        }
        result.push(String::from_utf16_lossy(&b[..len as usize]));
    }
    Ok(result)
}

pub fn file_access(path: &str) -> Result<(bool, bool), String> {
    #[repr(C)]
    struct Mapping {
        read: u32,
        write: u32,
        execute: u32,
        all: u32,
    }
    #[link(name = "advapi32")]
    extern "system" {
        fn GetNamedSecurityInfoW(
            name: *const u16,
            kind: u32,
            security: u32,
            owner: *mut *mut c_void,
            group: *mut *mut c_void,
            dacl: *mut *mut c_void,
            sacl: *mut *mut c_void,
            descriptor: *mut *mut c_void,
        ) -> u32;
        fn OpenProcessToken(process: *mut c_void, access: u32, token: *mut *mut c_void) -> i32;
        fn DuplicateToken(token: *mut c_void, level: u32, out: *mut *mut c_void) -> i32;
        fn MapGenericMask(mask: *mut u32, mapping: *const Mapping);
        fn AccessCheck(
            sd: *const c_void,
            token: *mut c_void,
            desired: u32,
            mapping: *const Mapping,
            privileges: *mut c_void,
            size: *mut u32,
            granted: *mut u32,
            status: *mut i32,
        ) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn CloseHandle(h: *mut c_void) -> i32;
        fn LocalFree(p: *mut c_void) -> *mut c_void;
    }
    struct Token(*mut c_void);
    impl Drop for Token {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    struct Descriptor(*mut c_void);
    impl Drop for Descriptor {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
    let mut sd = ptr::null_mut();
    let rc = unsafe {
        GetNamedSecurityInfoW(
            wide(path).as_ptr(),
            1,
            7,
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            ptr::null_mut(),
            &mut sd,
        )
    };
    if rc != 0 {
        return Err(format!("ACL do arquivo: Windows {rc}"));
    }
    let sd = Descriptor(sd);
    let mut raw = ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), 8 | 2, &mut raw) } == 0 {
        return Err(failure("Token do usuário"));
    }
    let token = Token(raw);
    let mut dup = ptr::null_mut();
    if unsafe { DuplicateToken(token.0, 2, &mut dup) } == 0 {
        return Err(failure("Token de verificação de acesso"));
    }
    let token = Token(dup);
    let mapping = Mapping {
        read: 0x120089,
        write: 0x120116,
        execute: 0x1200a0,
        all: 0x1f01ff,
    };
    let check = |mut mask: u32| -> Result<bool, String> {
        unsafe {
            MapGenericMask(&mut mask, &mapping);
        }
        let mut privileges = [0u64; 128];
        let mut length = 1024;
        let (mut granted, mut status) = (0, 0);
        if unsafe {
            AccessCheck(
                sd.0,
                token.0,
                mask,
                &mapping,
                privileges.as_mut_ptr().cast(),
                &mut length,
                &mut granted,
                &mut status,
            )
        } == 0
        {
            return Err(failure("AccessCheck"));
        }
        Ok(status != 0)
    };
    Ok((check(0x80000000)?, check(0x40000000)?))
}
