//! Google Gemini / Nano Banana 生图适配器。
//!
//! 协议 `banana-image`：同步协议，提交即返回图片（base64）。
use super::{
    join_path, read_json, AdapterResult, AppError, AssetPayload, CapabilityRequest, JobStatus,
    ModelConfig, ProviderRuntime,
};
use serde_json::{json, Value};

const LABEL: &str = "Nano Banana";
/// Gemini 支持的画面比例。
const RATIO_NAMES: [&str; 5] = ["9:16", "16:9", "1:1", "3:4", "4:3"];

pub async fn execute(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    request: &CapabilityRequest,
) -> Result<AdapterResult, AppError> {
    let mut parts = vec![json!({ "text": request.prompt })];
    for input in request.inputs.iter().filter(|item| item.kind == "image") {
        let (mime, data) = inline_image(input)?;
        parts.push(json!({ "inline_data": { "mime_type": mime, "data": data } }));
    }

    let body = json!({
        "contents": [{ "parts": parts }],
        "generationConfig": {
            "responseModalities": ["TEXT", "IMAGE"],
            "imageConfig": {
                "aspectRatio": aspect_ratio(request.params.get("aspectRatio").and_then(Value::as_str), request.params.get("size").and_then(Value::as_str)),
                "imageSize": image_size(request.params.get("resolution").and_then(Value::as_str))
            }
        }
    });

    let url = join_path(
        &runtime.profile.base_url,
        &format!("/v1beta/models/{}:generateContent", request.model),
    );
    let response = client
        .post(url)
        .header("x-goog-api-key", &runtime.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| super::map_reqwest(error, LABEL))?;
    let value = read_json(response, LABEL).await?;
    let outputs = image_outputs(&value)?;
    Ok(AdapterResult {
        status: "succeeded".to_string(),
        outputs,
        task_id: None,
        raw: Some(value),
    })
}

/// 同步协议不会走到轮询；空任务号属于调用错误，按失败返回。
pub async fn poll(
    _client: &reqwest::Client,
    _runtime: &ProviderRuntime,
    _model: &ModelConfig,
    task_id: &str,
) -> Result<JobStatus, AppError> {
    if task_id.trim().is_empty() {
        return Ok(JobStatus {
            status: "failed".to_string(),
            progress: None,
            outputs: Vec::new(),
            raw_status: Some("sync".to_string()),
            error: Some(AppError::new("TASK_FAILED", "同步协议不应进入轮询", false)),
        });
    }
    Ok(JobStatus {
        status: "succeeded".to_string(),
        progress: Some(100.0),
        outputs: Vec::new(),
        raw_status: Some("sync".to_string()),
        error: None,
    })
}

/// 同步协议没有可取消的任务，直接成功。
pub async fn cancel(
    _client: &reqwest::Client,
    _runtime: &ProviderRuntime,
    _model: &ModelConfig,
    _task_id: &str,
) -> Result<(), AppError> {
    Ok(())
}

/// 参考图必须是 data URL 或裸 base64；公网 URL 无法内联。
fn inline_image(input: &super::PreparedInput) -> Result<(String, String), AppError> {
    let value = input.value.trim();
    if value.is_empty() {
        return Err(AppError::new("CAP_UNSUPPORTED_INPUT", "Nano Banana 参考图为空", false));
    }
    if let Some(rest) = value.strip_prefix("data:") {
        let (meta, data) = rest
            .split_once(',')
            .ok_or_else(|| AppError::new("CAP_UNSUPPORTED_INPUT", "Nano Banana 参考图 data URL 格式无效", false))?;
        let mime = meta.split(';').next().unwrap_or("").trim();
        let mime = if mime.is_empty() { "image/png" } else { mime };
        if data.trim().is_empty() {
            return Err(AppError::new("CAP_UNSUPPORTED_INPUT", "Nano Banana 参考图 data URL 缺少数据", false));
        }
        return Ok((mime.to_string(), data.trim().to_string()));
    }
    if value.starts_with("http://") || value.starts_with("https://") {
        return Err(AppError::new(
            "CAP_UNSUPPORTED_INPUT",
            "Nano Banana 参考图需要 data URL 或 base64",
            false,
        ));
    }
    // 裸 base64：mime 用输入自带的。
    let mime = if input.mime.trim().is_empty() { "image/png" } else { input.mime.trim() };
    Ok((mime.to_string(), value.to_string()))
}

