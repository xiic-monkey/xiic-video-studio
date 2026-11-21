//! 火山方舟 Doubao-Seedance 视频生成适配器。
//!
//! 协议 `seedance-video`：异步协议，提交返回任务 id，再轮询任务状态取回视频地址。
use super::{
    join_path, read_json, AdapterResult, AppError, AssetPayload, CapabilityRequest, JobStatus,
    ModelConfig, ProviderRuntime,
};
use serde_json::{json, Value};

const LABEL: &str = "火山方舟视频";
const DEFAULT_SUBMIT_PATH: &str = "/api/v3/contents/generations/tasks";
const DEFAULT_POLL_PATH: &str = "/api/v3/contents/generations/tasks/{task_id}";

pub async fn execute(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    request: &CapabilityRequest,
) -> Result<AdapterResult, AppError> {
    let model = runtime.profile.model(&request.model);
    let submit_path = model
        .and_then(|item| default_string(&item.defaults, "submitPath"))
        .unwrap_or_else(|| DEFAULT_SUBMIT_PATH.to_string());

    // content 第一项必须是文本提示词，其后按输入顺序追加图片。
    let mut content = vec![json!({ "type": "text", "text": request.prompt })];
    for input in &request.inputs {
        if !matches!(
            input.role.as_str(),
            "first_frame" | "last_frame" | "reference_image"
        ) {
            continue;
        }
        content.push(json!({
            "type": "image_url",
            "image_url": { "url": input.value }
        }));
    }

    let body = json!({
        "model": request.model,
        "content": content,
        "ratio": request.params.get("ratio").and_then(Value::as_str).unwrap_or("9:16"),
        "duration": request.params.get("duration").and_then(Value::as_i64).unwrap_or(5),
        "generate_audio": request.params.get("generateAudio").and_then(Value::as_bool).unwrap_or(false)
    });

    let response = client
        .post(join_path(&runtime.profile.base_url, &submit_path))
        .bearer_auth(&runtime.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|error| super::map_reqwest(error, LABEL))?;
    let value = read_json(response, LABEL).await?;
    let task_id = first_string(&value, &["id", "task_id", "taskId"])
        .ok_or_else(|| {
            AppError::new("PROVIDER_BAD_RESPONSE", "火山方舟提交响应缺少任务 id", false)
                .with_raw(value.to_string())
        })?;
    Ok(AdapterResult {
        status: "queued".to_string(),
        outputs: Vec::new(),
        task_id: Some(task_id),
        raw: Some(value),
    })
}

pub async fn poll(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    model: &ModelConfig,
    task_id: &str,
) -> Result<JobStatus, AppError> {
    let poll_path = default_string(&model.defaults, "pollPath")
        .unwrap_or_else(|| DEFAULT_POLL_PATH.to_string());
    let url = join_path(
        &runtime.profile.base_url,
        &poll_path.replace("{task_id}", task_id),
    );
    let response = client
        .get(url)
        .bearer_auth(&runtime.api_key)
        .send()
        .await
        .map_err(|error| super::map_reqwest(error, LABEL))?;
    let value = read_json(response, LABEL).await?;

    let raw_status = first_string(&value, &["status", "task_status"]).unwrap_or_default();
    let normalized = raw_status.to_ascii_lowercase();
    match normalized.as_str() {
        "succeeded" | "success" => {
            let url = first_string(&value, &["content.video_url", "content.url", "video_url", "url"])
                .ok_or_else(|| {
                    AppError::new("TASK_RESULT_UNRECOGNIZED", "任务成功但未找到视频 URL", false)
                        .with_raw(value.to_string())
                })?;
            Ok(JobStatus {
                status: "succeeded".to_string(),
                progress: Some(100.0),
                outputs: vec![AssetPayload {
                    kind: "video".to_string(),
                    mime: "video/mp4".to_string(),
                    url: Some(url),
                    data: None,
                }],
                raw_status: Some(raw_status),
                error: None,
            })
        }
        "failed" | "fail" | "error" => {
            let message = first_string(&value, &["error.message", "message", "error"])
                .unwrap_or_else(|| "视频任务失败".to_string());
            Ok(JobStatus {
                status: "failed".to_string(),
                progress: None,
                outputs: Vec::new(),
                raw_status: Some(raw_status),
                error: Some(AppError::new("TASK_FAILED", message, false).with_raw(value.to_string())),
            })
        }
        "cancelled" | "canceled" => Ok(JobStatus {
            status: "cancelled".to_string(),
            progress: None,
            outputs: Vec::new(),
            raw_status: Some(raw_status),
            error: None,
        }),
        _ => Ok(JobStatus {
            status: "polling".to_string(),
            progress: None,
            outputs: Vec::new(),
            raw_status: Some(raw_status),
            error: None,
        }),
    }
}

pub async fn cancel(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    model: &ModelConfig,
    task_id: &str,
) -> Result<(), AppError> {
    let poll_path = default_string(&model.defaults, "pollPath")
        .unwrap_or_else(|| DEFAULT_POLL_PATH.to_string());
    let url = join_path(
        &runtime.profile.base_url,
        &poll_path.replace("{task_id}", task_id),
    );
    let response = client
        .delete(url)
        .bearer_auth(&runtime.api_key)
        .send()
        .await
        .map_err(|error| super::map_reqwest(error, LABEL))?;
    let status = response.status();
    if status.is_success() || status.as_u16() == 404 {
        return Ok(());
    }
    Err(super::map_http_status(
        status,
        &response.text().await.unwrap_or_default(),
        LABEL,
    ))
}

