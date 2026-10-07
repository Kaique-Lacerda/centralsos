#[cfg(all(test,windows))]
mod tests {
    use crate::models::printer_diagnostic::*;
    use crate::services::printer_diagnostics::diagnose;
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
