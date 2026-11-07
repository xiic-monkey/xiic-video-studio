use chrono::Utc;
use keyring::Entry;
use reqwest::Client;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{fs, path::PathBuf, sync::Mutex, time::Duration};
use tauri::{AppHandle, Manager, State};

mod assets;
mod db;
// 项目导出：打包项目元数据（不含素材二进制与密钥），文件写入与路径校验都在 Rust 侧。
mod export;
mod gateway;
// 旧项目导入：素材下载、落 CAS 与落库都在这个模块里。
mod import;
mod jobs;
mod runs;
mod security;

const CREDENTIAL_ACCOUNT_PREFIX: &str = "provider/";
const KEYCHAIN_SERVICE: &str = "com.frameforge.studio";

// 精确匹配而非子串：RunRecord.cacheKey 必须保留，否则导入/重启后缓存命中与 stale 判定全部失效。
// 不含裸 "key"——画布节点数据里 key/value 是常见结构，按名字剥会吞掉用户内容。
const SENSITIVE_KEYS: [&str; 16] = [
    "apikey",
    "api_key",
    "secretkey",
    "secret_key",
    "accesskey",
    "access_key",
    "accesskeyid",
    "secretaccesskey",
    "authorization",
    "bearer",
    "token",
    "accesstoken",
    "password",
    "credential",
    "credentials",
    "secret",
];

pub(crate) fn strip_sensitive_fields(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.retain(|field, _| !SENSITIVE_KEYS.contains(&field.to_ascii_lowercase().as_str()));
            for nested in map.values_mut() {
                strip_sensitive_fields(nested);
            }
        }
        Value::Array(items) => {
            for nested in items.iter_mut() {
                strip_sensitive_fields(nested);
            }
        }
        _ => {}
    }
}

pub(crate) struct AppState {
    pub(crate) db_path: Mutex<PathBuf>,
    pub(crate) data_dir: PathBuf,
}

pub(crate) fn http_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|error| format!("Could not create HTTP client: {error}"))
}

fn open_db(path: &PathBuf) -> Result<Connection, String> {
    db::open(path)
}

/// 资产桶配置：连接参数存在 app_settings，密钥只在 keychain。
pub(crate) fn asset_host_internal(
    state: &AppState,
) -> Result<gateway::transport::AssetHostConfig, String> {
    let path = state
        .db_path
        .lock()
        .map_err(|_| "Project database lock poisoned".to_string())?;
    let connection = open_db(&path)?;
    let stored: Option<String> = connection
        .query_row(
            "SELECT value FROM app_settings WHERE key='asset_host'",
            [],
            |row| row.get(0),
        )
        .ok();
    let mut config: gateway::transport::AssetHostConfig = match stored {
        Some(payload) => serde_json::from_str(&payload).unwrap_or_default(),
        None => gateway::transport::AssetHostConfig::default(),
    };
    if let Ok(entry) = Entry::new("com.frameforge.studio", "asset-host/access-key") {
        config.access_key = entry.get_password().ok();
    }
    if let Ok(entry) = Entry::new("com.frameforge.studio", "asset-host/secret-key") {
        config.secret_key = entry.get_password().ok();
    }
    Ok(config)
}

#[tauri::command]
fn save_provider_credential(provider_id: String, api_key: String) -> Result<(), String> {
    if api_key.trim().is_empty() {
        return Err("API key cannot be empty".to_string());
    }
    if provider_id.trim().is_empty() {
        return Err("Provider id cannot be empty".to_string());
    }
    let entry = Entry::new(KEYCHAIN_SERVICE, &format!("{CREDENTIAL_ACCOUNT_PREFIX}{provider_id}"))
        .map_err(|error| error.to_string())?;
    entry
        .set_password(api_key.trim())
        .map_err(|error| error.to_string())
}

