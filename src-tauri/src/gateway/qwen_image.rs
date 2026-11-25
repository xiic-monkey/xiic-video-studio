//! 阿里云百炼（DashScope）通义万相生图适配器。
//!
//! 协议 `qwen-image`：提交走异步接口，返回 task_id 后轮询任务状态。
use super::{
    join_path, read_json, AdapterResult, AppError, AssetPayload, CapabilityRequest, JobStatus,
    ModelConfig, ProviderRuntime,
};
use serde_json::{json, Value};

const LABEL: &str = "通义万相";
/// 百炼异步文生图 / 图生图提交端点（qwen-image 首发系列的 image-synthesis 接口）。
const SUBMIT_PATH: &str = "/api/v1/services/aigc/text2image/image-synthesis";
/// 3.0 / 2.1 系列换用 image-generation 提交端点，异步查询地址不变。
const MULTIMODAL_SUBMIT_PATH: &str = "/api/v1/services/aigc/image-generation/generation";
/// 异步任务查询端点前缀。
const TASK_PATH: &str = "/api/v1/tasks";

/**
 * 3.0 / 2.1 系列换了端点和请求体：走 multimodal-generation 的 messages 结构，
 * 老的 qwen-image 仍然用 image-synthesis 的 prompt/images 结构。
 */
fn uses_multimodal_generation(model: &str) -> bool {
    model.starts_with("qwen-image-3") || model.starts_with("qwen-image-2.1")
}

