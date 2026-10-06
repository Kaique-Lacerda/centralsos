use crate::models::{machine::SnapshotCollection, printer_diagnostic::*};
#[cfg(windows)]
#[path = "printer_devices.rs"]
mod present_devices;

#[cfg(windows)]
mod platform {
    use super::*;
    use std::{ffi::c_void, ptr, mem::size_of, net::{TcpStream, ToSocketAddrs}, time::Duration};
    use wmi::WMIConnection;
    #[repr(C)]
    struct PortInfo2 { name: *const u16, monitor: *const u16, description: *const u16, port_type: u32, reserved: u32 }
    #[repr(C)]
    struct DriverInfo6 {
        version: u32, name: *const u16, environment: *const u16, driver_path: *const u16, data: *const u16, config: *const u16,
        help: *const u16, dependent: *const u16, monitor: *const u16, datatype: *const u16, previous: *const u16,
        date: u64, driver_version: u64, manufacturer: *const u16, oem: *const u16, hardware_id: *const u16, provider: *const u16,
    }
    #[link(name = "winspool")]
    extern "system" {
        fn EnumPortsW(server: *const u16, level: u32, buffer: *mut u8, size: u32, needed: *mut u32, count: *mut u32) -> i32;
        fn OpenPrinterW(name: *const u16, handle: *mut *mut c_void, defaults: *const c_void) -> i32;
        fn ClosePrinter(handle: *mut c_void) -> i32;
        fn GetPrinterDriverW(handle: *mut c_void, environment: *const u16, level: u32, buffer: *mut u8, size: u32, needed: *mut u32) -> i32;
    }
    #[link(name = "kernel32")] extern "system" { fn GetLastError() -> u32; }
    fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain(Some(0)).collect() }
    unsafe fn text(s: *const u16) -> Option<String> {
        if s.is_null() { return None; } let mut len = 0;
        while *s.add(len) != 0 { len += 1; }
        let result = String::from_utf16_lossy(std::slice::from_raw_parts(s, len));
        (!result.trim().is_empty()).then_some(result)
    }
    pub fn enumerate_ports(server: Option<&str>) -> Result<Vec<PrintPort>, String> {
        let server = server.map(wide); let server = server.as_ref().map_or(ptr::null(), |s| s.as_ptr());
        let mut needed = 0; let mut count = 0;
        let first = unsafe { EnumPortsW(server, 2, ptr::null_mut(), 0, &mut needed, &mut count) };
        if first != 0 && needed == 0 { return Ok(Vec::new()); }
        if needed == 0 { return Err(format!("EnumPorts não retornou o inventário (Windows {}).", unsafe { GetLastError() })); }
        let mut data = vec![0u64; (needed as usize + 7) / 8];
        if unsafe { EnumPortsW(server, 2, data.as_mut_ptr() as *mut u8, needed, &mut needed, &mut count) } == 0 {
            return Err(format!("Não foi possível listar portas do servidor da impressora (Windows {}).", unsafe { GetLastError() }));
        }
        let rows = unsafe { std::slice::from_raw_parts(data.as_ptr() as *const PortInfo2, count as usize) };
        Ok(rows.iter().filter_map(|r| Some(PrintPort { name: unsafe { text(r.name) }?, monitor: unsafe { text(r.monitor) }, description: unsafe { text(r.description) }, port_type: r.port_type })).collect())
    }
    fn get_driver(name: &str) -> Result<PrintDriver, PrintQueryError> {
        struct Handle(*mut c_void); impl Drop for Handle { fn drop(&mut self) { unsafe { ClosePrinter(self.0); } } }
        let error = || { let code = unsafe { GetLastError() }; PrintQueryError { code, message: format!("GetPrinterDriver falhou (Windows {code}).") } };
        let mut handle = ptr::null_mut();
        if unsafe { OpenPrinterW(wide(name).as_ptr(), &mut handle, ptr::null()) } == 0 { return Err(error()); }
        let handle = Handle(handle); let mut needed = 0;
        unsafe { GetPrinterDriverW(handle.0, ptr::null(), 6, ptr::null_mut(), 0, &mut needed); }
        if needed < size_of::<DriverInfo6>() as u32 { return Err(error()); }
        let mut data = vec![0u64; (needed as usize + 7) / 8];
        if unsafe { GetPrinterDriverW(handle.0, ptr::null(), 6, data.as_mut_ptr() as *mut u8, needed, &mut needed) } == 0 { return Err(error()); }
        let row = unsafe { &*(data.as_ptr() as *const DriverInfo6) };
        Ok(PrintDriver { name: unsafe { text(row.name) }, environment: unsafe { text(row.environment) },
            version: (row.driver_version != 0).then(|| format!("{}.{}.{}.{}", row.driver_version >> 48, (row.driver_version >> 32) & 0xffff, (row.driver_version >> 16) & 0xffff, row.driver_version & 0xffff)),
            hardware_id: unsafe { text(row.hardware_id) }, provider: unsafe { text(row.provider) } })
    }
    fn serial() -> Result<Vec<SerialPrintDevice>, String> {
        WMIConnection::new().map_err(|e| e.to_string())?.raw_query("SELECT DeviceID, Name, Description, PNPDeviceID, Status, ConfigManagerErrorCode FROM Win32_SerialPort").map_err(|e| e.to_string())
    }
    fn tcp() -> Result<Vec<TcpPrintPort>, String> {
        WMIConnection::new().map_err(|e| e.to_string())?.raw_query("SELECT Name, HostAddress, PortNumber, Protocol, Queue, SNMPEnabled, Status FROM Win32_TCPIPPrinterPort").map_err(|e| e.to_string())
    }
    fn collection<T>(result: Result<Vec<T>, String>) -> SnapshotCollection<T> {
        match result { Ok(items) => SnapshotCollection { items, error: None }, Err(error) => SnapshotCollection { items: Vec::new(), error: Some(error) } }
    }
    pub fn diagnose(name: String) -> Result<PrinterDiagnosticSnapshot, String> {
        // WQL values are escaped, never interpolated as executable commands.
        let escaped_name = name.replace('\\', "\\\\").replace('\'', "\\'");
        let device_status = WMIConnection::new().map_err(|e|e.to_string()).and_then(|connection|
            connection.raw_query::<PrinterDeviceStatus>(&format!("SELECT DetectedErrorState, ExtendedDetectedErrorState, ExtendedPrinterStatus FROM Win32_Printer WHERE Name = '{escaped_name}'")).map_err(|e|e.to_string()));
        let (device_status, device_status_error) = match device_status {
            Ok(mut rows) if rows.len() == 1 => (rows.pop(), None),
            Ok(_) => (None, Some("Estado WMI não determinado para esta impressora.".into())),
            Err(error) => (None, Some(error)),
        };
        let state = crate::services::printer_management::native_state(name.clone());
        let server = state.as_ref().ok().and_then(|p| p.server.as_deref()).filter(|s| !s.trim().is_empty());
        let remote = server.is_some() || name.starts_with("\\\\");
        let ports = if state.is_ok() { collection(enumerate_ports(server)) } else { collection(Err("A impressora não pôde ser aberta; o servidor das portas não foi determinado.".into())) };
        let redirected=state.as_ref().is_ok_and(|p|p.attributes&0x8000!=0);
        let local_hardware=!(remote||redirected);
        let serial = if !local_hardware { collection(Err("Dispositivos seriais locais não confirmam o hardware de uma fila remota/redirecionada.".into())) } else { collection(serial()) };
        let present_devices=if local_hardware {super::present_devices::collect()} else {
            PrinterPresentDevices {com:collection(Err("Presença local não aplicável a fila remota/redirecionada.".into())),usb:collection(Err("Presença local não aplicável a fila remota/redirecionada.".into()))}
        };
        let tcp = if !local_hardware { collection(Err("Configuração TCP/IP de fila remota/redirecionada não é verificável localmente.".into())) } else { collection(tcp()) };
        let (driver, driver_error) = match get_driver(&name) { Ok(d) => (Some(d), None), Err(e) => (None, Some(e)) };
        Ok(PrinterDiagnosticSnapshot { device_status, device_status_error, printer_error: state.as_ref().err().cloned(), printer: state.ok(), ports, serial, tcp, present_devices, driver, driver_error,
            queue: collection(crate::services::printer_operations::get_printer_queue(name)), spooler: crate::services::printer_spooler::snapshot(),
            is_elevated: crate::services::printer_management::elevated_context().unwrap_or(false) })
    }
    pub fn probe(name: String) -> Result<TcpPrintProbe, String> {
        let state = crate::services::printer_management::native_state(name)?;
        if state.server.is_some()||state.attributes&0x8000!=0 { return Err("O endpoint TCP de uma fila remota/redirecionada não foi determinado localmente.".into()); }
        let port_name = state.port.ok_or("A porta não foi informada.")?;
        let row = tcp()?.into_iter().find(|p| p.name.eq_ignore_ascii_case(&port_name)).ok_or("Não há configuração TCP/IP correspondente à porta selecionada.")?;
        if !matches!(row.protocol, Some(1 | 2)) { return Err("Protocolo TCP/IP não determinado; nenhum teste foi realizado.".into()); }
        let host = row.host_address.ok_or("Endereço TCP não informado.")?; let port = row.port_number.ok_or("Número da porta TCP não informado.")?;
        let addresses: Vec<_> = (host.as_str(), port).to_socket_addrs().map_err(|e| format!("Não foi possível resolver o endereço configurado: {e}"))?.take(4).collect();
        let reachable = addresses.iter().any(|address| TcpStream::connect_timeout(address, Duration::from_secs(1)).is_ok());
        Ok(TcpPrintProbe { host, port, reachable, detail: if reachable { "Conexão TCP estabelecida; isso não confirma impressão ou disponibilidade física." } else { "Não foi possível estabelecer TCP; isso não é prova de que a impressora está offline." }.into() })
    }
}
#[cfg(windows)] pub use platform::{diagnose, enumerate_ports, probe};
#[cfg(not(windows))] pub fn diagnose(_: String) -> Result<PrinterDiagnosticSnapshot, String> { Err("Exige Desktop Windows.".into()) }
#[cfg(not(windows))] pub fn enumerate_ports(_: Option<&str>) -> Result<Vec<PrintPort>, String> { Err("Exige Desktop Windows.".into()) }
#[cfg(not(windows))] pub fn probe(_: String) -> Result<TcpPrintProbe, String> { Err("Exige Desktop Windows.".into()) }

