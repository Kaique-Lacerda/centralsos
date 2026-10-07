use serde::Deserialize;
use std::collections::HashMap;
use std::net::IpAddr;
use wmi::WMIConnection;

use crate::models::machine::NetworkAdapterSnapshot;

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct AdapterRow {
    name: Option<String>,
    index: Option<u32>,
    interface_index: Option<u32>,
    #[serde(rename = "MACAddress")]
    mac_address: Option<String>,
    net_connection_status: Option<u16>,
    net_enabled: Option<bool>,
    physical_adapter: Option<bool>,
    manufacturer: Option<String>,
    product_name: Option<String>,
    service_name: Option<String>,
    #[serde(rename = "PNPDeviceID")]
    pnp_device_id: Option<String>,
    adapter_type: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ConfigurationRow {
    index: Option<u32>,
    #[serde(rename = "DHCPEnabled")]
    dhcp_enabled: Option<bool>,
    description: Option<String>,
    #[serde(rename = "MACAddress")]
    mac_address: Option<String>,
    #[serde(rename = "IPAddress")]
    ip_address: Option<Vec<String>>,
    #[serde(rename = "DefaultIPGateway")]
    default_ip_gateway: Option<Vec<String>>,
    #[serde(rename = "DNSServerSearchOrder")]
    dns_server_search_order: Option<Vec<String>>,
}

pub fn collect(connection: &WMIConnection) -> (Vec<NetworkAdapterSnapshot>, Option<String>) {
    let adapters = match connection.raw_query::<AdapterRow>(
        "SELECT Name, Index, InterfaceIndex, MACAddress, NetConnectionStatus, NetEnabled, PhysicalAdapter, Manufacturer, ProductName, ServiceName, PNPDeviceID, AdapterType FROM Win32_NetworkAdapter",
    ) {
        Ok(rows) => rows,
        Err(error) => return (Vec::new(), Some(error.to_string())),
    };

    let configurations = match connection.raw_query::<ConfigurationRow>(
        "SELECT Index, DHCPEnabled, Description, MACAddress, IPAddress, DefaultIPGateway, DNSServerSearchOrder FROM Win32_NetworkAdapterConfiguration",
    ) {
        Ok(rows) => rows,
        Err(error) => {
            let items = adapters.into_iter().map(|adapter| NetworkAdapterSnapshot {
                index: adapter.index,
                interface_index: adapter.interface_index,
                net_enabled: adapter.net_enabled,
                name: adapter.name.unwrap_or_else(|| "Indisponível".into()),
                status: connection_status(adapter.net_connection_status, adapter.net_enabled),
                mac: adapter.mac_address,
                physical_adapter: adapter.physical_adapter,
                manufacturer: adapter.manufacturer,
                product_name: adapter.product_name,
                service_name: adapter.service_name,
                pnp_device_id: adapter.pnp_device_id,
                adapter_type: adapter.adapter_type,
                ..NetworkAdapterSnapshot::default()
            }).collect();
            return (items, Some(error.to_string()));
        }
    };

    let by_index: HashMap<u32, ConfigurationRow> = configurations
        .into_iter()
        .filter_map(|configuration| configuration.index.map(|index| (index, configuration)))
        .collect();

    let items = adapters
        .into_iter()
        .map(|adapter| {
            let configuration = adapter.index.and_then(|index| by_index.get(&index));
            let mut ipv4 = Vec::new();
            let mut ipv6 = Vec::new();
            for address in configuration
                .and_then(|item| item.ip_address.as_ref())
                .into_iter()
                .flatten()
            {
                let plain_address = address
                    .split_once('%')
                    .map_or(address.as_str(), |(address, _)| address);
                match plain_address.parse::<IpAddr>() {
                    Ok(IpAddr::V4(_)) => ipv4.push(address.clone()),
                    Ok(IpAddr::V6(_)) => ipv6.push(address.clone()),
                    Err(_) => {}
                }
            }
            NetworkAdapterSnapshot {
                index: adapter.index,
                interface_index: adapter.interface_index,
                net_enabled: adapter.net_enabled,
                dhcp_enabled: configuration.and_then(|item| item.dhcp_enabled),
                name: adapter
                    .name
                    .or_else(|| configuration.and_then(|item| item.description.clone()))
                    .unwrap_or_else(|| "Indisponível".into()),
                status: connection_status(adapter.net_connection_status, adapter.net_enabled),
                mac: configuration
                    .and_then(|item| item.mac_address.clone())
                    .or(adapter.mac_address),
                physical_adapter: adapter.physical_adapter,
                manufacturer: adapter.manufacturer,
                product_name: adapter.product_name,
                service_name: adapter.service_name,
                pnp_device_id: adapter.pnp_device_id,
                adapter_type: adapter.adapter_type,
                ipv4,
                ipv6,
                gateways: configuration
                    .and_then(|item| item.default_ip_gateway.clone())
                    .unwrap_or_default(),
                dns_servers: configuration
                    .and_then(|item| item.dns_server_search_order.clone())
                    .unwrap_or_default(),
            }
        })
        .collect();
    (items, None)
}

fn connection_status(code: Option<u16>, enabled: Option<bool>) -> Option<String> {
    code.map(|value| match value {
        0 => "Desconectado".into(),
        1 => "Conectando".into(),
        2 => "Conectado".into(),
        3 => "Desconectando".into(),
        4 => "Hardware ausente".into(),
        5 => "Hardware desabilitado".into(),
        6 => "Falha de hardware".into(),
        7 => "Mídia desconectada".into(),
        8 => "Autenticando".into(),
        9 => "Autenticado".into(),
        10 => "Falha de autenticação".into(),
        11 => "Endereço inválido".into(),
        12 => "Credenciais necessárias".into(),
        other => format!("Status {other}"),
    })
    .or_else(|| {
        enabled.map(|value| {
            if value {
                "Habilitado".into()
            } else {
                "Desabilitado".into()
            }
        })
    })
}
