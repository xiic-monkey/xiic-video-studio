use super::types::ChangeResult;
use chrono::Utc;
use rusqlite::{params, Connection, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CommandError {
    #[error("PRODUCTION_REVISION_CONFLICT")]
    RevisionConflict,
    #[error("PRODUCTION_CHANGE_CONFLICT")]
    ChangeConflict,
    #[error("PRODUCTION_REFERENCE_INVALID")]
    InvalidReference,
    #[error("PRODUCTION_VALIDATION_FAILED")]
    ValidationFailed,
    #[error("DATABASE: {0}")]
    Database(String),
}

fn script_line_count(payload: &Value) -> i64 {
    payload
        .get("body")
        .and_then(Value::as_str)
        .map(|body| body.lines().count().max(1) as i64)
        .unwrap_or(1)
}

fn validate_breakdown_payload(payload: &Value, line_count: i64) -> Result<(), CommandError> {
    super::breakdown::validate_draft(payload, line_count).map_err(|_| CommandError::ValidationFailed)
}

fn merge_payload(current: &Value, patch: &Value) -> Result<Value, CommandError> {
    let current = current.as_object().ok_or(CommandError::InvalidReference)?;
    let patch = patch.as_object().ok_or(CommandError::InvalidReference)?;
    let merged = current
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .chain(patch.iter().map(|(key, value)| (key.clone(), value.clone())))
        .collect::<serde_json::Map<String, Value>>();
    Ok(Value::Object(merged))
}

fn entity_exists(
    transaction: &rusqlite::Transaction<'_>,
    project_id: &str,
    entity_id: &str,
    kind: &str,
) -> Result<bool, CommandError> {
    transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM project_entities WHERE id=?1 AND project_id=?2 AND kind=?3 AND archived_at IS NULL)",
            params![entity_id, project_id, kind],
            |row| row.get(0),
        )
        .map_err(|error| CommandError::Database(error.to_string()))
}

