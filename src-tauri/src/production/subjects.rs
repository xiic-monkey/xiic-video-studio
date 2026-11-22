use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubjectVersion { pub subject_id: String, pub ordinal: i64, pub descriptor: String, pub references: Vec<Value> }

pub(crate) fn create_subject_version(connection: &rusqlite::Connection, version: &SubjectVersion) -> Result<(), String> {
    connection.execute("INSERT INTO subject_versions (subject_id,ordinal,payload,created_at) VALUES (?1,?2,?3,datetime('now'))", params![version.subject_id, version.ordinal, serde_json::to_string(version).map_err(|e| e.to_string())?]).map_err(|error| if error.to_string().contains("UNIQUE") { "SUBJECT_VERSION_IMMUTABLE".into() } else { error.to_string() })?;
    Ok(())
}

#[allow(dead_code)]
pub(crate) fn latest_subject_version(connection: &rusqlite::Connection, subject_id: &str) -> Result<Option<SubjectVersion>, String> {
    connection.query_row("SELECT payload FROM subject_versions WHERE subject_id=?1 ORDER BY ordinal DESC LIMIT 1", [subject_id], |row| row.get::<_, String>(0)).optional().map_err(|e| e.to_string()).and_then(|payload| payload.map(|text| serde_json::from_str(&text).map_err(|e| e.to_string())).transpose())
}

#[cfg(test)] mod tests { use super::*; use crate::db; #[test] fn subject_versions_are_immutable() { let dir=tempfile::tempdir().unwrap(); let c=db::open(&dir.path().join("db.sqlite3")).unwrap(); let v=SubjectVersion{subject_id:"s".into(),ordinal:1,descriptor:"hero".into(),references:vec![]}; create_subject_version(&c,&v).unwrap(); assert_eq!(create_subject_version(&c,&v).unwrap_err(),"SUBJECT_VERSION_IMMUTABLE"); } }
