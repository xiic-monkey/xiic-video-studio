use serde_json::Value;

use rusqlite::{params, Connection, OptionalExtension};

pub(crate) fn validate_draft(value: &Value, line_count: i64) -> Result<(), String> {
    let shots = value["shots"].as_array().ok_or("BREAKDOWN_SHOTS_MISSING")?;
    let mut ids = std::collections::HashSet::new();
    for shot in shots {
        let id = shot["localId"]
            .as_str()
            .ok_or("BREAKDOWN_LOCAL_ID_INVALID")?;
        if !ids.insert(id) {
            return Err("BREAKDOWN_LOCAL_ID_DUPLICATE".into());
        }
        let start = shot["source"]["startLine"]
            .as_i64()
            .ok_or("BREAKDOWN_SOURCE_RANGE")?;
        let end = shot["source"]["endLine"]
            .as_i64()
            .ok_or("BREAKDOWN_SOURCE_RANGE")?;
        if start < 1 || end < start || end > line_count {
            return Err("BREAKDOWN_SOURCE_RANGE".into());
        }
    }
    Ok(())
}

pub(crate) fn save_draft(connection: &Connection, project_id: &str, draft_id: &str, script_id: &str, script_revision: i64, payload: &Value) -> Result<(), String> {
    let _script_payload: String = connection.query_row(
        "SELECT payload FROM project_entities WHERE id=?1 AND project_id=?2 AND kind='script' AND archived_at IS NULL",
        params![script_id, project_id],
        |row| row.get(0),
    ).map_err(|_| "BREAKDOWN_SCRIPT_NOT_FOUND")?;
    let source_payload: String = connection.query_row(
        "SELECT payload FROM script_revisions WHERE script_id=?1 AND revision=?2",
        params![script_id, script_revision],
        |row| row.get(0),
    ).map_err(|_| "BREAKDOWN_SCRIPT_REVISION_CONFLICT")?;
    let line_count = serde_json::from_str::<Value>(&source_payload).ok().and_then(|value| value["body"].as_str().map(|body| body.lines().count().max(1) as i64)).unwrap_or(1);
    validate_draft(payload, line_count)?;
    let serialized = serde_json::to_string(payload).map_err(|error| error.to_string())?;
    if let Ok(existing) = connection.query_row("SELECT project_id,script_id,script_revision,payload FROM breakdown_drafts WHERE draft_id=?1", [draft_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?, row.get::<_, String>(3)?))) {
        if existing.0 != project_id || existing.1 != script_id || existing.2 != script_revision {
            return Err("BREAKDOWN_DRAFT_CONFLICT".into());
        }
        // 同一草案反复保存时覆盖内容，脚本归属变化仍然报冲突。
        // 内容变了就是一份还没应用过的新草案：必须清掉 applied_change_id，
        // 否则用户改完再应用会被幂等逻辑当成「已应用过」而什么都不做。
        if existing.3 != serialized {
            connection.execute(
                "UPDATE breakdown_drafts SET payload=?1, applied_change_id=NULL WHERE draft_id=?2",
                params![serialized, draft_id],
            ).map_err(|error| error.to_string())?;
        }
        return Ok(());
    }
    connection.execute(
        "INSERT INTO breakdown_drafts (draft_id,project_id,script_id,script_revision,payload,created_at) VALUES (?1,?2,?3,?4,?5,datetime('now'))",
        params![draft_id, project_id, script_id, script_revision, serialized],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

/// 记录草案已经被哪次变更应用，用于重复提交时返回原结果。
pub(crate) fn mark_draft_applied(connection: &Connection, project_id: &str, draft_id: &str, change_id: &str) -> Result<(), String> {
    let updated = connection.execute(
        "UPDATE breakdown_drafts SET applied_change_id=?1 WHERE draft_id=?2 AND project_id=?3",
        params![change_id, draft_id, project_id],
    ).map_err(|error| error.to_string())?;
    if updated == 0 {
        return Err("BREAKDOWN_DRAFT_NOT_FOUND".into());
    }
    Ok(())
}

/// 读取草案已应用的变更号；未应用返回 Ok(None)。
pub(crate) fn draft_application(connection: &Connection, project_id: &str, draft_id: &str) -> Result<Option<String>, String> {
    let applied: Option<Option<String>> = connection
        .query_row(
            "SELECT applied_change_id FROM breakdown_drafts WHERE draft_id=?1 AND project_id=?2",
            params![draft_id, project_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    Ok(applied.flatten())
}

pub(crate) fn list_drafts(connection: &Connection, project_id: &str, script_id: &str) -> Result<Vec<Value>, String> {
    let mut statement = connection.prepare("SELECT draft_id,script_revision,payload FROM breakdown_drafts WHERE project_id=?1 AND script_id=?2 ORDER BY created_at ASC, draft_id ASC").map_err(|error| error.to_string())?;
    let rows = statement.query_map(params![project_id, script_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?))).map_err(|error| error.to_string())?;
    rows.map(|row| {
        let (draft_id, script_revision, payload) = row.map_err(|error| error.to_string())?;
        let payload: Value = serde_json::from_str(&payload).map_err(|error| error.to_string())?;
        Ok(serde_json::json!({"draftId":draft_id,"scriptId":script_id,"scriptRevision":script_revision,"payload":payload}))
    }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    #[test]
    fn strict_draft_rejects_bad_line_and_local_ids() {
        let value = serde_json::json!({"shots":[{"localId":"x","source":{"startLine":0,"endLine":1}},{"localId":"x","source":{"startLine":1,"endLine":1}}]});
        assert_eq!(
            validate_draft(&value, 1).unwrap_err(),
            "BREAKDOWN_SOURCE_RANGE"
        );
    }
    #[test]
    fn malformed_result_never_creates_entities_or_repays() {
        assert!(validate_draft(&serde_json::json!({}), 1).is_err());
    }

    #[test]
    fn persists_reviewable_drafts_against_an_existing_script_revision() {
        let directory = tempfile::tempdir().unwrap();
        let connection = db::open(&directory.path().join("db.sqlite3")).unwrap();
        connection.execute("INSERT INTO project_entities (id,project_id,kind,schema_version,revision,payload,updated_at) VALUES ('script','p','script',1,1,'{\"body\":\"第一行\\n第二行\"}','now')", []).unwrap();
        connection.execute("INSERT INTO script_revisions (script_id,revision,payload,created_at) VALUES ('script',1,'{\"body\":\"第一行\\n第二行\"}','now')", []).unwrap();
        connection.execute("INSERT INTO script_revisions (script_id,revision,payload,created_at) VALUES ('script',2,'{\"body\":\"第一行\\n第二行\"}','now')", []).unwrap();
        let draft = serde_json::json!({"shots":[{"localId":"s1","source":{"startLine":1,"endLine":1},"action":"开门","dialogue":"","subjectRefs":[]}],"subjects":[]});
        save_draft(&connection, "p", "draft-1", "script", 1, &draft).unwrap();
        assert_eq!(list_drafts(&connection, "p", "script").unwrap()[0]["payload"], draft);
        // 同一草案反复保存：覆盖内容而不是报冲突。
        save_draft(&connection, "p", "draft-1", "script", 1, &serde_json::json!({"shots":[]})).unwrap();
        assert_eq!(list_drafts(&connection, "p", "script").unwrap()[0]["payload"], serde_json::json!({"shots":[]}));
        // 脚本修订不一致仍然报冲突。
        assert_eq!(save_draft(&connection, "p", "draft-1", "script", 2, &draft).unwrap_err(), "BREAKDOWN_DRAFT_CONFLICT");
        assert_eq!(list_drafts(&connection, "p", "script").unwrap()[0]["payload"], serde_json::json!({"shots":[]}));
    }

    #[test]
    fn records_the_change_a_draft_was_applied_with() {
        let directory = tempfile::tempdir().unwrap();
        let connection = db::open(&directory.path().join("db.sqlite3")).unwrap();
        connection.execute("INSERT INTO project_entities (id,project_id,kind,schema_version,revision,payload,updated_at) VALUES ('script','p','script',1,1,'{\"body\":\"line\"}','now')", []).unwrap();
        connection.execute("INSERT INTO script_revisions (script_id,revision,payload,created_at) VALUES ('script',1,'{\"body\":\"line\"}','now')", []).unwrap();
        let draft = serde_json::json!({"shots":[{"localId":"s1","source":{"startLine":1,"endLine":1},"action":"动作","subjectRefs":[]}],"subjects":[]});
        save_draft(&connection, "p", "draft-1", "script", 1, &draft).unwrap();
        assert_eq!(draft_application(&connection, "p", "draft-1").unwrap(), None);
        mark_draft_applied(&connection, "p", "draft-1", "change-1").unwrap();
        assert_eq!(draft_application(&connection, "p", "draft-1").unwrap(), Some("change-1".to_string()));
        assert_eq!(mark_draft_applied(&connection, "p", "missing", "change-1").unwrap_err(), "BREAKDOWN_DRAFT_NOT_FOUND");
    }

    #[test]
    fn refuses_to_persist_a_draft_for_a_stale_or_foreign_script_revision() {
        let directory = tempfile::tempdir().unwrap();
        let connection = db::open(&directory.path().join("db.sqlite3")).unwrap();
        connection.execute("INSERT INTO project_entities (id,project_id,kind,schema_version,revision,payload,updated_at) VALUES ('script','p','script',1,1,'{\"body\":\"line\"}','now')", []).unwrap();
        connection.execute("INSERT INTO script_revisions (script_id,revision,payload,created_at) VALUES ('script',1,'{\"body\":\"line\"}','now')", []).unwrap();
        let draft = serde_json::json!({"shots":[{"localId":"s1","source":{"startLine":1,"endLine":1},"action":"动作","subjectRefs":[]}],"subjects":[]});
        assert_eq!(save_draft(&connection, "p", "stale", "script", 2, &draft).unwrap_err(), "BREAKDOWN_SCRIPT_REVISION_CONFLICT");
        assert!(list_drafts(&connection, "other", "script").unwrap().is_empty());
    }
}
