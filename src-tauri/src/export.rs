use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};

use crate::db;
use crate::AppState;

/// 导出包里出现「像本机绝对路径」的字段时一律脱敏。
///
/// 触发点是旧项目导入：素材的 `provenance.legacy.source` 记的是导入前的原始地址，
/// 本地文件就是本机绝对路径。计划里的测试只用了干净种子数据，扫不到这条路径。
const PATH_LIKE_KEYS: [&str; 8] = [
    "path",
    "thumbpath",
    "proxypath",
    "source",
    "filepath",
    "absolutepath",
    "localpath",
    "sourcelocalpath",
];

const REDACTED_LOCAL_PATH: &str = "<已脱敏的本机路径>";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub path: String,
    pub project_id: String,
    pub boards: usize,
    pub runs: usize,
    pub assets: usize,
}

pub fn build_package(connection: &Connection, project_id: &str) -> Result<Value, String> {
    let project_text: String = connection
        .query_row(
            "SELECT payload FROM studio_projects WHERE id=?1",
            [project_id],
            |row| row.get(0),
        )
        .map_err(|_| format!("项目不存在：{project_id}"))?;
    let mut project: Value = serde_json::from_str(&project_text).map_err(|error| error.to_string())?;
    crate::strip_sensitive_fields(&mut project);

    let mut boards: Vec<Value> = Vec::new();
    {
        let mut statement = connection
            .prepare("SELECT payload FROM boards WHERE project_id=?1 ORDER BY updated_at ASC")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([project_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        for row in rows {
            let mut board: Value =
                serde_json::from_str(&row.map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
            crate::strip_sensitive_fields(&mut board);
            boards.push(board);
        }
    }

    let mut runs: Vec<Value> = Vec::new();
    {
        let mut statement = connection
            .prepare("SELECT payload FROM runs WHERE project_id=?1 ORDER BY created_at ASC")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([project_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        for row in rows {
            let mut run: Value =
                serde_json::from_str(&row.map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
            crate::strip_sensitive_fields(&mut run);
            runs.push(run);
        }
    }

    let mut asset_ids: Vec<String> = Vec::new();
    for entry in boards.iter().chain(runs.iter()) {
        collect_referenced_assets(entry, &mut asset_ids);
    }
    let assets: Vec<Value> = asset_ids
        .iter()
        .filter_map(|id| asset_entry(connection, id))
        .collect();

    let mut package = json!({
        "schemaVersion": 1,
        "packageKind": "frameforge.project",
        "exportedAt": chrono::Utc::now().to_rfc3339(),
        "project": project,
        "boards": boards,
        "runs": runs,
        "assets": assets,
        "assetBodiesIncluded": false,
    });
    scrub_local_paths(&mut package);
    Ok(package)
}

/// 判断字符串是否像「本机绝对路径」。
///
/// 只看形态，不看语义：https URL 不会命中，`/` 开头的路径会命中。
/// 盘符形式（`C:\...`）一并覆盖，虽然 P0 只在 macOS 上跑。
fn looks_like_local_absolute_path(value: &str) -> bool {
    if value.starts_with('/') {
        return true;
    }
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\')
}

/// 按字段名脱敏：只动「路径类字段」，不碰用户正文。
///
/// 提示词里出现 "/" 开头的句子很常见（"1/2 构图"），无差别扫描会把用户内容改坏，
/// 所以这里必须按字段名精确匹配。
fn scrub_local_paths(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (field, nested) in map.iter_mut() {
                let key = field.to_ascii_lowercase();
                if PATH_LIKE_KEYS.contains(&key.as_str()) {
                    if let Some(text) = nested.as_str() {
                        if looks_like_local_absolute_path(text) {
                            *nested = Value::String(REDACTED_LOCAL_PATH.to_string());
                            continue;
                        }
                    }
                }
                scrub_local_paths(nested);
            }
        }
        Value::Array(items) => {
            for nested in items.iter_mut() {
                scrub_local_paths(nested);
            }
        }
        _ => {}
    }
}

// 导出规模是「数百资产」量级，线性去重足够；不要为它引入 IndexSet 之类新依赖。
fn push_asset_id(id: &str, sink: &mut Vec<String>) {
    if id.is_empty() || sink.iter().any(|existing| existing == id) {
        return;
    }
    sink.push(id.to_string());
}

fn collect_referenced_assets(value: &Value, sink: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            if let Some(id) = map.get("selectedAssetId").and_then(Value::as_str) {
                push_asset_id(id, sink);
            }
            for key in ["inputAssetIds", "outputAssetIds"] {
                if let Some(ids) = map.get(key).and_then(Value::as_array) {
                    for id in ids.iter().filter_map(Value::as_str) {
                        push_asset_id(id, sink);
                    }
                }
            }
            for nested in map.values() {
                collect_referenced_assets(nested, sink);
            }
        }
        Value::Array(items) => {
            for nested in items {
                collect_referenced_assets(nested, sink);
            }
        }
        _ => {}
    }
}

fn asset_entry(connection: &Connection, id: &str) -> Option<Value> {
    connection
        .query_row(
            "SELECT id, kind, path, mime, bytes, width, height, duration FROM assets WHERE id=?1",
            [id],
            |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0).unwrap_or_default(),
                    "kind": row.get::<_, String>(1).unwrap_or_default(),
                    "relativePath": row.get::<_, String>(2).unwrap_or_default(),
                    "mime": row.get::<_, String>(3).unwrap_or_default(),
                    "bytes": row.get::<_, i64>(4).unwrap_or_default(),
                    "width": row.get::<_, Option<i64>>(5).unwrap_or(None),
                    "height": row.get::<_, Option<i64>>(6).unwrap_or(None),
                    "duration": row.get::<_, Option<f64>>(7).unwrap_or(None),
                }))
            },
        )
        .ok()
}