pub async fn execute(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    request: &CapabilityRequest,
) -> Result<AdapterResult, AppError> {
    let size = dash_size(request.params.get("size").and_then(Value::as_str));
    let count = request.params.get("count").and_then(Value::as_u64).unwrap_or(1).clamp(1, 4);

    let body = if uses_multimodal_generation(&request.model) {
        // 参考图放 content 里，和提示词一起作为一条 user 消息。
        let mut content = vec![json!({ "text": request.prompt })];
        for input in request.inputs.iter().filter(|item| item.kind == "image") {
            content.push(json!({ "image": input.value }));
        }
        json!({
            "model": request.model,
            "input": { "messages": [ { "role": "user", "content": content } ] },
            "parameters": {
                "size": size,
                "n": count,
                // 百炼这两个字段的官方默认就是开着的。
                "prompt_extend": true,
                "watermark": false
            }
        })
    } else {
        let mut input = json!({ "prompt": request.prompt });
        // 图生图：参考图放 input.images，没有参考图就不带这个字段。
        let images: Vec<Value> = request
            .inputs
            .iter()
            .filter(|item| item.kind == "image")
            .map(|item| json!({ "image": item.value }))
            .collect();
        if !images.is_empty() {
            input["images"] = Value::Array(images);
        }
        json!({
            "model": request.model,
            "input": input,
            "parameters": {
                "size": size,
                "n": count,
                "prompt_extend": false,
                "watermark": false
            }
        })
    };

    let submit_path = if uses_multimodal_generation(&request.model) {
        MULTIMODAL_SUBMIT_PATH
    } else {
        SUBMIT_PATH
    };

    let response = client
        .post(join_path(&runtime.profile.base_url, submit_path))
        .bearer_auth(&runtime.api_key)
        .header("X-DashScope-Async", "enable")
        .json(&body)
        .send()
        .await
        .map_err(|error| super::map_reqwest(error, LABEL))?;
    let value = read_json(response, LABEL).await?;
    let task_id = task_id_of(&value).ok_or_else(|| {
        AppError::new("PROVIDER_BAD_RESPONSE", "通义万相提交响应缺少 task_id", false)
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
    _model: &ModelConfig,
    task_id: &str,
) -> Result<JobStatus, AppError> {
    let url = join_path(&runtime.profile.base_url, &format!("{TASK_PATH}/{task_id}"));
    let response = client
        .get(url)
        .bearer_auth(&runtime.api_key)
        .send()
        .await
        .map_err(|error| super::map_reqwest(error, LABEL))?;
    let value = read_json(response, LABEL).await?;

    let raw_status = task_status_of(&value).unwrap_or_default();
    let normalized = raw_status.to_ascii_uppercase();
    if normalized == "SUCCEEDED" {
        let outputs: Vec<AssetPayload> = result_urls(&value)
            .into_iter()
            .map(|url| AssetPayload {
                kind: "image".to_string(),
                mime: "image/png".to_string(),
                url: Some(url),
                data: None,
            })
            .collect();
        // 成功但没有图：不能当成功。百炼可能返回 SUCCEEDED 却没有结果，
        // 或者结果里 code != 200 —— 当成成功会让节点拿到空结果。
        if outputs.is_empty() {
            return Err(AppError::new(
                "PROVIDER_BAD_RESPONSE",
                "任务已结束但没有返回图片",
                false,
            )
            .with_raw(value.to_string()));
        }
        return Ok(JobStatus {
            status: "succeeded".to_string(),
            progress: Some(100.0),
            outputs,
            raw_status: Some(raw_status),
            error: None,
        });
    }
    if normalized == "FAILED" || normalized == "CANCELED" {
        let message = first_string(&value, &["output.message", "message", "error.message"])
            .unwrap_or_else(|| "任务失败".to_string());
        return Ok(JobStatus {
            status: "failed".to_string(),
            progress: None,
            outputs: Vec::new(),
            raw_status: Some(raw_status),
            error: Some(AppError::new("TASK_FAILED", message, false).with_raw(value.to_string())),
        });
    }
    Ok(JobStatus {
        status: "polling".to_string(),
        progress: None,
        outputs: Vec::new(),
        raw_status: Some(raw_status),
        error: None,
    })
}

pub async fn cancel(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    _model: &ModelConfig,
    task_id: &str,
) -> Result<(), AppError> {
    let url = join_path(&runtime.profile.base_url, &format!("{TASK_PATH}/{task_id}"));
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
    Err(super::map_http_status(status, &response.text().await.unwrap_or_default(), LABEL))
}

/// "1024x1536" → "1024*1536"（百炼用 * 分隔尺寸）。
fn dash_size(size: Option<&str>) -> String {
    let raw = size.unwrap_or("").trim();
    if raw.is_empty() {
        return "1024*1024".to_string();
    }
    let converted = raw.replace('x', "*").replace('X', "*");
    if converted.contains('*') {
        converted
    } else {
        "1024*1024".to_string()
    }
}

fn task_id_of(value: &Value) -> Option<String> {
    first_string(
        value,
        &["output.task_id", "output.taskId", "task_id", "taskId", "id"],
    )
}

/// 任务状态可能在 output 里，也可能在顶层。
fn task_status_of(value: &Value) -> Option<String> {
    first_string(
        value,
        &["output.task_status", "task_status", "output.taskStatus", "status"],
    )
}

/// 结果数组可能在 output.results，也可能在顶层 results。
fn result_urls(value: &Value) -> Vec<String> {
    let items = value
        .pointer("/output/results")
        .and_then(Value::as_array)
        .or_else(|| value.get("results").and_then(Value::as_array));
    if let Some(items) = items {
        let urls: Vec<String> = items
            .iter()
            .filter(|item| result_code_ok(item))
            .filter_map(|item| item.get("url").and_then(Value::as_str))
            .filter(|url| !url.is_empty())
            .map(|url| url.to_string())
            .collect();
        if !urls.is_empty() {
            return urls;
        }
    }
    choice_urls(value)
}

/// 3.0 / 2.1 系列：图片在 output.choices[].message.content[].image。
fn choice_urls(value: &Value) -> Vec<String> {
    let Some(choices) = value
        .pointer("/output/choices")
        .and_then(Value::as_array)
        .or_else(|| value.get("choices").and_then(Value::as_array))
    else {
        return Vec::new();
    };
    let mut urls = Vec::new();
    for choice in choices {
        let Some(content) = choice
            .pointer("/message/content")
            .and_then(Value::as_array)
            .or_else(|| choice.get("content").and_then(Value::as_array))
        else {
            continue;
        };
        for part in content {
            if let Some(url) = part.get("image").and_then(Value::as_str) {
                if !url.is_empty() {
                    urls.push(url.to_string());
                }
            }
        }
    }
    urls
}

/// 百炼在失败结果上带 code，非 200 的结果不是可用图片。
fn result_code_ok(item: &Value) -> bool {
    match item.get("code") {
        Some(Value::String(code)) => code == "200",
        Some(Value::Number(code)) => code.as_i64() == Some(200),
        _ => true,
    }
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
            defaults: json!({}),
            protocols: std::collections::HashMap::new(),
            priority: None,
            enabled: None,
            vendor: None,
        }
    }

    fn runtime(base_url: &str) -> ProviderRuntime {
        let mut profile = test_profile("dashscope", base_url);
        profile.models = vec![model()];
        ProviderRuntime {
            profile,
            api_key: "test-key".to_string(),
            protocol: "qwen-image".to_string(),
        }
    }

    fn request() -> CapabilityRequest {
        CapabilityRequest {
            capability: "image.generate".to_string(),
            model: "test-model".to_string(),
            prompt: "雨夜街头".to_string(),
            negative: None,
            params: json!({ "count": 2, "size": "1024x1536" }),
            inputs: vec![PreparedInput {
                role: "reference_image".to_string(),
                kind: "image".to_string(),
                mime: "image/png".to_string(),
                value: "https://cdn.example.com/ref.png".to_string(),
            }],
            client_request_id: "req_1".to_string(),
        }
    }

    #[tokio::test]
    async fn submit_returns_queued_task_id() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/services/aigc/text2image/image-synthesis"))
            .and(body_partial_json(json!({
                "model": "test-model",
                "input": {
                    "prompt": "雨夜街头",
                    "images": [{ "image": "https://cdn.example.com/ref.png" }]
                },
                "parameters": { "size": "1024*1536", "n": 2 }
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "output": { "task_status": "PENDING", "task_id": "task-abc" }
            })))
            .mount(&server)
            .await;
        let result = execute(&reqwest::Client::new(), &runtime(&server.uri()), &request())
            .await
            .expect("submit");
        assert_eq!(result.status, "queued");
        assert_eq!(result.task_id.as_deref(), Some("task-abc"));
        assert!(result.outputs.is_empty());
    }

    #[tokio::test]
    async fn poll_maps_success_to_image_output() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/tasks/task-abc"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "output": {
                    "task_status": "SUCCEEDED",
                    "results": [{ "code": "200", "url": "https://cdn.example.com/out.png" }]
                }
            })))
            .mount(&server)
            .await;
        let status = poll(&reqwest::Client::new(), &runtime(&server.uri()), &model(), "task-abc")
            .await
            .expect("poll");
        assert_eq!(status.status, "succeeded");
        assert_eq!(status.progress, Some(100.0));
        assert_eq!(status.outputs[0].url.as_deref(), Some("https://cdn.example.com/out.png"));
    }

    #[tokio::test]
    async fn poll_maps_failure_with_provider_message() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/tasks/task-abc"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "output": { "task_status": "FAILED", "message": "内容审核未通过" }
            })))
            .mount(&server)
            .await;
        let status = poll(&reqwest::Client::new(), &runtime(&server.uri()), &model(), "task-abc")
            .await
            .expect("poll");
        assert_eq!(status.status, "failed");
        let error = status.error.expect("error");
        assert_eq!(error.code, "TASK_FAILED");
        assert_eq!(error.message, "内容审核未通过");
    }

    #[tokio::test]
    async fn unauthorized_maps_to_auth_error() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/services/aigc/text2image/image-synthesis"))
            .respond_with(ResponseTemplate::new(401).set_body_string("unauthorized"))
            .mount(&server)
            .await;
        let error = execute(&reqwest::Client::new(), &runtime(&server.uri()), &request())
            .await
            .expect_err("auth");
        assert_eq!(error.code, "AUTH_UNAUTHORIZED");
    }

    /// 3.0 系列换了提交端点和请求体：messages 结构 + image-generation 端点。
    #[tokio::test]
    async fn qwen_image_3_uses_the_multimodal_generation_endpoint() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/v1/services/aigc/image-generation/generation"))
            .and(body_partial_json(json!({
                "model": "qwen-image-3.0",
                "input": {
                    "messages": [{
                        "role": "user",
                        "content": [
                            { "text": "雨夜街头" },
                            { "image": "https://cdn.example.com/ref.png" }
                        ]
                    }]
                },
                "parameters": { "size": "1024*1536", "n": 2 }
            })))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "output": { "task_status": "PENDING", "task_id": "task-abc" }
            })))
            .mount(&server)
            .await;
        let mut request = request();
        request.model = "qwen-image-3.0".to_string();
        let result = execute(&reqwest::Client::new(), &runtime(&server.uri()), &request)
            .await
            .expect("submit");
        assert_eq!(result.task_id.as_deref(), Some("task-abc"));
    }

    /// 3.0 系列的图片在 output.choices[].message.content[].image。
    #[tokio::test]
    async fn poll_reads_the_choice_content_shape() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/tasks/task-abc"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "output": {
                    "task_status": "SUCCEEDED",
                    "choices": [{
                        "finish_reason": "stop",
                        "message": {
                            "role": "assistant",
                            "content": [{
                                "type": "image",
                                "image": "https://cdn.example.com/out.png"
                            }]
                        }
                    }]
                }
            })))
            .mount(&server)
            .await;
        let status = poll(&reqwest::Client::new(), &runtime(&server.uri()), &model(), "task-abc")
            .await
            .expect("poll");
        assert_eq!(status.status, "succeeded");
        assert_eq!(status.outputs[0].url.as_deref(), Some("https://cdn.example.com/out.png"));
    }

    #[tokio::test]
    async fn cancel_treats_404_as_ok() {
        let server = MockServer::start().await;
        Mock::given(method("DELETE"))
            .and(path("/api/v1/tasks/task-abc"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        cancel(&reqwest::Client::new(), &runtime(&server.uri()), &model(), "task-abc")
            .await
            .expect("cancel");
    }

    /// 任务成功但没有图片：不能判成功，否则节点拿到空结果。
    #[tokio::test]
    async fn succeeded_without_a_picture_is_an_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/tasks/task_1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "output": { "task_status": "SUCCEEDED", "results": [] }
            })))
            .mount(&server)
            .await;
        let error = poll(
            &reqwest::Client::new(),
            &runtime(&server.uri()),
            &model(),
            "task_1",
        )
        .await
        .expect_err("empty output");
        assert_eq!(error.code, "PROVIDER_BAD_RESPONSE");
    }
}
