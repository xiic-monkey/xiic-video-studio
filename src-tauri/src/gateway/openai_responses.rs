use super::{
    api_url, map_reqwest, read_json, AdapterResult, AppError, AssetPayload, CapabilityRequest,
    ProviderRuntime,
};
use serde_json::{json, Value};

const LABEL: &str = "OpenAI Responses";

/// OpenAI Responses 协议：POST {base}/v1/responses。
pub async fn execute(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    request: &CapabilityRequest,
) -> Result<AdapterResult, AppError> {
    let system = request.params.get("system").and_then(Value::as_str).unwrap_or("").trim();
    let mut body = json!({
        "model": request.model,
        "input": request.prompt,
        "stream": false
    });
    // system 为空时不下发 instructions，避免覆盖供应商侧的默认系统提示。
    if !system.is_empty() {
        body["instructions"] = json!(system);
    }
    let response = client
        .post(api_url(&runtime.profile.base_url, "responses"))
        .bearer_auth(&runtime.api_key)
        .header("Idempotency-Key", &request.client_request_id)
        .json(&body)
        .send()
        .await
        .map_err(|error| map_reqwest(error, LABEL))?;
    let value = read_json(response, LABEL).await?;
    let text = extract_text(&value).ok_or_else(|| {
        AppError::new("PROVIDER_BAD_RESPONSE", "Responses 响应缺少 output_text", false)
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

/// 取正文：优先顶层 `output_text`，否则遍历 `output[].content[]` 里的 `output_text`。
fn extract_text(value: &Value) -> Option<String> {
    if let Some(text) = value.get("output_text").and_then(Value::as_str) {
        if !text.trim().is_empty() {
            return Some(text.to_string());
        }
    }
    let mut parts: Vec<String> = Vec::new();
    if let Some(items) = value.get("output").and_then(Value::as_array) {
        for item in items {
            let Some(contents) = item.get("content").and_then(Value::as_array) else {
                continue;
            };
            for content in contents {
                if content.get("type").and_then(Value::as_str) != Some("output_text") {
                    continue;
                }
                if let Some(text) = content.get("text").and_then(Value::as_str) {
                    if !text.is_empty() {
                        parts.push(text.to_string());
                    }
                }
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
            protocol: "openai-responses".to_string(),
        }
    }

    fn request() -> CapabilityRequest {
        CapabilityRequest {
            capability: "text.chat".to_string(),
            model: "test-model".to_string(),
            prompt: "雨夜街头".to_string(),
            negative: None,
            params: json!({ "system": "你是编剧" }),
            inputs: Vec::new(),
            client_request_id: "req_1".to_string(),
        }
    }

    #[tokio::test]
    async fn parses_top_level_output_text() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/responses"))
            .and(header("authorization", "Bearer test-key"))
            .and(header("idempotency-key", "req_1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "output_text": "第一场：雨夜"
            })))
            .mount(&server)
            .await;
        let result = execute(&reqwest::Client::new(), &runtime(&server.uri()), &request())
            .await
            .expect("responses");
        assert_eq!(result.status, "succeeded");
        assert_eq!(result.outputs.len(), 1);
        assert_eq!(result.outputs[0].kind, "text");
        assert_eq!(result.outputs[0].mime, "text/plain");
        assert_eq!(result.outputs[0].data.as_deref(), Some("第一场：雨夜"));
        assert!(result.task_id.is_none());
    }

    #[tokio::test]
    async fn falls_back_to_output_content_blocks() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/responses"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "output": [
                    {
                        "type": "message",
                        "content": [
                            { "type": "output_text", "text": "第一段" },
                            { "type": "refusal", "text": "ignored" },
                            { "type": "output_text", "text": "第二段" }
                        ]
                    }
                ]
            })))
            .mount(&server)
            .await;
        let result = execute(&reqwest::Client::new(), &runtime(&server.uri()), &request())
            .await
            .expect("responses");
        assert_eq!(result.outputs[0].data.as_deref(), Some("第一段\n第二段"));
    }

    #[tokio::test]
    async fn sends_model_input_and_instructions() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/responses"))
            .and(body_partial_json(json!({
                "model": "test-model",
                "input": "雨夜街头",
                "instructions": "你是编剧",
                "stream": false
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "output_text": "ok" })))
            .mount(&server)
            .await;
        let result = execute(&reqwest::Client::new(), &runtime(&server.uri()), &request())
            .await
            .expect("responses");
        assert_eq!(result.outputs[0].data.as_deref(), Some("ok"));
    }

    #[tokio::test]
    async fn missing_text_is_a_bad_response() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/responses"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "id": "resp_1" })))
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
            .and(path("/v1/responses"))
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
