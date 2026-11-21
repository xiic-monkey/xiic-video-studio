use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetRef {
    pub id: String,
    pub kind: String,
    pub path: String,
    pub thumb_path: Option<String>,
    pub proxy_path: Option<String>,
    pub mime: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub duration: Option<f64>,
    pub bytes: u64,
    pub created_at: String,
    pub provenance: Value,
}

pub fn extension_for(mime: &str, kind: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/quicktime" => "mov",
        "audio/mpeg" => "mp3",
        "audio/wav" => "wav",
        "audio/ogg" => "ogg",
        "text/plain" | "text/markdown" => "txt",
        "application/json" => "json",
        // octet-stream 意味着「格式未知」，不能按 kind 猜成 png/mp4。
        "application/octet-stream" => "bin",
        _ => match kind {
            "image" => "png",
            "video" => "mp4",
            "audio" => "mp3",
            "text" => "txt",
            "json" => "json",
            _ => "bin",
        },
    }
}

pub fn store_bytes(
    root: &Path,
    bytes: &[u8],
    kind: &str,
    mime: &str,
    provenance: Value,
) -> Result<AssetRef, String> {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let id = hex::encode(hasher.finalize());
    let extension = extension_for(mime, kind);
    let relative = format!("assets/{}/{}.{}", &id[0..2], id, extension);
    let absolute = area_path(root, &relative)?;
    if !absolute.exists() {
        if let Some(parent) = absolute.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let temporary = absolute.with_file_name(format!(".{id}.tmp"));
        fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
        fs::rename(&temporary, &absolute).map_err(|error| error.to_string())?;
    }
    Ok(AssetRef {
        id,
        kind: kind.to_string(),
        path: relative,
        thumb_path: None,
        proxy_path: None,
        mime: mime.to_string(),
        width: None,
        height: None,
        duration: None,
        bytes: bytes.len() as u64,
        created_at: chrono::Utc::now().to_rfc3339(),
        provenance,
    })
}

fn area_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_))
        })
    {
        return Err("STORAGE_PATH_INVALID".to_string());
    }
    Ok(root.join(path))
}

pub fn absolute_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    area_path(root, relative)
}

/// 写派生产物（例如缩略图）：不进资产表，只落文件。
pub fn write_derived(root: &Path, relative: &str, bytes: &[u8]) -> Result<String, String> {
    let absolute = area_path(root, relative)?;
    if let Some(parent) = absolute.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&absolute, bytes).map_err(|error| error.to_string())?;
    Ok(relative.to_string())
}

pub fn decode_data_url(value: &str) -> Option<(String, Vec<u8>)> {
    let rest = value.strip_prefix("data:")?;
    let (meta, payload) = rest.split_once(',')?;
    let mime = meta.split(';').next()?.to_string();
    let bytes = base64::engine::general_purpose::STANDARD.decode(payload).ok()?;
    Some((mime, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stores_content_addressed_and_deduplicates() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bytes = b"hello frameforge";
        let first = store_bytes(dir.path(), bytes, "text", "text/plain", json!({"projectId": "p1"})).expect("first");
        let second = store_bytes(dir.path(), bytes, "text", "text/plain", json!({"projectId": "p2"})).expect("second");
        assert_eq!(first.id, second.id);
        assert!(first.path.starts_with("assets/"));
        assert_eq!(first.bytes, bytes.len() as u64);
        assert!(dir.path().join(&first.path).exists());
        let count = std::fs::read_dir(dir.path().join("assets"))
            .expect("dir")
            .flat_map(|entry| std::fs::read_dir(entry.unwrap().path()).unwrap())
            .count();
        assert_eq!(count, 1);
    }

    #[test]
    fn rejects_parent_directory_paths() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(absolute_path(dir.path(), "assets/../secret.txt").is_err());
        assert!(absolute_path(dir.path(), "/etc/passwd").is_err());
    }

    #[test]
    fn decodes_data_urls() {
        let (mime, bytes) = decode_data_url("data:image/png;base64,aGVsbG8=").expect("decode");
        assert_eq!(mime, "image/png");
        assert_eq!(bytes, b"hello");
    }

    #[test]
    fn maps_mime_to_extension() {
        assert_eq!(extension_for("image/jpeg", "image"), "jpg");
        assert_eq!(extension_for("video/mp4", "video"), "mp4");
        assert_eq!(extension_for("audio/mpeg", "audio"), "mp3");
        assert_eq!(extension_for("text/plain", "text"), "txt");
        assert_eq!(extension_for("application/octet-stream", "image"), "bin");
    }
}