/// 画面比例：优先用显式 aspectRatio，否则由 size（宽x高）换算到受支持比例。
///
/// 支持 9:16 / 16:9 / 1:1 / 3:4 / 4:3；按画幅长短边分桶：
/// 竖构图高宽比 ≥ 1.45 记 9:16，横向长宽比 ≥ 1.45 记 16:9，其余取 3:4 / 4:3。
fn aspect_ratio(explicit: Option<&str>, size: Option<&str>) -> String {
    if let Some(ratio) = explicit {
        let trimmed = ratio.trim();
        if RATIO_NAMES.contains(&trimmed) {
            return trimmed.to_string();
        }
    }
    let Some(size) = size else { return "1:1".to_string() };
    let Some((width, height)) = parse_size(size) else { return "1:1".to_string() };
    if width == 0 || height == 0 {
        return "1:1".to_string();
    }
    if width == height {
        return "1:1".to_string();
    }
    let long = width.max(height) as f64;
    let short = width.min(height) as f64;
    let ratio = long / short;
    if width > height {
        if ratio >= 1.45 {
            "16:9".to_string()
        } else {
            "4:3".to_string()
        }
    } else if ratio >= 1.45 {
        "9:16".to_string()
    } else {
        "3:4".to_string()
    }
}

/// "1024x1536" → (1024, 1536)。
fn parse_size(size: &str) -> Option<(u32, u32)> {
    let trimmed = size.trim().to_ascii_lowercase();
    let separator = trimmed.find(|ch| ch == 'x' || ch == '*')?;
    let (width, height) = trimmed.split_at(separator);
    let height = &height[1..];
    let width = width.trim().parse::<u32>().ok()?;
    let height = height.trim().parse::<u32>().ok()?;
    Some((width, height))
}

/// 图片分辨率只允许 1K / 2K。
fn image_size(resolution: Option<&str>) -> String {
    let value = resolution.unwrap_or("").trim().to_ascii_uppercase();
    if value == "2K" {
        return "2K".to_string();
    }
    "1K".to_string()
}

