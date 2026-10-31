use crate::assets::{self, AssetRef};
use crate::db;
use crate::gateway::{self, AppError, ProviderRuntime};
use crate::security;
use crate::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunInput {
    pub role: String,
    pub asset_id: String,
    pub kind: String,
    pub mime: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRunRequest {
    pub schema_version: u32,
    pub project_id: String,
    pub board_id: String,
    pub node_id: String,
    pub capability: String,
    pub provider_id: String,
    pub model: String,
    pub prompt_snapshot: Value,
    pub params: Value,
    pub inputs: Vec<RunInput>,
    pub input_asset_ids: Vec<String>,
    pub cache_key: String,
    pub cached_asset_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub id: String,
    pub project_id: String,
    pub board_id: String,
    pub node_id: String,
    pub entity_id: Option<String>,
    pub action: String,
    pub cache_key: String,
    pub status: String,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub prompt_snapshot: Value,
    pub params: Value,
    pub input_asset_ids: Vec<String>,
    pub output_asset_ids: Vec<String>,
    pub selected_asset_id: Option<String>,
    pub cost: Option<Value>,
    pub error: Option<AppError>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunUpdatedEvent {
    pub run: RunRecord,
    pub assets: Vec<AssetRef>,
}

pub fn db_path(state: &AppState) -> Result<PathBuf, String> {
    state
        .db_path
        .lock()
        .map(|path| path.clone())
        .map_err(|_| "Project database lock poisoned".to_string())
}

pub fn create_run(state: &AppState, request: &StartRunRequest) -> Result<RunRecord, String> {
    let now = chrono::Utc::now().to_rfc3339();
    let run = RunRecord {
        id: format!("run_{}", uuid::Uuid::new_v4()),
        project_id: request.project_id.clone(),
        board_id: request.board_id.clone(),
        node_id: request.node_id.clone(),
        entity_id: None,
        action: "generate".to_string(),
        cache_key: request.cache_key.clone(),
        status: "queued".to_string(),
        provider_id: Some(request.provider_id.clone()),
        model: Some(request.model.clone()),
        prompt_snapshot: request.prompt_snapshot.clone(),
        params: request.params.clone(),
        input_asset_ids: request.input_asset_ids.clone(),
        output_asset_ids: Vec::new(),
        selected_asset_id: None,
        cost: None,
        error: None,
        started_at: now.clone(),
        finished_at: None,
    };
    save_run(state, &run)?;
    Ok(run)
}

pub fn save_run(state: &AppState, run: &RunRecord) -> Result<(), String> {
    let path = db_path(state)?;
    let connection = db::open(&path)?;
    let payload = serde_json::to_string(run).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO runs (id, project_id, board_id, node_id, status, cache_key, payload, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET status=excluded.status, payload=excluded.payload, updated_at=excluded.updated_at",
            rusqlite::params![
                run.id,
                run.project_id,
                run.board_id,
                run.node_id,
                run.status,
                run.cache_key,
                payload,
                run.started_at,
                chrono::Utc::now().to_rfc3339()
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn load_run(state: &AppState, run_id: &str) -> Result<RunRecord, String> {
    let path = db_path(state)?;
    let connection = db::open(&path)?;
    let payload: String = connection
        .query_row("SELECT payload FROM runs WHERE id=?1", [run_id], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    serde_json::from_str(&payload).map_err(|error| error.to_string())
}

pub fn list_runs(state: &AppState, board_id: &str) -> Result<Vec<RunRecord>, String> {
    let path = db_path(state)?;
    let connection = db::open(&path)?;
    let mut statement = connection
        .prepare("SELECT payload FROM runs WHERE board_id=?1 ORDER BY created_at DESC LIMIT 500")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([board_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    rows.map(|row| {
        let payload = row.map_err(|error| error.to_string())?;
        serde_json::from_str(&payload).map_err(|error| error.to_string())
    })
    .collect()
}

pub fn select_candidate(
    state: &AppState,
    run_id: &str,
    asset_id: &str,
) -> Result<RunRecord, String> {
    let mut run = load_run(state, run_id)?;
    if !run.output_asset_ids.iter().any(|item| item == asset_id) {
        return Err("选中的资产不属于该运行记录".to_string());
    }
    run.selected_asset_id = Some(asset_id.to_string());
    save_run(state, &run)?;
    Ok(run)
}

pub fn mark_cancelled(state: &AppState, run_id: &str) -> Result<RunRecord, String> {
    let mut run = load_run(state, run_id)?;
    run.status = "cancelled".to_string();
    run.finished_at = Some(chrono::Utc::now().to_rfc3339());
    save_run(state, &run)?;
    Ok(run)
}

pub fn mark_running(state: &AppState, run_id: &str) -> Result<RunRecord, String> {
    let mut run = load_run(state, run_id)?;
    run.status = "running".to_string();
    save_run(state, &run)?;
    Ok(run)
}

pub fn finish_cached(
    state: &AppState,
    request: &StartRunRequest,
    asset_id: &str,
) -> Result<RunRecord, String> {
    let mut run = create_run(state, request)?;
    run.status = "succeeded".to_string();
    run.output_asset_ids = vec![asset_id.to_string()];
    run.selected_asset_id = Some(asset_id.to_string());
    run.cost = Some(json!({ "estimated": { "amount": 0, "currency": "", "unit": "缓存命中" } }));
    run.finished_at = Some(chrono::Utc::now().to_rfc3339());
    save_run(state, &run)?;
    Ok(run)
}

async fn prepare_inputs(
    state: &AppState,
    request: &StartRunRequest,
    capability: &gateway::ModelCapability,
    host: &gateway::transport::AssetHostConfig,
) -> Result<Vec<gateway::PreparedInput>, AppError> {
    let path =
        db_path(state).map_err(|message| AppError::new("STORAGE_DB_FAILED", message, false))?;
    let connection =
        db::open(&path).map_err(|message| AppError::new("STORAGE_DB_FAILED", message, false))?;
    let mut prepared = Vec::new();
    for input in &request.inputs {
        let payload: String = connection
            .query_row("SELECT payload FROM assets WHERE id=?1", [&input.asset_id], |row| {
                row.get(0)
            })
            .map_err(|_| {
                AppError::new(
                    "STORAGE_ASSET_MISSING",
                    format!("资产 {} 不存在", input.asset_id),
                    false,
                )
            })?;
        let asset: AssetRef = serde_json::from_str(&payload)
            .map_err(|error| AppError::new("STORAGE_ASSET_CORRUPT", error.to_string(), false))?;
        let transport =
            gateway::transport::prepare_input(&state.data_dir, &asset, &capability.input_transport, host)
                .await?;
        prepared.push(gateway::PreparedInput {
            role: input.role.clone(),
            kind: input.kind.clone(),
            mime: input.mime.clone(),
            value: transport.value,
        });
    }
    Ok(prepared)
}

pub async fn execute_run(
    app: AppHandle,
    state: AppState,
    run: RunRecord,
    job_id: String,
    request: StartRunRequest,
    runtime: ProviderRuntime,
) {
    let model = match runtime.profile.models.iter().find(|item| item.id == request.model) {
        Some(model) => model.clone(),
        None => {
            fail_run(
                &app,
                &state,
                &run,
                AppError::new("PARAM_MODEL_UNKNOWN", "模型未配置", false),
            );
            return;
        }
    };
    let capability = match model.capability(&request.capability) {
        Some(capability) => capability.clone(),
        None => {
            fail_run(
                &app,
                &state,
                &run,
                AppError::new("CAP_UNSUPPORTED_CAPABILITY", "模型不支持该能力", false),
            );
            return;
        }
    };
    let host = crate::asset_host_internal(&state).unwrap_or_default();
    let inputs = match prepare_inputs(&state, &request, &capability, &host).await {
        Ok(inputs) => inputs,
        Err(error) => {
            fail_run(&app, &state, &run, error);
            return;
        }
    };
    let capability_request = gateway::CapabilityRequest {
        capability: request.capability.clone(),
        model: request.model.clone(),
        prompt: request
            .prompt_snapshot
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        negative: request
            .prompt_snapshot
            .get("negative")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        params: request.params.clone(),
        inputs,
        client_request_id: format!("{}-0-1", run.id),
    };
    let client = match crate::http_client() {
        Ok(client) => client,
        Err(message) => {
            fail_run(
                &app,
                &state,
                &run,
                AppError::new("UNAVAILABLE_HTTP", message, false),
            );
            return;
        }
    };
    match gateway::execute(&client, &runtime, &capability_request).await {
        Ok(result) if result.status == "queued" => {
            let task_id = match result.task_id {
                Some(task_id) => task_id,
                None => {
                    fail_run(
                        &app,
                        &state,
                        &run,
                        AppError::new("PROVIDER_BAD_RESPONSE", "异步任务缺少 task_id", false),
                    );
                    return;
                }
            };
            crate::jobs::attach_task(&app, &state, &run, &job_id, &task_id, request, runtime, model);
        }
        Ok(result) => match store_outputs(&app, &state, &run, result.outputs).await {
            Ok(assets) => succeed_run(&app, &state, &run, assets),
            Err(error) => fail_run(&app, &state, &run, error),
        },
        Err(error) => fail_run(&app, &state, &run, error),
    }
}

async fn store_outputs(
    app: &AppHandle,
    state: &AppState,
    run: &RunRecord,
    outputs: Vec<gateway::AssetPayload>,
) -> Result<Vec<AssetRef>, AppError> {
    let mut assets_out = Vec::new();
    for output in outputs {
        let (bytes, mime) = match (output.data, output.url) {
            (Some(data), _) => {
                if output.kind == "text" {
                    (data.into_bytes(), output.mime.clone())
                } else {
                    let decoded = if data.starts_with("data:") {
                        assets::decode_data_url(&data).map(|(_, bytes)| bytes)
                    } else {
                        use base64::Engine;
                        base64::engine::general_purpose::STANDARD.decode(data.as_bytes()).ok()
                    };
                    (
                        decoded.ok_or_else(|| {
                            AppError::new(
                                "DOWNLOAD_DECODE_FAILED",
                                "生成结果 base64 解码失败",
                                true,
                            )
                        })?,
                        output.mime.clone(),
                    )
                }
            }
            (None, Some(url)) => {
                let validated = security::validate_remote_url(&url)?;
                let client = crate::http_client()
                    .map_err(|message| AppError::new("UNAVAILABLE_HTTP", message, false))?;
                let response = client
                    .get(validated)
                    .send()
                    .await
                    .map_err(|error| gateway::map_reqwest(error, "结果下载"))?;
                if !response.status().is_success() {
                    return Err(gateway::map_http_status(response.status(), "", "结果下载"));
                }
                (
                    response
                        .bytes()
                        .await
                        .map_err(|error| gateway::map_reqwest(error, "结果下载"))?
                        .to_vec(),
                    output.mime.clone(),
                )
            }
            (None, None) => {
                return Err(AppError::new(
                    "PROVIDER_BAD_RESPONSE",
                    "生成结果既无 data 也无 url",
                    false,
                ))
            }
        };
        let provenance = json!({
            "projectId": run.project_id,
            "nodeId": run.node_id,
            "runId": run.id,
            "providerId": run.provider_id,
            "model": run.model,
            "promptHash": run.prompt_snapshot.get("hash"),
        });
        let asset = assets::store_bytes(&state.data_dir, &bytes, &output.kind, &mime, provenance)
            .map_err(|message| AppError::new("STORAGE_WRITE_FAILED", message, false))?;
        save_asset(state, &asset)?;
        let _ = app.emit("asset.created", &asset);
        assets_out.push(asset);
    }
    Ok(assets_out)
}

fn save_asset(state: &AppState, asset: &AssetRef) -> Result<(), AppError> {
    let path =
        db_path(state).map_err(|message| AppError::new("STORAGE_DB_FAILED", message, false))?;
    let connection =
        db::open(&path).map_err(|message| AppError::new("STORAGE_DB_FAILED", message, false))?;
    let payload = serde_json::to_string(asset)
        .map_err(|error| AppError::new("STORAGE_JSON_FAILED", error.to_string(), false))?;
    connection
        .execute(
            "INSERT OR REPLACE INTO assets (id, kind, path, mime, bytes, width, height, duration, payload, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                asset.id,
                asset.kind,
                asset.path,
                asset.mime,
                asset.bytes,
                asset.width,
                asset.height,
                asset.duration,
                payload,
                asset.created_at
            ],
        )
        .map_err(|error| AppError::new("STORAGE_DB_FAILED", error.to_string(), false))?;
    Ok(())
}

fn succeed_run(app: &AppHandle, state: &AppState, run: &RunRecord, assets_out: Vec<AssetRef>) {
    let mut finished = run.clone();
    finished.status = "succeeded".to_string();
    finished.output_asset_ids = assets_out.iter().map(|asset| asset.id.clone()).collect();
    if finished.output_asset_ids.len() == 1 {
        finished.selected_asset_id = finished.output_asset_ids.first().cloned();
    }
    finished.finished_at = Some(chrono::Utc::now().to_rfc3339());
    let _ = save_run(state, &finished);
    let _ = app.emit(
        "run.updated",
        &RunUpdatedEvent {
            run: finished,
            assets: assets_out,
        },
    );
}

fn fail_run(app: &AppHandle, state: &AppState, run: &RunRecord, error: AppError) {
    let mut finished = run.clone();
    finished.status = "failed".to_string();
    finished.error = Some(error);
    finished.finished_at = Some(chrono::Utc::now().to_rfc3339());
    let _ = save_run(state, &finished);
    let _ = app.emit(
        "run.updated",
        &RunUpdatedEvent {
            run: finished,
            assets: Vec::new(),
        },
    );
}

pub fn load_provider_profile(
    state: &AppState,
    provider_id: &str,
) -> Result<Option<gateway::ProviderProfile>, String> {
    let path = db_path(state)?;
    let connection = db::open(&path)?;
    let mut statement = connection
        .prepare("SELECT payload FROM provider_profiles WHERE id=?1")
        .map_err(|error| error.to_string())?;
    let mut rows = statement
        .query([provider_id])
        .map_err(|error| error.to_string())?;
    match rows.next().map_err(|error| error.to_string())? {
        Some(row) => {
            let payload: String = row.get(0).map_err(|error| error.to_string())?;
            Ok(Some(
                serde_json::from_str(&payload).map_err(|error| error.to_string())?,
            ))
        }
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn request(cache_key: &str) -> StartRunRequest {
        StartRunRequest {
            schema_version: 1,
            project_id: "project_1".to_string(),
            board_id: "board_1".to_string(),
            node_id: "node_1".to_string(),
            capability: "text.chat".to_string(),
            provider_id: "openai-compatible".to_string(),
            model: "test-model".to_string(),
            prompt_snapshot: json!({ "text": "hi", "segments": [], "hash": "h", "locked": false }),
            params: json!({}),
            inputs: Vec::new(),
            input_asset_ids: Vec::new(),
            cache_key: cache_key.to_string(),
            cached_asset_id: None,
        }
    }

    #[test]
    fn creates_and_reads_a_queued_run() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = crate::AppState {
            db_path: std::sync::Mutex::new(dir.path().join("db.sqlite3")),
            data_dir: dir.path().to_path_buf(),
        };
        let run = create_run(&state, &request("cache-1")).expect("create");
        assert_eq!(run.status, "queued");
        let loaded = load_run(&state, &run.id).expect("load");
        assert_eq!(loaded.cache_key, "cache-1");
        assert_eq!(list_runs(&state, "board_1").expect("list").len(), 1);
    }

    #[test]
    fn selecting_a_candidate_updates_the_run() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = crate::AppState {
            db_path: std::sync::Mutex::new(dir.path().join("db.sqlite3")),
            data_dir: dir.path().to_path_buf(),
        };
        let mut run = create_run(&state, &request("cache-2")).expect("create");
        run.status = "succeeded".to_string();
        run.output_asset_ids = vec!["asset_a".to_string(), "asset_b".to_string()];
        save_run(&state, &run).expect("save");
        let updated = select_candidate(&state, &run.id, "asset_b").expect("select");
        assert_eq!(updated.selected_asset_id.as_deref(), Some("asset_b"));
    }
}
