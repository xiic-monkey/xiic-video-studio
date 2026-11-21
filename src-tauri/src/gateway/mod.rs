pub mod anthropic;
pub mod banana_image;
pub mod minimax;
pub mod openai;
pub mod openai_responses;
pub mod qwen_image;
pub mod seedance_video;
pub mod transport;
pub mod tts;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthConfig {
    #[serde(rename = "type")]
    pub kind: String,
    pub key_ref: String,
}

/// 供应商下的一个 API Key。明文只存在系统钥匙串，profile 里只存引用与状态。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderKey {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub key_ref: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// active | cooling | invalid
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub cooldown_until: Option<String>,
    /// 后端注入：钥匙串里是否真的有这个密钥。
    #[serde(default)]
    pub has_secret: bool,
}

fn default_true() -> bool {
    true
}

impl ProviderKey {
    /// 冷却中的 Key 在 cooldown_until 之前不可用；时间解析不了时保守跳过。
    pub fn is_cooling(&self) -> bool {
        if self.status != "cooling" {
            return false;
        }
        match &self.cooldown_until {
            None => true,
            Some(until) => chrono::DateTime::parse_from_rfc3339(until)
                .map(|expire| expire > chrono::Utc::now())
                .unwrap_or(true),
        }
    }
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
    /// 该绑定使用的协议：capability -> protocol。
    #[serde(default)]
    pub protocols: HashMap<String, String>,
    /// 该模型下跨供应商的优先级，数字小的先调用。
    #[serde(default)]
    pub priority: Option<i64>,
    /// 针对该模型停用此供应商。
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub vendor: Option<String>,
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
    #[serde(default)]
    pub keys: Vec<ProviderKey>,
    #[serde(default)]
    pub schema_version: u32,
    /// 后端注入：这个供应商当前有没有可用密钥。
    #[serde(default)]
    pub has_key: bool,
}

impl ProviderProfile {
    /// 这个供应商提供的某个模型条目。
    pub fn model(&self, model_id: &str) -> Option<&ModelConfig> {
        self.models.iter().find(|item| item.id == model_id)
    }

    /// 可用的 Key 引用（key_id, key_ref），按配置顺序。
    ///
    /// 旧版 profile 只有 auth.keyRef（单 Key），这里回退成一条 default 记录。
    pub fn key_refs(&self) -> Vec<(String, String)> {
        if self.keys.is_empty() {
            if self.auth.key_ref.trim().is_empty() {
                return Vec::new();
            }
            return vec![("default".to_string(), self.auth.key_ref.clone())];
        }
        self.keys
            .iter()
            .filter(|key| key.enabled && key.status != "invalid" && !key.is_cooling())
            .map(|key| {
                let key_ref = if key.key_ref.trim().is_empty() {
                    format!("provider/{}/key/{}", self.id, key.id)
                } else {
                    key.key_ref.clone()
                };
                (key.id.clone(), key_ref)
            })
            .collect()
    }
}

/// 一次调用候选：供应商 + Key + 模型 + 协议。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub provider_id: String,
    pub provider_name: String,
    pub base_url: String,
    pub auth_kind: String,
    pub model_id: String,
    pub protocol: String,
    pub key_id: String,
    pub key_ref: String,
    pub key_label: String,
}

