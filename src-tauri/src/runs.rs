use crate::assets::{self, AssetRef};
use crate::db;
use crate::gateway::{self, AppError};
use crate::production::repository::{record_asset_membership, AssetOrigin};
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

/// 命中的路由信息：最终用哪家供应商、哪个 Key、哪个协议。
///
/// 写进任务载荷，重启后恢复轮询时按同一条路由继续。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteInfo {
    pub provider_id: String,
    pub provider_name: String,
    pub key_ref: String,
    pub key_label: String,
    pub protocol: String,
}

/// 一次尝试：某个供应商 / Key 的调用结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunAttempt {
    pub provider_id: String,
    pub provider_name: String,
    pub key_label: String,
    pub protocol: String,
    pub ok: bool,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRunRequest {
    pub schema_version: u32,
    pub project_id: String,
    pub board_id: String,
    pub node_id: String,
    /// Optional production entity association. When present, the backend verifies
    /// that the entity belongs to the same project before creating the run.
    #[serde(default)]
    pub entity_id: Option<String>,
    /// User-visible production action (for example `video` or `storyboard`).
    #[serde(default)]
    pub action: Option<String>,
    pub capability: String,
    /// 空串表示自动路由：由后端按模型下各供应商的顺序逐家尝试。
    pub provider_id: String,
    pub model: String,
    /// 前端按目录解析出的协议；绑定里显式配的协议优先于它。
    #[serde(default)]
    pub protocol: String,
    pub prompt_snapshot: Value,
    pub params: Value,
    pub inputs: Vec<RunInput>,
    pub input_asset_ids: Vec<String>,
    pub cache_key: String,
    pub cached_asset_id: Option<String>,
    #[serde(default)]
    pub route: Option<RouteInfo>,
    /// 节点级参考图（例如三视图拆出来的视角），由后端按资产 id 解析。
    #[serde(default)]
    pub reference_asset_ids: Vec<String>,
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
    #[serde(default)]
    pub route: Vec<RunAttempt>,
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
        entity_id: request.entity_id.clone(),
        action: request.action.clone().unwrap_or_else(|| "generate".to_string()),
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
        route: Vec::new(),
        started_at: now.clone(),
        finished_at: None,
    };
    save_run(state, &run)?;
    Ok(run)
}

pub fn save_run(state: &AppState, run: &RunRecord) -> Result<(), String> {
    let path = db_path(state)?;
    save_run_at(&path, run)
}

pub(crate) fn save_run_at(path: &PathBuf, run: &RunRecord) -> Result<(), String> {
    let connection = db::open(path)?;
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
        .query_row("SELECT payload FROM runs WHERE id=?1", [run_id], |row| {
            row.get(0)
        })
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
    close_jobs_for_run(state, run_id, "cancelled");
    Ok(run)
}

/// 运行到达终态时，把这个 run 名下还在跑的 job 行一并关掉。
///
/// job 的生命周期跟着运行走：留着 queued/submitted，下次启动的恢复扫描会
/// 把它当成「提交阶段被中断」，反过来把已经成功的运行改判成失败。
fn close_jobs_for_run(state: &AppState, run_id: &str, status: &str) {
    let Ok(path) = db_path(state) else { return };
    let Ok(connection) = db::open(&path) else {
        return;
    };
    let _ = connection.execute(
        "UPDATE jobs SET status=?1, updated_at=?2 WHERE run_id=?3 AND status IN ('queued','submitted','polling')",
        rusqlite::params![status, chrono::Utc::now().to_rfc3339(), run_id],
    );
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
            .query_row(
                "SELECT payload FROM assets WHERE id=?1",
                [&input.asset_id],
                |row| row.get(0),
            )
            .map_err(|_| {
                AppError::new(
                    "STORAGE_ASSET_MISSING",
                    format!("资产 {} 不存在", input.asset_id),
                    false,
                )
            })?;
        let asset: AssetRef = serde_json::from_str(&payload)
            .map_err(|error| AppError::new("STORAGE_ASSET_CORRUPT", error.to_string(), false))?;
        let transport = gateway::transport::prepare_input(
            &state.data_dir,
            &asset,
            &capability.input_transport,
            host,
        )
        .await?;
        prepared.push(gateway::PreparedInput {
            role: input.role.clone(),
            kind: asset.kind.clone(),
            mime: asset.mime.clone(),
            value: transport.value,
        });
    }
    // 节点级参考图：拆帧出来的视角、锁版后的角色包等。
    for asset_id in &request.reference_asset_ids {
        let payload: String = connection
            .query_row(
                "SELECT payload FROM assets WHERE id=?1",
                [asset_id],
                |row| row.get(0),
            )
            .map_err(|_| {
                AppError::new(
                    "STORAGE_ASSET_MISSING",
                    format!("参考资产 {asset_id} 不存在"),
                    false,
                )
            })?;
        let asset: AssetRef = serde_json::from_str(&payload)
            .map_err(|error| AppError::new("STORAGE_ASSET_CORRUPT", error.to_string(), false))?;
        let transport = gateway::transport::prepare_input(
            &state.data_dir,
            &asset,
            &capability.input_transport,
            host,
        )
        .await?;
        prepared.push(gateway::PreparedInput {
            role: "reference_image".to_string(),
            kind: asset.kind.clone(),
            mime: asset.mime.clone(),
            value: transport.value,
        });
    }
    Ok(prepared)
}

