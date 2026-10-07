use super::windows::{text, wide};
use crate::models::{machine::SnapshotCollection, support::*};
use std::{
    ffi::c_void,
    ptr,
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    time::Duration,
};
static PENDING: AtomicUsize = AtomicUsize::new(0);
pub fn validate_unc(path: &str) -> Result<(String, String), String> {
    let p = path.trim();
    let rest = p
        .strip_prefix(r"\\")
        .ok_or("Use um caminho UNC: \\\\SERVIDOR\\Compartilhamento.")?;
    let parts = rest.split('\\').collect::<Vec<_>>();
    if parts.len() != 2
        || parts[1].is_empty()
        || parts[1].len() > 80
        || parts[1]
            .chars()
            .any(|c| c.is_control() || "/:*?\"<>|".contains(c))
        || [".", ".."].contains(&parts[1])
    {
        return Err(
            "Informe somente servidor e compartilhamento, sem subpastas ou caracteres especiais."
                .into(),
        );
    }
    let host = super::connectivity::validate_host(parts[0])?;
    if host == "." || host == "?" {
        return Err("Dispositivo UNC não permitido.".into());
    }
    Ok((host, parts[1].into()))
}
fn bounded<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    if PENDING
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
            (n < 2).then_some(n + 1)
        })
        .is_err()
    {
        return Err("Há consultas SMB pendentes; aguarde o Windows.".into());
    }
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let r = f();
        let _ = tx.send(r);
        PENDING.fetch_sub(1, Ordering::SeqCst);
    });
    rx.recv_timeout(Duration::from_secs(12)).map_err(|_| {
        "Tempo limite de SMB (12 segundos); nenhuma credencial ou configuração foi alterada."
            .to_string()
    })?
}
pub fn access_result(code: u32) -> (Check, Check) {
    match code{0=>(Check::new("success","Compartilhamento encontrado."),Check::new("success","Listagem do diretório permitida ao usuário atual.")),2|3|67=>(Check::error(code,"Compartilhamento/caminho não encontrado."),Check::new("unknown","Acesso não testado: caminho ausente.")),5=>(Check::new("unknown","A existência não foi confirmada com o acesso atual."),Check::error(code,"O Windows negou acesso ao compartilhamento.")),86|1326|1219=>(Check::new("unknown","Existência não confirmada."),Check::error(code,"Credencial recusada ou conflito com uma conexão existente. Nenhuma senha foi enviada pelo CENTRAL SOS.")),53=>(Check::error(code,"Caminho de rede não encontrado; consulte DNS e TCP 445."),Check::new("unknown","Acesso não confirmado.")),121|1460=>(Check::new("timeout","Tempo limite do Windows ao acessar o caminho."),Check::new("timeout","Acesso não confirmado no tempo disponível.")),_=>(Check::error(code,format!("O Windows retornou o código {code}.")),Check::new("unknown","Acesso não confirmado."))}
}
pub fn test(path: String) -> Result<ShareSnapshot, String> {
    let (host, _) = validate_unc(&path)?;
    let canonical = path.trim().to_string();
    let connectivity = super::connectivity::test(host, Some(445), false)?;
    if connectivity.dns.state != "success" {
        return Ok(ShareSnapshot {
            path: canonical,
            connectivity,
            existence: Check::new("unknown", "Destino não resolvido."),
            access: Check::new("unknown", "Consulta SMB não executada."),
        });
    }
    let lookup = canonical.clone();
    let r = bounded(move || match std::fs::read_dir(&lookup) {
        Ok(_) => Ok(access_result(0)),
        Err(e) => Ok(access_result(e.raw_os_error().unwrap_or(1) as u32)),
    });
    let (existence, access) =
        r.unwrap_or_else(|e| (Check::new("timeout", &e), Check::new("timeout", e)));
    Ok(ShareSnapshot {
        path: canonical,
        connectivity,
        existence,
        access,
    })
}
pub fn list(host: String) -> Result<SnapshotCollection<ShareInfo>, String> {
    let host = super::connectivity::validate_host(&host)?;
    bounded(move || {
        #[repr(C)]
        struct Row {
            name: *const u16,
            kind: u32,
            remark: *const u16,
        }
        #[link(name = "netapi32")]
        extern "system" {
            fn NetShareEnum(
                server: *const u16,
                level: u32,
                buffer: *mut *mut u8,
                max: u32,
                read: *mut u32,
                total: *mut u32,
                resume: *mut u32,
            ) -> u32;
            fn NetApiBufferFree(p: *mut c_void) -> u32;
        }
        let mut result = vec![];
        let mut resume = 0;
        let server = wide(&format!("\\\\{host}"));
        let mut truncated = false;
        for _ in 0..16 {
            let mut b = ptr::null_mut();
            let (mut read, mut total) = (0, 0);
            let rc = unsafe {
                NetShareEnum(
                    server.as_ptr(),
                    1,
                    &mut b,
                    16384,
                    &mut read,
                    &mut total,
                    &mut resume,
                )
            };
            if rc != 0 && rc != 234 {
                if !b.is_null() {
                    unsafe {
                        NetApiBufferFree(b.cast());
                    }
                }
                return Err(format!("Listar compartilhamentos: Windows {rc}"));
            }
            if !b.is_null() {
                for row in unsafe { std::slice::from_raw_parts(b.cast::<Row>(), read as usize) } {
                    let name = unsafe { text(row.name) }.unwrap_or_default();
                    if row.kind & 0xffff == 0 && !name.ends_with('$') {
                        result.push(ShareInfo {
                            path: format!("\\\\{host}\\{name}"),
                            name,
                            comment: unsafe { text(row.remark) },
                        })
                    }
                }
                unsafe {
                    NetApiBufferFree(b.cast());
                }
            }
            if rc == 0 {
                return Ok(SnapshotCollection {
                    items: result,
                    error: None,
                });
            }
            truncated = true;
        }
        Ok(SnapshotCollection{items:result,error:truncated.then(||"Listagem parcial: limite de 16 páginas atingido. Compartilhamentos administrativos ocultos não são apresentados.".into())})
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unc_and_errors() {
        assert!(validate_unc(r"\\SERVIDOR\Troia").is_ok());
        for p in [
            r"\\.\x",
            r"\\?\x",
            r"\\server\..",
            r"\\server\x\y",
            "server",
        ] {
            assert!(validate_unc(p).is_err())
        }
        assert_eq!(access_result(5).1.state, "error");
        assert_eq!(access_result(67).0.state, "error");
        assert_eq!(access_result(1460).0.state, "timeout");
        assert_eq!(access_result(0).1.state, "success")
    }
}
