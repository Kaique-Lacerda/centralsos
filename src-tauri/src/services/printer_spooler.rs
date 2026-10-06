use crate::models::printer_diagnostic::{SpoolerActionResult, SpoolerState};
use std::{path::Path, sync::Mutex};

static ACTION_LOCK: Mutex<()> = Mutex::new(());

pub trait SpoolerOperations {
    fn state(&self) -> SpoolerState;
    fn stop(&self) -> Result<(), String>;
    fn start(&self) -> Result<(), String>;
    fn cleanup(&self) -> Result<(u32, Vec<String>), String>;
}

// Kept independent of SCM so tests can verify sequencing without touching Windows.
fn execute(ops: &impl SpoolerOperations, action: &str, confirmed: bool) -> Result<SpoolerActionResult, String> {
    if !matches!(action, "start" | "restart" | "reset") { return Err("Ação do Spooler inválida.".into()); }
    if action == "reset" && !confirmed { return Err("Confirme a remoção de todos os trabalhos locais.".into()); }
    let before = ops.state();
    if before.error.is_some() || before.state.is_none() { return Err("O estado do Spooler não pôde ser confirmado.".into()); }
    if before.start_mode == Some(4) { return Err("Spooler desabilitado. A inicialização não será alterada.".into()); }
    let mut removed_files = 0; let mut failed_files = Vec::new();
    if action != "start" {
        if let Err(error)=ops.stop() {
            // A late STOP transition must not silently leave an originally running
            // Spooler stopped. Never delete anything on this path.
            if before.state==Some(4) && matches!(ops.state().state,Some(1|3)) {
                let recovery=ops.start();
                return Err(format!("{error} Recuperação do Spooler: {recovery:?}"));
            }
            return Err(error);
        }
        if ops.state().state != Some(1) { return Err("Spooler não está parado; nenhum arquivo foi removido.".into()); }
        if action == "reset" {
            match ops.cleanup() { Ok((removed, failed)) => { removed_files = removed; failed_files = failed; }, Err(error) => failed_files.push(error) }
        }
    }
    // Always try to restore printing, including after a cleanup error.
    ops.start().map_err(|error| format!("{error} Arquivos removidos: {removed_files}. Falhas de limpeza: {}", failed_files.join("; ")))?;
    let after = ops.state();
    if after.state != Some(4) { return Err("Não foi possível confirmar o Spooler em execução após a operação.".into()); }
    Ok(SpoolerActionResult { before, after, removed_files, failed_files })
}

