use serde::Serialize;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentMetadata {
    pub hostname: String,
    pub os_version: Option<String>,
    pub uptime: u64,
    pub local_ip: Option<String>,
}
pub fn collect() -> AgentMetadata {
    let mut local_ip = None;
    #[cfg(windows)]
    {
        #[derive(serde::Deserialize)]
        struct Row {
            #[serde(rename = "IPAddress")]
            ip: Option<Vec<String>>,
        }
        if let Ok(c) = wmi::WMIConnection::new() {
            if let Ok(rows) = c.raw_query::<Row>(
                "SELECT IPAddress FROM Win32_NetworkAdapterConfiguration WHERE IPEnabled=True",
            ) {
                let ips = rows
                    .into_iter()
                    .flat_map(|r| r.ip.unwrap_or_default())
                    .filter(|s| {
                        s.parse::<std::net::Ipv4Addr>().is_ok_and(|v| {
                            !v.is_loopback() && !v.is_unspecified() && !v.is_link_local()
                        })
                    })
                    .collect::<std::collections::BTreeSet<_>>();
                if ips.len() == 1 {
                    local_ip = ips.into_iter().next();
                }
            }
        }
    }
    AgentMetadata {
        hostname: sysinfo::System::host_name().unwrap_or_else(|| "Indisponível".into()),
        os_version: sysinfo::System::long_os_version(),
        uptime: sysinfo::System::uptime(),
        local_ip,
    }
}