/// 素材传输方式不匹配：换一家支持另一种传输方式的供应商可能就能跑，
/// 不能在这里把整次运行判死。
pub fn retries_with_next_candidate(error: &AppError) -> bool {
    error.code == "CAP_PUBLIC_URL_REQUIRED"
}

/// 按候选顺序执行：一家失败就换下一家 / 下一个 Key。
///
/// 回退策略在 `gateway::should_fallback`：参数错、审核拒这类「换家也一样」的错误直接失败。
pub async fn execute_run(
    app: AppHandle,
    state: AppState,
    run: RunRecord,
    job_id: String,
    request: StartRunRequest,
    candidates: Vec<gateway::Candidate>,
) {
    let host = crate::asset_host_internal(&state).unwrap_or_default();
    let client = match crate::http_client() {
        Ok(client) => client,
        Err(message) => {
            fail_run(
                &app,
                &state,
                &run,
                AppError::new("UNAVAILABLE_HTTP", message, false),
                Vec::new(),
            );
            return;
        }
    };
    let mut attempts: Vec<RunAttempt> = Vec::new();
    let mut last_error: Option<AppError> = None;

    for candidate in candidates {
        let profile = match load_provider_profile(&state, &candidate.provider_id) {
            Ok(Some(profile)) => profile,
            _ => continue,
        };
        let Some(model) = profile.model(&request.model).cloned() else {
            continue;
        };
        let Some(capability) = model.capability(&request.capability).cloned() else {
            continue;
        };
        let Some(api_key) = crate::provider_key_secret(&candidate.key_ref) else {
            continue;
        };
        let inputs = match prepare_inputs(&state, &request, &capability, &host).await {
            Ok(inputs) => inputs,
            Err(error) => {
                if retries_with_next_candidate(&error) {
                    // 素材传输方式不匹配：这一家只收公网链接，换一家支持
                    // dataUrl 的供应商可能就能跑，不能在这里把整次运行判死。
                    attempts.push(attempt_of(
                        &candidate,
                        false,
                        Some(error.code.clone()),
                        Some(error.message.clone()),
                    ));
                    last_error = Some(error);
                    continue;
                }
                // 其余输入问题（素材缺失、损坏等）换供应商也一样，直接失败。
                fail_run(&app, &state, &run, error, attempts);
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
        let runtime = gateway::ProviderRuntime {
            profile: profile.clone(),
            api_key,
            protocol: candidate.protocol.clone(),
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
                            attempts,
                        );
                        return;
                    }
                };
                attempts.push(attempt_of(&candidate, true, None, None));
                let route = RouteInfo {
                    provider_id: candidate.provider_id.clone(),
                    provider_name: candidate.provider_name.clone(),
                    key_ref: candidate.key_ref.clone(),
                    key_label: candidate.key_label.clone(),
                    protocol: candidate.protocol.clone(),
                };
                let mut routed = request.clone();
                routed.route = Some(route);
                let tracked = run_with_attempts(&run, &attempts, Some(&candidate));
                crate::jobs::attach_task(
                    &app, &state, &tracked, &job_id, &task_id, routed, runtime, model,
                );
                return;
            }
            Ok(result) => {
                attempts.push(attempt_of(&candidate, true, None, None));
                let tracked = run_with_attempts(&run, &attempts, Some(&candidate));
                match store_outputs(&app, &state, &tracked, result.outputs).await {
                    Ok(assets) => succeed_run(&app, &state, &tracked, assets),
                    Err(error) => fail_run(&app, &state, &tracked, error, attempts),
                }
                return;
            }
            Err(error) => {
                attempts.push(attempt_of(
                    &candidate,
                    false,
                    Some(error.code.clone()),
                    Some(error.message.clone()),
                ));
                if gateway::invalidates_key(&error) {
                    let _ = mark_key_invalid(&state, &candidate.provider_id, &candidate.key_id);
                } else if gateway::cooldowns_key(&error) {
                    let _ = mark_key_cooldown(&state, &candidate.provider_id, &candidate.key_id);
                }
                if !gateway::should_fallback(&error) {
                    fail_run(&app, &state, &run, error, attempts);
                    return;
                }
                last_error = Some(error);
            }
        }
    }

    let error = last_error.unwrap_or_else(|| {
        AppError::new(
            "CAP_NO_PROVIDER",
            "没有可用供应商：请检查该模型的供应商配置与 API Key",
            false,
        )
    });
    fail_run(&app, &state, &run, error, attempts);
}