/// 从模型 defaults 里读协议自定义路径。
fn default_string(defaults: &Value, key: &str) -> Option<String> {
    defaults
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(|text| text.to_string())
}

fn first_string(value: &Value, paths: &[&str]) -> Option<String> {
    for path in paths {
        let mut current = value;
        let mut found = true;
        for segment in path.split('.') {
            match current.get(segment) {
                Some(next) => current = next,
                None => {
                    found = false;
                    break;
                }
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
            id: "test-model".to_string(),
            display_name: "Test Model".to_string(),
            capabilities: Vec::new(),
            defaults: json!({
                "submitPath": "/api/v3/contents/generations/tasks",
                "pollPath": "/api/v3/contents/generations/tasks/{task_id}"
            }),
            protocols: std::collections::HashMap::new(),
            priority: None,
            enabled: None,
            vendor: None,
        }
    }

    fn runtime(base_url: &str) -> ProviderRuntime {
        let mut profile = test_profile("bytedance-video", base_url);
        profile.models = vec![model()];
        ProviderRuntime {
            profile,
            api_key: "test-key".to_string(),
            protocol: "seedance-video".to_string(),
        }
    }

    fn request() -> CapabilityRequest {
        CapabilityRequest {
            capability: "video.generate".to_string(),
            model: "test-model".to_string(),
            prompt: "雨夜街头".to_string(),
            negative: None,
            params: json!({ "duration": 6, "resolution": "768P", "ratio": "9:16", "generateAudio": true }),
            inputs: vec![PreparedInput {
                role: "first_frame".to_string(),
                kind: "image".to_string(),
                mime: "image/png".to_string(),
                value: "https://cdn.example.com/frame.png".to_string(),
            }],
            client_request_id: "req_1".to_string(),
        }
    }

    #[tokio::test]
    async fn submit_returns_queued_task_id() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v3/contents/generations/tasks"))
            .and(body_partial_json(json!({
                "model": "test-model",
                "content": [
                    { "type": "text", "text": "雨夜街头" },
                    { "type": "image_url", "image_url": { "url": "https://cdn.example.com/frame.png" } }
                ],
                "ratio": "9:16",
                "duration": 6,
                "generate_audio": true
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "id": "task-123" })))
            .mount(&server)
            .await;
        let result = execute(&reqwest::Client::new(), &runtime(&server.uri()), &request())
            .await
            .expect("submit");
        assert_eq!(result.status, "queued");
        assert_eq!(result.task_id.as_deref(), Some("task-123"));
        assert!(result.outputs.is_empty());
    }

    #[tokio::test]
    async fn poll_maps_success_to_video_output() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v3/contents/generations/tasks/task-123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "task-123",
                "status": "succeeded",
                "content": { "video_url": "https://cdn.example.com/out.mp4" }
            })))
            .mount(&server)
            .await;
        let status = poll(&reqwest::Client::new(), &runtime(&server.uri()), &model(), "task-123")
            .await
            .expect("poll");
        assert_eq!(status.status, "succeeded");
        assert_eq!(status.progress, Some(100.0));
        assert_eq!(status.outputs[0].kind, "video");
        assert_eq!(status.outputs[0].url.as_deref(), Some("https://cdn.example.com/out.mp4"));
    }

    #[tokio::test]
    async fn poll_maps_failure_with_provider_message() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v3/contents/generations/tasks/task-123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "task-123",
                "status": "failed",
                "error": { "message": "内容审核未通过" }
            })))
            .mount(&server)
            .await;
        let status = poll(&reqwest::Client::new(), &runtime(&server.uri()), &model(), "task-123")
            .await
            .expect("poll");
        assert_eq!(status.status, "failed");
        let error = status.error.expect("error");
        assert_eq!(error.code, "TASK_FAILED");
        assert_eq!(error.message, "内容审核未通过");
    }

    #[tokio::test]
    async fn poll_reports_running_as_polling() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v3/contents/generations/tasks/task-123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "task-123",
                "status": "running"
            })))
            .mount(&server)
            .await;
        let status = poll(&reqwest::Client::new(), &runtime(&server.uri()), &model(), "task-123")
            .await
            .expect("poll");
        assert_eq!(status.status, "polling");
        assert_eq!(status.raw_status.as_deref(), Some("running"));
    }

    #[tokio::test]
    async fn unauthorized_maps_to_auth_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v3/contents/generations/tasks"))
            .respond_with(ResponseTemplate::new(401).set_body_string("unauthorized"))
            .mount(&server)
            .await;
        let error = execute(&reqwest::Client::new(), &runtime(&server.uri()), &request())
            .await
            .expect_err("auth");
        assert_eq!(error.code, "AUTH_UNAUTHORIZED");
    }

    #[tokio::test]
    async fn cancel_treats_404_as_ok() {
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .and(path("/api/v3/contents/generations/tasks/task-123"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        cancel(&reqwest::Client::new(), &runtime(&server.uri()), &model(), "task-123")
            .await
            .expect("cancel");
    }
}
