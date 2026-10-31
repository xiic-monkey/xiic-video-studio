use super::{
    join_path, read_json, AdapterResult, AppError, AssetPayload, CapabilityRequest, JobStatus,
    ModelConfig, ProviderRuntime,
};
use serde::Deserialize;
use serde_json::{json, Value};

const RATIOS: [&str; 7] = ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct H3Options {
    #[serde(default = "default_protocol")]
    protocol: String,
    #[serde(default = "default_submit_path")]
    submit_path: String,
    #[serde(default = "default_poll_path")]
    poll_path: String,
    #[serde(default)]
    cancel_path: String,
    #[serde(default)]
    file_retrieve_path: String,
}

impl Default for H3Options {
    fn default() -> Self {
        Self {
            protocol: default_protocol(),
            submit_path: default_submit_path(),
            poll_path: default_poll_path(),
            cancel_path: String::new(),
            file_retrieve_path: String::new(),
        }
    }
}

fn default_protocol() -> String { "official".to_string() }
fn default_submit_path() -> String { "/v1/video_generation".to_string() }
fn default_poll_path() -> String { "/v1/query/video_generation?task_id={task_id}".to_string() }

fn options(model: &ModelConfig) -> H3Options {
    serde_json::from_value(model.defaults.clone()).unwrap_or_default()
}

pub fn validate(request: &CapabilityRequest, model: &ModelConfig) -> Result<(), AppError> {
    let prompt_chars = request.prompt.chars().count();
    let limit = model.capability("video.generate").and_then(|item| item.max_prompt_chars).unwrap_or(20480) as usize;
    if prompt_chars > limit {
        return Err(AppError::new("PARAM_PROMPT_TOO_LONG", format!("提示词超过 {limit} 字符上限"), false));
    }
    let duration = request.params.get("duration").and_then(Value::as_i64).unwrap_or(5);
    if !(5..=15).contains(&duration) {
        return Err(AppError::new("PARAM_DURATION_RANGE", "H3 时长需为 5–15 的整数秒", false));
    }
    let resolution = request.params.get("resolution").and_then(Value::as_str).unwrap_or("768P");
    if !matches!(resolution, "768P" | "2K") {
        return Err(AppError::new("PARAM_RESOLUTION_UNSUPPORTED", "H3 只支持 768P 或 2K", false));
    }
    let ratio = request.params.get("ratio").and_then(Value::as_str).unwrap_or("9:16");
    if !RATIOS.contains(&ratio) {
        return Err(AppError::new("PARAM_RATIO_UNSUPPORTED", format!("H3 不支持比例 {ratio}"), false));
    }
    let has_frame = request.inputs.iter().any(|input| matches!(input.role.as_str(), "first_frame" | "last_frame"));
    let has_reference = request.inputs.iter().any(|input| matches!(input.role.as_str(), "reference_image" | "reference_video" | "reference_audio"));
    if has_frame && has_reference {
        return Err(AppError::new("PARAM_MODE_CONFLICT", "首尾帧模式与全能参考模式互斥", false));
    }
    let images = request.inputs.iter().filter(|input| input.role == "reference_image").count();
    let videos = request.inputs.iter().filter(|input| input.role == "reference_video").count();
    let audios = request.inputs.iter().filter(|input| input.role == "reference_audio").count();
    if images > 9 || videos > 3 || audios > 3 {
        return Err(AppError::new("PARAM_REFERENCE_LIMIT", "参考素材超过 H3 上限（9 图 / 3 视频 / 3 音频）", false));
    }
    Ok(())
}

