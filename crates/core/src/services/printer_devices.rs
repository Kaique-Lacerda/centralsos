// Read-only SetupAPI inventory. EnumPorts is deliberately not used as evidence
// of hardware presence. No device is opened, reset, installed or reconfigured.
use crate::models::{machine::SnapshotCollection, printer_diagnostic::{PresentPrintDevice, PrinterPresentDevices}};
use std::{ffi::c_void, mem::size_of, ptr};

#[repr(C)]
struct Guid { data1:u32, data2:u16, data3:u16, data4:[u8;8] }
#[repr(C)]
struct DeviceInfo { size:u32, class_guid:Guid, dev_inst:u32, reserved:usize }
const COMPORT:Guid=Guid {data1:0x86e0d1e0,data2:0x8089,data3:0x11d0,data4:[0x9c,0xe4,0x08,0x00,0x3e,0x30,0x1f,0x73]};
const USBPRINT:Guid=Guid {data1:0x28d78fad,data2:0x5a12,data3:0x11d1,data4:[0xae,0x5b,0,0,0xf8,0x03,0xa8,0xc2]};
const PRESENT_INTERFACES:u32=0x02|0x10; // DIGCF_PRESENT | DIGCF_DEVICEINTERFACE
#[link(name="setupapi")]
extern "system" {
    fn SetupDiGetClassDevsW(class:*const Guid,enumerator:*const u16,parent:*mut c_void,flags:u32)->*mut c_void;
    fn SetupDiEnumDeviceInfo(set:*mut c_void,index:u32,info:*mut DeviceInfo)->i32;
    fn SetupDiDestroyDeviceInfoList(set:*mut c_void)->i32;
    fn SetupDiGetDeviceRegistryPropertyW(set:*mut c_void,info:*mut DeviceInfo,property:u32,kind:*mut u32,buffer:*mut u8,size:u32,needed:*mut u32)->i32;
    fn SetupDiGetDeviceInstanceIdW(set:*mut c_void,info:*mut DeviceInfo,buffer:*mut u16,size:u32,needed:*mut u32)->i32;
    fn SetupDiOpenDevRegKey(set:*mut c_void,info:*mut DeviceInfo,scope:u32,profile:u32,key_type:u32,access:u32)->*mut c_void;
}
#[link(name="advapi32")]
extern "system" {
    fn RegQueryValueExW(key:*mut c_void,name:*const u16,reserved:*mut u32,kind:*mut u32,buffer:*mut u8,size:*mut u32)->i32;
    fn RegCloseKey(key:*mut c_void)->i32;
}
#[link(name="cfgmgr32")]
extern "system" {fn CM_Get_DevNode_Status(status:*mut u32,problem:*mut u32,dev_inst:u32,flags:u32)->u32;}
#[link(name="kernel32")]
extern "system" {fn GetLastError()->u32;}
struct InfoSet(*mut c_void);
impl Drop for InfoSet {fn drop(&mut self){unsafe{SetupDiDestroyDeviceInfoList(self.0);}}}
struct RegistryKey(*mut c_void);
impl Drop for RegistryKey {fn drop(&mut self){unsafe{RegCloseKey(self.0);}}}
fn decoded(data:&[u16])->Option<String> {
    let end=data.iter().position(|v|*v==0).unwrap_or(data.len());
    let value=String::from_utf16_lossy(&data[..end]);(!value.trim().is_empty()).then_some(value)
}
fn property(set:*mut c_void,info:&mut DeviceInfo,id:u32)->Option<String> {
    let mut kind=0;let mut needed=0;
    unsafe{SetupDiGetDeviceRegistryPropertyW(set,info,id,&mut kind,ptr::null_mut(),0,&mut needed);}
    if needed<2||needed>16384{return None;}
    let mut data=vec![0u16;(needed as usize+1)/2];
    if unsafe{SetupDiGetDeviceRegistryPropertyW(set,info,id,&mut kind,data.as_mut_ptr().cast(),(data.len()*2) as u32,&mut needed)}==0||kind!=1{return None;}
    decoded(&data)
}
fn instance_id(set:*mut c_void,info:&mut DeviceInfo)->Option<String> {
    let mut needed=0;
    unsafe{SetupDiGetDeviceInstanceIdW(set,info,ptr::null_mut(),0,&mut needed);}
    if needed==0||needed>8192{return None;}
    let mut data=vec![0u16;needed as usize];
    if unsafe{SetupDiGetDeviceInstanceIdW(set,info,data.as_mut_ptr(),data.len() as u32,&mut needed)}==0{return None;}
    decoded(&data)
}
fn port_name(set:*mut c_void,info:&mut DeviceInfo)->Result<String,String> {
    // DICS_FLAG_GLOBAL, DIREG_DEV, KEY_QUERY_VALUE: never create/write a key.
    let key=unsafe{SetupDiOpenDevRegKey(set,info,1,0,1,1)};
    if key as isize == -1{return Err(format!("PortName não consultável (Windows {}).",unsafe{GetLastError()}));}
    let key=RegistryKey(key);let name:Vec<u16>="PortName".encode_utf16().chain(Some(0)).collect();let mut kind=0;let mut size=0;
    let code=unsafe{RegQueryValueExW(key.0,name.as_ptr(),ptr::null_mut(),&mut kind,ptr::null_mut(),&mut size)};
    if code!=0||kind!=1||size<2||size>16384{return Err(format!("PortName não determinado (Windows {code})."));}
    let mut data=vec![0u16;(size as usize+1)/2];size=(data.len()*2) as u32;
    let code=unsafe{RegQueryValueExW(key.0,name.as_ptr(),ptr::null_mut(),&mut kind,data.as_mut_ptr().cast(),&mut size)};
    if code!=0||kind!=1{return Err(format!("PortName não determinado (Windows {code})."));}
    decoded(&data).ok_or_else(||"PortName vazio.".into())
}
fn enumerate(class:&Guid,is_com:bool)->Result<Vec<PresentPrintDevice>,String> {
    let set=unsafe{SetupDiGetClassDevsW(class,ptr::null(),ptr::null_mut(),PRESENT_INTERFACES)};
    if set as isize == -1{return Err(format!("SetupAPI DIGCF_PRESENT falhou (Windows {}).",unsafe{GetLastError()}));}
    let set=InfoSet(set);let mut devices=Vec::new();
    for index in 0..4096 {
        let mut info:DeviceInfo=unsafe{std::mem::zeroed()};info.size=size_of::<DeviceInfo>() as u32;
        if unsafe{SetupDiEnumDeviceInfo(set.0,index,&mut info)}==0 {
            let code=unsafe{GetLastError()};return if code==259{Ok(devices)}else{Err(format!("Enumeração SetupAPI incompleta (Windows {code})."))};
        }
        let friendly_name=property(set.0,&mut info,12).or_else(||property(set.0,&mut info,0));
        let instance_id=instance_id(set.0,&mut info);
        let (port_name,mut errors)=if is_com {match port_name(set.0,&mut info){Ok(value)=>(Some(value),Vec::new()),Err(error)=>(None,vec![error])}}else{(None,Vec::new())};
        let mut flags=0;let mut problem=0;let code=unsafe{CM_Get_DevNode_Status(&mut flags,&mut problem,info.dev_inst,0)};
        if code!=0{errors.push(format!("Estado ConfigManager não verificável ({code})."));}
        devices.push(PresentPrintDevice {port_name,friendly_name,instance_id,status_flags:(code==0).then_some(flags),
            config_manager_error_code:(code==0).then_some(if flags&0x400!=0{problem}else{0}),query_error:(!errors.is_empty()).then(||errors.join(" "))});
    }
    Err("Limite de enumeração SetupAPI atingido; presença não determinada.".into())
}
fn collection(result:Result<Vec<PresentPrintDevice>,String>)->SnapshotCollection<PresentPrintDevice>{
    match result{Ok(items)=>SnapshotCollection{items,error:None},Err(error)=>SnapshotCollection{items:Vec::new(),error:Some(error)}}
}
pub fn collect()->PrinterPresentDevices {
    PrinterPresentDevices{com:collection(enumerate(&COMPORT,true)),usb:collection(enumerate(&USBPRINT,false))}
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn printer_presence_native_contract_and_flags(){
        assert_eq!(PRESENT_INTERFACES,0x12);
        assert_eq!(size_of::<DeviceInfo>(),if cfg!(target_pointer_width="64"){32}else{28});
        assert_eq!(decoded(&[67,79,77,52,0,99]).as_deref(),Some("COM4"));
        assert_eq!(decoded(&[0]),None);
    }
    #[test]
    #[ignore="Inventário SetupAPI somente leitura no Windows real; não abre nem modifica dispositivos"]
    fn printer_presence_readonly_windows(){
        let result=collect();println!("SetupAPI DIGCF_PRESENT: {result:?}");
        assert!(result.com.error.is_none(),"{:?}",result.com.error);
        assert!(result.usb.error.is_none(),"{:?}",result.usb.error);
    }
}
