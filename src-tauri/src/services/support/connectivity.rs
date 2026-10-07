use crate::models::{machine::SnapshotCollection, support::*};
use std::{
    net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
static RESOLVERS: AtomicUsize = AtomicUsize::new(0);
pub fn validate_host(host: &str) -> Result<String, String> {
    let h = host.trim();
    if host.chars().any(char::is_control)
        || h.is_empty()
        || h.len() > 253
        || h.contains(['\\', '/', '\0', ':', ' ']) && h.parse::<IpAddr>().is_err()
    {
        return Err("Informe somente um hostname ou IP, sem URL, caminho ou porta.".into());
    }
    if h.parse::<IpAddr>().is_ok() {
        return Ok(h.into());
    }
    if h.split('.').any(|s| {
        s.is_empty()
            || s.len() > 63
            || s.starts_with('-')
            || s.ends_with('-')
            || !s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    }) {
        return Err("Hostname inválido.".into());
    }
    Ok(h.into())
}
pub fn validate_port(port: Option<u32>) -> Result<Option<u16>, String> {
    match port {
        Some(p) if (1..=65535).contains(&p) => Ok(Some(p as u16)),
        Some(_) => Err("A porta deve estar entre 1 e 65535.".into()),
        None => Ok(None),
    }
}
fn resolve(host: String) -> Result<Vec<IpAddr>, String> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(vec![ip]);
    }
    if RESOLVERS
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
            (n < 4).then_some(n + 1)
        })
        .is_err()
    {
        return Err("Há consultas DNS pendentes; tente novamente.".into());
    }
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let result = (host.as_str(), 0)
            .to_socket_addrs()
            .map(|a| a.map(|a| a.ip()).take(16).collect::<Vec<_>>())
            .map_err(|e| e.to_string());
        let _ = tx.send(result);
        RESOLVERS.fetch_sub(1, Ordering::SeqCst);
    });
    let mut ips = rx
        .recv_timeout(Duration::from_secs(4))
        .map_err(|_| "Tempo limite de resolução DNS (4 segundos).".to_string())??;
    ips.sort();
    ips.dedup();
    if ips.is_empty() {
        Err("O Windows não retornou endereços.".into())
    } else {
        Ok(ips)
    }
}
pub fn test(
    host: String,
    port: Option<u32>,
    local_details: bool,
) -> Result<ConnectivitySnapshot, String> {
    let host = validate_host(&host)?;
    let port = validate_port(port)?;
    let started = Instant::now();
    let resolved = resolve(host.clone());
    let (mut dns, ips) = match resolved {
        Ok(ips) => (
            Check::new(
                "success",
                if host.parse::<IpAddr>().is_ok() {
                    "Endereço IP informado; resolução não necessária."
                } else {
                    "Nome resolvido pelo Windows."
                },
            ),
            ips,
        ),
        Err(e) => (
            Check::new(
                if e.contains("pendentes") {
                    "unknown"
                } else if e.contains("Tempo limite") {
                    "timeout"
                } else {
                    "error"
                },
                e,
            ),
            vec![],
        ),
    };
    dns.latency_ms = Some(started.elapsed().as_millis() as u64);
    let ping = ips
        .iter()
        .find_map(|ip| {
            if let IpAddr::V4(v) = ip {
                Some(ping(*v))
            } else {
                None
            }
        })
        .unwrap_or_else(|| {
            Check::new(
                "unknown",
                "ICMP IPv4 não disponível para este destino; não significa que esteja inacessível.",
            )
        });
    let tcp = if let Some(port) = port {
        if ips.is_empty() {
            Check::new("unknown", "TCP não testado porque o destino não resolveu.")
        } else {
            tcp(&ips, port)
        }
    } else {
        Check::new("unknown", "Nenhuma porta foi informada.")
    };
    let local = ips.iter().any(|ip| ip.is_loopback())
        || local_details
            && wmi::WMIConnection::new().ok().is_some_and(|c| {
                let (adapters, _) = crate::services::network::collect(&c);
                adapters
                    .iter()
                    .flat_map(|a| a.ipv4.iter().chain(a.ipv6.iter()))
                    .any(|s| s.parse::<IpAddr>().ok().is_some_and(|ip| ips.contains(&ip)))
            });
    let (listeners, listener_error) = if local && local_details {
        match port.map(super::processes::listeners).transpose() {
            Ok(items) => (items.unwrap_or_default(), None),
            Err(e) => (vec![], Some(e)),
        }
    } else {
        (vec![], None)
    };
    let firewall_rules = if local && local_details {
        port.map(firewall).unwrap_or_else(|| SnapshotCollection {
            items: vec![],
            error: None,
        })
    } else {
        SnapshotCollection {
            items: vec![],
            error: None,
        }
    };
    Ok(ConnectivitySnapshot {
        host,
        port,
        addresses: ips.iter().map(ToString::to_string).collect(),
        dns,
        ping,
        tcp,
        listeners,
        listener_error,
        firewall_rules,
    })
}
fn tcp(ips: &[IpAddr], port: u16) -> Check {
    let start = Instant::now();
    let mut timeout = false;
    let mut errors = vec![];
    for ip in ips.iter().take(4) {
        match TcpStream::connect_timeout(&SocketAddr::new(*ip,port),Duration::from_millis(900)){Ok(_)=>return Check{latency_ms:Some(start.elapsed().as_millis() as u64),..Check::new("success",format!("TCP {port} aceitou conexão em {ip}. Não confirma o protocolo da aplicação."))},Err(e)=>{timeout|=matches!(e.kind(),std::io::ErrorKind::TimedOut|std::io::ErrorKind::WouldBlock);errors.push(e.to_string())}}
    }
    Check {
        latency_ms: Some(start.elapsed().as_millis() as u64),
        ..Check::new(
            if timeout { "timeout" } else { "error" },
            format!(
                "TCP {port}: {}. A causa não foi atribuída automaticamente ao Firewall.",
                errors.join("; ")
            ),
        )
    }
}
fn ping(ip: std::net::Ipv4Addr) -> Check {
    use std::{ffi::c_void, ptr};
    #[link(name = "iphlpapi")]
    extern "system" {
        fn IcmpCreateFile() -> *mut c_void;
        fn IcmpCloseHandle(h: *mut c_void) -> i32;
        fn IcmpSendEcho(
            h: *mut c_void,
            ip: u32,
            data: *const c_void,
            size: u16,
            options: *const c_void,
            reply: *mut c_void,
            reply_size: u32,
            timeout: u32,
        ) -> u32;
    }
    let h = unsafe { IcmpCreateFile() };
    if h as isize == -1 {
        return Check::new("unknown", "ICMP indisponível.");
    }
    // DWORD Address, Status and RoundTripTime are the first three fields on x86/x64.
    let mut b = [0u64; 64];
    let count = unsafe {
        IcmpSendEcho(
            h,
            u32::from_ne_bytes(ip.octets()),
            b"SOS".as_ptr().cast(),
            3,
            ptr::null(),
            b.as_mut_ptr().cast(),
            512,
            900,
        )
    };
    unsafe {
        IcmpCloseHandle(h);
    }
    let words = unsafe { std::slice::from_raw_parts(b.as_ptr().cast::<u32>(), 3) };
    if count > 0 && words[1] == 0 {
        Check {
            latency_ms: Some(words[2] as u64),
            ..Check::new("success", "Resposta ICMP recebida.")
        }
    } else {
        Check::new(
            "unknown",
            "Sem resposta ICMP. O destino pode bloquear ping; consulte o resultado TCP.",
        )
    }
}
fn firewall(port: u16) -> SnapshotCollection<FirewallRule> {
    // Associated filters supply port/application; a rule alone does not prove an effective block.
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "PascalCase")]
    struct Filter {
        instance_id: String,
        local_port: Option<Vec<String>>,
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "PascalCase")]
    struct Row {
        display_name: Option<String>,
        enabled: Option<u16>,
        direction: Option<u16>,
        action: Option<u16>,
    }
    let run = || -> Result<Vec<FirewallRule>, String> {
        let c = wmi::WMIConnection::with_namespace_path("ROOT\\StandardCimv2")
            .map_err(|e| e.to_string())?;
        let filters: Vec<Filter> = c
            .raw_query(
                "SELECT InstanceID, LocalPort FROM MSFT_NetFirewallPortFilter WHERE Protocol = 6",
            )
            .map_err(|e| e.to_string())?;
        let mut items = vec![];
        for f in filters
            .into_iter()
            .filter(|f| {
                f.local_port
                    .as_ref()
                    .is_some_and(|p| p.iter().any(|s| s == &port.to_string()))
            })
            .take(32)
        {
            let id = f.instance_id.replace('\\', "\\\\").replace('\'', "\\'");
            let rows:Vec<Row>=c.raw_query(format!("SELECT DisplayName, Enabled, Direction, Action FROM MSFT_NetFirewallRule WHERE InstanceID = '{id}'")).map_err(|e|e.to_string())?;
            for r in rows {
                items.push(FirewallRule {
                    name: r.display_name,
                    enabled: r.enabled,
                    direction: r.direction,
                    action: r.action,
                    local_port: Some(port.to_string()),
                    application: None,
                })
            }
        }
        Ok(items)
    };
    match run(){Ok(items)=>SnapshotCollection{items,error:Some("Regras por porta exata. Perfis, aplicação, precedência e regras por intervalo não foram avaliados; não comprova bloqueio efetivo.".into())},Err(e)=>SnapshotCollection{items:vec![],error:Some(e)}}
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hosts_and_ports() {
        for h in ["server", "192.168.1.10", "::1", "example.org"] {
            assert!(validate_host(h).is_ok())
        }
        for h in ["", "https://site", "x & cmd", "../x", "a\n"] {
            assert!(validate_host(h).is_err())
        }
        assert_eq!(validate_port(Some(3050)).unwrap(), Some(3050));
        for p in [0, 65536, u32::MAX] {
            assert!(validate_port(Some(p)).is_err())
        }
    }
}
