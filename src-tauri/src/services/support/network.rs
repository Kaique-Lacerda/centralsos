use super::windows::{text, value, HKCU};
use crate::models::{machine::SnapshotCollection, support::*};
use std::{
    ffi::c_void,
    net::{IpAddr, SocketAddr, UdpSocket},
    ptr,
    sync::Mutex,
    time::Duration,
};
static ACTION: Mutex<()> = Mutex::new(());
const PROXY_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";
#[repr(C)]
struct ProxyInfo {
    access: u32,
    proxy: *mut u16,
    bypass: *mut u16,
}
#[link(name = "winhttp")]
extern "system" {
    fn WinHttpGetDefaultProxyConfiguration(out: *mut ProxyInfo) -> i32;
    fn WinHttpSetDefaultProxyConfiguration(info: *const ProxyInfo) -> i32;
}
#[link(name = "kernel32")]
extern "system" {
    fn GlobalFree(p: *mut c_void) -> *mut c_void;
}
#[link(name = "wininet")]
extern "system" {
    fn InternetSetOptionW(h: *mut c_void, option: u32, buffer: *const c_void, len: u32) -> i32;
}
pub fn proxies() -> Vec<Proxy> {
    let enabled = value(HKCU, PROXY_KEY, "ProxyEnable", 0);
    let server = value(HKCU, PROXY_KEY, "ProxyServer", 0);
    let pac = value(HKCU, PROXY_KEY, "AutoConfigURL", 0);
    let wininet = Proxy {
        source: "WinINET (usuário atual)".into(),
        enabled: enabled
            .as_ref()
            .ok()
            .and_then(|v| v.as_ref())
            .map(|v| v == "1"),
        server: server.clone().ok().flatten(),
        pac: pac.clone().ok().flatten(),
        error: enabled
            .err()
            .or(server.err())
            .or(pac.err())
            .map(|e| format!("Registro Windows {e}")),
    };
    let mut p = ProxyInfo {
        access: 0,
        proxy: ptr::null_mut(),
        bypass: ptr::null_mut(),
    };
    let ok = unsafe { WinHttpGetDefaultProxyConfiguration(&mut p) } != 0;
    let winhttp = Proxy {
        source: "WinHTTP (configuração padrão)".into(),
        enabled: ok.then_some(p.access == 3),
        server: unsafe { text(p.proxy) },
        pac: None,
        error: (!ok).then(|| super::windows::failure("WinHTTP")),
    };
    unsafe {
        if !p.proxy.is_null() {
            GlobalFree(p.proxy.cast());
        }
        if !p.bypass.is_null() {
            GlobalFree(p.bypass.cast());
        }
    }
    vec![wininet, winhttp]
}
pub fn collect() -> Result<NetworkSupportSnapshot, String> {
    let c = wmi::WMIConnection::new().map_err(|e| e.to_string())?;
    let (items, error) = crate::services::network::collect(&c);
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "PascalCase")]
    struct Row {
        interface_index: Option<u32>,
        next_hop: Option<String>,
        metric1: Option<u32>,
    }
    let rows=c.raw_query::<Row>("SELECT InterfaceIndex, NextHop, Metric1 FROM Win32_IP4RouteTable WHERE Destination='0.0.0.0' AND Mask='0.0.0.0'");
    let routes = match rows {
        Ok(r) => SnapshotCollection {
            items: r
                .into_iter()
                .map(|r| Route {
                    interface_index: r.interface_index,
                    gateway: r.next_hop,
                    metric: r.metric1,
                })
                .collect(),
            error: None,
        },
        Err(e) => SnapshotCollection {
            items: vec![],
            error: Some(e.to_string()),
        },
    };
    let connected = items
        .iter()
        .filter(|a| a.status.as_deref() == Some("Conectado"))
        .collect::<Vec<_>>();
    let gateways = connected
        .iter()
        .flat_map(|a| &a.gateways)
        .filter(|s| s.parse::<std::net::Ipv4Addr>().is_ok())
        .collect::<std::collections::BTreeSet<_>>();
    let gateway = if gateways.len() == 1 {
        gateways
            .first()
            .and_then(|g| super::connectivity::test((*g).clone(), None, false).ok())
    } else {
        None
    };
    let dns = connected
        .iter()
        .flat_map(|a| &a.dns_servers)
        .collect::<std::collections::BTreeSet<_>>();
    let mut dns_servers = vec![];
    for server in dns.into_iter().take(4) {
        dns_servers.push(ConnectivitySnapshot {
            host: server.clone(),
            port: Some(53),
            addresses: vec![server.clone()],
            dns: dns_probe(server),
            ping: Check::new("unknown", "ICMP não necessário nesta consulta DNS."),
            tcp: Check::new("unknown", "Consulta realizada por UDP 53; TCP não testado."),
            listeners: vec![],
            listener_error: None,
            firewall_rules: SnapshotCollection {
                items: vec![],
                error: None,
            },
        });
    }
    let external = super::connectivity::test("github.com".into(), Some(443), false)?;
    Ok(NetworkSupportSnapshot {
        adapters: SnapshotCollection { items, error },
        routes,
        proxies: proxies(),
        gateway,
        dns_servers,
        external,
    })
}
fn dns_probe(server: &str) -> Check {
    if server.parse::<IpAddr>().is_err() {
        return Check::new(
            "unknown",
            "Endereço DNS não suportado por esta consulta UDP; nenhum estado foi presumido.",
        );
    }
    let run = || -> Result<Check, String> {
        let ip: IpAddr = server.parse().map_err(|_| "Endereço DNS inválido.")?;
        let socket = UdpSocket::bind(if ip.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" })
            .map_err(|e| e.to_string())?;
        socket
            .set_read_timeout(Some(Duration::from_millis(1200)))
            .map_err(|e| e.to_string())?;
        socket
            .set_write_timeout(Some(Duration::from_millis(1200)))
            .map_err(|e| e.to_string())?;
        socket
            .connect(SocketAddr::new(ip, 53))
            .map_err(|e| e.to_string())?;
        let id = (std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .subsec_nanos() as u16)
            .to_be_bytes();
        let mut query = vec![id[0], id[1], 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 6];
        query.extend(b"github");
        query.push(3);
        query.extend(b"com");
        query.extend([0, 0, 1, 0, 1]);
        socket.send(&query).map_err(|e| e.to_string())?;
        let mut b = [0u8; 4096];
        let n = socket.recv(&mut b).map_err(|e| e.to_string())?;
        Ok(dns_response(&b[..n], id, server))
    };
    run().unwrap_or_else(|e|Check::new("timeout",format!("Não houve resposta DNS UDP de {server}: {e}. Bloqueio ou filtragem também são possíveis.")))
}
fn dns_response(b: &[u8], id: [u8; 2], server: &str) -> Check {
    if b.len() < 12 || b[..2] != id || b[2] & 0x80 == 0 {
        return Check::new("unknown", "Resposta DNS inválida ou sem correspondência.");
    }
    let code = b[3] & 15;
    if code != 0 {
        return Check::error(
            code as u32,
            format!("O DNS {server} respondeu, mas retornou RCODE {code} para github.com."),
        );
    }
    if b[2] & 2 != 0 {
        return Check::new("unknown", "Resposta UDP truncada; não prova falha do DNS.");
    }
    if u16::from_be_bytes([b[6], b[7]]) == 0 {
        return Check::new("unknown", "DNS respondeu sem registros de resposta.");
    }
    Check::new(
        "success",
        format!("{server} respondeu à consulta UDP de github.com."),
    )
}
pub fn repair(action: String, index: Option<u32>, confirmed: bool) -> Result<String, String> {
    super::elevated()?;
    let _guard = ACTION
        .try_lock()
        .map_err(|_| "Outra ação de rede está em execução.".to_string())?;
    if action == "flushDns" {
        let fresh = collect()?;
        if fresh.external.dns.state == "success" {
            return Ok("DNS já resolve; nenhuma limpeza foi necessária.".into());
        }
        if !fresh.dns_servers.iter().any(|s| s.dns.state == "success") {
            return Err("Nenhum DNS configurado respondeu diretamente; não há evidência para limpar cache como correção.".into());
        }
        #[link(name = "dnsapi")]
        extern "system" {
            fn DnsFlushResolverCache() -> i32;
        }
        if unsafe { DnsFlushResolverCache() } == 0 {
            return Err(super::windows::failure("Limpeza DNS"));
        }
        let after = super::connectivity::test("github.com".into(), Some(443), false)?;
        return Ok(format!(
            "Cache DNS limpo. Nova consulta: {}",
            after.dns.message
        ));
    }
    super::require_confirmation(confirmed)?;
    if action == "removeWininetProxy" {
        if proxies()[0].enabled != Some(true) {
            return Err("Proxy manual WinINET não está confirmado; nada foi alterado.".into());
        }
        super::windows::disable_user_proxy()?;
        unsafe {
            InternetSetOptionW(ptr::null_mut(), 39, ptr::null(), 0);
            InternetSetOptionW(ptr::null_mut(), 37, ptr::null(), 0);
        }
        return Ok("Proxy manual do usuário desabilitado. PAC/WPAD e configurações gerenciadas foram preservados.".into());
    }
    if action == "removeWinhttpProxy" {
        if proxies()[1].enabled != Some(true) {
            return Err("Proxy padrão WinHTTP não está confirmado.".into());
        }
        let p = ProxyInfo {
            access: 1,
            proxy: ptr::null_mut(),
            bypass: ptr::null_mut(),
        };
        if unsafe { WinHttpSetDefaultProxyConfiguration(&p) } == 0 {
            return Err(super::windows::failure("Proxy WinHTTP"));
        }
        return Ok(
            "Proxy padrão WinHTTP removido. Configurações por aplicação foram preservadas.".into(),
        );
    }
    let index = index.ok_or("Selecione uma interface com índice real do Windows.")?;
    let c = wmi::WMIConnection::new().map_err(|e| e.to_string())?;
    let (items, error) = crate::services::network::collect(&c);
    if let Some(e) = error {
        return Err(e);
    }
    let adapter = items
        .into_iter()
        .find(|a| a.index == Some(index))
        .ok_or("Adaptador não encontrado.")?;
    let (object,method)=match action.as_str(){"enableAdapter" if adapter.net_enabled==Some(false)=>(format!("Win32_NetworkAdapter.DeviceID=\"{index}\""),"Enable"),"renewDhcp" if adapter.dhcp_enabled==Some(true)&&adapter.ipv4.iter().any(|ip|ip.starts_with("169.254."))=>(format!("Win32_NetworkAdapterConfiguration.Index={index}"),"RenewDHCPLease"),_=>return Err("Ação indisponível: falta evidência correspondente. DNS, Winsock e rotas não serão redefinidos.".into())};
    let result = c
        .exec_method(object, method, None)
        .map_err(|e| e.to_string())?
        .ok_or("Resultado da ação não informado.")?
        .get_property("ReturnValue")
        .map_err(|e| e.to_string())?;
    match result{wmi::Variant::UI4(0)|wmi::Variant::I4(0)=>Ok("Ação aceita pelo Windows. O diagnóstico será consultado novamente para confirmar o estado.".into()),v=>Err(format!("{method} retornou {v:?}"))}
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dns_packets_do_not_invent_resolution_or_failure() {
        let mut response = [0x12, 0x34, 0x80, 0, 0, 1, 0, 1, 0, 0, 0, 0];
        assert_eq!(
            dns_response(&response, [0x12, 0x34], "8.8.8.8").state,
            "success"
        );
        assert_eq!(dns_response(&response, [0, 1], "8.8.8.8").state, "unknown");
        assert_eq!(
            dns_response(&response[..6], [0x12, 0x34], "8.8.8.8").state,
            "unknown"
        );
        response[3] = 2;
        assert_eq!(
            dns_response(&response, [0x12, 0x34], "8.8.8.8").code,
            Some(2)
        );
        response[3] = 0;
        response[2] |= 2;
        assert_eq!(
            dns_response(&response, [0x12, 0x34], "8.8.8.8").state,
            "unknown"
        );
        response[2] = 0x80;
        response[7] = 0;
        assert_eq!(
            dns_response(&response, [0x12, 0x34], "8.8.8.8").state,
            "unknown"
        );
    }
}
