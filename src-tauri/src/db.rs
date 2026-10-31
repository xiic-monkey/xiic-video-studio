use rusqlite::Connection;
use std::path::Path;

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

pub fn open(path: &Path) -> Result<Connection, String> {
    let mut connection = Connection::open(path).map_err(|error| error.to_string())?;
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
    if version < 1 {
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        transaction.execute_batch(MIGRATION_1).map_err(|error| error.to_string())?;
        transaction
            .pragma_update(None, "user_version", 1)
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    // 旧库可能早于 voice 列存在；重复添加会报错，忽略即可。
    let _ = connection.execute("ALTER TABLE provider_settings ADD COLUMN voice TEXT", []);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_schema_and_is_idempotent() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("frameforge.sqlite3");
        let connection = open(&path).expect("open");
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("version");
        assert_eq!(version, 1);
        for table in ["studio_projects", "boards", "runs", "jobs", "assets", "provider_profiles", "projects"] {
            let count: i64 = connection
                .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1", [table], |row| row.get(0))
                .expect("table count");
            assert_eq!(count, 1, "missing table {table}");
        }
        drop(connection);
        let reopened = open(&path).expect("reopen");
        let version: i64 = reopened
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("version");
        assert_eq!(version, 1);
    }
}