#[derive(Debug, Clone)]
pub struct ProviderRuntime {
    pub profile: ProviderProfile,
    pub api_key: String,
    /// 选中的协议（capability -> protocol 解析的结果）。
    pub protocol: String,
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
    // 状态码优先：鉴权、限流、端点错误都有确定的含义，不能被错误体里的
    // 一个 "safety" 关键词改成审核拒绝（那会硬失败且不作废 Key）。
    match status.as_u16() {
        401 => AppError::new("AUTH_UNAUTHORIZED", format!("{label} 鉴权失败，请检查 API Key"), false).with_raw(raw),
        403 => AppError::new("PERM_FORBIDDEN", format!("{label} 无权限访问该模型"), false).with_raw(raw),
        404 => AppError::new("PARAM_ENDPOINT_NOT_FOUND", format!("{label} 端点不存在，请检查 Base URL"), false).with_raw(raw),
        429 => AppError::new("RATE_LIMIT", format!("{label} 限流"), true).with_raw(raw),
        value if (500..=599).contains(&value) => {
            AppError::new("UNAVAILABLE_PROVIDER", format!("{label} 服务不可用（{value}）"), true).with_raw(raw)
        }
        400 | 422 => {
            // 审核拒绝和参数错误都走 400：只有错误体明确提到审核时才算审核拒。
            if lower.contains("moderation") || lower.contains("content policy") || lower.contains("safety") {
                AppError::new("MODERATION_REJECTED", format!("{label} 拒绝了该内容"), false).with_raw(raw)
            } else {
                AppError::new("PARAM_INVALID", format!("{label} 参数无效"), false).with_raw(raw)
            }
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

/// 旧适配器名 → 默认协议。绑定里显式配了 protocols 就用绑定值。
pub fn legacy_protocol(adapter: &str, capability: &str) -> &'static str {
    match (adapter, capability) {
        (_, "text.chat") => "openai-chat",
        (_, "image.generate") | (_, "image.edit") => "openai-images",
        (_, "audio.tts") => "openai-audio",
        ("minimax-h3", "video.generate") => "minimax-video",
        ("bytedance-video", "video.generate") => "seedance-video",
        (_, "video.generate") => "minimax-video",
        _ => "openai-chat",
    }
}

/// 绑定上的协议：优先 model.protocols[capability]，否则回落到旧适配器默认值。
pub fn protocol_for(profile: &ProviderProfile, model_id: &str, capability: &str) -> String {
    profile
        .model(model_id)
        .and_then(|model| model.protocols.get(capability).cloned())
        .unwrap_or_else(|| legacy_protocol(&profile.adapter, capability).to_string())
}

pub async fn execute(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    request: &CapabilityRequest,
) -> Result<AdapterResult, AppError> {
    let result = match runtime.protocol.as_str() {
        "openai-chat" => openai::chat(client, runtime, request).await,
        "openai-images" => match request.capability.as_str() {
            "image.edit" => openai::image_edit(client, runtime, request).await,
            _ => openai::image_generate(client, runtime, request).await,
        },
        "openai-audio" => openai::speech(client, runtime, request).await,
        "openai-responses" => openai_responses::execute(client, runtime, request).await,
        "anthropic-messages" => anthropic::execute(client, runtime, request).await,
        "qwen-image" => qwen_image::execute(client, runtime, request).await,
        "banana-image" => banana_image::execute(client, runtime, request).await,
        "minimax-tts" => tts::minimax_execute(client, runtime, request).await,
        "mimo-tts" => tts::mimo_execute(client, runtime, request).await,
        "minimax-video" => minimax::execute(client, runtime, request).await,
        "seedance-video" => seedance_video::execute(client, runtime, request).await,
        other => Err(AppError::new(
            "CAP_UNSUPPORTED_ADAPTER",
            format!("未实现的协议 {other}"),
            false,
        )),
    };
    // 供应商的错误响应体可能把用户自己的 Key 原样回显（401 的
    // "Incorrect API key provided: sk-xxxx" 是常见写法）。错误会落进运行记录、
    // 事件与导出包，所以离开网关前必须按**值**脱敏——按字段名脱敏抓不到内嵌值。
    result.map_err(|error| redact_secrets(error, &[runtime.api_key.as_str()]))
}

/// 异步任务轮询：按协议分发。
pub async fn poll(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    model: &ModelConfig,
    task_id: &str,
) -> Result<JobStatus, AppError> {
    match runtime.protocol.as_str() {
        "seedance-video" => seedance_video::poll(client, runtime, model, task_id).await,
        "qwen-image" => qwen_image::poll(client, runtime, model, task_id).await,
        "banana-image" => banana_image::poll(client, runtime, model, task_id).await,
        _ => minimax::poll(client, runtime, model, task_id).await,
    }
}

/// 取消异步任务：按协议分发。
pub async fn cancel(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    model: &ModelConfig,
    task_id: &str,
) -> Result<(), AppError> {
    match runtime.protocol.as_str() {
        "seedance-video" => seedance_video::cancel(client, runtime, model, task_id).await,
        "qwen-image" => qwen_image::cancel(client, runtime, model, task_id).await,
        "banana-image" => banana_image::cancel(client, runtime, model, task_id).await,
        _ => minimax::cancel(client, runtime, model, task_id).await,
    }
}

/// 失败是否值得换下一个候选（供应商 / Key）。
///
/// 请求本身有问题（参数错、审核拒）换一家也会一样失败，直接失败；
/// 鉴权 / 限流 / 网络 / 服务端错误换一家或换 Key 可能成功。
pub fn should_fallback(error: &AppError) -> bool {
    matches!(
        error.code.as_str(),
        "AUTH_UNAUTHORIZED"
            | "PERM_FORBIDDEN"
            | "RATE_LIMIT"
            | "UNAVAILABLE_PROVIDER"
            | "TIMEOUT_PROVIDER"
            | "PARAM_ENDPOINT_NOT_FOUND"
            | "UNAVAILABLE_HTTP"
            | "PROVIDER_BAD_RESPONSE"
            | "PROVIDER_BAD_JSON"
            | "UNKNOWN_PROVIDER"
    )
}

/// 明确的鉴权失败：这个 Key 已失效，作废后不再尝试。
/// 注意 403 常是「该模型无权限」而非 Key 失效，只做限时冷却，不能作废。
pub fn invalidates_key(error: &AppError) -> bool {
    matches!(error.code.as_str(), "AUTH_UNAUTHORIZED")
}

/// 临时性失败：Key 可能恢复，限时冷却后还能再用。
pub fn cooldowns_key(error: &AppError) -> bool {
    matches!(
        error.code.as_str(),
        "PERM_FORBIDDEN"
            | "RATE_LIMIT"
            | "UNAVAILABLE_PROVIDER"
            | "TIMEOUT_PROVIDER"
            | "UNKNOWN_PROVIDER"
    )
}

/// 冷却时长（秒）：跨过常见限流窗口，又不至于长期不可用。
pub const KEY_COOLDOWN_SECONDS: i64 = 60;

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
            protocols: HashMap::new(),
            priority: None,
            enabled: None,
            vendor: None,
        }],
        enabled: true,
        keys: Vec::new(),
        schema_version: 2,
        has_key: false,
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

    /// 状态码优先于错误体关键词：401 的错误体里出现 "safety" 仍然是鉴权失败，
    /// 不能被判成审核拒绝（那会硬失败还不作废 Key）。
    #[test]
    fn status_code_wins_over_moderation_keywords_in_the_body() {
        let error = map_http_status(
            reqwest::StatusCode::UNAUTHORIZED,
            "safety system triggered, check your api key",
            "测试",
        );
        assert_eq!(error.code, "AUTH_UNAUTHORIZED");
        assert!(invalidates_key(&error));

        let limited = map_http_status(
            reqwest::StatusCode::TOO_MANY_REQUESTS,
            "slow down: safety quota",
            "测试",
        );
        assert_eq!(limited.code, "RATE_LIMIT");
    }

    /// 400 才可能是审核拒绝：此时错误体提到审核才按审核拒处理。
    #[test]
    fn moderation_keywords_only_apply_to_bad_request() {
        let error = map_http_status(
            reqwest::StatusCode::BAD_REQUEST,
            "content policy violation",
            "测试",
        );
        assert_eq!(error.code, "MODERATION_REJECTED");
        assert!(!should_fallback(&error));

        let plain = map_http_status(
            reqwest::StatusCode::BAD_REQUEST,
            "invalid size parameter",
            "测试",
        );
        assert_eq!(plain.code, "PARAM_INVALID");
    }

    /// 回退策略：换一家供应商能救回来的错误才回退。
    #[test]
    fn fallback_only_for_provider_level_failures() {
        for code in [
            "AUTH_UNAUTHORIZED",
            "PERM_FORBIDDEN",
            "RATE_LIMIT",
            "UNAVAILABLE_PROVIDER",
            "TIMEOUT_PROVIDER",
            "PARAM_ENDPOINT_NOT_FOUND",
            "PROVIDER_BAD_RESPONSE",
            "PROVIDER_BAD_JSON",
            "UNKNOWN_PROVIDER",
        ] {
            assert!(should_fallback(&AppError::new(code, "x", true)), "{code} 应该回退");
        }
        for code in ["PARAM_INVALID", "MODERATION_REJECTED", "CAP_UNSUPPORTED_INPUT"] {
            assert!(!should_fallback(&AppError::new(code, "x", false)), "{code} 不应该回退");
        }
        assert!(invalidates_key(&AppError::new("AUTH_UNAUTHORIZED", "x", false)));
        assert!(!invalidates_key(&AppError::new("PERM_FORBIDDEN", "x", false)));
        assert!(!invalidates_key(&AppError::new("RATE_LIMIT", "x", true)));
        assert!(cooldowns_key(&AppError::new("PERM_FORBIDDEN", "x", false)));
        assert!(cooldowns_key(&AppError::new("RATE_LIMIT", "x", true)));
        assert!(!cooldowns_key(&AppError::new("AUTH_UNAUTHORIZED", "x", false)));
    }

    #[test]
    fn cooling_key_is_skipped_only_until_expiry() {
        let key = ProviderKey {
            id: "k1".to_string(),
            label: "主".to_string(),
            key_ref: "provider/test/key/k1".to_string(),
            enabled: true,
            status: "cooling".to_string(),
            cooldown_until: Some((chrono::Utc::now() + chrono::Duration::seconds(60)).to_rfc3339()),
            has_secret: true,
        };
        assert!(key.is_cooling());
        let expired = ProviderKey { cooldown_until: Some("2020-01-01T00:00:00+00:00".to_string()), ..key.clone() };
        assert!(!expired.is_cooling());
        let active = ProviderKey { status: "active".to_string(), cooldown_until: None, ..key };
        assert!(!active.is_cooling());
    }

    /// 绑定上的协议优先，其次旧适配器默认值。
    #[test]
    fn protocol_comes_from_the_binding_first() {
        let mut profile = test_profile("openai-compatible", "https://example.com");
        profile.models[0].protocols
            .insert("text.chat".to_string(), "anthropic-messages".to_string());
        assert_eq!(protocol_for(&profile, "test-model", "text.chat"), "anthropic-messages");
        assert_eq!(protocol_for(&profile, "test-model", "image.generate"), "openai-images");
        let mut video = test_profile("bytedance-video", "https://example.com");
        video.models[0].capabilities[0].capability = "video.generate".to_string();
        assert_eq!(protocol_for(&video, "test-model", "video.generate"), "seedance-video");
    }

    /// 多 Key 的引用顺序：旧 profile 回落到单 Key，新 profile 按配置顺序。
    #[test]
    fn key_refs_fall_back_to_the_legacy_single_key() {
        let profile = test_profile("openai-compatible", "https://example.com");
        assert_eq!(profile.key_refs(), vec![("default".to_string(), "provider/test".to_string())]);
        let mut multi = profile.clone();
        multi.keys = vec![
            ProviderKey {
                id: "k1".to_string(),
                label: "主".to_string(),
                key_ref: "provider/test/key/k1".to_string(),
                enabled: true,
                status: "active".to_string(),
                cooldown_until: None,
                has_secret: true,
            },
            ProviderKey {
                id: "k2".to_string(),
                label: "备".to_string(),
                key_ref: String::new(),
                enabled: false,
                status: "active".to_string(),
                cooldown_until: None,
                has_secret: true,
            },
        ];
        assert_eq!(multi.key_refs(), vec![("k1".to_string(), "provider/test/key/k1".to_string())]);
    }
}
