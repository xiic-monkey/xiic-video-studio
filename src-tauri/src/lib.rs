use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::Utc;
use keyring::Entry;
use reqwest::Client;
use rusqlite::{params, Connection, Error as RusqliteError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Manager, State};

mod assets;
mod db;
mod gateway;
mod jobs;
mod runs;
mod security;

const CREDENTIAL_ACCOUNT_PREFIX: &str = "provider/";
const KEYCHAIN_SERVICE: &str = "com.frameforge.studio";

// 精确匹配而非子串：RunRecord.cacheKey 必须保留，否则导入/重启后缓存命中与 stale 判定全部失效。
// 不含裸 "key"——画布节点数据里 key/value 是常见结构，按名字剥会吞掉用户内容。
const SENSITIVE_KEYS: [&str; 16] = [
    "apikey",
    "api_key",
    "secretkey",
    "secret_key",
    "accesskey",
    "access_key",
    "accesskeyid",
    "secretaccesskey",
    "authorization",
    "bearer",
    "token",
    "accesstoken",
    "password",
    "credential",
    "credentials",
    "secret",
];

pub(crate) fn strip_sensitive_fields(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.retain(|field, _| !SENSITIVE_KEYS.contains(&field.to_ascii_lowercase().as_str()));
            for nested in map.values_mut() {
                strip_sensitive_fields(nested);
            }
        }
        Value::Array(items) => {
            for nested in items.iter_mut() {
                strip_sensitive_fields(nested);
            }
        }
        _ => {}
    }
}

