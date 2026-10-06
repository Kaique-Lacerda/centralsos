use crate::models::{machine::SnapshotCollection, printer_diagnostic::DiscoveredPrinter};

pub fn validate_unc(path: &str) -> Result<(), String> {
    if !path.starts_with("\\\\") || path.chars().count() > 512 || path.chars().any(|c| c.is_control() || matches!(c, '/' | '*' | '?' | '"' | '<' | '>' | '|' | ':')) {
        return Err("Informe um caminho válido: \\\\servidor\\impressora.".into());
    }
    let parts: Vec<_> = path[2..].split('\\').collect();
    if parts.len() != 2 || parts.iter().any(|p|p.trim().is_empty() || *p != p.trim() || matches!(*p, "." | "..")) {
        return Err("Informe um caminho válido: \\\\servidor\\impressora.".into());
    }
    Ok(())
}

#[derive(Debug, PartialEq)]
enum RemovalTarget { Connection, Local }
trait RemovalBackend {
    fn remove_connection(&mut self, name:&str)->Result<(),String>;
    fn remove_local(&mut self, name:&str)->Result<(),String>;
}
fn execute_removal(confirmed:bool,name:&str,state:&crate::models::printer_diagnostic::PrinterNativeState,connections:&[String],api:&mut impl RemovalBackend)->Result<(),String>{
    if !confirmed{return Err("Confirme a remoção desta impressora.".into());}
    match removal_target(name,state,connections)?{
        RemovalTarget::Connection=>api.remove_connection(name),
        RemovalTarget::Local=>api.remove_local(name),
    }
}
fn combine_discovery(results:Vec<Result<Vec<DiscoveredPrinter>,String>>)->SnapshotCollection<DiscoveredPrinter>{
    let mut items:Vec<DiscoveredPrinter>=Vec::new();let mut errors=Vec::new();
    for result in results {match result{Ok(rows)=>for row in rows{if !items.iter().any(|item|item.path.eq_ignore_ascii_case(&row.path)){items.push(row);}},Err(error)=>errors.push(error)}}
    SnapshotCollection{items,error:(!errors.is_empty()).then(||errors.join("; "))}
}
fn removal_target(name: &str, state: &crate::models::printer_diagnostic::PrinterNativeState, connections: &[String]) -> Result<RemovalTarget,String> {
    if state.attributes & 0x8000 != 0 { return Err("Remova a impressora redirecionada na sessão de origem.".into()); }
    if connections.iter().any(|connection| connection.eq_ignore_ascii_case(name)) { return Ok(RemovalTarget::Connection); }
    if name.starts_with("\\\\") || state.server.as_ref().is_some_and(|s|!s.is_empty()) || state.attributes & 0x40 == 0 {
        return Err("Não foi possível confirmar se esta fila é uma conexão do usuário. Nenhuma impressora foi removida.".into());
    }
    Ok(RemovalTarget::Local)
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::{ffi::c_void, mem::size_of, ptr};
    #[repr(C)] struct PrinterInfo1 { flags:u32, description:*const u16, name:*const u16, comment:*const u16 }
    #[repr(C)] struct PrinterDefaults { datatype:*const u16, devmode:*const c_void, access:u32 }
    #[link(name="winspool")]
    extern "system" {
        fn EnumPrintersW(flags:u32,name:*const u16,level:u32,buffer:*mut u8,size:u32,needed:*mut u32,count:*mut u32)->i32;
        fn AddPrinterConnectionW(name:*const u16)->i32;
        fn DeletePrinterConnectionW(name:*const u16)->i32;
        fn OpenPrinterW(name:*const u16,handle:*mut *mut c_void,defaults:*const c_void)->i32;
        fn DeletePrinter(handle:*mut c_void)->i32;
        fn ClosePrinter(handle:*mut c_void)->i32;
    }
    #[link(name="kernel32")] extern "system" {fn GetLastError()->u32;}
    fn wide(value:&str)->Vec<u16>{value.encode_utf16().chain(Some(0)).collect()}
    unsafe fn text(value:*const u16)->Option<String>{
        if value.is_null(){return None;}
        let mut len=0;while *value.add(len)!=0{len+=1;}
        let value=String::from_utf16_lossy(std::slice::from_raw_parts(value,len));
        (!value.is_empty()).then_some(value)
    }
    fn error(operation:&str)->String{format!("{operation} falhou (Windows {}).",unsafe{GetLastError()})}
    // NETWORK and REMOTE are supported only at Level 1. Never use Level 2 here.
    fn enumerate(flags:u32)->Result<Vec<DiscoveredPrinter>,String>{
        let mut needed=0;let mut count=0;
        let first=unsafe{EnumPrintersW(flags,ptr::null(),1,ptr::null_mut(),0,&mut needed,&mut count)};
        if first!=0&&needed==0{return Ok(Vec::new());}
        if first==0&&unsafe{GetLastError()}!=122{return Err(error("EnumPrinters"));}
        for _ in 0..3 {
            if needed==0||needed>32*1024*1024{return Err("Inventário de rede excede o limite seguro.".into());}
            let bytes=needed;let mut buffer=vec![0u64;(bytes as usize+7)/8];
            if unsafe{EnumPrintersW(flags,ptr::null(),1,buffer.as_mut_ptr() as *mut u8,bytes,&mut needed,&mut count)}==0 {
                if unsafe{GetLastError()}==122{continue;}return Err(error("EnumPrinters"));
            }
            if count as usize>bytes as usize/size_of::<PrinterInfo1>(){return Err("Inventário de rede inválido.".into());}
            let rows=unsafe{std::slice::from_raw_parts(buffer.as_ptr() as *const PrinterInfo1,count as usize)};
            return Ok(rows.iter().filter_map(|row|{
                if row.flags&0x800000!=0{return None;} // container/provider, not a printer
                let path=unsafe{text(row.name)}?;validate_unc(&path).ok()?;
                let mut parts=path[2..].split('\\');let server=parts.next()?.to_string();let name=parts.next()?.to_string();
                Some(DiscoveredPrinter{name,server,path,description:unsafe{text(row.comment)}.or_else(||unsafe{text(row.description)})})
            }).collect());
        }
        Err("A lista de impressoras mudou durante a consulta. Tente novamente.".into())
    }
    pub fn discover()->SnapshotCollection<DiscoveredPrinter>{
        let mut results=Vec::new();
        for flags in [0x40,0x10,4] { results.push(enumerate(flags)); }
        combine_discovery(results)
    }
    pub fn add(path:String)->Result<(),String>{
        validate_unc(&path)?;
        crate::services::printer_management::require_elevation()?;
        if unsafe{AddPrinterConnectionW(wide(&path).as_ptr())}==0{return Err(error("AddPrinterConnection"));}Ok(())
    }
    pub fn remove(name:String,confirmed:bool)->Result<(),String>{
        if !confirmed{return Err("Confirme a remoção desta impressora.".into());}
        if name.trim().is_empty()||name.chars().count()>512||name.chars().any(char::is_control){return Err("Selecione uma impressora válida.".into());}
        crate::services::printer_management::require_elevation()?;
        let state=crate::services::printer_management::native_state(name.clone())?;
        let connections=enumerate(4)?.into_iter().map(|p|p.path).collect::<Vec<_>>();
        struct NativeRemoval;
        impl RemovalBackend for NativeRemoval {
            fn remove_connection(&mut self,name:&str)->Result<(),String>{
                if unsafe{DeletePrinterConnectionW(wide(&name).as_ptr())}==0{return Err(error("DeletePrinterConnection"));}
                Ok(())
            }
            fn remove_local(&mut self,name:&str)->Result<(),String>{
                // DELETE plus ADMINISTER rights to the selected local object only.
                let defaults=PrinterDefaults{datatype:ptr::null(),devmode:ptr::null(),access:0x10000|4};
                let mut raw=ptr::null_mut();
                if unsafe{OpenPrinterW(wide(&name).as_ptr(),&mut raw,&defaults as *const PrinterDefaults as *const c_void)}==0{return Err(error("OpenPrinter"));}
                struct Handle(*mut c_void);impl Drop for Handle{fn drop(&mut self){unsafe{ClosePrinter(self.0);}}}
                let handle=Handle(raw);
                if unsafe{DeletePrinter(handle.0)}==0{return Err(error("DeletePrinter"));}
                Ok(())
            }
        }
        // No DeletePrinterDriver / DeletePort, no other queue is touched.
        execute_removal(confirmed,&name,&state,&connections,&mut NativeRemoval)
    }
}

