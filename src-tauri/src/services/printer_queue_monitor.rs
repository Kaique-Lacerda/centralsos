use crate::models::printer_diagnostic::QueueMonitorEvent;
use tauri::ipc::Channel;
#[cfg(windows)]
mod platform {
    use super::*;
    use std::{collections::HashMap,ffi::c_void,ptr,sync::{Arc,Mutex,OnceLock,atomic::{AtomicBool,AtomicU64,Ordering}}};
    static MONITORS:OnceLock<Mutex<HashMap<String,Arc<AtomicBool>>>>=OnceLock::new();
    static IDS:AtomicU64=AtomicU64::new(1);
    fn monitors()-> &'static Mutex<HashMap<String,Arc<AtomicBool>>> { MONITORS.get_or_init(||Mutex::new(HashMap::new())) }
    #[link(name="winspool")] extern "system" {
        fn OpenPrinterW(name:*const u16,handle:*mut *mut c_void,defaults:*const c_void)->i32;
        fn ClosePrinter(handle:*mut c_void)->i32;
        fn FindFirstPrinterChangeNotification(printer:*mut c_void,filter:u32,options:u32,info:*const c_void)->*mut c_void;
        fn FindNextPrinterChangeNotification(handle:*mut c_void,change:*mut u32,options:*const c_void,info:*mut *mut c_void)->i32;
        fn FindClosePrinterChangeNotification(handle:*mut c_void)->i32;
    }
    #[link(name="kernel32")] extern "system" { fn WaitForSingleObject(handle:*mut c_void,timeout:u32)->u32; fn GetLastError()->u32; }
    struct Printer(*mut c_void); impl Drop for Printer { fn drop(&mut self) { unsafe {ClosePrinter(self.0);} } }
    struct Notice(*mut c_void); impl Drop for Notice { fn drop(&mut self) { unsafe {FindClosePrinterChangeNotification(self.0);} } }
    fn watch(name:String,stop:Arc<AtomicBool>,channel:Channel<QueueMonitorEvent>)->Result<(),String> {
        let name:Vec<u16>=name.encode_utf16().chain(Some(0)).collect();let mut handle=ptr::null_mut();
        if unsafe {OpenPrinterW(name.as_ptr(),&mut handle,ptr::null())}==0 { return Err(format!("OpenPrinter: Windows {}",unsafe{GetLastError()})); }
        let printer=Printer(handle);
        let notification=unsafe{FindFirstPrinterChangeNotification(printer.0,0xff00|0xff,0,ptr::null())};
        if notification.is_null() || notification as isize == -1 { return Err(format!("Notificação nativa indisponível: Windows {}",unsafe{GetLastError()})); }
        let notification=Notice(notification);
        if channel.send(QueueMonitorEvent{mode:"native".into(),changed:false,detail:None}).is_err() { return Ok(()); }
        while !stop.load(Ordering::Relaxed) {
            match unsafe {WaitForSingleObject(notification.0,500)} {
                258=>continue,
                0=>{let mut change=0;if unsafe{FindNextPrinterChangeNotification(notification.0,&mut change,ptr::null(),ptr::null_mut())}==0 { return Err(format!("Notificação interrompida: Windows {}",unsafe{GetLastError()})); }
                    if channel.send(QueueMonitorEvent{mode:"native".into(),changed:true,detail:None}).is_err(){break;}
                },
                _=>return Err(format!("Espera de notificação falhou: Windows {}",unsafe{GetLastError()})),
            }
        }
        Ok(())
    }
    pub fn start(name:String,channel:Channel<QueueMonitorEvent>)->Result<String,String> {
        if name.trim().is_empty() || name.contains('\0') {return Err("Nome de impressora inválido.".into());}
        let id=IDS.fetch_add(1,Ordering::Relaxed).to_string();let stop=Arc::new(AtomicBool::new(false));
        {let mut all=monitors().lock().map_err(|e|e.to_string())?;if all.len()>=64{return Err("Limite de monitores atingido.".into());}all.insert(id.clone(),stop.clone());}
        let worker_id=id.clone();
        if let Err(error)=std::thread::Builder::new().name("printer-queue-monitor".into()).spawn(move||{
            if let Err(detail)=watch(name,stop,channel.clone()) {let _=channel.send(QueueMonitorEvent{mode:"polling".into(),changed:false,detail:Some(detail)});}
            if let Ok(mut all)=monitors().lock(){all.remove(&worker_id);}
        }) {if let Ok(mut all)=monitors().lock(){all.remove(&id);}return Err(error.to_string());}
        Ok(id)
    }
    pub fn stop(id:String)->Result<(),String>{if let Some(flag)=monitors().lock().map_err(|e|e.to_string())?.get(&id){flag.store(true,Ordering::Relaxed);}Ok(())}
    #[cfg(test)] mod tests {
        use super::*;
        #[test] fn printer_queue_monitor_rejects_invalid_name_without_native_call() {
            let channel=Channel::new(|_|Ok(()));assert!(start("bad\0name".into(),channel).is_err());
        }
        #[test]
        #[ignore="Assinatura nativa somente leitura no Windows real; sem gerar ou alterar jobs"]
        fn printer_queue_monitor_native_readonly() {
            let modes=Arc::new(Mutex::new(Vec::new()));let received=modes.clone();
            let channel=Channel::new(move|body|{if let tauri::ipc::InvokeResponseBody::Json(json)=body{received.lock().unwrap().push(json);}Ok(())});
            let id=start("Microsoft Print to PDF".into(),channel).unwrap();
            let deadline=std::time::Instant::now()+std::time::Duration::from_secs(3);
            while modes.lock().unwrap().is_empty() && std::time::Instant::now()<deadline {std::thread::sleep(std::time::Duration::from_millis(50));}
            stop(id.clone()).unwrap();
            let deadline=std::time::Instant::now()+std::time::Duration::from_secs(3);
            while monitors().lock().unwrap().contains_key(&id) && std::time::Instant::now()<deadline {std::thread::sleep(std::time::Duration::from_millis(50));}
            assert!(!monitors().lock().unwrap().contains_key(&id),"O monitor deve liberar o registro após o fechamento");
            let events=modes.lock().unwrap();println!("Eventos nativos somente leitura: {events:?}");
            assert!(events.iter().any(|json|json.contains("\"mode\":\"native\"")),"Notificação nativa não disponível nesta máquina");
        }
    }
}
#[cfg(windows)] pub use platform::{start,stop};
#[cfg(not(windows))] pub fn start(_:String,_:Channel<QueueMonitorEvent>)->Result<String,String>{Err("Exige Windows.".into())}
#[cfg(not(windows))] pub fn stop(_:String)->Result<(),String>{Ok(())}