pub fn validate_destination(dest: &Path, data_dir: &Path) -> Result<PathBuf, String> {
    if dest.components().any(|component| matches!(component, Component::ParentDir)) {
        return Err("导出路径不合法".to_string());
    }
    if dest.extension().and_then(|value| value.to_str()) != Some("json") {
        return Err("导出文件必须以 .json 结尾".to_string());
    }
    let file_name = dest.file_name().ok_or_else(|| "导出路径缺少文件名".to_string())?;
    let parent = dest
        .parent()
        .ok_or_else(|| "导出路径缺少目录".to_string())?
        .canonicalize()
        .map_err(|_| "导出目录不存在".to_string())?;
    let resolved = parent.join(file_name);
    let data_root = data_dir.canonicalize().map_err(|error| error.to_string())?;
    if resolved.starts_with(&data_root) {
        return Err("不能导出到应用数据目录内".to_string());
    }
    if resolved.symlink_metadata().is_ok() {
        let metadata = resolved.symlink_metadata().map_err(|error| error.to_string())?;
        // 覆盖本身交给保存对话框确认；这里只挡住软链接和目录，避免把导出重定向到别处。
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("导出目标已存在且不是普通文件，已拒绝".to_string());
        }
    }
    Ok(resolved)
}

pub fn export_project(state: &AppState, project_id: &str, dest: &Path) -> Result<ExportSummary, String> {
    // 先校验目标路径：路径不合法就别白读一遍数据库。
    let resolved = validate_destination(dest, &state.data_dir)?;
    let db_path = state
        .db_path
        .lock()
        .map_err(|_| "db lock".to_string())?
        .clone();
    let package = {
        let connection = db::open(&db_path)?;
        build_package(&connection, project_id)?
    };
    let raw = serde_json::to_string_pretty(&package).map_err(|error| error.to_string())?;
    std::fs::write(&resolved, raw.as_bytes()).map_err(|error| error.to_string())?;

    let count = |key: &str| {
        package
            .get(key)
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or_default()
    };
    Ok(ExportSummary {
        path: resolved.to_string_lossy().to_string(),
        project_id: project_id.to_string(),
        boards: count("boards"),
        runs: count("runs"),
        assets: count("assets"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(connection: &rusqlite::Connection) {
        connection
            .execute(
                "INSERT INTO studio_projects (id, name, payload, created_at, updated_at)
                 VALUES ('p1', '测试项目', ?1, '2026-10-31T00:00:00Z', '2026-10-31T00:00:00Z')",
                [r#"{"id":"p1","name":"测试项目","settings":{"apiKey":"sk-leak","baseUrl":"https://relay.example/v1"}}"#],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO boards (id, project_id, name, payload, created_at, updated_at)
                 VALUES ('b1', 'p1', '主画布', ?1, '2026-10-31T00:00:00Z', '2026-10-31T00:00:00Z')",
                [r#"{"id":"b1","projectId":"p1","name":"主画布","schemaVersion":1,"cacheKey":"board-cache-key-stays","nodes":{"n1":{"id":"n1","type":"image","data":{"selectedAssetId":"a1"}}},"edges":{},"viewport":{"x":0,"y":0,"zoom":1}}"#],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO runs (id, project_id, board_id, node_id, status, cache_key, payload, created_at, updated_at)
                 VALUES ('r1', 'p1', 'b1', 'n1', 'succeeded', 'ck1', ?1, '2026-10-31T00:00:00Z', '2026-10-31T00:00:00Z')",
                [r#"{"id":"r1","boardId":"b1","nodeId":"n1","status":"succeeded","cacheKey":"ck1","inputAssetIds":[],"outputAssetIds":["a1"],"apiKey":"sk-run-leak"}"#],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO assets (id, kind, path, mime, bytes, width, height, duration, payload, created_at)
                 VALUES ('a1', 'image', 'assets/ab/ab12.png', 'image/png', 120, 1024, 1024, NULL, '{}', '2026-10-31T00:00:00Z')",
                [],
            )
            .unwrap();
    }

    #[test]
    fn package_drops_credentials_but_keeps_cache_keys_and_relative_paths() {
        let dir = tempfile::tempdir().unwrap();
        let connection = crate::db::open(&dir.path().join("db.sqlite3")).unwrap();
        seed(&connection);

        let package = build_package(&connection, "p1").unwrap();
        let raw = serde_json::to_string(&package).unwrap();

        assert!(!raw.contains("sk-leak"), "项目设置里的 apiKey 必须被剥掉");
        assert!(!raw.contains("sk-run-leak"), "运行记录里的 apiKey 必须被剥掉");
        assert!(raw.contains("board-cache-key-stays"), "cacheKey 不能被子串匹配误伤");
        assert!(!raw.contains(dir.path().to_str().unwrap()), "导出不得含本机绝对路径");
        assert_eq!(package["boards"].as_array().map(Vec::len), Some(1));
        assert_eq!(package["assets"][0]["relativePath"], serde_json::json!("assets/ab/ab12.png"));
        assert_eq!(package["assetBodiesIncluded"], serde_json::json!(false));
    }

    #[test]
    fn unknown_project_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let connection = crate::db::open(&dir.path().join("db.sqlite3")).unwrap();
        let error = build_package(&connection, "nope").unwrap_err();
        assert!(error.contains("项目不存在"), "实际错误：{error}");
    }

    #[test]
    fn destination_rejects_escape_text_and_data_dir() {
        let data_dir = tempfile::tempdir().unwrap();
        let out_dir = tempfile::tempdir().unwrap();

        let ok = validate_destination(&out_dir.path().join("包.json"), data_dir.path()).unwrap();
        assert!(ok.to_string_lossy().ends_with("包.json"));

        assert!(validate_destination(std::path::Path::new("../evil.json"), data_dir.path()).is_err());
        assert!(validate_destination(&out_dir.path().join("evil.txt"), data_dir.path()).is_err());
        assert!(validate_destination(&data_dir.path().join("inside.json"), data_dir.path()).is_err());
        assert!(validate_destination(&out_dir.path().join("nope/missing.json"), data_dir.path()).is_err());
        // 普通文件可以覆盖（保存对话框已确认），软链接不行。
        std::fs::write(&out_dir.path().join("again.json"), b"{}").unwrap();
        assert!(validate_destination(&out_dir.path().join("again.json"), data_dir.path()).is_ok());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/etc/passwd", &out_dir.path().join("link.json")).unwrap();
            assert!(validate_destination(&out_dir.path().join("link.json"), data_dir.path()).is_err());
        }
    }

    #[test]
    fn export_writes_a_parseable_file_and_counts() {
        let data_dir = tempfile::tempdir().unwrap();
        let out_dir = tempfile::tempdir().unwrap();
        let state = crate::AppState {
            db_path: std::sync::Mutex::new(data_dir.path().join("db.sqlite3")),
            data_dir: data_dir.path().to_path_buf(),
        };
        {
            let connection = crate::db::open(&data_dir.path().join("db.sqlite3")).unwrap();
            seed(&connection);
        }

        let summary = export_project(&state, "p1", &out_dir.path().join("project.json")).unwrap();
        assert_eq!((summary.boards, summary.runs, summary.assets), (1, 1, 1));
        let text = std::fs::read_to_string(&summary.path).unwrap();
        assert!(!text.contains("sk-leak"));
        serde_json::from_str::<serde_json::Value>(&text).unwrap();

        // 退出标准第 3 条：导出到同一个文件名 → 覆盖成功，且文件仍是合法 JSON。
        let again = export_project(&state, "p1", &out_dir.path().join("project.json")).unwrap();
        assert_eq!(again.path, summary.path);
        let overwritten = std::fs::read_to_string(&again.path).unwrap();
        serde_json::from_str::<serde_json::Value>(&overwritten).unwrap();

        // 退出标准第 3 条：目标是软链接时必须被拒绝，不能顺着链接写到别处。
        #[cfg(unix)]
        {
            let link = out_dir.path().join("link.json");
            std::os::unix::fs::symlink(out_dir.path().join("project.json"), &link).unwrap();
            let error = export_project(&state, "p1", &link).expect_err("软链接必须被拒绝");
            assert!(error.contains("不是普通文件"), "实际错误：{error}");
        }
    }

    /// P0 退出标准第 3 条的自动化版本：对**真实写出的文件**做 key 名扫描与密钥前缀扫描。
    ///
    /// 手工验收时用 grep 跑的是：
    ///   grep -Eio '"(api[_]?key|secret[_]?key|access[_]?key|token|password)"' 验收-*.json
    ///   grep -c 'sk-' 验收-*.json
    /// 这里用同样的判据把「导出文件里没有任何密钥字段、也没有任何密钥值」钉死。
    #[test]
    fn written_export_file_carries_no_key_fields_and_keeps_cache_keys() {
        let data_dir = tempfile::tempdir().unwrap();
        let out_dir = tempfile::tempdir().unwrap();
        let state = crate::AppState {
            db_path: std::sync::Mutex::new(data_dir.path().join("db.sqlite3")),
            data_dir: data_dir.path().to_path_buf(),
        };
        {
            let connection = crate::db::open(&data_dir.path().join("db.sqlite3")).unwrap();
            seed(&connection);
        }

        let summary = export_project(&state, "p1", &out_dir.path().join("验收.json")).unwrap();
        let text = std::fs::read_to_string(&summary.path).unwrap();

        // 第一条：不能出现任何密钥字段名（大小写不敏感）。
        for field in [
            "\"apiKey\"", "\"api_key\"", "\"secretKey\"", "\"secret_key\"", "\"accessKey\"",
            "\"access_key\"", "\"token\"", "\"password\"", "\"credential\"", "\"secret\"",
        ] {
            let lower = text.to_ascii_lowercase();
            assert!(
                !lower.contains(&field.to_ascii_lowercase()),
                "导出文件里出现了密钥字段 {field}：{text}"
            );
        }
        // 第二条：不能出现任何密钥值形态。
        assert!(!text.contains("sk-"), "导出文件里出现了密钥值：{text}");
        // 第三条：cacheKey 必须还在——导出→导入后缓存语义不能被破坏。
        assert!(text.contains("\"cacheKey\""), "cacheKey 被误伤了：{text}");
        assert!(text.contains("board-cache-key-stays"));
        assert!(text.contains("ck1"));
    }

    /// 旧项目导入的素材会把「导入前的原始地址」记进 provenance.legacy.source，
    /// 本地文件那一支就是本机绝对路径。导出包不允许含本机绝对路径，必须脱敏；
    /// 但远端 URL 要留下（P2 重新导入时还要用），提示词正文也不能被误伤。
    #[test]
    fn local_absolute_paths_are_redacted_but_urls_and_prompts_survive() {
        let dir = tempfile::tempdir().unwrap();
        let connection = crate::db::open(&dir.path().join("db.sqlite3")).unwrap();
        seed(&connection);
        connection
            .execute(
                "INSERT INTO runs (id, project_id, board_id, node_id, status, cache_key, payload, created_at, updated_at)
                 VALUES ('r2', 'p1', 'b1', 'n1', 'succeeded', 'ck2', ?1, '2026-10-31T00:00:00Z', '2026-10-31T00:00:00Z')",
                [r#"{"id":"r2","boardId":"b1","nodeId":"n1","status":"succeeded","cacheKey":"ck2","prompt":"1/2 构图，仰角 45°","assets":[{"id":"a2","path":"assets/cd/cd34.png","provenance":{"legacy":{"source":"/Users/xiic/frameforge/sb1.png"}}},{"id":"a3","path":"assets/ef/ef56.png","provenance":{"legacy":{"source":"https://cdn.example.com/a.png"}}}]}"#],
            )
            .unwrap();

        let package = build_package(&connection, "p1").unwrap();
        let raw = serde_json::to_string(&package).unwrap();

        assert!(
            !raw.contains("/Users/xiic/frameforge/sb1.png"),
            "导出包不得含本机绝对路径：{raw}"
        );
        assert!(
            raw.contains("https://cdn.example.com/a.png"),
            "远端素材地址要保留，P2 重新导入时还要用"
        );
        assert!(raw.contains("1/2 构图，仰角 45°"), "提示词正文不能被路径脱敏误伤");
        assert!(raw.contains("assets/cd/cd34.png"), "CAS 相对路径要保留");
        assert!(raw.contains("ck2"), "cacheKey 不能被误伤");
    }
}
