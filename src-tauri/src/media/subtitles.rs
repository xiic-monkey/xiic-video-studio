use super::grants::{FileGrantStore, GrantPurpose};
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::io::Read;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubtitleDocument {
    pub text: String,
    pub display_name: String,
}

pub(crate) fn import_subtitle(
    state: &AppState,
    store: &FileGrantStore,
    project_id: &str,
    grant_id: &str,
) -> Result<SubtitleDocument, String> {
    let grant = store.get(grant_id).ok_or("FILE_GRANT_INVALID")?;
    let mut file = store
        .open_input(&grant, project_id, GrantPurpose::SubtitleImport)
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.by_ref()
        .take(2 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("SUBTITLE_TOO_LARGE".into());
    }
    let text = String::from_utf8(bytes).map_err(|_| "SUBTITLE_NOT_UTF8".to_string())?;
    let _ = state;
    Ok(SubtitleDocument {
        text,
        display_name: super::grants::sanitize_display_name(&grant.path),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_ungranted_or_non_utf8_subtitle() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState {
            db_path: std::sync::Mutex::new(dir.path().join("db.sqlite3")),
            data_dir: dir.path().to_path_buf(),
        };
        let store = FileGrantStore;
        assert!(import_subtitle(&state, &store, "p", "missing").is_err());
        let path = dir.path().join("x.srt");
        std::fs::write(&path, [0xff]).unwrap();
        let grant = store
            .issue("p", &path, GrantPurpose::SubtitleImport)
            .unwrap();
        assert_eq!(
            import_subtitle(&state, &store, "p", &grant.id).unwrap_err(),
            "SUBTITLE_NOT_UTF8"
        );
    }
}
