use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EntityEnvelope {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub schema_version: i64,
    pub revision: i64,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChangeResult {
    pub change_id: String,
    pub revision_map: std::collections::HashMap<String, i64>,
    pub affected_ids: Vec<String>,
}
