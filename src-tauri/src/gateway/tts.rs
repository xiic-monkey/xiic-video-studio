use super::{
    api_url, map_reqwest, read_json, AdapterResult, AppError, AssetPayload, CapabilityRequest,
    ProviderRuntime,
};
use base64::Engine;
use serde_json::{json, Value};

const MINIMAX_LABEL: &str = "MiniMax 语音";
const MIMO_LABEL: &str = "MiMo 语音";

/// 语音合成：按 params.format 决定 MIME。
fn audio_mime(format: &str) -> &'static str {
    match format {
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "pcm" => "audio/pcm",
        "opus" => "audio/ogg",
        _ => "audio/mpeg",
    }
}

/// 取要合成的文本：优先 params.text，回落到 prompt。
fn synth_text(request: &CapabilityRequest) -> String {
    request
        .params
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| request.prompt.clone())
}

/// MiniMax TTS 协议：POST {base}/v1/t2a_v2。
pub async fn minimax_execute(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    request: &CapabilityRequest,
) -> Result<AdapterResult, AppError> {
    let format = request.params.get("format").and_then(Value::as_str).unwrap_or("mp3");
    let voice = request.params.get("voice").and_then(Value::as_str).unwrap_or("male-qn-qingse");
    let speed = request.params.get("speed").and_then(Value::as_f64).unwrap_or(1.0);
    let vol = request.params.get("vol").and_then(Value::as_f64).unwrap_or(1.0);
    let pitch = request.params.get("pitch").and_then(Value::as_i64).unwrap_or(0);
    let emotion = request.params.get("emotion").and_then(Value::as_str).unwrap_or("happy");

    let body = json!({
        "model": request.model,
        "text": synth_text(request),
        "stream": false,
        "voice_setting": {
            "voice_id": voice,
            "speed": speed,
            "vol": vol,
            "pitch": pitch,
            "emotion": emotion
        },
        "audio_setting": {
            "sample_rate": 32000,
            "bitrate": 128000,
            "format": 1,
            "channel": 1
        },
        "output_format": "url"
    });

    let mut builder = client
        .post(api_url(&runtime.profile.base_url, "t2a_v2"))
        .bearer_auth(&runtime.api_key);
    // GroupId 只有老接口需要；取不到就不加 query。
    if let Some(group_id) = request.params.get("groupId").and_then(Value::as_str) {
        if !group_id.trim().is_empty() {
            builder = builder.query(&[("GroupId", group_id)]);
        }
    }
    let response = builder
        .json(&body)
        .send()
        .await
        .map_err(|error| map_reqwest(error, MINIMAX_LABEL))?;
    let value = read_json(response, MINIMAX_LABEL).await?;

    if let Some(base_resp) = value.get("base_resp") {
        let code = base_resp.get("status_code").and_then(Value::as_i64).unwrap_or(0);
        if code != 0 {
            let message = base_resp
                .get("status_msg")
                .and_then(Value::as_str)
                .filter(|text| !text.is_empty())
                .unwrap_or("MiniMax 语音失败")
                .to_string();
            return Err(AppError::new("PROVIDER_BAD_RESPONSE", message, false)
                .with_raw(value.to_string()));
        }
    }

    let audio = value
        .pointer("/data/audio")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| {
            AppError::new("PROVIDER_BAD_RESPONSE", "MiniMax 语音响应缺少 data.audio", false)
                .with_raw(value.to_string())
        })?;

    let output = if audio.starts_with("http://") || audio.starts_with("https://") {
        AssetPayload {
            kind: "audio".to_string(),
            mime: audio_mime(format).to_string(),
            url: Some(audio.to_string()),
            data: None,
        }
    } else {
        let bytes = hex::decode(audio).map_err(|error| {
            AppError::new("PROVIDER_BAD_RESPONSE", format!("MiniMax 语音音频不是合法 hex：{error}"), false)
                .with_raw(value.to_string())
        })?;
        AssetPayload {
            kind: "audio".to_string(),
            mime: audio_mime(format).to_string(),
            url: None,
            data: Some(base64::engine::general_purpose::STANDARD.encode(&bytes)),
        }
    };

    Ok(AdapterResult {
        status: "succeeded".to_string(),
        outputs: vec![output],
        task_id: None,
        raw: Some(value),
    })
}