/// 从 candidates[0].content.parts[] 里取出 inlineData。
fn image_outputs(value: &Value) -> Result<Vec<AssetPayload>, AppError> {
    let parts = value
        .pointer("/candidates/0/content/parts")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            AppError::new("PROVIDER_BAD_RESPONSE", "Nano Banana 未返回图片", false)
                .with_raw(value.to_string())
        })?;
    let mut outputs = Vec::new();
    for part in parts {
        let inline = part.get("inlineData").or_else(|| part.get("inline_data"));
        let Some(inline) = inline else { continue };
        let Some(data) = inline.get("data").and_then(Value::as_str) else { continue };
        if data.is_empty() {
            continue;
        }
        let mime = inline
            .get("mimeType")
            .or_else(|| inline.get("mime_type"))
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .unwrap_or("image/png");
        outputs.push(AssetPayload {
            kind: "image".to_string(),
            mime: mime.to_string(),
            url: None,
            data: Some(data.to_string()),
        });
    }
    if outputs.is_empty() {
        return Err(AppError::new("PROVIDER_BAD_RESPONSE", "Nano Banana 未返回图片", false)
            .with_raw(value.to_string()));
    }
    Ok(outputs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway::{test_profile, CapabilityRequest, PreparedInput, ProviderRuntime};
    use serde_json::json;
    use wiremock::matchers::{body_partial_json, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn model() -> crate::gateway::ModelConfig {
        crate::gateway::ModelConfig {
            id: "test-model".to_string(),
            display_name: "Test Model".to_string(),
            capabilities: Vec::new(),
            defaults: json!({}),
            protocols: std::collections::HashMap::new(),
            priority: None,
            enabled: None,
            vendor: None,
        }
    }

    fn runtime(base_url: &str) -> ProviderRuntime {
        let mut profile = test_profile("gemini", base_url);
        profile.models = vec![model()];
        ProviderRuntime {
            profile,
            api_key: "test-key".to_string(),
            protocol: "banana-image".to_string(),
        }
    }

    fn request() -> CapabilityRequest {
        CapabilityRequest {
            capability: "image.generate".to_string(),
            model: "test-model".to_string(),
            prompt: "雨夜街头".to_string(),
            negative: None,
            params: json!({ "count": 2, "size": "1024x1536", "resolution": "2K" }),
            inputs: vec![PreparedInput {
                role: "reference_image".to_string(),
                kind: "image".to_string(),
                mime: "image/png".to_string(),
                value: "data:image/png;base64,aGVsbG8=".to_string(),
            }],
            client_request_id: "req_1".to_string(),
        }
    }

    #[tokio::test]
    async fn submit_returns_inline_image() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1beta/models/test-model:generateContent"))
            .and(body_partial_json(json!({
                "contents": [{
                    "parts": [
                        { "text": "雨夜街头" },
                        { "inline_data": { "mime_type": "image/png", "data": "aGVsbG8=" } }
                    ]
                }],
                "generationConfig": {
                    "responseModalities": ["TEXT", "IMAGE"],
                    "imageConfig": { "imageSize": "2K" }
                }
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "candidates": [{
                    "content": { "parts": [
                        { "text": "描述" },
                        { "inlineData": { "mimeType": "image/png", "data": "aGVsbG8=" } }
                    ] }
                }]
            })))
            .mount(&server)
            .await;
        let result = execute(&reqwest::Client::new(), &runtime(&server.uri()), &request())
            .await
            .expect("submit");
        assert_eq!(result.status, "succeeded");
        assert_eq!(result.outputs.len(), 1);
        assert_eq!(result.outputs[0].data.as_deref(), Some("aGVsbG8="));
        assert_eq!(result.outputs[0].mime, "image/png");
    }

    #[tokio::test]
    async fn text_only_response_is_rejected() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1beta/models/test-model:generateContent"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "candidates": [{ "content": { "parts": [{ "text": "只有文字" }] } }]
            })))
            .mount(&server)
            .await;
        let error = execute(&reqwest::Client::new(), &runtime(&server.uri()), &request())
            .await
            .expect_err("no image");
        assert_eq!(error.code, "PROVIDER_BAD_RESPONSE");
    }

    #[tokio::test]
    async fn remote_reference_image_is_rejected() {
        let server = MockServer::start().await;
        let mut request = request();
        request.inputs[0].value = "https://cdn.example.com/ref.png".to_string();
        let error = execute(&reqwest::Client::new(), &runtime(&server.uri()), &request)
            .await
            .expect_err("url input");
        assert_eq!(error.code, "CAP_UNSUPPORTED_INPUT");
    }

    #[tokio::test]
    async fn poll_is_a_noop_for_sync_protocol() {
        let status = poll(
            &reqwest::Client::new(),
            &runtime("http://127.0.0.1:1"),
            &model(),
            "task-1",
        )
        .await
        .expect("poll");
        assert_eq!(status.status, "succeeded");
        assert_eq!(status.raw_status.as_deref(), Some("sync"));
    }

    #[tokio::test]
    async fn unauthorized_maps_to_auth_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1beta/models/test-model:generateContent"))
            .respond_with(ResponseTemplate::new(401).set_body_string("unauthorized"))
            .mount(&server)
            .await;
        let error = execute(&reqwest::Client::new(), &runtime(&server.uri()), &request())
            .await
            .expect_err("auth");
        assert_eq!(error.code, "AUTH_UNAUTHORIZED");
    }
}
