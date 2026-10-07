use crate::models::printer_operation::{PrintJobSnapshot, PrinterQueueActionResult};

#[cfg(windows)]
mod platform {
    use super::{PrintJobSnapshot, PrinterQueueActionResult};
    use serde::Deserialize;
    use std::{ffi::c_void, mem::size_of, ptr, slice};
    use wmi::WMIConnection;

    const ERROR_INSUFFICIENT_BUFFER: u32 = 122;
    const ERROR_ACCESS_DENIED: u32 = 5;
    const ERROR_PRINTER_NOT_FOUND: u32 = 1801;
    const ERROR_INVALID_PRINTER_NAME: u32 = 1802;
    const JOB_CONTROL_DELETE: u32 = 5;
    const PRINTER_CONTROL_PAUSE: u32 = 1;
    const PRINTER_CONTROL_RESUME: u32 = 2;
    const PRINTER_ACCESS_ADMINISTER: u32 = 0x4;

    #[repr(C)]
    struct PrinterDefaultsW { datatype: *mut u16, devmode: *mut c_void, desired_access: u32 }

    #[repr(C)]
    struct SystemTime {
        year: u16,
        month: u16,
        day_of_week: u16,
        day: u16,
        hour: u16,
        minute: u16,
        second: u16,
        milliseconds: u16,
    }

    #[repr(C)]
    struct JobInfo2W {
        job_id: u32,
        printer_name: *mut u16,
        machine_name: *mut u16,
        user_name: *mut u16,
        document: *mut u16,
        notify_name: *mut u16,
        datatype: *mut u16,
        print_processor: *mut u16,
        parameters: *mut u16,
        driver_name: *mut u16,
        dev_mode: *mut c_void,
        status_text: *mut u16,
        security_descriptor: *mut c_void,
        status: u32,
        priority: u32,
        position: u32,
        start_time: u32,
        until_time: u32,
        total_pages: u32,
        size: u32,
        submitted: SystemTime,
        elapsed_time: u32,
        pages_printed: u32,
    }

