use rusqlite::{Connection, TransactionBehavior};
use std::{path::Path, time::Duration};

const MIGRATION_1: &str = r#"
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS generation_jobs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
  payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_by_project ON generation_jobs(project_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS provider_settings (
  provider_id TEXT PRIMARY KEY, base_url TEXT NOT NULL, model TEXT NOT NULL,
  text_model TEXT, voice TEXT
);
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS studio_projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, payload TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
  payload TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS boards_by_project ON boards(project_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, board_id TEXT NOT NULL, node_id TEXT NOT NULL,
  status TEXT NOT NULL, cache_key TEXT NOT NULL, payload TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_by_board ON runs(board_id, created_at DESC);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, provider_id TEXT NOT NULL, capability TEXT NOT NULL,
  remote_task_id TEXT, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
  next_poll_at TEXT, payload TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_by_status ON jobs(status, next_poll_at);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, path TEXT NOT NULL, mime TEXT NOT NULL,
  bytes INTEGER NOT NULL, width INTEGER, height INTEGER, duration REAL,
  payload TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_profiles (
  id TEXT PRIMARY KEY, adapter TEXT NOT NULL, base_url TEXT NOT NULL,
  enabled INTEGER NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL
);
"#;

const PRODUCTION_SCHEMA: &str = include_str!("db/migration_2.sql");
const SCHEMA_VERSION: i64 = 5;

pub fn open(path: &Path) -> Result<Connection, String> {
    let mut connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
        .map_err(|error| error.to_string())?;
    migrate(&mut connection)?;
    Ok(connection)
}

fn migrate(connection: &mut Connection) -> Result<(), String> {
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if version > SCHEMA_VERSION {
        return Err(format!(
            "Database version {version} is newer than this application supports"
        ));
    }
    if version == SCHEMA_VERSION {
        return Ok(());
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let current: i64 = transaction
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if current == SCHEMA_VERSION {
        return transaction.commit().map_err(|error| error.to_string());
    }
    if current > SCHEMA_VERSION {
        return Err(format!(
            "Database version {current} is newer than this application supports"
        ));
    }
    transaction
        .execute_batch("PRAGMA defer_foreign_keys = ON;")
        .map_err(|error| error.to_string())?;
    let tables = {
        let mut statement = transaction
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    for table in tables {
        let quoted = table.replace('"', "\"\"");
        transaction
            .execute_batch(&format!("DROP TABLE \"{quoted}\";"))
            .map_err(|error| error.to_string())?;
    }
    transaction
        .execute_batch(MIGRATION_1)
        .map_err(|error| error.to_string())?;
    transaction
        .execute_batch(PRODUCTION_SCHEMA)
        .map_err(|error| error.to_string())?;
    transaction
        .pragma_update(None, "user_version", SCHEMA_VERSION)
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn v1_fixture(path: &Path) -> Connection {
        let connection = Connection::open(path).unwrap();
        connection
            .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
            .unwrap();
        connection.execute_batch(MIGRATION_1).unwrap();
        connection.pragma_update(None, "user_version", 1).unwrap();
        connection
    }

    #[test]
    fn creates_schema_and_is_idempotent() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("frameforge.sqlite3");
        let connection = open(&path).expect("open");
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("version");
        assert_eq!(version, SCHEMA_VERSION);
        for table in [
            "studio_projects",
            "boards",
            "runs",
            "jobs",
            "assets",
            "provider_profiles",
            "projects",
        ] {
            let count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |row| row.get(0),
                )
                .expect("table count");
            assert_eq!(count, 1, "missing table {table}");
        }
        drop(connection);
        let reopened = open(&path).expect("reopen");
        let version: i64 = reopened
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("version");
        assert_eq!(version, SCHEMA_VERSION);
    }

    #[test]
    fn replaces_unreleased_v1_data_with_current_schema() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("frameforge.sqlite3");
        let old = v1_fixture(&path);
        old.execute("INSERT INTO studio_projects (id,name,payload,created_at,updated_at) VALUES ('old','Old','{}','2026-01-01','2026-01-01')", []).unwrap();
        old.execute(
            "INSERT INTO runs (id,project_id,board_id,node_id,status,cache_key,payload,created_at,updated_at) VALUES ('r1','p2','b2','n','succeeded','c',?1,'2026-01-01','2026-01-01')",
            [json!({"inputAssetIds": ["shared"], "outputAssetIds": []}).to_string()],
        ).unwrap();
        let migrated = open(&path).unwrap();
        assert_eq!(
            migrated
                .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        assert_eq!(
            migrated
                .query_row("SELECT COUNT(*) FROM studio_projects", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            migrated
                .query_row("SELECT COUNT(*) FROM runs", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            migrated
                .query_row("SELECT COUNT(*) FROM project_assets", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        drop(migrated);
        let reopened = open(&path).unwrap();
        assert_eq!(
            reopened
                .query_row("SELECT COUNT(*) FROM studio_projects", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}
