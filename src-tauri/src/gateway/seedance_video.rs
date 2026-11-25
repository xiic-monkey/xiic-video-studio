//! 火山方舟 Doubao-Seedance 视频生成适配器。
//!
//! 协议 `seedance-video`：异步协议，提交返回任务 id，再轮询任务状态取回视频地址。
//!
//! Seedance 2.x 的 content 是带 role 的内容列表：
//! `image_url`（reference_image / first_frame / last_frame）、
//! `video_url`（reference_video）、`audio_url`（reference_audio）。
use super::{
    join_path, read_json, AdapterResult, AppError, AssetPayload, CapabilityRequest, JobStatus,
    ModelConfig, ProviderRuntime,
};
use serde_json::{json, Value};

const LABEL: &str = "火山方舟视频";
const DEFAULT_SUBMIT_PATH: &str = "/api/v3/contents/generations/tasks";
const DEFAULT_POLL_PATH: &str = "/api/v3/contents/generations/tasks/{task_id}";

/// Seedance 各版本的能力差异（从模型 defaults.seedance 读）。
struct SeedanceOptions {
    /// 是否支持 omni_reference_task_type：Seedance 2.5 起才有。
    task_type: bool,
    /// 是否允许只传参考音频：Seedance 2.5 起才有（2.0 必须搭配图或视频）。
    audio_only: bool,
}

impl Default for SeedanceOptions {
    fn default() -> Self {
        // 绑定里没写 seedance 配置时按 2.0 的保守能力处理。
        Self { task_type: false, audio_only: false }
    }
}

fn options(model: Option<&ModelConfig>) -> SeedanceOptions {
    let Some(model) = model else { return SeedanceOptions::default() };
    let Some(config) = model.defaults.get("seedance") else {
        return SeedanceOptions::default();
    };
    SeedanceOptions {
        task_type: config.get("taskType").and_then(Value::as_bool).unwrap_or(false),
        audio_only: config.get("audioOnly").and_then(Value::as_bool).unwrap_or(false),
    }
}

