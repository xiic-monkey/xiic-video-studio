use super::grants::{FileGrant, FileGrantStore, GrantPurpose};
use crate::{
    assets, db,
    production::repository::{record_asset_membership, AssetOrigin},
    AppState,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const MAX_IMAGE_BYTES: u64 = 30 * 1024 * 1024;
const MAX_AUDIO_BYTES: u64 = 100 * 1024 * 1024;
const MAX_VIDEO_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct IngestedAsset {
    pub(crate) asset_id: String,
    pub(crate) display_name: String,
    pub(crate) bytes: u64,
    pub(crate) kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaTask {
    pub id: String,
    pub project_id: String,
    pub kind: String,
    pub status: String,
    pub asset_id: Option<String>,
    pub payload: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

pub(crate) fn import_grants(
    state: &AppState,
    store: &FileGrantStore,
    project_id: &str,
    grant_ids: &[String],
    request_id: &str,
) -> Result<MediaTask, String> {
    let db_path = state
        .db_path
        .lock()
        .map_err(|_| "db lock".to_string())?
        .clone();
    let existing = db::open(&db_path)?.query_row("SELECT id,kind,status,payload,created_at,updated_at FROM media_tasks WHERE project_id=?1 AND request_id=?2", rusqlite::params![project_id, request_id], |row| {
        let payload_text: String = row.get(3)?;
        let payload: serde_json::Value = serde_json::from_str(&payload_text).unwrap_or_default();
        let asset_id = payload["importedAssetIds"].as_array().and_then(|items| items.first()).and_then(|value| value.as_str()).map(str::to_owned);
        Ok(MediaTask { id: row.get(0)?, project_id: project_id.into(), kind: row.get(1)?, status: row.get(2)?, payload, asset_id, created_at: row.get(4)?, updated_at: row.get(5)? })
    }).ok();
    if let Some(task) = existing {
        return Ok(task);
    }
    let task_id = format!("media_{}", uuid::Uuid::new_v4());
    let now = Utc::now().to_rfc3339();
    let mut imported = Vec::new();
    let mut failed = Vec::new();
    for grant_id in grant_ids {
        match store
            .take(grant_id)
            .and_then(|grant| ingest_grant(state, store, project_id, &grant).ok())
        {
            Some(asset) => imported.push(asset.asset_id),
            None => failed.push(grant_id.clone()),
        }
    }
    let status = if imported.is_empty() {
        "failed"
    } else {
        "succeeded"
    };
    let payload = serde_json::json!({"requestId": request_id, "importedAssetIds": imported, "failedGrantIds": failed});
    let path = state
        .db_path
        .lock()
        .map_err(|_| "db lock".to_string())?
        .clone();
    let connection = db::open(&path)?;
    connection.execute("INSERT INTO media_tasks (id,project_id,request_id,kind,status,payload,created_at,updated_at) VALUES (?1,?2,?3,'import',?4,?5,?6,?6)", rusqlite::params![task_id, project_id, request_id, status, payload.to_string(), now]).map_err(|e| e.to_string())?;
    Ok(MediaTask {
        id: task_id,
        project_id: project_id.into(),
        kind: "import".into(),
        status: status.into(),
        asset_id: imported.first().cloned(),
        payload,
        created_at: now.clone(),
        updated_at: now,
    })
}

pub(crate) fn list_tasks(state: &AppState, project_id: &str) -> Result<Vec<MediaTask>, String> {
    let path = state
        .db_path
        .lock()
        .map_err(|_| "db lock".to_string())?
        .clone();
    let connection = db::open(&path)?;
    let mut statement = connection.prepare("SELECT id,project_id,kind,status,payload,created_at,updated_at FROM media_tasks WHERE project_id=?1 ORDER BY updated_at DESC").map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([project_id], |row| {
            let payload: String = row.get(4)?;
            Ok(MediaTask {
                id: row.get(0)?,
                project_id: row.get(1)?,
                kind: row.get(2)?,
                status: row.get(3)?,
                asset_id: serde_json::from_str::<serde_json::Value>(&payload)
                    .ok()
                    .and_then(|v| {
                        v["importedAssetIds"]
                            .as_array()
                            .and_then(|a| a.first())
                            .and_then(|v| v.as_str())
                            .map(str::to_owned)
                    }),
                payload: serde_json::from_str(&payload).unwrap_or_default(),
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.map(|row| row.map_err(|e| e.to_string())).collect()
}

pub(crate) fn cancel_task(
    state: &AppState,
    project_id: &str,
    task_id: &str,
) -> Result<MediaTask, String> {
    let path = state
        .db_path
        .lock()
        .map_err(|_| "db lock".to_string())?
        .clone();
    let connection = db::open(&path)?;
    let now = Utc::now().to_rfc3339();
    connection.execute("UPDATE media_tasks SET status='cancelled',updated_at=?1 WHERE id=?2 AND project_id=?3 AND status NOT IN ('succeeded','failed','cancelled')", rusqlite::params![now,task_id,project_id]).map_err(|e| e.to_string())?;
    list_tasks(state, project_id)?
        .into_iter()
        .find(|task| task.id == task_id)
        .ok_or_else(|| "MEDIA_TASK_NOT_FOUND".into())
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub(crate) enum IngestError {
    #[error("MEDIA_TOO_LARGE")]
    TooLarge,
    #[error("MEDIA_FORMAT_INVALID")]
    InvalidFormat,
    #[error("MEDIA_GRANT_INVALID")]
    GrantInvalid,
    #[error("MEDIA_DB: {0}")]
    Database(String),
}

impl IngestError {
    /// 失败原因对外暴露的稳定代码：库内错误保留原始 MEDIA_ 前缀，其余归到 MEDIA_DB。
    pub(crate) fn code(&self) -> String {
        match self {
            IngestError::TooLarge => "MEDIA_TOO_LARGE".into(),
            IngestError::InvalidFormat => "MEDIA_FORMAT_INVALID".into(),
            IngestError::GrantInvalid => "MEDIA_GRANT_INVALID".into(),
            IngestError::Database(message) => {
                if message.starts_with("MEDIA_") {
                    message.clone()
                } else {
                    format!("MEDIA_DB: {message}")
                }
            }
        }
    }
}

/// 按路径导入：前端拖拽文件拿到的是裸路径，没有 grant 可用。
pub(crate) fn ingest_path(
    state: &AppState,
    project_id: &str,
    path: &Path,
) -> Result<IngestedAsset, IngestError> {
    let metadata = std::fs::metadata(path).map_err(|_| IngestError::InvalidFormat)?;
    if !metadata.is_file() {
        return Err(IngestError::InvalidFormat);
    }
    let file = std::fs::File::open(path).map_err(|_| IngestError::InvalidFormat)?;
    ingest_file(state, project_id, path, file, metadata.len())
}

pub(crate) fn ingest_grant(
    state: &AppState,
    grants: &FileGrantStore,
    project_id: &str,
    grant: &FileGrant,
) -> Result<IngestedAsset, IngestError> {
    let file = grants
        .open_input(grant, project_id, GrantPurpose::MediaImport)
        .map_err(|_| IngestError::GrantInvalid)?;
    let metadata_len = file
        .metadata()
        .map_err(|_| IngestError::InvalidFormat)?
        .len();
    ingest_file(state, project_id, grant.path.as_path(), file, metadata_len)
}

/// 已打开文件之后的导入流程：判定类型 → 大小校验 → 落盘 → 落库 → 登记项目成员。
pub(crate) fn ingest_file(
    state: &AppState,
    project_id: &str,
    path: &Path,
    file: std::fs::File,
    metadata_len: u64,
) -> Result<IngestedAsset, IngestError> {
    let kind = kind_for_path(path).ok_or(IngestError::InvalidFormat)?;
    let limit = match kind {
        "image" => MAX_IMAGE_BYTES,
        "audio" => MAX_AUDIO_BYTES,
        _ => MAX_VIDEO_BYTES,
    };
    if metadata_len > limit {
        return Err(IngestError::TooLarge);
    }
    let display_name = super::grants::sanitize_display_name(path);
    let mime = mime_for_path(path, kind);
    let mut probed_metadata = None;
    let mut image_dimensions = None;
    let mut asset = assets::store_reader(
        &state.data_dir,
        file,
        limit,
        kind,
        mime,
        serde_json::json!({"projectId":project_id,"displayName":display_name,"kind":"import"}),
        |staged_path, prefix| {
            if !looks_like_kind(prefix, kind, path) {
                return Err("MEDIA_FORMAT_INVALID".into());
            }
            if kind == "image" {
                let decoded = image::ImageReader::open(staged_path)
                    .map_err(|_| "MEDIA_FORMAT_INVALID")?
                    .with_guessed_format()
                    .map_err(|_| "MEDIA_FORMAT_INVALID")?
                    .decode()
                    .map_err(|_| "MEDIA_FORMAT_INVALID")?;
                if u64::from(decoded.width()) * u64::from(decoded.height()) > 40_000_000 {
                    return Err("MEDIA_TOO_LARGE".into());
                }
                image_dimensions = Some((decoded.width(), decoded.height()));
            } else {
                let ffprobe = ffprobe_path().ok_or_else(|| "MEDIA_TOOL_UNAVAILABLE:ffprobe".to_string())?;
                let probed = super::probe::probe(&ffprobe, staged_path)?;
                if probed.kind != kind || probed.duration_ticks <= 0 {
                    return Err("MEDIA_FORMAT_INVALID".into());
                }
                if kind == "video" && probed.duration_ticks > 30 * 60 * 240_000 {
                    return Err("MEDIA_DURATION_TOO_LONG".into());
                }
                probed_metadata = Some(probed);
            }
            Ok(())
        },
    )
    .map_err(|error| {
        if error == "MEDIA_TOO_LARGE" {
            IngestError::TooLarge
        } else if error == "MEDIA_FORMAT_INVALID" {
            IngestError::InvalidFormat
        } else {
            IngestError::Database(error)
        }
    })?;
    if let Some((width, height)) = image_dimensions {
        asset.width = Some(width);
        asset.height = Some(height);
    }
    if let Some(probed) = probed_metadata {
        asset.width = probed.width;
        asset.height = probed.height;
        asset.duration = Some(probed.duration_ticks as f64 / 240_000.0);
    }
    let id = asset.id.clone();
    register_asset(state, project_id, &asset, &display_name).map_err(IngestError::Database)?;
    Ok(IngestedAsset {
        asset_id: id,
        display_name,
        bytes: metadata_len,
        kind: kind.into(),
    })
}

/// 落库并登记到项目：assets 表 + 项目素材归属。
///
/// 走文件导入的和走剪贴板粘贴的最终都是「一段字节 → 一个项目素材」，
/// 所以共用这一步，免得两处各写一遍归属登记。
pub(crate) fn register_asset(
    state: &AppState,
    project_id: &str,
    asset: &assets::AssetRef,
    display_name: &str,
) -> Result<(), String> {
    let path = state
        .db_path
        .lock()
        .map_err(|_| "lock".to_string())?
        .clone();
    let connection = db::open(&path)?;
    let transaction = connection
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    transaction.execute("INSERT INTO assets (id,kind,path,mime,bytes,width,height,duration,payload,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(id) DO NOTHING", rusqlite::params![asset.id,asset.kind,asset.path,asset.mime,asset.bytes,asset.width,asset.height,asset.duration,serde_json::to_string(asset).map_err(|error| error.to_string())?,asset.created_at]).map_err(|error| error.to_string())?;
    record_asset_membership(
        &transaction,
        project_id,
        asset,
        &AssetOrigin {
            kind: "import".into(),
            reference: Some(display_name.to_string()),
        },
    )
    .map_err(|error| error.to_string())?;
    transaction
        .commit()
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn ffprobe_path() -> Option<PathBuf> {
    super::probe::configured_ffprobe()
}

fn kind_for_path(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" | "jpg" | "jpeg" | "webp" => Some("image"),
        "mp4" | "mov" => Some("video"),
        "wav" | "mp3" | "m4a" => Some("audio"),
        _ => None,
    }
}
fn mime_for_path(path: &Path, kind: &str) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "png" => "image/png",
        "mov" => "video/quicktime",
        "mp4" => "video/mp4",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "mp3" => "audio/mpeg",
        _ => match kind {
            "image" => "image/png",
            "audio" => "audio/mpeg",
            _ => "video/mp4",
        },
    }
}
fn looks_like_kind(bytes: &[u8], kind: &str, path: &Path) -> bool {
    match kind {
        "image" => match path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str()
        {
            "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
            "jpg" | "jpeg" => bytes.starts_with(b"\xFF\xD8\xFF"),
            "webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
            _ => false,
        },
        "video" => bytes.len() >= 12 && &bytes[4..8] == b"ftyp",
        "audio" => {
            bytes.starts_with(b"RIFF")
                || bytes.starts_with(b"ID3")
                || bytes.starts_with(b"\xFF\xFB")
                || bytes.starts_with(b"\xFF\xF3")
                || bytes.starts_with(b"\xFF\xF2")
                || (bytes.len() >= 12 && &bytes[4..8] == b"ftyp")
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::super::grants::FileGrantStore;
    use super::*;
    #[test]
    fn rejects_fake_or_oversize_media_before_publication() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("fake.mp4");
        std::fs::write(&path, b"not a video").unwrap();
        let state = AppState {
            db_path: std::sync::Mutex::new(directory.path().join("db.sqlite3")),
            data_dir: directory.path().to_path_buf(),
        };
        let store = FileGrantStore;
        let grant = store.issue("p1", &path, GrantPurpose::MediaImport).unwrap();
        assert_eq!(
            ingest_grant(&state, &store, "p1", &grant).unwrap_err(),
            IngestError::InvalidFormat
        );
    }

    #[test]
    fn imports_valid_items_only_and_retains_after_source_removal() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("source.png");
        let image = image::RgbaImage::from_pixel(2, 2, image::Rgba([1, 2, 3, 255]));
        image::DynamicImage::ImageRgba8(image).save(&path).unwrap();
        let state = AppState {
            db_path: std::sync::Mutex::new(directory.path().join("db.sqlite3")),
            data_dir: directory.path().to_path_buf(),
        };
        let store = FileGrantStore;
        let grant = store.issue("p1", &path, GrantPurpose::MediaImport).unwrap();
        let imported = ingest_grant(&state, &store, "p1", &grant).unwrap();
        std::fs::remove_file(&path).unwrap();
        let connection = db::open(&directory.path().join("db.sqlite3")).unwrap();
        let asset = crate::production::repository::require_project_asset(
            &connection,
            "p1",
            &imported.asset_id,
        )
        .unwrap();
        assert!(directory.path().join(asset.path).is_file());
        assert_eq!(imported.kind, "image");
    }

    #[test]
    fn cannot_use_a_grant_in_another_project() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("source.png");
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            1,
            1,
            image::Rgba([0, 0, 0, 255]),
        ))
        .save(&path)
        .unwrap();
        let state = AppState {
            db_path: std::sync::Mutex::new(directory.path().join("db.sqlite3")),
            data_dir: directory.path().to_path_buf(),
        };
        let store = FileGrantStore;
        let grant = store.issue("p1", &path, GrantPurpose::MediaImport).unwrap();
        assert_eq!(
            ingest_grant(&state, &store, "p2", &grant).unwrap_err(),
            IngestError::GrantInvalid
        );
    }

    #[test]
    fn imported_image_dimensions_are_written_to_the_asset_columns() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("source.png");
        let image = image::RgbaImage::from_pixel(3, 5, image::Rgba([9, 9, 9, 255]));
        image::DynamicImage::ImageRgba8(image).save(&path).unwrap();
        let state = AppState {
            db_path: std::sync::Mutex::new(directory.path().join("db.sqlite3")),
            data_dir: directory.path().to_path_buf(),
        };
        let store = FileGrantStore;
        let grant = store.issue("p1", &path, GrantPurpose::MediaImport).unwrap();
        let imported = ingest_grant(&state, &store, "p1", &grant).unwrap();
        let connection = db::open(&directory.path().join("db.sqlite3")).unwrap();
        let (width, height): (i64, i64) = connection
            .query_row(
                "SELECT width, height FROM assets WHERE id=?1",
                [&imported.asset_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((width, height), (3, 5));
    }

    #[cfg(unix)]
    struct FfprobeStub {
        previous: Option<std::ffi::OsString>,
    }

    #[cfg(unix)]
    impl Drop for FfprobeStub {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(value) => std::env::set_var("FRAMEFORGE_FFPROBE", value),
                None => std::env::remove_var("FRAMEFORGE_FFPROBE"),
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn imported_media_duration_is_readable_from_the_asset_columns() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let stub = directory.path().join("ffprobe-stub");
        std::fs::write(
            &stub,
            "#!/bin/sh\ncat <<'JSON'\n{\"streams\":[{\"codec_type\":\"video\",\"width\":1280,\"height\":720,\"avg_frame_rate\":\"30/1\"}],\"format\":{\"duration\":\"12.5\"}}\nJSON\n",
        )
        .unwrap();
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
        let _stub_guard = FfprobeStub {
            previous: std::env::var_os("FRAMEFORGE_FFPROBE"),
        };
        std::env::set_var("FRAMEFORGE_FFPROBE", &stub);

        let path = directory.path().join("source.mp4");
        std::fs::write(&path, b"\x00\x00\x00\x18ftypisom\x00\x00\x00\x00").unwrap();
        let state = AppState {
            db_path: std::sync::Mutex::new(directory.path().join("db.sqlite3")),
            data_dir: directory.path().to_path_buf(),
        };
        let store = FileGrantStore;
        let grant = store.issue("p1", &path, GrantPurpose::MediaImport).unwrap();
        let imported = ingest_grant(&state, &store, "p1", &grant).unwrap();

        let connection = db::open(&directory.path().join("db.sqlite3")).unwrap();
        let (width, height, duration): (i64, i64, f64) = connection
            .query_row(
                "SELECT width, height, duration FROM assets WHERE id=?1",
                [&imported.asset_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!((width, height), (1280, 720));
        assert_eq!(duration, 12.5);
    }

    #[test]
    fn imports_a_file_by_path_without_a_grant() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("dragged.png");
        image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            1,
            1,
            image::Rgba([7, 8, 9, 255]),
        ))
        .save(&path)
        .unwrap();
        let state = AppState {
            db_path: std::sync::Mutex::new(directory.path().join("db.sqlite3")),
            data_dir: directory.path().to_path_buf(),
        };
        let imported = ingest_path(&state, "p1", &path).unwrap();
        assert_eq!(imported.kind, "image");
        assert_eq!(imported.display_name, "dragged.png");
        assert_eq!(imported.asset_id.len(), 64);
        assert!(imported.asset_id.chars().all(|value| value.is_ascii_hexdigit()));
    }

    #[test]
    fn path_import_rejects_missing_files_and_unsupported_extensions() {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState {
            db_path: std::sync::Mutex::new(directory.path().join("db.sqlite3")),
            data_dir: directory.path().to_path_buf(),
        };
        let missing = directory.path().join("nope.png");
        assert_eq!(
            ingest_path(&state, "p1", &missing).unwrap_err(),
            IngestError::InvalidFormat
        );
        let text = directory.path().join("notes.txt");
        std::fs::write(&text, b"plain text").unwrap();
        assert_eq!(
            ingest_path(&state, "p1", &text).unwrap_err(),
            IngestError::InvalidFormat
        );
    }
}