#[cfg(all(test,windows))]
mod tests {
    use super::*;
    #[test]
    fn printer_diagnostics_ipc_contracts() {
        // Exercise the actual Tauri serializer without adding a JSON dependency.
        let serial=SerialPrintDevice {device_id:Some("COM4".into()),name:None,description:None,pnp_device_id:Some("USB\\VID_1234&PID_ABCD".into()),status:Some("OK".into()),config_manager_error_code:Some(0)};
        let channel=tauri::ipc::Channel::new(|body|{if let tauri::ipc::InvokeResponseBody::Json(json)=body {assert!(json.contains("\"deviceId\":\"COM4\""));assert!(json.contains("\"configManagerErrorCode\":0"));assert!(json.contains("\"pnpDeviceId\""));}else{panic!("Expected JSON");}Ok(())});
        channel.send(serial).unwrap();
        let device=PresentPrintDevice {port_name:Some("COM4".into()),friendly_name:None,instance_id:Some("USB\\REAL".into()),status_flags:Some(8),config_manager_error_code:Some(0),query_error:None};
        let channel=tauri::ipc::Channel::new(|body|{if let tauri::ipc::InvokeResponseBody::Json(json)=body {assert!(json.contains("\"portName\":\"COM4\""));assert!(json.contains("\"instanceId\""));assert!(json.contains("\"configManagerErrorCode\":0"));assert!(json.contains("\"queryError\":null"));}else{panic!("Expected JSON");}Ok(())});channel.send(device).unwrap();
        let tcp=TcpPrintPort {name:"Actual".into(),host_address:Some("10.0.0.5".into()),port_number:Some(515),protocol:Some(2),queue:Some("queue".into()),snmp_enabled:Some(false),status:None};
        let channel=tauri::ipc::Channel::new(|body|{if let tauri::ipc::InvokeResponseBody::Json(json)=body {assert!(json.contains("\"portNumber\":515"));assert!(json.contains("\"snmpEnabled\":false"));}else{panic!("Expected JSON");}Ok(())});channel.send(tcp).unwrap();
    }
    #[test]
    #[ignore = "Consulta somente leitura ao Windows real; executada explicitamente, não altera filas"]
    fn printer_diagnostics_readonly_windows() {
        #[derive(serde::Deserialize)] #[serde(rename_all="PascalCase")] struct Row { name:String }
        let rows:Vec<Row>=wmi::WMIConnection::new().unwrap().raw_query("SELECT Name FROM Win32_Printer").unwrap();
        let spooler=crate::services::printer_spooler::snapshot();println!("Spooler real: {spooler:?}");
        let mut queried=0;
        for row in rows.into_iter().take(3) {
            let result=diagnose(row.name).unwrap();
            assert!(result.printer.is_some()||result.printer_error.is_some());
            println!("Impressora real: {:?}; portas: {}; serial: {}; TCP: {}; driver: {:?}; erro: {:?}",result.printer,result.ports.items.len(),result.serial.items.len(),result.tcp.items.len(),result.driver,result.printer_error);
            let channel=tauri::ipc::Channel::new(|body|{if let tauri::ipc::InvokeResponseBody::Json(json)=body {println!("PRINTER_READONLY_JSON: {json}");}Ok(())});channel.send(result).unwrap();
            queried+=1;
        }
        println!("Filas consultadas sem alterações: {queried}");
    }
}
