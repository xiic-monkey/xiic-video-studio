use super::{
    publish::{publish_once, PublishError},
    timeline::TimelinePlan,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex, OnceLock};

static EXPORT_CANCELLATIONS: OnceLock<Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn cancellations() -> &'static Mutex<std::collections::HashMap<String, Arc<AtomicBool>>> {
    EXPORT_CANCELLATIONS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

pub(crate) fn register_cancellation(task_id: &str) -> Arc<AtomicBool> {
    let token = Arc::new(AtomicBool::new(false));
    if let Ok(mut store) = cancellations().lock() { store.insert(task_id.to_string(), token.clone()); }
    token
}

pub(crate) fn cancel(task_id: &str) -> bool {
    let Ok(store) = cancellations().lock() else { return false };
    let Some(token) = store.get(task_id) else { return false };
    token.store(true, Ordering::Relaxed);
    true
}

pub(crate) fn unregister_cancellation(task_id: &str) {
    if let Ok(mut store) = cancellations().lock() { store.remove(task_id); }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportPreview {
    pub preview_id: String,
    pub edit_hash: String,
    pub total_ticks: i64,
    pub preset: String,
    /// 阻断级问题：不能靠确认放行。
    pub issues: Vec<String>,
    /// 必须明确确认级问题：逐条确认后仍可交付。
    pub warnings: Vec<String>,
}

pub(crate) fn preview(preview_id: &str, plan: &TimelinePlan, preset: &str) -> ExportPreview {
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(plan).unwrap_or_default());
    ExportPreview {
        preview_id: preview_id.into(),
        edit_hash: hex::encode(hasher.finalize()),
        total_ticks: plan.total_ticks,
        preset: preset.into(),
        issues: plan.issues.clone(),
        warnings: plan.warnings.clone(),
    }
}

pub(crate) fn start(
    preview: &ExportPreview,
    current_edit_hash: &str,
    acknowledged: &[String],
) -> Result<(), String> {
    if preview.edit_hash != current_edit_hash {
        return Err("EXPORT_SNAPSHOT_STALE".into());
    }
    if !preview.issues.is_empty() {
        return Err("EXPORT_PREFLIGHT_BLOCKED".into());
    }
    if preview
        .warnings
        .iter()
        .any(|warning| !acknowledged.iter().any(|item| item == warning))
    {
        return Err("EXPORT_ISSUE_UNACKNOWLEDGED".into());
    }
    Ok(())
}

pub(crate) fn publish_pair(
    mp4: &Path,
    srt: &Path,
    mp4_target: &Path,
    srt_target: &Path,
) -> Result<(), PublishError> {
    publish_once(mp4, mp4_target)?;
    publish_once(srt, srt_target)?;
    Ok(())
}

pub(crate) fn recover_pending(connection: &rusqlite::Connection) -> Result<usize, String> {
    let now = chrono::Utc::now().to_rfc3339();
    let changed = connection.execute(
        "UPDATE media_tasks SET status='paused', payload=json_set(payload,'$.error','MEDIA_TASK_NEEDS_REVIEW'), updated_at=?1 WHERE kind='export' AND status IN ('queued','running')",
        [now.clone()],
    ).map_err(|error| error.to_string())?;
    connection.execute(
        "UPDATE media_exports SET status='paused', updated_at=?1 WHERE status IN ('queued','rendering','validating','publishing')",
        [now],
    ).map_err(|error| error.to_string())?;
    if let Some(data_dir) = data_dir_of(connection) {
        let _ = cleanup_stale_export_staging(&data_dir);
    }
    Ok(changed)
}

/// 应用的数据目录与数据库文件同属一个目录（`app_data`），因此从连接路径反推。
fn data_dir_of(connection: &rusqlite::Connection) -> Option<std::path::PathBuf> {
    let path = connection.path()?;
    if path.is_empty() || path == ":memory:" {
        return None;
    }
    std::path::Path::new(path)
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(std::path::Path::to_path_buf)
}

const STAGING_EXPIRY: std::time::Duration = std::time::Duration::from_secs(3600);

