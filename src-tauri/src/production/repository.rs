use crate::assets::AssetRef;
use chrono::Utc;
use rusqlite::{params, Connection, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AssetOrigin {
    pub(crate) kind: String,
    pub(crate) reference: Option<String>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub(crate) enum ProductionError {
    #[error("ASSET_NOT_IN_PROJECT")]
    AssetNotInProject,
    #[error("ASSET_MISSING")]
    AssetMissing,
    #[error("PROJECT_ID_REQUIRED")]
    ProjectIdRequired,
    #[error("DATABASE: {0}")]
    Database(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectAssetPage {
    pub(crate) items: Vec<AssetRef>,
    pub(crate) next_cursor: Option<String>,
}

pub(crate) fn require_project_asset(
    connection: &Connection,
    project_id: &str,
    asset_id: &str,
) -> Result<AssetRef, ProductionError> {
    if project_id.trim().is_empty() {
        return Err(ProductionError::ProjectIdRequired);
    }
    let (payload, provenance): (String, String) = connection
        .query_row(
            "SELECT a.payload, pa.provenance FROM assets a JOIN project_assets pa ON pa.asset_id=a.id WHERE pa.project_id=?1 AND pa.asset_id=?2",
            params![project_id, asset_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => ProductionError::AssetNotInProject,
            other => ProductionError::Database(other.to_string()),
        })?;
    let mut asset: AssetRef =
        serde_json::from_str(&payload).map_err(|_| ProductionError::AssetMissing)?;
    asset.provenance =
        serde_json::from_str(&provenance).map_err(|_| ProductionError::AssetMissing)?;
    Ok(asset)
}

pub(crate) fn record_asset_membership(
    transaction: &Transaction<'_>,
    project_id: &str,
    asset: &AssetRef,
    origin: &AssetOrigin,
) -> Result<(), ProductionError> {
    if project_id.trim().is_empty() {
        return Err(ProductionError::ProjectIdRequired);
    }
    let provenance = serde_json::to_string(&asset.provenance)
        .map_err(|error| ProductionError::Database(error.to_string()))?;
    let display_name = asset.provenance.get("displayName").and_then(Value::as_str);
    let mut digest = Sha256::new();
    for field in [
        project_id,
        asset.id.as_str(),
        origin.kind.as_str(),
        origin.reference.as_deref().unwrap_or(""),
        provenance.as_str(),
    ] {
        digest.update((field.len() as u64).to_le_bytes());
        digest.update(field.as_bytes());
    }
    let origin_id = format!("origin_{}", hex::encode(digest.finalize()));
    transaction
        .execute(
            "INSERT OR IGNORE INTO project_assets (project_id, asset_id, display_name, added_at, provenance) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![project_id, asset.id, display_name, asset.created_at, provenance],
        )
        .map_err(|error| ProductionError::Database(error.to_string()))?;
    transaction
        .execute(
            "INSERT OR IGNORE INTO asset_origins (id, project_id, asset_id, origin_kind, origin_ref, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                origin_id,
                project_id,
                asset.id,
                origin.kind,
                origin.reference,
                provenance,
                Utc::now().to_rfc3339()
            ],
        )
        .map_err(|error| ProductionError::Database(error.to_string()))?;
    Ok(())
}

pub(crate) fn list_project_assets(
    connection: &Connection,
    project_id: &str,
    kind: Option<&str>,
    query: Option<&str>,
    cursor: Option<&str>,
) -> Result<ProjectAssetPage, ProductionError> {
    let cursor_value: Option<(String, String)> = cursor
        .map(|value| {
            serde_json::from_str(value)
                .map_err(|_| ProductionError::Database("invalid cursor".into()))
        })
        .transpose()?;
    let query_value = query.unwrap_or("");
    let kind_value = kind.unwrap_or("");
    let mut statement = connection
        .prepare(
            "SELECT a.payload, pa.added_at, pa.provenance FROM assets a JOIN project_assets pa ON pa.asset_id=a.id
             WHERE pa.project_id=?1 AND (?2='' OR a.kind=?2)
             AND (?3='' OR a.id LIKE '%' || ?3 || '%' OR COALESCE(pa.display_name,'') LIKE '%' || ?3 || '%')
             AND (?4 IS NULL OR (pa.added_at, pa.asset_id) < (?4, ?5))
             ORDER BY pa.added_at DESC, pa.asset_id DESC LIMIT 101",
        )
        .map_err(|error| ProductionError::Database(error.to_string()))?;
    let rows = statement
        .query_map(
            params![
                project_id,
                kind_value,
                query_value,
                cursor_value.as_ref().map(|value| &value.0),
                cursor_value.as_ref().map(|value| &value.1)
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .map_err(|error| ProductionError::Database(error.to_string()))?;
    let mut items: Vec<AssetRef> = Vec::new();
    let mut last_added_at = String::new();
    let mut has_more = false;
    for row in rows {
        let (payload, added_at, provenance) =
            row.map_err(|error| ProductionError::Database(error.to_string()))?;
        if items.len() == 100 {
            has_more = true;
            break;
        }
        let value: Value =
            serde_json::from_str(&payload).map_err(|_| ProductionError::AssetMissing)?;
        let mut asset: AssetRef =
            serde_json::from_value(value).map_err(|_| ProductionError::AssetMissing)?;
        asset.provenance =
            serde_json::from_str(&provenance).map_err(|_| ProductionError::AssetMissing)?;
        items.push(asset);
        last_added_at = added_at;
    }
    let next_cursor = if has_more {
        let last = items.last().expect("limit ensures a last item");
        Some(
            serde_json::to_string(&(last_added_at, &last.id))
                .map_err(|error| ProductionError::Database(error.to_string()))?,
        )
    } else {
        None
    };
    Ok(ProjectAssetPage { items, next_cursor })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{assets, db};
    use serde_json::json;

    #[test]
    fn shared_hash_keeps_distinct_project_origins() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("frameforge.sqlite3");
        let connection = db::open(&path).unwrap();
        let first = assets::store_bytes(directory.path(), b"same", "text", "text/plain", json!({}))
            .unwrap();
        connection.execute("INSERT OR REPLACE INTO assets (id, kind, path, mime, bytes, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)", params![first.id, first.kind, first.path, first.mime, first.bytes, serde_json::to_string(&first).unwrap(), first.created_at]).unwrap();
        let transaction = connection.unchecked_transaction().unwrap();
        record_asset_membership(
            &transaction,
            "p1",
            &first,
            &AssetOrigin {
                kind: "import".into(),
                reference: Some("one.txt".into()),
            },
        )
        .unwrap();
        record_asset_membership(
            &transaction,
            "p2",
            &first,
            &AssetOrigin {
                kind: "import".into(),
                reference: Some("two.txt".into()),
            },
        )
        .unwrap();
        transaction.commit().unwrap();
        assert_eq!(
            require_project_asset(&connection, "p1", &first.id)
                .unwrap()
                .id,
            first.id
        );
        assert_eq!(
            require_project_asset(&connection, "p2", &first.id)
                .unwrap()
                .id,
            first.id
        );
        assert!(matches!(
            require_project_asset(&connection, "p3", &first.id),
            Err(ProductionError::AssetNotInProject)
        ));
    }
}
