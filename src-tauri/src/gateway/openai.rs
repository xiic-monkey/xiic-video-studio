use super::{
    api_url, map_reqwest, read_json, AdapterResult, AppError, AssetPayload, CapabilityRequest,
    ProviderRuntime,
};
use base64::Engine;
use serde_json::{json, Value};

pub async fn execute(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    request: &CapabilityRequest,
) -> Result<AdapterResult, AppError> {
    match request.capability.as_str() {
        "text.chat" => chat(client, runtime, request).await,
        "image.generate" => image_generate(client, runtime, request).await,
        "image.edit" => image_edit(client, runtime, request).await,
        "audio.tts" => speech(client, runtime, request).await,
        other => Err(AppError::new(
            "CAP_UNSUPPORTED_CAPABILITY",
            format!("OpenAI 兼容适配器不支持 {other}"),
            false,
        )),
    }
}

async fn chat(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    request: &CapabilityRequest,
) -> Result<AdapterResult, AppError> {
    let system = request.params.get("system").and_then(Value::as_str).unwrap_or("").trim();
    let mut messages = Vec::new();
    if !system.is_empty() {
        messages.push(json!({ "role": "system", "content": system }));
    }
    messages.push(json!({ "role": "user", "content": request.prompt }));
    let response = client
        .post(api_url(&runtime.profile.base_url, "chat/completions"))
        .bearer_auth(&runtime.api_key)
        .header("Idempotency-Key", &request.client_request_id)
        .json(&json!({ "model": request.model, "messages": messages, "stream": false }))
        .send()
        .await
        .map_err(|error| map_reqwest(error, "OpenAI 兼容文本"))?;
    let value = read_json(response, "OpenAI 兼容文本").await?;
    let content = value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::new("PROVIDER_BAD_RESPONSE", "文本响应缺少 choices[0].message.content", false).with_raw(value.to_string()))?;
    Ok(AdapterResult {
        status: "succeeded".to_string(),
        outputs: vec![AssetPayload { kind: "text".to_string(), mime: "text/plain".to_string(), url: None, data: Some(content.to_string()) }],
        task_id: None,
        raw: Some(value),
    })
}

async fn image_generate(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    request: &CapabilityRequest,
) -> Result<AdapterResult, AppError> {
    let count = request.params.get("count").and_then(Value::as_u64).unwrap_or(1).clamp(1, 4);
    let size = request.params.get("size").and_then(Value::as_str).unwrap_or("1024x1536");
    let response = client
        .post(api_url(&runtime.profile.base_url, "images/generations"))
        .bearer_auth(&runtime.api_key)
        .json(&json!({
            "model": request.model,
            "prompt": request.prompt,
            "n": count,
            "size": size,
            "response_format": "b64_json"
        }))
        .send()
        .await
        .map_err(|error| map_reqwest(error, "OpenAI 兼容图片"))?;
    let value = read_json(response, "OpenAI 兼容图片").await?;
    let outputs = image_outputs(&value)?;
    Ok(AdapterResult { status: "succeeded".to_string(), outputs, task_id: None, raw: Some(value) })
}

async fn image_edit(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    request: &CapabilityRequest,
) -> Result<AdapterResult, AppError> {
    let first = request.inputs.iter().find(|input| input.kind == "image")
        .ok_or_else(|| AppError::new("CAP_UNSUPPORTED_INPUT", "图片编辑需要至少一张参考图", false))?;
    let (mime, bytes) = decode_data_input(&first.value)?;
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name("image.png")
        .mime_str(&mime)
        .map_err(|error| AppError::new("PARAM_INVALID", format!("图片 MIME 无效：{error}"), false))?;
    let form = reqwest::multipart::Form::new()
        .text("model", request.model.clone())
        .text("prompt", request.prompt.clone())
        .text("n", request.params.get("count").and_then(Value::as_u64).unwrap_or(1).to_string())
        .text("size", request.params.get("size").and_then(Value::as_str).unwrap_or("1024x1536").to_string())
        .text("response_format", "b64_json")
        .part("image", part);
    let response = client
        .post(api_url(&runtime.profile.base_url, "images/edits"))
        .bearer_auth(&runtime.api_key)
        .multipart(form)
        .send()
        .await
        .map_err(|error| map_reqwest(error, "OpenAI 兼容图片编辑"))?;
    let value = read_json(response, "OpenAI 兼容图片编辑").await?;
    let outputs = image_outputs(&value)?;
    Ok(AdapterResult { status: "succeeded".to_string(), outputs, task_id: None, raw: Some(value) })
}

async fn speech(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    request: &CapabilityRequest,
) -> Result<AdapterResult, AppError> {
    let voice = request.params.get("voice").and_then(Value::as_str).unwrap_or("alloy");
    let format = request.params.get("format").and_then(Value::as_str).unwrap_or("mp3");
    let response = client
        .post(api_url(&runtime.profile.base_url, "audio/speech"))
        .bearer_auth(&runtime.api_key)
        .json(&json!({
            "model": request.model,
            "voice": voice,
            "input": request.prompt,
            "response_format": format
        }))
        .send()
        .await
        .map_err(|error| map_reqwest(error, "OpenAI 兼容语音"))?;
    let status = response.status();
    let bytes = response.bytes().await.map_err(|error| map_reqwest(error, "OpenAI 兼容语音"))?;
    if !status.is_success() {
        return Err(super::map_http_status(status, &String::from_utf8_lossy(&bytes), "OpenAI 兼容语音"));
    }
    let mime = match format {
        "wav" => "audio/wav",
        "opus" => "audio/ogg",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        _ => "audio/mpeg",
    };
    Ok(AdapterResult {
        status: "succeeded".to_string(),
        outputs: vec![AssetPayload {
            kind: "audio".to_string(),
            mime: mime.to_string(),
            url: None,
            data: Some(base64::engine::general_purpose::STANDARD.encode(&bytes)),
        }],
        task_id: None,
        raw: None,
    })
}

