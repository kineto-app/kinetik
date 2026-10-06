use serde::{Deserialize, Serialize};
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRequest {
    pub key: Option<String>,
    pub value: Option<String>,
    pub active: Option<bool>,
    pub url: Option<String>,
    /// Background work includes a run the user started.
    pub started: Option<bool>,
}
#[derive(Debug, Deserialize, Serialize, Default)]
pub struct NativeResponse {
    pub value: Option<String>,
}