/// 回收属于本应用、未完成且已过期的导出暂存目录。
/// 只处理 `.staging/export-export_preview_<id>`，且目录内只允许出现本应用的导出中间产物。
pub(crate) fn cleanup_stale_export_staging(data_dir: &Path) -> Result<usize, String> {
    let staging = data_dir.join(".staging");
    let entries = match std::fs::read_dir(&staging) {
        Ok(entries) => entries,
        Err(_) => return Ok(0),
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if !is_export_staging_dir(name) || !is_expired(&path) || !holds_only_export_artifacts(&path) {
            continue;
        }
        if std::fs::remove_dir_all(&path).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

fn is_export_staging_dir(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("export-export_preview_") else {
        return false;
    };
    !rest.is_empty()
        && rest
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn is_expired(path: &Path) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    let Ok(modified) = metadata.modified() else {
        return false;
    };
    std::time::SystemTime::now()
        .duration_since(modified)
        .map(|age| age > STAGING_EXPIRY)
        .unwrap_or(false)
}

fn holds_only_export_artifacts(path: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(path) else {
        return false;
    };
    entries.flatten().all(|entry| {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            return false;
        };
        matches!(
            name.as_str(),
            "concat.txt" | "output.mp4" | "concatenated.mp4" | "mixed.mp4" | "subtitled.mp4" | "subtitles.srt"
        ) || is_normalized_clip(&name)
    })
}

fn is_normalized_clip(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("clip-") else {
        return false;
    };
    let Some(digits) = rest.strip_suffix(".mp4") else {
        return false;
    };
    !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_changed_timeline_and_unacknowledged_warning() {
        let plan = TimelinePlan {
            clips: vec![],
            audio_tracks: vec![],
            total_ticks: 1,
            issues: vec![],
            warnings: vec!["warn".into()],
        };
        let p = preview("p", &plan, "vertical");
        assert_eq!(start(&p, "different", &[]).unwrap_err(), "EXPORT_SNAPSHOT_STALE");
        assert_eq!(start(&p, &p.edit_hash, &[]).unwrap_err(), "EXPORT_ISSUE_UNACKNOWLEDGED");
        assert!(start(&p, &p.edit_hash, &["warn".into()]).is_ok());
    }

    #[test]
    fn blocking_issues_cannot_be_acknowledged_away() {
        let plan = TimelinePlan {
            clips: vec![],
            audio_tracks: vec![],
            total_ticks: 1,
            issues: vec!["TIMELINE_RANGE_INVALID:c1".into()],
            warnings: vec!["TIMELINE_AUDIO_TRACK_INVALID:voice".into()],
        };
        let p = preview("p", &plan, "vertical");
        assert_eq!(
            start(&p, &p.edit_hash, &["TIMELINE_RANGE_INVALID:c1".into()]).unwrap_err(),
            "EXPORT_PREFLIGHT_BLOCKED"
        );
        assert_eq!(
            start(&p, &p.edit_hash, &["TIMELINE_AUDIO_TRACK_INVALID:voice".into()]).unwrap_err(),
            "EXPORT_PREFLIGHT_BLOCKED"
        );
    }

    #[test]
    fn every_warning_must_be_acknowledged() {
        let plan = TimelinePlan {
            clips: vec![],
            audio_tracks: vec![],
            total_ticks: 1,
            issues: vec![],
            warnings: vec!["w1".into(), "w2".into()],
        };
        let p = preview("p", &plan, "vertical");
        assert_eq!(
            start(&p, &p.edit_hash, &["w1".into()]).unwrap_err(),
            "EXPORT_ISSUE_UNACKNOWLEDGED"
        );
        assert!(start(&p, &p.edit_hash, &["w1".into(), "w2".into()]).is_ok());
    }

    #[test]
    fn preview_carries_issues_and_warnings_separately() {
        let plan = TimelinePlan {
            clips: vec![],
            audio_tracks: vec![],
            total_ticks: 1,
            issues: vec!["block".into()],
            warnings: vec!["confirm".into()],
        };
        let p = preview("p", &plan, "vertical");
        assert_eq!(p.issues, vec!["block".to_string()]);
        assert_eq!(p.warnings, vec!["confirm".to_string()]);
    }

    #[test]
    fn refuses_to_overwrite_existing_target() {
        let d = tempfile::tempdir().unwrap();
        let staged = d.path().join("x");
        let target = d.path().join("out.mp4");
        std::fs::write(&staged, b"x").unwrap();
        std::fs::write(&target, b"old").unwrap();
        assert_eq!(
            publish_once(&staged, &target).unwrap_err(),
            PublishError::TargetConflict
        );
    }
    #[test]
    fn publishes_staged_mp4_and_srt_when_targets_are_empty() {
        let d = tempfile::tempdir().unwrap();
        let a = d.path().join("a");
        let b = d.path().join("b");
        let at = d.path().join("a.mp4");
        let bt = d.path().join("b.srt");
        std::fs::write(&a, b"a").unwrap();
        std::fs::write(&b, b"b").unwrap();
        publish_pair(&a, &b, &at, &bt).unwrap();
        assert!(at.exists() && bt.exists());
    }

    #[test]
    fn recovery_pauses_interrupted_exports_without_guessing_output_success() {
        let directory = tempfile::tempdir().unwrap();
        let connection = crate::db::open(&directory.path().join("db.sqlite3")).unwrap();
        connection.execute("INSERT INTO media_tasks (id,project_id,request_id,kind,status,payload,created_at,updated_at) VALUES ('t','p','r','export','running','{}','2026-01-01','2026-01-01')", []).unwrap();
        connection.execute("INSERT INTO media_exports (export_id,project_id,status,payload,created_at,updated_at) VALUES ('e','p','rendering','{}','2026-01-01','2026-01-01')", []).unwrap();
        assert_eq!(recover_pending(&connection).unwrap(), 1);
        assert_eq!(connection.query_row("SELECT status FROM media_tasks WHERE id='t'", [], |row| row.get::<_, String>(0)).unwrap(), "paused");
        assert_eq!(connection.query_row("SELECT status FROM media_exports WHERE export_id='e'", [], |row| row.get::<_, String>(0)).unwrap(), "paused");
    }

    #[test]
    fn recovery_removes_expired_export_staging_but_keeps_import_staging_and_assets() {
        let directory = tempfile::tempdir().unwrap();
        let staging = directory.path().join(".staging");
        std::fs::create_dir_all(&staging).unwrap();
        let expired = staging.join("export-export_preview_11111111-2222-3333-4444-555555555555");
        std::fs::create_dir_all(&expired).unwrap();
        std::fs::write(expired.join("clip-0000.mp4"), b"x").unwrap();
        std::fs::write(expired.join("concatenated.mp4"), b"x").unwrap();
        let fresh = staging.join("export-export_preview_99999999-2222-3333-4444-555555555555");
        std::fs::create_dir_all(&fresh).unwrap();
        std::fs::write(fresh.join("clip-0000.mp4"), b"x").unwrap();
        let import_staging = staging.join("11111111-2222-3333-4444-555555555555.tmp");
        std::fs::write(&import_staging, b"x").unwrap();
        let frame_staging = staging.join("frame-abcdef");
        std::fs::create_dir_all(&frame_staging).unwrap();
        let assets = directory.path().join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        std::fs::write(assets.join("keep.png"), b"x").unwrap();

        let old = std::time::SystemTime::now() - STAGING_EXPIRY - std::time::Duration::from_secs(60);
        let directory_handle = std::fs::File::open(&expired).unwrap();
        directory_handle
            .set_times(std::fs::FileTimes::new().set_modified(old))
            .unwrap();

        let connection = crate::db::open(&directory.path().join("db.sqlite3")).unwrap();
        assert_eq!(recover_pending(&connection).unwrap(), 0);
        assert!(!expired.exists(), "过期的导出暂存目录应被回收");
        assert!(fresh.exists(), "未过期的导出暂存目录应保留");
        assert!(import_staging.exists(), "导入暂存文件不应被删");
        assert!(frame_staging.exists(), "抽帧暂存目录不应被删");
        assert!(assets.join("keep.png").exists(), "素材目录不应被删");
    }
}
