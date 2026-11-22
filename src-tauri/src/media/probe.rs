use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Seek, SeekFrom},
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

/// ffprobe 的墙钟上限。`-count_frames` 需要整段解码，长素材天然偏慢，
/// 上限只用来兜住畸形文件，不用来卡正常素材。
const PROBE_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_PROBE_BYTES: u64 = 16 * 1024 * 1024;

const PROBE_ARGS: [&str; 7] = [
    "-v",
    "error",
    "-count_frames",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
];

pub(crate) fn configured_ffprobe() -> Option<std::path::PathBuf> {
    std::env::var_os("FRAMEFORGE_FFPROBE").map(std::path::PathBuf::from).filter(|path| path.is_absolute() && path.is_file())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbedMedia {
    pub kind: String,
    pub duration_ticks: i64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub has_audio: bool,
    pub rotation: i32,
    pub frame_count: Option<u64>,
}

pub(crate) fn probe(ffprobe: &Path, path: &Path) -> Result<ProbedMedia, String> {
    probe_with_timeout(ffprobe, path, PROBE_TIMEOUT)
}

pub(crate) fn probe_with_timeout(
    ffprobe: &Path,
    path: &Path,
    timeout: Duration,
) -> Result<ProbedMedia, String> {
    let output = run_ffprobe_with_timeout(ffprobe, &PROBE_ARGS, path, timeout)?;
    let value: serde_json::Value =
        serde_json::from_slice(&output).map_err(|_| "MEDIA_PROBE_INVALID".to_string())?;
    let streams = value["streams"].as_array().cloned().unwrap_or_default();
    let video = streams.iter().find(|item| item["codec_type"] == "video");
    let has_audio = streams.iter().any(|item| item["codec_type"] == "audio");
    let duration = value["format"]["duration"]
        .as_str()
        .and_then(|v| v.parse::<f64>().ok())
        .or_else(|| video.and_then(|stream| stream["duration"].as_str()).and_then(|v| v.parse::<f64>().ok()))
        .or_else(|| streams.iter().find(|stream| stream["codec_type"] == "audio").and_then(|stream| stream["duration"].as_str()).and_then(|v| v.parse::<f64>().ok()))
        .unwrap_or(0.0);
    let fps = video
        .and_then(|v| v["avg_frame_rate"].as_str())
        .and_then(|v| {
            let (a, b) = v.split_once('/')?;
            let numerator = a.parse::<f64>().ok()?;
            let denominator = b.parse::<f64>().ok()?;
            (denominator > 0.0).then_some(numerator / denominator)
        });
    Ok(ProbedMedia {
        kind: if video.is_some() {
            "video"
        } else if has_audio {
            "audio"
        } else {
            "image"
        }
        .into(),
        duration_ticks: (duration * 240_000.0).round() as i64,
        width: video.and_then(|v| v["width"].as_u64()).map(|v| v as u32),
        height: video.and_then(|v| v["height"].as_u64()).map(|v| v as u32),
        fps,
        has_audio,
        rotation: video.and_then(rotation_from_stream).unwrap_or(0),
        frame_count: video.and_then(|stream| stream["nb_read_frames"].as_str().and_then(|value| value.parse().ok())),
    })
}

fn rotation_from_stream(stream: &serde_json::Value) -> Option<i32> {
    stream["tags"]["rotate"].as_str().and_then(|value| value.parse().ok()).or_else(|| {
        stream["side_data_list"].as_array().and_then(|items| items.iter().find_map(|item| item["rotation"].as_i64().map(|value| value as i32)))
    })
}

/// 跑 ffprobe 并卡一道墙钟超时：畸形媒体不能让导入/抽帧无限期挂起。
pub(crate) fn run_ffprobe_with_timeout(
    ffprobe: &Path,
    args: &[&str],
    path: &Path,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    let mut stdout = tempfile::tempfile().map_err(|e| e.to_string())?;
    let stdout_clone = stdout.try_clone().map_err(|e| e.to_string())?;
    let stderr = tempfile::tempfile().map_err(|e| e.to_string())?;
    let mut child = Command::new(ffprobe)
        .args(args)
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout_clone))
        .stderr(Stdio::from(stderr))
        .spawn()
        .map_err(|e| e.to_string())?;
    let started = Instant::now();
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => {
                if !status.success() {
                    return Err("MEDIA_PROBE_FAILED".into());
                }
                break;
            }
            None => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("MEDIA_PROBE_TIMEOUT".into());
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
    stdout.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut output = Vec::new();
    stdout
        .take(MAX_PROBE_BYTES)
        .read_to_end(&mut output)
        .map_err(|e| e.to_string())?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::rotation_from_stream;
    #[test]
    fn reads_rotation_from_display_matrix_side_data() {
        let value = serde_json::json!({"side_data_list":[{"rotation":90}]});
        assert_eq!(rotation_from_stream(&value), Some(90));
    }

    #[cfg(unix)]
    fn stub_ffprobe(directory: &std::path::Path, name: &str, body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = directory.join(name);
        std::fs::write(&path, body).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn hanging_ffprobe_is_stopped_with_a_timeout_error() {
        let directory = tempfile::tempdir().unwrap();
        let ffprobe = stub_ffprobe(directory.path(), "ffprobe-hang", "#!/bin/sh\nexec sleep 30\n");
        let media = directory.path().join("broken.mp4");
        std::fs::write(&media, b"x").unwrap();
        let started = std::time::Instant::now();
        let error = super::probe_with_timeout(&ffprobe, &media, std::time::Duration::from_millis(300)).unwrap_err();
        assert_eq!(error, "MEDIA_PROBE_TIMEOUT");
        assert!(started.elapsed() < std::time::Duration::from_secs(10), "超时必须及时返回");
    }

    #[cfg(unix)]
    #[test]
    fn reads_metadata_from_ffprobe_output() {
        let directory = tempfile::tempdir().unwrap();
        let ffprobe = stub_ffprobe(
            directory.path(),
            "ffprobe-ok",
            "#!/bin/sh\ncat <<'JSON'\n{\"streams\":[{\"codec_type\":\"video\",\"width\":1280,\"height\":720,\"avg_frame_rate\":\"30/1\"}],\"format\":{\"duration\":\"12.5\"}}\nJSON\n",
        );
        let media = directory.path().join("sample.mp4");
        std::fs::write(&media, b"x").unwrap();
        let probed = super::probe_with_timeout(&ffprobe, &media, std::time::Duration::from_secs(5)).unwrap();
        assert_eq!(probed.kind, "video");
        assert_eq!(probed.width, Some(1280));
        assert_eq!(probed.height, Some(720));
        assert_eq!(probed.duration_ticks, 3_000_000);
    }
}