fn validate_entity_hierarchy(
    transaction: &rusqlite::Transaction<'_>,
    project_id: &str,
    kind: &str,
    payload: &Value,
) -> Result<(), CommandError> {
    let parent_id = |field: &str| payload.get(field).and_then(Value::as_str);
    if let Some(script_id) = parent_id("scriptId") {
        if !entity_exists(transaction, project_id, script_id, "script")? {
            return Err(CommandError::InvalidReference);
        }
    }
    match kind {
        "scene" => {
            let episode_id = parent_id("episodeId").ok_or(CommandError::InvalidReference)?;
            if !entity_exists(transaction, project_id, episode_id, "episode")? {
                return Err(CommandError::InvalidReference);
            }
        }
        "shot" => {
            let scene_id = parent_id("sceneId");
            let episode_id = parent_id("episodeId");
            if let Some(scene_id) = scene_id {
                if !entity_exists(transaction, project_id, scene_id, "scene")? {
                    return Err(CommandError::InvalidReference);
                }
                let scene_episode: Option<String> = transaction
                    .query_row(
                        "SELECT json_extract(payload, '$.episodeId') FROM project_entities WHERE id=?1 AND project_id=?2 AND kind='scene' AND archived_at IS NULL",
                        params![scene_id, project_id],
                        |row| row.get(0),
                    )
                    .map_err(|error| CommandError::Database(error.to_string()))?;
                if let (Some(shot_episode), Some(scene_episode)) = (episode_id, scene_episode.as_deref()) {
                    if shot_episode != scene_episode {
                        return Err(CommandError::InvalidReference);
                    }
                }
            }
            if let Some(episode_id) = episode_id {
                if !entity_exists(transaction, project_id, episode_id, "episode")? {
                    return Err(CommandError::InvalidReference);
                }
            }
        }
        "timeline" => {
            if let Some(episode_id) = parent_id("episodeId") {
                if !entity_exists(transaction, project_id, episode_id, "episode")? {
                    return Err(CommandError::InvalidReference);
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn canonical_json(value: &Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(map.iter().map(|(key, value)| (key.clone(), canonical_json(value))).collect()),
        Value::Array(items) => Value::Array(items.iter().map(canonical_json).collect()),
        other => other.clone(),
    }
}

fn canonical_hash(value: &Value) -> Result<String, CommandError> {
    let bytes = serde_json::to_vec(&canonical_json(value)).map_err(|error| CommandError::Database(error.to_string()))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn shot_spec_hash(payload: &Value) -> Result<String, CommandError> {
    let keys = ["title", "action", "dialogue", "durationMs", "aspectRatio", "emotionalBeat", "hook", "bindings", "previousTail", "genericReferenceIds"];
    let mut spec = serde_json::Map::new();
    for key in keys {
        if let Some(value) = payload.get(key) { spec.insert(key.to_string(), value.clone()); }
    }
    canonical_hash(&Value::Object(spec))
}

/// 时间线审批固定的剪辑内容快照哈希：只覆盖片段、音频轨与字幕，不含审批状态本身。
fn timeline_edit_hash(payload: &Value) -> Result<String, CommandError> {
    let keys = ["clips", "audioTracks", "subtitleCues"];
    let mut spec = serde_json::Map::new();
    for key in keys {
        if let Some(value) = payload.get(key) { spec.insert(key.to_string(), value.clone()); }
    }
    canonical_hash(&Value::Object(spec))
}

const REVIEW_STATES: [&str; 4] = ["draft", "review", "approved", "rejected"];
const SHOT_SLOTS: [&str; 5] = ["storyboard", "firstFrame", "lastFrame", "video", "dialogue"];

/// 制作审批状态机：只允许下面这些转移，目标状态与当前状态相同视为幂等。
fn review_transition_allowed(from: &str, to: &str) -> bool {
    if from == to { return true; }
    matches!(
        (from, to),
        ("draft", "review")
            | ("review", "approved") | ("review", "rejected") | ("review", "draft")
            | ("approved", "review") | ("approved", "draft")
            | ("rejected", "review") | ("rejected", "draft")
    )
}

fn asset_in_project(
    transaction: &rusqlite::Transaction<'_>,
    project_id: &str,
    asset_id: &str,
) -> Result<bool, CommandError> {
    transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM project_assets WHERE project_id=?1 AND asset_id=?2)",
            params![project_id, asset_id],
            |row| row.get(0),
        )
        .map_err(|error| CommandError::Database(error.to_string()))
}

fn subject_version_exists(
    transaction: &rusqlite::Transaction<'_>,
    subject_id: &str,
    ordinal: i64,
) -> Result<bool, CommandError> {
    transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM subject_versions WHERE subject_id=?1 AND ordinal=?2)",
            params![subject_id, ordinal],
            |row| row.get(0),
        )
        .map_err(|error| CommandError::Database(error.to_string()))
}

/// 载荷级引用校验：对所有操作生效（校验发生在合并之后），保证实体类型、项目归属、版本与素材都真实存在。
fn validate_payload_references(
    transaction: &rusqlite::Transaction<'_>,
    project_id: &str,
    kind: &str,
    entity_id: &str,
    payload: &Value,
) -> Result<(), CommandError> {
    if let Some(bindings) = payload.get("bindings").and_then(Value::as_array) {
        for binding in bindings {
            let subject_id = binding
                .get("subjectId")
                .and_then(Value::as_str)
                .ok_or(CommandError::InvalidReference)?;
            let ordinal = binding
                .get("version")
                .and_then(Value::as_i64)
                .ok_or(CommandError::InvalidReference)?;
            if !entity_exists(transaction, project_id, subject_id, "subject")? {
                return Err(CommandError::InvalidReference);
            }
            if ordinal < 1 || !subject_version_exists(transaction, subject_id, ordinal)? {
                return Err(CommandError::InvalidReference);
            }
        }
    }
    if let Some(selected) = payload.get("selected").and_then(Value::as_object) {
        for slot in SHOT_SLOTS {
            let Some(entry) = selected.get(slot) else { continue; };
            if entry.is_null() { continue; }
            let asset_id = entry
                .get("assetId")
                .and_then(Value::as_str)
                .ok_or(CommandError::InvalidReference)?;
            if !asset_in_project(transaction, project_id, asset_id)? {
                return Err(CommandError::InvalidReference);
            }
        }
    }
    if let Some(references) = payload.get("genericReferenceIds").and_then(Value::as_array) {
        for reference in references {
            let asset_id = reference.as_str().ok_or(CommandError::InvalidReference)?;
            if !asset_in_project(transaction, project_id, asset_id)? {
                return Err(CommandError::InvalidReference);
            }
        }
    }
    for field in ["firstFrameId", "lastFrameId"] {
        let Some(asset_id) = payload.get(field).and_then(Value::as_str) else { continue; };
        if !asset_in_project(transaction, project_id, asset_id)? {
            return Err(CommandError::InvalidReference);
        }
    }
    if kind == "subject" {
        if let Some(current) = payload.get("currentVersion") {
            let ordinal = current.as_i64().ok_or(CommandError::InvalidReference)?;
            if ordinal < 1 || !subject_version_exists(transaction, entity_id, ordinal)? {
                return Err(CommandError::InvalidReference);
            }
        }
    }
    Ok(())
}

/// 内容改动后把审批打回 draft，并保留上一次审批快照。
fn enforce_review_after_change(kind: &str, payload: &mut Value) -> Result<(), CommandError> {
    let state = payload
        .get("review")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if !matches!(state.as_str(), "approved" | "rejected") {
        return Ok(());
    }
    let (recorded, current) = match kind {
        "shot" => (
            payload.get("approvedSpecHash").and_then(Value::as_str).map(str::to_string),
            shot_spec_hash(payload)?,
        ),
        "timeline" => (
            payload.get("approvedEditHash").and_then(Value::as_str).map(str::to_string),
            timeline_edit_hash(payload)?,
        ),
        _ => return Ok(()),
    };
    if recorded.as_deref() == Some(current.as_str()) {
        return Ok(());
    }
    payload["previousReview"] = json!({
        "state": state,
        "specHash": recorded.unwrap_or_else(|| current.clone()),
        "at": Utc::now().to_rfc3339(),
    });
    payload["review"] = Value::String("draft".into());
    Ok(())
}

pub fn apply_production_change(
    connection: &mut Connection,
    project_id: &str,
    change_id: &str,
    expected_revisions: &HashMap<String, i64>,
    operations: &[Value],
) -> Result<ChangeResult, CommandError> {
    let hash = {
        let mut h = Sha256::new();
        let revisions = expected_revisions.iter().collect::<BTreeMap<_, _>>();
        h.update(serde_json::to_vec(&(project_id, revisions, operations)).map_err(|e| CommandError::Database(e.to_string()))?);
        hex::encode(h.finalize())
    };
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| CommandError::Database(e.to_string()))?;
    if let Ok((existing_project, existing)) = tx.query_row(
        "SELECT project_id,payload FROM production_changes WHERE change_id=?1",
        [change_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
    ) {
        if existing_project != project_id {
            return Err(CommandError::ChangeConflict);
        }
        let value: Value =
            serde_json::from_str(&existing).map_err(|e| CommandError::Database(e.to_string()))?;
        if value["hash"] == hash {
            return serde_json::from_value(value["result"].clone())
                .map_err(|e| CommandError::Database(e.to_string()));
        }
        return Err(CommandError::ChangeConflict);
    }
    // 拆镜草案幂等：草案已应用过就直接返回那次变更的结果，不再重复创建实体。
    let mut applied_drafts: Vec<String> = Vec::new();
    for operation in operations {
        if operation.get("op").and_then(Value::as_str) != Some("applyBreakdown") {
            continue;
        }
        let Some(draft_id) = operation["payload"]["draftId"].as_str() else { continue; };
        let script_id = operation["payload"]["scriptId"].as_str().ok_or(CommandError::InvalidReference)?;
        let script_revision = operation["payload"]["scriptRevision"].as_i64().ok_or(CommandError::InvalidReference)?;
        let draft: Option<(String, String, i64)> = tx
            .query_row(
                "SELECT project_id,script_id,script_revision FROM breakdown_drafts WHERE draft_id=?1",
                [draft_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .ok();
        let (draft_project, draft_script, draft_revision) = draft.ok_or(CommandError::InvalidReference)?;
        if draft_project != project_id || draft_script != script_id || draft_revision != script_revision {
            return Err(CommandError::InvalidReference);
        }
        let applied = super::breakdown::draft_application(&tx, project_id, draft_id)
            .map_err(|error| CommandError::Database(error))?;
        if let Some(applied_change_id) = applied {
            let stored: Option<(String, String)> = tx
                .query_row(
                    "SELECT project_id,payload FROM production_changes WHERE change_id=?1",
                    [&applied_change_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .ok();
            let (stored_project, stored_payload) = stored.ok_or(CommandError::ChangeConflict)?;
            if stored_project != project_id {
                return Err(CommandError::ChangeConflict);
            }
            let stored_value: Value =
                serde_json::from_str(&stored_payload).map_err(|_| CommandError::ChangeConflict)?;
            if stored_value["result"].is_null() {
                return Err(CommandError::ChangeConflict);
            }
            return serde_json::from_value(stored_value["result"].clone())
                .map_err(|_| CommandError::ChangeConflict);
        }
        if !applied_drafts.iter().any(|value| value == draft_id) {
            applied_drafts.push(draft_id.to_string());
        }
    }
    for (id, expected) in expected_revisions {
        let row: Option<(i64, Option<String>)> = tx
            .query_row(
                "SELECT revision,archived_at FROM project_entities WHERE id=?1 AND project_id=?2",
                params![id, project_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();
        match row {
            Some((_, Some(_))) => {
                // 归档实体不再接受写入，避免写入成功但内容静默丢失。
                return Err(CommandError::ChangeConflict);
            }
            Some((revision, None)) => {
                if *expected == 0 || revision != *expected {
                    return Err(CommandError::RevisionConflict);
                }
            }
            None => {
                if *expected != 0 {
                    return Err(CommandError::RevisionConflict);
                }
            }
        }
    }
    let mut revision_map = HashMap::new();
    let mut affected = Vec::new();
    let mut operation_ids = HashSet::new();
    let mut before_payloads = serde_json::Map::new();
    let mut after_payloads = serde_json::Map::new();
    for operation in operations {
        let id = operation["id"]
            .as_str()
            .ok_or(CommandError::InvalidReference)?;
        if !operation_ids.insert(id) { return Err(CommandError::InvalidReference); }
        let kind = operation["kind"]
            .as_str()
            .ok_or(CommandError::InvalidReference)?;
        if !["script", "episode", "scene", "shot", "subject", "timeline"].contains(&kind) {
            return Err(CommandError::InvalidReference);
        }
        let op = operation.get("op").and_then(Value::as_str).unwrap_or("upsertEntity");
        if !["upsertEntity", "deleteEntity", "applyBreakdown", "createSubjectVersion", "setShotBindings", "attachPreviousLastFrame", "adoptShotMedia", "recordProductionReview", "assembleEpisode", "replaceTimelineClip", "commitTimelineEdit", "revertProductionChange"].contains(&op) {
            return Err(CommandError::InvalidReference);
        }
        let mut payload = match operation.get("payload") {
            Some(value) if value.is_object() => value.clone(),
            // deleteEntity 只需要实体 id，载荷可为空对象或缺省。
            Some(value) if op == "deleteEntity" && value.is_null() => json!({}),
            None if op == "deleteEntity" => json!({}),
            _ => return Err(CommandError::InvalidReference),
        };
        let owner: Option<(String, String, Option<String>)> = tx
            .query_row("SELECT project_id,kind,archived_at FROM project_entities WHERE id=?1", [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .ok();
        if !expected_revisions.contains_key(id) {
            return Err(CommandError::InvalidReference);
        }
        if owner.as_ref().is_some_and(|(owner_project, owner_kind, _)| owner_project != project_id || owner_kind != kind) {
            return Err(CommandError::InvalidReference);
        }
        if owner.as_ref().is_some_and(|(_, _, archived)| archived.is_some()) {
            // 已归档实体不接受写入。
            return Err(CommandError::ChangeConflict);
        }
        let current_payload: Option<String> = tx.query_row("SELECT payload FROM project_entities WHERE id=?1 AND project_id=?2", params![id, project_id], |row| row.get(0)).ok();
        if op == "revertProductionChange" {
            let archived: bool = tx.query_row("SELECT archived_at IS NOT NULL FROM project_entities WHERE id=?1 AND project_id=?2", params![id, project_id], |row| row.get(0)).map_err(|_| CommandError::ChangeConflict)?;
            if archived { return Err(CommandError::ChangeConflict); }
            let target_id = operation["payload"]["targetChangeId"].as_str().ok_or(CommandError::InvalidReference)?;
            let target_project: String = tx.query_row("SELECT project_id FROM production_changes WHERE change_id=?1", [target_id], |row| row.get(0)).map_err(|_| CommandError::ChangeConflict)?;
            if target_project != project_id { return Err(CommandError::ChangeConflict); }
            let target_payload: String = tx.query_row("SELECT payload FROM production_changes WHERE change_id=?1", [target_id], |row| row.get(0)).map_err(|_| CommandError::ChangeConflict)?;
            let target: Value = serde_json::from_str(&target_payload).map_err(|_| CommandError::ChangeConflict)?;
            let before = target["before"].get(id).cloned().ok_or(CommandError::ChangeConflict)?;
            let after = target["after"].get(id).cloned().ok_or(CommandError::ChangeConflict)?;
            let current = current_payload.as_deref().and_then(|value| serde_json::from_str::<Value>(value).ok()).ok_or(CommandError::ChangeConflict)?;
            if current != after { return Err(CommandError::ChangeConflict); }
            payload = before;
        } else if matches!(op, "adoptShotMedia" | "recordProductionReview" | "setShotBindings" | "attachPreviousLastFrame" | "replaceTimelineClip" | "commitTimelineEdit") {
            if let Some(current) = current_payload.as_deref().and_then(|value| serde_json::from_str::<Value>(value).ok()) {
                payload = merge_payload(&current, &payload)?;
            } else {
                return Err(CommandError::InvalidReference);
            }
        }
        before_payloads.insert(id.to_string(), current_payload.as_deref().and_then(|value| serde_json::from_str::<Value>(value).ok()).unwrap_or(Value::Null));
        if op == "revertProductionChange" && payload.is_null() {
            let now = Utc::now().to_rfc3339();
            tx.execute("UPDATE project_entities SET archived_at=?1, updated_at=?1, revision=revision+1 WHERE id=?2 AND project_id=?3", params![now, id, project_id]).map_err(|error| CommandError::Database(error.to_string()))?;
            after_payloads.insert(id.to_string(), Value::Null);
            let revision: i64 = tx.query_row("SELECT revision FROM project_entities WHERE id=?1 AND project_id=?2", params![id, project_id], |row| row.get(0)).map_err(|error| CommandError::Database(error.to_string()))?;
            revision_map.insert(id.to_string(), revision);
            affected.push(id.to_string());
            continue;
        }
        if op == "deleteEntity" {
            // 软删除：只归档不删行，和 revertProductionChange 的归档路径保持一致，历史变更仍可追溯。
            if owner.is_none() { return Err(CommandError::InvalidReference); }
            let now = Utc::now().to_rfc3339();
            tx.execute("UPDATE project_entities SET archived_at=?1, updated_at=?1, revision=revision+1 WHERE id=?2 AND project_id=?3", params![now, id, project_id]).map_err(|error| CommandError::Database(error.to_string()))?;
            after_payloads.insert(id.to_string(), Value::Null);
            let revision: i64 = tx.query_row("SELECT revision FROM project_entities WHERE id=?1 AND project_id=?2", params![id, project_id], |row| row.get(0)).map_err(|error| CommandError::Database(error.to_string()))?;
            revision_map.insert(id.to_string(), revision);
            affected.push(id.to_string());
            continue;
        }
        if op == "applyBreakdown" {
            if kind != "shot" { return Err(CommandError::InvalidReference); }
            let script_id = payload["scriptId"].as_str().ok_or(CommandError::InvalidReference)?;
            let script_revision = payload["scriptRevision"].as_i64().ok_or(CommandError::InvalidReference)?;
            let (actual_revision, script_payload): (i64, String) = tx.query_row(
                "SELECT revision,payload FROM project_entities WHERE id=?1 AND project_id=?2 AND kind='script' AND archived_at IS NULL",
                params![script_id, project_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).map_err(|_| CommandError::InvalidReference)?;
            if actual_revision != script_revision { return Err(CommandError::RevisionConflict); }
            let script: Value = serde_json::from_str(&script_payload).map_err(|_| CommandError::InvalidReference)?;
            validate_breakdown_payload(&json!({"shots":[payload.clone()]}), script_line_count(&script))?;
            if payload.get("review").and_then(Value::as_str).is_none() {
                payload["review"] = Value::String("draft".into());
            }
            payload["selected"] = payload.get("selected").cloned().unwrap_or_else(|| json!({}));
        }
        if op == "setShotBindings" {
            if kind != "shot" || !payload.get("bindings").is_some_and(Value::is_array) { return Err(CommandError::InvalidReference); }
            for binding in payload["bindings"].as_array().into_iter().flatten() {
                let subject_id = binding["subjectId"].as_str().ok_or(CommandError::InvalidReference)?;
                let belongs: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM project_entities WHERE id=?1 AND project_id=?2 AND kind='subject' AND archived_at IS NULL)", params![subject_id, project_id], |row| row.get(0)).map_err(|error| CommandError::Database(error.to_string()))?;
                let ordinal = binding["version"].as_i64().unwrap_or(0);
                let version_exists: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM subject_versions WHERE subject_id=?1 AND ordinal=?2)", params![subject_id, ordinal], |row| row.get(0)).map_err(|error| CommandError::Database(error.to_string()))?;
                if !belongs || ordinal < 1 || !version_exists { return Err(CommandError::InvalidReference); }
            }
        }
        if op == "adoptShotMedia" {
            if kind != "shot" { return Err(CommandError::InvalidReference); }
            let slot = operation["payload"]["slot"].as_str().filter(|value| ["storyboard", "firstFrame", "lastFrame", "video", "dialogue"].contains(value)).ok_or(CommandError::InvalidReference)?;
            let asset_id = operation["payload"]["assetId"].as_str().ok_or(CommandError::InvalidReference)?;
            let member: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM project_assets WHERE project_id=?1 AND asset_id=?2)", params![project_id, asset_id], |row| row.get(0)).map_err(|error| CommandError::Database(error.to_string()))?;
            if !member { return Err(CommandError::InvalidReference); }
            let spec_hash = shot_spec_hash(&payload)?;
            if operation["payload"]["specHash"].as_str() != Some(spec_hash.as_str()) { return Err(CommandError::ValidationFailed); }
            let adoption_id = format!("adopt_{}", hex::encode(Sha256::digest(format!("{change_id}:{id}:{slot}").as_bytes())));
            let adopted = serde_json::json!({"adoptionId":adoption_id,"assetId":asset_id,"specHash":spec_hash,"adoptedAt":Utc::now().to_rfc3339()});
            payload["selected"][slot] = adopted.clone();
            tx.execute("INSERT OR IGNORE INTO shot_adoptions (adoption_id,shot_id,slot,payload,adopted_at) VALUES (?1,?2,?3,?4,?5)", params![adoption_id,id,slot,adopted.to_string(),Utc::now().to_rfc3339()]).map_err(|error| CommandError::Database(error.to_string()))?;
        }
        if op == "recordProductionReview" {
            if !matches!(kind, "shot" | "timeline") { return Err(CommandError::InvalidReference); }
            let state = operation["payload"]["state"].as_str().ok_or(CommandError::ValidationFailed)?;
            if !REVIEW_STATES.contains(&state) { return Err(CommandError::ValidationFailed); }
            let current_state = payload.get("review").and_then(Value::as_str).unwrap_or("draft").to_string();
            if !review_transition_allowed(&current_state, state) { return Err(CommandError::ValidationFailed); }
            let declared_hash = operation["payload"]["approvedSpecHash"].as_str().or_else(|| operation["payload"]["specHash"].as_str());
            if kind == "shot" {
                let current_spec = current_payload.as_deref().and_then(|value| serde_json::from_str::<Value>(value).ok()).ok_or(CommandError::ValidationFailed)?;
                let current_hash = shot_spec_hash(&current_spec)?;
                if state == "approved" {
                    let adoption_id = operation["payload"]["adoptionId"].as_str().ok_or(CommandError::ValidationFailed)?;
                    let spec_hash = operation["payload"]["specHash"].as_str().ok_or(CommandError::ValidationFailed)?;
                    let selected = current_spec["selected"]["video"].as_object().cloned().ok_or(CommandError::ValidationFailed)?;
                    if selected.get("adoptionId").and_then(Value::as_str) != Some(adoption_id) || selected.get("specHash").and_then(Value::as_str) != Some(spec_hash) || current_hash != spec_hash {
                        return Err(CommandError::ValidationFailed);
                    }
                }
                if state == "approved" || state == "rejected" {
                    // 审批必须绑定到具体规格快照。
                    let declared = declared_hash.ok_or(CommandError::ValidationFailed)?;
                    if declared != current_hash { return Err(CommandError::ValidationFailed); }
                    payload["approvedSpecHash"] = Value::String(current_hash);
                }
            } else if state == "approved" || state == "rejected" {
                // 时间线审批固定到剪辑内容快照。
                let edit_hash = operation["payload"]["editHash"].as_str().ok_or(CommandError::ValidationFailed)?;
                let current_edit_hash = timeline_edit_hash(&payload)?;
                if edit_hash != current_edit_hash { return Err(CommandError::ValidationFailed); }
                payload["approvedEditHash"] = Value::String(current_edit_hash);
            }
            let review_id = format!("review_{}", hex::encode(Sha256::digest(format!("{change_id}:{id}").as_bytes())));
            payload["review"] = Value::String(state.to_string());
            tx.execute("INSERT OR IGNORE INTO production_reviews (review_id,project_id,payload,created_at) VALUES (?1,?2,?3,?4)", params![review_id,project_id,operation["payload"].to_string(),Utc::now().to_rfc3339()]).map_err(|error| CommandError::Database(error.to_string()))?;
        }
        if op == "assembleEpisode" {
            if kind != "episode" { return Err(CommandError::InvalidReference); }
            let required = operation["payload"]["requiredShotIds"].as_array().ok_or(CommandError::ValidationFailed)?;
            let mut frozen = Vec::new();
            for shot_id in required.iter().filter_map(Value::as_str) {
                let shot_payload: String = tx.query_row("SELECT payload FROM project_entities WHERE id=?1 AND project_id=?2 AND kind='shot' AND archived_at IS NULL", params![shot_id, project_id], |row| row.get(0)).map_err(|_| CommandError::ValidationFailed)?;
                let shot: Value = serde_json::from_str(&shot_payload).map_err(|_| CommandError::ValidationFailed)?;
                let asset_id = shot["selected"]["video"]["assetId"].as_str().ok_or(CommandError::ValidationFailed)?;
                let belongs: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM project_assets WHERE project_id=?1 AND asset_id=?2)", params![project_id, asset_id], |row| row.get(0)).map_err(|error| CommandError::Database(error.to_string()))?;
                if !belongs { return Err(CommandError::ValidationFailed); }
                frozen.push(json!({"shotId":shot_id,"assetId":asset_id,"specHash":shot["selected"]["video"]["specHash"]}));
            }
            payload["frozenShots"] = Value::Array(frozen);
            payload["assembledAt"] = Value::String(Utc::now().to_rfc3339());
        }
        if op == "replaceTimelineClip" {
            if kind != "timeline" { return Err(CommandError::InvalidReference); }
            let asset_id = payload["assetId"].as_str().ok_or(CommandError::InvalidReference)?;
            let belongs: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM project_assets WHERE project_id=?1 AND asset_id=?2)", params![project_id, asset_id], |row| row.get(0)).map_err(|error| CommandError::Database(error.to_string()))?;
            if !belongs { return Err(CommandError::InvalidReference); }
            let duration_seconds: f64 = tx.query_row("SELECT duration FROM assets WHERE id=?1", [asset_id], |row| row.get(0)).map_err(|_| CommandError::InvalidReference)?;
            let mut timeline = current_payload.as_deref().and_then(|value| serde_json::from_str::<Value>(value).ok()).ok_or(CommandError::InvalidReference)?;
            let clip_id = payload["clipId"].as_str().ok_or(CommandError::InvalidReference)?;
            let clips = timeline["clips"].as_array_mut().ok_or(CommandError::InvalidReference)?;
            let clip = clips.iter_mut().find(|clip| clip["id"].as_str() == Some(clip_id)).ok_or(CommandError::InvalidReference)?;
            let old_duration = clip["sourceOutTicks"].as_i64().unwrap_or(0) - clip["sourceInTicks"].as_i64().unwrap_or(0);
            let source_in = payload["sourceInTicks"].as_i64().ok_or(CommandError::InvalidReference)?;
            let source_out = payload["sourceOutTicks"].as_i64().ok_or(CommandError::InvalidReference)?;
            let new_duration = source_out - source_in;
            if new_duration < old_duration && payload["acknowledgeShorter"] != true { return Err(CommandError::ValidationFailed); }
            let max_ticks = (duration_seconds.max(0.0) * 240_000.0).round() as i64;
            if source_in < 0 || source_out <= source_in || source_out > max_ticks { return Err(CommandError::InvalidReference); }
            clip["assetId"] = Value::String(asset_id.to_string());
            clip["sourceInTicks"] = Value::from(source_in);
            clip["sourceOutTicks"] = Value::from(source_out);
            timeline["revision"] = Value::from(timeline["revision"].as_i64().unwrap_or(0) + 1);
            payload = timeline;
        }
        if op == "createSubjectVersion" {
            if kind != "subject" { return Err(CommandError::InvalidReference); }
            let version = operation.get("payload").and_then(|value| value.get("version")).ok_or(CommandError::InvalidReference)?;
            let ordinal = version["ordinal"].as_i64().ok_or(CommandError::InvalidReference)?;
            if ordinal < 1 { return Err(CommandError::InvalidReference); }
            let descriptor = version["descriptor"].as_str().ok_or(CommandError::InvalidReference)?.to_string();
            let references = version["references"].as_array().cloned().unwrap_or_default();
            for reference in &references {
                let asset_id = reference["assetId"].as_str().ok_or(CommandError::InvalidReference)?;
                let belongs: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM project_assets WHERE project_id=?1 AND asset_id=?2)", params![project_id, asset_id], |row| row.get(0)).map_err(|error| CommandError::Database(error.to_string()))?;
                if !belongs { return Err(CommandError::InvalidReference); }
            }
            let subject_version = super::subjects::SubjectVersion { subject_id: id.to_string(), ordinal, descriptor, references };
            tx.execute("INSERT INTO subject_versions (subject_id,ordinal,payload,created_at) VALUES (?1,?2,?3,?4)", params![subject_version.subject_id, subject_version.ordinal, serde_json::to_string(&subject_version).map_err(|error| CommandError::Database(error.to_string()))?, Utc::now().to_rfc3339()]).map_err(|error| if error.to_string().contains("UNIQUE") { CommandError::InvalidReference } else { CommandError::Database(error.to_string()) })?;
            payload["currentVersion"] = Value::from(ordinal);
        }
        validate_payload_references(&tx, project_id, kind, id, &payload)?;
        if op != "recordProductionReview" && op != "revertProductionChange" {
            enforce_review_after_change(kind, &mut payload)?;
        }
        validate_entity_hierarchy(&tx, project_id, kind, &payload)?;
        if kind == "timeline" {
            let asset_ids = payload["clips"]
                .as_array()
                .into_iter()
                .flatten()
                .chain(payload["audioTracks"].as_array().into_iter().flatten())
                .filter_map(|item| item["assetId"].as_str())
                .collect::<HashSet<_>>();
            for asset_id in asset_ids {
                let belongs: bool = tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM project_assets WHERE project_id=?1 AND asset_id=?2)",
                        params![project_id, asset_id],
                        |row| row.get(0),
                    )
                    .map_err(|error| CommandError::Database(error.to_string()))?;
                if !belongs {
                    return Err(CommandError::InvalidReference);
                }
            }
        }
        let revision = expected_revisions.get(id).copied().unwrap_or(0) + 1;
        tx.execute("INSERT INTO project_entities (id,project_id,kind,schema_version,revision,payload,updated_at) VALUES (?1,?2,?3,1,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET revision=?4,payload=?5,updated_at=?6", params![id,project_id,kind,revision,serde_json::to_string(&payload).map_err(|e| CommandError::Database(e.to_string()))?,Utc::now().to_rfc3339()]).map_err(|e| CommandError::Database(e.to_string()))?;
        after_payloads.insert(id.to_string(), payload.clone());
        if kind == "script" {
            tx.execute("INSERT INTO script_revisions (script_id,revision,payload,created_at) VALUES (?1,?2,?3,?4) ON CONFLICT(script_id,revision) DO NOTHING", params![id, revision, serde_json::to_string(&payload).map_err(|e| CommandError::Database(e.to_string()))?, Utc::now().to_rfc3339()]).map_err(|error| CommandError::Database(error.to_string()))?;
        }
        revision_map.insert(id.to_string(), revision);
        affected.push(id.to_string());
    }
    let result = ChangeResult {
        change_id: change_id.to_string(),
        revision_map,
        affected_ids: affected,
    };
    let change_log = serde_json::json!({"hash":hash,"result":result,"before":before_payloads,"after":after_payloads});
    tx.execute("INSERT INTO production_changes (change_id,project_id,payload,created_at) VALUES (?1,?2,?3,?4)", params![change_id, project_id, change_log.to_string(), Utc::now().to_rfc3339()]).map_err(|e| CommandError::Database(e.to_string()))?;
    for draft_id in &applied_drafts {
        super::breakdown::mark_draft_applied(&tx, project_id, draft_id, change_id)
            .map_err(|error| CommandError::Database(error))?;
    }
    tx.commit()
        .map_err(|e| CommandError::Database(e.to_string()))?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    #[test]
    fn rolls_back_all_changes_on_bad_reference() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = db::open(&dir.path().join("db.sqlite3")).unwrap();
        let operations = vec![
            serde_json::json!({"id":"s1","kind":"shot","payload":{}}),
            serde_json::json!({"kind":"shot"}),
        ];
        assert_eq!(
            apply_production_change(&mut c, "p", "c1", &HashMap::new(), &operations).unwrap_err(),
            CommandError::InvalidReference
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM project_entities", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn idempotent_same_id_but_different_payload_is_conflict() {
        let dir = tempfile::tempdir().unwrap();
        let mut c = db::open(&dir.path().join("db.sqlite3")).unwrap();
        let op = vec![serde_json::json!({"id":"s1","kind":"shot","payload":{"v":1}})];
        apply_production_change(&mut c, "p", "c1", &HashMap::from([("s1".to_string(), 0)]), &op).unwrap();
        let other = vec![serde_json::json!({"id":"s1","kind":"shot","payload":{"v":2}})];
        assert_eq!(
            apply_production_change(&mut c, "p", "c1", &HashMap::new(), &other).unwrap_err(),
            CommandError::ChangeConflict
        );
    }

    #[test]
    fn refuses_to_rewrite_an_entity_owned_by_another_project() {
        let dir = tempfile::tempdir().unwrap();
        let mut connection = db::open(&dir.path().join("db.sqlite3")).unwrap();
        let op = vec![serde_json::json!({"id":"shared-id","kind":"shot","payload":{"value":1}})];
        apply_production_change(&mut connection, "p1", "c1", &HashMap::from([("shared-id".to_string(), 0)]), &op).unwrap();
        let other = vec![serde_json::json!({"id":"shared-id","kind":"shot","payload":{"value":2}})];
        assert_eq!(
            apply_production_change(&mut connection, "p2", "c2", &HashMap::from([("shared-id".to_string(), 0)]), &other).unwrap_err(),
            CommandError::InvalidReference
        );
        let payload: String = connection.query_row("SELECT payload FROM project_entities WHERE id='shared-id' AND project_id='p1'", [], |row| row.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&payload).unwrap()["value"], 1);
    }

    #[test]
    fn rejects_scene_with_a_foreign_episode() {
        let dir = tempfile::tempdir().unwrap();
        let mut connection = db::open(&dir.path().join("db.sqlite3")).unwrap();
        apply_production_change(
            &mut connection,
            "p2",
            "episode-p2",
            &HashMap::from([("episode".to_string(), 0)]),
            &[serde_json::json!({"id":"episode","kind":"episode","payload":{"title":"外部集","order":1}})],
        ).unwrap();
        let result = apply_production_change(
            &mut connection,
            "p1",
            "scene-p1",
            &HashMap::from([("scene".to_string(), 0)]),
            &[serde_json::json!({"id":"scene","kind":"scene","payload":{"episodeId":"episode","heading":"场"}})],
        );
        assert_eq!(result.unwrap_err(), CommandError::InvalidReference);
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM project_entities WHERE project_id='p1'", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    }

    #[test]
    fn accepts_episode_scene_shot_hierarchy_in_one_transaction() {
        let dir = tempfile::tempdir().unwrap();
        let mut connection = db::open(&dir.path().join("db.sqlite3")).unwrap();
        let operations = vec![
            serde_json::json!({"id":"episode","kind":"episode","payload":{"title":"第一集","order":1}}),
            serde_json::json!({"id":"scene","kind":"scene","payload":{"episodeId":"episode","heading":"室内","order":1}}),
            serde_json::json!({"id":"shot","kind":"shot","payload":{"episodeId":"episode","sceneId":"scene","title":"开门","order":1}}),
        ];
        apply_production_change(
            &mut connection,
            "p1",
            "hierarchy",
            &HashMap::from([("episode".to_string(), 0), ("scene".to_string(), 0), ("shot".to_string(), 0)]),
            &operations,
        ).unwrap();
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM project_entities WHERE project_id='p1'", [], |row| row.get::<_, i64>(0)).unwrap(), 3);
    }

    #[test]
    fn rejects_shot_when_scene_belongs_to_a_different_episode() {
        let dir = tempfile::tempdir().unwrap();
        let mut connection = db::open(&dir.path().join("db.sqlite3")).unwrap();
        let operations = vec![
            serde_json::json!({"id":"episode-a","kind":"episode","payload":{"title":"A","order":1}}),
            serde_json::json!({"id":"episode-b","kind":"episode","payload":{"title":"B","order":2}}),
            serde_json::json!({"id":"scene","kind":"scene","payload":{"episodeId":"episode-a","heading":"场"}}),
        ];
        apply_production_change(
            &mut connection,
            "p1",
            "parents",
            &HashMap::from([("episode-a".to_string(), 0), ("episode-b".to_string(), 0), ("scene".to_string(), 0)]),
            &operations,
        ).unwrap();
        let result = apply_production_change(
            &mut connection,
            "p1",
            "bad-shot-parent",
            &HashMap::from([("shot".to_string(), 0)]),
            &[serde_json::json!({"id":"shot","kind":"shot","payload":{"episodeId":"episode-b","sceneId":"scene","title":"错误归属"}})],
        );
        assert_eq!(result.unwrap_err(), CommandError::InvalidReference);
    }

    #[test]
    fn update_requires_an_explicit_expected_revision() {
        let dir = tempfile::tempdir().unwrap();
        let mut connection = db::open(&dir.path().join("db.sqlite3")).unwrap();
        let create = vec![serde_json::json!({"id":"s","kind":"shot","payload":{"value":1}})];
        apply_production_change(&mut connection, "p", "create", &HashMap::from([("s".into(), 0)]), &create).unwrap();
        let update = vec![serde_json::json!({"id":"s","kind":"shot","payload":{"value":2}})];
        assert_eq!(apply_production_change(&mut connection, "p", "update", &HashMap::new(), &update).unwrap_err(), CommandError::InvalidReference);
    }

    #[test]
    fn same_change_id_cannot_replay_another_projects_response() {
        let dir = tempfile::tempdir().unwrap();
        let mut connection = db::open(&dir.path().join("db.sqlite3")).unwrap();
        let op = vec![serde_json::json!({"id":"s","kind":"shot","payload":{"value":1}})];
        apply_production_change(&mut connection, "p1", "change", &HashMap::from([("s".into(), 0)]), &op).unwrap();
        assert_eq!(apply_production_change(&mut connection, "p2", "change", &HashMap::from([("s2".into(), 0)]), &op).unwrap_err(), CommandError::ChangeConflict);
    }

    #[test]
    fn applies_valid_breakdown_to_new_shot_entities_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let mut connection = db::open(&dir.path().join("db.sqlite3")).unwrap();
        let script = vec![serde_json::json!({"id":"script","kind":"script","payload":{"body":"A\nB"}})];
        apply_production_change(&mut connection, "p", "script-create", &HashMap::from([("script".into(), 0)]), &script).unwrap();
        let operations = vec![serde_json::json!({
            "id":"shot-1","kind":"shot","op":"applyBreakdown",
            "payload":{"scriptId":"script","scriptRevision":1,"localId":"shot-local-1","source":{"startLine":1,"endLine":2},"action":"人物走入房间","dialogue":"你好","order":1}
        })];
        let result = apply_production_change(&mut connection, "p", "breakdown-apply", &HashMap::from([("script".into(), 1), ("shot-1".into(), 0)]), &operations).unwrap();
        assert_eq!(result.affected_ids, vec!["shot-1"]);
        let payload: String = connection.query_row("SELECT payload FROM project_entities WHERE id='shot-1'", [], |row| row.get(0)).unwrap();
        let payload: Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(payload["source"]["startLine"], 1);
        assert_eq!(payload["action"], "人物走入房间");
    }

    #[test]
    fn breakdown_rejects_changed_script_revision_without_partial_entities() {
        let dir = tempfile::tempdir().unwrap();
        let mut connection = db::open(&dir.path().join("db.sqlite3")).unwrap();
        let script = vec![serde_json::json!({"id":"script","kind":"script","payload":{"body":"A\nB"}})];
        apply_production_change(&mut connection, "p", "script-create", &HashMap::from([("script".into(), 0)]), &script).unwrap();
        let operations = vec![serde_json::json!({"id":"shot-1","kind":"shot","op":"applyBreakdown","payload":{"scriptId":"script","scriptRevision":0,"localId":"local","source":{"startLine":1,"endLine":1},"action":"walk"}})];
        assert_eq!(apply_production_change(&mut connection, "p", "stale-breakdown", &HashMap::from([("script".into(), 1), ("shot-1".into(), 0)]), &operations).unwrap_err(), CommandError::RevisionConflict);
        let count: i64 = connection.query_row("SELECT COUNT(*) FROM project_entities WHERE kind='shot'", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn persists_script_revision_snapshots_and_rejects_kind_reassignment() {
        let dir = tempfile::tempdir().unwrap();
        let mut connection = db::open(&dir.path().join("db.sqlite3")).unwrap();
        let create = vec![serde_json::json!({"id":"script","kind":"script","payload":{"body":"first"}})];
        apply_production_change(&mut connection, "p", "script-v1", &HashMap::from([("script".into(), 0)]), &create).unwrap();
        let update = vec![serde_json::json!({"id":"script","kind":"script","payload":{"body":"second"}})];
        apply_production_change(&mut connection, "p", "script-v2", &HashMap::from([("script".into(), 1)]), &update).unwrap();
        let revisions: i64 = connection.query_row("SELECT COUNT(*) FROM script_revisions WHERE script_id='script'", [], |row| row.get(0)).unwrap();
        assert_eq!(revisions, 2);
        let wrong_kind = vec![serde_json::json!({"id":"script","kind":"shot","payload":{}})];
        assert_eq!(apply_production_change(&mut connection, "p", "kind-change", &HashMap::from([("script".into(), 2)]), &wrong_kind).unwrap_err(), CommandError::InvalidReference);
    }

    #[test]
    fn undo_restores_previous_snapshot_and_rejects_later_adjustment() {
        let dir = tempfile::tempdir().unwrap();
        let mut connection = db::open(&dir.path().join("db.sqlite3")).unwrap();
        let create = vec![serde_json::json!({"id":"shot","kind":"shot","payload":{"action":"old"}})];
        apply_production_change(&mut connection, "p", "create", &HashMap::from([("shot".into(), 0)]), &create).unwrap();
        let update = vec![serde_json::json!({"id":"shot","kind":"shot","payload":{"action":"new"}})];
        apply_production_change(&mut connection, "p", "update", &HashMap::from([("shot".into(), 1)]), &update).unwrap();
        let revert = vec![serde_json::json!({"id":"shot","kind":"shot","op":"revertProductionChange","payload":{"targetChangeId":"update"}})];
        apply_production_change(&mut connection, "p", "revert", &HashMap::from([("shot".into(), 2)]), &revert).unwrap();
        let payload: String = connection.query_row("SELECT payload FROM project_entities WHERE id='shot'", [], |row| row.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&payload).unwrap()["action"], "old");
        let later = vec![serde_json::json!({"id":"shot","kind":"shot","payload":{"action":"later"}})];
        apply_production_change(&mut connection, "p", "later", &HashMap::from([("shot".into(), 3)]), &later).unwrap();
        assert_eq!(apply_production_change(&mut connection, "p", "revert-again", &HashMap::from([("shot".into(), 4)]), &revert).unwrap_err(), CommandError::ChangeConflict);
    }

    #[test]
    fn undoing_creation_archives_entity_without_deleting_its_history() {
        let dir = tempfile::tempdir().unwrap();
        let mut connection = db::open(&dir.path().join("db.sqlite3")).unwrap();
        let create = vec![serde_json::json!({"id":"shot","kind":"shot","payload":{"action":"new"}})];
        apply_production_change(&mut connection, "p", "create", &HashMap::from([("shot".into(), 0)]), &create).unwrap();
        let revert = vec![serde_json::json!({"id":"shot","kind":"shot","op":"revertProductionChange","payload":{"targetChangeId":"create"}})];
        apply_production_change(&mut connection, "p", "revert", &HashMap::from([("shot".into(), 1)]), &revert).unwrap();
        let archived: Option<String> = connection.query_row("SELECT archived_at FROM project_entities WHERE id='shot'", [], |row| row.get(0)).unwrap();
        assert!(archived.is_some());
        assert_eq!(apply_production_change(&mut connection, "p", "revert-again", &HashMap::from([("shot".into(), 2)]), &revert).unwrap_err(), CommandError::ChangeConflict);
        let changes: i64 = connection.query_row("SELECT COUNT(*) FROM production_changes", [], |row| row.get(0)).unwrap();
        assert_eq!(changes, 2);
    }

    #[test]
    fn approval_requires_the_current_video_adoption_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let mut connection = db::open(&dir.path().join("db.sqlite3")).unwrap();
        seed_asset(&connection, "p", "asset");
        let create = vec![serde_json::json!({"id":"shot","kind":"shot","payload":{"selected":{"video":{"adoptionId":"a1","assetId":"asset","specHash":"h1"}}}})];
        apply_production_change(&mut connection, "p", "create", &HashMap::from([("shot".into(), 0)]), &create).unwrap();
        let review = vec![serde_json::json!({"id":"shot","kind":"shot","op":"recordProductionReview","payload":{"state":"approved","adoptionId":"a1","specHash":"wrong"}})];
        assert_eq!(apply_production_change(&mut connection, "p", "review", &HashMap::from([("shot".into(), 1)]), &review).unwrap_err(), CommandError::ValidationFailed);
    }

    #[test]
    fn timeline_creation_rejects_assets_outside_the_project() {
        let dir = tempfile::tempdir().unwrap();
        let mut connection = db::open(&dir.path().join("db.sqlite3")).unwrap();
        connection.execute("INSERT INTO assets (id,kind,path,mime,bytes,payload,created_at) VALUES ('foreign-video','video','cas/video.mp4','video/mp4',1,'{}','now')", []).unwrap();
        connection.execute("INSERT INTO project_assets (project_id,asset_id,added_at,provenance) VALUES ('other-project','foreign-video','now','{}')", []).unwrap();
        let timeline = vec![serde_json::json!({
            "id":"timeline",
            "kind":"timeline",
            "payload":{"boardId":"board","clips":[{"id":"clip","assetId":"foreign-video","sourceInTicks":0,"sourceOutTicks":240000}]}
        })];

        assert_eq!(
            apply_production_change(&mut connection, "project", "timeline-create", &HashMap::from([("timeline".into(), 0)]), &timeline).unwrap_err(),
            CommandError::InvalidReference
        );
        let count: i64 = connection.query_row("SELECT COUNT(*) FROM project_entities WHERE kind='timeline'", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn timeline_clip_replacement_preserves_other_clips_and_subtitle_anchors() {
        let dir = tempfile::tempdir().unwrap();
        let mut connection = db::open(&dir.path().join("db.sqlite3")).unwrap();
        for (asset_id, seconds) in [("old-1", 3.0), ("old-2", 3.0), ("retake", 1.5)] {
            connection.execute("INSERT INTO assets (id,kind,path,mime,bytes,duration,payload,created_at) VALUES (?1,'video','cas/video.mp4','video/mp4',1,?2,'{}','now')", params![asset_id, seconds]).unwrap();
            connection.execute("INSERT INTO project_assets (project_id,asset_id,added_at,provenance) VALUES ('p',?1,'now','{}')", [asset_id]).unwrap();
        }
        let timeline = vec![serde_json::json!({
            "id":"timeline","kind":"timeline",
            "payload":{"clips":[
                {"id":"clip-1","assetId":"old-1","sourceInTicks":0,"sourceOutTicks":240000},
                {"id":"clip-2","assetId":"old-2","sourceInTicks":0,"sourceOutTicks":480000}
            ],"subtitleCues":[{"id":"cue","startTicks":250000,"endTicks":400000,"anchorClipId":"clip-2","text":"你好"}]}
        })];
        apply_production_change(&mut connection, "p", "timeline-create", &HashMap::from([("timeline".into(), 0)]), &timeline).unwrap();
        let replacement = vec![serde_json::json!({
            "id":"timeline","kind":"timeline","op":"replaceTimelineClip",
            "payload":{"clipId":"clip-2","assetId":"retake","sourceInTicks":0,"sourceOutTicks":360000,"acknowledgeShorter":false}
        })];
        assert_eq!(
            apply_production_change(&mut connection, "p", "replace-shorter", &HashMap::from([("timeline".into(), 1)]), &replacement).unwrap_err(),
            CommandError::ValidationFailed
        );
        let allowed = vec![serde_json::json!({
            "id":"timeline","kind":"timeline","op":"replaceTimelineClip",
            "payload":{"clipId":"clip-2","assetId":"retake","sourceInTicks":0,"sourceOutTicks":360000,"acknowledgeShorter":true}
        })];
        apply_production_change(&mut connection, "p", "replace-confirmed", &HashMap::from([("timeline".into(), 1)]), &allowed).unwrap();
        let payload: String = connection.query_row("SELECT payload FROM project_entities WHERE id='timeline'", [], |row| row.get(0)).unwrap();
        let payload: Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(payload["clips"][0]["assetId"], "old-1");
        assert_eq!(payload["clips"][1]["assetId"], "retake");
        assert_eq!(payload["clips"][1]["sourceOutTicks"], 360_000);
        assert_eq!(payload["subtitleCues"][0]["anchorClipId"], "clip-2");
    }

    fn seed_asset(connection: &Connection, project_id: &str, asset_id: &str) {
        connection.execute("INSERT INTO assets (id,kind,path,mime,bytes,payload,created_at) VALUES (?1,'video','cas/video.mp4','video/mp4',1,'{}','now')", [asset_id]).unwrap();
        connection.execute("INSERT INTO project_assets (project_id,asset_id,added_at,provenance) VALUES (?1,?2,'now','{}')", params![project_id, asset_id]).unwrap();
    }

    fn shot_spec(action: &str) -> Value {
        serde_json::json!({"title":"开门","action":action,"dialogue":"","durationMs":3000,"bindings":[],"selected":{},"review":"draft"})
    }

    fn stored_payload(connection: &Connection, id: &str) -> Value {
        let raw: String = connection.query_row("SELECT payload FROM project_entities WHERE id=?1", [id], |row| row.get(0)).unwrap();
        serde_json::from_str(&raw).unwrap()
    }

    #[test]
    fn upsert_entity_rejects_bindings_and_assets_outside_the_project() {
        let dir = tempfile::tempdir().unwrap();
        let mut connection = db::open(&dir.path().join("db.sqlite3")).unwrap();
        connection.execute("INSERT INTO assets (id,kind,path,mime,bytes,payload,created_at) VALUES ('foreign','video','cas/v.mp4','video/mp4',1,'{}','now')", []).unwrap();
        connection.execute("INSERT INTO project_assets (project_id,asset_id,added_at,provenance) VALUES ('other','foreign','now','{}')", []).unwrap();
        let bad_binding = vec![serde_json::json!({"id":"shot","kind":"shot","payload":{"bindings":[{"bindingId":"b1","subjectId":"missing-subject","version":1}]}})];
        assert_eq!(apply_production_change(&mut connection, "p", "bad-binding", &HashMap::from([("shot".to_string(), 0)]), &bad_binding).unwrap_err(), CommandError::InvalidReference);
        let bad_slot = vec![serde_json::json!({"id":"shot","kind":"shot","payload":{"selected":{"video":{"adoptionId":"a1","assetId":"foreign","specHash":"h1"}}}} )];
        assert_eq!(apply_production_change(&mut connection, "p", "bad-slot", &HashMap::from([("shot".to_string(), 0)]), &bad_slot).unwrap_err(), CommandError::InvalidReference);
        let bad_reference = vec![serde_json::json!({"id":"shot","kind":"shot","payload":{"genericReferenceIds":["foreign"]}})];
        assert_eq!(apply_production_change(&mut connection, "p", "bad-reference", &HashMap::from([("shot".to_string(), 0)]), &bad_reference).unwrap_err(), CommandError::InvalidReference);
        let bad_frame = vec![serde_json::json!({"id":"shot","kind":"shot","payload":{"firstFrameId":"foreign","lastFrameId":"foreign"}})];
        assert_eq!(apply_production_change(&mut connection, "p", "bad-frame", &HashMap::from([("shot".to_string(), 0)]), &bad_frame).unwrap_err(), CommandError::InvalidReference);
        let count: i64 = connection.query_row("SELECT COUNT(*) FROM project_entities WHERE kind='shot'", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn subject_current_version_must_reference_an_existing_subject_version() {
        let dir = tempfile::tempdir().unwrap();
        let mut connection = db::open(&dir.path().join("db.sqlite3")).unwrap();
        let bad = vec![serde_json::json!({"id":"subject-1","kind":"subject","payload":{"name":"主角","kind":"character","aliases":[],"currentVersion":99}})];
        assert_eq!(apply_production_change(&mut connection, "p", "bad-version", &HashMap::from([("subject-1".to_string(), 0)]), &bad).unwrap_err(), CommandError::InvalidReference);
        let create = vec![serde_json::json!({"id":"subject-1","kind":"subject","op":"createSubjectVersion","payload":{"name":"主角","kind":"character","aliases":[],"version":{"ordinal":1,"descriptor":"主角","references":[]}}})];
        apply_production_change(&mut connection, "p", "create-version", &HashMap::from([("subject-1".to_string(), 0)]), &create).unwrap();
        assert_eq!(stored_payload(&connection, "subject-1")["currentVersion"], 1);
        let missing = vec![serde_json::json!({"id":"subject-1","kind":"subject","payload":{"name":"主角","kind":"character","aliases":[],"currentVersion":2}})];
        assert_eq!(apply_production_change(&mut connection, "p", "missing-version", &HashMap::from([("subject-1".to_string(), 1)]), &missing).unwrap_err(), CommandError::InvalidReference);
    }

    #[test]
    fn review_state_machine_rejects_unknown_states_and_illegal_transitions() {
        let dir = tempfile::tempdir().unwrap();
        let mut connection = db::open(&dir.path().join("db.sqlite3")).unwrap();
        let create = vec![serde_json::json!({"id":"shot","kind":"shot","payload":shot_spec("人物走入房间")})];
        apply_production_change(&mut connection, "p", "create", &HashMap::from([("shot".to_string(), 0)]), &create).unwrap();
        let unknown = vec![serde_json::json!({"id":"shot","kind":"shot","op":"recordProductionReview","payload":{"state":"banana"}})];
        assert_eq!(apply_production_change(&mut connection, "p", "review-banana", &HashMap::from([("shot".to_string(), 1)]), &unknown).unwrap_err(), CommandError::ValidationFailed);
        let illegal = vec![serde_json::json!({"id":"shot","kind":"shot","op":"recordProductionReview","payload":{"state":"approved","adoptionId":"a1","specHash":"h1","approvedSpecHash":"h1"}})];
        assert_eq!(apply_production_change(&mut connection, "p", "review-illegal", &HashMap::from([("shot".to_string(), 1)]), &illegal).unwrap_err(), CommandError::ValidationFailed);
        let to_review = vec![serde_json::json!({"id":"shot","kind":"shot","op":"recordProductionReview","payload":{"state":"review"}})];
        apply_production_change(&mut connection, "p", "review-review", &HashMap::from([("shot".to_string(), 1)]), &to_review).unwrap();
        assert_eq!(stored_payload(&connection, "shot")["review"], "review");
    }

    #[test]
    fn changing_shot_content_returns_review_to_draft_and_keeps_the_last_approval() {
        let dir = tempfile::tempdir().unwrap();
        let mut connection = db::open(&dir.path().join("db.sqlite3")).unwrap();
        seed_asset(&connection, "p", "asset-1");
        let create = vec![serde_json::json!({"id":"shot","kind":"shot","payload":shot_spec("人物走入房间")})];
        apply_production_change(&mut connection, "p", "create", &HashMap::from([("shot".to_string(), 0)]), &create).unwrap();
        let spec = shot_spec_hash(&shot_spec("人物走入房间")).unwrap();
        let adopt = vec![serde_json::json!({"id":"shot","kind":"shot","op":"adoptShotMedia","payload":{"slot":"video","assetId":"asset-1","specHash":spec}})];
        apply_production_change(&mut connection, "p", "adopt", &HashMap::from([("shot".to_string(), 1)]), &adopt).unwrap();
        let adoption_id = stored_payload(&connection, "shot")["selected"]["video"]["adoptionId"].as_str().unwrap().to_string();
        let to_review = vec![serde_json::json!({"id":"shot","kind":"shot","op":"recordProductionReview","payload":{"state":"review"}})];
        apply_production_change(&mut connection, "p", "review-review", &HashMap::from([("shot".to_string(), 2)]), &to_review).unwrap();
        let approve = vec![serde_json::json!({"id":"shot","kind":"shot","op":"recordProductionReview","payload":{"state":"approved","adoptionId":adoption_id,"specHash":spec,"approvedSpecHash":spec}})];
        apply_production_change(&mut connection, "p", "approve", &HashMap::from([("shot".to_string(), 3)]), &approve).unwrap();
        assert_eq!(stored_payload(&connection, "shot")["review"], "approved");
        // 交付内容没变：审批保持不变。
        let unchanged = vec![serde_json::json!({"id":"shot","kind":"shot","payload":{"title":"开门","action":"人物走入房间","dialogue":"","durationMs":3000,"bindings":[],"selected":{"video":{"adoptionId":adoption_id,"assetId":"asset-1","specHash":spec}},"review":"approved","approvedSpecHash":spec}})];
        apply_production_change(&mut connection, "p", "unchanged", &HashMap::from([("shot".to_string(), 4)]), &unchanged).unwrap();
        assert_eq!(stored_payload(&connection, "shot")["review"], "approved");
        // 交付内容变了：回到 draft 并保留上次审批快照。
        let changed = vec![serde_json::json!({"id":"shot","kind":"shot","payload":{"title":"开门","action":"人物跑进房间","dialogue":"","durationMs":3000,"bindings":[],"selected":{"video":{"adoptionId":adoption_id,"assetId":"asset-1","specHash":spec}},"review":"approved","approvedSpecHash":spec}})];
        apply_production_change(&mut connection, "p", "changed", &HashMap::from([("shot".to_string(), 5)]), &changed).unwrap();
        let payload = stored_payload(&connection, "shot");
        assert_eq!(payload["review"], "draft");
        assert_eq!(payload["previousReview"]["state"], "approved");
        assert_eq!(payload["previousReview"]["specHash"], spec);
        assert!(payload["previousReview"]["at"].as_str().is_some());
    }

    #[test]
    fn archived_entities_reject_further_writes() {
        let dir = tempfile::tempdir().unwrap();
        let mut connection = db::open(&dir.path().join("db.sqlite3")).unwrap();
        let create = vec![serde_json::json!({"id":"shot","kind":"shot","payload":{"action":"new"}})];
        apply_production_change(&mut connection, "p", "create", &HashMap::from([("shot".to_string(), 0)]), &create).unwrap();
        let revert = vec![serde_json::json!({"id":"shot","kind":"shot","op":"revertProductionChange","payload":{"targetChangeId":"create"}})];
        apply_production_change(&mut connection, "p", "revert", &HashMap::from([("shot".to_string(), 1)]), &revert).unwrap();
        let update = vec![serde_json::json!({"id":"shot","kind":"shot","payload":{"action":"again"}})];
        assert_eq!(apply_production_change(&mut connection, "p", "write-archived", &HashMap::from([("shot".to_string(), 2)]), &update).unwrap_err(), CommandError::ChangeConflict);
        let payload: Option<String> = connection.query_row("SELECT payload FROM project_entities WHERE id='shot'", [], |row| row.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&payload.unwrap()).unwrap()["action"], "new");
    }

    #[test]
    fn delete_entity_archives_the_entity_instead_of_dropping_the_row() {
        let dir = tempfile::tempdir().unwrap();
        let mut connection = db::open(&dir.path().join("db.sqlite3")).unwrap();
        let create = vec![serde_json::json!({"id":"shot","kind":"shot","payload":{"action":"new"}})];
        apply_production_change(&mut connection, "p", "create", &HashMap::from([("shot".to_string(), 0)]), &create).unwrap();
        let delete = vec![serde_json::json!({"id":"shot","kind":"shot","op":"deleteEntity","payload":{}})];
        let result = apply_production_change(&mut connection, "p", "delete", &HashMap::from([("shot".to_string(), 1)]), &delete).unwrap();
        assert_eq!(result.affected_ids, vec!["shot"]);
        assert_eq!(result.revision_map.get("shot"), Some(&2));
        let archived: Option<String> = connection.query_row("SELECT archived_at FROM project_entities WHERE id='shot'", [], |row| row.get(0)).unwrap();
        assert!(archived.is_some(), "删除实体要归档而不是删行");
        let listed: i64 = connection.query_row("SELECT COUNT(*) FROM project_entities WHERE project_id='p' AND archived_at IS NULL", [], |row| row.get(0)).unwrap();
        assert_eq!(listed, 0, "归档后的实体不再出现在列表查询里");
        let revision: i64 = connection.query_row("SELECT revision FROM project_entities WHERE id='shot'", [], |row| row.get(0)).unwrap();
        assert_eq!(revision, 2);
    }

    #[test]
    fn delete_entity_rejects_unknown_entity_and_stale_revision() {
        let dir = tempfile::tempdir().unwrap();
        let mut connection = db::open(&dir.path().join("db.sqlite3")).unwrap();
        let missing = vec![serde_json::json!({"id":"ghost","kind":"shot","op":"deleteEntity","payload":{}})];
        assert_eq!(apply_production_change(&mut connection, "p", "delete-missing", &HashMap::from([("ghost".to_string(), 0)]), &missing).unwrap_err(), CommandError::InvalidReference);
        let create = vec![serde_json::json!({"id":"shot","kind":"shot","payload":{"action":"new"}})];
        apply_production_change(&mut connection, "p", "create", &HashMap::from([("shot".to_string(), 0)]), &create).unwrap();
        let stale = vec![serde_json::json!({"id":"shot","kind":"shot","op":"deleteEntity","payload":{}})];
        assert_eq!(apply_production_change(&mut connection, "p", "delete-stale", &HashMap::from([("shot".to_string(), 7)]), &stale).unwrap_err(), CommandError::RevisionConflict);
        // 归档后不可再写：已归档实体不接受任何改动。
        let delete = vec![serde_json::json!({"id":"shot","kind":"shot","op":"deleteEntity","payload":{}})];
        apply_production_change(&mut connection, "p", "delete", &HashMap::from([("shot".to_string(), 1)]), &delete).unwrap();
        assert_eq!(apply_production_change(&mut connection, "p", "delete-again", &HashMap::from([("shot".to_string(), 2)]), &delete).unwrap_err(), CommandError::ChangeConflict);
    }

    #[test]
    fn reapplying_a_breakdown_draft_returns_the_original_result() {
        let dir = tempfile::tempdir().unwrap();
        let mut connection = db::open(&dir.path().join("db.sqlite3")).unwrap();
        let script = vec![serde_json::json!({"id":"script","kind":"script","payload":{"body":"A\nB"}})];
        apply_production_change(&mut connection, "p", "script-create", &HashMap::from([("script".to_string(), 0)]), &script).unwrap();
        let draft = serde_json::json!({"shots":[{"localId":"s1","source":{"startLine":1,"endLine":1},"action":"walk","dialogue":"","subjectRefs":[]}],"subjects":[]});
        crate::production::breakdown::save_draft(&connection, "p", "draft-1", "script", 1, &draft).unwrap();
        let operations = vec![serde_json::json!({
            "id":"shot-1","kind":"shot","op":"applyBreakdown",
            "payload":{"scriptId":"script","scriptRevision":1,"draftId":"draft-1","localId":"s1","source":{"startLine":1,"endLine":1},"action":"walk","dialogue":"","order":1}
        })];
        let first = apply_production_change(&mut connection, "p", "breakdown-apply", &HashMap::from([("script".to_string(), 1), ("shot-1".to_string(), 0)]), &operations).unwrap();
        let second = apply_production_change(&mut connection, "p", "breakdown-apply-again", &HashMap::from([("script".to_string(), 1), ("shot-1".to_string(), 0)]), &operations).unwrap();
        assert_eq!(second.change_id, first.change_id);
        assert_eq!(second.affected_ids, vec!["shot-1"]);
        let count: i64 = connection.query_row("SELECT COUNT(*) FROM project_entities WHERE kind='shot'", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 1);
        assert_eq!(crate::production::breakdown::draft_application(&connection, "p", "draft-1").unwrap(), Some("breakdown-apply".to_string()));
    }

    #[test]
    fn applying_an_unknown_breakdown_draft_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let mut connection = db::open(&dir.path().join("db.sqlite3")).unwrap();
        let script = vec![serde_json::json!({"id":"script","kind":"script","payload":{"body":"A\nB"}})];
        apply_production_change(&mut connection, "p", "script-create", &HashMap::from([("script".to_string(), 0)]), &script).unwrap();
        let operations = vec![serde_json::json!({
            "id":"shot-1","kind":"shot","op":"applyBreakdown",
            "payload":{"scriptId":"script","scriptRevision":1,"draftId":"missing-draft","localId":"s1","source":{"startLine":1,"endLine":1},"action":"walk"}
        })];
        assert_eq!(apply_production_change(&mut connection, "p", "breakdown-apply", &HashMap::from([("script".to_string(), 1), ("shot-1".to_string(), 0)]), &operations).unwrap_err(), CommandError::InvalidReference);
        let count: i64 = connection.query_row("SELECT COUNT(*) FROM project_entities WHERE kind='shot'", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 0);
    }
}
