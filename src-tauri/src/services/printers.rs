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
}

pub fn collect(connection: &WMIConnection) -> Result<Vec<PrinterSnapshot>, String> {
    connection.raw_query::<PrinterRow>(
        "SELECT Name, Default, DriverName, PortName, ServerName, PrinterStatus FROM Win32_Printer",
    ).map(|rows| rows.into_iter().map(|row| PrinterSnapshot {
        name: row.name.unwrap_or_else(|| "Indisponível".into()),
        is_default: row.is_default.unwrap_or(false),
        driver: row.driver_name,
        port: row.port_name,
        server: row.server_name,
        status: row.printer_status.map(printer_status),
    }).collect()).map_err(|error| error.to_string())
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