pub async fn execute(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    request: &CapabilityRequest,
) -> Result<AdapterResult, AppError> {
    let model = runtime.profile.model(&request.model);
    let submit_path = model
        .and_then(|item| default_string(&item.defaults, "submitPath"))
        .unwrap_or_else(|| DEFAULT_SUBMIT_PATH.to_string());
    let options = options(model);

    // content 第一项必须是文本提示词，其后按输入顺序追加图片/视频/音频。
    let mut content = vec![json!({ "type": "text", "text": request.prompt })];
    let mut has_frame = false;
    let mut has_image = false;
    let mut has_video = false;
    let mut has_audio = false;
    for input in &request.inputs {
        match input.role.as_str() {
            "first_frame" => {
                content.push(json!({
                    "type": "image_url",
                    "role": "first_frame",
                    "image_url": { "url": input.value }
                }));
                has_frame = true;
                has_image = true;
            }
            "last_frame" => {
                content.push(json!({
                    "type": "image_url",
                    "role": "last_frame",
                    "image_url": { "url": input.value }
                }));
                has_frame = true;
                has_image = true;
            }
            "reference_image" => {
                content.push(json!({
                    "type": "image_url",
                    "role": "reference_image",
                    "image_url": { "url": input.value }
                }));
                has_image = true;
            }
            "reference_video" => {
                content.push(json!({
                    "type": "video_url",
                    "role": "reference_video",
                    "video_url": { "url": input.value }
                }));
                has_video = true;
            }
            "reference_audio" => {
                content.push(json!({
                    "type": "audio_url",
                    "role": "reference_audio",
                    "audio_url": { "url": input.value }
                }));
                has_audio = true;
            }
            _ => continue,
        }
    }

    let task_type = task_type_of(request)?;
    if task_type != "auto" && !options.task_type {
        return Err(AppError::new(
            "PARAM_TASK_TYPE_INVALID",
            "该 Seedance 版本不支持指定任务类型，请改用自动判定",
            false,
        ));
    }
    if matches!(task_type.as_str(), "edit" | "extend") && !has_video {
        return Err(AppError::new(
            "PARAM_TASK_TYPE_INVALID",
            "视频编辑/视频延长任务需要至少一个参考视频",
            false,
        ));
    }
    if has_audio && !has_image && !has_video && !options.audio_only {
        return Err(AppError::new(
            "CAP_UNSUPPORTED_INPUT",
            "该 Seedance 版本不支持只传参考音频，至少要搭配参考图或参考视频",
            false,
        ));
    }

    let mut ratio = request
        .params
        .get("ratio")
        .and_then(Value::as_str)
        .unwrap_or("adaptive")
        .trim()
        .to_string();
    let mut duration = request.params.get("duration").and_then(Value::as_i64).unwrap_or(5);
    // 首尾帧、视频编辑、视频延长三类任务，接口只接受 adaptive 比例：
    // 模型会自动保持输出与首帧图片 / 待编辑视频的宽高比一致。
    if has_frame || matches!(task_type.as_str(), "edit" | "extend") {
        ratio = "adaptive".to_string();
    }
    // 视频编辑任务要求 duration = -1，实际时长由模型按原视频决定。
    if task_type == "edit" {
        duration = -1;
    }

    let mut body = json!({
        "model": request.model,
        "content": content,
        "ratio": ratio,
        "duration": duration,
        "generate_audio": request.params.get("generateAudio").and_then(Value::as_bool).unwrap_or(true)
    });
    // 分辨率：目录里选的值要真的发出去，否则 1080p 会被悄悄降级。
    if let Some(resolution) = request.params.get("resolution").and_then(Value::as_str) {
        body["resolution"] = json!(resolution);
    }
    // 显式指定子任务类型时下发：接口会在提交阶段就校验参数限制，
    // 不符合要求会同步报错，而不是等任务跑起来才异步失败。
    if task_type != "auto" {
        body["omni_reference_task_type"] = json!(task_type);
    }

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

/// 任务类型（omni_reference_task_type）。非法值直接报错，不要静默降级成 auto。
fn task_type_of(request: &CapabilityRequest) -> Result<String, AppError> {
    let raw = request
        .params
        .get("taskType")
        .and_then(Value::as_str)
        .unwrap_or("auto")
        .trim()
        .to_string();
    if matches!(raw.as_str(), "auto" | "reference" | "edit" | "extend") {
        return Ok(raw);
    }
    Err(AppError::new(
        "PARAM_TASK_TYPE_INVALID",
        format!("Seedance 不支持任务类型 {raw}"),
        false,
    ))
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
        // 任务超时（超过 execution_expires_after）也是终态：
        // 当成轮询中会一直挂着，节点永远不结束。
        "expired" | "timeout" => Ok(JobStatus {
            status: "failed".to_string(),
            progress: None,
            outputs: Vec::new(),
            raw_status: Some(raw_status),
            error: Some(
                AppError::new("TASK_FAILED", "视频任务已超时过期", false)
                    .with_raw(value.to_string()),
            ),
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
                "pollPath": "/api/v3/contents/generations/tasks/{task_id}",
                "seedance": { "taskType": true, "audioOnly": true }
            }),
            protocols: std::collections::HashMap::new(),
            priority: None,
            enabled: None,
            vendor: None,
        }
    }

    fn model_2_0() -> crate::gateway::ModelConfig {
        let mut item = model();
        item.defaults = json!({
            "submitPath": "/api/v3/contents/generations/tasks",
            "pollPath": "/api/v3/contents/generations/tasks/{task_id}",
            "seedance": { "taskType": false, "audioOnly": false }
        });
        item
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

    fn runtime_with(base_url: &str, model: crate::gateway::ModelConfig) -> ProviderRuntime {
        let mut profile = test_profile("bytedance-video", base_url);
        profile.models = vec![model];
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
            params: json!({ "duration": 6, "resolution": "720p", "ratio": "9:16", "generateAudio": true }),
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
                    { "type": "image_url", "role": "first_frame", "image_url": { "url": "https://cdn.example.com/frame.png" } }
                ],
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

    /// 首帧/首尾帧任务：接口只接受 adaptive 比例，
    /// 照抄用户选的 9:16 会被服务端直接拒掉。
    #[tokio::test]
    async fn first_frame_forces_adaptive_ratio() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v3/contents/generations/tasks"))
            .and(body_partial_json(json!({ "ratio": "adaptive" })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "id": "task-123" })))
            .mount(&server)
            .await;
        execute(&reqwest::Client::new(), &runtime(&server.uri()), &request())
            .await
            .expect("submit");
    }

    /// 文生视频没有首帧：用户选的比例要原样发出去。
    #[tokio::test]
    async fn text_to_video_keeps_the_chosen_ratio() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v3/contents/generations/tasks"))
            .and(body_partial_json(json!({ "ratio": "9:16" })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "id": "task-123" })))
            .mount(&server)
            .await;
        let mut req = request();
        req.inputs.clear();
        execute(&reqwest::Client::new(), &runtime(&server.uri()), &req)
            .await
            .expect("submit");
    }

    /// 参考视频/音频要按 Seedance 2.x 的 content 结构带 role 发出去。
    #[tokio::test]
    async fn reference_video_and_audio_use_role_tagged_content() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v3/contents/generations/tasks"))
            .and(body_partial_json(json!({
                "content": [
                    { "type": "text", "text": "雨夜街头" },
                    { "type": "video_url", "role": "reference_video", "video_url": { "url": "https://cdn.example.com/ref.mp4" } },
                    { "type": "audio_url", "role": "reference_audio", "audio_url": { "url": "https://cdn.example.com/ref.mp3" } }
                ]
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "id": "task-1" })))
            .mount(&server)
            .await;
        let mut req = request();
        req.inputs = vec![
            PreparedInput {
                role: "reference_video".to_string(),
                kind: "video".to_string(),
                mime: "video/mp4".to_string(),
                value: "https://cdn.example.com/ref.mp4".to_string(),
            },
            PreparedInput {
                role: "reference_audio".to_string(),
                kind: "audio".to_string(),
                mime: "audio/mpeg".to_string(),
                value: "https://cdn.example.com/ref.mp3".to_string(),
            },
        ];
        execute(&reqwest::Client::new(), &runtime(&server.uri()), &req)
            .await
            .expect("参考视频与音频要能发出去");
    }

    /// 视频编辑任务：必须带参考视频，且比例强制 adaptive、时长交给模型决定。
    #[tokio::test]
    async fn edit_task_forces_adaptive_ratio_and_auto_duration() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v3/contents/generations/tasks"))
            .and(body_partial_json(json!({
                "ratio": "adaptive",
                "duration": -1,
                "omni_reference_task_type": "edit"
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "id": "task-1" })))
            .mount(&server)
            .await;
        let mut req = request();
        req.params["taskType"] = json!("edit");
        req.inputs = vec![PreparedInput {
            role: "reference_video".to_string(),
            kind: "video".to_string(),
            mime: "video/mp4".to_string(),
            value: "https://cdn.example.com/ref.mp4".to_string(),
        }];
        execute(&reqwest::Client::new(), &runtime(&server.uri()), &req)
            .await
            .expect("编辑任务");
    }

    /// 视频编辑任务没有参考视频：提交前就要拦下。
    #[tokio::test]
    async fn edit_task_without_reference_video_is_rejected() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v3/contents/generations/tasks"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "id": "task-1" })))
            .mount(&server)
            .await;
        let mut req = request();
        req.params["taskType"] = json!("edit");
        let error = execute(&reqwest::Client::new(), &runtime(&server.uri()), &req)
            .await
            .expect_err("没有参考视频不能提交编辑任务");
        assert_eq!(error.code, "PARAM_TASK_TYPE_INVALID");
    }

    /// Seedance 2.0 不支持 omni_reference_task_type：不能静默忽略用户的设置。
    #[tokio::test]
    async fn task_type_is_rejected_on_models_without_support() {
        let server = MockServer::start().await;
        let mut req = request();
        req.params["taskType"] = json!("edit");
        let error = execute(
            &reqwest::Client::new(),
            &runtime_with(&server.uri(), model_2_0()),
            &req,
        )
        .await
        .expect_err("2.0 不支持任务类型");
        assert_eq!(error.code, "PARAM_TASK_TYPE_INVALID");
    }

    /// Seedance 2.0 不允许只传音频：静默发出去会异步失败。
    #[tokio::test]
    async fn audio_only_input_is_rejected_on_models_without_support() {
        let server = MockServer::start().await;
        let mut req = request();
        req.inputs = vec![PreparedInput {
            role: "reference_audio".to_string(),
            kind: "audio".to_string(),
            mime: "audio/mpeg".to_string(),
            value: "https://cdn.example.com/ref.mp3".to_string(),
        }];
        let error = execute(
            &reqwest::Client::new(),
            &runtime_with(&server.uri(), model_2_0()),
            &req,
        )
        .await
        .expect_err("只传音频要报错");
        assert_eq!(error.code, "CAP_UNSUPPORTED_INPUT");
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

    /// 过期是终态：当成轮询中会让节点永远挂着。
    #[tokio::test]
    async fn poll_maps_expired_to_failure() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v3/contents/generations/tasks/task-123"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "task-123",
                "status": "expired"
            })))
            .mount(&server)
            .await;
        let status = poll(&reqwest::Client::new(), &runtime(&server.uri()), &model(), "task-123")
            .await
            .expect("poll");
        assert_eq!(status.status, "failed");
        assert_eq!(status.raw_status.as_deref(), Some("expired"));
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