pub async fn execute(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    request: &CapabilityRequest,
) -> Result<AdapterResult, AppError> {
    let model = runtime.profile.models.iter().find(|item| item.id == request.model)
        .ok_or_else(|| AppError::new("PARAM_MODEL_UNKNOWN", format!("Provider 未配置模型 {}", request.model), false))?;
    validate(request, model)?;
    let options = options(model);
    let mut body = json!({
        "model": request.model,
        "prompt": request.prompt,
        "duration": request.params.get("duration").and_then(Value::as_i64).unwrap_or(5),
        "resolution": request.params.get("resolution").and_then(Value::as_str).unwrap_or("768P"),
        "ratio": request.params.get("ratio").and_then(Value::as_str).unwrap_or("9:16")
    });
    let mut references = Vec::new();
    for input in &request.inputs {
        match input.role.as_str() {
            "first_frame" => body["first_frame_image"] = json!(input.value),
            "last_frame" => body["last_frame_image"] = json!(input.value),
            "reference_image" => references.push(json!({ "type": "image", "url": input.value })),
            "reference_video" => references.push(json!({ "type": "video", "url": input.value })),
            "reference_audio" => references.push(json!({ "type": "audio", "url": input.value })),
            _ => {}
        }
    }
    if !references.is_empty() {
        body["subject_reference"] = Value::Array(references);
    }
    if request.params.get("generateAudio").and_then(Value::as_bool).unwrap_or(true) {
        body["generate_audio"] = json!(true);
    }
    let response = client
        .post(join_path(&runtime.profile.base_url, &options.submit_path))
        .bearer_auth(&runtime.api_key)
        .header("Idempotency-Key", &request.client_request_id)
        .json(&body)
        .send()
        .await
        .map_err(|error| super::map_reqwest(error, "MiniMax H3"))?;
    let value = read_json(response, "MiniMax H3").await?;
    let task_id = first_string(&value, &["task_id", "taskId", "id", "data.task_id"])
        .ok_or_else(|| AppError::new("PROVIDER_BAD_RESPONSE", "H3 提交响应缺少 task_id", false).with_raw(value.to_string()))?;
    Ok(AdapterResult { status: "queued".to_string(), outputs: Vec::new(), task_id: Some(task_id), raw: Some(value) })
}

pub async fn poll(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    model: &ModelConfig,
    task_id: &str,
) -> Result<JobStatus, AppError> {
    let options = options(model);
    let url = join_path(&runtime.profile.base_url, &options.poll_path.replace("{task_id}", task_id));
    let response = client
        .get(url)
        .bearer_auth(&runtime.api_key)
        .send()
        .await
        .map_err(|error| super::map_reqwest(error, "MiniMax H3 查询"))?;
    let value = read_json(response, "MiniMax H3 查询").await?;
    let raw_status = first_string(&value, &["status", "task_status", "data.status"]).unwrap_or_default();
    let normalized = raw_status.to_ascii_lowercase();
    if matches!(normalized.as_str(), "success" | "succeeded" | "completed" | "finished") {
        let mut url = first_string(&value, &["file_url", "video_url", "download_url", "output.url", "data.file_url"]);
        if url.is_none() {
            if let (Some(file_id), false) = (first_string(&value, &["file_id", "data.file_id"]), options.file_retrieve_path.is_empty()) {
                let retrieve = join_path(&runtime.profile.base_url, &options.file_retrieve_path.replace("{file_id}", &file_id));
                let response = client.get(retrieve).bearer_auth(&runtime.api_key).send().await
                    .map_err(|error| super::map_reqwest(error, "MiniMax H3 文件"))?;
                let file_value = read_json(response, "MiniMax H3 文件").await?;
                url = first_string(&file_value, &["file.download_url", "download_url", "data.download_url"]);
            }
        }
        let url = url.ok_or_else(|| AppError::new("TASK_RESULT_UNRECOGNIZED", "H3 成功但未找到结果 URL", false).with_raw(value.to_string()))?;
        return Ok(JobStatus {
            status: "succeeded".to_string(),
            progress: Some(100.0),
            outputs: vec![AssetPayload { kind: "video".to_string(), mime: "video/mp4".to_string(), url: Some(url), data: None }],
            raw_status: Some(raw_status),
            error: None,
        });
    }
    if matches!(normalized.as_str(), "fail" | "failed" | "error") {
        let message = first_string(&value, &["message", "error.message", "base_resp.status_msg"]).unwrap_or_else(|| "H3 任务失败".to_string());
        return Ok(JobStatus {
            status: "failed".to_string(), progress: None, outputs: Vec::new(), raw_status: Some(raw_status),
            error: Some(AppError::new("TASK_FAILED", message, false).with_raw(value.to_string())),
        });
    }
    if matches!(normalized.as_str(), "cancelled" | "canceled") {
        return Ok(JobStatus { status: "cancelled".to_string(), progress: None, outputs: Vec::new(), raw_status: Some(raw_status), error: None });
    }
    let progress = value.get("progress").and_then(Value::as_f64);
    Ok(JobStatus { status: "polling".to_string(), progress, outputs: Vec::new(), raw_status: Some(raw_status), error: None })
}