pub(crate) struct AppState {
    pub(crate) db_path: Mutex<PathBuf>,
    pub(crate) data_dir: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredJob {
    id: String,
    project_id: String,
    kind: String,
    status: String,
    payload: Value,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct ProjectPackage {
    schema_version: u32,
    exported_at: String,
    project: Value,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredProviderSettings {
    provider_id: String,
    base_url: String,
    model: String,
    text_model: Option<String>,
    voice: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GptImageRequest {
    base_url: String,
    api_key: String,
    model: String,
    prompt: String,
    size: Option<String>,
    quality: Option<String>,
    reference_images: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextGenerationRequest {
    base_url: String,
    api_key: String,
    model: String,
    system_prompt: String,
    user_prompt: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpeechGenerationRequest {
    base_url: String,
    api_key: String,
    model: String,
    voice: String,
    input: String,
    response_format: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VideoGenerationRequest {
    provider_id: String,
    base_url: String,
    api_key: String,
    model: String,
    prompt: String,
    aspect_ratio: String,
    duration: u8,
    start_frame_url: Option<String>,
    end_frame_url: Option<String>,
    middle_frame_url: Option<String>,
    reference_image_urls: Option<Vec<String>>,
    client_request_id: Option<String>,
    generate_audio: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VideoTaskRequest {
    provider_id: String,
    base_url: String,
    api_key: String,
    task_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoreMediaAssetRequest {
    source: String,
    kind: String,
    file_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VideoGenerationTask {
    task_id: String,
    provider: String,
    model: Option<String>,
    status: String,
    progress: Option<u8>,
    output_urls: Vec<String>,
    raw_status: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedImage {
    url: String,
    revised_prompt: Option<String>,
    provider: String,
    model: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FinalCutClip {
    source: String,
    kind: String,
    duration: f64,
    preserve_audio: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FinalCutAudioTrack {
    source: String,
    start: f64,
    duration: f64,
    volume: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FinalCutSubtitleCue {
    text: String,
    start: f64,
    end: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FinalCutExportRequest {
    output_path: String,
    aspect_ratio: String,
    clips: Vec<FinalCutClip>,
    #[serde(default)]
    transition_duration: f64,
    #[serde(default)]
    cover_duration: f64,
    #[serde(default)]
    end_card_duration: f64,
    #[serde(default)]
    thumbnail_source: Option<String>,
    #[serde(default)]
    content_duration: Option<f64>,
    #[serde(default)]
    audio_tracks: Vec<FinalCutAudioTrack>,
    #[serde(default)]
    subtitles: Vec<FinalCutSubtitleCue>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FinalCutExportResult {
    path: String,
    thumbnail_path: Option<String>,
    clip_count: usize,
    duration: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MediaQcInput {
    asset_id: String,
    source: String,
    kind: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaQcResult {
    asset_id: String,
    status: String,
    duration: f64,
    width: u32,
    height: u32,
    has_audio: bool,
    frame_count: u64,
    contact_sheet_path: String,
    warnings: Vec<String>,
    errors: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
struct MediaProbeSummary {
    duration: f64,
    width: u32,
    height: u32,
    has_audio: bool,
    frame_count: u64,
    warnings: Vec<String>,
    errors: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ImageResponse {
    data: Vec<ImageData>,
}

#[derive(Debug, Deserialize)]
struct ImageData {
    b64_json: Option<String>,
    url: Option<String>,
    revised_prompt: Option<String>,
}

fn video_api_url(base_url: &str, path: &str) -> String {
    if path.starts_with("https://") || path.starts_with("http://") {
        return path.to_string();
    }
    format!(
        "{}/{}",
        base_url.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

fn first_string(value: &Value, paths: &[&str]) -> Option<String> {
    paths.iter().find_map(|path| {
        value
            .pointer(path)
            .and_then(Value::as_str)
            .map(str::to_owned)
    })
}

fn likely_video_url(url: &str, key: &str, context: &str) -> bool {
    let path = url.split('?').next().unwrap_or(url).to_ascii_lowercase();
    key.contains("video")
        || context.contains("/video/")
        || context.contains("generatedsample")
        || context.contains("/output/")
        || context.contains("/result/")
        || [".mp4", ".webm", ".mov", ".m3u8"]
            .iter()
            .any(|ext| path.ends_with(ext))
}

fn collect_video_urls(value: &Value, context: &str, output: &mut Vec<String>) {
    match value {
        Value::Object(fields) => {
            for (key, child) in fields {
                let key_lower = key.to_ascii_lowercase();
                let child_context = format!("{context}/{key_lower}");
                if let Some(url) = child.as_str() {
                    if likely_video_url(url, &key_lower, &child_context)
                        && (url.starts_with("https://") || url.starts_with("http://"))
                        && !output.iter().any(|stored| stored == url)
                    {
                        output.push(url.to_string());
                    }
                }
                collect_video_urls(child, &child_context, output);
            }
        }
        Value::Array(values) => {
            for child in values {
                collect_video_urls(child, context, output);
            }
        }
        _ => {}
    }
}

fn video_urls(value: &Value) -> Vec<String> {
    let mut output = Vec::new();
    collect_video_urls(value, "", &mut output);
    output
}

fn normalized_video_status(value: &Value) -> (String, Option<String>) {
    if value.get("done").and_then(Value::as_bool) == Some(true) {
        let status = if value
            .get("error")
            .filter(|error| !error.is_null())
            .is_some()
        {
            "failed"
        } else {
            "succeeded"
        };
        return (status.to_string(), Some("done".to_string()));
    }
    let raw = first_string(value, &["/status", "/data/status", "/task/status"]);
    let status = raw
        .as_deref()
        .map(|state| match state.to_ascii_lowercase().as_str() {
            "completed" | "complete" | "success" | "succeeded" | "done" => "succeeded",
            "failed" | "error" | "expired" => "failed",
            "cancelled" | "canceled" => "cancelled",
            "queued" | "pending" | "created" => "queued",
            "running" | "processing" | "generating" => "generating",
            _ => "polling",
        })
        .unwrap_or("polling")
        .to_string();
    (status, raw)
}

fn task_from_response(
    provider: &str,
    model: Option<String>,
    value: &Value,
) -> Result<VideoGenerationTask, String> {
    let task_id = first_string(
        value,
        &[
            "/id",
            "/request_id",
            "/task_id",
            "/data/id",
            "/task/id",
            "/name",
        ],
    )
    .ok_or_else(|| "Video provider response has no task id".to_string())?;
    let (status, raw_status) = normalized_video_status(value);
    let progress = value
        .pointer("/progress")
        .or_else(|| value.pointer("/data/progress"))
        .and_then(Value::as_u64)
        .and_then(|progress| u8::try_from(progress).ok());
    Ok(VideoGenerationTask {
        task_id,
        provider: provider.to_string(),
        model,
        status,
        progress,
        output_urls: video_urls(value),
        raw_status,
        error: first_string(value, &["/error/message", "/error", "/message"]),
    })
}

async fn provider_json(response: reqwest::Response, label: &str) -> Result<Value, String> {
    let status = response.status();
    let raw = response.text().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!("{label} returned {status}: {raw}"));
    }
    serde_json::from_str(&raw).map_err(|error| format!("Invalid {label} response: {error}"))
}

pub(crate) fn http_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|error| format!("Could not create HTTP client: {error}"))
}

fn chat_content(value: &Value) -> Option<String> {
    let content = value.pointer("/choices/0/message/content")?;
    if let Some(text) = content.as_str() {
        return Some(text.to_string());
    }
    content.as_array().map(|parts| {
        parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n")
    })
}

fn open_db(path: &PathBuf) -> Result<Connection, String> {
    db::open(path)
}

/// 资产桶配置：连接参数存在 app_settings，密钥只在 keychain。
pub(crate) fn asset_host_internal(
    state: &AppState,
) -> Result<gateway::transport::AssetHostConfig, String> {
    let path = state
        .db_path
        .lock()
        .map_err(|_| "Project database lock poisoned".to_string())?;
    let connection = open_db(&path)?;
    let stored: Option<String> = connection
        .query_row(
            "SELECT value FROM app_settings WHERE key='asset_host'",
            [],
            |row| row.get(0),
        )
        .ok();
    let mut config: gateway::transport::AssetHostConfig = match stored {
        Some(payload) => serde_json::from_str(&payload).unwrap_or_default(),
        None => gateway::transport::AssetHostConfig::default(),
    };
    if let Ok(entry) = Entry::new("com.frameforge.studio", "asset-host/access-key") {
        config.access_key = entry.get_password().ok();
    }
    if let Ok(entry) = Entry::new("com.frameforge.studio", "asset-host/secret-key") {
        config.secret_key = entry.get_password().ok();
    }
    Ok(config)
}

fn project_identity(project: &Value) -> Result<(String, String), String> {
    let id = project
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Project requires a non-empty id".to_string())?;
    let name = project
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Project requires a name".to_string())?;
    Ok((id.to_string(), name.to_string()))
}

fn valid_job_status(status: &str) -> bool {
    matches!(
        status,
        "queued"
            | "preparing"
            | "generating"
            | "polling"
            | "succeeded"
            | "failed"
            | "cancelled"
            | "unknown"
    )
}

fn project_package(mut project: Value) -> Result<ProjectPackage, String> {
    project_identity(&project)?;
    strip_sensitive_fields(&mut project);
    Ok(ProjectPackage {
        schema_version: 1,
        exported_at: Utc::now().to_rfc3339(),
        project,
    })
}

fn final_cut_dimensions(aspect_ratio: &str) -> Result<(u16, u16), String> {
    match aspect_ratio {
        "9:16" => Ok((1080, 1920)),
        "16:9" => Ok((1920, 1080)),
        _ => Err("Final cut aspect ratio must be 9:16 or 16:9".to_string()),
    }
}

fn validate_transition_duration(transition_duration: f64) -> Result<(), String> {
    if !transition_duration.is_finite() || !(0.0..=1.5).contains(&transition_duration) {
        return Err("Transition duration must be between 0 and 1.5 seconds".to_string());
    }
    Ok(())
}

fn validate_card_duration(duration: f64, label: &str) -> Result<(), String> {
    if !duration.is_finite() || !(0.0..=10.0).contains(&duration) {
        return Err(format!("{label} must be between 0 and 10 seconds"));
    }
    Ok(())
}

fn final_cut_duration(clip_durations: &[f64], transition_duration: f64) -> Result<f64, String> {
    validate_transition_duration(transition_duration)?;
    if clip_durations.is_empty() {
        return Err("Select at least one video or image candidate before exporting".to_string());
    }
    for duration in clip_durations {
        if !duration.is_finite() || !(0.1..=120.0).contains(duration) {
            return Err(
                "Each final cut clip duration must be between 0.1 and 120 seconds".to_string(),
            );
        }
        if transition_duration > 0.0 && *duration <= transition_duration {
            return Err(
                "Each clip must be longer than the transition duration for a dissolve".to_string(),
            );
        }
    }
    let total_duration: f64 = clip_durations.iter().sum();
    let final_duration =
        total_duration - transition_duration * clip_durations.len().saturating_sub(1) as f64;
    if !final_duration.is_finite() || final_duration <= 0.0 {
        return Err("Final cut duration must be greater than zero".to_string());
    }
    Ok(final_duration)
}

fn xfade_offsets(clip_durations: &[f64], transition_duration: f64) -> Result<Vec<f64>, String> {
    final_cut_duration(clip_durations, transition_duration)?;
    if clip_durations.len() < 2 {
        return Ok(Vec::new());
    }
    let mut accumulated = clip_durations[0];
    let mut offsets = Vec::with_capacity(clip_durations.len() - 1);
    for duration in clip_durations.iter().skip(1) {
        offsets.push(accumulated - transition_duration);
        accumulated += duration - transition_duration;
    }
    Ok(offsets)
}

fn ffmpeg_failure(label: &str, output: std::process::Output) -> Result<(), String> {
    if output.status.success() {
        return Ok(());
    }
    let diagnostics = String::from_utf8_lossy(&output.stderr);
    let tail = diagnostics
        .chars()
        .rev()
        .take(1800)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    Err(format!("{label} failed: {tail}"))
}

fn number_from_value(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(|value| {
            value
                .as_f64()
                .or_else(|| value.as_str()?.parse::<f64>().ok())
        })
        .filter(|value| value.is_finite())
}

fn rational_from_value(value: Option<&Value>) -> Option<f64> {
    let raw = value?.as_str()?;
    let (numerator, denominator) = raw.split_once('/')?;
    let numerator = numerator.parse::<f64>().ok()?;
    let denominator = denominator.parse::<f64>().ok()?;
    if denominator == 0.0 {
        return None;
    }
    Some(numerator / denominator)
}

fn parse_media_probe(value: &Value, kind: &str) -> Result<MediaProbeSummary, String> {
    let streams = value
        .get("streams")
        .and_then(Value::as_array)
        .ok_or_else(|| "FFprobe returned no stream list".to_string())?;
    let video_stream = streams
        .iter()
        .find(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("video"));
    let audio_stream = streams
        .iter()
        .any(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("audio"));
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let (width, height) = video_stream
        .map(|stream| {
            (
                stream
                    .get("width")
                    .and_then(Value::as_u64)
                    .and_then(|value| u32::try_from(value).ok())
                    .unwrap_or_default(),
                stream
                    .get("height")
                    .and_then(Value::as_u64)
                    .and_then(|value| u32::try_from(value).ok())
                    .unwrap_or_default(),
            )
        })
        .unwrap_or_default();
    if video_stream.is_none() {
        errors.push("媒体没有可用的视频流".to_string());
    }
    if width == 0 || height == 0 {
        errors.push("无法读取媒体画面尺寸".to_string());
    }
    let duration = number_from_value(value.pointer("/format/duration"))
        .or_else(|| video_stream.and_then(|stream| number_from_value(stream.get("duration"))))
        .unwrap_or_default()
        .max(0.0);
    if kind == "video" && duration <= 0.0 {
        errors.push("视频时长无效".to_string());
    }
    if kind == "video" && !audio_stream {
        warnings.push("视频没有原生音轨，终剪将使用外部配音或音乐".to_string());
    }
    if width > 0 && height > 0 && (width < 720 || height < 720) {
        warnings.push(format!("分辨率偏低：{width} × {height}"));
    }
    let frame_count = video_stream
        .and_then(|stream| {
            stream
                .get("nb_frames")
                .or_else(|| stream.get("nb_read_frames"))
                .and_then(|value| {
                    value
                        .as_u64()
                        .or_else(|| value.as_str()?.parse::<u64>().ok())
                })
        })
        .or_else(|| {
            let frame_rate = video_stream
                .and_then(|stream| {
                    rational_from_value(stream.get("avg_frame_rate"))
                        .or_else(|| rational_from_value(stream.get("r_frame_rate")))
                })
                .unwrap_or_default();
            if duration > 0.0 && frame_rate > 0.0 {
                Some((duration * frame_rate).round() as u64)
            } else {
                None
            }
        })
        .unwrap_or_else(|| if video_stream.is_some() { 1 } else { 0 });
    Ok(MediaProbeSummary {
        duration,
        width,
        height,
        has_audio: audio_stream,
        frame_count,
        warnings,
        errors,
    })
}

pub(crate) fn probe_media(path: &Path, kind: &str) -> Result<MediaProbeSummary, String> {
    let output = Command::new("ffprobe")
        .args([
            OsString::from("-v"),
            OsString::from("error"),
            OsString::from("-show_streams"),
            OsString::from("-show_format"),
            OsString::from("-of"),
            OsString::from("json"),
            path.as_os_str().to_os_string(),
        ])
        .output()
        .map_err(|error| {
            format!("Could not start FFprobe. Install FFmpeg and restart Frameforge: {error}")
        })?;
    ffmpeg_failure("Media probe", output.clone())?;
    let raw = String::from_utf8(output.stdout)
        .map_err(|error| format!("Invalid FFprobe output: {error}"))?;
    let value: Value =
        serde_json::from_str(&raw).map_err(|error| format!("Invalid FFprobe JSON: {error}"))?;
    parse_media_probe(&value, kind)
}

async fn materialize_media_source(
    source: &str,
    kind: &str,
    destination: &Path,
) -> Result<PathBuf, String> {
    if let Some(path) = source.strip_prefix("file://") {
        let local = PathBuf::from(path);
        if local.is_file() {
            return Ok(local);
        }
        return Err("Local media asset no longer exists".to_string());
    }
    let local = PathBuf::from(source);
    if local.is_file() {
        return Ok(local);
    }
    if !matches!(kind, "image" | "video" | "audio") {
        return Err(format!("Unsupported media asset type: {kind}"));
    }
    let bytes = read_media_source(source).await?;
    if bytes.is_empty() {
        return Err("Media asset is empty".to_string());
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(destination, bytes)
        .map_err(|error| format!("Could not cache media asset: {error}"))?;
    Ok(destination.to_path_buf())
}

#[tauri::command]
async fn run_media_qc(
    request: MediaQcInput,
    state: State<'_, AppState>,
) -> Result<MediaQcResult, String> {
    if request.asset_id.trim().is_empty() || request.source.trim().is_empty() {
        return Err("Media QC requires an asset id and source".to_string());
    }
    if !matches!(request.kind.as_str(), "image" | "video") {
        return Err("Media QC supports image and video assets".to_string());
    }
    let app_data = state
        .db_path
        .lock()
        .map_err(|_| "Project database lock poisoned".to_string())?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Could not resolve app data folder".to_string())?;
    let cache_dir = app_data.join("qc-cache");
    fs::create_dir_all(&cache_dir).map_err(|error| error.to_string())?;
    let stamp = Utc::now().timestamp_nanos_opt().unwrap_or_default();
    let source_path = cache_dir.join(format!(
        "qc-input-{stamp}.{}",
        if request.kind == "video" {
            "mp4"
        } else {
            "png"
        }
    ));
    let source_path =
        materialize_media_source(&request.source, &request.kind, &source_path).await?;
    let summary = probe_media(&source_path, &request.kind)?;
    let contact_sheet = cache_dir.join(format!("{}-{stamp}.jpg", media_stem(&request.asset_id)));
    let filter = if request.kind == "video" {
        "fps=1,scale=360:360:force_original_aspect_ratio=decrease,pad=360:360:(ow-iw)/2:(oh-ih)/2:color=black,tile=4x4"
    } else {
        "scale=360:360:force_original_aspect_ratio=decrease,pad=360:360:(ow-iw)/2:(oh-ih)/2:color=black"
    };
    let output = Command::new("ffmpeg")
        .args([
            OsString::from("-y"),
            OsString::from("-hide_banner"),
            OsString::from("-loglevel"),
            OsString::from("error"),
            OsString::from("-i"),
            source_path.as_os_str().to_os_string(),
            OsString::from("-vf"),
            OsString::from(filter),
            OsString::from("-frames:v"),
            OsString::from("1"),
            contact_sheet.as_os_str().to_os_string(),
        ])
        .output()
        .map_err(|error| {
            format!("Could not start FFmpeg. Install FFmpeg and restart Frameforge: {error}")
        })?;
    ffmpeg_failure("Contact sheet generation", output)?;
    Ok(MediaQcResult {
        asset_id: request.asset_id,
        status: "ready".to_string(),
        duration: summary.duration,
        width: summary.width,
        height: summary.height,
        has_audio: summary.has_audio,
        frame_count: summary.frame_count,
        contact_sheet_path: contact_sheet.to_string_lossy().to_string(),
        warnings: summary.warnings,
        errors: summary.errors,
    })
}

async fn materialize_final_cut_source(
    source: &str,
    kind: &str,
    destination: &Path,
) -> Result<PathBuf, String> {
    if let Some(path) = source.strip_prefix("file://") {
        let local = PathBuf::from(path);
        if local.is_file() {
            return Ok(local);
        }
        return Err("Local export asset no longer exists".to_string());
    }
    let local = PathBuf::from(source);
    if local.is_file() {
        return Ok(local);
    }

    let extension = match kind {
        "video" => "mp4",
        "image" => "png",
        "audio" => "audio",
        _ => return Err("Unsupported export asset type".to_string()),
    };
    let target = destination.with_extension(extension);
    if let Some(encoded) = source.strip_prefix("data:") {
        let (_, encoded) = encoded
            .split_once(",")
            .ok_or_else(|| "Invalid base64 export asset".to_string())?;
        let bytes = STANDARD
            .decode(encoded.as_bytes())
            .map_err(|error| format!("Invalid base64 export asset: {error}"))?;
        if bytes.len() > 512 * 1024 * 1024 {
            return Err("Export asset exceeds the 512 MB local limit".to_string());
        }
        fs::write(&target, bytes).map_err(|error| error.to_string())?;
        return Ok(target);
    }

    if !(source.starts_with("https://") || source.starts_with("http://")) {
        return Err(
            "Export asset must be a local file, base64 data URL, or HTTP(S) URL".to_string(),
        );
    }
    let response = http_client()?
        .get(source)
        .send()
        .await
        .map_err(|error| format!("Could not download export asset: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Could not download export asset: {}",
            response.status()
        ));
    }
    if response.content_length().unwrap_or_default() > 512 * 1024 * 1024 {
        return Err("Export asset exceeds the 512 MB local limit".to_string());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Could not read export asset: {error}"))?;
    if bytes.len() > 512 * 1024 * 1024 {
        return Err("Export asset exceeds the 512 MB local limit".to_string());
    }
    fs::write(&target, bytes).map_err(|error| error.to_string())?;
    Ok(target)
}

fn srt_timestamp(seconds: f64) -> String {
    let milliseconds = (seconds.max(0.0) * 1000.0).round() as u64;
    let hours = milliseconds / 3_600_000;
    let minutes = (milliseconds % 3_600_000) / 60_000;
    let seconds = (milliseconds % 60_000) / 1000;
    let millis = milliseconds % 1000;
    format!("{hours:02}:{minutes:02}:{seconds:02},{millis:03}")
}

fn subtitle_file(
    cues: &[FinalCutSubtitleCue],
    content_duration: f64,
    start_offset: f64,
) -> Result<String, String> {
    if cues.len() > 500 {
        return Err("A final cut supports at most 500 subtitle cues".to_string());
    }
    let mut output = String::new();
    let mut written = 0;
    for cue in cues {
        let text = cue.text.trim();
        if text.is_empty() {
            continue;
        }
        if !cue.start.is_finite()
            || !cue.end.is_finite()
            || cue.start < 0.0
            || cue.end <= cue.start
            || cue.end > content_duration + 0.05
        {
            return Err("Subtitle cue times must fall within the content sequence".to_string());
        }
        written += 1;
        output.push_str(&format!(
            "{written}\n{} --> {}\n{text}\n\n",
            srt_timestamp(cue.start + start_offset),
            srt_timestamp(cue.end + start_offset)
        ));
    }
    Ok(output)
}

#[tauri::command]
async fn export_final_cut(
    request: FinalCutExportRequest,
    state: State<'_, AppState>,
) -> Result<FinalCutExportResult, String> {
    if request.clips.is_empty() {
        return Err("Select at least one video or image candidate before exporting".to_string());
    }
    if request.clips.len() > 120 {
        return Err("A single final cut supports at most 120 clips".to_string());
    }
    let (width, height) = final_cut_dimensions(&request.aspect_ratio)?;
    let clip_durations = request
        .clips
        .iter()
        .map(|clip| clip.duration)
        .collect::<Vec<_>>();
    let content_duration = final_cut_duration(&clip_durations, request.transition_duration)?;
    validate_card_duration(request.cover_duration, "Cover duration")?;
    validate_card_duration(request.end_card_duration, "End card duration")?;
    let final_duration = content_duration + request.cover_duration + request.end_card_duration;
    if let Some(requested_content_duration) = request.content_duration {
        if !requested_content_duration.is_finite()
            || requested_content_duration <= 0.0
            || (requested_content_duration - content_duration).abs() > 0.1
        {
            return Err("Final cut content duration does not match the clip sequence".to_string());
        }
    }
    let transition_offsets = xfade_offsets(&clip_durations, request.transition_duration)?;
    let mut output_path = PathBuf::from(request.output_path.trim());
    if output_path.as_os_str().is_empty() {
        return Err("Final cut output path cannot be empty".to_string());
    }
    if output_path
        .extension()
        .and_then(|extension| extension.to_str())
        != Some("mp4")
    {
        output_path.set_extension("mp4");
    }
    if let Some(parent) = output_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create export folder: {error}"))?;
    }

    let app_data = state
        .db_path
        .lock()
        .map_err(|_| "Project database lock poisoned".to_string())?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Could not resolve app data folder".to_string())?;
    let render_dir = app_data.join("render-cache").join(format!(
        "final-cut-{}",
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    fs::create_dir_all(&render_dir).map_err(|error| error.to_string())?;

    let filter = format!(
        "scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1"
    );
    let mut materialized_clips = Vec::with_capacity(request.clips.len());
    let mut clip_has_audio = Vec::with_capacity(request.clips.len());
    for (index, clip) in request.clips.iter().enumerate() {
        if !matches!(clip.kind.as_str(), "video" | "image") {
            let _ = fs::remove_dir_all(&render_dir);
            return Err("Final cut clips must be video or image assets".to_string());
        }
        let source = match materialize_final_cut_source(
            &clip.source,
            &clip.kind,
            &render_dir.join(format!("source-{index}")),
        )
        .await
        {
            Ok(source) => source,
            Err(error) => {
                let _ = fs::remove_dir_all(&render_dir);
                return Err(error);
            }
        };
        let has_audio = if clip.kind == "video" && clip.preserve_audio.unwrap_or(true) {
            match probe_media(&source, "video") {
                Ok(summary) => summary.has_audio,
                Err(error) => {
                    let _ = fs::remove_dir_all(&render_dir);
                    return Err(error);
                }
            }
        } else {
            false
        };
        materialized_clips.push(source);
        clip_has_audio.push(has_audio);
    }
    let preserve_native_audio = clip_has_audio.iter().all(|has_audio| *has_audio);
    let mut segments = Vec::with_capacity(request.clips.len());
    for (index, clip) in request.clips.iter().enumerate() {
        let source = &materialized_clips[index];
        let segment = render_dir.join(format!("segment-{index:03}.mp4"));
        let mut arguments = vec![
            OsString::from("-y"),
            OsString::from("-hide_banner"),
            OsString::from("-loglevel"),
            OsString::from("error"),
        ];
        if clip.kind == "image" {
            arguments.extend([
                OsString::from("-loop"),
                OsString::from("1"),
                OsString::from("-framerate"),
                OsString::from("30"),
            ]);
        } else {
            arguments.extend([OsString::from("-stream_loop"), OsString::from("-1")]);
        }
        arguments.extend([
            OsString::from("-i"),
            source.clone().into_os_string(),
            OsString::from("-t"),
            OsString::from(format!("{:.3}", clip.duration)),
            OsString::from("-map"),
            OsString::from("0:v:0"),
            OsString::from("-vf"),
            OsString::from(&filter),
            OsString::from("-r"),
            OsString::from("30"),
        ]);
        if preserve_native_audio {
            arguments.extend([OsString::from("-map"), OsString::from("0:a:0")]);
        } else {
            arguments.push(OsString::from("-an"));
        }
        arguments.extend([
            OsString::from("-c:v"),
            OsString::from("libx264"),
            OsString::from("-preset"),
            OsString::from("medium"),
            OsString::from("-crf"),
            OsString::from("20"),
            OsString::from("-pix_fmt"),
            OsString::from("yuv420p"),
        ]);
        if preserve_native_audio {
            arguments.extend([
                OsString::from("-c:a"),
                OsString::from("aac"),
                OsString::from("-b:a"),
                OsString::from("192k"),
            ]);
        }
        arguments.extend([
            OsString::from("-movflags"),
            OsString::from("+faststart"),
            segment.clone().into_os_string(),
        ]);
        let result = Command::new("ffmpeg")
            .args(arguments)
            .output()
            .map_err(|error| {
                format!("Could not start FFmpeg. Install FFmpeg and restart Frameforge: {error}")
            });
        match result.and_then(|output| ffmpeg_failure("Clip rendering", output)) {
            Ok(()) => segments.push(segment),
            Err(error) => {
                let _ = fs::remove_dir_all(&render_dir);
                return Err(error);
            }
        }
    }

    let mut audio_sources = Vec::with_capacity(request.audio_tracks.len());
    for (index, track) in request.audio_tracks.iter().enumerate() {
        if track.source.trim().is_empty() {
            let _ = fs::remove_dir_all(&render_dir);
            return Err("Audio track source cannot be empty".to_string());
        }
        if !track.start.is_finite() || track.start < 0.0 || track.start > content_duration {
            let _ = fs::remove_dir_all(&render_dir);
            return Err("Audio track start must fall within the content sequence".to_string());
        }
        if !track.duration.is_finite() || !(0.1..=3600.0).contains(&track.duration) {
            let _ = fs::remove_dir_all(&render_dir);
            return Err("Audio track duration must be between 0.1 and 3600 seconds".to_string());
        }
        if !track.volume.is_finite() || !(0.0..=4.0).contains(&track.volume) {
            let _ = fs::remove_dir_all(&render_dir);
            return Err("Audio track volume must be between 0 and 4".to_string());
        }
        let source = match materialize_final_cut_source(
            &track.source,
            "audio",
            &render_dir.join(format!("audio-source-{index}")),
        )
        .await
        {
            Ok(source) => source,
            Err(error) => {
                let _ = fs::remove_dir_all(&render_dir);
                return Err(error);
            }
        };
        audio_sources.push((source, track.start, track.duration, track.volume));
    }

    let video_only = render_dir.join("video-only.mp4");
    let final_result = if request.transition_duration > 0.0 && segments.len() > 1 {
        let mut arguments = vec![
            OsString::from("-y"),
            OsString::from("-hide_banner"),
            OsString::from("-loglevel"),
            OsString::from("error"),
        ];
        for segment in &segments {
            arguments.extend([OsString::from("-i"), segment.clone().into_os_string()]);
        }
        let mut filters = Vec::with_capacity((segments.len() - 1) * 2);
        for (offset_index, offset) in transition_offsets.iter().enumerate() {
            let index = offset_index + 1;
            let previous = if index == 1 {
                "[0:v:0]".to_string()
            } else {
                format!("[v{}]", index - 1)
            };
            let output = format!("[v{index}]");
            filters.push(format!(
                "{previous}[{index}:v:0]xfade=transition=dissolve:duration={:.3}:offset={:.3}{output}",
                request.transition_duration, offset
            ));
        }
        if preserve_native_audio {
            for index in 1..segments.len() {
                let previous = if index == 1 {
                    "[0:a:0]".to_string()
                } else {
                    format!("[a{}]", index - 1)
                };
                filters.push(format!(
                    "{previous}[{index}:a:0]acrossfade=d={:.3}:c1=tri:c2=tri[a{index}]",
                    request.transition_duration
                ));
            }
        }
        arguments.extend([
            OsString::from("-filter_complex"),
            OsString::from(filters.join(";")),
            OsString::from("-map"),
            OsString::from(format!("[v{}]", segments.len() - 1)),
            OsString::from("-t"),
            OsString::from(format!("{content_duration:.3}")),
        ]);
        if preserve_native_audio {
            arguments.extend([
                OsString::from("-map"),
                OsString::from(format!("[a{}]", segments.len() - 1)),
            ]);
        } else {
            arguments.push(OsString::from("-an"));
        }
        arguments.extend([
            OsString::from("-c:v"),
            OsString::from("libx264"),
            OsString::from("-preset"),
            OsString::from("medium"),
            OsString::from("-crf"),
            OsString::from("20"),
            OsString::from("-pix_fmt"),
            OsString::from("yuv420p"),
        ]);
        if preserve_native_audio {
            arguments.extend([
                OsString::from("-c:a"),
                OsString::from("aac"),
                OsString::from("-b:a"),
                OsString::from("192k"),
            ]);
        }
        arguments.extend([
            OsString::from("-movflags"),
            OsString::from("+faststart"),
            video_only.clone().into_os_string(),
        ]);
        Command::new("ffmpeg")
            .args(arguments)
            .output()
            .map_err(|error| {
                format!("Could not start FFmpeg. Install FFmpeg and restart Frameforge: {error}")
            })
    } else {
        let manifest = render_dir.join("concat.txt");
        let manifest_body = segments
            .iter()
            .map(|segment| {
                format!(
                    "file '{}'",
                    segment.to_string_lossy().replace('\'', "'\\''")
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(&manifest, manifest_body).map_err(|error| error.to_string())?;
        let mut arguments = vec![
            OsString::from("-y"),
            OsString::from("-hide_banner"),
            OsString::from("-loglevel"),
            OsString::from("error"),
            OsString::from("-f"),
            OsString::from("concat"),
            OsString::from("-safe"),
            OsString::from("0"),
            OsString::from("-i"),
            manifest.into_os_string(),
            OsString::from("-c"),
            OsString::from("copy"),
        ];
        if !preserve_native_audio {
            arguments.push(OsString::from("-an"));
        }
        arguments.extend([
            OsString::from("-movflags"),
            OsString::from("+faststart"),
            video_only.clone().into_os_string(),
        ]);
        Command::new("ffmpeg")
            .args(arguments)
            .output()
            .map_err(|error| {
                format!("Could not start FFmpeg. Install FFmpeg and restart Frameforge: {error}")
            })
    };
    let result = final_result.and_then(|output| ffmpeg_failure("Final cut assembly", output));
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&render_dir);
        return Err(error);
    }

    let assembled = render_dir.join("assembled.mp4");
    let result = if audio_sources.is_empty() {
        fs::copy(&video_only, &assembled)
            .map(|_| ())
            .map_err(|error| format!("Could not assemble final cut: {error}"))
    } else {
        let mut arguments = vec![
            OsString::from("-y"),
            OsString::from("-hide_banner"),
            OsString::from("-loglevel"),
            OsString::from("error"),
            OsString::from("-i"),
            video_only.clone().into_os_string(),
        ];
        let mut filter_parts = Vec::with_capacity(audio_sources.len() + 2);
        let mut mix_inputs = Vec::with_capacity(audio_sources.len() + 1);
        if preserve_native_audio {
            filter_parts.push("[0:a:0]volume=1[base]".to_string());
            mix_inputs.push("[base]".to_string());
        }
        for (index, (source, start, duration, volume)) in audio_sources.iter().enumerate() {
            arguments.extend([OsString::from("-i"), source.clone().into_os_string()]);
            let delay_ms = (start * 1000.0).round() as u64;
            filter_parts.push(format!(
                "[{index_plus}:a]atrim=0:{duration:.3},asetpts=PTS-STARTPTS,volume={volume:.3},adelay={delay_ms}:all=1[a{index}]",
                index_plus = index + 1
            ));
            mix_inputs.push(format!("[a{index}]"));
        }
        let mix_inputs = mix_inputs.join("");
        filter_parts.push(format!(
            "{mix_inputs}amix=inputs={}:duration=longest:dropout_transition=0:normalize=0[aout]",
            audio_sources.len() + usize::from(preserve_native_audio)
        ));
        arguments.extend([
            OsString::from("-filter_complex"),
            OsString::from(filter_parts.join(";")),
            OsString::from("-map"),
            OsString::from("0:v:0"),
            OsString::from("-map"),
            OsString::from("[aout]"),
            OsString::from("-t"),
            OsString::from(format!("{content_duration:.3}")),
            OsString::from("-c:v"),
            OsString::from("libx264"),
            OsString::from("-preset"),
            OsString::from("medium"),
            OsString::from("-crf"),
            OsString::from("20"),
            OsString::from("-pix_fmt"),
            OsString::from("yuv420p"),
            OsString::from("-c:a"),
            OsString::from("aac"),
            OsString::from("-b:a"),
            OsString::from("192k"),
            OsString::from("-movflags"),
            OsString::from("+faststart"),
            assembled.clone().into_os_string(),
        ]);
        Command::new("ffmpeg")
            .args(arguments)
            .output()
            .map_err(|error| {
                format!("Could not start FFmpeg. Install FFmpeg and restart Frameforge: {error}")
            })
            .and_then(|output| ffmpeg_failure("Audio mix", output))
    };
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&render_dir);
        return Err(error);
    }

    let media_for_output = if request.cover_duration > 0.0 || request.end_card_duration > 0.0 {
        let carded = render_dir.join("carded.mp4");
        let has_audio = preserve_native_audio || !audio_sources.is_empty();
        let video_filter = format!(
            "tpad=start_mode=clone:start_duration={:.3}:stop_mode=clone:stop_duration={:.3}",
            request.cover_duration, request.end_card_duration
        );
        let mut arguments = vec![
            OsString::from("-y"),
            OsString::from("-hide_banner"),
            OsString::from("-loglevel"),
            OsString::from("error"),
            OsString::from("-i"),
            assembled.clone().into_os_string(),
            OsString::from("-vf"),
            OsString::from(video_filter),
            OsString::from("-map"),
            OsString::from("0:v:0"),
            OsString::from("-t"),
            OsString::from(format!("{final_duration:.3}")),
        ];
        if has_audio {
            let delay_ms = (request.cover_duration * 1000.0).round() as u64;
            arguments.extend([
                OsString::from("-filter_complex"),
                OsString::from(format!(
                    "[0:a:0]adelay={delay_ms}:all=1,apad,atrim=duration={final_duration:.3}[aout]"
                )),
                OsString::from("-map"),
                OsString::from("[aout]"),
            ]);
        } else {
            arguments.push(OsString::from("-an"));
        }
        arguments.extend([
            OsString::from("-c:v"),
            OsString::from("libx264"),
            OsString::from("-preset"),
            OsString::from("medium"),
            OsString::from("-crf"),
            OsString::from("20"),
            OsString::from("-pix_fmt"),
            OsString::from("yuv420p"),
        ]);
        if has_audio {
            arguments.extend([
                OsString::from("-c:a"),
                OsString::from("aac"),
                OsString::from("-b:a"),
                OsString::from("192k"),
            ]);
        }
        arguments.extend([
            OsString::from("-movflags"),
            OsString::from("+faststart"),
            carded.clone().into_os_string(),
        ]);
        let result = Command::new("ffmpeg")
            .args(arguments)
            .output()
            .map_err(|error| {
                format!("Could not start FFmpeg. Install FFmpeg and restart Frameforge: {error}")
            })
            .and_then(|output| ffmpeg_failure("Cover and end card render", output));
        if let Err(error) = result {
            let _ = fs::remove_dir_all(&render_dir);
            return Err(error);
        }
        carded
    } else {
        assembled.clone()
    };

    let thumbnail_path = {
        let source = if let Some(source) = request
            .thumbnail_source
            .as_deref()
            .filter(|source| !source.trim().is_empty())
        {
            materialize_final_cut_source(
                source,
                request
                    .clips
                    .first()
                    .map(|clip| clip.kind.as_str())
                    .unwrap_or("image"),
                &render_dir.join("thumbnail-source"),
            )
            .await?
        } else {
            materialized_clips
                .first()
                .cloned()
                .ok_or_else(|| "Final cut has no thumbnail source".to_string())?
        };
        let path = output_path.with_extension("jpg");
        let result = Command::new("ffmpeg")
            .args([
                OsString::from("-y"),
                OsString::from("-hide_banner"),
                OsString::from("-loglevel"),
                OsString::from("error"),
                OsString::from("-i"),
                source.into_os_string(),
                OsString::from("-vf"),
                OsString::from(format!(
                    "scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black"
                )),
                OsString::from("-frames:v"),
                OsString::from("1"),
                OsString::from("-q:v"),
                OsString::from("2"),
                path.clone().into_os_string(),
            ])
            .output()
            .map_err(|error| {
                format!("Could not start FFmpeg. Install FFmpeg and restart Frameforge: {error}")
            })
            .and_then(|output| ffmpeg_failure("Thumbnail export", output));
        if let Err(error) = result {
            let _ = fs::remove_dir_all(&render_dir);
            return Err(error);
        }
        Some(path.to_string_lossy().to_string())
    };

    let subtitle_result = if request.subtitles.is_empty() {
        fs::copy(&media_for_output, &output_path)
            .map(|_| ())
            .map_err(|error| format!("Could not write final cut: {error}"))
    } else {
        let body = match subtitle_file(&request.subtitles, content_duration, request.cover_duration)
        {
            Ok(body) => body,
            Err(error) => {
                let _ = fs::remove_dir_all(&render_dir);
                return Err(error);
            }
        };
        if body.trim().is_empty() {
            fs::copy(&media_for_output, &output_path)
                .map(|_| ())
                .map_err(|error| format!("Could not write final cut: {error}"))
        } else {
            let subtitle_path = render_dir.join("subtitles.srt");
            fs::write(&subtitle_path, body).map_err(|error| error.to_string())?;
            Command::new("ffmpeg")
                .args([
                    OsString::from("-y"),
                    OsString::from("-hide_banner"),
                    OsString::from("-loglevel"),
                    OsString::from("error"),
                    OsString::from("-i"),
                    media_for_output.clone().into_os_string(),
                    OsString::from("-f"),
                    OsString::from("srt"),
                    OsString::from("-i"),
                    subtitle_path.into_os_string(),
                    OsString::from("-map"),
                    OsString::from("0:v:0"),
                    OsString::from("-map"),
                    OsString::from("0:a?"),
                    OsString::from("-map"),
                    OsString::from("1:0"),
                    OsString::from("-c:v"),
                    OsString::from("copy"),
                    OsString::from("-c:a"),
                    OsString::from("copy"),
                    OsString::from("-c:s"),
                    OsString::from("mov_text"),
                    OsString::from("-metadata:s:s:0"),
                    OsString::from("language=chi"),
                    OsString::from("-movflags"),
                    OsString::from("+faststart"),
                    output_path.clone().into_os_string(),
                ])
                .output()
                .map_err(|error| {
                    format!(
                        "Could not start FFmpeg. Install FFmpeg and restart Frameforge: {error}"
                    )
                })
                .and_then(|output| ffmpeg_failure("Subtitle render", output))
        }
    };
    let _ = fs::remove_dir_all(&render_dir);
    subtitle_result?;
    Ok(FinalCutExportResult {
        path: output_path.to_string_lossy().to_string(),
        thumbnail_path,
        clip_count: request.clips.len(),
        duration: final_duration,
    })
}

#[tauri::command]
fn save_project(project: Value, state: State<'_, AppState>) -> Result<(), String> {
    let (id, name) = project_identity(&project)?;
    let payload = serde_json::to_string(&project).map_err(|error| error.to_string())?;
    let now = Utc::now().to_rfc3339();
    let path = state
        .db_path
        .lock()
        .map_err(|_| "Project database lock poisoned".to_string())?;
    let connection = open_db(&path)?;
    connection
        .execute(
            "INSERT INTO projects (id, name, payload, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, payload = excluded.payload, updated_at = excluded.updated_at",
            params![id, name, payload, now],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_project(project_id: String, state: State<'_, AppState>) -> Result<Option<Value>, String> {
    let path = state
        .db_path
        .lock()
        .map_err(|_| "Project database lock poisoned".to_string())?;
    let connection = open_db(&path)?;
    let payload = match connection.query_row(
        "SELECT payload FROM projects WHERE id = ?1",
        params![project_id],
        |row| row.get::<_, String>(0),
    ) {
        Ok(payload) => Some(payload),
        Err(RusqliteError::QueryReturnedNoRows) => None,
        Err(error) => return Err(error.to_string()),
    };
    payload
        .map(|raw| serde_json::from_str(&raw).map_err(|error| error.to_string()))
        .transpose()
}

#[tauri::command]
fn list_projects(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let path = state
        .db_path
        .lock()
        .map_err(|_| "Project database lock poisoned".to_string())?;
    let connection = open_db(&path)?;
    let mut statement = connection
        .prepare("SELECT payload FROM projects ORDER BY updated_at DESC")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    rows.map(|row| {
        let payload = row.map_err(|error| error.to_string())?;
        serde_json::from_str::<Value>(&payload).map_err(|error| error.to_string())
    })
    .collect()
}

#[tauri::command]
fn export_project_package(path: String, project: Value) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("Project package path cannot be empty".to_string());
    }
    let package = project_package(project)?;
    let encoded = serde_json::to_string_pretty(&package).map_err(|error| error.to_string())?;
    fs::write(path, encoded).map_err(|error| format!("Could not write project package: {error}"))
}

#[tauri::command]
fn import_project_package(path: String, state: State<'_, AppState>) -> Result<Value, String> {
    if path.trim().is_empty() {
        return Err("Project package path cannot be empty".to_string());
    }
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("Could not read project package: {error}"))?;
    let mut package: ProjectPackage = serde_json::from_str(&raw)
        .map_err(|error| format!("Invalid Frameforge project package: {error}"))?;
    if package.schema_version != 1 {
        return Err(format!(
            "Unsupported project package version: {}",
            package.schema_version
        ));
    }
    strip_sensitive_fields(&mut package.project);
    save_project(package.project.clone(), state)?;
    Ok(package.project)
}

#[tauri::command]
fn enqueue_generation_job(job: StoredJob, state: State<'_, AppState>) -> Result<(), String> {
    if !valid_job_status(&job.status) {
        return Err(format!("Unsupported generation job status: {}", job.status));
    }
    let path = state
        .db_path
        .lock()
        .map_err(|_| "Project database lock poisoned".to_string())?;
    let connection = open_db(&path)?;
    let payload = serde_json::to_string(&job.payload).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO generation_jobs (id, project_id, kind, status, payload, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload = excluded.payload, updated_at = excluded.updated_at",
            params![job.id, job.project_id, job.kind, job.status, payload, job.created_at, job.updated_at],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn list_generation_jobs(
    project_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<StoredJob>, String> {
    let path = state
        .db_path
        .lock()
        .map_err(|_| "Project database lock poisoned".to_string())?;
    let connection = open_db(&path)?;
    let mut statement = connection
        .prepare(
            "SELECT id, project_id, kind, status, payload, created_at, updated_at
             FROM generation_jobs WHERE project_id = ?1 ORDER BY updated_at DESC",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![project_id], |row| {
            let raw_payload: String = row.get(4)?;
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                raw_payload,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    rows.map(|row| {
        let (id, project_id, kind, status, payload, created_at, updated_at) =
            row.map_err(|error| error.to_string())?;
        Ok(StoredJob {
            id,
            project_id,
            kind,
            status,
            payload: serde_json::from_str(&payload).map_err(|error| error.to_string())?,
            created_at,
            updated_at,
        })
    })
    .collect()
}

fn append_task_id_to_payload(payload: &mut Value, task_id: &str) -> Result<(), String> {
    let fields = payload
        .as_object_mut()
        .ok_or_else(|| "Generation job payload must be an object".to_string())?;
    let task_ids = fields
        .entry("taskIds".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    let task_ids = task_ids
        .as_array_mut()
        .ok_or_else(|| "Generation job taskIds must be an array".to_string())?;
    if !task_ids
        .iter()
        .any(|stored| stored.as_str() == Some(task_id))
    {
        task_ids.push(Value::String(task_id.to_string()));
    }
    Ok(())
}

#[tauri::command]
fn append_generation_task_id(
    job_id: String,
    task_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if task_id.trim().is_empty() {
        return Err("Generation task id cannot be empty".to_string());
    }
    let path = state
        .db_path
        .lock()
        .map_err(|_| "Project database lock poisoned".to_string())?;
    let mut connection = open_db(&path)?;
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let raw_payload: String = transaction
        .query_row(
            "SELECT payload FROM generation_jobs WHERE id = ?1",
            params![job_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let mut payload: Value =
        serde_json::from_str(&raw_payload).map_err(|error| error.to_string())?;
    append_task_id_to_payload(&mut payload, &task_id)?;
    let payload = serde_json::to_string(&payload).map_err(|error| error.to_string())?;
    let changed = transaction
        .execute(
            "UPDATE generation_jobs SET status = 'polling', payload = ?1, updated_at = ?2 WHERE id = ?3",
            params![payload, Utc::now().to_rfc3339(), job_id],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("Generation job does not exist".to_string());
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn update_job_status(
    job_id: String,
    status: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if !valid_job_status(&status) {
        return Err(format!("Unsupported generation job status: {status}"));
    }
    let path = state
        .db_path
        .lock()
        .map_err(|_| "Project database lock poisoned".to_string())?;
    let connection = open_db(&path)?;
    connection
        .execute(
            "UPDATE generation_jobs SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![status, Utc::now().to_rfc3339(), job_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn save_provider_credential(provider_id: String, api_key: String) -> Result<(), String> {
    if api_key.trim().is_empty() {
        return Err("API key cannot be empty".to_string());
    }
    if provider_id.trim().is_empty() {
        return Err("Provider id cannot be empty".to_string());
    }
    let entry = Entry::new(KEYCHAIN_SERVICE, &format!("{CREDENTIAL_ACCOUNT_PREFIX}{provider_id}"))
        .map_err(|error| error.to_string())?;
    entry
        .set_password(api_key.trim())
        .map_err(|error| error.to_string())
}

/// 内部读取凭据。API Key 只存在系统钥匙串，前端拿不到明文。
pub(crate) fn provider_credential(provider_id: &str) -> Result<Option<String>, String> {
    let entry = Entry::new(KEYCHAIN_SERVICE, &format!("{CREDENTIAL_ACCOUNT_PREFIX}{provider_id}"))
        .map_err(|error| error.to_string())?;
    match entry.get_password() {
        Ok(api_key) => Ok(Some(api_key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn save_provider_settings(
    settings: StoredProviderSettings,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if settings.provider_id.trim().is_empty()
        || settings.base_url.trim().is_empty()
        || settings.model.trim().is_empty()
    {
        return Err("Provider settings require provider id, base URL, and model".to_string());
    }
    let path = state
        .db_path
        .lock()
        .map_err(|_| "Project database lock poisoned".to_string())?;
    let connection = open_db(&path)?;
    connection
        .execute(
            "INSERT INTO provider_settings (provider_id, base_url, model, text_model, voice) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(provider_id) DO UPDATE SET base_url = excluded.base_url, model = excluded.model, text_model = excluded.text_model, voice = excluded.voice",
            params![settings.provider_id, settings.base_url, settings.model, settings.text_model, settings.voice],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn list_provider_settings(
    state: State<'_, AppState>,
) -> Result<Vec<StoredProviderSettings>, String> {
    let path = state
        .db_path
        .lock()
        .map_err(|_| "Project database lock poisoned".to_string())?;
    let connection = open_db(&path)?;
    let mut statement = connection
        .prepare("SELECT provider_id, base_url, model, text_model, voice FROM provider_settings ORDER BY provider_id")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(StoredProviderSettings {
                provider_id: row.get(0)?,
                base_url: row.get(1)?,
                model: row.get(2)?,
                text_model: row.get(3)?,
                voice: row.get(4)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.map(|row| row.map_err(|error| error.to_string()))
        .collect()
}

#[tauri::command]
fn load_current_project_id(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let path = state
        .db_path
        .lock()
        .map_err(|_| "Project database lock poisoned".to_string())?;
    let connection = open_db(&path)?;
    match connection.query_row(
        "SELECT value FROM app_settings WHERE key = 'current_project_id'",
        [],
        |row| row.get::<_, String>(0),
    ) {
        Ok(project_id) => Ok(Some(project_id)),
        Err(RusqliteError::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn save_current_project_id(project_id: String, state: State<'_, AppState>) -> Result<(), String> {
    if project_id.trim().is_empty() {
        return Err("Current project id cannot be empty".to_string());
    }
    let path = state
        .db_path
        .lock()
        .map_err(|_| "Project database lock poisoned".to_string())?;
    let connection = open_db(&path)?;
    connection
        .execute(
            "INSERT INTO app_settings (key, value) VALUES ('current_project_id', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![project_id],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
async fn generate_gpt_image(request: GptImageRequest) -> Result<Vec<GeneratedImage>, String> {
    if request.api_key.trim().is_empty() {
        return Err("Missing GPT Image API key".to_string());
    }
    if request.prompt.trim().is_empty() {
        return Err("Image prompt cannot be empty".to_string());
    }

    let client = http_client()?;
    let response = if let Some(reference_images) =
        request.reference_images.filter(|images| !images.is_empty())
    {
        let mut form = reqwest::multipart::Form::new()
            .text("model", request.model.clone())
            .text("prompt", request.prompt.clone())
            .text("n", "1");
        if let Some(size) = request.size.clone() {
            form = form.text("size", size);
        }
        if let Some(quality) = request.quality.clone() {
            form = form.text("quality", quality);
        }
        for (index, source) in reference_images.iter().enumerate() {
            let bytes = read_media_source(source).await?;
            let part = reqwest::multipart::Part::bytes(bytes)
                .file_name(format!("reference-{index}.png"))
                .mime_str("image/png")
                .map_err(|error| format!("Invalid reference image: {error}"))?;
            form = form.part("image[]", part);
        }
        client
            .post(format!(
                "{}/images/edits",
                request.base_url.trim_end_matches('/')
            ))
            .bearer_auth(&request.api_key)
            .multipart(form)
            .send()
            .await
            .map_err(|error| format!("Image edit request failed: {error}"))?
    } else {
        let mut payload =
            json!({ "model": request.model.clone(), "prompt": request.prompt.clone(), "n": 1 });
        if let Some(size) = request.size {
            payload["size"] = Value::String(size);
        }
        if let Some(quality) = request.quality {
            payload["quality"] = Value::String(quality);
        }
        client
            .post(format!(
                "{}/images/generations",
                request.base_url.trim_end_matches('/')
            ))
            .bearer_auth(&request.api_key)
            .json(&payload)
            .send()
            .await
            .map_err(|error| format!("Image request failed: {error}"))?
    };
    let status = response.status();
    let raw = response.text().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!("Image provider returned {status}: {raw}"));
    }
    let parsed: ImageResponse =
        serde_json::from_str(&raw).map_err(|error| format!("Invalid image response: {error}"))?;
    parsed
        .data
        .into_iter()
        .map(|asset| {
            let url = match (asset.url, asset.b64_json) {
                (Some(url), _) => url,
                (None, Some(base64)) => {
                    STANDARD
                        .decode(base64.as_bytes())
                        .map_err(|error| error.to_string())?;
                    format!("data:image/png;base64,{base64}")
                }
                (None, None) => return Err("Image response has no URL or base64 asset".to_string()),
            };
            Ok(GeneratedImage {
                url,
                revised_prompt: asset.revised_prompt,
                provider: "GPT Image".to_string(),
                model: request.model.clone(),
            })
        })
        .collect()
}

fn bytedance_video_payload(request: &VideoGenerationRequest) -> Value {
    let mut content = vec![json!({ "type": "text", "text": request.prompt })];
    let image_parts = [
        (request.start_frame_url.as_deref(), "first_frame"),
        (request.end_frame_url.as_deref(), "last_frame"),
        (request.middle_frame_url.as_deref(), "reference_image"),
    ];
    for (url, role) in image_parts
        .into_iter()
        .filter_map(|(url, role)| url.map(|url| (url, role)))
    {
        content.push(json!({
            "type": "image_url",
            "image_url": { "url": url },
            "role": role
        }));
    }
    let specific_urls = [
        request.start_frame_url.as_deref(),
        request.end_frame_url.as_deref(),
        request.middle_frame_url.as_deref(),
    ];
    if let Some(reference_images) = request.reference_image_urls.as_ref() {
        for url in reference_images.iter().filter(|url| {
            !url.trim().is_empty()
                && !specific_urls
                    .iter()
                    .flatten()
                    .any(|specific| *specific == url.as_str())
        }) {
            content.push(json!({
                "type": "image_url",
                "image_url": { "url": url },
                "role": "reference_image"
            }));
        }
    }
    json!({
        "model": request.model,
        "content": content,
        "ratio": request.aspect_ratio,
        "duration": request.duration,
        "generate_audio": request.generate_audio.unwrap_or(false)
    })
}

fn grok_video_payload(request: &VideoGenerationRequest) -> Value {
    let mut payload = json!({
        "model": request.model,
        "prompt": request.prompt,
        "duration": request.duration,
        "aspect_ratio": request.aspect_ratio,
        "resolution": "720p"
    });
    if let Some(url) = request.start_frame_url.as_deref() {
        payload["image"] = json!({ "url": url });
    }
    let mut reference_images = Vec::new();
    for url in [
        request.end_frame_url.as_deref(),
        request.middle_frame_url.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        reference_images.push(json!({ "url": url }));
    }
    if let Some(extra) = request.reference_image_urls.as_ref() {
        for url in extra.iter().filter(|url| {
            !url.trim().is_empty()
                && ![
                    request.start_frame_url.as_deref(),
                    request.end_frame_url.as_deref(),
                    request.middle_frame_url.as_deref(),
                ]
                .into_iter()
                .flatten()
                .any(|specific| specific == url.as_str())
        }) {
            reference_images.push(json!({ "url": url }));
        }
    }
    if !reference_images.is_empty() {
        payload["reference_images"] = Value::Array(reference_images);
    }
    payload
}

fn gemini_video_payload(
    request: &VideoGenerationRequest,
    start_image: Option<Value>,
    end_image: Option<Value>,
    middle_image: Option<Value>,
    additional_images: Vec<Value>,
) -> Value {
    let mut instance = json!({ "prompt": request.prompt });
    if let Some(image) = start_image {
        instance["image"] = image;
    }
    if let Some(image) = end_image {
        instance["lastFrame"] = image;
    }
    let mut parameters = json!({
        "aspectRatio": request.aspect_ratio,
        "durationSeconds": request.duration,
        "sampleCount": 1,
        "generateAudio": request.generate_audio.unwrap_or(false)
    });
    let mut reference_images = Vec::new();
    if let Some(image) = middle_image {
        reference_images.push(json!({ "image": image, "referenceType": "asset" }));
    }
    reference_images.extend(
        additional_images
            .into_iter()
            .map(|image| json!({ "image": image, "referenceType": "asset" })),
    );
    if !reference_images.is_empty() {
        parameters["referenceImages"] = Value::Array(reference_images);
    }
    json!({ "instances": [instance], "parameters": parameters })
}

fn image_mime_type(source: &str) -> &'static str {
    if let Some(metadata) = source
        .strip_prefix("data:")
        .and_then(|value| value.split_once(',').map(|(metadata, _)| metadata))
    {
        if metadata.starts_with("image/jpeg") {
            return "image/jpeg";
        }
        if metadata.starts_with("image/webp") {
            return "image/webp";
        }
        if metadata.starts_with("image/gif") {
            return "image/gif";
        }
    }
    let path = source
        .split('?')
        .next()
        .unwrap_or(source)
        .to_ascii_lowercase();
    if path.ends_with(".jpg") || path.ends_with(".jpeg") {
        "image/jpeg"
    } else if path.ends_with(".webp") {
        "image/webp"
    } else if path.ends_with(".gif") {
        "image/gif"
    } else {
        "image/png"
    }
}

async fn gemini_image_part(source: &str) -> Result<Value, String> {
    let bytes = read_media_source(source).await?;
    Ok(json!({
        "bytesBase64Encoded": STANDARD.encode(bytes),
        "mimeType": image_mime_type(source)
    }))
}

#[tauri::command]
async fn submit_video_generation(
    request: VideoGenerationRequest,
) -> Result<VideoGenerationTask, String> {
    if request.api_key.trim().is_empty() {
        return Err("Missing video provider API key".to_string());
    }
    if request.prompt.trim().is_empty() {
        return Err("Video prompt cannot be empty".to_string());
    }
    if request.model.trim().is_empty() {
        return Err("Missing video model name".to_string());
    }

    let client = http_client()?;
    match request.provider_id.as_str() {
        "bytedance-video" => {
            let payload = bytedance_video_payload(&request);
            let mut request_builder = client
                .post(video_api_url(
                    &request.base_url,
                    "contents/generations/tasks",
                ))
                .bearer_auth(&request.api_key);
            if let Some(request_id) = request.client_request_id.as_deref() {
                request_builder = request_builder.header("Idempotency-Key", request_id);
            }
            let response = request_builder
                .json(&payload)
                .send()
                .await
                .map_err(|error| format!("ByteDance video request failed: {error}"))?;
            let value = provider_json(response, "ByteDance video provider").await?;
            task_from_response("ByteDance Video", Some(request.model), &value)
        }
        "grok-video" => {
            let payload = grok_video_payload(&request);
            let mut request_builder = client
                .post(video_api_url(&request.base_url, "videos/generations"))
                .bearer_auth(&request.api_key);
            if let Some(request_id) = request.client_request_id.as_deref() {
                request_builder = request_builder.header("Idempotency-Key", request_id);
            }
            let response = request_builder
                .json(&payload)
                .send()
                .await
                .map_err(|error| format!("Grok video request failed: {error}"))?;
            let value = provider_json(response, "Grok video provider").await?;
            task_from_response("Grok Video", Some(request.model), &value)
        }
        "gemini-video" => {
            let start_image = match request.start_frame_url.as_deref() {
                Some(source) => Some(gemini_image_part(source).await?),
                None => None,
            };
            let end_image = match request.end_frame_url.as_deref() {
                Some(source) => Some(gemini_image_part(source).await?),
                None => None,
            };
            let middle_image = match request.middle_frame_url.as_deref() {
                Some(source) => Some(gemini_image_part(source).await?),
                None => None,
            };
            let mut additional_images = Vec::new();
            if let Some(reference_images) = request.reference_image_urls.as_ref() {
                for source in reference_images {
                    if [
                        request.start_frame_url.as_deref(),
                        request.end_frame_url.as_deref(),
                        request.middle_frame_url.as_deref(),
                    ]
                    .into_iter()
                    .flatten()
                    .any(|specific| specific == source.as_str())
                    {
                        continue;
                    }
                    additional_images.push(gemini_image_part(source).await?);
                }
            }
            let payload = gemini_video_payload(
                &request,
                start_image,
                end_image,
                middle_image,
                additional_images,
            );
            let mut request_builder = client
                .post(video_api_url(
                    &request.base_url,
                    &format!("models/{}:predictLongRunning", request.model),
                ))
                .header("x-goog-api-key", &request.api_key);
            if let Some(request_id) = request.client_request_id.as_deref() {
                request_builder = request_builder.header("Idempotency-Key", request_id);
            }
            let response = request_builder
                .json(&payload)
                .send()
                .await
                .map_err(|error| format!("Gemini video request failed: {error}"))?;
            let value = provider_json(response, "Gemini video provider").await?;
            task_from_response("Gemini / Veo", Some(request.model), &value)
        }
        _ => Err(format!(
            "Unsupported video provider: {}",
            request.provider_id
        )),
    }
}

#[tauri::command]
async fn poll_video_generation(request: VideoTaskRequest) -> Result<VideoGenerationTask, String> {
    if request.api_key.trim().is_empty() {
        return Err("Missing video provider API key".to_string());
    }
    let path = match request.provider_id.as_str() {
        "bytedance-video" => format!("contents/generations/tasks/{}", request.task_id),
        "grok-video" => format!("videos/{}", request.task_id),
        "gemini-video" => request.task_id.clone(),
        _ => {
            return Err(format!(
                "Unsupported video provider: {}",
                request.provider_id
            ))
        }
    };
    let name = match request.provider_id.as_str() {
        "bytedance-video" => "ByteDance Video",
        "gemini-video" => "Gemini / Veo",
        _ => "Grok Video",
    };
    let client = http_client()?;
    let request_builder = client.get(video_api_url(&request.base_url, &path));
    let response = if request.provider_id == "gemini-video" {
        request_builder.header("x-goog-api-key", &request.api_key)
    } else {
        request_builder.bearer_auth(&request.api_key)
    }
    .send()
    .await
    .map_err(|error| format!("{name} polling request failed: {error}"))?;
    let value = provider_json(response, name).await?;
    task_from_response(name, None, &value)
}

#[tauri::command]
async fn cancel_video_generation(request: VideoTaskRequest) -> Result<(), String> {
    if request.api_key.trim().is_empty() {
        return Err("Missing video provider API key".to_string());
    }
    let path = match request.provider_id.as_str() {
        "bytedance-video" => format!("contents/generations/tasks/{}/cancel", request.task_id),
        "grok-video" => format!("videos/{}/cancel", request.task_id),
        "gemini-video" => format!("{}:cancel", request.task_id),
        _ => {
            return Err(format!(
                "Unsupported video provider: {}",
                request.provider_id
            ))
        }
    };
    let client = http_client()?;
    let request_builder = client.post(video_api_url(&request.base_url, &path));
    let response = if request.provider_id == "gemini-video" {
        request_builder.header("x-goog-api-key", &request.api_key)
    } else {
        request_builder.bearer_auth(&request.api_key)
    }
    .send()
    .await
    .map_err(|error| format!("Video cancellation request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        let raw = response.text().await.map_err(|error| error.to_string())?;
        return Err(format!("Video cancellation returned {status}: {raw}"));
    }
    Ok(())
}

#[tauri::command]
async fn generate_text(request: TextGenerationRequest) -> Result<String, String> {
    if request.api_key.trim().is_empty() {
        return Err("Missing text model API key".to_string());
    }
    if request.model.trim().is_empty() {
        return Err("Missing text model name".to_string());
    }
    let url = format!(
        "{}/chat/completions",
        request.base_url.trim_end_matches('/')
    );
    let response = http_client()?
        .post(url)
        .bearer_auth(request.api_key)
        .json(&json!({
            "model": request.model,
            "temperature": 0.45,
            "messages": [
                { "role": "system", "content": request.system_prompt },
                { "role": "user", "content": request.user_prompt }
            ]
        }))
        .send()
        .await
        .map_err(|error| format!("Text request failed: {error}"))?;
    let status = response.status();
    let raw = response.text().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        return Err(format!("Text provider returned {status}: {raw}"));
    }
    let parsed: Value =
        serde_json::from_str(&raw).map_err(|error| format!("Invalid text response: {error}"))?;
    chat_content(&parsed)
        .filter(|text| !text.trim().is_empty())
        .ok_or_else(|| "Text response has no message content".to_string())
}

#[tauri::command]
async fn generate_speech(request: SpeechGenerationRequest) -> Result<String, String> {
    if request.api_key.trim().is_empty() {
        return Err("Missing speech provider API key".to_string());
    }
    if request.model.trim().is_empty() || request.voice.trim().is_empty() {
        return Err("Speech model and voice are required".to_string());
    }
    if request.input.trim().is_empty() || request.input.chars().count() > 4096 {
        return Err("Speech input must contain 1 to 4096 characters".to_string());
    }
    let response_format = request.response_format.unwrap_or_else(|| "mp3".to_string());
    if !matches!(
        response_format.as_str(),
        "mp3" | "wav" | "opus" | "aac" | "flac" | "pcm"
    ) {
        return Err("Unsupported speech response format".to_string());
    }
    let response = http_client()?
        .post(format!(
            "{}/audio/speech",
            request.base_url.trim_end_matches('/')
        ))
        .bearer_auth(request.api_key)
        .json(&json!({
            "model": request.model,
            "voice": request.voice,
            "input": request.input,
            "response_format": response_format
        }))
        .send()
        .await
        .map_err(|error| format!("Speech request failed: {error}"))?;
    let status = response.status();
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if !status.is_success() {
        let raw = String::from_utf8_lossy(&bytes);
        return Err(format!("Speech provider returned {status}: {raw}"));
    }
    if bytes.len() > 50 * 1024 * 1024 {
        return Err("Generated speech exceeds the 50 MB local limit".to_string());
    }
    let mime = match response_format.as_str() {
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "opus" => "audio/ogg",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        _ => "audio/L16",
    };
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

fn media_extension(kind: &str, file_name: &str) -> Result<&'static str, String> {
    let requested = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let extension = match kind {
        "image" => match requested.as_str() {
            "png" => "png",
            "jpg" | "jpeg" => "jpg",
            "webp" => "webp",
            _ => "png",
        },
        "video" => match requested.as_str() {
            "mp4" => "mp4",
            "webm" => "webm",
            "mov" => "mov",
            _ => "mp4",
        },
        "audio" => match requested.as_str() {
            "mp3" => "mp3",
            "wav" => "wav",
            "m4a" => "m4a",
            "aac" => "aac",
            "ogg" | "opus" => "ogg",
            "flac" => "flac",
            _ => "bin",
        },
        _ => return Err(format!("Unsupported media asset type: {kind}")),
    };
    Ok(extension)
}

fn media_stem(file_name: &str) -> String {
    let raw = Path::new(file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("asset");
    let stem: String = raw
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        .take(80)
        .collect();
    if stem.is_empty() {
        "asset".to_string()
    } else {
        stem
    }
}

async fn read_media_source(source: &str) -> Result<Vec<u8>, String> {
    if let Some(encoded) = source.strip_prefix("data:") {
        let (_, encoded) = encoded
            .split_once(',')
            .ok_or_else(|| "Invalid base64 media asset".to_string())?;
        return STANDARD
            .decode(encoded.as_bytes())
            .map_err(|error| format!("Invalid base64 media asset: {error}"));
    }
    if let Some(path) = source.strip_prefix("file://") {
        return fs::read(path).map_err(|error| format!("Could not read media asset: {error}"));
    }
    let local = Path::new(source);
    if local.is_file() {
        return fs::read(local).map_err(|error| format!("Could not read media asset: {error}"));
    }
    if !(source.starts_with("https://") || source.starts_with("http://")) {
        return Err(
            "Media asset must be a local file, base64 data URL, or HTTP(S) URL".to_string(),
        );
    }
    let mut response = http_client()?
        .get(source)
        .send()
        .await
        .map_err(|error| format!("Could not download media asset: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Could not download media asset: {}",
            response.status()
        ));
    }
    if response.content_length().unwrap_or_default() > 512 * 1024 * 1024 {
        return Err("Media asset exceeds the 512 MB local limit".to_string());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Could not read media asset: {error}"))?
    {
        if bytes.len().saturating_add(chunk.len()) > 512 * 1024 * 1024 {
            return Err("Media asset exceeds the 512 MB local limit".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[tauri::command]
async fn store_media_asset(
    request: StoreMediaAssetRequest,
    state: State<'_, AppState>,
) -> Result<String, String> {
    if request.source.trim().is_empty() {
        return Err("Media asset source cannot be empty".to_string());
    }
    let extension = media_extension(&request.kind, &request.file_name)?;
    let bytes = read_media_source(&request.source).await?;
    if bytes.is_empty() || bytes.len() > 512 * 1024 * 1024 {
        return Err("Media asset must be between 1 byte and 512 MB".to_string());
    }
    let app_data = state
        .db_path
        .lock()
        .map_err(|_| "Project database lock poisoned".to_string())?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Could not resolve app data folder".to_string())?;
    let directory = app_data.join("assets").join(&request.kind);
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let target = directory.join(format!(
        "{}-{}.{}",
        media_stem(&request.file_name),
        Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        extension
    ));
    fs::write(&target, bytes).map_err(|error| format!("Could not store media asset: {error}"))?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
fn store_audio_asset(
    data_url: String,
    file_name: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let encoded = data_url
        .strip_prefix("data:audio/")
        .and_then(|value| value.split_once(',').map(|(_, encoded)| encoded))
        .ok_or_else(|| "Generated audio must be a base64 data URL".to_string())?;
    let bytes = STANDARD
        .decode(encoded.as_bytes())
        .map_err(|error| format!("Invalid generated audio: {error}"))?;
    if bytes.is_empty() || bytes.len() > 50 * 1024 * 1024 {
        return Err("Generated audio must be between 1 byte and 50 MB".to_string());
    }
    let extension = Path::new(&file_name)
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| matches!(*value, "mp3" | "wav" | "opus" | "aac" | "flac" | "pcm"))
        .unwrap_or("mp3");
    let app_data = state
        .db_path
        .lock()
        .map_err(|_| "Project database lock poisoned".to_string())?
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Could not resolve app data folder".to_string())?;
    let audio_dir = app_data.join("assets").join("audio");
    fs::create_dir_all(&audio_dir).map_err(|error| error.to_string())?;
    let target = audio_dir.join(format!(
        "generated-{}.{}",
        Utc::now().timestamp_nanos_opt().unwrap_or_default(),
        extension
    ));
    fs::write(&target, bytes)
        .map_err(|error| format!("Could not store generated audio: {error}"))?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
fn list_studio_projects(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    let mut statement = connection
        .prepare("SELECT payload FROM studio_projects ORDER BY updated_at DESC")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    rows.map(|row| {
        serde_json::from_str(&row.map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())
    })
    .collect()
}

#[tauri::command]
fn save_studio_project(mut project: Value, state: State<'_, AppState>) -> Result<(), String> {
    let id = project
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or("项目缺少 id")?
        .to_string();
    let name = project
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or("项目缺少名称")?
        .to_string();
    strip_sensitive_fields(&mut project);
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    let now = Utc::now().to_rfc3339();
    connection
        .execute(
            "INSERT INTO studio_projects (id, name, payload, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, payload=excluded.payload, updated_at=excluded.updated_at",
            params![id, name, serde_json::to_string(&project).map_err(|error| error.to_string())?, now],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn list_boards(project_id: String, state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    let mut statement = connection
        .prepare("SELECT payload FROM boards WHERE project_id=?1 ORDER BY updated_at DESC")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([project_id], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    rows.map(|row| {
        serde_json::from_str(&row.map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())
    })
    .collect()
}

#[tauri::command]
fn load_board(board_id: String, state: State<'_, AppState>) -> Result<Option<Value>, String> {
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    let mut statement = connection
        .prepare("SELECT payload FROM boards WHERE id=?1")
        .map_err(|error| error.to_string())?;
    let mut rows = statement.query([board_id]).map_err(|error| error.to_string())?;
    match rows.next().map_err(|error| error.to_string())? {
        Some(row) => Ok(Some(
            serde_json::from_str(&row.get::<_, String>(0).map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())?,
        )),
        None => Ok(None),
    }
}

#[tauri::command]
fn save_board(mut board: Value, state: State<'_, AppState>) -> Result<(), String> {
    let id = board
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or("画布缺少 id")?
        .to_string();
    let project_id = board
        .get("projectId")
        .and_then(Value::as_str)
        .ok_or("画布缺少 projectId")?
        .to_string();
    let name = board
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("未命名画布")
        .to_string();
    strip_sensitive_fields(&mut board);
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    let now = Utc::now().to_rfc3339();
    connection
        .execute(
            "INSERT INTO boards (id, project_id, name, payload, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, payload=excluded.payload, updated_at=excluded.updated_at",
            params![id, project_id, name, serde_json::to_string(&board).map_err(|error| error.to_string())?, now],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_board(board_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    db::open(&path)?
        .execute("DELETE FROM boards WHERE id=?1", [board_id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn list_provider_profiles(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    let mut statement = connection
        .prepare("SELECT payload FROM provider_profiles ORDER BY id")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    rows.map(|row| {
        serde_json::from_str(&row.map_err(|error| error.to_string())?)
            .map_err(|error| error.to_string())
    })
    .collect()
}

/// 远端地址校验失败时保留错误码，方便前端提示与日志排查区分具体原因。
fn remote_url_error(error: gateway::AppError) -> String {
    format!("{}（{}）", error.message, error.code)
}

/// Provider 的 Base URL：留空表示未配置，放行；否则必须是公网 https。
fn validate_provider_base_url(base_url: &str) -> Result<(), String> {
    let trimmed = base_url.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    security::validate_remote_url(trimmed)
        .map(|_| ())
        .map_err(remote_url_error)
}

/// 素材外链：S3 策略下的 endpoint 与公网前缀都必须是公网 https。
fn validate_asset_host_urls(config: &Value) -> Result<(), String> {
    let strategy = config.get("strategy").and_then(Value::as_str).unwrap_or("");
    let endpoint = config
        .get("endpoint")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let public_base_url = config
        .get("publicBaseUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if strategy == "s3" && !endpoint.is_empty() {
        security::validate_remote_url(endpoint).map_err(remote_url_error)?;
    }
    if !public_base_url.is_empty() {
        security::validate_remote_url(public_base_url).map_err(remote_url_error)?;
    }
    Ok(())
}

/// 落库的素材外链配置：去掉密钥，固定 schemaVersion。
fn asset_host_payload(config: &Value) -> Value {
    let mut object = config.as_object().cloned().unwrap_or_default();
    object.remove("accessKey");
    object.remove("secretKey");
    object.insert("schemaVersion".to_string(), json!(1));
    Value::Object(object)
}

/// 回读给前端的素材外链配置：带 schemaVersion（存量数据默认 1），且不含任何明文密钥。
fn asset_host_response(config: &gateway::transport::AssetHostConfig) -> Value {
    json!({
        "schemaVersion": config.schema_version,
        "strategy": config.strategy,
        "endpoint": config.endpoint,
        "bucket": config.bucket,
        "region": config.region,
        "prefix": config.prefix,
        "publicBaseUrl": config.public_base_url,
        "hasCredentials": config.access_key.is_some() && config.secret_key.is_some()
    })
}

#[tauri::command]
fn save_provider_profile(mut profile: Value, state: State<'_, AppState>) -> Result<(), String> {
    strip_sensitive_fields(&mut profile);
    let id = profile
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or("Provider 缺少 id")?
        .to_string();
    let adapter = profile
        .get("adapter")
        .and_then(Value::as_str)
        .unwrap_or("openai-compatible")
        .to_string();
    let base_url = profile
        .get("baseUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    validate_provider_base_url(&base_url)?;
    // 落库的值与校验过的值保持一致，避免前后空格绕过校验。
    if let Some(object) = profile.as_object_mut() {
        object.insert("baseUrl".to_string(), json!(base_url.clone()));
    }
    let enabled = profile
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    connection
        .execute(
            "INSERT INTO provider_profiles (id, adapter, base_url, enabled, payload, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET adapter=excluded.adapter, base_url=excluded.base_url, enabled=excluded.enabled, payload=excluded.payload, updated_at=excluded.updated_at",
            params![id, adapter, base_url, enabled, serde_json::to_string(&profile).map_err(|error| error.to_string())?, Utc::now().to_rfc3339()],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn provider_has_key(provider_id: String) -> Result<bool, String> {
    Ok(provider_credential(&provider_id)?.is_some())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderTestResult {
    ok: bool,
    message: String,
    model_count: Option<usize>,
}

#[tauri::command]
async fn test_provider_profile(
    provider_id: String,
    state: State<'_, AppState>,
) -> Result<ProviderTestResult, String> {
    let profile = runs::load_provider_profile(&state, &provider_id)?
        .ok_or_else(|| "Provider 未配置".to_string())?;
    let key = provider_credential(&provider_id)?
        .ok_or_else(|| "尚未保存 API Key".to_string())?;
    let client = http_client()?;
    if profile.adapter == "openai-compatible" {
        let url = if profile.base_url.trim_end_matches('/').ends_with("/v1") {
            format!("{}/models", profile.base_url.trim_end_matches('/'))
        } else {
            format!("{}/v1/models", profile.base_url.trim_end_matches('/'))
        };
        let response = client
            .get(url)
            .bearer_auth(&key)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        let status = response.status();
        let value: Value = response.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            let count = value.get("data").and_then(Value::as_array).map(Vec::len);
            return Ok(ProviderTestResult {
                ok: true,
                message: "连接成功".to_string(),
                model_count: count,
            });
        }
        return Ok(ProviderTestResult {
            ok: false,
            message: format!("连接失败：HTTP {}", status.as_u16()),
            model_count: None,
        });
    }
    Ok(ProviderTestResult {
        ok: true,
        message: "配置已保存，视频接口将在首次生成时验证".to_string(),
        model_count: None,
    })
}

#[tauri::command]
fn save_asset_host(config: Value, state: State<'_, AppState>) -> Result<(), String> {
    validate_asset_host_urls(&config)?;
    let access_key = config
        .get("accessKey")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let secret_key = config
        .get("secretKey")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if !access_key.is_empty() {
        Entry::new(KEYCHAIN_SERVICE, "asset-host/access-key")
            .map_err(|error| error.to_string())?
            .set_password(&access_key)
            .map_err(|error| error.to_string())?;
    }
    if !secret_key.is_empty() {
        Entry::new(KEYCHAIN_SERVICE, "asset-host/secret-key")
            .map_err(|error| error.to_string())?
            .set_password(&secret_key)
            .map_err(|error| error.to_string())?;
    }
    let public = asset_host_payload(&config);
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    db::open(&path)?
        .execute(
            "INSERT INTO app_settings (key, value) VALUES ('asset_host', ?1)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [serde_json::to_string(&public).map_err(|error| error.to_string())?],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn load_asset_host(state: State<'_, AppState>) -> Result<Value, String> {
    let config = asset_host_internal(&state)?;
    Ok(asset_host_response(&config))
}

#[tauri::command]
async fn start_run(
    request: runs::StartRunRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<runs::RunRecord, String> {
    let profile = runs::load_provider_profile(&state, &request.provider_id)?
        .ok_or_else(|| "Provider 未配置".to_string())?;
    if !profile.enabled {
        return Err("Provider 已禁用".to_string());
    }
    if let Some(asset_id) = request.cached_asset_id.clone() {
        return runs::finish_cached(&state, &request, &asset_id);
    }
    let key = provider_credential(&request.provider_id)?
        .ok_or_else(|| "尚未保存该 Provider 的 API Key".to_string())?;
    let runtime = gateway::ProviderRuntime {
        profile: profile.clone(),
        api_key: key,
    };
    let run = runs::create_run(&state, &request)?;
    let job_id = format!("job_{}", uuid::Uuid::new_v4());
    // 同步能力不建 job 行：否则下次启动的恢复扫描会把它当成「提交阶段被中断」。
    let is_async = profile
        .models
        .iter()
        .find(|model| model.id == request.model)
        .and_then(|model| model.capability(&request.capability))
        .map(|capability| capability.async_job)
        .unwrap_or(false);
    let db_path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    if is_async {
        db::open(&db_path)?
            .execute(
                "INSERT INTO jobs (id, run_id, provider_id, capability, status, attempts, payload, updated_at) VALUES (?1, ?2, ?3, ?4, 'queued', 0, ?5, ?6)",
                params![job_id, run.id, request.provider_id, request.capability, serde_json::to_string(&request).map_err(|error| error.to_string())?, Utc::now().to_rfc3339()],
            )
            .map_err(|error| error.to_string())?;
    }
    let state_owned = AppState {
        db_path: Mutex::new(db_path),
        data_dir: state.data_dir.clone(),
    };
    let app_clone = app.clone();
    let run_clone = run.clone();
    tauri::async_runtime::spawn(async move {
        runs::execute_run(app_clone, state_owned, run_clone, job_id, request, runtime).await;
    });
    Ok(run)
}

#[tauri::command]
fn cancel_run(run_id: String, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    jobs::cancel(&app, &state, &run_id);
    Ok(())
}

#[tauri::command]
fn list_runs(board_id: String, state: State<'_, AppState>) -> Result<Vec<runs::RunRecord>, String> {
    runs::list_runs(&state, &board_id)
}

#[tauri::command]
fn select_run_candidate(
    run_id: String,
    asset_id: String,
    state: State<'_, AppState>,
) -> Result<runs::RunRecord, String> {
    runs::select_candidate(&state, &run_id, &asset_id)
}

#[tauri::command]
fn resume_jobs(app: AppHandle, state: State<'_, AppState>) -> Result<usize, String> {
    Ok(jobs::resume_pending_on_start(app, &state))
}

#[tauri::command]
fn asset_file_path(asset_id: String, state: State<'_, AppState>) -> Result<String, String> {
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    let payload: String = connection
        .query_row("SELECT payload FROM assets WHERE id=?1", [asset_id], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    let asset: assets::AssetRef =
        serde_json::from_str(&payload).map_err(|error| error.to_string())?;
    Ok(assets::absolute_path(&state.data_dir, &asset.path)?.to_string_lossy().to_string())
}

#[tauri::command]
fn read_asset_text(asset_id: String, state: State<'_, AppState>) -> Result<String, String> {
    let path = state.db_path.lock().map_err(|_| "db lock".to_string())?.clone();
    let connection = db::open(&path)?;
    let payload: String = connection
        .query_row("SELECT payload FROM assets WHERE id=?1", [asset_id], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    let asset: assets::AssetRef =
        serde_json::from_str(&payload).map_err(|error| error.to_string())?;
    std::fs::read_to_string(assets::absolute_path(&state.data_dir, &asset.path)?)
        .map_err(|error| error.to_string())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            fs::create_dir_all(&app_data)?;
            let db_path = app_data.join("frameforge.sqlite3");
            open_db(&db_path).map_err(std::io::Error::other)?;
            app.manage(AppState {
                db_path: Mutex::new(db_path),
                data_dir: app_data.clone(),
            });
            {
                let handle = app.handle().clone();
                let state = app.state::<AppState>();
                let owned = AppState {
                    db_path: Mutex::new(
                        state
                            .db_path
                            .lock()
                            .map_err(|_| "db lock poisoned".to_string())?
                            .clone(),
                    ),
                    data_dir: state.data_dir.clone(),
                };
                jobs::resume_pending_on_start(handle, &owned);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            save_project,
            load_project,
            list_projects,
            load_current_project_id,
            save_current_project_id,
            export_project_package,
            import_project_package,
            export_final_cut,
            enqueue_generation_job,
            list_generation_jobs,
            append_generation_task_id,
            update_job_status,
            save_provider_credential,
            save_provider_settings,
            list_provider_settings,
            generate_gpt_image,
            submit_video_generation,
            poll_video_generation,
            cancel_video_generation,
            generate_text,
            generate_speech,
            run_media_qc,
            store_audio_asset,
            store_media_asset,
            list_studio_projects,
            save_studio_project,
            list_boards,
            load_board,
            save_board,
            delete_board,
            list_provider_profiles,
            save_provider_profile,
            provider_has_key,
            test_provider_profile,
            save_asset_host,
            load_asset_host,
            start_run,
            cancel_run,
            list_runs,
            select_run_candidate,
            resume_jobs,
            asset_file_path,
            read_asset_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running Frameforge");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_package_round_trips_without_credentials() {
        let project = json!({
            "id": "project_round_trip",
            "name": "项目包测试",
            "apiKey": "must-not-export",
            "nested": { "token": "also-not-export" },
            "episodes": [{ "id": "episode_1", "number": 1 }],
            "shots": [{ "id": "shot_1", "archived": true }],
            "characters": [],
            "prompts": [],
            "candidates": []
        });
        let package = project_package(project.clone()).expect("valid project package");
        let encoded = serde_json::to_string(&package).expect("serialize package");
        let decoded: ProjectPackage = serde_json::from_str(&encoded).expect("deserialize package");

        assert_eq!(decoded.schema_version, 1);
        assert_eq!(decoded.project["id"], project["id"]);
        assert_eq!(decoded.project["name"], project["name"]);
        assert_eq!(decoded.project["episodes"][0]["id"], "episode_1");
        assert_eq!(decoded.project["shots"][0]["archived"], true);
        assert!(decoded.project.get("apiKey").is_none());
        assert!(decoded.project["nested"].get("token").is_none());
    }

    #[test]
    fn final_cut_dimensions_follow_project_aspect_ratio() {
        assert_eq!(
            final_cut_dimensions("9:16").expect("vertical"),
            (1080, 1920)
        );
        assert_eq!(
            final_cut_dimensions("16:9").expect("horizontal"),
            (1920, 1080)
        );
        assert!(final_cut_dimensions("1:1").is_err());
    }

    #[test]
    fn transition_duration_calculates_final_length_and_xfade_offsets() {
        let durations = [2.0, 3.0, 4.0];
        assert_eq!(final_cut_duration(&durations, 0.5).expect("duration"), 8.0);
        assert_eq!(
            xfade_offsets(&durations, 0.5).expect("offsets"),
            vec![1.5, 4.0]
        );
        assert!(final_cut_duration(&[1.0, 2.0], 1.0).is_err());
        assert!(final_cut_duration(&[2.0, 2.0], 1.51).is_err());
        assert!(final_cut_duration(&[2.0, 2.0], f64::NAN).is_err());
    }

    #[test]
    fn generation_task_ids_are_appended_without_duplicates() {
        let mut payload = json!({ "taskIds": ["task-a"] });
        append_task_id_to_payload(&mut payload, "task-b").expect("append task");
        append_task_id_to_payload(&mut payload, "task-a").expect("ignore duplicate");
        assert_eq!(payload["taskIds"], json!(["task-a", "task-b"]));
    }

    fn video_request() -> VideoGenerationRequest {
        VideoGenerationRequest {
            provider_id: "provider".to_string(),
            base_url: "https://provider.example/v1".to_string(),
            api_key: "test-key".to_string(),
            model: "test-video-model".to_string(),
            prompt: "A woman walks through fog".to_string(),
            aspect_ratio: "9:16".to_string(),
            duration: 8,
            start_frame_url: Some("https://cdn.example/start.png".to_string()),
            end_frame_url: Some("https://cdn.example/end.png".to_string()),
            middle_frame_url: Some("https://cdn.example/middle.png".to_string()),
            reference_image_urls: None,
            client_request_id: None,
            generate_audio: Some(true),
        }
    }

    #[test]
    fn provider_payloads_preserve_frame_roles_and_audio_settings() {
        let request = video_request();
        let byte_payload = bytedance_video_payload(&request);
        assert_eq!(byte_payload["ratio"], "9:16");
        assert_eq!(byte_payload["duration"], 8);
        assert_eq!(byte_payload["generate_audio"], true);
        assert_eq!(byte_payload["content"][1]["role"], "first_frame");
        assert_eq!(byte_payload["content"][2]["role"], "last_frame");
        assert_eq!(byte_payload["content"][3]["role"], "reference_image");
        assert!(byte_payload.get("parameters").is_none());

        let grok_payload = grok_video_payload(&request);
        assert_eq!(
            grok_payload["image"]["url"],
            "https://cdn.example/start.png"
        );
        assert_eq!(
            grok_payload["reference_images"][0]["url"],
            "https://cdn.example/end.png"
        );
        assert_eq!(
            grok_payload["reference_images"][1]["url"],
            "https://cdn.example/middle.png"
        );
        assert!(grok_payload.get("image_url").is_none());
        assert!(grok_payload.get("end_image_url").is_none());
    }

    #[test]
    fn gemini_payload_uses_binary_image_parts_and_reference_images() {
        let request = video_request();
        let start = json!({ "bytesBase64Encoded": "c3RhcnQ=", "mimeType": "image/png" });
        let end = json!({ "bytesBase64Encoded": "ZW5k", "mimeType": "image/png" });
        let middle = json!({ "bytesBase64Encoded": "bWlkZGxl", "mimeType": "image/jpeg" });
        let payload =
            gemini_video_payload(&request, Some(start), Some(end), Some(middle), Vec::new());
        assert_eq!(payload["instances"][0]["image"]["mimeType"], "image/png");
        assert_eq!(
            payload["instances"][0]["lastFrame"]["bytesBase64Encoded"],
            "ZW5k"
        );
        assert_eq!(
            payload["parameters"]["referenceImages"][0]["referenceType"],
            "asset"
        );
        assert_eq!(payload["parameters"]["generateAudio"], true);
        assert!(payload["instances"][0]["image"].get("uri").is_none());
    }

    #[test]
    fn xai_request_id_and_video_response_are_parsed() {
        let pending = json!({ "request_id": "xai-pending", "status": "pending" });
        let pending_task = task_from_response(
            "Grok Video",
            Some("grok-imagine-video".to_string()),
            &pending,
        )
        .expect("pending xAI response");
        assert_eq!(pending_task.task_id, "xai-pending");
        assert_eq!(pending_task.status, "queued");

        let done = json!({
            "request_id": "xai-done",
            "status": "done",
            "video": { "url": "https://cdn.example/video.mp4" }
        });
        let done_task = task_from_response("Grok Video", None, &done).expect("done xAI response");
        assert_eq!(done_task.task_id, "xai-done");
        assert_eq!(done_task.status, "succeeded");
        assert_eq!(done_task.output_urls, vec!["https://cdn.example/video.mp4"]);
    }

    #[test]
    fn image_mime_type_handles_data_urls_and_file_extensions() {
        assert_eq!(image_mime_type("data:image/jpeg;base64,abc"), "image/jpeg");
        assert_eq!(
            image_mime_type("https://cdn.example/frame.webp?cache=1"),
            "image/webp"
        );
        assert_eq!(image_mime_type("/tmp/frame.png"), "image/png");
    }

    #[test]
    fn media_probe_parser_reads_dimensions_audio_and_frame_count() {
        let value = json!({
            "streams": [
                {
                    "codec_type": "video",
                    "width": 1080,
                    "height": 1920,
                    "duration": "2.5",
                    "nb_frames": "75"
                },
                { "codec_type": "audio" }
            ],
            "format": { "duration": "2.5" }
        });
        let summary = parse_media_probe(&value, "video").expect("probe summary");
        assert_eq!(summary.width, 1080);
        assert_eq!(summary.height, 1920);
        assert!(summary.has_audio);
        assert_eq!(summary.frame_count, 75);
        assert!(summary.warnings.is_empty());
        assert!(summary.errors.is_empty());
    }

    #[test]
    fn media_probe_parser_reports_missing_audio_and_low_resolution() {
        let value = json!({
            "streams": [{
                "codec_type": "video",
                "width": 360,
                "height": 640,
                "duration": "1.0",
                "avg_frame_rate": "24/1"
            }],
            "format": { "duration": "1.0" }
        });
        let summary = parse_media_probe(&value, "video").expect("probe summary");
        assert!(!summary.has_audio);
        assert_eq!(summary.frame_count, 24);
        assert_eq!(summary.warnings.len(), 2);
        assert!(summary.errors.is_empty());
    }

    #[test]
    fn video_response_parser_handles_nested_samples_and_done_operations() {
        let response = json!({
            "name": "projects/demo/locations/us-central1/operations/123",
            "done": true,
            "error": null,
            "response": {
                "generateVideoResponse": {
                    "generatedSamples": [
                        { "video": { "uri": "https://cdn.example.test/shot-1.mp4" } },
                        { "video": { "uri": "https://cdn.example.test/shot-2.mp4" } }
                    ]
                }
            }
        });
        let task = task_from_response("Gemini / Veo", Some("veo-test".to_string()), &response)
            .expect("nested Gemini operation");
        assert_eq!(
            task.task_id,
            "projects/demo/locations/us-central1/operations/123"
        );
        assert_eq!(task.status, "succeeded");
        assert_eq!(task.output_urls.len(), 2);
        assert_eq!(video_api_url("https://generativelanguage.googleapis.com/v1beta", &task.task_id), "https://generativelanguage.googleapis.com/v1beta/projects/demo/locations/us-central1/operations/123");
    }

    #[test]
    fn video_url_parser_ignores_unrelated_urls_and_keeps_nested_video_urls() {
        let response = json!({
            "url": "https://cdn.example.test/landing",
            "image": { "url": "https://cdn.example.test/frame.jpg" },
            "download": { "href": "https://cdn.example.test/clip.mp4?token=abc" },
            "video": { "url": "https://cdn.example.test/generated-video" }
        });
        let urls = video_urls(&response);
        assert!(urls.contains(&"https://cdn.example.test/clip.mp4?token=abc".to_string()));
        assert!(urls.contains(&"https://cdn.example.test/generated-video".to_string()));
        assert!(!urls.contains(&"https://cdn.example.test/landing".to_string()));
        assert!(!urls.contains(&"https://cdn.example.test/frame.jpg".to_string()));
    }

    #[test]
    fn video_response_parser_treats_non_null_errors_as_failed() {
        let response = json!({
            "id": "task-failed",
            "done": true,
            "error": { "message": "quota exceeded" }
        });
        let task = task_from_response("Video", None, &response).expect("failed operation");
        assert_eq!(task.status, "failed");
        assert_eq!(task.error.as_deref(), Some("quota exceeded"));
    }

    #[test]
    fn subtitle_file_uses_srt_timestamps_and_rejects_invalid_ranges() {
        assert_eq!(srt_timestamp(1.234), "00:00:01,234");
        let cues = vec![FinalCutSubtitleCue {
            text: "第一句".to_string(),
            start: 0.0,
            end: 1.5,
        }];
        let srt = subtitle_file(&cues, 2.0, 0.0).expect("valid subtitles");
        assert!(srt.contains("00:00:00,000 --> 00:00:01,500"));
        assert!(subtitle_file(
            &[FinalCutSubtitleCue {
                text: "越界".to_string(),
                start: 1.0,
                end: 3.0,
            }],
            2.0,
            0.0,
        )
        .is_err());
    }

    #[test]
    fn media_asset_names_are_scoped_and_sanitized() {
        assert_eq!(
            media_extension("image", "frame.webp").expect("webp"),
            "webp"
        );
        assert_eq!(media_extension("video", "clip.mov").expect("mov"), "mov");
        assert_eq!(
            media_extension("audio", "voice.unknown").expect("fallback"),
            "bin"
        );
        assert!(media_extension("document", "file.txt").is_err());
        assert_eq!(media_stem("../shot with spaces?.png"), "shotwithspaces");
        assert_eq!(media_stem("!!!.png"), "asset");
    }

    #[test]
    fn provider_base_url_accepts_public_https_and_empty_value() {
        assert!(validate_provider_base_url("").is_ok());
        assert!(validate_provider_base_url("   ").is_ok());
        assert!(validate_provider_base_url("https://api.example.com/v1").is_ok());
    }

    #[test]
    fn provider_base_url_rejects_insecure_and_private_targets() {
        let insecure = validate_provider_base_url("http://api.example.com").expect_err("http 拒绝");
        assert!(insecure.contains("PARAM_URL_INSECURE"), "{insecure}");
        for target in [
            "https://127.0.0.1:8080",
            "https://localhost",
            "https://192.168.1.10",
        ] {
            let error = validate_provider_base_url(target).expect_err("私网拒绝");
            assert!(error.contains("PARAM_URL_PRIVATE"), "{target} -> {error}");
        }
        let invalid = validate_provider_base_url("not-a-url").expect_err("非法 URL");
        assert!(invalid.contains("PARAM_URL_INVALID"), "{invalid}");
    }

    #[test]
    fn asset_host_rejects_insecure_endpoint_and_public_base_url() {
        let insecure = validate_asset_host_urls(&json!({
            "strategy": "s3",
            "endpoint": "http://s3.example.com"
        }))
        .expect_err("http endpoint 拒绝");
        assert!(insecure.contains("PARAM_URL_INSECURE"), "{insecure}");
        let private = validate_asset_host_urls(&json!({
            "strategy": "s3",
            "endpoint": "https://127.0.0.1:9000"
        }))
        .expect_err("私网 endpoint 拒绝");
        assert!(private.contains("PARAM_URL_PRIVATE"), "{private}");
        let public_base = validate_asset_host_urls(&json!({
            "strategy": "s3",
            "endpoint": "https://s3.example.com",
            "publicBaseUrl": "http://cdn.example.com"
        }))
        .expect_err("公网前缀拒绝 http");
        assert!(public_base.contains("PARAM_URL_INSECURE"), "{public_base}");
    }

    #[test]
    fn asset_host_ignores_endpoint_when_strategy_is_not_s3() {
        assert!(validate_asset_host_urls(&json!({
            "strategy": "dataUrl",
            "endpoint": "http://s3.example.com"
        }))
        .is_ok());
        assert!(validate_asset_host_urls(&json!({
            "strategy": "s3",
            "endpoint": "https://s3.example.com",
            "publicBaseUrl": "https://cdn.example.com"
        }))
        .is_ok());
    }

    #[test]
    fn asset_host_payload_drops_keys_and_keeps_schema_version() {
        let payload = asset_host_payload(&json!({
            "strategy": "s3",
            "endpoint": "https://s3.example.com",
            "accessKey": "access-plain",
            "secretKey": "secret-plain"
        }));
        assert_eq!(payload["schemaVersion"], json!(1));
        assert_eq!(payload["endpoint"], json!("https://s3.example.com"));
        assert!(payload.get("accessKey").is_none());
        assert!(payload.get("secretKey").is_none());
    }

    #[test]
    fn asset_host_response_carries_schema_version_without_plain_keys() {
        let mut config = gateway::transport::AssetHostConfig::default();
        config.strategy = "s3".to_string();
        config.endpoint = Some("https://s3.example.com".to_string());
        config.access_key = Some("access-plain".to_string());
        config.secret_key = Some("secret-plain".to_string());
        let response = asset_host_response(&config);
        assert_eq!(response["schemaVersion"], json!(1));
        assert_eq!(response["strategy"], json!("s3"));
        assert_eq!(response["hasCredentials"], json!(true));
        assert!(response.get("accessKey").is_none());
        assert!(response.get("secretKey").is_none());
    }
}
