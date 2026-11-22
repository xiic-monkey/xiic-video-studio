use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{path::Path, process::Command};

/// 帧索引同样要整段解码，超时只用来兜住畸形文件。
const FRAME_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum FrameSelector {
    First,
    Last,
    AtTicks { at_ticks: i64 },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DerivedFrame {
    pub asset_id: String,
    pub source_asset_id: String,
    pub actual_ticks: i64,
}

pub(crate) fn derivation_key(
    source_asset_id: &str,
    selector: &FrameSelector,
    implementation_version: u32,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(source_asset_id.as_bytes());
    hasher.update(serde_json::to_vec(selector).unwrap_or_default());
    hasher.update(implementation_version.to_le_bytes());
    hex::encode(hasher.finalize())
}

pub(crate) fn actual_last_timestamp(duration_ticks: i64, timestamps: &[i64]) -> Option<i64> {
    timestamps
        .iter()
        .copied()
        .filter(|value| *value < duration_ticks)
        .max()
}

pub(crate) fn extract_frame(
    ffmpeg: &Path,
    ffprobe: &Path,
    source: &Path,
    selector: &FrameSelector,
    output: &Path,
    cancel: &dyn Fn() -> bool,
) -> Result<i64, String> {
    let timestamps = actual_frame_timestamps(ffprobe, source, FRAME_PROBE_TIMEOUT)?;
    let duration_ticks = timestamps.last().copied().unwrap_or(0).saturating_add(1);
    let actual_ticks = match selector {
        FrameSelector::First => timestamps.first().copied().ok_or("MEDIA_VIDEO_EMPTY")?,
        FrameSelector::AtTicks { at_ticks } => timestamps.iter().copied().find(|tick| *tick >= *at_ticks).ok_or("MEDIA_FRAME_NOT_FOUND")?,
        FrameSelector::Last => actual_last_timestamp(duration_ticks, &timestamps).ok_or("MEDIA_VIDEO_EMPTY")?,
    };
    let timestamp = actual_ticks as f64 / 240_000.0;
    let timestamp_arg = format!("{timestamp:.6}");
    let mut child = Command::new(ffmpeg).args(["-nostdin", "-v", "error", "-y", "-ss", &timestamp_arg, "-i"]).arg(source).args(["-frames:v", "1", "-f", "image2", "-update", "1"]).arg(output).spawn().map_err(|e| e.to_string())?;
    loop {
        if cancel() { let _ = child.kill(); let _ = child.wait(); return Err("MEDIA_TASK_CANCELLED".into()); }
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) if status.success() => break,
            Some(_) => return Err("MEDIA_FRAME_EXTRACT_FAILED".into()),
            None => std::thread::sleep(std::time::Duration::from_millis(20)),
        }
    }
    if !output.is_file() { return Err("MEDIA_FRAME_MISSING".into()); }
    Ok(actual_ticks)
}

fn actual_frame_timestamps(
    ffprobe: &Path,
    source: &Path,
    timeout: std::time::Duration,
) -> Result<Vec<i64>, String> {
    let output = super::probe::run_ffprobe_with_timeout(
        ffprobe,
        &[
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "frame=best_effort_timestamp_time",
            "-of",
            "csv=p=0",
        ],
        source,
        timeout,
    )?;
    if output.len() > 16 * 1024 * 1024 { return Err("MEDIA_FRAME_INDEX_TOO_LARGE".into()); }
    let text = String::from_utf8(output).map_err(|_| "MEDIA_PROBE_INVALID".to_string())?;
    let mut timestamps = text.lines().filter_map(|line| line.trim().parse::<f64>().ok()).map(|value| (value * 240_000.0).round() as i64).collect::<Vec<_>>();
    timestamps.sort_unstable();
    timestamps.dedup();
    Ok(timestamps)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn last_frame_uses_actual_timestamp_for_rotated_vfr() {
        assert_eq!(
            actual_last_timestamp(1_000, &[0, 333, 777, 1_111]),
            Some(777)
        );
    }
    #[test]
    fn identical_derivation_reuses_output() {
        assert_eq!(
            derivation_key("a", &FrameSelector::Last, 1),
            derivation_key("a", &FrameSelector::Last, 1)
        );
    }
    #[test]
    fn derivation_key_changes_with_implementation_version() {
        assert!(
            derivation_key("a", &FrameSelector::First, 1)
                != derivation_key("a", &FrameSelector::First, 2)
        );
    }

    #[cfg(unix)]
    #[test]
    fn hanging_ffprobe_does_not_block_frame_extraction_forever() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let stub = directory.path().join("ffprobe-stub");
        std::fs::write(&stub, "#!/bin/sh\nexec sleep 30\n").unwrap();
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
        let source = directory.path().join("source.mp4");
        std::fs::write(&source, b"x").unwrap();
        let error = actual_frame_timestamps(
            &stub,
            &source,
            std::time::Duration::from_millis(300),
        )
        .unwrap_err();
        assert_eq!(error, "MEDIA_PROBE_TIMEOUT");
    }
}