#[cfg(windows)] pub use platform::{add,remove};
#[cfg(not(windows))] pub fn add(_:String)->Result<(),String>{Err("Exige Desktop Windows.".into())}
#[cfg(not(windows))] pub fn remove(_:String,_:bool)->Result<(),String>{Err("Exige Desktop Windows.".into())}

#[cfg(windows)]
pub fn discover()->Result<SnapshotCollection<DiscoveredPrinter>,String>{
    use std::sync::{atomic::{AtomicBool,Ordering},mpsc};
    static SEARCHING:AtomicBool=AtomicBool::new(false);
    if SEARCHING.swap(true,Ordering::AcqRel){return Err("Uma busca de rede ainda está em andamento. Aguarde antes de tentar novamente.".into());}
    let (send,receive)=mpsc::channel();
    let worker=std::thread::Builder::new().name("printer-network-discovery".into()).spawn(move||{
        struct Permit;impl Drop for Permit{fn drop(&mut self){SEARCHING.store(false,Ordering::Release);}}
        let _permit=Permit;let _=send.send(platform::discover());
    });
    if worker.is_err(){SEARCHING.store(false,Ordering::Release);return Err("Não foi possível iniciar a busca de rede.".into());}
    receive.recv_timeout(std::time::Duration::from_secs(30)).map_err(|_|"A busca de rede excedeu 30 segundos. O provider do Windows pode continuar ocupado; use Adicionar por caminho.".into())
}
#[cfg(not(windows))] pub fn discover()->Result<SnapshotCollection<DiscoveredPrinter>,String>{Err("Exige Desktop Windows.".into())}

