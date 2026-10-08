#![cfg_attr(windows, windows_subsystem = "windows")]
#[cfg(windows)]
mod collector;
fn main() {
    // No arguments/configuration selecting a path, program or script.
    if std::env::args_os().len() != 1 {
        eprintln!("Session Helper não aceita argumentos.");
        std::process::exit(1);
    }
    #[cfg(windows)]
    if let Err(error) = central_sos_link::session::windows::serve(collector::bounded_collect) {
        eprintln!("Session Helper encerrado: {:?}", error.code);
        std::process::exit(1);
    }
    #[cfg(not(windows))]
    {
        eprintln!("Session Helper exige Windows interativo.");
        std::process::exit(1);
    }
}
