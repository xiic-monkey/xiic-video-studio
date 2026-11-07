pub mod minimax;
pub mod openai;
pub mod transport;

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
    let result = match runtime.profile.adapter.as_str() {
        "openai-compatible" => openai::execute(client, runtime, request).await,
        "minimax-h3" => minimax::execute(client, runtime, request).await,
        other => Err(AppError::new(
            "CAP_UNSUPPORTED_ADAPTER",
            format!("P0 未实现适配器 {other}"),
            false,
        )),
    };
    // 供应商的错误响应体可能把用户自己的 Key 原样回显（401 的
    // "Incorrect API key provided: sk-xxxx" 是常见写法）。错误会落进运行记录、
    // 事件与导出包，所以离开网关前必须按**值**脱敏——按字段名脱敏抓不到内嵌值。
    result.map_err(|error| redact_secrets(error, &[runtime.api_key.as_str()]))
}

/// 脱敏后的密钥占位符。
pub const REDACTED_SECRET: &str = "***";

/// 短于此长度的「密钥」不参与脱敏：短串会误伤正常文案。
const MIN_REDACTABLE_LEN: usize = 8;

/// 把字符串里出现的密钥值替换掉。
pub fn redact_secret(text: &str, secret: &str) -> String {
    let secret = secret.trim();
    if secret.len() < MIN_REDACTABLE_LEN {
        return text.to_string();
    }
    text.replace(secret, REDACTED_SECRET)
}

/// 递归替换 JSON 里的字符串值。
fn redact_secret_in_value(value: &mut Value, secret: &str) {
    match value {
        Value::String(text) => *text = redact_secret(text, secret),
        Value::Array(items) => {
            for item in items.iter_mut() {
                redact_secret_in_value(item, secret);
            }
        }
        Value::Object(map) => {
            for nested in map.values_mut() {
                redact_secret_in_value(nested, secret);
            }
        }
        _ => {}
    }
}

/// 把错误里的密钥值脱敏掉。
///
/// 覆盖 message / provider_raw / details 三处：错误正文、供应商原始响应体、
/// 以及结构化细节里都可能内嵌密钥值。
pub fn redact_secrets(mut error: AppError, secrets: &[&str]) -> AppError {
    for secret in secrets {
        error.message = redact_secret(&error.message, secret);
        error.provider_raw = error
            .provider_raw
            .as_ref()
            .map(|raw| redact_secret(raw, secret));
        if let Some(details) = error.details.as_mut() {
            redact_secret_in_value(details, secret);
        }
    }
    error
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 供应商的 401 错误体常把用户自己的 Key 原样回显。
    /// 这条错误会落进运行记录、事件与导出包，所以必须按值脱敏。
    #[test]
    fn provider_errors_never_carry_the_api_key_value() {
        let key = "sk-live-abcdef0123456789";
        let error = AppError::new("AUTH_UNAUTHORIZED", "鉴权失败", false)
            .with_raw(format!("{{\"error\":{{\"message\":\"Incorrect API key provided: {key}\"}}}}"));
        let mut error = error;
        error.details = Some(json!({ "echo": key, "nested": [{ "value": key }] }));

        let redacted = redact_secrets(error, &[key]);
        assert!(!redacted.message.contains(key));
        let raw = redacted.provider_raw.as_deref().unwrap_or("");
        assert!(!raw.contains(key), "供应商原始响应体里还留着密钥：{raw}");
        assert!(raw.contains(REDACTED_SECRET));
        let details = redacted.details.unwrap();
        assert!(!details.to_string().contains(key), "结构化细节里还留着密钥");
    }

    /// 脱敏不能把正常文案改成乱码：太短的串不参与替换。
    #[test]
    fn short_values_are_left_alone() {
        assert_eq!(redact_secret("模型 abc 不可用", "abc"), "模型 abc 不可用");
        assert_eq!(
            redact_secret("模型 sk-live-0123456789 不可用", "sk-live-0123456789"),
            format!("模型 {REDACTED_SECRET} 不可用")
        );
    }

    /// 多个密钥一起脱敏：素材外链的 access key 与 secret key 都在同一批里。
    #[test]
    fn multiple_secrets_are_redacted() {
        let error = AppError::new("STORAGE_UPLOAD_FAILED", "上传失败 ak-0123456789", true)
            .with_raw("sk-9876543210 / ak-0123456789".to_string());
        let redacted = redact_secrets(error, &["sk-9876543210", "ak-0123456789"]);
        assert!(!redacted.message.contains("ak-0123456789"));
        let raw = redacted.provider_raw.as_deref().unwrap_or("");
        assert!(!raw.contains("sk-9876543210"));
        assert!(!raw.contains("ak-0123456789"));
    }
}
