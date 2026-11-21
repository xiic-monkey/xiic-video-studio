//! 阿里云百炼（DashScope）通义万相生图适配器。
//!
//! 协议 `qwen-image`：提交走异步接口，返回 task_id 后轮询任务状态。
use super::{
    join_path, read_json, AdapterResult, AppError, AssetPayload, CapabilityRequest, JobStatus,
    ModelConfig, ProviderRuntime,
};
use serde_json::{json, Value};

const LABEL: &str = "通义万相";
/// 百炼异步文生图 / 图生图提交端点。
const SUBMIT_PATH: &str = "/api/v1/services/aigc/text2image/image-synthesis";
/// 异步任务查询端点前缀。
const TASK_PATH: &str = "/api/v1/tasks";

pub async fn execute(
    client: &reqwest::Client,
    runtime: &ProviderRuntime,
    request: &CapabilityRequest,
) -> Result<AdapterResult, AppError> {
    let size = dash_size(request.params.get("size").and_then(Value::as_str));
    let count = request.params.get("count").and_then(Value::as_u64).unwrap_or(1).clamp(1, 4);

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

    let body = json!({
        "model": request.model,
        "input": input,
        "parameters": {
            "size": size,
            "n": count,
            "prompt_extend": false,
            "watermark": false
        }
    });

    let response = client
        .post(join_path(&runtime.profile.base_url, SUBMIT_PATH))
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
    let Some(items) = items else { return Vec::new() };
    items
        .iter()
        .filter(|item| result_code_ok(item))
        .filter_map(|item| item.get("url").and_then(Value::as_str))
        .filter(|url| !url.is_empty())
        .map(|url| url.to_string())
        .collect()
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
}