#[cfg(test)]
mod tests {
    use super::*;
    fn state()->crate::models::printer_diagnostic::PrinterNativeState{
        crate::models::printer_diagnostic::PrinterNativeState{name:"Local".into(),port:Some("USB001".into()),driver:Some("Preserved".into()),server:None,share_name:None,attributes:0x40,status_bits:0,job_count:0}
    }
    #[test] fn unc_validation(){
        for path in ["\\\\SERVER\\Printer","\\\\192.168.1.25\\HP Financeiro"]{assert!(validate_unc(path).is_ok());}
        for path in ["","\\SERVER\\Printer","\\\\SERVER","\\\\SERVER\\Printer\\file","\\\\SERVER\\","\\\\.\\Printer","\\\\SERVER\\..","\\\\SERVER\\Print\0"]{assert!(validate_unc(path).is_err());}
    }
    #[test] fn removes_only_confirmed_user_connection_or_local_object(){
        let local=state();assert_eq!(removal_target("Local",&local,&[]).unwrap(),RemovalTarget::Local);
        let mut remote=state();remote.server=Some("\\\\SERVER".into());remote.attributes=0x10;
        assert_eq!(removal_target("\\\\SERVER\\HP",&remote,&["\\\\server\\hp".into()]).unwrap(),RemovalTarget::Connection);
        assert!(removal_target("\\\\SERVER\\HP",&remote,&[]).is_err());
        remote.attributes=0x8000;assert!(removal_target("Remote",&remote,&[]).is_err());
        assert_eq!(local.driver.as_deref(),Some("Preserved"));assert_eq!(local.port.as_deref(),Some("USB001"));
    }
    #[test] fn removal_dispatch_uses_mocks_not_real_printers(){
        struct Mock { calls:Vec<String> }
        impl RemovalBackend for Mock{
            fn remove_connection(&mut self,name:&str)->Result<(),String>{self.calls.push(format!("connection:{name}"));Ok(())}
            fn remove_local(&mut self,name:&str)->Result<(),String>{self.calls.push(format!("local:{name}"));Ok(())}
        }
        let local=state();let mut api=Mock{calls:Vec::new()};
        assert!(execute_removal(false,"Local",&local,&[],&mut api).is_err());assert!(api.calls.is_empty());
        execute_removal(true,"Local",&local,&[],&mut api).unwrap();
        let mut remote=state();remote.attributes=0x10;remote.server=Some("\\\\SERVER".into());
        execute_removal(true,"\\\\SERVER\\HP",&remote,&["\\\\SERVER\\HP".into()],&mut api).unwrap();
        assert!(execute_removal(true,"\\\\OTHER\\HP",&remote,&[],&mut api).is_err());
        assert_eq!(api.calls,vec!["local:Local","connection:\\\\SERVER\\HP"]);
        assert_eq!(local.driver.as_deref(),Some("Preserved"));assert_eq!(local.port.as_deref(),Some("USB001"));
    }
    #[test] fn discovery_empty_partial_and_duplicate_results(){
        assert!(combine_discovery(vec![Ok(vec![])]).items.is_empty());
        let row=DiscoveredPrinter{name:"HP".into(),server:"SERVER".into(),path:"\\\\SERVER\\HP".into(),description:None};
        let result=combine_discovery(vec![Ok(vec![row.clone()]),Err("Provider indisponível".into()),Ok(vec![row])]);
        assert_eq!(result.items.len(),1);assert_eq!(result.error.as_deref(),Some("Provider indisponível"));
    }
}