/// MiMo TTS（OpenAI 兼容 chat/completions）：POST {base}/v1/chat/completions。
///
/// 待合成的文本放在 role=assistant 的消息里，user 消息放指令。
pub async fn mimo_execute(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    request: &CapabilityRequest,
) -> Result<AdapterResult, AppError> {
    let format = request.params.get("format").and_then(Value::as_str).unwrap_or("wav");
    let voice = request.params.get("voice").and_then(Value::as_str).unwrap_or("mimo_default");
    let instruction = request
        .params
        .get("instruction")
        .and_then(Value::as_str)
        .unwrap_or("");

    let body = json!({
        "model": request.model,
        "messages": [
            { "role": "user", "content": instruction },
            { "role": "assistant", "content": synth_text(request) }
        ],
        "audio": {
            "format": format,
            "voice": voice
        }
    });

    let response = client
        .post(api_url(&runtime.profile.base_url, "chat/completions"))
        .bearer_auth(&runtime.api_key)
        .header("api-key", &runtime.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| map_reqwest(error, MIMO_LABEL))?;
    let value = read_json(response, MIMO_LABEL).await?;

    let data = value
        .pointer("/choices/0/message/audio/data")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| {
            AppError::new("PROVIDER_BAD_RESPONSE", "MiMo 语音响应缺少 choices[0].message.audio.data", false)
                .with_raw(value.to_string())
        })?;

    // 兼容 data URL 前缀（data:audio/wav;base64,....）。
    let base64_data = match data.split_once(',') {
        Some((prefix, rest)) if prefix.starts_with("data:") && prefix.contains("base64") => rest,
        _ => data,
    };

    Ok(AdapterResult {
        status: "succeeded".to_string(),
        outputs: vec![AssetPayload {
            kind: "audio".to_string(),
            mime: audio_mime(format).to_string(),
            url: None,
            data: Some(base64_data.to_string()),
        }],
        task_id: None,
        raw: Some(value),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway::{CapabilityRequest, ProviderRuntime};
    use serde_json::json;
    use wiremock::matchers::{body_partial_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn runtime(base_url: &str, protocol: &str) -> ProviderRuntime {
        ProviderRuntime {
            profile: crate::gateway::test_profile("openai-compatible", base_url),
            api_key: "test-key".to_string(),
            protocol: protocol.to_string(),
        }
    }

    fn request(params: Value) -> CapabilityRequest {
        CapabilityRequest {
            capability: "audio.tts".to_string(),
            model: "speech-model".to_string(),
            prompt: "雨夜街头".to_string(),
            negative: None,
            params,
            inputs: Vec::new(),
            client_request_id: "req_1".to_string(),
        }
    }

    #[tokio::test]
    async fn minimax_decodes_hex_audio() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/t2a_v2"))
            .and(header("authorization", "Bearer test-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "base_resp": { "status_code": 0, "status_msg": "success" },
                "data": { "audio": "6D7033" }
            })))
            .mount(&server)
            .await;
        let result = minimax_execute(
            &reqwest::Client::new(),
            &runtime(&server.uri(), "minimax-tts"),
            &request(json!({ "format": "mp3" })),
        )
        .await
        .expect("minimax tts");
        assert_eq!(result.status, "succeeded");
        assert_eq!(result.outputs[0].kind, "audio");
        assert_eq!(result.outputs[0].mime, "audio/mpeg");
        assert_eq!(result.outputs[0].data.as_deref(), Some("bXAz"));
        assert!(result.outputs[0].url.is_none());
    }

    #[tokio::test]
    async fn minimax_accepts_audio_url() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/t2a_v2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "base_resp": { "status_code": 0 },
                "data": { "audio": "https://cdn.example.com/a.mp3" }
            })))
            .mount(&server)
            .await;
        let result = minimax_execute(
            &reqwest::Client::new(),
            &runtime(&server.uri(), "minimax-tts"),
            &request(json!({ "format": "mp3" })),
        )
        .await
        .expect("minimax tts");
        assert_eq!(result.outputs[0].url.as_deref(), Some("https://cdn.example.com/a.mp3"));
        assert!(result.outputs[0].data.is_none());
    }

    #[tokio::test]
    async fn minimax_sends_voice_setting_body() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/t2a_v2"))
            .and(body_partial_json(json!({
                "model": "speech-model",
                "text": "雨夜街头",
                "stream": false,
                "voice_setting": { "voice_id": "male-qn-qingse", "speed": 1.0, "vol": 1.0, "pitch": 0, "emotion": "happy" },
                "audio_setting": { "sample_rate": 32000, "bitrate": 128000, "format": 1, "channel": 1 },
                "output_format": "url"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "base_resp": { "status_code": 0 },
                "data": { "audio": "6D7033" }
            })))
            .mount(&server)
            .await;
        let result = minimax_execute(
            &reqwest::Client::new(),
            &runtime(&server.uri(), "minimax-tts"),
            &request(json!({})),
        )
        .await
        .expect("minimax tts");
        assert_eq!(result.outputs[0].data.as_deref(), Some("bXAz"));
    }

    #[tokio::test]
    async fn minimax_base_resp_error_is_reported() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/t2a_v2"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "base_resp": { "status_code": 1004, "status_msg": "voice not found" }
            })))
            .mount(&server)
            .await;
        let error = minimax_execute(
            &reqwest::Client::new(),
            &runtime(&server.uri(), "minimax-tts"),
            &request(json!({})),
        )
        .await
        .expect_err("base resp");
        assert_eq!(error.code, "PROVIDER_BAD_RESPONSE");
        assert_eq!(error.message, "voice not found");
    }

    #[tokio::test]
    async fn minimax_unauthorized_maps_to_auth_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/t2a_v2"))
            .respond_with(ResponseTemplate::new(401).set_body_string("unauthorized"))
            .mount(&server)
            .await;
        let error = minimax_execute(
            &reqwest::Client::new(),
            &runtime(&server.uri(), "minimax-tts"),
            &request(json!({})),
        )
        .await
        .expect_err("auth");
        assert_eq!(error.code, "AUTH_UNAUTHORIZED");
    }

    #[tokio::test]
    async fn mimo_decodes_base64_audio_with_data_url_prefix() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(header("authorization", "Bearer test-key"))
            .and(header("api-key", "test-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{ "message": { "audio": { "data": "data:audio/wav;base64,aGVsbG8=" } } }]
            })))
            .mount(&server)
            .await;
        let result = mimo_execute(
            &reqwest::Client::new(),
            &runtime(&server.uri(), "mimo-tts"),
            &request(json!({ "format": "wav" })),
        )
        .await
        .expect("mimo tts");
        assert_eq!(result.status, "succeeded");
        assert_eq!(result.outputs[0].kind, "audio");
        assert_eq!(result.outputs[0].mime, "audio/wav");
        assert_eq!(result.outputs[0].data.as_deref(), Some("aGVsbG8="));
    }

    #[tokio::test]
    async fn mimo_sends_text_in_assistant_message() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .and(body_partial_json(json!({
                "model": "speech-model",
                "messages": [
                    { "role": "user", "content": "" },
                    { "role": "assistant", "content": "要合成的台词" }
                ],
                "audio": { "format": "wav", "voice": "mimo_default" }
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{ "message": { "audio": { "data": "aGVsbG8=" } } }]
            })))
            .mount(&server)
            .await;
        let result = mimo_execute(
            &reqwest::Client::new(),
            &runtime(&server.uri(), "mimo-tts"),
            &request(json!({ "text": "要合成的台词" })),
        )
        .await
        .expect("mimo tts");
        assert_eq!(result.outputs[0].data.as_deref(), Some("aGVsbG8="));
    }

    #[tokio::test]
    async fn mimo_missing_audio_is_a_bad_response() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "choices": [{ "message": { "content": "no audio" } }]
            })))
            .mount(&server)
            .await;
        let error = mimo_execute(
            &reqwest::Client::new(),
            &runtime(&server.uri(), "mimo-tts"),
            &request(json!({})),
        )
        .await
        .expect_err("bad response");
        assert_eq!(error.code, "PROVIDER_BAD_RESPONSE");
    }

    #[tokio::test]
    async fn mimo_unauthorized_maps_to_auth_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/chat/completions"))
            .respond_with(ResponseTemplate::new(401).set_body_string("unauthorized"))
            .mount(&server)
            .await;
        let error = mimo_execute(
            &reqwest::Client::new(),
            &runtime(&server.uri(), "mimo-tts"),
            &request(json!({})),
        )
        .await
        .expect_err("auth");
        assert_eq!(error.code, "AUTH_UNAUTHORIZED");
    }
}
