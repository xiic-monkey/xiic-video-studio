use super::{
    api_url, map_reqwest, read_json, AdapterResult, AppError, AssetPayload, CapabilityRequest,
    ProviderRuntime,
};
use serde_json::{json, Value};

const LABEL: &str = "Anthropic Messages";

/// Anthropic Messages 协议：POST {base}/v1/messages。
pub async fn execute(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    request: &CapabilityRequest,
) -> Result<AdapterResult, AppError> {
    let system = request.params.get("system").and_then(Value::as_str).unwrap_or("").trim();
    let max_tokens = request
        .params
        .get("maxTokens")
        .and_then(Value::as_u64)
        .or_else(|| request.params.get("max_tokens").and_then(Value::as_u64))
        .unwrap_or(4096);
    let mut body = json!({
        "model": request.model,
        "max_tokens": max_tokens,
        "messages": [{ "role": "user", "content": request.prompt }]
    });
    // system 为空时不下发该字段。
    if !system.is_empty() {
        body["system"] = json!(system);
    }
    let response = client
        .post(api_url(&runtime.profile.base_url, "messages"))
        .header("x-api-key", &runtime.api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .body(serde_json::to_vec(&body).unwrap_or_default())
        .send()
        .await
        .map_err(|error| map_reqwest(error, LABEL))?;
    let value = read_json(response, LABEL).await?;
    let text = extract_text(&value).ok_or_else(|| {
        AppError::new("PROVIDER_BAD_RESPONSE", "Anthropic 响应缺少文本内容", false)
            .with_raw(value.to_string())
    })?;
    Ok(AdapterResult {
        status: "succeeded".to_string(),
        outputs: vec![AssetPayload {
            kind: "text".to_string(),
            mime: "text/plain".to_string(),
            url: None,
            data: Some(text),
        }],
        task_id: None,
        raw: Some(value),
    })
}

/// 取 `content[]` 里 type == "text" 的文本片段，用换行拼接。
fn extract_text(value: &Value) -> Option<String> {
    let contents = value.get("content").and_then(Value::as_array)?;
    let mut parts: Vec<String> = Vec::new();
    for content in contents {
        if content.get("type").and_then(Value::as_str) != Some("text") {
            continue;
        }
        if let Some(text) = content.get("text").and_then(Value::as_str) {
            if !text.is_empty() {
                parts.push(text.to_string());
            }
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway::{CapabilityRequest, ProviderRuntime};
    use serde_json::json;
    use wiremock::matchers::{body_partial_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn runtime(base_url: &str) -> ProviderRuntime {
        ProviderRuntime {
            profile: crate::gateway::test_profile("openai-compatible", base_url),
            api_key: "test-key".to_string(),
            protocol: "anthropic-messages".to_string(),
        }
    }

    fn request() -> CapabilityRequest {
        CapabilityRequest {
            capability: "text.chat".to_string(),
            model: "claude-test".to_string(),
            prompt: "雨夜街头".to_string(),
            negative: None,
            params: json!({ "system": "你是编剧", "maxTokens": 1024 }),
            inputs: Vec::new(),
            client_request_id: "req_1".to_string(),
        }
    }

    #[tokio::test]
    async fn parses_text_content_blocks() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .and(header("x-api-key", "test-key"))
            .and(header("anthropic-version", "2023-06-01"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "content": [
                    { "type": "text", "text": "第一段" },
                    { "type": "tool_use", "id": "t1" },
                    { "type": "text", "text": "第二段" }
                ]
            })))
            .mount(&server)
            .await;
        let result = execute(&reqwest::Client::new(), &runtime(&server.uri()), &request())
            .await
            .expect("messages");
        assert_eq!(result.status, "succeeded");
        assert_eq!(result.outputs[0].kind, "text");
        assert_eq!(result.outputs[0].data.as_deref(), Some("第一段\n第二段"));
    }

    #[tokio::test]
    async fn sends_model_max_tokens_and_system() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .and(body_partial_json(json!({
                "model": "claude-test",
                "max_tokens": 1024,
                "system": "你是编剧",
                "messages": [{ "role": "user", "content": "雨夜街头" }]
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "content": [{ "type": "text", "text": "ok" }]
            })))
            .mount(&server)
            .await;
        let result = execute(&reqwest::Client::new(), &runtime(&server.uri()), &request())
            .await
            .expect("messages");
        assert_eq!(result.outputs[0].data.as_deref(), Some("ok"));
    }

    #[tokio::test]
    async fn missing_content_is_a_bad_response() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "id": "msg_1" })))
            .mount(&server)
            .await;
        let error = execute(&reqwest::Client::new(), &runtime(&server.uri()), &request())
            .await
            .expect_err("bad response");
        assert_eq!(error.code, "PROVIDER_BAD_RESPONSE");
        assert!(error.provider_raw.is_some());
    }

    #[tokio::test]
    async fn unauthorized_maps_to_auth_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/messages"))
            .respond_with(ResponseTemplate::new(401).set_body_string("unauthorized"))
            .mount(&server)
            .await;
        let error = execute(&reqwest::Client::new(), &runtime(&server.uri()), &request())
            .await
            .expect_err("auth");
        assert_eq!(error.code, "AUTH_UNAUTHORIZED");
        assert!(!error.retryable);
    }
}