fn attempt_of(
    candidate: &gateway::Candidate,
    ok: bool,
    code: Option<String>,
    message: Option<String>,
) -> RunAttempt {
    RunAttempt {
        provider_id: candidate.provider_id.clone(),
        provider_name: candidate.provider_name.clone(),
        key_label: candidate.key_label.clone(),
        protocol: candidate.protocol.clone(),
        ok,
        code,
        message,
    }
}

/// 把尝试轨迹写回运行记录。
fn run_with_attempts(
    run: &RunRecord,
    attempts: &[RunAttempt],
    winner: Option<&gateway::Candidate>,
) -> RunRecord {
    let mut tracked = run.clone();
    tracked.route = attempts.to_vec();
    if let Some(candidate) = winner {
        tracked.provider_id = Some(candidate.provider_id.clone());
    }
    tracked
}

/// 单个生成结果的下载上限（256 MB）：视频再大也不该把内存吃光。
const MAX_OUTPUT_BYTES: u64 = 256 * 1024 * 1024;

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
                        base64::engine::general_purpose::STANDARD
                            .decode(data.as_bytes())
                            .ok()
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
                // 下载结果要有上限：供应商返回超大文件时不能把内存吃光。
                let length = response.content_length().unwrap_or_default() as u64;
                if length > MAX_OUTPUT_BYTES {
                    return Err(AppError::new(
                        "DOWNLOAD_TOO_LARGE",
                        "生成结果超过下载上限",
                        false,
                    ));
                }
                let bytes = response
                    .bytes()
                    .await
                    .map_err(|error| gateway::map_reqwest(error, "结果下载"))?;
                if bytes.len() as u64 > MAX_OUTPUT_BYTES {
                    return Err(AppError::new(
                        "DOWNLOAD_TOO_LARGE",
                        "生成结果超过下载上限",
                        false,
                    ));
                }
                (bytes.to_vec(), output.mime.clone())
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
        let _ = app.emit("asset/created", &asset);
        assets_out.push(asset);
    }
    Ok(assets_out)
}

/// 轮询器只持有 db_path / data_dir，这里现场组装一个临时 AppState 复用同一条落盘路径。
pub(crate) async fn store_outputs_for_poll(
    app: &AppHandle,
    db_path: &PathBuf,
    data_dir: &PathBuf,
    run: &RunRecord,
    outputs: Vec<gateway::AssetPayload>,
) -> Result<Vec<AssetRef>, AppError> {
    let state = crate::AppState {
        db_path: std::sync::Mutex::new(db_path.clone()),
        data_dir: data_dir.clone(),
    };
    store_outputs(app, &state, run, outputs).await
}