fn spool_file(path: &Path) -> bool {
    path.extension().and_then(|s| s.to_str()).is_some_and(|s| s.eq_ignore_ascii_case("spl") || s.eq_ignore_ascii_case("shd"))
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::{ffi::c_void, ptr, time::{Duration, Instant}, os::windows::fs::MetadataExt};
    #[repr(C)] #[derive(Default)]
    struct ServiceStatus { kind:u32, state:u32, controls:u32, win_exit:u32, service_exit:u32, checkpoint:u32, wait_hint:u32, pid:u32, flags:u32 }
    #[repr(C)] struct ServiceConfig { kind:u32, start:u32, error_control:u32, binary:*const u16, group:*const u16, tag:u32, dependencies:*const u16, account:*const u16, display:*const u16 }
    #[link(name="advapi32")] extern "system" {
        fn OpenSCManagerW(machine:*const u16, database:*const u16, access:u32) -> *mut c_void;
        fn OpenServiceW(manager:*mut c_void, name:*const u16, access:u32) -> *mut c_void;
        fn CloseServiceHandle(handle:*mut c_void) -> i32;
        fn QueryServiceStatusEx(handle:*mut c_void, level:u32, buffer:*mut u8, size:u32, needed:*mut u32) -> i32;
        fn QueryServiceConfigW(handle:*mut c_void, buffer:*mut u8, size:u32, needed:*mut u32) -> i32;
        fn ControlService(handle:*mut c_void, control:u32, status:*mut ServiceStatus) -> i32;
        fn StartServiceW(handle:*mut c_void, count:u32, args:*const *const u16) -> i32;
    }
    #[link(name="kernel32")] extern "system" { fn GetLastError() -> u32; fn GetWindowsDirectoryW(buffer:*mut u16, size:u32) -> u32; }
    struct Handle(*mut c_void); impl Drop for Handle { fn drop(&mut self) { unsafe { CloseServiceHandle(self.0); } } }
    fn failure(action:&str) -> String { format!("{action} (Windows {}). Nenhuma configuração de inicialização foi alterada.", unsafe { GetLastError() }) }
    struct Native { service:Handle }
    impl Native {
        fn open(write:bool) -> Result<Self,String> {
            let manager = Handle(unsafe { OpenSCManagerW(ptr::null(),ptr::null(),1) });
            if manager.0.is_null() { return Err(failure("Acesso ao gerenciador local negado")); }
            let name:Vec<u16> = "Spooler\0".encode_utf16().collect();
            let service = Handle(unsafe { OpenServiceW(manager.0,name.as_ptr(), 1 | 4 | if write { 0x10 | 0x20 } else { 0 }) });
            if service.0.is_null() { return Err(failure("Não foi possível abrir o Spooler local")); }
            Ok(Self { service })
        }
        fn status(&self) -> Result<ServiceStatus,String> {
            let mut status=ServiceStatus::default(); let mut needed=0;
            if unsafe { QueryServiceStatusEx(self.service.0,0,&mut status as *mut _ as *mut u8,std::mem::size_of::<ServiceStatus>() as u32,&mut needed) } == 0 { return Err(failure("Falha ao ler Spooler")); }
            Ok(status)
        }
        fn wait(&self, state:u32) -> Result<(),String> {
            let deadline=Instant::now()+Duration::from_secs(30);
            loop { if self.status()?.state==state { return Ok(()); } if Instant::now()>=deadline { return Err("Tempo limite ao aguardar transição do Spooler.".into()); } std::thread::sleep(Duration::from_millis(250)); }
        }
    }
    impl SpoolerOperations for Native {
        fn state(&self) -> SpoolerState {
            let state=match self.status() { Ok(s)=>s.state, Err(error)=>return SpoolerState { state:None,start_mode:None,error:Some(error) } };
            let mut needed=0; unsafe { QueryServiceConfigW(self.service.0,ptr::null_mut(),0,&mut needed); }
            let mut data=vec![0u64;(needed as usize+7)/8];
            let start_mode=if needed>=std::mem::size_of::<ServiceConfig>() as u32 && unsafe { QueryServiceConfigW(self.service.0,data.as_mut_ptr() as *mut u8,needed,&mut needed) }!=0 { Some(unsafe { (*(data.as_ptr() as *const ServiceConfig)).start }) } else { None };
            SpoolerState { state:Some(state),start_mode,error:None }
        }
        fn stop(&self) -> Result<(),String> {
            let current=self.status()?.state;
            if current==1 { return Ok(()); }
            if current!=3 { let mut s=ServiceStatus::default(); if unsafe { ControlService(self.service.0,1,&mut s) }==0 { return Err(failure("Não foi possível parar o Spooler")); } }
            self.wait(1)
        }
        fn start(&self) -> Result<(),String> {
            let mut current=self.status()?.state;
            if current==3 {self.wait(1)?;current=self.status()?.state;}
            if current==4 { return Ok(()); }
            if current!=2 && unsafe { StartServiceW(self.service.0,0,ptr::null()) }==0 { return Err(failure("Não foi possível iniciar o Spooler")); }
            self.wait(4)
        }
        fn cleanup(&self) -> Result<(u32,Vec<String>),String> {
            let mut buffer=vec![0u16;32768]; let size=unsafe { GetWindowsDirectoryW(buffer.as_mut_ptr(),buffer.len() as u32) };
            if size==0 || size as usize>=buffer.len() { return Err("Diretório Windows não determinado. Limpeza recusada.".into()); }
            let root=std::path::PathBuf::from(String::from_utf16_lossy(&buffer[..size as usize]));
            let mut path=root.clone();
            for segment in ["System32","spool","PRINTERS"] {
                path.push(segment);
                let meta=std::fs::symlink_metadata(&path).map_err(|e| format!("Não foi possível verificar a pasta fixa de spool: {e}"))?;
                if !meta.is_dir() || meta.file_attributes()&0x400!=0 { return Err("Pasta de spool redirecionada/reparse point; limpeza recusada.".into()); }
            }
            if !path.canonicalize().map_err(|e|e.to_string())?.starts_with(root.canonicalize().map_err(|e|e.to_string())?) { return Err("Pasta de spool fora do Windows; limpeza recusada.".into()); }
            let mut removed=0; let mut failures=Vec::new();
            for item in std::fs::read_dir(&path).map_err(|e|e.to_string())? {
                match self.status() {Ok(status) if status.state==1=>{},_=>{failures.push("Spooler deixou de estar confirmado como parado. Limpeza interrompida.".into());break;}}
                let item=match item { Ok(item)=>item,Err(e)=>{failures.push(e.to_string());continue;} };
                let file=item.path(); if !spool_file(&file) { continue; }
                match std::fs::symlink_metadata(&file) {
                    Ok(meta) if meta.is_file() && meta.file_attributes()&0x400==0 => match std::fs::remove_file(&file) { Ok(())=>removed+=1,Err(e)=>failures.push(format!("{}: {e}",item.file_name().to_string_lossy())) },
                    Ok(_)=>failures.push(format!("{}: arquivo não regular; preservado",item.file_name().to_string_lossy())),
                    Err(e)=>failures.push(e.to_string()),
                }
            }
            Ok((removed,failures))
        }
    }
    pub fn snapshot() -> SpoolerState { match Native::open(false) { Ok(s)=>s.state(),Err(error)=>SpoolerState { state:None,start_mode:None,error:Some(error) } } }
    pub fn action(action:&str,confirmed:bool) -> Result<SpoolerActionResult,String> {
        if action=="reset" && !confirmed { return Err("Confirme a remoção de todos os trabalhos locais.".into()); }
        crate::services::printer_management::require_elevation()?;
        let _guard=ACTION_LOCK.try_lock().map_err(|_|"Outra operação do Spooler está em andamento.")?;
        execute(&Native::open(true)?,action,confirmed)
    }
}
#[cfg(windows)] pub use platform::{action,snapshot};
#[cfg(not(windows))] pub fn snapshot() -> SpoolerState { SpoolerState { state:None,start_mode:None,error:Some("Exige Windows.".into()) } }
#[cfg(not(windows))] pub fn action(_: &str,_:bool) -> Result<SpoolerActionResult,String> { Err("Exige Windows.".into()) }