    #[repr(C)]
    struct DocInfoW {
        size: i32,
        document_name: *const u16,
        output_file: *const u16,
        datatype: *const u16,
        flags: u32,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "PascalCase")]
    struct PrinterStatusRow {
        printer_status: Option<u16>,
    }

    #[link(name = "winspool")]
    extern "system" {
        fn OpenPrinterW(name: *const u16, printer: *mut *mut c_void, defaults: *const c_void) -> i32;
        fn ClosePrinter(printer: *mut c_void) -> i32;
        fn EnumJobsW(
            printer: *mut c_void,
            first_job: u32,
            no_jobs: u32,
            level: u32,
            jobs: *mut u8,
            buffer_size: u32,
            bytes_needed: *mut u32,
            jobs_returned: *mut u32,
        ) -> i32;
        fn SetJobW(printer: *mut c_void, job_id: u32, level: u32, job: *const c_void, command: u32) -> i32;
        fn SetPrinterW(printer: *mut c_void, level: u32, printer_info: *const u8, command: u32) -> i32;
    }

    #[link(name = "gdi32")]
    extern "system" {
        fn CreateDCW(driver: *const u16, device: *const u16, port: *const u16, devmode: *const c_void) -> *mut c_void;
        fn DeleteDC(dc: *mut c_void) -> i32;
        fn StartDocW(dc: *mut c_void, doc_info: *const DocInfoW) -> i32;
        fn StartPage(dc: *mut c_void) -> i32;
        fn EndPage(dc: *mut c_void) -> i32;
        fn EndDoc(dc: *mut c_void) -> i32;
        fn AbortDoc(dc: *mut c_void) -> i32;
        fn TextOutW(dc: *mut c_void, x: i32, y: i32, text: *const u16, count: i32) -> i32;
        fn GetDeviceCaps(dc: *mut c_void, index: i32) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetLastError() -> u32;
    }

    struct PrinterHandle(*mut c_void);
    impl Drop for PrinterHandle {
        fn drop(&mut self) {
            unsafe { ClosePrinter(self.0); }
        }
    }

    struct DeviceContext(*mut c_void);
    impl Drop for DeviceContext {
        fn drop(&mut self) {
            unsafe { DeleteDC(self.0); }
        }
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn optional_wide(value: *const u16) -> Option<String> {
        if value.is_null() {
            return None;
        }
        let mut length = 0;
        unsafe {
            while *value.add(length) != 0 {
                length += 1;
            }
            let content = slice::from_raw_parts(value, length);
            let text = String::from_utf16_lossy(content).trim().to_owned();
            (!text.is_empty()).then_some(text)
        }
    }

    fn open_printer(printer_name: &str) -> Result<PrinterHandle, String> {
        let name = wide(printer_name);
        let mut handle = ptr::null_mut();
        if unsafe { OpenPrinterW(name.as_ptr(), &mut handle, ptr::null()) } == 0 {
            return Err(map_printer_error(unsafe { GetLastError() }));
        }
        Ok(PrinterHandle(handle))
    }

    fn open_printer_with_access(printer_name: &str, desired_access: u32) -> Result<PrinterHandle, String> {
        let name = wide(printer_name);
        let defaults = PrinterDefaultsW { datatype: ptr::null_mut(), devmode: ptr::null_mut(), desired_access };
        let mut handle = ptr::null_mut();
        if unsafe { OpenPrinterW(name.as_ptr(), &mut handle, &defaults as *const _ as *const c_void) } == 0 {
            return Err(map_printer_error(unsafe { GetLastError() }));
        }
        Ok(PrinterHandle(handle))
    }

    fn map_printer_error(code: u32) -> String {
        match code {
            ERROR_PRINTER_NOT_FOUND => "A impressora não foi encontrada.".into(),
            ERROR_INVALID_PRINTER_NAME => "A impressora não foi encontrada.".into(),
            ERROR_ACCESS_DENIED => "O Windows negou acesso à impressora.".into(),
            1722 => "Não foi possível alcançar o servidor de impressão.".into(),
            _ => format!("Não foi possível acessar a impressora (erro do Windows {code})."),
        }
    }

    fn validate_current_printer_status(printer_name: &str) -> Result<(), String> {
        let connection = match WMIConnection::new() {
            Ok(connection) => connection,
            Err(_) => return Ok(()),
        };
        let escaped_name = printer_name.replace('\\', "\\\\").replace('\'', "\\'");
        let query = format!(
            "SELECT PrinterStatus FROM Win32_Printer WHERE Name = '{escaped_name}'"
        );
        let rows = match connection.raw_query::<PrinterStatusRow>(&query) {
            Ok(rows) => rows,
            Err(_) => return Ok(()),
        };
        let Some(row) = rows.into_iter().next() else {
            // OpenPrinterW already confirmed that the spooler recognizes it;
            // a missing WMI row only means status could not be cross-checked.
            return Ok(());
        };
        if matches!(row.printer_status, Some(6 | 7)) {
            return Err("A impressora está indisponível.".into());
        }
        Ok(())
    }

    pub fn get_printer_queue(printer_name: String) -> Result<Vec<PrintJobSnapshot>, String> {
        let printer_name = printer_name.trim();
        if printer_name.is_empty() {
            return Err("Selecione uma impressora válida.".into());
        }
        let printer = open_printer(printer_name)?;
        let mut bytes_needed = 0;
        let mut jobs_returned = 0;
        let first_call_succeeded = unsafe {
            EnumJobsW(
                printer.0,
                0,
                u32::MAX,
                2,
                ptr::null_mut(),
                0,
                &mut bytes_needed,
                &mut jobs_returned,
            )
        } != 0;
        if first_call_succeeded && jobs_returned == 0 {
            return Ok(Vec::new());
        }
        if bytes_needed == 0 {
            let code = unsafe { GetLastError() };
            if code == ERROR_INSUFFICIENT_BUFFER {
                return Ok(Vec::new());
            }
            return Err(map_printer_error(code));
        }

        // EnumJobsW returns JOB_INFO_2W values, which contain pointers and
        // therefore require pointer alignment even though the API accepts bytes.
        let mut buffer = vec![0u64; (bytes_needed as usize + size_of::<u64>() - 1) / size_of::<u64>()];
        let mut actual_bytes = 0;
        let mut actual_jobs = 0;
        let success = unsafe {
            EnumJobsW(
                printer.0,
                0,
                u32::MAX,
                2,
                buffer.as_mut_ptr() as *mut u8,
                bytes_needed,
                &mut actual_bytes,
                &mut actual_jobs,
            )
        };
        if success == 0 {
            return Err(map_printer_error(unsafe { GetLastError() }));
        }
        if actual_jobs == 0 {
            return Ok(Vec::new());
        }

        let jobs = unsafe {
            slice::from_raw_parts(buffer.as_ptr() as *const JobInfo2W, actual_jobs as usize)
        };
        Ok(jobs.iter().map(map_job).collect())
    }

    fn map_job(job: &JobInfo2W) -> PrintJobSnapshot {
        PrintJobSnapshot {
            job_id: job.job_id,
            document: optional_wide(job.document),
            user: optional_wide(job.user_name),
            status: map_job_status(job.status),
            status_bits: job.status,
            status_detail: optional_wide(job.status_text),
            size_bytes: u64::from(job.size),
            total_pages: (job.total_pages > 0).then_some(job.total_pages),
            pages_printed: (job.pages_printed > 0).then_some(job.pages_printed),
            submitted_at: format_submitted_at(&job.submitted),
            position: job.position,
        }
    }

    fn map_job_status(status: u32) -> String {
        if status & (0x0002 | 0x0020 | 0x0040 | 0x0200 | 0x0400) != 0 { return "Erro".into(); }
        if status & (0x0004 | 0x0100) != 0 { return "Cancelando".into(); }
        if status & 0x0001 != 0 { return "Pausado".into(); }
        if status & 0x0010 != 0 { return "Imprimindo".into(); }
        if status & (0x0080 | 0x1000 | 0x2000) != 0 { return "Concluído".into(); }
        if status & (0x0008 | 0x0800) != 0 || status == 0 { return "Aguardando".into(); }
        "Desconhecido".into()
    }

    fn selected_printer_contains_job(jobs: &[PrintJobSnapshot], job_id: u32) -> bool {
        jobs.iter().any(|job| job.job_id == job_id)
    }
    fn can_cancel_problem_job(status:u32)->bool {
        status & (0x0002|0x0200)!=0 && status & (0x0001|0x0004|0x0020|0x0040|0x0080|0x0100|0x0400|0x1000|0x2000)==0
    }

    fn clear_result(job_ids: &[u32], failed_job_ids: Vec<u32>) -> PrinterQueueActionResult {
        PrinterQueueActionResult { removed_count: job_ids.len().saturating_sub(failed_job_ids.len()) as u32, failed_job_ids }
    }

    fn printer_control_command(paused: bool) -> u32 {
        if paused { PRINTER_CONTROL_PAUSE } else { PRINTER_CONTROL_RESUME }
    }

    fn test_page_lines(printer_name: &str) -> Vec<String> {
        vec![
            "CENTRAL SOS".to_owned(),
            "Página de teste da impressora".to_owned(),
            format!("Impressora: {printer_name}"),
            "Se esta página foi impressa, o envio pelo Windows foi concluído.".to_owned(),
        ]
    }

    fn format_submitted_at(value: &SystemTime) -> Option<String> {
        (value.year > 0 && value.month > 0 && value.day > 0).then(|| {
            format!("{:04}-{:02}-{:02} {:02}:{:02} UTC", value.year, value.month, value.day, value.hour, value.minute)
        })
    }

    pub fn print_test_page(printer_name: String) -> Result<(), String> {
        let printer_name = printer_name.trim();
        if printer_name.is_empty() {
            return Err("Selecione uma impressora válida.".into());
        }
        let _printer = open_printer(printer_name)?;
        validate_current_printer_status(printer_name)?;

        let device_name = wide(printer_name);
        let dc = unsafe { CreateDCW(ptr::null(), device_name.as_ptr(), ptr::null(), ptr::null()) };
        if dc.is_null() {
            return Err("Não foi possível iniciar a impressão. Verifique se a impressora está disponível.".into());
        }
        let dc = DeviceContext(dc);
        let document_name = wide("CENTRAL SOS - Página de teste");
        let doc_info = DocInfoW {
            size: size_of::<DocInfoW>() as i32,
            document_name: document_name.as_ptr(),
            output_file: ptr::null(),
            datatype: ptr::null(),
            flags: 0,
        };
        if unsafe { StartDocW(dc.0, &doc_info) } <= 0 {
            return Err("O Windows não conseguiu criar o trabalho de impressão.".into());
        }
        if unsafe { StartPage(dc.0) } <= 0 {
            unsafe { AbortDoc(dc.0); }
            return Err("O Windows não conseguiu preparar a página de teste.".into());
        }

        let dpi_x = unsafe { GetDeviceCaps(dc.0, 88) }.max(1);
        let dpi_y = unsafe { GetDeviceCaps(dc.0, 90) }.max(1);
        let lines = test_page_lines(printer_name);
        for (index, line) in lines.iter().enumerate() {
            let text = wide(line);
            let y = (dpi_y * 3 / 4) + (index as i32 * dpi_y / 3);
            if unsafe { TextOutW(dc.0, dpi_x * 3 / 4, y, text.as_ptr(), (text.len() - 1) as i32) } == 0 {
                unsafe { AbortDoc(dc.0); }
                return Err("O Windows não conseguiu preparar o conteúdo da página de teste.".into());
            }
        }
        if unsafe { EndPage(dc.0) } <= 0 {
            unsafe { AbortDoc(dc.0); }
            return Err("O Windows não conseguiu finalizar a página de teste.".into());
        }
        if unsafe { EndDoc(dc.0) } <= 0 {
            return Err("O Windows não conseguiu enviar o trabalho para a fila da impressora.".into());
        }
        Ok(())
    }

    pub fn cancel_printer_job(printer_name: String, job_id: u32) -> Result<(), String> {
        let printer_name = printer_name.trim();
        if printer_name.is_empty() { return Err("Selecione uma impressora válida.".into()); }
        let jobs = get_printer_queue(printer_name.to_owned())?;
        if !selected_printer_contains_job(&jobs, job_id) {
            return Err("O trabalho não está mais na fila desta impressora.".into());
        }
        let printer = open_printer(printer_name)?;
        if unsafe { SetJobW(printer.0, job_id, 0, ptr::null(), JOB_CONTROL_DELETE) } == 0 {
            return Err(map_printer_error(unsafe { GetLastError() }));
        }
        Ok(())
    }

    pub fn cancel_problem_job(printer_name:String,job_id:u32)->Result<bool,String> {
        let name=printer_name.trim();if name.is_empty()||name.contains('\0'){return Err("Selecione uma impressora válida.".into());}
        let jobs=get_printer_queue(name.to_owned())?;
        // Re-check native flags immediately before deletion. A healed, completed,
        // deleting or missing job is preserved by the automatic repair path.
        if !jobs.iter().any(|j|j.job_id==job_id&&can_cancel_problem_job(j.status_bits)){return Ok(false);}
        let printer=open_printer(name)?;
        if unsafe{SetJobW(printer.0,job_id,0,ptr::null(),JOB_CONTROL_DELETE)}==0{return Err(map_printer_error(unsafe{GetLastError()}));}
        Ok(true)
    }

    pub fn clear_printer_queue(printer_name: String) -> Result<PrinterQueueActionResult, String> {
        let printer_name = printer_name.trim();
        if printer_name.is_empty() { return Err("Selecione uma impressora válida.".into()); }
        let jobs = get_printer_queue(printer_name.to_owned())?;
        let printer = open_printer(printer_name)?;
        let job_ids: Vec<u32> = jobs.iter().map(|job| job.job_id).collect();
        let mut failed_job_ids = Vec::new();
        for job_id in &job_ids {
            if unsafe { SetJobW(printer.0, *job_id, 0, ptr::null(), JOB_CONTROL_DELETE) } == 0 {
                failed_job_ids.push(*job_id);
            }
        }
        Ok(clear_result(&job_ids, failed_job_ids))
    }

    pub fn set_printer_paused(printer_name: String, paused: bool) -> Result<(), String> {
        let printer_name = printer_name.trim();
        if printer_name.is_empty() { return Err("Selecione uma impressora válida.".into()); }
        let printer = open_printer_with_access(printer_name, PRINTER_ACCESS_ADMINISTER)?;
        let command = printer_control_command(paused);
        if unsafe { SetPrinterW(printer.0, 0, ptr::null(), command) } == 0 {
            return Err(map_printer_error(unsafe { GetLastError() }));
        }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::{can_cancel_problem_job, clear_result, format_submitted_at, map_job_status, map_printer_error, printer_control_command, selected_printer_contains_job, test_page_lines, SystemTime, JOB_CONTROL_DELETE, PRINTER_CONTROL_PAUSE, PRINTER_CONTROL_RESUME, ERROR_PRINTER_NOT_FOUND};
        use crate::models::printer_operation::PrintJobSnapshot;

        #[test]
        fn maps_spooler_job_states_to_readable_labels() {
            assert_eq!(map_job_status(0x0010), "Imprimindo");
            assert_eq!(map_job_status(0), "Aguardando");
            assert_eq!(map_job_status(0x0001), "Pausado");
            assert_eq!(map_job_status(0x0002), "Erro");
            assert_eq!(map_job_status(0x0004), "Cancelando");
            assert_eq!(map_job_status(0x1000), "Concluído");
        }

        #[test]
        fn leaves_missing_spooler_timestamp_unreported() {
            let missing = SystemTime { year: 0, month: 0, day_of_week: 0, day: 0, hour: 0, minute: 0, second: 0, milliseconds: 0 };
            assert_eq!(format_submitted_at(&missing), None);
        }

        #[test]
        fn reports_a_missing_printer_without_starting_a_print_job() {
            assert_eq!(map_printer_error(ERROR_PRINTER_NOT_FOUND), "A impressora não foi encontrada.");
        }

        #[test]
        fn builds_explicit_test_page_for_the_selected_printer() {
            let content = test_page_lines("Impressora do balcão");
            assert_eq!(content[0], "CENTRAL SOS");
            assert_eq!(content[2], "Impressora: Impressora do balcão");
        }

        #[test]
        fn models_empty_and_multi_job_queue_cancellation_results_without_spooler_calls() {
            let empty = clear_result(&[], vec![]);
            assert_eq!(empty.removed_count, 0);
            assert!(empty.failed_job_ids.is_empty());
            let partial = clear_result(&[8, 9, 10], vec![9]);
            assert_eq!(partial.removed_count, 2);
            assert_eq!(partial.failed_job_ids, vec![9]);
            let all = clear_result(&[1, 2], vec![]);
            assert_eq!(all.removed_count, 2);
        }

        #[test]
        fn individual_job_validation_uses_the_selected_printer_queue_and_pause_commands_are_explicit() {
            let jobs = vec![PrintJobSnapshot { job_id: 7, document: None, user: None, status: "Aguardando".into(), status_bits: 0, status_detail: None, size_bytes: 0, total_pages: None, pages_printed: None, submitted_at: None, position: 1 }];
            assert!(selected_printer_contains_job(&jobs, 7));
            assert!(!selected_printer_contains_job(&jobs, 8));
            assert_eq!(printer_control_command(true), PRINTER_CONTROL_PAUSE);
            assert_eq!(printer_control_command(false), PRINTER_CONTROL_RESUME);
            assert_eq!(JOB_CONTROL_DELETE, 5);
        }
        #[test] fn automatic_printer_cancel_rechecks_native_fault_flags() {
            for bits in [2,0x200]{assert!(can_cancel_problem_job(bits));}
            for bits in [0,1,0x10,0x20,0x40,0x400,2|1,2|4,2|0x20,2|0x40,2|0x80,2|0x100,2|0x400,2|0x1000,2|0x2000]{assert!(!can_cancel_problem_job(bits));}
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use super::{PrintJobSnapshot, PrinterQueueActionResult};
    pub fn get_printer_queue(_: String) -> Result<Vec<PrintJobSnapshot>, String> {
        Err("A consulta da fila exige o Desktop Windows.".into())
    }
    pub fn print_test_page(_: String) -> Result<(), String> {
        Err("A impressão de teste exige o Desktop Windows.".into())
    }
    pub fn cancel_printer_job(_: String, _: u32) -> Result<(), String> { Err("Esta operação exige o Desktop Windows.".into()) }
    pub fn cancel_problem_job(_:String,_:u32)->Result<bool,String>{Err("Esta operação exige o Desktop Windows.".into())}
    pub fn clear_printer_queue(_: String) -> Result<PrinterQueueActionResult, String> { Err("Esta operação exige o Desktop Windows.".into()) }
    pub fn set_printer_paused(_: String, _: bool) -> Result<(), String> { Err("Esta operação exige o Desktop Windows.".into()) }
}

pub fn get_printer_queue(printer_name: String) -> Result<Vec<PrintJobSnapshot>, String> {
    platform::get_printer_queue(printer_name)
}

pub fn print_test_page(printer_name: String) -> Result<(), String> {
    platform::print_test_page(printer_name)
}

pub fn cancel_printer_job(printer_name: String, job_id: u32) -> Result<(), String> {
    platform::cancel_printer_job(printer_name, job_id)
}
pub fn cancel_problem_job(name:String,id:u32)->Result<bool,String>{platform::cancel_problem_job(name,id)}

pub fn clear_printer_queue(printer_name: String) -> Result<PrinterQueueActionResult, String> {
    platform::clear_printer_queue(printer_name)
}

pub fn set_printer_paused(printer_name: String, paused: bool) -> Result<(), String> {
    platform::set_printer_paused(printer_name, paused)
}
