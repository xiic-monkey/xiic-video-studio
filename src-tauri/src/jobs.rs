use crate::db;
use crate::gateway::{self, ModelConfig, ProviderRuntime};
use crate::runs::{self, RunRecord, StartRunRequest};
use crate::AppState;
use serde_json::json;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const POLL_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const MAX_TRANSIENT_RETRIES: u32 = 8;

pub fn poll_delay(attempt: u32) -> Duration {
    Duration::from_secs(match attempt {
        0 => 2,
        1 => 3,
        2 => 5,
        3 => 8,
        4 => 12,
        _ => 15,
    })
}

pub fn should_resume(status: &str, remote_task_id: Option<&str>) -> bool {
    matches!(status, "submitted" | "polling") && remote_task_id.is_some()
}

/// 运行是否已经到终态：到终态就不该再恢复轮询，
/// 更不能把它当成「提交中断」改判成失败。
pub fn run_is_terminal(status: &str) -> bool {
    matches!(status, "succeeded" | "failed" | "cancelled")
}

fn db_connection(state: &AppState) -> Result<rusqlite::Connection, String> {
    let path = runs::db_path(state)?;
    db::open(&path)
}

/// 记录已提交到远端的异步任务并启动轮询。
pub fn attach_task(
    app: &AppHandle,
    state: &AppState,
    run: &RunRecord,
    job_id: &str,
    task_id: &str,
    request: StartRunRequest,
    runtime: ProviderRuntime,
    model: ModelConfig,
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
    let app = app.clone();
    let db_path = runs::db_path(state).unwrap_or_default();
    let data_dir = state.data_dir.clone();
    let run = run.clone();
    let job_id = job_id.to_string();
    let task_id = task_id.to_string();
    tauri::async_runtime::spawn(async move {
        poll_loop(app, db_path, data_dir, run, job_id, task_id, runtime, model).await;
    });
}

async fn poll_loop(
    app: AppHandle,
    db_path: PathBuf,
    data_dir: PathBuf,
    run: RunRecord,
    job_id: String,
    task_id: String,
    runtime: ProviderRuntime,
    model: ModelConfig,
) {
    let client = match crate::http_client() {
        Ok(client) => client,
        Err(message) => {
            finish_failed(
                &app,
                &db_path,
                &run,
                gateway::AppError::new("UNAVAILABLE_HTTP", message, false),
            );
            set_job_values(&db_path, &job_id, "failed", 0);
            return;
        }
    };
    let started = std::time::Instant::now();
    let mut attempt = 0u32;
    loop {
        tokio::time::sleep(poll_delay(attempt)).await;
        if is_cancelled(&db_path, &run.id) {
            let _ = gateway::cancel(&client, &runtime, &model, &task_id).await;
            finish_cancelled(&app, &db_path, &run);
            set_job_values(&db_path, &job_id, "cancelled", attempt);
            return;
        }
        if started.elapsed() > POLL_TIMEOUT {
            finish_failed(
                &app,
                &db_path,
                &run,
                gateway::AppError::new("TIMEOUT_TASK", "视频任务轮询超时", true),
            );
            set_job_values(&db_path, &job_id, "failed", attempt);
            return;
        }
        match gateway::poll(&client, &runtime, &model, &task_id).await {
            Ok(status) if status.status == "succeeded" => {
                match runs::store_outputs_for_poll(&app, &db_path, &data_dir, &run, status.outputs).await
                {
                    Ok(assets) => finish_succeeded(&app, &db_path, &run, assets),
                    Err(error) => finish_failed(&app, &db_path, &run, error),
                }
                set_job_values(&db_path, &job_id, "succeeded", attempt);
                return;
            }
            Ok(status) if status.status == "failed" => {
                let error = status.error.unwrap_or_else(|| {
                    gateway::AppError::new("TASK_FAILED", "视频任务失败", false)
                });
                finish_failed(&app, &db_path, &run, error);
                set_job_values(&db_path, &job_id, "failed", attempt);
                return;
            }
            Ok(status) if status.status == "cancelled" => {
                finish_cancelled(&app, &db_path, &run);
                set_job_values(&db_path, &job_id, "cancelled", attempt);
                return;
            }
            Ok(status) => {
                set_job_values(&db_path, &job_id, "polling", attempt);
                let _ = app.emit(
                    "job.updated",
                    json!({
                        "id": job_id,
                        "status": "polling",
                        "progress": status.progress,
                        "rawStatus": status.raw_status,
                    }),
                );
                attempt = attempt.saturating_add(1);
            }
            Err(error) if error.retryable && attempt < MAX_TRANSIENT_RETRIES => {
                attempt = attempt.saturating_add(1);
            }
            Err(error) => {
                finish_failed(&app, &db_path, &run, error);
                set_job_values(&db_path, &job_id, "failed", attempt);
                return;
            }
        }
    }
}