#[cfg(test)] mod tests {
    use super::*; use std::cell::{Cell,RefCell};
    struct Fake { state:Cell<u32>, log:RefCell<Vec<&'static str>>, cleanup_error:bool, stop_error:bool }
    impl SpoolerOperations for Fake {
        fn state(&self)->SpoolerState { SpoolerState { state:Some(self.state.get()),start_mode:Some(2),error:None } }
        fn stop(&self)->Result<(),String> { self.log.borrow_mut().push("stop"); if self.stop_error { return Err("stop failed".into()); } self.state.set(1);Ok(()) }
        fn start(&self)->Result<(),String> { self.log.borrow_mut().push("start");self.state.set(4);Ok(()) }
        fn cleanup(&self)->Result<(u32,Vec<String>),String> { assert_eq!(self.state.get(),1);self.log.borrow_mut().push("cleanup"); if self.cleanup_error { Err("cleanup failed".into()) } else { Ok((2,vec![])) } }
    }
    fn fake()->Fake { Fake { state:Cell::new(4),log:RefCell::new(vec![]),cleanup_error:false,stop_error:false } }
    #[test] fn printer_spooler_restart_sequence() { let f=fake(); let r=execute(&f,"restart",false).unwrap();assert_eq!(*f.log.borrow(),vec!["stop","start"]);assert_eq!(r.after.state,Some(4)); }
    #[test] fn printer_spooler_reset_confirmation() { let f=fake();assert!(execute(&f,"reset",false).is_err());assert!(f.log.borrow().is_empty()); }
    #[test] fn printer_spooler_reset_sequence() { let f=fake();let r=execute(&f,"reset",true).unwrap();assert_eq!(*f.log.borrow(),vec!["stop","cleanup","start"]);assert_eq!(r.removed_files,2); }
    #[test] fn printer_spooler_cleanup_failure_restarts() { let mut f=fake();f.cleanup_error=true;assert_eq!(execute(&f,"reset",true).unwrap().failed_files.len(),1);assert_eq!(f.state.get(),4); }
    #[test] fn printer_spooler_stop_failure_never_deletes() { let mut f=fake();f.stop_error=true;assert!(execute(&f,"reset",true).is_err());assert_eq!(*f.log.borrow(),vec!["stop"]); }
    #[test] fn printer_spooler_cleanup_extensions_only() { for p in ["a.SPL","b.shd"] { assert!(spool_file(Path::new(p))); } for p in ["a.exe","b.txt","c","folder"] { assert!(!spool_file(Path::new(p))); } }
}