pub(crate) fn save_asset(state: &AppState, asset: &AssetRef) -> Result<(), AppError> {
    let path =
        db_path(state).map_err(|message| AppError::new("STORAGE_DB_FAILED", message, false))?;
    let connection =
        db::open(&path).map_err(|message| AppError::new("STORAGE_DB_FAILED", message, false))?;
    let payload = serde_json::to_string(asset)
        .map_err(|error| AppError::new("STORAGE_JSON_FAILED", error.to_string(), false))?;
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| AppError::new("STORAGE_DB_FAILED", error.to_string(), false))?;
    transaction
        .execute(
            "INSERT INTO assets (id, kind, path, mime, bytes, width, height, duration, payload, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO NOTHING",
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
    let project_id = asset
        .provenance
        .get("projectId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| AppError::new("PROJECT_ID_REQUIRED", "素材缺少项目归属", false))?;
    record_asset_membership(
        &transaction,
        project_id,
        asset,
        &AssetOrigin {
            kind: asset
                .provenance
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("generated")
                .to_string(),
            reference: asset
                .provenance
                .get("runId")
                .or_else(|| asset.provenance.get("sourceAssetId"))
                .and_then(Value::as_str)
                .map(str::to_string),
        },
    )
    .map_err(|error| AppError::new("STORAGE_DB_FAILED", error.to_string(), false))?;
    transaction
        .commit()
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
    close_jobs_for_run(state, &finished.id, "succeeded");
    let _ = app.emit(
        "run/updated",
        &RunUpdatedEvent {
            run: finished,
            assets: assets_out,
        },
    );
}

fn fail_run(
    app: &AppHandle,
    state: &AppState,
    run: &RunRecord,
    error: AppError,
    attempts: Vec<RunAttempt>,
) {
    let mut finished = run.clone();
    finished.status = "failed".to_string();
    finished.error = Some(error);
    finished.route = attempts;
    finished.finished_at = Some(chrono::Utc::now().to_rfc3339());
    let _ = save_run(state, &finished);
    close_jobs_for_run(state, &finished.id, "failed");
    let _ = app.emit(
        "run/updated",
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

/// 全部供应商配置。
pub fn list_provider_profiles(state: &AppState) -> Result<Vec<gateway::ProviderProfile>, String> {
    let path = db_path(state)?;
    let connection = db::open(&path)?;
    let mut statement = connection
        .prepare("SELECT payload FROM provider_profiles ORDER BY id")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    rows.map(|row| {
        let payload = row.map_err(|error| error.to_string())?;
        serde_json::from_str(&payload).map_err(|error| error.to_string())
    })
    .collect()
}

/// 把「模型 + 能力」展开成有序的候选列表（供应商 × Key）。
///
/// 规则：
/// - 节点指定了供应商就只用这一家；否则按该模型下各供应商的 priority 排序；
/// - 停用的供应商、停用的绑定、能力不匹配的绑定都跳过；
/// - 一家供应商的多个 Key 按配置顺序展开成多个候选。
pub fn expand_candidates(
    state: &AppState,
    request: &StartRunRequest,
) -> Result<Vec<gateway::Candidate>, String> {
    let profiles = list_provider_profiles(state)?;
    let pinned = request.provider_id.trim();
    let mut candidates: Vec<(i64, String, usize, gateway::Candidate)> = Vec::new();

    for profile in profiles {
        if !profile.enabled {
            continue;
        }
        if !pinned.is_empty() && profile.id != pinned {
            continue;
        }
        let Some(binding) = profile.model(&request.model) else {
            continue;
        };
        if binding.enabled == Some(false) {
            continue;
        }
        if binding.capability(&request.capability).is_none() {
            continue;
        }
        // 协议优先级：绑定里显式配的 > 请求带的（前端按目录解析）> 旧适配器默认值。
        // 绑定优先，用户在设置里为这条绑定改的协议才不会白改。
        let protocol = binding
            .protocols
            .get(&request.capability)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| {
                let requested = request.protocol.trim();
                if requested.is_empty() {
                    None
                } else {
                    Some(requested.to_string())
                }
            })
            .unwrap_or_else(|| {
                gateway::legacy_protocol(&profile.adapter, &request.capability).to_string()
            });
        let priority = binding.priority.unwrap_or(100);
        for (index, (key_id, key_ref)) in profile.key_refs().iter().enumerate() {
            candidates.push((
                priority,
                profile.id.clone(),
                index,
                gateway::Candidate {
                    provider_id: profile.id.clone(),
                    provider_name: profile.name.clone(),
                    base_url: profile.base_url.clone(),
                    auth_kind: profile.auth.kind.clone(),
                    model_id: request.model.clone(),
                    protocol: protocol.clone(),
                    key_id: key_id.clone(),
                    key_ref: key_ref.clone(),
                    key_label: profile
                        .keys
                        .iter()
                        .find(|key| &key.id == key_id)
                        .map(|key| key.label.clone())
                        .unwrap_or_else(|| key_id.clone()),
                },
            ));
        }
    }

    candidates.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then(left.1.cmp(&right.1))
            .then(left.2.cmp(&right.2))
    });
    Ok(candidates
        .into_iter()
        .map(|(_, _, _, candidate)| candidate)
        .collect())
}

/// 这次请求是不是异步能力（决定要不要建 job 行）。
///
/// 按实际选中的首个候选判断：「任一供应商支持异步」会把同步请求误判成异步，
/// 留下永不清理的孤儿 job 行。
pub fn request_is_async(
    state: &AppState,
    request: &StartRunRequest,
    candidates: &[gateway::Candidate],
) -> bool {
    let Some(candidate) = candidates.first() else {
        return false;
    };
    load_provider_profile(state, &candidate.provider_id)
        .ok()
        .flatten()
        .and_then(|profile| {
            profile
                .model(&candidate.model_id)
                .and_then(|model| model.capability(&request.capability))
                .map(|capability| capability.async_job)
        })
        .unwrap_or(false)
}