fn set_job_values(db_path: &PathBuf, job_id: &str, status: &str, attempts: u32) {
    if let Ok(connection) = db::open(db_path) {
        let _ = connection.execute(
            "UPDATE jobs SET status=?1, attempts=?2, updated_at=?3 WHERE id=?4",
            rusqlite::params![status, attempts, chrono::Utc::now().to_rfc3339(), job_id],
        );
    }
}

fn is_cancelled(db_path: &PathBuf, run_id: &str) -> bool {
    db::open(db_path)
        .ok()
        .and_then(|connection| {
            connection
                .query_row("SELECT status FROM runs WHERE id=?1", [run_id], |row| {
                    row.get::<_, String>(0)
                })
                .ok()
        })
        .map(|status| status == "cancelled")
        .unwrap_or(false)
}

fn finish_succeeded(app: &AppHandle, db_path: &PathBuf, run: &RunRecord, assets: Vec<crate::assets::AssetRef>) {
    let mut finished = run.clone();
    finished.status = "succeeded".to_string();
    finished.output_asset_ids = assets.iter().map(|asset| asset.id.clone()).collect();
    finished.selected_asset_id = finished.output_asset_ids.first().cloned();
    finished.finished_at = Some(chrono::Utc::now().to_rfc3339());
    let _ = runs::save_run_at(db_path, &finished);
    let _ = app.emit(
        "run.updated",
        &runs::RunUpdatedEvent { run: finished, assets },
    );
}

fn finish_failed(app: &AppHandle, db_path: &PathBuf, run: &RunRecord, error: gateway::AppError) {
    let mut finished = run.clone();
    finished.status = "failed".to_string();
    finished.error = Some(error);
    finished.finished_at = Some(chrono::Utc::now().to_rfc3339());
    let _ = runs::save_run_at(db_path, &finished);
    let _ = app.emit(
        "run.updated",
        &runs::RunUpdatedEvent { run: finished, assets: Vec::new() },
    );
}

fn finish_cancelled(app: &AppHandle, db_path: &PathBuf, run: &RunRecord) {
    let mut finished = run.clone();
    finished.status = "cancelled".to_string();
    finished.finished_at = Some(chrono::Utc::now().to_rfc3339());
    let _ = runs::save_run_at(db_path, &finished);
    let _ = app.emit(
        "run.updated",
        &runs::RunUpdatedEvent { run: finished, assets: Vec::new() },
    );
}

pub fn cancel(app: &AppHandle, state: &AppState, run_id: &str) {
    if let Ok(run) = runs::mark_cancelled(state, run_id) {
        let _ = app.emit(
            "run.updated",
            &runs::RunUpdatedEvent { run, assets: Vec::new() },
        );
    }
}