fn image_outputs(value: &Value) -> Result<Vec<AssetPayload>, AppError> {
    let data = value.get("data").and_then(Value::as_array)
        .ok_or_else(|| AppError::new("PROVIDER_BAD_RESPONSE", "图片响应缺少 data 数组", false).with_raw(value.to_string()))?;
    let outputs: Vec<AssetPayload> = data.iter().filter_map(|item| {
        if let Some(b64) = item.get("b64_json").and_then(Value::as_str) {
            Some(AssetPayload { kind: "image".to_string(), mime: "image/png".to_string(), url: None, data: Some(b64.to_string()) })
        } else {
            item.get("url").and_then(Value::as_str).map(|url| AssetPayload {
                kind: "image".to_string(), mime: "image/png".to_string(), url: Some(url.to_string()), data: None,
            })
        }
    }).collect();
    if outputs.is_empty() {
        return Err(AppError::new("PROVIDER_BAD_RESPONSE", "图片响应没有 url 或 b64_json", false).with_raw(value.to_string()));
    }
    Ok(outputs)
}

fn decode_data_input(value: &str) -> Result<(String, Vec<u8>), AppError> {
    let (mime, bytes) = crate::assets::decode_data_url(value)
        .ok_or_else(|| AppError::new("CAP_UNSUPPORTED_INPUT", "图片编辑 P0 只接受 data URL 参考图", false))?;
    Ok((mime, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway::{CapabilityRequest, ProviderRuntime};
    use serde_json::json;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn runtime(base_url: &str) -> ProviderRuntime {
        ProviderRuntime {
            profile: crate::gateway::test_profile("openai-compatible", base_url),
            api_key: "test-key".to_string(),
        }
    }

    fn request(capability: &str) -> CapabilityRequest {
        CapabilityRequest {
            capability: capability.to_string(),
            model: "test-model".to_string(),
            prompt: "雨夜街头".to_string(),
            negative: None,
            params: json!({ "system": "你是编剧", "count": 2, "size": "1024x1536", "voice": "alloy", "format": "mp3" }),
            inputs: Vec::new(),
            client_request_id: "req_1".to_string(),
        }
    }

    #[tokio::test]
    async fn chat_returns_text_output() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(header("authorization", "Bearer test-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{ "message": { "content": "第一场：雨夜" } }]
            })))
            .mount(&server)
            .await;
        let result = execute(&reqwest::Client::new(), &runtime(&server.uri()), &request("text.chat"))
            .await
            .expect("chat");
        assert_eq!(result.status, "succeeded");
        assert_eq!(result.outputs[0].kind, "text");
        assert_eq!(result.outputs[0].data.as_deref(), Some("第一场：雨夜"));
    }

    #[tokio::test]
    async fn image_generation_decodes_b64_candidates() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/images/generations"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "data": [{ "b64_json": "aGVsbG8=" }, { "url": "https://cdn.example.com/a.png" }]
            })))
            .mount(&server)
            .await;
        let result = execute(&reqwest::Client::new(), &runtime(&server.uri()), &request("image.generate"))
            .await
            .expect("image");
        assert_eq!(result.outputs.len(), 2);
        assert_eq!(result.outputs[0].data.as_deref(), Some("aGVsbG8="));
        assert_eq!(result.outputs[1].url.as_deref(), Some("https://cdn.example.com/a.png"));
    }

    #[tokio::test]
    async fn unauthorized_maps_to_auth_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(401).set_body_string("unauthorized"))
            .mount(&server)
            .await;
        let error = execute(&reqwest::Client::new(), &runtime(&server.uri()), &request("text.chat"))
            .await
            .expect_err("auth");
        assert_eq!(error.code, "AUTH_UNAUTHORIZED");
        assert!(!error.retryable);
    }

    #[tokio::test]
    async fn rate_limit_is_retryable() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(429).set_body_string("slow down"))
            .mount(&server)
            .await;
        let error = execute(&reqwest::Client::new(), &runtime(&server.uri()), &request("text.chat"))
            .await
            .expect_err("rate");
        assert_eq!(error.code, "RATE_LIMIT");
        assert!(error.retryable);
    }

    #[tokio::test]
    async fn tts_returns_base64_audio() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/audio/speech"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"mp3-bytes".to_vec()))
            .mount(&server)
            .await;
        let result = execute(&reqwest::Client::new(), &runtime(&server.uri()), &request("audio.tts"))
            .await
            .expect("tts");
        assert_eq!(result.outputs[0].kind, "audio");
        assert_eq!(result.outputs[0].data.as_deref(), Some("bXAzLWJ5dGVz"));
    }
}