/// 读取供应商 profile 的原始 JSON。
///
/// 不经过 `ProviderProfile` 结构体：结构体只建模了部分字段，反序列化再序列化
/// 会丢掉绑定参数、能力上限等配置。
pub fn load_provider_profile_json(
    state: &AppState,
    provider_id: &str,
) -> Result<Option<Value>, String> {
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

/// 只改某个 Key 的状态字段，其余配置原样保留。
pub fn patch_key_status(
    state: &AppState,
    provider_id: &str,
    key_id: &str,
    status: &str,
    cooldown_until: Option<String>,
) -> Result<bool, String> {
    let Some(mut profile) = load_provider_profile_json(state, provider_id)? else {
        return Ok(false);
    };
    let Some(keys) = profile.get_mut("keys").and_then(Value::as_array_mut) else {
        return Ok(false);
    };
    let Some(key) = keys
        .iter_mut()
        .find(|key| key.get("id").and_then(Value::as_str) == Some(key_id))
    else {
        return Ok(false);
    };
    let Some(object) = key.as_object_mut() else {
        return Ok(false);
    };
    object.insert("status".to_string(), Value::String(status.to_string()));
    match cooldown_until {
        Some(until) => {
            object.insert("cooldownUntil".to_string(), Value::String(until));
        }
        None => {
            object.remove("cooldownUntil");
        }
    }
    let payload = serde_json::to_string(&profile).map_err(|error| error.to_string())?;
    let path = db_path(state)?;
    db::open(&path)?
        .execute(
            "UPDATE provider_profiles SET payload=?1, updated_at=?2 WHERE id=?3",
            rusqlite::params![payload, chrono::Utc::now().to_rfc3339(), provider_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(true)
}

/// 把某个 Key 标记为失效（401 之后不再尝试这个 Key）。
pub fn mark_key_invalid(state: &AppState, provider_id: &str, key_id: &str) -> Result<(), String> {
    // 已经是失效状态就不必再写一次。
    if let Some(profile) = load_provider_profile_json(state, provider_id)? {
        let already = profile
            .get("keys")
            .and_then(Value::as_array)
            .and_then(|keys| {
                keys.iter()
                    .find(|key| key.get("id").and_then(Value::as_str) == Some(key_id))
                    .and_then(|key| key.get("status"))
                    .and_then(Value::as_str)
                    .map(|status| status == "invalid")
            })
            .unwrap_or(false);
        if already {
            return Ok(());
        }
    }
    patch_key_status(state, provider_id, key_id, "invalid", None)?;
    Ok(())
}

/// 把某个 Key 限时冷却：限流 / 服务不可用等临时错误不再立刻重试。
pub fn mark_key_cooldown(state: &AppState, provider_id: &str, key_id: &str) -> Result<(), String> {
    let until = (chrono::Utc::now() + chrono::Duration::seconds(gateway::KEY_COOLDOWN_SECONDS))
        .to_rfc3339();
    patch_key_status(state, provider_id, key_id, "cooling", Some(until))?;
    Ok(())
}

/// 把某个 Key 恢复成可用（用户重新填了密钥，或删掉了这个 Key）。
pub fn reset_key_status(state: &AppState, provider_id: &str, key_id: &str) -> Result<(), String> {
    patch_key_status(state, provider_id, key_id, "active", None)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    fn runs_db_path(state: &crate::AppState) -> PathBuf {
        state.db_path.lock().expect("lock").clone()
    }

    #[test]
    fn duplicate_asset_preserves_each_project_origin() {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState {
            db_path: std::sync::Mutex::new(directory.path().join("db.sqlite3")),
            data_dir: directory.path().to_owned(),
        };
        let first = assets::store_bytes(
            directory.path(),
            b"same-content",
            "text",
            "text/plain",
            json!({"projectId":"p1", "runId":"run-1"}),
        )
        .unwrap();
        let second = assets::store_bytes(
            directory.path(),
            b"same-content",
            "text",
            "text/plain",
            json!({"projectId":"p2", "runId":"run-2"}),
        )
        .unwrap();
        save_asset(&state, &first).unwrap();
        save_asset(&state, &second).unwrap();
        let connection = db::open(&runs_db_path(&state)).unwrap();
        let membership_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM project_assets WHERE asset_id=?1",
                [&first.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(membership_count, 2);
        let first_asset =
            crate::production::repository::require_project_asset(&connection, "p1", &first.id)
                .unwrap();
        let second_asset =
            crate::production::repository::require_project_asset(&connection, "p2", &first.id)
                .unwrap();
        assert_eq!(first_asset.provenance["runId"], "run-1");
        assert_eq!(second_asset.provenance["runId"], "run-2");
    }

    fn request(cache_key: &str) -> StartRunRequest {
        StartRunRequest {
            schema_version: 1,
            project_id: "project_1".to_string(),
            board_id: "board_1".to_string(),
            node_id: "node_1".to_string(),
            entity_id: None,
            action: None,
            capability: "text.chat".to_string(),
            provider_id: "openai-compatible".to_string(),
            model: "test-model".to_string(),
            protocol: String::new(),
            prompt_snapshot: json!({ "text": "hi", "segments": [], "hash": "h", "locked": false }),
            params: json!({}),
            inputs: Vec::new(),
            input_asset_ids: Vec::new(),
            cache_key: cache_key.to_string(),
            cached_asset_id: None,
            route: None,
            reference_asset_ids: Vec::new(),
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
    fn production_runs_keep_the_shot_and_action_association() {
        let dir = tempfile::tempdir().unwrap();
        let state = crate::AppState {
            db_path: std::sync::Mutex::new(dir.path().join("db.sqlite3")),
            data_dir: dir.path().to_path_buf(),
        };
        let mut request = request("cache-shot");
        request.entity_id = Some("shot-7".into());
        request.action = Some("video".into());
        let run = create_run(&state, &request).unwrap();
        assert_eq!(run.entity_id.as_deref(), Some("shot-7"));
        assert_eq!(run.action, "video");
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

    /// 候选展开：按模型下的优先级排序，停用的供应商/绑定被跳过，指定供应商时只留这一家。
    #[test]
    fn expands_candidates_in_priority_order() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = crate::AppState {
            db_path: std::sync::Mutex::new(dir.path().join("db.sqlite3")),
            data_dir: dir.path().to_path_buf(),
        };
        let connection = db::open(&runs_db_path(&state)).expect("db");
        let now = chrono::Utc::now().to_rfc3339();
        for (id, priority, enabled) in [
            ("slow", 50_i64, true),
            ("fast", 10, true),
            ("off", 1, false),
        ] {
            let profile = gateway::ProviderProfile {
                id: id.to_string(),
                name: id.to_string(),
                adapter: "minimax-h3".to_string(),
                base_url: "https://example.com".to_string(),
                auth: gateway::AuthConfig {
                    kind: "bearer".to_string(),
                    key_ref: format!("provider/{id}"),
                },
                models: vec![gateway::ModelConfig {
                    id: "MiniMax-H3".to_string(),
                    display_name: "MiniMax H3".to_string(),
                    capabilities: vec![gateway::ModelCapability {
                        capability: "video.generate".to_string(),
                        input_transport: vec!["publicUrl".to_string()],
                        async_job: true,
                        durations: None,
                        max_prompt_chars: None,
                    }],
                    defaults: Value::Null,
                    protocols: HashMap::new(),
                    priority: Some(priority),
                    enabled: Some(enabled),
                    vendor: None,
                }],
                enabled: true,
                keys: vec![gateway::ProviderKey {
                    id: "k1".to_string(),
                    label: "主 Key".to_string(),
                    key_ref: format!("provider/{id}/key/k1"),
                    enabled: true,
                    status: "active".to_string(),
                    cooldown_until: None,
                    has_secret: false,
                }],
                schema_version: 2,
                has_key: false,
            };
            connection
                .execute(
                    "INSERT INTO provider_profiles (id, adapter, base_url, enabled, payload, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    rusqlite::params![id, "minimax-h3", "https://example.com", 1, serde_json::to_string(&profile).expect("json"), now],
                )
                .expect("insert");
        }

        let mut request = request("cache-3");
        request.model = "MiniMax-H3".to_string();
        request.capability = "video.generate".to_string();
        request.provider_id = String::new();
        let candidates = expand_candidates(&state, &request).expect("candidates");
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].provider_id, "fast");
        assert_eq!(candidates[1].provider_id, "slow");
        assert_eq!(candidates[0].protocol, "minimax-video");
        assert_eq!(candidates[0].key_label, "主 Key");

        // 指定供应商后只留这一家。
        request.provider_id = "slow".to_string();
        let pinned = expand_candidates(&state, &request).expect("pinned");
        assert_eq!(pinned.len(), 1);
        assert_eq!(pinned[0].provider_id, "slow");

        // 前端按目录解析的协议优先于后端 binding 的旧适配器兜底。
        request.provider_id = String::new();
        request.protocol = "seedance-video".to_string();
        let overridden = expand_candidates(&state, &request).expect("overridden");
        assert!(overridden
            .iter()
            .all(|candidate| candidate.protocol == "seedance-video"));
    }

    /// 改 Key 状态时不能顺手把用户配置的参数洗掉：
    /// 结构体只建模了部分字段，整份覆盖会把绑定参数、能力上限抹掉。
    #[test]
    fn patching_a_key_status_keeps_the_rest_of_the_profile() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = crate::AppState {
            db_path: std::sync::Mutex::new(dir.path().join("db.sqlite3")),
            data_dir: dir.path().to_path_buf(),
        };
        let connection = db::open(&runs_db_path(&state)).expect("db");
        let profile = json!({
            "id": "p1",
            "name": "P1",
            "adapter": "openai-compatible",
            "baseUrl": "https://example.com",
            "auth": { "type": "bearer", "keyRef": "provider/p1" },
            "enabled": true,
            "schemaVersion": 2,
            "models": [{
                "id": "gpt-image-2.6-flare",
                "displayName": "GPT Image 1",
                "params": [{ "key": "quality", "label": "质量", "type": "select" }],
                "capabilities": [{
                    "capability": "image.edit",
                    "supportsMask": true,
                    "maxReferenceImages": 4,
                    "inputTransport": ["dataUrl"],
                    "async": false
                }]
            }],
            "keys": [{
                "id": "k1", "label": "主", "keyRef": "provider/p1/key/k1",
                "enabled": true, "status": "active"
            }]
        });
        connection
            .execute(
                "INSERT INTO provider_profiles (id, adapter, base_url, enabled, payload, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![
                    "p1", "openai-compatible", "https://example.com", 1,
                    serde_json::to_string(&profile).expect("json"),
                    chrono::Utc::now().to_rfc3339()
                ],
            )
            .expect("insert");

        mark_key_invalid(&state, "p1", "k1").expect("mark");
        let stored = load_provider_profile_json(&state, "p1")
            .expect("load")
            .expect("profile");
        assert_eq!(stored["keys"][0]["status"], "invalid");
        // 状态之外的配置必须原样保留。
        assert_eq!(stored["models"][0]["params"][0]["key"], "quality");
        assert_eq!(stored["models"][0]["capabilities"][0]["supportsMask"], true);
        assert_eq!(
            stored["models"][0]["capabilities"][0]["maxReferenceImages"],
            4
        );

        // 重新填密钥后要能恢复可用，否则这个 Key 永远被跳过。
        reset_key_status(&state, "p1", "k1").expect("reset");
        let restored = load_provider_profile_json(&state, "p1")
            .expect("load")
            .expect("profile");
        assert_eq!(restored["keys"][0]["status"], "active");
    }

    /// 传输方式不匹配时换下一家，而不是把整次运行判死。
    #[test]
    fn transport_mismatch_retries_with_the_next_candidate() {
        let transport = AppError::new("CAP_PUBLIC_URL_REQUIRED", "需要公网链接", false);
        assert!(retries_with_next_candidate(&transport));
        let missing = AppError::new("STORAGE_ASSET_MISSING", "资产不存在", false);
        assert!(!retries_with_next_candidate(&missing));
    }

    /// 绑定里显式配的协议优先于请求带的：用户在设置里改过的协议要真的生效。
    #[test]
    fn binding_protocol_overrides_the_request_protocol() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = crate::AppState {
            db_path: std::sync::Mutex::new(dir.path().join("db.sqlite3")),
            data_dir: dir.path().to_path_buf(),
        };
        let connection = db::open(&runs_db_path(&state)).expect("db");
        let now = chrono::Utc::now().to_rfc3339();
        let mut protocols = HashMap::new();
        protocols.insert("video.generate".to_string(), "seedance-video".to_string());
        let profile = gateway::ProviderProfile {
            id: "bound".to_string(),
            name: "bound".to_string(),
            adapter: "minimax-h3".to_string(),
            base_url: "https://example.com".to_string(),
            auth: gateway::AuthConfig {
                kind: "bearer".to_string(),
                key_ref: "provider/bound".to_string(),
            },
            models: vec![gateway::ModelConfig {
                id: "MiniMax-H3".to_string(),
                display_name: "MiniMax H3".to_string(),
                capabilities: vec![gateway::ModelCapability {
                    capability: "video.generate".to_string(),
                    input_transport: vec!["publicUrl".to_string()],
                    async_job: true,
                    durations: None,
                    max_prompt_chars: None,
                }],
                defaults: Value::Null,
                protocols,
                priority: Some(10),
                enabled: Some(true),
                vendor: None,
            }],
            enabled: true,
            keys: vec![gateway::ProviderKey {
                id: "k1".to_string(),
                label: "主 Key".to_string(),
                key_ref: "provider/bound/key/k1".to_string(),
                enabled: true,
                status: "active".to_string(),
                cooldown_until: None,
                has_secret: false,
            }],
            schema_version: 2,
            has_key: false,
        };
        connection
            .execute(
                "INSERT INTO provider_profiles (id, adapter, base_url, enabled, payload, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params!["bound", "minimax-h3", "https://example.com", 1, serde_json::to_string(&profile).expect("json"), now],
            )
            .expect("insert");

        let mut request = request("cache-protocol");
        request.model = "MiniMax-H3".to_string();
        request.capability = "video.generate".to_string();
        request.provider_id = "bound".to_string();
        request.protocol = "minimax-video".to_string();
        let candidates = expand_candidates(&state, &request).expect("candidates");
        assert_eq!(candidates[0].protocol, "seedance-video");
    }

    /// 运行到终态时 job 行要一起关掉：否则重启后的恢复扫描会把
    /// 已经成功的运行当成「提交阶段被中断」改判成失败。
    #[test]
    fn closing_jobs_marks_pending_rows_terminal() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = crate::AppState {
            db_path: std::sync::Mutex::new(dir.path().join("db.sqlite3")),
            data_dir: dir.path().to_path_buf(),
        };
        let run = create_run(&state, &request("cache-jobs")).expect("create");
        let connection = db::open(&runs_db_path(&state)).expect("db");
        connection
            .execute(
                "INSERT INTO jobs (id, run_id, provider_id, capability, remote_task_id, status, attempts, next_poll_at, payload, updated_at)
                 VALUES ('job_1', ?1, 'p', 'text.chat', NULL, 'queued', 0, NULL, '{}', ?2)",
                rusqlite::params![run.id, chrono::Utc::now().to_rfc3339()],
            )
            .expect("insert");

        close_jobs_for_run(&state, &run.id, "succeeded");
        let status: String = connection
            .query_row("SELECT status FROM jobs WHERE id='job_1'", [], |row| {
                row.get(0)
            })
            .expect("status");
        assert_eq!(status, "succeeded");
    }

    fn seed_profile(state: &crate::AppState, id: &str, async_job: bool) {
        let connection = db::open(&runs_db_path(state)).expect("db");
        let now = chrono::Utc::now().to_rfc3339();
        let profile = gateway::ProviderProfile {
            id: id.to_string(),
            name: id.to_string(),
            adapter: "openai-compatible".to_string(),
            base_url: "https://example.com".to_string(),
            auth: gateway::AuthConfig {
                kind: "bearer".to_string(),
                key_ref: format!("provider/{id}"),
            },
            models: vec![gateway::ModelConfig {
                id: "test-model".to_string(),
                display_name: "Test".to_string(),
                capabilities: vec![gateway::ModelCapability {
                    capability: "text.chat".to_string(),
                    input_transport: vec!["dataUrl".to_string()],
                    async_job,
                    durations: None,
                    max_prompt_chars: None,
                }],
                defaults: Value::Null,
                protocols: HashMap::new(),
                priority: None,
                enabled: None,
                vendor: None,
            }],
            enabled: true,
            keys: vec![gateway::ProviderKey {
                id: "k1".to_string(),
                label: "主 Key".to_string(),
                key_ref: format!("provider/{id}/key/k1"),
                enabled: true,
                status: "active".to_string(),
                cooldown_until: None,
                has_secret: true,
            }],
            schema_version: 2,
            has_key: true,
        };
        connection.execute(
            "INSERT INTO provider_profiles (id, adapter, base_url, enabled, payload, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![id, "openai-compatible", "https://example.com", 1, serde_json::to_string(&profile).expect("json"), now],
        ).expect("insert");
    }

    #[test]
    fn cooldown_is_temporary_and_skips_the_key() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = crate::AppState {
            db_path: std::sync::Mutex::new(dir.path().join("db.sqlite3")),
            data_dir: dir.path().to_path_buf(),
        };
        seed_profile(&state, "cool", false);
        mark_key_cooldown(&state, "cool", "k1").expect("cooldown");
        let profile = load_provider_profile(&state, "cool")
            .expect("load")
            .expect("profile");
        assert_eq!(profile.keys[0].status, "cooling");
        assert!(profile.keys[0].cooldown_until.is_some());
        assert!(profile.keys[0].is_cooling());
        assert!(profile.key_refs().is_empty());
    }

    #[test]
    fn async_decision_follows_the_selected_candidate() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = crate::AppState {
            db_path: std::sync::Mutex::new(dir.path().join("db.sqlite3")),
            data_dir: dir.path().to_path_buf(),
        };
        seed_profile(&state, "sync-provider", false);
        seed_profile(&state, "async-provider", true);
        let mut req = request("cache-async");
        req.provider_id.clear();
        let candidates = expand_candidates(&state, &req).expect("candidates");
        assert_eq!(candidates[0].provider_id, "async-provider");
        assert!(request_is_async(&state, &req, &candidates));
        req.provider_id = "sync-provider".to_string();
        let sync = expand_candidates(&state, &req).expect("sync");
        assert!(!request_is_async(&state, &req, &sync));
        assert!(!request_is_async(&state, &req, &[]));
    }
}