/// 启动时恢复未完成的远端任务：已有远端 task_id 的续轮询，没拿到 task_id 的判定为提交中断。
/// 返回实际恢复轮询的任务数。
pub fn resume_pending_on_start(app: AppHandle, state: &AppState) -> usize {
    let path = match runs::db_path(state) {
        Ok(path) => path,
        Err(_) => return 0,
    };
    let connection = match db::open(&path) {
        Ok(connection) => connection,
        Err(_) => return 0,
    };
    let mut statement = match connection.prepare(
        "SELECT id, run_id, provider_id, status, remote_task_id, payload FROM jobs WHERE status IN ('queued','submitted','polling')",
    ) {
        Ok(statement) => statement,
        Err(_) => return 0,
    };
    let rows: Vec<(String, String, String, String, Option<String>, String)> = match statement
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?))
        })
        .and_then(|mapped| mapped.collect::<Result<Vec<_>, _>>())
    {
        Ok(rows) => rows,
        Err(_) => return 0,
    };
    let mut resumed = 0usize;
    for (job_id, run_id, provider_id, status, remote_task_id, payload) in rows {
        // 运行已经到终态（例如同步候选先跑成功了）：不要复活它，
        // 更不能当成「提交中断」把它改判成失败。
        let run = match runs::load_run(state, &run_id) {
            Ok(run) => run,
            Err(_) => continue,
        };
        if run_is_terminal(&run.status) {
            set_job_values(&path, &job_id, &run.status, 0);
            continue;
        }
        let request: StartRunRequest = match serde_json::from_str(&payload) {
            Ok(request) => request,
            Err(_) => continue,
        };
        if !should_resume(&status, remote_task_id.as_deref()) {
            finish_failed(
                &app,
                &path,
                &run,
                gateway::AppError::new(
                    "TASK_INTERRUPTED",
                    "任务在提交阶段被中断，请重新运行",
                    true,
                ),
            );
            set_job_values(&path, &job_id, "failed", 0);
            continue;
        }
        let task_id = match remote_task_id {
            Some(task_id) => task_id,
            None => continue,
        };
        let key_ref = match request.route.as_ref() {
            Some(route) => route.key_ref.clone(),
            // 老任务没有路由信息：回落到供应商默认 Key。
            None => match crate::provider_credential(&provider_id) {
                Ok(Some(key)) => key,
                _ => continue,
            },
        };
        let key = match crate::provider_key_secret(&key_ref) {
            Some(key) => key,
            None => continue,
        };
        let profile = match runs::load_provider_profile(state, &provider_id) {
            Ok(Some(profile)) => profile,
            _ => continue,
        };
        let model = match profile.models.iter().find(|item| item.id == request.model) {
            Some(model) => model.clone(),
            None => continue,
        };
        let protocol = match request.route.as_ref() {
            Some(route) => route.protocol.clone(),
            None => gateway::protocol_for(&profile, &request.model, &request.capability),
        };
        let runtime = ProviderRuntime { profile, api_key: key, protocol };
        let handle = app.clone();
        let db_path = path.clone();
        let data_dir = state.data_dir.clone();
        tauri::async_runtime::spawn(async move {
            poll_loop(handle, db_path, data_dir, run, job_id, task_id, runtime, model).await;
        });
        resumed += 1;
    }
    resumed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_grows_then_caps() {
        assert_eq!(poll_delay(0), std::time::Duration::from_secs(2));
        assert_eq!(poll_delay(1), std::time::Duration::from_secs(3));
        assert_eq!(poll_delay(2), std::time::Duration::from_secs(5));
        assert_eq!(poll_delay(9), std::time::Duration::from_secs(15));
    }

    #[test]
    fn resume_only_when_remote_task_exists() {
        assert!(!should_resume("queued", None));
        assert!(should_resume("submitted", Some("task_1")));
        assert!(should_resume("polling", Some("task_1")));
        assert!(!should_resume("succeeded", Some("task_1")));
    }

    /// 已经成功的运行不再恢复：恢复扫描不能把它改判成失败。
    #[test]
    fn terminal_runs_are_never_resumed() {
        assert!(run_is_terminal("succeeded"));
        assert!(run_is_terminal("failed"));
        assert!(run_is_terminal("cancelled"));
        assert!(!run_is_terminal("running"));
        assert!(!run_is_terminal("queued"));
    }
}