/// 内部读取凭据。API Key 只存在系统钥匙串，前端拿不到明文。
pub(crate) fn provider_credential(provider_id: &str) -> Result<Option<String>, String> {
    let entry = Entry::new(KEYCHAIN_SERVICE, &format!("{CREDENTIAL_ACCOUNT_PREFIX}{provider_id}"))
        .map_err(|error| error.to_string())?;
    match entry.get_password() {
        Ok(api_key) => Ok(Some(api_key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn list_studio_projects(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    let mut statement = connection
        .prepare("SELECT payload FROM studio_projects ORDER BY updated_at DESC")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    rows.map(|row| {
        serde_json::from_str(&row.map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())
    })
    .collect()
}

#[tauri::command]
fn save_studio_project(mut project: Value, state: State<'_, AppState>) -> Result<(), String> {
    let id = project
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or("项目缺少 id")?
        .to_string();
    let name = project
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or("项目缺少名称")?
        .to_string();
    strip_sensitive_fields(&mut project);
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    let now = Utc::now().to_rfc3339();
    connection
        .execute(
            "INSERT INTO studio_projects (id, name, payload, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, payload=excluded.payload, updated_at=excluded.updated_at",
            params![id, name, serde_json::to_string(&project).map_err(|error| error.to_string())?, now],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn list_boards(project_id: String, state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    let mut statement = connection
        .prepare("SELECT payload FROM boards WHERE project_id=?1 ORDER BY updated_at DESC")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([project_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    rows.map(|row| {
        serde_json::from_str(&row.map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())
    })
    .collect()
}

#[tauri::command]
fn load_board(board_id: String, state: State<'_, AppState>) -> Result<Option<Value>, String> {
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    let mut statement = connection
        .prepare("SELECT payload FROM boards WHERE id=?1")
        .map_err(|error| error.to_string())?;
    let mut rows = statement.query([board_id]).map_err(|error| error.to_string())?;
    match rows.next().map_err(|error| error.to_string())? {
        Some(row) => Ok(Some(
            serde_json::from_str(&row.get::<_, String>(0).map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())?,
        )),
        None => Ok(None),
    }
}

#[tauri::command]
fn save_board(mut board: Value, state: State<'_, AppState>) -> Result<(), String> {
    let id = board
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or("画布缺少 id")?
        .to_string();
    let project_id = board
        .get("projectId")
        .and_then(Value::as_str)
        .ok_or("画布缺少 projectId")?
        .to_string();
    let name = board
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("未命名画布")
        .to_string();
    strip_sensitive_fields(&mut board);
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    let now = Utc::now().to_rfc3339();
    connection
        .execute(
            "INSERT INTO boards (id, project_id, name, payload, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, payload=excluded.payload, updated_at=excluded.updated_at",
            params![id, project_id, name, serde_json::to_string(&board).map_err(|error| error.to_string())?, now],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_board(board_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    db::open(&path)?
        .execute("DELETE FROM boards WHERE id=?1", [board_id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn list_provider_profiles(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    let mut statement = connection
        .prepare("SELECT payload FROM provider_profiles ORDER BY id")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    rows.map(|row| {
        serde_json::from_str(&row.map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())
    })
    .collect()
}

/// 远端地址校验失败时保留错误码，方便前端提示与日志排查区分具体原因。
fn remote_url_error(error: gateway::AppError) -> String {
    format!("{}（{}）", error.message, error.code)
}

/// Provider 的 Base URL：留空表示未配置，放行；否则必须是公网 https。
fn validate_provider_base_url(base_url: &str) -> Result<(), String> {
    let trimmed = base_url.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    security::validate_remote_url(trimmed)
        .map(|_| ())
        .map_err(remote_url_error)
}

/// 素材外链：S3 策略下的 endpoint 与公网前缀都必须是公网 https。
fn validate_asset_host_urls(config: &Value) -> Result<(), String> {
    let strategy = config.get("strategy").and_then(Value::as_str).unwrap_or("");
    let endpoint = config
        .get("endpoint")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let public_base_url = config
        .get("publicBaseUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if strategy == "s3" && !endpoint.is_empty() {
        security::validate_remote_url(endpoint).map_err(remote_url_error)?;
    }
    if !public_base_url.is_empty() {
        security::validate_remote_url(public_base_url).map_err(remote_url_error)?;
    }
    Ok(())
}

/// 落库的素材外链配置：去掉密钥，固定 schemaVersion。
fn asset_host_payload(config: &Value) -> Value {
    let mut object = config.as_object().cloned().unwrap_or_default();
    object.remove("accessKey");
    object.remove("secretKey");
    object.insert("schemaVersion".to_string(), json!(1));
    Value::Object(object)
}

/// 回读给前端的素材外链配置：带 schemaVersion（存量数据默认 1），且不含任何明文密钥。
fn asset_host_response(config: &gateway::transport::AssetHostConfig) -> Value {
    json!({
        "schemaVersion": config.schema_version,
        "strategy": config.strategy,
        "endpoint": config.endpoint,
        "bucket": config.bucket,
        "region": config.region,
        "prefix": config.prefix,
        "publicBaseUrl": config.public_base_url,
        "hasCredentials": config.access_key.is_some() && config.secret_key.is_some()
    })
}

#[tauri::command]
fn save_provider_profile(mut profile: Value, state: State<'_, AppState>) -> Result<(), String> {
    strip_sensitive_fields(&mut profile);
    let id = profile
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or("Provider 缺少 id")?
        .to_string();
    let adapter = profile
        .get("adapter")
        .and_then(Value::as_str)
        .unwrap_or("openai-compatible")
        .to_string();
    let base_url = profile
        .get("baseUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    validate_provider_base_url(&base_url)?;
    // 落库的值与校验过的值保持一致，避免前后空格绕过校验。
    if let Some(object) = profile.as_object_mut() {
        object.insert("baseUrl".to_string(), json!(base_url.clone()));
    }
    let enabled = profile
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    connection
        .execute(
            "INSERT INTO provider_profiles (id, adapter, base_url, enabled, payload, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET adapter=excluded.adapter, base_url=excluded.base_url, enabled=excluded.enabled, payload=excluded.payload, updated_at=excluded.updated_at",
            params![id, adapter, base_url, enabled, serde_json::to_string(&profile).map_err(|error| error.to_string())?, Utc::now().to_rfc3339()],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn provider_has_key(provider_id: String) -> Result<bool, String> {
    Ok(provider_credential(&provider_id)?.is_some())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderTestResult {
    ok: bool,
    message: String,
    model_count: Option<usize>,
}

#[tauri::command]
async fn test_provider_profile(
    provider_id: String,
    state: State<'_, AppState>,
) -> Result<ProviderTestResult, String> {
    let profile = runs::load_provider_profile(&state, &provider_id)?
        .ok_or_else(|| "Provider 未配置".to_string())?;
    let key = provider_credential(&provider_id)?
        .ok_or_else(|| "尚未保存 API Key".to_string())?;
    let client = http_client()?;
    if profile.adapter == "openai-compatible" {
        let url = if profile.base_url.trim_end_matches('/').ends_with("/v1") {
            format!("{}/models", profile.base_url.trim_end_matches('/'))
        } else {
            format!("{}/v1/models", profile.base_url.trim_end_matches('/'))
        };
        let response = client
            .get(url)
            .bearer_auth(&key)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status();
        let value: Value = response.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            let count = value.get("data").and_then(Value::as_array).map(Vec::len);
            return Ok(ProviderTestResult {
                ok: true,
                message: "连接成功".to_string(),
                model_count: count,
            });
        }
        return Ok(ProviderTestResult {
            ok: false,
            message: format!("连接失败：HTTP {}", status.as_u16()),
            model_count: None,
        });
    }
    Ok(ProviderTestResult {
        ok: true,
        message: "配置已保存，视频接口将在首次生成时验证".to_string(),
        model_count: None,
    })
}

#[tauri::command]
fn save_asset_host(config: Value, state: State<'_, AppState>) -> Result<(), String> {
    validate_asset_host_urls(&config)?;
    let access_key = config
        .get("accessKey")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let secret_key = config
        .get("secretKey")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if !access_key.is_empty() {
        Entry::new(KEYCHAIN_SERVICE, "asset-host/access-key")
            .map_err(|error| error.to_string())?
            .set_password(&access_key)
            .map_err(|error| error.to_string())?;
    }
    if !secret_key.is_empty() {
        Entry::new(KEYCHAIN_SERVICE, "asset-host/secret-key")
            .map_err(|error| error.to_string())?
            .set_password(&secret_key)
            .map_err(|error| error.to_string())?;
    }
    let public = asset_host_payload(&config);
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    db::open(&path)?
        .execute(
            "INSERT INTO app_settings (key, value) VALUES ('asset_host', ?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [serde_json::to_string(&public).map_err(|error| error.to_string())?],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_asset_host(state: State<'_, AppState>) -> Result<Value, String> {
    let config = asset_host_internal(&state)?;
    Ok(asset_host_response(&config))
}

#[tauri::command]
async fn start_run(
    request: runs::StartRunRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<runs::RunRecord, String> {
    let profile = runs::load_provider_profile(&state, &request.provider_id)?
        .ok_or_else(|| "Provider 未配置".to_string())?;
    if !profile.enabled {
        return Err("Provider 已禁用".to_string());
    }
    if let Some(asset_id) = request.cached_asset_id.clone() {
        return runs::finish_cached(&state, &request, &asset_id);
    }
    let key = provider_credential(&request.provider_id)?
        .ok_or_else(|| "尚未保存该 Provider 的 API Key".to_string())?;
    let runtime = gateway::ProviderRuntime {
        profile: profile.clone(),
        api_key: key,
    };
    let run = runs::create_run(&state, &request)?;
    let job_id = format!("job_{}", uuid::Uuid::new_v4());
    // 同步能力不建 job 行：否则下次启动的恢复扫描会把它当成「提交阶段被中断」。
    let is_async = profile
        .models
        .iter()
        .find(|model| model.id == request.model)
        .and_then(|model| model.capability(&request.capability))
        .map(|capability| capability.async_job)
        .unwrap_or(false);
    let db_path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    if is_async {
        db::open(&db_path)?
            .execute(
                "INSERT INTO jobs (id, run_id, provider_id, capability, status, attempts, payload, updated_at) VALUES (?1, ?2, ?3, ?4, 'queued', 0, ?5, ?6)",
                params![job_id, run.id, request.provider_id, request.capability, serde_json::to_string(&request).map_err(|error| error.to_string())?, Utc::now().to_rfc3339()],
            )
            .map_err(|error| error.to_string())?;
    }
    let state_owned = AppState {
        db_path: Mutex::new(db_path),
        data_dir: state.data_dir.clone(),
    };
    let app_clone = app.clone();
    let run_clone = run.clone();
    tauri::async_runtime::spawn(async move {
        runs::execute_run(app_clone, state_owned, run_clone, job_id, request, runtime).await;
    });
    Ok(run)
}

#[tauri::command]
fn cancel_run(run_id: String, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    jobs::cancel(&app, &state, &run_id);
    Ok(())
}

#[tauri::command]
fn list_runs(board_id: String, state: State<'_, AppState>) -> Result<Vec<runs::RunRecord>, String> {
    runs::list_runs(&state, &board_id)
}

#[tauri::command]
fn select_run_candidate(
    run_id: String,
    asset_id: String,
    state: State<'_, AppState>,
) -> Result<runs::RunRecord, String> {
    runs::select_candidate(&state, &run_id, &asset_id)
}

#[tauri::command]
fn resume_jobs(app: AppHandle, state: State<'_, AppState>) -> Result<usize, String> {
    Ok(jobs::resume_pending_on_start(app, &state))
}

#[tauri::command]
fn asset_file_path(asset_id: String, state: State<'_, AppState>) -> Result<String, String> {
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    let payload: String = connection
        .query_row("SELECT payload FROM assets WHERE id=?1", [asset_id], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    let asset: assets::AssetRef =
        serde_json::from_str(&payload).map_err(|error| error.to_string())?;
    Ok(assets::absolute_path(&state.data_dir, &asset.path)?.to_string_lossy().to_string())
}

#[tauri::command]
fn read_asset_text(asset_id: String, state: State<'_, AppState>) -> Result<String, String> {
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    let payload: String = connection
        .query_row("SELECT payload FROM assets WHERE id=?1", [asset_id], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    let asset: assets::AssetRef =
        serde_json::from_str(&payload).map_err(|error| error.to_string())?;
    std::fs::read_to_string(assets::absolute_path(&state.data_dir, &asset.path)?)
        .map_err(|error| error.to_string())
}

/// 导入旧项目时允许读取的目录：应用数据目录 + 用户选中的那个 JSON 所在的目录。
///
/// 文件系统根目录不进白名单，否则「文件所在目录」等于放开整块磁盘。
fn import_allowed_roots(data_dir: &PathBuf, target: &std::path::Path) -> Vec<PathBuf> {
    vec![
        data_dir.clone(),
        target
            .parent()
            .filter(|parent| parent.parent().is_some())
            .map(PathBuf::from)
            .unwrap_or_else(|| data_dir.clone()),
    ]
}

/// 导入旧版 Frameforge 项目：素材复制进 CAS，项目 / 画布 / 运行记录落库。
///
/// 允许读取的目录只有两处：应用数据目录，以及用户选中的那个 JSON 所在的目录。
#[tauri::command]
async fn import_legacy_project(
    path: String,
    state: State<'_, AppState>,
) -> Result<import::LegacyImportResult, String> {
    let data_dir = state.data_dir.clone();
    let db_path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let owned = AppState {
        db_path: std::sync::Mutex::new(db_path),
        data_dir: data_dir.clone(),
    };
    let target = std::path::PathBuf::from(&path);
    let roots = import_allowed_roots(&data_dir, &target);
    let document = import::read_legacy_document(&target, &roots).map_err(|error| error.message)?;
    import::import_document(&owned, &document, &roots)
        .await
        .map_err(|error| error.message)
}

/// 导出项目元数据包（不含素材二进制、不含密钥、不含绝对路径）。
///
/// 路径校验与文件写入都在 Rust 侧完成：渲染进程只能给一个目标路径，不能决定写到哪。
#[tauri::command]
fn export_project(
    project_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<export::ExportSummary, String> {
    export::export_project(&state, &project_id, std::path::Path::new(&path))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            fs::create_dir_all(&app_data)?;
            let db_path = app_data.join("frameforge.sqlite3");
            open_db(&db_path).map_err(std::io::Error::other)?;
            app.manage(AppState {
                db_path: Mutex::new(db_path),
                data_dir: app_data.clone(),
            });
            {
                let handle = app.handle().clone();
                let state = app.state::<AppState>();
                let owned = AppState {
                    db_path: Mutex::new(
                        state
                            .db_path
                            .lock()
                            .map_err(|_| "db lock poisoned".to_string())?
                            .clone(),
                    ),
                    data_dir: state.data_dir.clone(),
                };
                jobs::resume_pending_on_start(handle, &owned);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            save_provider_credential,
            list_studio_projects,
            save_studio_project,
            list_boards,
            load_board,
            save_board,
            delete_board,
            list_provider_profiles,
            save_provider_profile,
            provider_has_key,
            test_provider_profile,
            save_asset_host,
            load_asset_host,
            start_run,
            cancel_run,
            list_runs,
            select_run_candidate,
            resume_jobs,
            asset_file_path,
            read_asset_text,
            import_legacy_project,
            export_project
        ])
        .run(tauri::generate_context!())
        .expect("error while running Frameforge");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_base_url_accepts_public_https_and_empty_value() {
        assert!(validate_provider_base_url("").is_ok());
        assert!(validate_provider_base_url("   ").is_ok());
        assert!(validate_provider_base_url("https://api.example.com/v1").is_ok());
    }

    #[test]
    fn provider_base_url_rejects_insecure_and_private_targets() {
        let insecure = validate_provider_base_url("http://api.example.com").expect_err("http 拒绝");
        assert!(insecure.contains("PARAM_URL_INSECURE"), "{insecure}");
        for target in [
            "https://127.0.0.1:8080",
            "https://localhost",
            "https://192.168.1.10",
        ] {
            let error = validate_provider_base_url(target).expect_err("私网拒绝");
            assert!(error.contains("PARAM_URL_PRIVATE"), "{target} -> {error}");
        }
        let invalid = validate_provider_base_url("not-a-url").expect_err("非法 URL");
        assert!(invalid.contains("PARAM_URL_INVALID"), "{invalid}");
    }

    #[test]
    fn asset_host_rejects_insecure_endpoint_and_public_base_url() {
        let insecure = validate_asset_host_urls(&json!({
            "strategy": "s3",
            "endpoint": "http://s3.example.com"
        }))
        .expect_err("http endpoint 拒绝");
        assert!(insecure.contains("PARAM_URL_INSECURE"), "{insecure}");
        let private = validate_asset_host_urls(&json!({
            "strategy": "s3",
            "endpoint": "https://127.0.0.1:9000"
        }))
        .expect_err("私网 endpoint 拒绝");
        assert!(private.contains("PARAM_URL_PRIVATE"), "{private}");
        let public_base = validate_asset_host_urls(&json!({
            "strategy": "s3",
            "endpoint": "https://s3.example.com",
            "publicBaseUrl": "http://cdn.example.com"
        }))
        .expect_err("公网前缀拒绝 http");
        assert!(public_base.contains("PARAM_URL_INSECURE"), "{public_base}");
    }

    #[test]
    fn asset_host_ignores_endpoint_when_strategy_is_not_s3() {
        assert!(validate_asset_host_urls(&json!({
            "strategy": "dataUrl",
            "endpoint": "http://s3.example.com"
        }))
        .is_ok());
        assert!(validate_asset_host_urls(&json!({
            "strategy": "s3",
            "endpoint": "https://s3.example.com",
            "publicBaseUrl": "https://cdn.example.com"
        }))
        .is_ok());
    }

    #[test]
    fn asset_host_payload_drops_keys_and_keeps_schema_version() {
        let payload = asset_host_payload(&json!({
            "strategy": "s3",
            "endpoint": "https://s3.example.com",
            "accessKey": "access-plain",
            "secretKey": "secret-plain"
        }));
        assert_eq!(payload["schemaVersion"], json!(1));
        assert_eq!(payload["endpoint"], json!("https://s3.example.com"));
        assert!(payload.get("accessKey").is_none());
        assert!(payload.get("secretKey").is_none());
    }

    #[test]
    fn asset_host_response_carries_schema_version_without_plain_keys() {
        let mut config = gateway::transport::AssetHostConfig::default();
        config.strategy = "s3".to_string();
        config.endpoint = Some("https://s3.example.com".to_string());
        config.access_key = Some("access-plain".to_string());
        config.secret_key = Some("secret-plain".to_string());
        let response = asset_host_response(&config);
        assert_eq!(response["schemaVersion"], json!(1));
        assert_eq!(response["strategy"], json!("s3"));
        assert_eq!(response["hasCredentials"], json!(true));
        assert!(response.get("accessKey").is_none());
        assert!(response.get("secretKey").is_none());
    }

    #[test]
    fn import_roots_cover_the_data_dir_and_the_selected_file_folder() {
        let data_dir = PathBuf::from("/Users/xiic/Library/Application Support/com.frameforge.studio");
        let roots = import_allowed_roots(&data_dir, std::path::Path::new("/Users/xiic/frameforge/project.json"));
        assert_eq!(roots[0], data_dir);
        assert_eq!(roots[1], PathBuf::from("/Users/xiic/frameforge"));
    }

    #[test]
    fn import_roots_never_include_the_filesystem_root() {
        let data_dir = PathBuf::from("/Users/xiic/Library/Application Support/com.frameforge.studio");
        // 用户选了根目录下的文件：那个目录不能当白名单，否则等于放开整块磁盘。
        let roots = import_allowed_roots(&data_dir, std::path::Path::new("/project.json"));
        assert!(
            roots.iter().all(|root| root.parent().is_some()),
            "白名单里不能出现文件系统根目录：{roots:?}"
        );
        // 相对路径同样拿不到「所在目录」白名单。
        let roots = import_allowed_roots(&data_dir, std::path::Path::new("project.json"));
        assert_eq!(roots[1], data_dir);
    }
}