pub async fn cancel(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    model: &ModelConfig,
    task_id: &str,
) -> Result<(), AppError> {
    let options = options(model);
    if options.cancel_path.is_empty() {
        return Ok(());
    }
    let url = join_path(&runtime.profile.base_url, &options.cancel_path.replace("{task_id}", task_id));
    let response = client.post(url).bearer_auth(&runtime.api_key).json(&json!({ "task_id": task_id })).send().await
        .map_err(|error| super::map_reqwest(error, "MiniMax H3 取消"))?;
    let status = response.status();
    if status.is_success() || status.as_u16() == 404 {
        return Ok(());
    }
    Err(super::map_http_status(status, &response.text().await.unwrap_or_default(), "MiniMax H3 取消"))
}

fn first_string(value: &Value, paths: &[&str]) -> Option<String> {
    for path in paths {
        let mut current = value;
        let mut found = true;
        for segment in path.split('.') {
            match current.get(segment) {
                Some(next) => current = next,
                None => { found = false; break; }
            }
        }
        if found {
            if let Some(text) = current.as_str() {
                if !text.is_empty() {
                    return Some(text.to_string());
                }
            }
        }
    }
    None
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
            id: "MiniMax-H3".to_string(),
            display_name: "MiniMax H3".to_string(),
            capabilities: Vec::new(),
            defaults: json!({
                "protocol": "official",
                "submitPath": "/v1/video_generation",
                "pollPath": "/v1/query/video_generation?task_id={task_id}",
                "cancelPath": "",
                "fileRetrievePath": "/v1/files/retrieve?file_id={file_id}"
            }),
        }
    }

    fn runtime(base_url: &str) -> ProviderRuntime {
        let mut profile = test_profile("minimax-h3", base_url);
        profile.models = vec![model()];
        ProviderRuntime { profile, api_key: "h3-key".to_string() }
    }

    fn request() -> CapabilityRequest {
        CapabilityRequest {
            capability: "video.generate".to_string(),
            model: "MiniMax-H3".to_string(),
            prompt: "雨夜街头，女主回头".to_string(),
            negative: None,
            params: json!({ "duration": 6, "resolution": "768P", "ratio": "9:16" }),
            inputs: vec![PreparedInput {
                role: "first_frame".to_string(),
                kind: "image".to_string(),
                mime: "image/png".to_string(),
                value: "https://cdn.example.com/frame.png".to_string(),
            }],
            client_request_id: "run_1-0-1".to_string(),
        }
    }

    #[tokio::test]
    async fn submits_task_with_first_frame() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/video_generation"))
            .and(body_partial_json(json!({
                "first_frame_image": "https://cdn.example.com/frame.png",
                "duration": 6,
                "resolution": "768P",
                "ratio": "9:16"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "task_id": "task_123" })))
            .mount(&server)
            .await;
        let result = execute(&reqwest::Client::new(), &runtime(&server.uri()), &request())
            .await
            .expect("submit");
        assert_eq!(result.status, "queued");
        assert_eq!(result.task_id.as_deref(), Some("task_123"));
    }

    #[tokio::test]
    async fn poll_maps_success_to_video_output() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/query/video_generation"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "status": "Success",
                "file_id": "file_1",
                "file_url": "https://cdn.example.com/out.mp4"
            })))
            .mount(&server)
            .await;
        let status = poll(&reqwest::Client::new(), &runtime(&server.uri()), &model(), "task_123")
            .await
            .expect("poll");
        assert_eq!(status.status, "succeeded");
        assert_eq!(status.outputs[0].url.as_deref(), Some("https://cdn.example.com/out.mp4"));
    }

    #[tokio::test]
    async fn poll_maps_failure_with_provider_message() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/v1/query/video_generation"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "status": "Fail",
                "message": "content rejected"
            })))
            .mount(&server)
            .await;
        let status = poll(&reqwest::Client::new(), &runtime(&server.uri()), &model(), "task_123")
            .await
            .expect("poll");
        assert_eq!(status.status, "failed");
        assert_eq!(status.error.as_ref().map(|error| error.code.as_str()), Some("TASK_FAILED"));
    }

    #[test]
    fn rejects_mixed_frame_and_reference_modes() {
        let mut mixed = request();
        mixed.inputs.push(PreparedInput {
            role: "reference_image".to_string(), kind: "image".to_string(),
            mime: "image/png".to_string(), value: "https://cdn.example.com/ref.png".to_string(),
        });
        let error = validate(&mixed, &model()).expect_err("mixed");
        assert_eq!(error.code, "PARAM_MODE_CONFLICT");
    }

    #[test]
    fn rejects_out_of_range_duration() {
        let mut bad = request();
        bad.params = json!({ "duration": 4, "resolution": "768P", "ratio": "9:16" });
        assert_eq!(validate(&bad, &model()).expect_err("duration").code, "PARAM_DURATION_RANGE");
    }
}
