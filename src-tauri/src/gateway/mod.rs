pub mod openai;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthConfig {
    #[serde(rename = "type")]
    pub kind: String,
    pub key_ref: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCapability {
    pub capability: String,
    #[serde(default)]
    pub input_transport: Vec<String>,
    #[serde(default, rename = "async")]
    pub async_job: bool,
    #[serde(default)]
    pub durations: Option<Value>,
    #[serde(default)]
    pub max_prompt_chars: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelConfig {
    pub id: String,
    pub display_name: String,
    #[serde(default)]
    pub capabilities: Vec<ModelCapability>,
    #[serde(default)]
    pub defaults: Value,
}

impl ModelConfig {
    pub fn capability(&self, name: &str) -> Option<&ModelCapability> {
        self.capabilities.iter().find(|item| item.capability == name)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProfile {
    pub id: String,
    pub name: String,
    pub adapter: String,
    pub base_url: String,
    pub auth: AuthConfig,
    #[serde(default)]
    pub models: Vec<ModelConfig>,
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Debug, Clone)]
pub struct ProviderRuntime {
    pub profile: ProviderProfile,
    pub api_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedInput {
    pub role: String,
    pub kind: String,
    pub mime: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityRequest {
    pub capability: String,
    pub model: String,
    pub prompt: String,
    #[serde(default)]
    pub negative: Option<String>,
    #[serde(default)]
    pub params: Value,
    #[serde(default)]
    pub inputs: Vec<PreparedInput>,
    pub client_request_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetPayload {
    pub kind: String,
    pub mime: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub data: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterResult {
    pub status: String,
    #[serde(default)]
    pub outputs: Vec<AssetPayload>,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub raw: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(default)]
    pub provider_raw: Option<String>,
    #[serde(default)]
    pub details: Option<Value>,
}

impl AppError {
    pub fn new(code: &str, message: impl Into<String>, retryable: bool) -> Self {
        Self { code: code.to_string(), message: message.into(), retryable, provider_raw: None, details: None }
    }

    pub fn with_raw(mut self, raw: String) -> Self {
        self.provider_raw = Some(raw.chars().take(800).collect());
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobStatus {
    pub status: String,
    #[serde(default)]
    pub progress: Option<f64>,
    #[serde(default)]
    pub outputs: Vec<AssetPayload>,
    #[serde(default)]
    pub raw_status: Option<String>,
    #[serde(default)]
    pub error: Option<AppError>,
}

pub fn join_path(base: &str, path: &str) -> String {
    if path.starts_with("http://") || path.starts_with("https://") {
        return path.to_string();
    }
    format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'))
}

pub fn api_url(base: &str, path: &str) -> String {
    let trimmed = base.trim_end_matches('/');
    if trimmed.ends_with("/v1") {
        format!("{trimmed}/{}", path.trim_start_matches('/'))
    } else {
        format!("{trimmed}/v1/{}", path.trim_start_matches('/'))
    }
}

pub fn map_http_status(status: reqwest::StatusCode, body: &str, label: &str) -> AppError {
    let lower = body.to_ascii_lowercase();
    let raw = body.chars().take(800).collect::<String>();
    if lower.contains("moderation") || lower.contains("content policy") || lower.contains("safety") {
        return AppError::new("MODERATION_REJECTED", format!("{label} 拒绝了该内容"), false).with_raw(raw);
    }
    match status.as_u16() {
        401 => AppError::new("AUTH_UNAUTHORIZED", format!("{label} 鉴权失败，请检查 API Key"), false).with_raw(raw),
        403 => AppError::new("PERM_FORBIDDEN", format!("{label} 无权限访问该模型"), false).with_raw(raw),
        404 => AppError::new("PARAM_ENDPOINT_NOT_FOUND", format!("{label} 端点不存在，请检查 Base URL"), false).with_raw(raw),
        400 | 422 => AppError::new("PARAM_INVALID", format!("{label} 参数无效"), false).with_raw(raw),
        429 => AppError::new("RATE_LIMIT", format!("{label} 限流"), true).with_raw(raw),
        value if (500..=599).contains(&value) => {
            AppError::new("UNAVAILABLE_PROVIDER", format!("{label} 服务不可用（{value}）"), true).with_raw(raw)
        }
        value => AppError::new("UNKNOWN_PROVIDER", format!("{label} 返回错误 {value}"), false).with_raw(raw),
    }
}

pub fn map_reqwest(error: reqwest::Error, label: &str) -> AppError {
    if error.is_timeout() {
        AppError::new("TIMEOUT_PROVIDER", format!("{label} 请求超时"), true)
    } else if error.is_connect() {
        AppError::new("UNAVAILABLE_PROVIDER", format!("{label} 连接失败"), true)
    } else {
        AppError::new("UNKNOWN_PROVIDER", format!("{label} 请求失败：{error}"), false)
    }
}

pub async fn read_json(response: reqwest::Response, label: &str) -> Result<Value, AppError> {
    let status = response.status();
    let text = response.text().await.map_err(|error| map_reqwest(error, label))?;
    if !status.is_success() {
        return Err(map_http_status(status, &text, label));
    }
    serde_json::from_str(&text).map_err(|_| {
        AppError::new("PROVIDER_BAD_JSON", format!("{label} 返回了非 JSON 响应"), false)
            .with_raw(text)
    })
}

pub async fn execute(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    request: &CapabilityRequest,
) -> Result<AdapterResult, AppError> {
    match runtime.profile.adapter.as_str() {
        "openai-compatible" => openai::execute(client, runtime, request).await,
        other => Err(AppError::new(
            "CAP_UNSUPPORTED_ADAPTER",
            format!("P0 未实现适配器 {other}"),
            false,
        )),
    }
}

#[cfg(test)]
pub fn test_profile(adapter: &str, base_url: &str) -> ProviderProfile {
    ProviderProfile {
        id: "test".to_string(),
        name: "Test".to_string(),
        adapter: adapter.to_string(),
        base_url: base_url.to_string(),
        auth: AuthConfig { kind: "bearer".to_string(), key_ref: "provider/test".to_string() },
        models: vec![ModelConfig {
            id: "test-model".to_string(),
            display_name: "Test Model".to_string(),
            capabilities: vec![ModelCapability {
                capability: "text.chat".to_string(),
                input_transport: vec!["dataUrl".to_string()],
                async_job: false,
                durations: None,
                max_prompt_chars: None,
            }],
            defaults: Value::Null,
        }],
        enabled: true,
    }
}
