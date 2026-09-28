use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WindowsServiceSnapshot {
    pub name: Option<String>,
    pub display_name: Option<String>,
    pub state: Option<String>,
    pub start_mode: Option<String>,
    pub status: Option<String>,
    pub path_name: Option<String>,
    pub description: Option<String>,
    pub start_name: Option<String>,
}
