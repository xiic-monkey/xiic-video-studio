use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileGrant {
    pub(crate) id: String,
    pub(crate) project_id: String,
    pub(crate) path: PathBuf,
    pub(crate) purpose: GrantPurpose,
    pub(crate) expires_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum GrantPurpose {
    MediaImport,
    SubtitleImport,
    ScriptImport,
    ExportTarget,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub(crate) enum GrantError {
    #[error("FILE_GRANT_PROJECT_MISMATCH")]
    ProjectMismatch,
    #[error("FILE_GRANT_PURPOSE_MISMATCH")]
    PurposeMismatch,
    #[error("FILE_GRANT_MISSING")]
    Missing,
    #[error("FILE_GRANT_NOT_FILE")]
    NotFile,
}

#[derive(Default)]
pub(crate) struct FileGrantStore;

static GRANTS: OnceLock<Mutex<HashMap<String, FileGrant>>> = OnceLock::new();
fn registry() -> &'static Mutex<HashMap<String, FileGrant>> {
    GRANTS.get_or_init(|| Mutex::new(HashMap::new()))
}

impl FileGrantStore {
    pub(crate) fn issue(
        &self,
        project_id: &str,
        path: impl Into<PathBuf>,
        purpose: GrantPurpose,
    ) -> Result<FileGrant, GrantError> {
        let path = path.into();
        if !path.exists() {
            return Err(GrantError::Missing);
        }
        let now = chrono::Utc::now();
        let grant = FileGrant {
            id: format!("grant_{}", uuid::Uuid::new_v4()),
            project_id: project_id.to_owned(),
            path,
            purpose,
            expires_at: (now + chrono::Duration::minutes(10)).to_rfc3339(),
        };
        let mut grants = registry().lock().map_err(|_| GrantError::Missing)?;
        grants.retain(|_, item| item.expires_at > now.to_rfc3339());
        grants.insert(grant.id.clone(), grant.clone());
        Ok(grant)
    }

    pub(crate) fn issue_export_target(
        &self,
        project_id: &str,
        path: impl Into<PathBuf>,
    ) -> Result<FileGrant, GrantError> {
        let path = path.into();
        let Some(parent) = path.parent() else { return Err(GrantError::Missing) };
        if !parent.is_dir() || path.exists() { return Err(GrantError::Missing); }
        let now = chrono::Utc::now();
        let grant = FileGrant {
            id: format!("grant_{}", uuid::Uuid::new_v4()),
            project_id: project_id.to_owned(),
            path,
            purpose: GrantPurpose::ExportTarget,
            expires_at: (now + chrono::Duration::minutes(10)).to_rfc3339(),
        };
        let mut grants = registry().lock().map_err(|_| GrantError::Missing)?;
        grants.retain(|_, item| item.expires_at > now.to_rfc3339());
        grants.insert(grant.id.clone(), grant.clone());
        Ok(grant)
    }

    pub(crate) fn get(&self, id: &str) -> Option<FileGrant> {
        registry().lock().ok()?.get(id).cloned()
    }
    pub(crate) fn take(&self, id: &str) -> Option<FileGrant> {
        registry().lock().ok()?.remove(id)
    }

    pub(crate) fn open_input<'a>(
        &self,
        grant: &'a FileGrant,
        project_id: &str,
        purpose: GrantPurpose,
    ) -> Result<std::fs::File, GrantError> {
        if grant.expires_at <= chrono::Utc::now().to_rfc3339() {
            return Err(GrantError::Missing);
        }
        if grant.project_id != project_id {
            return Err(GrantError::ProjectMismatch);
        }
        if grant.purpose != purpose {
            return Err(GrantError::PurposeMismatch);
        }
        let metadata = fs::metadata(&grant.path).map_err(|_| GrantError::Missing)?;
        if !metadata.is_file() {
            return Err(GrantError::NotFile);
        }
        fs::File::open(&grant.path).map_err(|_| GrantError::Missing)
    }

    pub(crate) fn resolve_export_target(
        &self,
        grant: &FileGrant,
        project_id: &str,
    ) -> Result<PathBuf, GrantError> {
        if grant.expires_at <= chrono::Utc::now().to_rfc3339() {
            return Err(GrantError::Missing);
        }
        if grant.project_id != project_id {
            return Err(GrantError::ProjectMismatch);
        }
        if grant.purpose != GrantPurpose::ExportTarget {
            return Err(GrantError::PurposeMismatch);
        }
        if grant.path.as_os_str().is_empty() {
            return Err(GrantError::Missing);
        }
        Ok(grant.path.clone())
    }
}

pub(crate) fn sanitize_display_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("未命名文件")
        .chars()
        .take(160)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn grants_are_scoped_to_project_and_purpose() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("clip.mp4");
        fs::write(&path, b"clip").unwrap();
        let store = FileGrantStore;
        let grant = store.issue("p1", &path, GrantPurpose::MediaImport).unwrap();
        assert!(store
            .open_input(&grant, "p2", GrantPurpose::MediaImport)
            .is_err());
        assert_eq!(
            store
                .open_input(&grant, "p1", GrantPurpose::SubtitleImport)
                .unwrap_err(),
            GrantError::PurposeMismatch
        );
        assert!(store
            .open_input(&grant, "p1", GrantPurpose::MediaImport)
            .is_ok());
    }

    #[test]
    fn missing_source_is_rejected_before_ingest() {
        let store = FileGrantStore;
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(
            store
                .issue(
                    "p1",
                    directory.path().join("missing.mp4"),
                    GrantPurpose::MediaImport
                )
                .unwrap_err(),
            GrantError::Missing
        );
    }
}
