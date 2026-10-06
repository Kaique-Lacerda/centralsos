use serde::Deserialize;
use wmi::WMIConnection;

use crate::models::machine::PrinterSnapshot;

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct PrinterRow {
    name: Option<String>,
    #[serde(rename = "Default")]
    is_default: Option<bool>,
    driver_name: Option<String>,
    port_name: Option<String>,
    server_name: Option<String>,
    printer_status: Option<u16>,
    local: Option<bool>,
    network: Option<bool>,
    shared: Option<bool>,
    share_name: Option<String>,
    location: Option<String>,
    comment: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct PrinterNameRow {
    name: Option<String>,
}

pub fn collect(connection: &WMIConnection) -> (Vec<PrinterSnapshot>, Option<String>) {
    let query = "SELECT Name, Default, DriverName, PortName, ServerName, PrinterStatus, Local, Network, Shared, ShareName, Location, Comment FROM Win32_Printer";
    match connection.raw_query::<PrinterRow>(query) {
        Ok(rows) => (rows.into_iter().map(map_printer).collect(), None),
        Err(initial_error) => collect_individually(connection, initial_error.to_string()),
    }
}

fn collect_individually(connection: &WMIConnection, initial_error: String) -> (Vec<PrinterSnapshot>, Option<String>) {
    let names = match connection.raw_query::<PrinterNameRow>("SELECT Name FROM Win32_Printer") {
        Ok(names) => names,
        Err(error) => return (Vec::new(), Some(format!("{initial_error}; não foi possível enumerar impressoras: {error}"))),
    };

    let mut printers = Vec::new();
    let mut errors = Vec::new();
    for name in names.into_iter().filter_map(|row| row.name) {
        let escaped_name = name.replace('\\', "\\\\").replace('\'', "\\'");
        let query = format!(
            "SELECT Name, Default, DriverName, PortName, ServerName, PrinterStatus, Local, Network, Shared, ShareName, Location, Comment FROM Win32_Printer WHERE Name = '{escaped_name}'"
        );
        match connection.raw_query::<PrinterRow>(&query) {
            Ok(rows) => printers.extend(rows.into_iter().map(map_printer)),
            Err(error) => errors.push(format!("{name}: {error}")),
        }
    }

    let partial_error = if errors.is_empty() { None } else {
        Some(format!("Coleta parcial. Consulta conjunta: {initial_error}. Falhas individuais: {}", errors.join("; ")))
    };
    (printers, partial_error)
}

fn map_printer(row: PrinterRow) -> PrinterSnapshot {
    PrinterSnapshot {
        name: row.name.unwrap_or_else(|| "Indisponível".into()),
        is_default: row.is_default.unwrap_or(false),
        driver: row.driver_name,
        port: row.port_name,
        server: row.server_name,
        status: row.printer_status.map(printer_status),
        local: row.local,
        network: row.network,
        shared: row.shared,
        share_name: row.share_name,
        location: row.location,
        comment: row.comment,
    }
}

fn printer_status(code: u16) -> String {
    match code {
        1 => "Outro".into(),
        2 => "Desconhecido".into(),
        3 => "Ociosa".into(),
        4 => "Imprimindo".into(),
        5 => "Aquecendo".into(),
        6 => "Parada".into(),
        7 => "Offline".into(),
        other => format!("Status {other}"),
    }
}
