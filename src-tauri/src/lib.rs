use chrono::Utc;
use keyring::Entry;
use reqwest::Client;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{fs, io::Read, path::PathBuf, sync::Mutex, time::Duration};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

mod assets;
mod db;
// 项目导出：打包项目元数据（不含素材二进制与密钥），文件写入与路径校验都在 Rust 侧。
mod export;
mod gateway;
// 旧项目导入：素材下载、落 CAS 与落库都在这个模块里。
mod import;
mod jobs;
mod mask;
#[allow(dead_code)]
mod media;
mod production;
mod run_authorization;
mod runs;
mod security;
mod sheet;

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
    let entry = Entry::new(
        KEYCHAIN_SERVICE,
        &format!("{CREDENTIAL_ACCOUNT_PREFIX}{provider_id}"),
    )
    .map_err(|error| error.to_string())?;
    entry
        .set_password(api_key.trim())
        .map_err(|error| error.to_string())
}

/// 内部读取凭据。API Key 只存在系统钥匙串，前端拿不到明文。
pub(crate) fn provider_credential(provider_id: &str) -> Result<Option<String>, String> {
    let entry = Entry::new(
        KEYCHAIN_SERVICE,
        &format!("{CREDENTIAL_ACCOUNT_PREFIX}{provider_id}"),
    )
    .map_err(|error| error.to_string())?;
    match entry.get_password() {
        Ok(api_key) => Ok(Some(api_key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

/// 按 key_ref 读取钥匙串里的密钥（多 Key 场景用）。
pub(crate) fn provider_key_secret(key_ref: &str) -> Option<String> {
    if key_ref.trim().is_empty() {
        return None;
    }
    Entry::new(KEYCHAIN_SERVICE, key_ref)
        .ok()
        .and_then(|entry| entry.get_password().ok())
}

/// 保存某个 Key。同一供应商可以有多个 Key，账户名按 key_id 区分。
#[tauri::command]
fn save_provider_key(
    provider_id: String,
    key_id: String,
    api_key: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if api_key.trim().is_empty() {
        return Err("API key cannot be empty".to_string());
    }
    if provider_id.trim().is_empty() || key_id.trim().is_empty() {
        return Err("Provider id and key id cannot be empty".to_string());
    }
    let account = format!("{CREDENTIAL_ACCOUNT_PREFIX}{provider_id}/key/{key_id}");
    Entry::new(KEYCHAIN_SERVICE, &account)
        .map_err(|error| error.to_string())?
        .set_password(api_key.trim())
        .map_err(|error| error.to_string())?;
    // 重新填了密钥就意味着用户想继续用它：把之前的失效 / 冷却状态清掉，
    // 否则这个 Key 会永远被跳过（401 作废后没有任何恢复入口）。
    let _ = runs::reset_key_status(&state, &provider_id, &key_id);
    Ok(())
}

/// 删除某个 Key（钥匙串与配置里的状态一起清掉）。
#[tauri::command]
fn delete_provider_key(
    provider_id: String,
    key_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let account = format!("{CREDENTIAL_ACCOUNT_PREFIX}{provider_id}/key/{key_id}");
    if let Ok(entry) = Entry::new(KEYCHAIN_SERVICE, &account) {
        match entry.delete_credential() {
            Ok(()) => {}
            Err(keyring::Error::NoEntry) => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    // 钥匙串里没了，配置里的失效 / 冷却状态也要一起清掉。
    let _ = runs::reset_key_status(&state, &provider_id, &key_id);
    Ok(())
}

/// 素材外链的访问密钥与密钥（存在钥匙串里）。
///
/// 供导出时精确抹除残留的密钥值用：钥匙串读不到就返回空，不让导出失败。
pub(crate) fn asset_host_secrets(state: &AppState) -> Vec<String> {
    let Ok(config) = asset_host_internal(state) else {
        return Vec::new();
    };
    config
        .access_key
        .into_iter()
        .chain(config.secret_key)
        .filter(|value| value.trim().len() >= 8)
        .collect()
}

#[tauri::command]
fn list_studio_projects(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let path = state
        .db_path
        .lock()
        .map_err(|_| "db lock".to_string())?
        .clone();
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
    let path = state
        .db_path
        .lock()
        .map_err(|_| "db lock".to_string())?
        .clone();
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
    let path = state
        .db_path
        .lock()
        .map_err(|_| "db lock".to_string())?
        .clone();
    let connection = db::open(&path)?;
    let mut statement = connection
        .prepare(
            "SELECT payload, revision FROM boards WHERE project_id=?1 ORDER BY updated_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([project_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|error| error.to_string())?;
    rows.map(|row| {
        let (payload, revision) = row.map_err(|error| error.to_string())?;
        let mut board: Value = serde_json::from_str(&payload).map_err(|error| error.to_string())?;
        board["revision"] = Value::from(revision);
        Ok(board)
    })
    .collect()
}

#[tauri::command]
fn load_board(board_id: String, state: State<'_, AppState>) -> Result<Option<Value>, String> {
    let path = state
        .db_path
        .lock()
        .map_err(|_| "db lock".to_string())?
        .clone();
    let connection = db::open(&path)?;
    let mut statement = connection
        .prepare("SELECT payload, revision FROM boards WHERE id=?1")
        .map_err(|error| error.to_string())?;
    let mut rows = statement
        .query([board_id])
        .map_err(|error| error.to_string())?;
    match rows.next().map_err(|error| error.to_string())? {
        Some(row) => {
            let mut board: Value =
                serde_json::from_str(&row.get::<_, String>(0).map_err(|error| error.to_string())?)
                    .map_err(|error| error.to_string())?;
            board["revision"] =
                Value::from(row.get::<_, i64>(1).map_err(|error| error.to_string())?);
            Ok(Some(board))
        }
        None => Ok(None),
    }
}

#[tauri::command]
fn save_board(
    mut board: Value,
    expected_revision: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
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
    let path = state
        .db_path
        .lock()
        .map_err(|_| "db lock".to_string())?
        .clone();
    let mut connection = db::open(&path)?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let current_revision: Option<i64> = transaction
        .query_row("SELECT revision FROM boards WHERE id=?1", [&id], |row| {
            row.get(0)
        })
        .ok();
    if current_revision.unwrap_or(0) != expected_revision.unwrap_or(0) {
        return Err("PRODUCTION_REVISION_CONFLICT".to_string());
    }
    let revision = current_revision.unwrap_or(0) + 1;
    board["revision"] = Value::from(revision);
    let now = Utc::now().to_rfc3339();
    transaction
        .execute(
            "INSERT INTO boards (id, project_id, name, payload, created_at, updated_at, revision) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, payload=excluded.payload, updated_at=excluded.updated_at, revision=excluded.revision",
            params![id, project_id, name, serde_json::to_string(&board).map_err(|error| error.to_string())?, now, revision],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(json!({"revision": revision}))
}

#[tauri::command]
fn delete_board(board_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let path = state
        .db_path
        .lock()
        .map_err(|_| "db lock".to_string())?
        .clone();
    db::open(&path)?
        .execute("DELETE FROM boards WHERE id=?1", [board_id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// 删掉项目及其所有关联数据。
///
/// 素材本体（assets 行与磁盘文件）保留：素材是内容寻址的，可能被别的项目共用。
/// 项目不存在时返回 Ok，删除是幂等的。
fn delete_studio_project_data(connection: &mut Connection, project_id: &str) -> Result<(), String> {
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    // 先删依赖实体的子表：它们的关联键存在 project_entities 里。
    transaction
        .execute(
            "DELETE FROM shot_adoptions WHERE shot_id IN (SELECT id FROM project_entities WHERE project_id=?1 AND kind='shot')",
            [project_id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM script_revisions WHERE script_id IN (SELECT id FROM project_entities WHERE project_id=?1 AND kind='script')",
            [project_id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM subject_versions WHERE subject_id IN (SELECT id FROM project_entities WHERE project_id=?1 AND kind='subject')",
            [project_id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM jobs WHERE run_id IN (SELECT id FROM runs WHERE project_id=?1)",
            [project_id],
        )
        .map_err(|error| error.to_string())?;
    for statement in [
        "DELETE FROM runs WHERE project_id=?1",
        "DELETE FROM boards WHERE project_id=?1",
        "DELETE FROM run_previews WHERE project_id=?1",
        "DELETE FROM media_tasks WHERE project_id=?1",
        "DELETE FROM media_exports WHERE project_id=?1",
        "DELETE FROM production_changes WHERE project_id=?1",
        "DELETE FROM breakdown_drafts WHERE project_id=?1",
        "DELETE FROM production_reviews WHERE project_id=?1",
        "DELETE FROM asset_origins WHERE project_id=?1",
        "DELETE FROM project_assets WHERE project_id=?1",
        "DELETE FROM project_entities WHERE project_id=?1",
        "DELETE FROM studio_projects WHERE id=?1",
    ] {
        transaction
            .execute(statement, [project_id])
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(())
}

/// 删除项目：连同画板、实体、运行记录、素材关联一起清掉。
#[tauri::command]
fn delete_studio_project(project_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let path = state
        .db_path
        .lock()
        .map_err(|_| "db lock".to_string())?
        .clone();
    let mut connection = db::open(&path)?;
    delete_studio_project_data(&mut connection, &project_id)
}

/// 只解除素材与项目的关联。
///
/// assets 行与磁盘文件保留：素材是内容寻址的，可能被别的项目共用。
/// 关联本来就不存在时返回 Ok，删除是幂等的。
fn delete_project_asset_data(
    connection: &mut Connection,
    project_id: &str,
    asset_id: &str,
) -> Result<(), String> {
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM project_assets WHERE project_id=?1 AND asset_id=?2",
            params![project_id, asset_id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "DELETE FROM asset_origins WHERE project_id=?1 AND asset_id=?2",
            params![project_id, asset_id],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(())
}

/// 从项目里移除一个素材（不删除素材本体）。
#[tauri::command]
fn delete_project_asset(
    project_id: String,
    asset_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let path = state
        .db_path
        .lock()
        .map_err(|_| "db lock".to_string())?
        .clone();
    let mut connection = db::open(&path)?;
    delete_project_asset_data(&mut connection, &project_id, &asset_id)
}

#[tauri::command]
fn list_provider_profiles(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let path = state
        .db_path
        .lock()
        .map_err(|_| "db lock".to_string())?
        .clone();
    let connection = db::open(&path)?;
    let mut statement = connection
        .prepare("SELECT payload FROM provider_profiles ORDER BY id")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut profiles: Vec<Value> = rows
        .map(|row| {
            let payload = row.map_err(|error| error.to_string())?;
            serde_json::from_str(&payload).map_err(|error| error.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    inject_key_state(&mut profiles);
    Ok(profiles)
}

/// 注入每个 Key 的「钥匙串里是否真的有密钥」，前端据此显示状态。
///
/// 直接在原始 JSON 上改：经过 ProviderProfile 结构体会丢掉未建模的字段
///（绑定参数、能力上限等），前端一保存就把残缺结构写回库，配置被悄悄洗掉。
fn inject_key_state(profiles: &mut [Value]) {
    for profile in profiles.iter_mut() {
        let Some(object) = profile.as_object_mut() else {
            continue;
        };
        let provider_id = object
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let key_count = object
            .get("keys")
            .and_then(Value::as_array)
            .map(|keys| keys.len())
            .unwrap_or(0);
        let mut usable = false;
        if let Some(keys) = object.get_mut("keys").and_then(Value::as_array_mut) {
            for key in keys.iter_mut() {
                let Some(key_object) = key.as_object_mut() else {
                    continue;
                };
                let key_id = key_object.get("id").and_then(Value::as_str).unwrap_or("");
                let key_ref = key_object
                    .get("keyRef")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let resolved = if key_ref.is_empty() {
                    format!("{CREDENTIAL_ACCOUNT_PREFIX}{provider_id}/key/{key_id}")
                } else {
                    key_ref
                };
                let has_secret = provider_key_secret(&resolved).is_some();
                key_object.insert("hasSecret".to_string(), Value::Bool(has_secret));
                let enabled = key_object
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                let status = key_object
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("active");
                if enabled && status != "invalid" && has_secret {
                    usable = true;
                }
            }
        }
        let has_key = if key_count == 0 {
            // 旧版 profile 只有 auth.keyRef。
            let auth_ref = object
                .get("auth")
                .and_then(|auth| auth.get("keyRef"))
                .and_then(Value::as_str)
                .unwrap_or("");
            provider_key_secret(auth_ref).is_some()
        } else {
            usable
        };
        object.insert("hasKey".to_string(), Value::Bool(has_key));
    }
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
    let path = state
        .db_path
        .lock()
        .map_err(|_| "db lock".to_string())?
        .clone();
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

/// 删掉供应商的配置行（钥匙串另算）。
///
/// 拆成独立函数是为了能直接测：钥匙串在测试环境里碰不到，
/// 但「配置行确实没了」这条必须保证。
fn delete_provider_profile_data(connection: &Connection, provider_id: &str) -> Result<(), String> {
    connection
        .execute("DELETE FROM provider_profiles WHERE id=?1", [provider_id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// 删掉一个供应商配置，连同它在钥匙串里的密钥。
///
/// 密钥必须一起清：只删数据库行的话，密钥会留在钥匙串里没人能删，
/// 也可能让「按 key_ref 找密钥」的路径捡到孤儿条目。
#[tauri::command]
fn delete_provider_profile(provider_id: String, state: State<'_, AppState>) -> Result<(), String> {
    if provider_id.trim().is_empty() {
        return Err("Provider id cannot be empty".to_string());
    }
    let path = state
        .db_path
        .lock()
        .map_err(|_| "db lock".to_string())?
        .clone();
    let connection = db::open(&path)?;
    // 先读配置：要知道这家供应商用了哪些 key_ref，才能把钥匙串条目清干净。
    let payload: Option<String> = connection
        .query_row(
            "SELECT payload FROM provider_profiles WHERE id=?1",
            [&provider_id],
            |row| row.get(0),
        )
        .ok();
    if let Some(payload) = payload {
        let profile: Value = serde_json::from_str(&payload).unwrap_or(Value::Null);
        let mut refs: Vec<String> = Vec::new();
        if let Some(keys) = profile.get("keys").and_then(Value::as_array) {
            for key in keys {
                if let Some(reference) = key.get("keyRef").and_then(Value::as_str) {
                    refs.push(reference.to_string());
                }
            }
        }
        // 旧版单 Key：账户名就是 provider/{id}。
        if let Some(reference) = profile
            .get("auth")
            .and_then(|auth| auth.get("keyRef"))
            .and_then(Value::as_str)
        {
            refs.push(reference.to_string());
        }
        refs.push(format!("{CREDENTIAL_ACCOUNT_PREFIX}{provider_id}"));
        for reference in refs {
            if let Ok(entry) = Entry::new(KEYCHAIN_SERVICE, &reference) {
                match entry.delete_credential() {
                    Ok(()) => {}
                    Err(keyring::Error::NoEntry) => {}
                    Err(error) => return Err(error.to_string()),
                }
            }
        }
    }
    delete_provider_profile_data(&connection, &provider_id)?;
    // Key 的失效 / 冷却状态也要清掉，否则同一个 id 重新接入时会被跳过。
    let _ = runs::reset_key_status(&state, &provider_id, "default");
    Ok(())
}

#[tauri::command]
async fn provider_has_key(provider_id: String, state: State<'_, AppState>) -> Result<bool, String> {
    // 与「测试连接」同源：多 Key 约定优先，旧单 Key 账户兜底。
    // 只读旧账户会让用新约定保存 Key 的供应商误判为「没有 Key」。
    let Some(profile) = runs::load_provider_profile(&state, &provider_id)? else {
        // profile 不存在时维持旧行为，仍尝试旧单 Key 账户。
        return Ok(provider_credential(&provider_id)?.is_some());
    };
    Ok(test_key_refs(&profile, &provider_id)
        .into_iter()
        .any(|key_ref| provider_key_secret(&key_ref).is_some()))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderTestResult {
    ok: bool,
    message: String,
    model_count: Option<usize>,
}

/// 测试连接要尝试的密钥引用：多 Key 约定优先，旧单 Key 账户兜底。
///
/// 新约定把每个 Key 存到 provider/{id}/key/{keyId}（见 save_provider_key），
/// 旧版单 Key 存在 provider/{id}。测试连接不能只读旧账户，否则用新约定保存
/// Key 后会误报「尚未保存 API Key」。
pub(crate) fn test_key_refs(profile: &gateway::ProviderProfile, provider_id: &str) -> Vec<String> {
    let mut refs: Vec<String> = profile
        .key_refs()
        .into_iter()
        .map(|(_, key_ref)| key_ref)
        .collect();
    let legacy = format!("{CREDENTIAL_ACCOUNT_PREFIX}{provider_id}");
    if !refs.contains(&legacy) {
        refs.push(legacy);
    }
    refs
}

#[tauri::command]
async fn test_provider_profile(
    provider_id: String,
    state: State<'_, AppState>,
) -> Result<ProviderTestResult, String> {
    let profile = runs::load_provider_profile(&state, &provider_id)?
        .ok_or_else(|| "Provider 未配置".to_string())?;
    let key = test_key_refs(&profile, &provider_id)
        .into_iter()
        .find_map(|key_ref| provider_key_secret(&key_ref))
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
    let path = state
        .db_path
        .lock()
        .map_err(|_| "db lock".to_string())?
        .clone();
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

async fn start_run(
    request: runs::StartRunRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<runs::RunRecord, String> {
    validate_run_entity_scope(&state, &request)?;
    // 缓存命中不需要供应商：先判缓存，否则供应商停用 / Key 失效时
    // 会把「本来能直接复用」的一次运行也拦掉。
    if let Some(asset_id) = request.cached_asset_id.clone() {
        return runs::finish_cached(&state, &request, &asset_id);
    }
    // 候选展开：自动路由时按模型下各供应商的顺序展开（供应商 × Key）。
    let candidates = runs::expand_candidates(&state, &request)?;
    if candidates.is_empty() {
        return Err("没有可用供应商：请检查该模型的供应商配置、协议与 API Key".to_string());
    }
    let run = runs::create_run(&state, &request)?;
    let job_id = format!("job_{}", uuid::Uuid::new_v4());
    // 同步能力不建 job 行：否则下次启动的恢复扫描会把它当成「提交阶段被中断」。
    let is_async = runs::request_is_async(&state, &request, &candidates);
    let db_path = state
        .db_path
        .lock()
        .map_err(|_| "db lock".to_string())?
        .clone();
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
        runs::execute_run(
            app_clone,
            state_owned,
            run_clone,
            job_id,
            request,
            candidates,
        )
        .await;
    });
    Ok(run)
}

fn validate_run_entity_scope(state: &AppState, request: &runs::StartRunRequest) -> Result<(), String> {
    let Some(entity_id) = request.entity_id.as_deref() else { return Ok(()); };
    let action = request.action.as_deref().ok_or("RUN_ACTION_REQUIRED")?;
    let expected_capability = match action {
        "storyboard" | "firstFrame" | "lastFrame" => "image.generate",
        "video" => "video.generate",
        "dialogue" => "audio.tts",
        _ => return Err("RUN_ACTION_INVALID".into()),
    };
    if request.capability != expected_capability {
        return Err("RUN_ACTION_CAPABILITY_MISMATCH".into());
    }
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    let payload: String = connection
        .query_row(
            "SELECT payload FROM project_entities WHERE id=?1 AND project_id=?2 AND kind='shot' AND archived_at IS NULL",
            params![entity_id, request.project_id],
            |row| row.get(0),
        )
        .map_err(|_| "RUN_ENTITY_NOT_IN_PROJECT".to_string())?;
    let shot: Value = serde_json::from_str(&payload).map_err(|_| "RUN_ENTITY_INVALID".to_string())?;
    if shot.get("boardId").and_then(Value::as_str) != Some(request.board_id.as_str()) {
        return Err("RUN_ENTITY_BOARD_MISMATCH".into());
    }
    Ok(())
}

#[tauri::command]
fn prepare_paid_run(
    project_id: String,
    board_id: String,
    expected_revision: i64,
    draft: Value,
    state: State<'_, AppState>,
) -> Result<run_authorization::RunPreview, String> {
    let path = state
        .db_path
        .lock()
        .map_err(|_| "db lock".to_string())?
        .clone();
    let connection = db::open(&path)?;
    let (revision, board_payload): (i64, String) = connection
        .query_row(
            "SELECT revision,payload FROM boards WHERE id=?1 AND project_id=?2",
            params![board_id, project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "PRODUCTION_REVISION_CONFLICT".to_string())?;
    if revision != expected_revision {
        return Err("PRODUCTION_REVISION_CONFLICT".into());
    }
    let request: runs::StartRunRequest =
        serde_json::from_value(draft.clone()).map_err(|_| "RUN_REQUEST_INVALID".to_string())?;
    if request.project_id != project_id || request.board_id != board_id {
        return Err("RUN_PREVIEW_SCOPE_MISMATCH".into());
    }
    validate_run_entity_scope(&state, &request)?;
    let board: Value =
        serde_json::from_str(&board_payload).map_err(|_| "BOARD_INVALID".to_string())?;
    if board
        .get("nodes")
        .and_then(|nodes| nodes.get(&request.node_id))
        .is_none()
    {
        return Err("GRAPH_UNKNOWN_NODE".into());
    }
    let mut input_ids = request.input_asset_ids.clone();
    input_ids.extend(request.reference_asset_ids.iter().cloned());
    if let Some(cached_id) = &request.cached_asset_id {
        input_ids.push(cached_id.clone());
    }
    for asset_id in input_ids {
        let belongs: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM project_assets WHERE project_id=?1 AND asset_id=?2)",
                params![project_id, asset_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !belongs {
            return Err("ASSET_NOT_IN_PROJECT".into());
        }
    }
    if let Some(cached_id) = &request.cached_asset_id {
        let runs = crate::runs::list_runs(&state, &board_id)?;
        if !runs.iter().any(|run| {
            run.project_id == project_id
                && run.node_id == request.node_id
                && run.cache_key == request.cache_key
                && run.status == "succeeded"
                && (run.selected_asset_id.as_deref() == Some(cached_id)
                    || run.output_asset_ids.contains(cached_id))
        }) {
            return Err("RUN_CACHE_INVALID".into());
        }
    }
    let preview = run_authorization::prepare(&project_id, &board_id, &draft);
    run_authorization::persist(&connection, &preview)?;
    Ok(preview)
}

#[tauri::command]
async fn start_paid_run(
    preview_id: String,
    fingerprint: String,
    request: Value,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<runs::RunRecord, String> {
    let path = state
        .db_path
        .lock()
        .map_err(|_| "db lock".to_string())?
        .clone();
    let mut connection = db::open(&path)?;
    if run_authorization::fingerprint(&request) != fingerprint {
        return Err("RUN_PREVIEW_MODIFIED".into());
    }
    let preview = run_authorization::consume_persisted(&mut connection, &preview_id, &fingerprint)?;
    if request["projectId"] != preview.project_id || request["boardId"] != preview.board_id {
        return Err("RUN_PREVIEW_SCOPE_MISMATCH".into());
    }
    let request: runs::StartRunRequest =
        serde_json::from_value(request).map_err(|_| "RUN_REQUEST_INVALID".to_string())?;
    start_run(request, app, state).await
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

/// 拆帧：把一张设定图按版式切成各视角，分别落库。
#[tauri::command]
fn split_sheet(
    asset_id: String,
    layout: String,
    node_id: String,
    project_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<Value>, String> {
    let path = state
        .db_path
        .lock()
        .map_err(|_| "db lock".to_string())?
        .clone();
    let connection = db::open(&path)?;
    let payload: String = connection
        .query_row(
            "SELECT payload FROM assets WHERE id=?1",
            [&asset_id],
            |row| row.get(0),
        )
        .map_err(|_| "素材不存在".to_string())?;
    let source: assets::AssetRef =
        serde_json::from_str(&payload).map_err(|error| error.to_string())?;
    let absolute = assets::absolute_path(&state.data_dir, &source.path)?;
    let bytes = std::fs::read(&absolute).map_err(|error| error.to_string())?;
    let provenance = json!({
        "projectId": project_id,
        "nodeId": node_id,
        "sourceAssetId": asset_id,
        "kind": "sheet-view",
    });
    let pieces = sheet::split_sheet(&bytes, sheet::SheetLayout::parse(&layout))?;
    let views = sheet::store_views(&state.data_dir, pieces, provenance)?;
    let mut out = Vec::new();
    for view in views {
        runs::save_asset(&state, &view.asset).map_err(|error| error.message)?;
        out.push(json!({
            "view": view.view,
            "label": view.label,
            "assetId": view.asset.id,
            "mime": view.asset.mime,
            "path": view.asset.path,
        }));
    }
    Ok(out)
}

/// 局部重绘：保存画好的蒙版。
///
/// 渲染进程只给 data URL；尺寸校验、灰度归一化与落库都在后端完成。
#[tauri::command]
fn save_mask(
    mask_data_url: String,
    source_asset_id: String,
    node_id: String,
    project_id: String,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let (mime, raw) =
        assets::decode_data_url(&mask_data_url).ok_or_else(|| "蒙版数据格式无效".to_string())?;
    if mime != "image/png" {
        return Err("蒙版必须是 PNG 图片".to_string());
    }
    let path = state
        .db_path
        .lock()
        .map_err(|_| "db lock".to_string())?
        .clone();
    let connection = db::open(&path)?;
    let payload: String = connection
        .query_row(
            "SELECT payload FROM assets WHERE id=?1",
            [&source_asset_id],
            |row| row.get(0),
        )
        .map_err(|_| "源图素材不存在".to_string())?;
    let source: assets::AssetRef =
        serde_json::from_str(&payload).map_err(|error| error.to_string())?;
    let source_path = assets::absolute_path(&state.data_dir, &source.path)?;
    let source_bytes = std::fs::read(&source_path).map_err(|error| error.to_string())?;
    let (width, height) = mask::ensure_same_size(&source_bytes, &raw)?;
    let png = mask::normalize_mask(&raw)?;
    let provenance = json!({
        "projectId": project_id,
        "nodeId": node_id,
        "sourceAssetId": source_asset_id,
        "kind": "mask",
    });
    let mut asset = assets::store_bytes(&state.data_dir, &png, "image", "image/png", provenance)?;
    asset.width = Some(width);
    asset.height = Some(height);
    if let Ok(thumb) = sheet::thumbnail(&png, 512) {
        let relative = format!("thumbs/{}/{}.png", &asset.id[0..2], asset.id);
        if let Ok(thumb_path) = assets::write_derived(&state.data_dir, &relative, &thumb) {
            asset.thumb_path = Some(thumb_path);
        }
    }
    runs::save_asset(&state, &asset).map_err(|error| error.message)?;
    Ok(json!({
        "assetId": asset.id,
        "mime": asset.mime,
        "path": asset.path,
        "width": width,
        "height": height,
    }))
}

#[tauri::command]
fn open_project_media(
    project_id: String,
    asset_id: String,
    rendition: media::access::Rendition,
    state: State<'_, AppState>,
    window: tauri::Window,
) -> Result<media::access::MediaGrant, String> {
    media::access::open_project_media(&state, window.label(), &project_id, &asset_id, rendition)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn read_project_asset_text(
    project_id: String,
    asset_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    media::access::read_project_asset_text(&state, &project_id, &asset_id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn list_project_assets(
    project_id: String,
    kind: Option<String>,
    query: Option<String>,
    cursor: Option<String>,
    state: State<'_, AppState>,
) -> Result<production::repository::ProjectAssetPage, String> {
    media::access::list_project_media(
        &state,
        &project_id,
        kind.as_deref(),
        query.as_deref(),
        cursor.as_deref(),
    )
    .map_err(|error| error.to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FileGrantView {
    id: String,
    display_name: String,
}

#[tauri::command]
async fn pick_media_files(
    project_id: String,
    app: AppHandle,
) -> Result<Vec<FileGrantView>, String> {
    let paths = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter(
                "媒体",
                &[
                    "png", "jpg", "jpeg", "webp", "mp4", "mov", "wav", "mp3", "m4a",
                ],
            )
            .blocking_pick_files()
    })
    .await
    .map_err(|error| error.to_string())?;
    let store = media::grants::FileGrantStore;
    paths
        .unwrap_or_default()
        .into_iter()
        .map(|path| {
            let native_path = path.into_path().map_err(|error| error.to_string())?;
            let display_name = media::grants::sanitize_display_name(&native_path);
            let grant = store
                .issue(
                    &project_id,
                    native_path,
                    media::grants::GrantPurpose::MediaImport,
                )
                .map_err(|error| error.to_string())?;
            Ok(FileGrantView {
                id: grant.id,
                display_name,
            })
        })
        .collect()
}

async fn pick_single_file(
    app: AppHandle,
    project_id: String,
    purpose: media::grants::GrantPurpose,
    filter_name: &'static str,
    extensions: &'static [&'static str],
) -> Result<Option<FileGrantView>, String> {
    let selected = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter(filter_name, extensions)
            .blocking_pick_file()
    })
    .await
    .map_err(|error| error.to_string())?;
    let Some(selected) = selected else { return Ok(None) };
    let path = selected.into_path().map_err(|error| error.to_string())?;
    let grant = media::grants::FileGrantStore
        .issue(&project_id, &path, purpose)
        .map_err(|error| error.to_string())?;
    Ok(Some(FileGrantView {
        id: grant.id,
        display_name: media::grants::sanitize_display_name(&path),
    }))
}

#[tauri::command]
async fn pick_script_file(project_id: String, app: AppHandle) -> Result<Option<FileGrantView>, String> {
    pick_single_file(app, project_id, media::grants::GrantPurpose::ScriptImport, "剧本文档", &["txt", "md", "docx"]).await
}

#[tauri::command]
fn import_script_document(project_id: String, file_grant_id: String) -> Result<Value, String> {
    let grant = media::grants::FileGrantStore.get(&file_grant_id).ok_or("FILE_GRANT_INVALID")?;
    let mut file = media::grants::FileGrantStore.open_input(&grant, &project_id, media::grants::GrantPurpose::ScriptImport).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if metadata.len() > 200 * 1024 { return Err("SCRIPT_TOO_LARGE".into()); }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(200 * 1024 + 1).read_to_end(&mut bytes).map_err(|error| error.to_string())?;
    let extension = grant.path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
    let body = if extension == "docx" {
        production::script::extract_docx_text(&bytes, 200 * 1024)?
    } else if matches!(extension.as_str(), "txt" | "md") {
        production::script::validate_script_bytes(&bytes, 200 * 1024)?
    } else {
        return Err("SCRIPT_FORMAT_UNSUPPORTED".into());
    };
    let title = grant.path.file_stem().and_then(|value| value.to_str()).unwrap_or("未命名剧本").chars().take(120).collect::<String>();
    Ok(json!({"title":title,"body":body,"displayName":media::grants::sanitize_display_name(&grant.path)}))
}

#[tauri::command]
async fn pick_subtitle_file(project_id: String, app: AppHandle) -> Result<Option<FileGrantView>, String> {
    pick_single_file(app, project_id, media::grants::GrantPurpose::SubtitleImport, "SubRip 字幕", &["srt"]).await
}

#[tauri::command]
async fn pick_export_target(project_id: String, app: AppHandle) -> Result<Option<FileGrantView>, String> {
    let selected = tokio::task::spawn_blocking(move || {
        app.dialog().file().add_filter("MP4 视频", &["mp4"]).set_file_name("frameforge-export.mp4").blocking_save_file()
    }).await.map_err(|error| error.to_string())?;
    let Some(selected) = selected else { return Ok(None) };
    let path = selected.into_path().map_err(|error| error.to_string())?;
    let grant = media::grants::FileGrantStore.issue_export_target(&project_id, path.clone()).map_err(|error| error.to_string())?;
    Ok(Some(FileGrantView { id: grant.id, display_name: media::grants::sanitize_display_name(&path) }))
}

#[tauri::command]
fn import_subtitle_document(project_id: String, file_grant_id: String, state: State<'_, AppState>) -> Result<media::subtitles::SubtitleDocument, String> {
    media::subtitles::import_subtitle(&state, &media::grants::FileGrantStore, &project_id, &file_grant_id)
}

#[tauri::command]
fn import_media(
    project_id: String,
    file_grant_ids: Vec<String>,
    request_id: String,
    state: State<'_, AppState>,
) -> Result<media::ingest::MediaTask, String> {
    if file_grant_ids.is_empty() || file_grant_ids.len() > 20 {
        return Err("MEDIA_BATCH_LIMIT".into());
    }
    media::ingest::import_grants(
        &state,
        &media::grants::FileGrantStore,
        &project_id,
        &file_grant_ids,
        &request_id,
    )
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedPath {
    pub asset_id: String,
    pub display_name: String,
    pub kind: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedPath {
    pub path: String,
    pub code: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedPaths {
    pub imported: Vec<ImportedPath>,
    pub failed: Vec<FailedPath>,
}

/// 按裸文件路径导入素材：前端拖拽文件拿到的是路径，没有 grant 可用。
#[tauri::command]
fn import_media_paths(
    project_id: String,
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<ImportedPaths, String> {
    if paths.is_empty() || paths.len() > 20 {
        return Err("MEDIA_BATCH_LIMIT".into());
    }
    let mut imported = Vec::new();
    let mut failed = Vec::new();
    for path in paths {
        match media::ingest::ingest_path(&state, &project_id, std::path::Path::new(&path)) {
            Ok(asset) => imported.push(ImportedPath {
                asset_id: asset.asset_id,
                display_name: asset.display_name,
                kind: asset.kind,
            }),
            Err(error) => failed.push(FailedPath {
                path,
                code: error.code(),
            }),
        }
    }
    Ok(ImportedPaths { imported, failed })
}

/// 把一段图片字节存成项目素材（截图粘贴用）。
///
/// 剪贴板图片是前端读出来的字节，这里只负责落盘 + 登记归属。
/// 之所以要后端：素材必须落到项目目录里，模型运行时才读得到。
#[tauri::command]
fn import_image_bytes(
    project_id: String,
    data_base64: String,
    display_name: String,
    state: State<'_, AppState>,
) -> Result<ImportedPath, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|_| "MEDIA_FORMAT_INVALID".to_string())?;
    if bytes.is_empty() {
        return Err("MEDIA_FORMAT_INVALID".into());
    }
    let decoded = image::ImageReader::new(std::io::Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|_| "MEDIA_FORMAT_INVALID".to_string())?
        .decode()
        .map_err(|_| "MEDIA_FORMAT_INVALID".to_string())?;
    let mime = match decoded.color() {
        image::ColorType::Rgb8 => "image/jpeg",
        _ => "image/png",
    };
    let name = if display_name.trim().is_empty() {
        "剪贴板截图".to_string()
    } else {
        display_name.trim().to_string()
    };
    store_imported_image(&state, &project_id, &bytes, mime, decoded.width(), decoded.height(), &name)
}

/// 把一段图片字节存成项目素材（截图粘贴用）。
///
/// 素材必须落到项目目录里，模型运行时才读得到，所以落盘统一走这里。
fn store_imported_image(
    state: &AppState,
    project_id: &str,
    bytes: &[u8],
    mime: &str,
    width: u32,
    height: u32,
    name: &str,
) -> Result<ImportedPath, String> {
    let mut asset = assets::store_bytes(
        &state.data_dir,
        bytes,
        "image",
        mime,
        serde_json::json!({"projectId":project_id,"displayName":name,"kind":"import"}),
    )?;
    asset.width = Some(width);
    asset.height = Some(height);
    media::ingest::register_asset(state, project_id, &asset, name)?;
    Ok(ImportedPath {
        asset_id: asset.id,
        display_name: name.to_string(),
        kind: "image".into(),
    })
}

/// 直接从系统剪贴板读图并存成项目素材。
///
/// macOS 上 Tauri 用的是 WKWebView，它不会把剪贴板里的图片放进前端
/// `paste` 事件的 clipboardData（WebKit 明确不支持粘贴文件），
/// 所以 Cmd+V 贴图只能由后端读系统剪贴板。
#[tauri::command]
fn import_clipboard_image(
    app: tauri::AppHandle,
    project_id: String,
    state: State<'_, AppState>,
) -> Result<ImportedPath, String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let clipboard = app.clipboard().read_image().map_err(|_| "CLIPBOARD_NO_IMAGE".to_string())?;
    let buffer = image::RgbaImage::from_raw(clipboard.width(), clipboard.height(), clipboard.rgba().to_vec())
        .ok_or("MEDIA_FORMAT_INVALID".to_string())?;
    let mut png = Vec::new();
    buffer
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|_| "MEDIA_FORMAT_INVALID".to_string())?;
    store_imported_image(
        &state,
        &project_id,
        &png,
        "image/png",
        buffer.width(),
        buffer.height(),
        "剪贴板截图",
    )
}

#[tauri::command]
fn list_media_tasks(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<media::ingest::MediaTask>, String> {
    media::ingest::list_tasks(&state, &project_id)
}

#[tauri::command]
fn cancel_media_task(
    project_id: String,
    job_id: String,
    state: State<'_, AppState>,
) -> Result<media::ingest::MediaTask, String> {
    media::export_task::cancel(&job_id);
    media::ingest::cancel_task(&state, &project_id, &job_id)
}

#[tauri::command]
fn extract_media_frame(
    project_id: String,
    asset_id: String,
    selector: media::derive::FrameSelector,
    state: State<'_, AppState>,
) -> Result<media::derive::DerivedFrame, String> {
    let db_path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&db_path)?;
    let source = production::repository::require_project_asset(&connection, &project_id, &asset_id).map_err(|error| error.to_string())?;
    if source.kind != "video" { return Err("MEDIA_FRAME_SOURCE_NOT_VIDEO".into()); }
    let source_path = assets::absolute_path(&state.data_dir, &source.path)?;
    let ffmpeg = media::render::configured_ffmpeg().ok_or("MEDIA_TOOL_UNAVAILABLE:ffmpeg")?;
    let ffprobe = media::probe::configured_ffprobe().ok_or("MEDIA_TOOL_UNAVAILABLE:ffprobe")?;
    let key = media::derive::derivation_key(&asset_id, &selector, 1);
    let staging = state.data_dir.join(".staging").join(format!("frame-{key}"));
    std::fs::create_dir_all(&staging).map_err(|error| error.to_string())?;
    let output = staging.join("frame.png");
    let actual_ticks = media::derive::extract_frame(&ffmpeg, &ffprobe, &source_path, &selector, &output, &|| false)?;
    let bytes = std::fs::read(&output).map_err(|error| error.to_string())?;
    let mut derived = assets::store_bytes(&state.data_dir, &bytes, "image", "image/png", json!({"projectId":project_id,"sourceAssetId":asset_id,"kind":"derived-frame","selector":selector,"actualTicks":actual_ticks,"derivationKey":key}))?;
    let decoded = image::ImageReader::open(&assets::absolute_path(&state.data_dir, &derived.path)?).map_err(|error| error.to_string())?.with_guessed_format().map_err(|error| error.to_string())?.decode().map_err(|error| error.to_string())?;
    derived.width = Some(decoded.width()); derived.height = Some(decoded.height());
    let mut connection = db::open(&db_path)?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    transaction.execute("INSERT INTO assets (id,kind,path,mime,bytes,width,height,payload,created_at) VALUES (?1,'image',?2,'image/png',?3,?4,?5,?6,?7) ON CONFLICT(id) DO NOTHING", params![derived.id,derived.path,derived.bytes,derived.width,derived.height,serde_json::to_string(&derived).map_err(|error| error.to_string())?,derived.created_at]).map_err(|error| error.to_string())?;
    production::repository::record_asset_membership(&transaction,&project_id,&derived,&production::repository::AssetOrigin{kind:"frame-extract".into(),reference:Some(asset_id.clone())}).map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    let _ = std::fs::remove_dir_all(staging);
    Ok(media::derive::DerivedFrame { asset_id: derived.id, source_asset_id: asset_id, actual_ticks })
}

#[tauri::command]
fn list_production_entities(project_id: String, kind: Option<String>, state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    let mut statement = connection.prepare("SELECT id,kind,schema_version,revision,payload,updated_at FROM project_entities WHERE project_id=?1 AND archived_at IS NULL AND (?2 IS NULL OR kind=?2) ORDER BY updated_at DESC").map_err(|error| error.to_string())?;
    let rows = statement.query_map(params![project_id, kind], |row| { let payload: String = row.get(4)?; Ok(json!({"id": row.get::<_, String>(0)?, "kind": row.get::<_, String>(1)?, "schemaVersion": row.get::<_, i64>(2)?, "revision": row.get::<_, i64>(3)?, "payload": serde_json::from_str::<Value>(&payload).unwrap_or(Value::Null), "updatedAt": row.get::<_, String>(5)?})) }).map_err(|error| error.to_string())?;
    rows.map(|row| row.map_err(|error| error.to_string())).collect()
}

#[tauri::command]
fn apply_production_change(project_id: String, change_id: String, expected_revisions: std::collections::HashMap<String, i64>, operations: Vec<Value>, state: State<'_, AppState>) -> Result<production::types::ChangeResult, String> {
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let mut connection = db::open(&path)?;
    production::commands::apply_production_change(&mut connection, &project_id, &change_id, &expected_revisions, &operations).map_err(|error| error.to_string())
}

#[tauri::command]
fn save_breakdown_draft(project_id: String, draft_id: String, script_id: String, script_revision: i64, payload: Value, state: State<'_, AppState>) -> Result<(), String> {
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    production::breakdown::save_draft(&connection, &project_id, &draft_id, &script_id, script_revision, &payload)
}

#[tauri::command]
fn list_breakdown_drafts(project_id: String, script_id: String, state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    production::breakdown::list_drafts(&connection, &project_id, &script_id)
}

fn production_operation(
    project_id: String,
    change_id: String,
    expected_revisions: std::collections::HashMap<String, i64>,
    operation: Value,
    state: State<'_, AppState>,
) -> Result<production::types::ChangeResult, String> {
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let mut connection = db::open(&path)?;
    production::commands::apply_production_change(&mut connection, &project_id, &change_id, &expected_revisions, &[operation]).map_err(|error| error.to_string())
}

#[tauri::command]
fn adopt_shot_media(project_id: String, change_id: String, expected_revisions: std::collections::HashMap<String, i64>, shot_id: String, slot: String, asset_id: String, spec_hash: String, state: State<'_, AppState>) -> Result<production::types::ChangeResult, String> {
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    production::repository::require_project_asset(&connection, &project_id, &asset_id).map_err(|error| error.to_string())?;
    drop(connection);
    production_operation(project_id, change_id, expected_revisions, json!({"id":shot_id,"kind":"shot","op":"adoptShotMedia","payload":{"slot":slot,"assetId":asset_id,"specHash":spec_hash}}), state)
}

/// 解析实体在项目里的类型。
///
/// 审批和撤销必须按实体的真实类型走：kind 写死成 shot 时，
/// 时间线这类实体会因为「owner_kind 与 kind 不一致」直接被拒。
fn production_entity_kind(state: &AppState, project_id: &str, entity_id: &str) -> Result<String, String> {
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    connection
        .query_row(
            "SELECT kind FROM project_entities WHERE id=?1 AND project_id=?2",
            params![entity_id, project_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|_| "PRODUCTION_ENTITY_NOT_FOUND".to_string())
}

#[tauri::command]
fn record_production_review(project_id: String, change_id: String, expected_revisions: std::collections::HashMap<String, i64>, entity_id: String, review: Value, state: State<'_, AppState>) -> Result<production::types::ChangeResult, String> {
    let kind = production_entity_kind(&state, &project_id, &entity_id)?;
    production_operation(project_id, change_id, expected_revisions, json!({"id":entity_id,"kind":kind,"op":"recordProductionReview","payload":review}), state)
}

#[tauri::command]
fn assemble_episode(project_id: String, change_id: String, expected_revisions: std::collections::HashMap<String, i64>, episode_id: String, payload: Value, state: State<'_, AppState>) -> Result<production::types::ChangeResult, String> {
    production_operation(project_id, change_id, expected_revisions, json!({"id":episode_id,"kind":"episode","op":"assembleEpisode","payload":payload}), state)
}

#[tauri::command]
fn replace_timeline_clip(project_id: String, change_id: String, expected_revisions: std::collections::HashMap<String, i64>, timeline_id: String, payload: Value, state: State<'_, AppState>) -> Result<production::types::ChangeResult, String> {
    production_operation(project_id, change_id, expected_revisions, json!({"id":timeline_id,"kind":"timeline","op":"replaceTimelineClip","payload":payload}), state)
}

#[tauri::command]
fn revert_production_change(project_id: String, change_id: String, expected_revisions: std::collections::HashMap<String, i64>, entity_id: String, payload: Value, state: State<'_, AppState>) -> Result<production::types::ChangeResult, String> {
    let kind = production_entity_kind(&state, &project_id, &entity_id)?;
    production_operation(project_id, change_id, expected_revisions, json!({"id":entity_id,"kind":kind,"op":"revertProductionChange","payload":payload}), state)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaExportPreviewView {
    preview_id: String,
    project_id: String,
    timeline_id: String,
    edit_hash: String,
    total_ticks: i64,
    preset: String,
    /// 阻断级问题：必须修好，不允许靠确认放行。
    issues: Vec<String>,
    /// 必须明确确认级问题：逐条确认后可以继续交付。
    warnings: Vec<String>,
}

fn load_timeline_for_export(
    connection: &rusqlite::Connection,
    data_dir: &std::path::Path,
    project_id: &str,
    timeline_id: &str,
    expected_revision: i64,
) -> Result<(media::timeline::TimelineData, Vec<media::render::RenderAsset>, media::timeline::TimelinePlan), String> {
    let (revision, payload): (i64, String) = connection
        .query_row("SELECT revision,payload FROM project_entities WHERE id=?1 AND project_id=?2 AND kind='timeline' AND archived_at IS NULL", params![timeline_id, project_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(|_| "TIMELINE_NOT_FOUND".to_string())?;
    if revision != expected_revision { return Err("PRODUCTION_REVISION_CONFLICT".into()); }
    let timeline: media::timeline::TimelineData = serde_json::from_str(&payload).map_err(|_| "TIMELINE_INVALID".to_string())?;
    let mut sources = std::collections::HashMap::new();
    let mut render_assets = Vec::new();
    for clip in timeline.clips.iter().filter(|clip| clip.enabled) {
        if sources.contains_key(&clip.asset_id) { continue; }
        let asset = production::repository::require_project_asset(connection, project_id, &clip.asset_id).map_err(|error| error.to_string())?;
        if asset.kind != "video" { return Err(format!("TIMELINE_VIDEO_SOURCE_INVALID:{}", clip.id)); }
        let duration_ticks = (asset.duration.unwrap_or(0.0).max(0.0) * media::timeline::TICKS_PER_SECOND as f64).round() as i64;
        sources.insert(clip.asset_id.clone(), media::timeline::SourceInfo { duration_ticks });
        let absolute = assets::absolute_path(data_dir, &asset.path)?;
        render_assets.push(media::render::RenderAsset { asset_id: asset.id, path: absolute, kind: asset.kind.clone(), has_audio: asset.kind == "audio" });
    }
    for track in &timeline.audio_tracks {
        if sources.contains_key(&track.asset_id) { continue; }
        let asset = production::repository::require_project_asset(connection, project_id, &track.asset_id).map_err(|error| error.to_string())?;
        if asset.kind != "audio" { return Err(format!("TIMELINE_AUDIO_TRACK_INVALID:{}", track.id)); }
        let duration_ticks = (asset.duration.unwrap_or(0.0).max(0.0) * media::timeline::TICKS_PER_SECOND as f64).round() as i64;
        sources.insert(track.asset_id.clone(), media::timeline::SourceInfo { duration_ticks });
        let absolute = assets::absolute_path(data_dir, &asset.path)?;
        render_assets.push(media::render::RenderAsset { asset_id: asset.id, path: absolute, kind: asset.kind.clone(), has_audio: true });
    }
    let plan = media::timeline::validate_timeline(&timeline, &sources)?;
    Ok((timeline, render_assets, plan))
}

#[tauri::command]
fn prepare_media_export(
    project_id: String,
    timeline_id: String,
    expected_revision: i64,
    preset: String,
    state: State<'_, AppState>,
) -> Result<MediaExportPreviewView, String> {
    if !matches!(preset.as_str(), "vertical-1080x1920" | "horizontal-1920x1080") { return Err("EXPORT_PRESET_INVALID".into()); }
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    let (timeline, _assets, plan) = load_timeline_for_export(&connection, &state.data_dir, &project_id, &timeline_id, expected_revision)?;
    let toolchain = media::toolchain::MediaToolchain::configured(!timeline.subtitle_cues.is_empty()).map_err(|error| error.to_string())?;
    let preview_id = format!("export_preview_{}", uuid::Uuid::new_v4());
    let preview = media::export_task::preview(&preview_id, &plan, &preset);
    let payload = json!({
        "projectId": project_id,
        "timelineId": timeline_id,
        "timelineRevision": expected_revision,
        "editHash": preview.edit_hash,
        "totalTicks": preview.total_ticks,
        "preset": preset,
        "toolchainFingerprint": toolchain.build_fingerprint,
        "plan": plan,
    });
    connection.execute("INSERT INTO media_exports (export_id,project_id,timeline_id,status,payload,created_at,updated_at) VALUES (?1,?2,?3,'preview',?4,?5,?5)", params![preview_id, project_id, timeline_id, payload.to_string(), Utc::now().to_rfc3339()]).map_err(|error| error.to_string())?;
    Ok(MediaExportPreviewView { preview_id, project_id, timeline_id, edit_hash: preview.edit_hash, total_ticks: preview.total_ticks, preset, issues: preview.issues, warnings: preview.warnings })
}

#[tauri::command]
async fn start_media_export(
    preview_id: String,
    acknowledged_issue_ids: Vec<String>,
    request_id: String,
    target_grant_id: String,
    state: State<'_, AppState>,
) -> Result<media::ingest::MediaTask, String> {
    if request_id.trim().is_empty() || request_id.len() > 200 { return Err("MEDIA_REQUEST_ID_INVALID".into()); }
    let db_path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&db_path)?;
    let payload_text: String = connection.query_row("SELECT payload FROM media_exports WHERE export_id=?1", [&preview_id], |row| row.get(0)).map_err(|_| "EXPORT_PREVIEW_NOT_FOUND".to_string())?;
    let payload: Value = serde_json::from_str(&payload_text).map_err(|_| "EXPORT_PREVIEW_INVALID".to_string())?;
    let project_id = payload["projectId"].as_str().ok_or("EXPORT_PREVIEW_INVALID")?.to_string();
    let created_at: String = connection.query_row("SELECT created_at FROM media_exports WHERE export_id=?1", [&preview_id], |row| row.get(0)).map_err(|error| error.to_string())?;
    let preview_created = chrono::DateTime::parse_from_rfc3339(&created_at).map_err(|_| "EXPORT_PREVIEW_INVALID")?;
    if preview_created + chrono::Duration::minutes(10) <= Utc::now() { return Err("EXPORT_PREVIEW_EXPIRED".into()); }
    let target_grant = media::grants::FileGrantStore.get(&target_grant_id).ok_or("FILE_GRANT_INVALID")?;
    let target = media::grants::FileGrantStore.resolve_export_target(&target_grant, &project_id).map_err(|error| error.to_string())?;
    let target_path = target.to_string_lossy().to_string();
    if target.extension().and_then(|value| value.to_str()) != Some("mp4") { return Err("EXPORT_TARGET_INVALID".into()); }
    let status: String = connection.query_row("SELECT status FROM media_exports WHERE export_id=?1", [&preview_id], |row| row.get(0)).map_err(|error| error.to_string())?;
    let timeline_id = payload["timelineId"].as_str().ok_or("EXPORT_PREVIEW_INVALID")?.to_string();
    let edit_hash = payload["editHash"].as_str().ok_or("EXPORT_PREVIEW_INVALID")?.to_string();
    let total_ticks = payload["totalTicks"].as_i64().unwrap_or(0);
    // 阻断级问题必须先修好，不允许靠「忽略」输出不确定的结果；
    // 必须明确确认级的问题逐条确认后可以继续交付（设计 §9.3）。
    // 分级判定统一由 export_task::start 负责，这里只负责还原冻结快照。
    let snapshot = media::export_task::ExportPreview {
        preview_id: preview_id.clone(),
        edit_hash: edit_hash.clone(),
        total_ticks,
        preset: payload["preset"].as_str().unwrap_or_default().to_string(),
        issues: payload["plan"]["issues"].as_array().cloned().unwrap_or_default().into_iter().filter_map(|item| item.as_str().map(str::to_owned)).collect(),
        warnings: payload["plan"]["warnings"].as_array().cloned().unwrap_or_default().into_iter().filter_map(|item| item.as_str().map(str::to_owned)).collect(),
    };
    media::export_task::start(&snapshot, &edit_hash, &acknowledged_issue_ids).map_err(|error| error.to_string())?;
    let warnings = snapshot.warnings.clone();
    let existing: Option<media::ingest::MediaTask> = connection.query_row("SELECT id,project_id,kind,status,payload,created_at,updated_at FROM media_tasks WHERE project_id=?1 AND request_id=?2", params![project_id, request_id], |row| {
        let raw: String = row.get(4)?;
        let parsed: Value = serde_json::from_str(&raw).unwrap_or_default();
        Ok(media::ingest::MediaTask { id: row.get(0)?, project_id: row.get(1)?, kind: row.get(2)?, status: row.get(3)?, asset_id: None, payload: parsed, created_at: row.get(5)?, updated_at: row.get(6)? })
    }).ok();
    if let Some(task) = existing {
        if task.payload["previewId"] == preview_id && task.payload["targetPath"] == target_path { return Ok(task); }
        return Err("MEDIA_EXPORT_REQUEST_CONFLICT".into());
    }
    if status != "preview" { return Err("EXPORT_PREVIEW_ALREADY_USED".into()); }
    let task_id = format!("export_{}", uuid::Uuid::new_v4());
    let now = Utc::now().to_rfc3339();
    let task_payload = json!({"requestId":request_id,"previewId":preview_id,"targetPath":target_path,"timelineId":timeline_id,"editHash":edit_hash,"totalTicks":total_ticks,"acknowledgedWarnings":warnings});
    if let Err(error) = connection.execute("INSERT INTO media_tasks (id,project_id,request_id,kind,status,payload,created_at,updated_at) VALUES (?1,?2,?3,'export','queued',?4,?5,?5)", params![task_id, project_id, request_id, task_payload.to_string(), now]) {
        if error.to_string().contains("UNIQUE constraint failed") {
            if let Ok(task) = connection.query_row("SELECT id,project_id,kind,status,payload,created_at,updated_at FROM media_tasks WHERE project_id=?1 AND request_id=?2", params![project_id,request_id], |row| {
                let raw: String = row.get(4)?; let parsed: Value = serde_json::from_str(&raw).unwrap_or_default();
                Ok(media::ingest::MediaTask { id: row.get(0)?, project_id: row.get(1)?, kind: row.get(2)?, status: row.get(3)?, asset_id: None, payload: parsed, created_at: row.get(5)?, updated_at: row.get(6)? })
            }) {
                if task.payload["previewId"] == preview_id && task.payload["targetPath"] == target_path { return Ok(task); }
                return Err("MEDIA_EXPORT_REQUEST_CONFLICT".into());
            }
        }
        return Err(error.to_string());
    }
    connection.execute("UPDATE media_exports SET status='queued',payload=json_set(payload,'$.taskId',?2,'$.targetPath',?3),updated_at=?4 WHERE export_id=?1", params![preview_id, task_id, target_path, now]).map_err(|error| error.to_string())?;
    connection.execute("UPDATE media_tasks SET status='running',updated_at=?2 WHERE id=?1", params![task_id,Utc::now().to_rfc3339()]).map_err(|error| error.to_string())?;
    connection.execute("UPDATE media_exports SET status='rendering',updated_at=?2 WHERE export_id=?1", params![preview_id,Utc::now().to_rfc3339()]).map_err(|error| error.to_string())?;
    let state_owned = AppState { db_path: Mutex::new(db_path), data_dir: state.data_dir.clone() };
    let preview_id_owned = preview_id.clone();
    let project_id_owned = project_id.clone();
    let task_id_owned = task_id.clone();
    let cancellation = media::export_task::register_cancellation(&task_id);
    tauri::async_runtime::spawn_blocking(move || {
        let result = render_media_export(&state_owned, &preview_id_owned, &project_id_owned, &target, &|| cancellation.load(std::sync::atomic::Ordering::Relaxed));
        let path = state_owned.db_path.lock().ok().map(|value| value.clone());
        if let Some(path) = path {
            if let Ok(connection) = db::open(&path) {
                let (status, message) = match result {
                    Ok(()) => ("succeeded", None),
                    Err(error) if error == "MEDIA_RENDER_CANCELLED" => ("cancelled", Some(error)),
                    Err(error) => ("failed", Some(error)),
                };
                let _ = connection.execute("UPDATE media_tasks SET status=?2,payload=json_set(payload,'$.error',?3),updated_at=?4 WHERE id=?1", params![task_id_owned, status, message, Utc::now().to_rfc3339()]);
                let _ = connection.execute("UPDATE media_exports SET status=?2,updated_at=?3 WHERE export_id=?1", params![preview_id_owned, status, Utc::now().to_rfc3339()]);
            }
        }
        media::export_task::unregister_cancellation(&task_id_owned);
    });
    Ok(media::ingest::MediaTask { id: task_id, project_id, kind: "export".into(), status: "queued".into(), asset_id: None, payload: task_payload, created_at: now.clone(), updated_at: now })
}

fn render_media_export(state: &AppState, preview_id: &str, project_id: &str, target: &std::path::Path, cancel: &dyn Fn() -> bool) -> Result<(), String> {
    let ffmpeg = media::render::configured_ffmpeg().ok_or("MEDIA_TOOL_UNAVAILABLE:ffmpeg")?;
    let db_path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&db_path)?;
    let payload: String = connection.query_row("SELECT payload FROM media_exports WHERE export_id=?1 AND project_id=?2", params![preview_id, project_id], |row| row.get(0)).map_err(|_| "EXPORT_NOT_FOUND".to_string())?;
    let data: Value = serde_json::from_str(&payload).map_err(|_| "EXPORT_INVALID".to_string())?;
    let revision = data["timelineRevision"].as_i64().ok_or("EXPORT_INVALID")?;
    let timeline_id = data["timelineId"].as_str().ok_or("EXPORT_INVALID")?;
    let (timeline, mut assets_for_render, plan) = load_timeline_for_export(&connection, &state.data_dir, project_id, timeline_id, revision)?;
    let toolchain = media::toolchain::MediaToolchain::configured(!timeline.subtitle_cues.is_empty()).map_err(|error| error.to_string())?;
    if data["toolchainFingerprint"].as_str() != Some(toolchain.build_fingerprint.as_str()) { return Err("EXPORT_TOOLCHAIN_CHANGED".into()); }
    let current_hash = media::export_task::preview(preview_id, &plan, data["preset"].as_str().unwrap_or("vertical-1080x1920")).edit_hash;
    if data["editHash"].as_str() != Some(current_hash.as_str()) { return Err("EXPORT_SNAPSHOT_STALE".into()); }
    // 阻断级问题不允许渲染：必须先修好（设计 §9.3）。
    if !plan.issues.is_empty() { return Err("EXPORT_PREFLIGHT_BLOCKED".into()); }
    for asset in &mut assets_for_render {
        if asset.kind == "video" {
            if let Some(ffprobe) = media::probe::configured_ffprobe() {
                asset.has_audio = media::probe::probe(&ffprobe, &asset.path).map(|info| info.has_audio).unwrap_or(false);
            }
        }
    }
    let staging = state.data_dir.join(".staging").join(format!("export-{preview_id}"));
    let staged_output = staging.join("output.mp4");
    let subtitle_text = media::render::format_srt(&timeline.subtitle_cues);
    let subtitle_path = if timeline.subtitle_cues.is_empty() { None } else {
        let path = staging.join("subtitles.srt");
        std::fs::create_dir_all(&staging).map_err(|error| error.to_string())?;
        std::fs::write(&path, subtitle_text.as_bytes()).map_err(|error| error.to_string())?;
        Some(path)
    };
    let (width, height) = match data["preset"].as_str().unwrap_or("vertical-1080x1920") {
        "vertical-1080x1920" => (1080, 1920),
        "horizontal-1920x1080" => (1920, 1080),
        _ => return Err("EXPORT_PRESET_INVALID".into()),
    };
    let options = media::render::RenderOptions {
        width,
        height,
        video_encoder: media::render::configured_video_encoder(),
        subtitle_path: subtitle_path.clone(),
        subtitle_font_dir: std::env::var_os("FRAMEFORGE_FONT_DIR").map(std::path::PathBuf::from),
        subtitle_font_family: std::env::var("FRAMEFORGE_FONT_FAMILY").ok(),
        ..media::render::RenderOptions::default()
    };
    let rendered = media::render::render(&ffmpeg, &plan, &assets_for_render, &options, &staging, &staged_output, cancel).map_err(|error| error.to_string());
    if let Err(error) = rendered {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }
    let ffprobe = media::probe::configured_ffprobe().ok_or("MEDIA_TOOL_UNAVAILABLE:ffprobe")?;
    let probed = match media::probe::probe(&ffprobe, &staged_output) {
        Ok(probed) => probed,
        Err(error) => { let _ = std::fs::remove_dir_all(&staging); return Err(error); }
    };
    let expected_frames = (plan.total_ticks + media::timeline::TICKS_PER_FRAME / 2) / media::timeline::TICKS_PER_FRAME;
    if probed.kind != "video" || probed.width != Some(width) || probed.height != Some(height) || probed.duration_ticks <= 0 || probed.fps.is_none_or(|fps| (fps - 30.0).abs() > 0.01) || probed.frame_count != Some(expected_frames as u64) || !probed.has_audio {
        let _ = std::fs::remove_dir_all(&staging);
        return Err("EXPORT_OUTPUT_INVALID".into());
    }
    if target.exists() { let _ = std::fs::remove_dir_all(&staging); return Err("EXPORT_TARGET_CONFLICT".into()); }
    if let Some(staged_srt) = subtitle_path {
        let mut target_srt = target.to_path_buf();
        target_srt.set_extension("srt");
        if target_srt.exists() { let _ = std::fs::remove_dir_all(&staging); return Err("EXPORT_TARGET_CONFLICT".into()); }
        if let Err(error) = media::export_task::publish_pair(&staged_output, &staged_srt, target, &target_srt).map_err(|error| error.to_string()) { let _ = std::fs::remove_dir_all(&staging); return Err(error); }
    } else {
        if let Err(error) = media::publish::publish_once(&staged_output, target).map_err(|error| error.to_string()) { let _ = std::fs::remove_dir_all(&staging); return Err(error); }
    }
    let _ = std::fs::remove_dir_all(&staging);
    Ok(())
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
    let db_path = state
        .db_path
        .lock()
        .map_err(|_| "db lock".to_string())?
        .clone();
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

/// 导出项目包。
///
/// `include_assets=false`（默认）时只写一个 JSON 元数据包；
/// `include_assets=true` 时写一个目录：里面是 `project.json` 与 `assets/` 素材本体。
///
/// 路径校验与文件写入都在 Rust 侧完成：渲染进程只能给一个目标路径，不能决定写到哪。
#[tauri::command]
fn export_project(
    project_id: String,
    path: String,
    include_assets: Option<bool>,
    state: State<'_, AppState>,
) -> Result<export::ExportSummary, String> {
    export::export_project(
        &state,
        &project_id,
        std::path::Path::new(&path),
        include_assets.unwrap_or(false),
    )
}

pub fn run() {
    tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol(
            "frameforge-media",
            |context, request, responder| {
                let app = context.app_handle().clone();
                let window_label = context.webview_label().to_string();
                std::thread::spawn(move || {
                    responder.respond(media::access::serve_media_request(
                        &app,
                        &window_label,
                        request,
                    ))
                });
            },
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            fs::create_dir_all(&app_data)?;
            let db_path = app_data.join("frameforge.sqlite3");
            open_db(&db_path).map_err(std::io::Error::other)?;
            if let Ok(connection) = db::open(&db_path) {
                let _ = media::export_task::recover_pending(&connection);
            }
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
            save_provider_key,
            delete_provider_key,
            list_studio_projects,
            save_studio_project,
            delete_studio_project,
            list_boards,
            load_board,
            save_board,
            delete_board,
            list_provider_profiles,
            save_provider_profile,
            delete_provider_profile,
            provider_has_key,
            test_provider_profile,
            save_asset_host,
            load_asset_host,
            prepare_paid_run,
            start_paid_run,
            cancel_run,
            list_runs,
            select_run_candidate,
            resume_jobs,
            open_project_media,
            read_project_asset_text,
            list_project_assets,
            delete_project_asset,
            pick_media_files,
            pick_script_file,
            import_script_document,
            pick_subtitle_file,
            import_subtitle_document,
            pick_export_target,
            import_media,
            import_media_paths,
            import_image_bytes,
            import_clipboard_image,
            list_media_tasks,
            cancel_media_task,
            extract_media_frame,
            list_production_entities,
            apply_production_change,
            save_breakdown_draft,
            list_breakdown_drafts,
            adopt_shot_media,
            record_production_review,
            assemble_episode,
            replace_timeline_clip,
            revert_production_change,
            prepare_media_export,
            start_media_export,
            split_sheet,
            save_mask,
            import_legacy_project,
            export_project
        ])
        .run(tauri::generate_context!())
        .expect("error while running Frameforge");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 前端直接消费导入结果，字段名必须稳定在 camelCase。
    #[test]
    fn imported_paths_serialize_with_camel_case_fields() {
        let payload = ImportedPaths {
            imported: vec![ImportedPath {
                asset_id: "abc".into(),
                display_name: "shot.png".into(),
                kind: "image".into(),
            }],
            failed: vec![FailedPath {
                path: "/tmp/broken.txt".into(),
                code: "MEDIA_FORMAT_INVALID".into(),
            }],
        };
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["imported"][0]["assetId"], "abc");
        assert_eq!(json["imported"][0]["displayName"], "shot.png");
        assert_eq!(json["imported"][0]["kind"], "image");
        assert_eq!(json["failed"][0]["path"], "/tmp/broken.txt");
        assert_eq!(json["failed"][0]["code"], "MEDIA_FORMAT_INVALID");
    }

    /// 测试连接必须按新约定读 Key：keys 里的 keyRef 优先，旧单 Key 账户兜底。
    /// 只查旧账户会让「用新约定保存 Key」的供应商永远报「尚未保存 API Key」。
    #[test]
    fn test_key_refs_prefer_new_keys_then_legacy() {
        let mut profile = gateway::test_profile("openai-compatible", "https://example.com");
        profile.keys = vec![gateway::ProviderKey {
            id: "k1".to_string(),
            label: "主".to_string(),
            key_ref: "provider/p1/key/k1".to_string(),
            enabled: true,
            status: "active".to_string(),
            cooldown_until: None,
            has_secret: true,
        }];
        let refs = test_key_refs(&profile, "p1");
        assert_eq!(refs.first().map(String::as_str), Some("provider/p1/key/k1"));
        assert!(
            refs.iter().any(|item| item == "provider/p1"),
            "旧账户仍要兜底"
        );

        // 没有多 Key 的 profile：key_refs 走 auth.keyRef，与旧账户一致，不重复。
        let legacy_only = gateway::test_profile("openai-compatible", "https://example.com");
        let refs = test_key_refs(&legacy_only, "test");
        assert_eq!(refs, vec!["provider/test".to_string()]);
    }

    /// profile 必须原样返回：绑定参数、能力上限这些字段不能被结构体吃掉，
    /// 否则前端一保存就把配置写回成残缺结构。
    #[test]
    fn provider_profiles_keep_fields_the_backend_does_not_model() {
        let profile = json!({
            "id": "p1",
            "name": "P1",
            "adapter": "openai-compatible",
            "baseUrl": "https://example.com",
            "auth": { "type": "bearer", "keyRef": "provider/p1" },
            "enabled": true,
            "schemaVersion": 2,
            "models": [{
                "id": "m1",
                "displayName": "M1",
                "params": [{ "key": "quality", "label": "质量", "type": "select" }],
                "capabilities": [{
                    "capability": "image.edit",
                    "supportsMask": true,
                    "maxReferenceImages": 4,
                    "inputTransport": ["dataUrl"],
                    "async": false
                }]
            }],
            "keys": [{ "id": "k1", "label": "主", "keyRef": "provider/p1/key/k1", "enabled": true, "status": "active" }]
        });
        let mut profiles = vec![profile];
        inject_key_state(&mut profiles);
        let models = profiles[0]["models"].as_array().expect("models");
        assert_eq!(models[0]["params"][0]["key"], "quality");
        assert_eq!(models[0]["capabilities"][0]["supportsMask"], true);
        assert_eq!(models[0]["capabilities"][0]["maxReferenceImages"], 4);
        // 没有钥匙串密钥时 hasKey 为 false，但仍要保留 hasSecret 字段。
        assert_eq!(profiles[0]["keys"][0]["hasSecret"], false);
        assert_eq!(profiles[0]["hasKey"], false);
    }

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
        let data_dir =
            PathBuf::from("/Users/xiic/Library/Application Support/com.frameforge.studio");
        let roots = import_allowed_roots(
            &data_dir,
            std::path::Path::new("/Users/xiic/frameforge/project.json"),
        );
        assert_eq!(roots[0], data_dir);
        assert_eq!(roots[1], PathBuf::from("/Users/xiic/frameforge"));
    }

    #[test]
    fn import_roots_never_include_the_filesystem_root() {
        let data_dir =
            PathBuf::from("/Users/xiic/Library/Application Support/com.frameforge.studio");
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

    /// 造一个带完整关联数据的项目：画板、实体、素材、运行记录都在里面。
    fn seed_project(connection: &Connection, project_id: &str) {
        connection.execute("INSERT INTO studio_projects (id,name,payload,created_at,updated_at) VALUES (?1,'P','{}','now','now')", [project_id]).unwrap();
        connection.execute("INSERT INTO boards (id,project_id,name,payload,created_at,updated_at) VALUES (?1,?2,'B','{}','now','now')", params![format!("board-{project_id}"), project_id]).unwrap();
        connection.execute("INSERT INTO assets (id,kind,path,mime,bytes,payload,created_at) VALUES (?1,'video','cas/video.mp4','video/mp4',1,'{}','now')", [format!("asset-{project_id}")]).unwrap();
        connection.execute("INSERT INTO project_assets (project_id,asset_id,added_at,provenance) VALUES (?1,?2,'now','{}')", params![project_id, format!("asset-{project_id}")]).unwrap();
        connection.execute("INSERT INTO asset_origins (id,project_id,asset_id,origin_kind,origin_ref,payload,created_at) VALUES (?1,?2,?3,'import',NULL,'{}','now')", params![format!("origin-{project_id}"), project_id, format!("asset-{project_id}")]).unwrap();
        for (id, kind) in [("script", "script"), ("shot", "shot"), ("subject", "subject")] {
            connection.execute("INSERT INTO project_entities (id,project_id,kind,schema_version,revision,payload,updated_at) VALUES (?1,?2,?3,1,1,'{}','now')", params![format!("{id}-{project_id}"), project_id, kind]).unwrap();
        }
        connection.execute("INSERT INTO script_revisions (script_id,revision,payload,created_at) VALUES (?1,1,'{}','now')", [format!("script-{project_id}")]).unwrap();
        connection.execute("INSERT INTO shot_adoptions (adoption_id,shot_id,slot,payload,adopted_at) VALUES (?1,?2,'video','{}','now')", params![format!("adoption-{project_id}"), format!("shot-{project_id}")]).unwrap();
        connection.execute("INSERT INTO subject_versions (subject_id,ordinal,payload,created_at) VALUES (?1,1,'{}','now')", [format!("subject-{project_id}")]).unwrap();
        connection.execute("INSERT INTO runs (id,project_id,board_id,node_id,status,cache_key,payload,created_at,updated_at) VALUES (?1,?2,?3,'n','succeeded','c','{}','now','now')", params![format!("run-{project_id}"), project_id, format!("board-{project_id}")]).unwrap();
        connection.execute("INSERT INTO jobs (id,run_id,provider_id,capability,status,attempts,payload,updated_at) VALUES (?1,?2,'p','image','queued',0,'{}','now')", params![format!("job-{project_id}"), format!("run-{project_id}")]).unwrap();
        connection.execute("INSERT INTO media_tasks (id,project_id,kind,status,payload,created_at,updated_at) VALUES (?1,?2,'frame','done','{}','now','now')", params![format!("task-{project_id}"), project_id]).unwrap();
        connection.execute("INSERT INTO media_exports (export_id,project_id,status,payload,created_at,updated_at) VALUES (?1,?2,'done','{}','now','now')", params![format!("export-{project_id}"), project_id]).unwrap();
        connection.execute("INSERT INTO production_changes (change_id,project_id,payload,created_at) VALUES (?1,?2,'{}','now')", params![format!("change-{project_id}"), project_id]).unwrap();
        connection.execute("INSERT INTO breakdown_drafts (draft_id,project_id,script_id,script_revision,payload,created_at) VALUES (?1,?2,?3,1,'{}','now')", params![format!("draft-{project_id}"), project_id, format!("script-{project_id}")]).unwrap();
        connection.execute("INSERT INTO production_reviews (review_id,project_id,payload,created_at) VALUES (?1,?2,'{}','now')", params![format!("review-{project_id}"), project_id]).unwrap();
        connection.execute("INSERT INTO run_previews (preview_id,project_id,board_id,fingerprint,payload,expires_at,created_at) VALUES (?1,?2,?3,'f','{}','now','now')", params![format!("preview-{project_id}"), project_id, format!("board-{project_id}")]).unwrap();
    }

    /// 删除项目要连带清掉所有关联行，但素材本体（assets 行）必须留着。
    #[test]
    fn delete_studio_project_removes_related_rows_but_keeps_assets() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db.sqlite3");
        let mut connection = db::open(&path).unwrap();
        seed_project(&connection, "p1");
        seed_project(&connection, "p2");

        delete_studio_project_data(&mut connection, "p1").unwrap();

        for (table, where_clause) in [
            ("studio_projects", "id='p1'"),
            ("boards", "project_id='p1'"),
            ("project_entities", "project_id='p1'"),
            ("project_assets", "project_id='p1'"),
            ("asset_origins", "project_id='p1'"),
            ("runs", "project_id='p1'"),
            ("jobs", "run_id='run-p1'"),
            ("media_tasks", "project_id='p1'"),
            ("media_exports", "project_id='p1'"),
            ("production_changes", "project_id='p1'"),
            ("breakdown_drafts", "project_id='p1'"),
            ("production_reviews", "project_id='p1'"),
            ("script_revisions", "script_id='script-p1'"),
            ("shot_adoptions", "shot_id='shot-p1'"),
            ("subject_versions", "subject_id='subject-p1'"),
            ("run_previews", "project_id='p1'"),
        ] {
            let left: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table} WHERE {where_clause}"), [], |row| row.get(0))
                .unwrap();
            assert_eq!(left, 0, "{table} 里还残留 p1 的数据");
        }
        // 素材本体保留：素材是内容寻址的，可能被别的项目共用。
        let assets: i64 = connection.query_row("SELECT COUNT(*) FROM assets WHERE id='asset-p1'", [], |row| row.get(0)).unwrap();
        assert_eq!(assets, 1, "素材行不能被删");
        // 另一个项目不受影响。
        let other: i64 = connection.query_row("SELECT COUNT(*) FROM studio_projects WHERE id='p2'", [], |row| row.get(0)).unwrap();
        assert_eq!(other, 1);
        // 删除是幂等的：项目不存在也返回 Ok。
        delete_studio_project_data(&mut connection, "p1").unwrap();
        delete_studio_project_data(&mut connection, "missing").unwrap();
        // 外键不能留下悬空引用。
        let violations: i64 = connection
            .query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| row.get(0))
            .unwrap();
        assert_eq!(violations, 0, "删除项目后不能有外键悬空");
    }

    /// 移除素材只断关联，素材本体和别的项目关联都要留着。
    #[test]
    fn delete_project_asset_only_drops_the_project_membership() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db.sqlite3");
        let mut connection = db::open(&path).unwrap();
        seed_project(&connection, "p1");
        // 同一个素材被两个项目共用。
        connection.execute("INSERT INTO project_assets (project_id,asset_id,added_at,provenance) VALUES ('p2','asset-p1','now','{}')", []).unwrap();
        connection.execute("INSERT INTO asset_origins (id,project_id,asset_id,origin_kind,origin_ref,payload,created_at) VALUES ('origin-p2','p2','asset-p1','import',NULL,'{}','now')", []).unwrap();
        delete_project_asset_data(&mut connection, "p1", "asset-p1").unwrap();

        let memberships: i64 = connection.query_row("SELECT COUNT(*) FROM project_assets WHERE project_id='p1' AND asset_id='asset-p1'", [], |row| row.get(0)).unwrap();
        assert_eq!(memberships, 0, "项目与素材的关联要断掉");
        let origins: i64 = connection.query_row("SELECT COUNT(*) FROM asset_origins WHERE project_id='p1' AND asset_id='asset-p1'", [], |row| row.get(0)).unwrap();
        assert_eq!(origins, 0);
        // 素材本体与其它项目的关联不受影响。
        let assets: i64 = connection.query_row("SELECT COUNT(*) FROM assets WHERE id='asset-p1'", [], |row| row.get(0)).unwrap();
        assert_eq!(assets, 1, "素材行不能被删");
        let shared: i64 = connection.query_row("SELECT COUNT(*) FROM project_assets WHERE project_id='p2' AND asset_id='asset-p1'", [], |row| row.get(0)).unwrap();
        assert_eq!(shared, 1, "别的项目对同一素材的关联要留着");
        // 幂等：关联本来就不存在也返回 Ok。
        delete_project_asset_data(&mut connection, "p1", "asset-p1").unwrap();
        delete_project_asset_data(&mut connection, "p1", "missing").unwrap();
    }

    /// 删掉供应商配置行：只删自己那家，别家不受影响，删两次也不报错。
    #[test]
    fn delete_provider_profile_only_drops_that_provider() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db.sqlite3");
        let connection = db::open(&path).unwrap();
        for id in ["p1", "p2"] {
            connection.execute(
                "INSERT INTO provider_profiles (id, adapter, base_url, enabled, payload, updated_at) VALUES (?1,'openai-compatible','',1,'{}','now')",
                [id],
            ).unwrap();
        }

        delete_provider_profile_data(&connection, "p1").unwrap();
        let left: i64 = connection
            .query_row("SELECT COUNT(*) FROM provider_profiles WHERE id='p1'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(left, 0, "被删的供应商配置行要消失");
        let others: i64 = connection
            .query_row("SELECT COUNT(*) FROM provider_profiles WHERE id='p2'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(others, 1, "别的供应商不能被连坐");
        // 幂等：删不存在的也不报错。
        delete_provider_profile_data(&connection, "p1").unwrap();
        delete_provider_profile_data(&connection, "missing").unwrap();
    }
}
