use crate::db;
use crate::gateway::{ModelConfig, ProviderRuntime};
use crate::runs::{self, RunRecord, StartRunRequest};
use crate::AppState;
use serde_json::json;
use tauri::{AppHandle, Emitter};

fn db_connection(state: &AppState) -> Result<rusqlite::Connection, String> {
    let path = runs::db_path(state)?;
    db::open(&path)
}

/// 记录已提交到远端的异步任务；轮询由 Task 14 的 poll loop 接管。
pub fn attach_task(
    app: &AppHandle,
    state: &AppState,
    run: &RunRecord,
    job_id: &str,
    task_id: &str,
    request: StartRunRequest,
    _runtime: ProviderRuntime,
    _model: ModelConfig,
) {
    if let Ok(connection) = db_connection(state) {
        let payload = serde_json::to_string(&request).unwrap_or_default();
        let _ = connection.execute(
            "INSERT INTO jobs (id, run_id, provider_id, capability, remote_task_id, status, attempts, next_poll_at, payload, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'submitted', 0, NULL, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET remote_task_id=excluded.remote_task_id, status='submitted', payload=excluded.payload, updated_at=excluded.updated_at",
            rusqlite::params![job_id, run.id, request.provider_id, request.capability, task_id, payload, chrono::Utc::now().to_rfc3339()],
        );
    }
    if let Ok(updated) = runs::mark_running(state, &run.id) {
        let _ = app.emit(
            "run.updated",
            &runs::RunUpdatedEvent { run: updated, assets: Vec::new() },
        );
    }
    let _ = app.emit("job.updated", json!({ "id": job_id, "status": "submitted", "attempts": 0 }));
}
