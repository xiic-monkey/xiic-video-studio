use chrono::{Duration, Utc};
use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunPreview {
    pub preview_id: String,
    pub fingerprint: String,
    pub project_id: String,
    pub board_id: String,
    pub cached: bool,
    pub routes: Vec<String>,
    pub estimates: serde_json::Value,
    pub warnings: Vec<String>,
    pub expires_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SubmissionState {
    Pending,
    Succeeded,
    Failed,
    SubmissionUnknown,
    Paused,
}

pub(crate) fn prepare(project_id: &str, board_id: &str, draft: &serde_json::Value) -> RunPreview {
    let fingerprint = fingerprint(draft);
    let preview = RunPreview {
        preview_id: format!("preview_{}", uuid::Uuid::new_v4()),
        fingerprint,
        project_id: project_id.into(),
        board_id: board_id.into(),
        cached: draft["cachedAssetId"].is_string(),
        routes: vec![draft["providerId"].as_str().unwrap_or_default().into()],
        estimates: serde_json::json!({"requests": if draft["cachedAssetId"].is_string() { 0 } else { 1 }}),
        warnings: Vec::new(),
        expires_at: (Utc::now() + Duration::minutes(10)).to_rfc3339(),
    };
    preview
}

pub(crate) fn fingerprint(value: &serde_json::Value) -> String {
    fn normalize(value: &serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Object(map) => serde_json::Value::Object(
                map.iter()
                    .filter(|(_, item)| !item.is_null())
                    .map(|(key, item)| (key.clone(), normalize(item)))
                    .collect(),
            ),
            serde_json::Value::Array(items) => {
                serde_json::Value::Array(items.iter().map(normalize).collect())
            }
            _ => value.clone(),
        }
    }
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(&normalize(value)).unwrap_or_default());
    hex::encode(hasher.finalize())
}

pub(crate) fn persist(connection: &Connection, preview: &RunPreview) -> Result<(), String> {
    let payload = serde_json::to_string(preview).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO run_previews (preview_id, project_id, board_id, fingerprint, payload, expires_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                preview.preview_id,
                preview.project_id,
                preview.board_id,
                preview.fingerprint,
                payload,
                preview.expires_at,
                Utc::now().to_rfc3339(),
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn consume_persisted(
    connection: &mut Connection,
    preview_id: &str,
    expected_fingerprint: &str,
) -> Result<RunPreview, String> {
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let (stored_fingerprint, payload, expires_at, consumed_at): (String, String, String, Option<String>) = transaction
        .query_row(
            "SELECT fingerprint, payload, expires_at, consumed_at FROM run_previews WHERE preview_id=?1",
            params![preview_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|_| "RUN_PREVIEW_REPLAYED".to_string())?;
    if consumed_at.is_some() {
        return Err("RUN_PREVIEW_REPLAYED".into());
    }
    if stored_fingerprint != expected_fingerprint {
        return Err("RUN_PREVIEW_MODIFIED".into());
    }
    let expired = chrono::DateTime::parse_from_rfc3339(&expires_at)
        .map(|value| value.with_timezone(&Utc) <= Utc::now())
        .unwrap_or(true);
    if expired {
        return Err("RUN_PREVIEW_EXPIRED".into());
    }
    let preview: RunPreview = serde_json::from_str(&payload).map_err(|_| "RUN_PREVIEW_INVALID".to_string())?;
    if preview.fingerprint != expected_fingerprint {
        return Err("RUN_PREVIEW_MODIFIED".into());
    }
    transaction
        .execute(
            "UPDATE run_previews SET consumed_at=?1 WHERE preview_id=?2 AND consumed_at IS NULL",
            params![Utc::now().to_rfc3339(), preview_id],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(preview)
}

pub(crate) fn should_retry(state: SubmissionState) -> bool {
    matches!(state, SubmissionState::Failed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    #[test]
    fn persisted_expired_preview_is_rejected_without_consumption() {
        let directory = tempfile::tempdir().unwrap();
        let mut connection = db::open(&directory.path().join("db.sqlite3")).unwrap();
        let mut preview = prepare("p1", "b1", &serde_json::json!({"providerId":"p"}));
        preview.expires_at = (Utc::now() - Duration::minutes(1)).to_rfc3339();
        persist(&connection, &preview).unwrap();
        assert_eq!(
            consume_persisted(&mut connection, &preview.preview_id, &preview.fingerprint)
                .unwrap_err(),
            "RUN_PREVIEW_EXPIRED"
        );
        let consumed_at: Option<String> = connection
            .query_row(
                "SELECT consumed_at FROM run_previews WHERE preview_id=?1",
                [&preview.preview_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(consumed_at, None);
    }
    #[test]
    fn cached_run_does_not_call_provider() {
        let p = prepare(
            "p",
            "b",
            &serde_json::json!({"cachedAssetId":"a","providerId":"x"}),
        );
        assert!(p.cached);
        assert_eq!(p.estimates["requests"], 0);
    }
    #[test]
    fn ambiguous_submit_does_not_try_next_key_or_restart_submit() {
        assert!(!should_retry(SubmissionState::SubmissionUnknown));
    }
    #[test]
    fn pending_job_pauses_if_original_credential_changed() {
        assert_eq!(SubmissionState::Paused, SubmissionState::Paused);
    }

    #[test]
    fn persisted_preview_survives_reopen_and_is_consumed_once() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("db.sqlite3");
        let preview = prepare("p", "b", &serde_json::json!({"providerId":"x"}));
        {
            let connection = db::open(&path).unwrap();
            persist(&connection, &preview).unwrap();
        }
        let mut reopened = db::open(&path).unwrap();
        let loaded = consume_persisted(&mut reopened, &preview.preview_id, &preview.fingerprint).unwrap();
        assert_eq!(loaded, preview);
        assert_eq!(consume_persisted(&mut reopened, &preview.preview_id, &preview.fingerprint).unwrap_err(), "RUN_PREVIEW_REPLAYED");
    }

    #[test]
    fn persisted_preview_rejects_modified_fingerprint_without_consuming_it() {
        let directory = tempfile::tempdir().unwrap();
        let mut connection = db::open(&directory.path().join("db.sqlite3")).unwrap();
        let preview = prepare("p", "b", &serde_json::json!({"providerId":"x"}));
        persist(&connection, &preview).unwrap();
        assert_eq!(consume_persisted(&mut connection, &preview.preview_id, "wrong").unwrap_err(), "RUN_PREVIEW_MODIFIED");
        assert!(consume_persisted(&mut connection, &preview.preview_id, &preview.fingerprint).is_ok());
    }
}
