#[cfg(windows)]
pub mod installation;
pub mod snapshot;
pub mod agent_metadata;
#[cfg(windows)]
pub mod support;
pub mod printer_operations;
pub mod printer_management;
pub mod printer_connections;
pub mod printer_diagnostics;
pub mod printer_spooler;

#[cfg(windows)]
mod network;
#[cfg(windows)]
mod printers;
#[cfg(windows)]
mod storage;
#[cfg(windows)]
mod system;
#[cfg(windows)]
pub mod windows_services;
