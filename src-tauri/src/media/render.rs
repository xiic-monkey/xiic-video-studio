use super::timeline::{CompiledClip, TimelinePlan, TICKS_PER_FRAME, TICKS_PER_SECOND};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RenderSummary {
    pub frame_count: i64,
    pub total_ticks: i64,
    pub has_audio: bool,
    pub subtitle_burn_in: bool,
}

pub(crate) fn render_summary(
    plan: &TimelinePlan,
    has_audio: bool,
    subtitle_burn_in: bool,
) -> RenderSummary {
    RenderSummary {
        frame_count: (plan.total_ticks + TICKS_PER_FRAME / 2) / TICKS_PER_FRAME,
        total_ticks: plan.total_ticks,
        has_audio,
        subtitle_burn_in,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenderAsset {
    pub asset_id: String,
    pub path: PathBuf,
    pub kind: String,
    pub has_audio: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenderOptions {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub sample_rate: u32,
    pub video_encoder: String,
    pub subtitle_path: Option<PathBuf>,
    pub subtitle_font_dir: Option<PathBuf>,
    pub subtitle_font_family: Option<String>,
}

impl Default for RenderOptions {
    fn default() -> Self {
        Self {
            width: 1080,
            height: 1920,
            fps: 30,
            sample_rate: 48_000,
            video_encoder: "libx264".into(),
            subtitle_path: None,
            subtitle_font_dir: None,
            subtitle_font_family: None,
        }
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub(crate) enum RenderError {
    #[error("MEDIA_RENDER_CANCELLED")]
    Cancelled,
    #[error("MEDIA_RENDER_INPUT_MISSING")]
    InputMissing,
    #[error("MEDIA_RENDER_COMMAND_FAILED: {0}")]
    CommandFailed(String),
    #[error("MEDIA_RENDER_IO: {0}")]
    Io(String),
    #[error("MEDIA_RENDER_INVALID_OPTION")]
    InvalidOption,
    #[error("MEDIA_RENDER_INVALID_TICK_RANGE")]
    InvalidTickRange,
}

pub(crate) struct RenderResult {
    pub output: PathBuf,
    pub summary: RenderSummary,
}

pub(crate) fn format_srt(cues: &[super::timeline::SubtitleCue]) -> String {
    let time = |ticks: i64| {
        let millis = ticks.max(0).saturating_add(120) / 240;
        let ms = millis % 1000;
        let seconds = millis / 1000;
        format!("{:02}:{:02}:{:02},{:03}", seconds / 3600, (seconds / 60) % 60, seconds % 60, ms)
    };
    cues.iter().enumerate().map(|(index, cue)| format!("{}\n{} --> {}\n{}", index + 1, time(cue.start_ticks), time(cue.end_ticks), cue.text)).collect::<Vec<_>>().join("\n\n") + if cues.is_empty() { "" } else { "\n" }
}

pub(crate) fn configured_ffmpeg() -> Option<PathBuf> {
    std::env::var_os("FRAMEFORGE_FFMPEG").map(PathBuf::from).filter(|path| path.is_absolute() && path.is_file())
}

pub(crate) fn configured_video_encoder() -> String {
    std::env::var("FRAMEFORGE_H264_ENCODER").ok().filter(|value| matches!(value.as_str(), "libx264" | "h264_videotoolbox")).unwrap_or_else(|| "libx264".into())
}

/// Render one continuous video track into an MP4. Each source clip is normalized into
/// an intermediate MP4 with a guaranteed stereo audio stream, then concatenated. The
/// function accepts already-authorized paths only; resolving project membership belongs
/// to the caller.
pub(crate) fn render(
    ffmpeg: &Path,
    plan: &TimelinePlan,
    assets: &[RenderAsset],
    options: &RenderOptions,
    staging_dir: &Path,
    output: &Path,
    cancel: &dyn Fn() -> bool,
) -> Result<RenderResult, RenderError> {
    if options.width == 0
        || options.height == 0
        || options.fps == 0
        || options.sample_rate == 0
        || plan.clips.is_empty()
    {
        return Err(RenderError::InvalidOption);
    }
    let outcome = render_into(ffmpeg, plan, assets, options, staging_dir, output, cancel);
    if outcome.is_err() {
        let _ = fs::remove_dir_all(staging_dir);
    }
    outcome
}

fn render_into(
    ffmpeg: &Path,
    plan: &TimelinePlan,
    assets: &[RenderAsset],
    options: &RenderOptions,
    staging_dir: &Path,
    output: &Path,
    cancel: &dyn Fn() -> bool,
) -> Result<RenderResult, RenderError> {
    fs::create_dir_all(staging_dir).map_err(|e| RenderError::Io(e.to_string()))?;
    let by_id = assets
        .iter()
        .map(|asset| (asset.asset_id.as_str(), asset))
        .collect::<std::collections::HashMap<_, _>>();
    let mut normalized = Vec::new();
    for (index, clip) in plan.clips.iter().enumerate() {
        if cancel() {
            return Err(RenderError::Cancelled);
        }
        let asset = by_id.get(clip.asset_id.as_str()).ok_or(RenderError::InputMissing)?;
        if !asset.path.is_file() {
            return Err(RenderError::InputMissing);
        }
        let duration = clip_duration_seconds(clip)?;
        let path = staging_dir.join(format!("clip-{index:04}.mp4"));
        normalize_clip(ffmpeg, asset, clip, duration, options, &path, cancel)?;
        normalized.push(path);
    }
    let concat_file = staging_dir.join("concat.txt");
    let mut list = File::create(&concat_file).map_err(|e| RenderError::Io(e.to_string()))?;
    for path in &normalized {
        let escaped = path.to_string_lossy().replace('\'', "'\\''");
        writeln!(list, "file '{escaped}'").map_err(|e| RenderError::Io(e.to_string()))?;
    }
    let concat_output = staging_dir.join("concatenated.mp4");
    let mut final_output = concat_output.clone();
    run_ffmpeg(
        ffmpeg,
        &[
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            concat_file.to_str().ok_or(RenderError::InvalidOption)?,
            "-c:v",
            &options.video_encoder,
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-ar",
            &options.sample_rate.to_string(),
            "-ac",
            "2",
            concat_output.to_str().ok_or(RenderError::InvalidOption)?,
        ],
        cancel,
    )?;
    if !plan.audio_tracks.is_empty() {
        let mixed_output = staging_dir.join("mixed.mp4");
        mix_audio_tracks(ffmpeg, &concat_output, plan, &by_id, options, &mixed_output, cancel)?;
        final_output = mixed_output;
    }
    let final_input = if options.subtitle_path.is_some() {
        let subtitle_output = staging_dir.join("subtitled.mp4");
        let filter = subtitle_filter(options)?;
        run_ffmpeg(
            ffmpeg,
            &[
                "-y",
                "-i",
                final_output.to_str().ok_or(RenderError::InvalidOption)?,
                "-vf",
                &filter,
                "-c:v",
                &options.video_encoder,
                "-pix_fmt",
                "yuv420p",
                "-r",
                &options.fps.to_string(),
                "-c:a",
                "aac",
                "-ar",
                &options.sample_rate.to_string(),
                "-ac",
                "2",
                subtitle_output.to_str().ok_or(RenderError::InvalidOption)?,
            ],
            cancel,
        )?;
        subtitle_output
    } else {
        final_output
    };
    if let Some(parent) = output.parent() {
        fs::create_dir_all(parent).map_err(|e| RenderError::Io(e.to_string()))?;
    }
    fs::copy(&final_input, output).map_err(|e| RenderError::Io(e.to_string()))?;
    Ok(RenderResult {
        output: output.to_path_buf(),
        summary: render_summary(plan, true, options.subtitle_path.is_some()),
    })
}

fn mix_audio_tracks(
    ffmpeg: &Path,
    video: &Path,
    plan: &TimelinePlan,
    assets: &std::collections::HashMap<&str, &RenderAsset>,
    options: &RenderOptions,
    output: &Path,
    cancel: &dyn Fn() -> bool,
) -> Result<(), RenderError> {
    let mut command = Command::new(ffmpeg);
    command.args(["-nostdin", "-v", "error", "-xerror", "-y", "-i"]);
    command.arg(video);
    for track in &plan.audio_tracks {
        let asset = assets.get(track.asset_id.as_str()).ok_or(RenderError::InputMissing)?;
        if asset.kind != "audio" || !asset.path.is_file() { return Err(RenderError::InputMissing); }
        let duration = track.source_out_ticks.checked_sub(track.source_in_ticks).ok_or(RenderError::InvalidTickRange)?;
        if duration <= 0 { return Err(RenderError::InvalidTickRange); }
        command.arg("-ss").arg(format!("{:.6}", clip_source_seconds(track.source_in_ticks))).arg("-t").arg(format!("{:.6}", duration as f64 / TICKS_PER_SECOND as f64)).arg("-i");
        command.arg(&asset.path);
    }
    let mut filter = String::new();
    let mut labels = vec!["[0:a]".to_string()];
    for (index, track) in plan.audio_tracks.iter().enumerate() {
        let input_index = index + 1;
        let delay_ms = track.timeline_in_ticks.saturating_mul(1000) / TICKS_PER_SECOND;
        let label = format!("[mix{index}]");
        filter.push_str(&format!("[{input_index}:a]aresample={},volume={:.3},adelay={delay_ms}|{delay_ms}{label};", options.sample_rate, track.gain));
        labels.push(label);
    }
    filter.push_str(&labels.join(""));
    filter.push_str(&format!("amix=inputs={}:duration=first:dropout_transition=0,alimiter=limit=0.95[aout]", labels.len()));
    command.arg("-filter_complex").arg(filter).args(["-map", "0:v:0", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac", "-ar"]).arg(options.sample_rate.to_string()).args(["-ac", "2"]);
    command.arg(output);
    run_command(command, cancel)
}

fn clip_duration_seconds(clip: &CompiledClip) -> Result<String, RenderError> {
    let ticks = clip
        .timeline_out_ticks
        .checked_sub(clip.timeline_in_ticks)
        .ok_or(RenderError::InvalidTickRange)?;
    if ticks <= 0 {
        return Err(RenderError::InvalidTickRange);
    }
    Ok(format!("{:.6}", ticks as f64 / TICKS_PER_SECOND as f64))
}

fn normalize_clip(
    ffmpeg: &Path,
    asset: &RenderAsset,
    clip: &CompiledClip,
    duration: String,
    options: &RenderOptions,
    output: &Path,
    cancel: &dyn Fn() -> bool,
) -> Result<(), RenderError> {
    let filter = format!(
        "scale={}:{}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2:color=black,fps={}",
        options.width, options.height, options.width, options.height, options.fps
    );
    let mut args = vec![
        "-y".to_string(),
        "-ss".to_string(),
        format!("{:.6}", clip_source_seconds(clip.source_in_ticks)),
        "-i".to_string(),
        asset.path.to_string_lossy().to_string(),
    ];
    if asset.has_audio {
        args.extend(["-map".into(), "0:v:0".into(), "-map".into(), "0:a:0".into()]);
    } else {
        args.extend([
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            format!("anullsrc=r={}:cl=stereo", options.sample_rate),
            "-map".into(),
            "0:v:0".into(),
            "-map".into(),
            "1:a:0".into(),
        ]);
    }
    args.extend([
        "-t".into(),
        duration,
        "-vf".into(),
        filter,
        "-r".into(),
        options.fps.to_string(),
        "-c:v".into(),
        options.video_encoder.clone(),
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-c:a".into(),
        "aac".into(),
        "-ar".into(),
        options.sample_rate.to_string(),
        "-ac".into(),
        "2".into(),
        output.to_string_lossy().to_string(),
    ]);
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    run_ffmpeg(ffmpeg, &refs, cancel)
}

fn clip_source_seconds(ticks: i64) -> f64 {
    ticks.max(0) as f64 / TICKS_PER_SECOND as f64
}

fn subtitle_filter(options: &RenderOptions) -> Result<String, RenderError> {
    let path = options.subtitle_path.as_ref().ok_or(RenderError::InvalidOption)?;
    let mut filter = format!("subtitles=filename='{}'", escape_filter_path(path));
    if let Some(dir) = &options.subtitle_font_dir {
        filter.push_str(&format!(":fontsdir='{}'", escape_filter_path(dir)));
    }
    if let Some(family) = &options.subtitle_font_family {
        if family.is_empty() || !family.bytes().all(|b| b.is_ascii_alphanumeric() || b == b' ' || b == b'-' || b == b'_') {
            return Err(RenderError::InvalidOption);
        }
        filter.push_str(&format!(":force_style='FontName={family}'"));
    }
    Ok(filter)
}

fn escape_filter_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "\\\\").replace(':', "\\:").replace('\'', "\\'")
}

fn run_ffmpeg(ffmpeg: &Path, args: &[&str], cancel: &dyn Fn() -> bool) -> Result<(), RenderError> {
    let mut command = Command::new(ffmpeg);
    command.args(["-nostdin", "-v", "error", "-xerror"]).args(args);
    run_command(command, cancel)
}

fn run_command(mut command: Command, cancel: &dyn Fn() -> bool) -> Result<(), RenderError> {
    let stderr_file = tempfile::tempfile().map_err(|e| RenderError::Io(e.to_string()))?;
    let stderr_clone = stderr_file.try_clone().map_err(|e| RenderError::Io(e.to_string()))?;
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(stderr_clone))
        .spawn()
        .map_err(|e| RenderError::Io(e.to_string()))?;
    loop {
        if cancel() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(RenderError::Cancelled);
        }
        match child.try_wait().map_err(|e| RenderError::Io(e.to_string()))? {
            Some(status) if status.success() => return Ok(()),
            Some(status) => {
                use std::io::{Read, Seek, SeekFrom};
                let mut diagnostic = String::new();
                let mut file = stderr_file;
                file.seek(SeekFrom::Start(0)).map_err(|e| RenderError::Io(e.to_string()))?;
                file.take(4096).read_to_string(&mut diagnostic).map_err(|e| RenderError::Io(e.to_string()))?;
                diagnostic = diagnostic.replace(std::env::var("HOME").unwrap_or_default().as_str(), "<local-path>");
                diagnostic.truncate(1000);
                return Err(RenderError::CommandFailed(format!("exit status {status}: {diagnostic}")));
            }
            None => std::thread::sleep(std::time::Duration::from_millis(30)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn summary_reports_300_frames_and_selected_audio_flags() {
        let plan = TimelinePlan { clips: Vec::new(), audio_tracks: Vec::new(), total_ticks: 2_400_000, issues: Vec::new(), warnings: Vec::new() };
        assert_eq!(render_summary(&plan, true, true), RenderSummary { frame_count: 300, total_ticks: 2_400_000, has_audio: true, subtitle_burn_in: true });
    }

    #[test]
    fn failed_render_removes_its_staging_directory() {
        let directory = tempfile::tempdir().unwrap();
        let staging = directory.path().join(".staging").join("export-export_preview_x");
        let plan = TimelinePlan {
            clips: vec![CompiledClip { id: "c".into(), asset_id: "missing".into(), source_in_ticks: 0, source_out_ticks: 240_000, timeline_in_ticks: 0, timeline_out_ticks: 240_000, frame_count: 30 }],
            audio_tracks: vec![],
            total_ticks: 240_000,
            issues: vec![],
            warnings: vec![],
        };
        let error = match render(Path::new("/nonexistent/ffmpeg"), &plan, &[], &RenderOptions::default(), &staging, &directory.path().join("out.mp4"), &|| false) {
            Ok(_) => panic!("缺少素材时应当失败"),
            Err(error) => error,
        };
        assert_eq!(error, RenderError::InputMissing);
        assert!(!staging.exists(), "渲染失败应清掉本任务的暂存目录");
    }

    #[test]
    fn overflowing_clip_ticks_are_rejected_instead_of_panicking() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.mp4");
        std::fs::write(&source, b"x").unwrap();
        let staging = directory.path().join("staging");
        let plan = TimelinePlan {
            clips: vec![CompiledClip { id: "c".into(), asset_id: "a".into(), source_in_ticks: 0, source_out_ticks: 240_000, timeline_in_ticks: 0, timeline_out_ticks: i64::MIN, frame_count: 30 }],
            audio_tracks: vec![],
            total_ticks: 240_000,
            issues: vec![],
            warnings: vec![],
        };
        let assets = vec![RenderAsset { asset_id: "a".into(), path: source, kind: "video".into(), has_audio: false }];
        let error = match render(Path::new("/nonexistent/ffmpeg"), &plan, &assets, &RenderOptions::default(), &staging, &directory.path().join("out.mp4"), &|| false) {
            Ok(_) => panic!("tick 溢出时应当失败"),
            Err(error) => error,
        };
        assert_eq!(error, RenderError::InvalidTickRange);
    }

    #[test]
    fn creates_mix_filter_with_gain_and_timeline_delay() {
        let track = super::super::timeline::AudioTrack { id: "voice".into(), asset_id: "voice-asset".into(), source_in_ticks: 0, source_out_ticks: 240_000, timeline_in_ticks: 480_000, gain: 0.75 };
        let filter = format!("[1:a]aresample=48000,volume={:.3},adelay={}|{}[mix0];[0:a][mix0]amix=inputs=2", track.gain, track.timeline_in_ticks * 1000 / TICKS_PER_SECOND, track.timeline_in_ticks * 1000 / TICKS_PER_SECOND);
        assert!(filter.contains("volume=0.750"));
        assert!(filter.contains("adelay=2000|2000"));
    }

    #[test]
    fn subtitle_paths_are_escaped_without_shell_interpolation() {
        let filter = subtitle_filter(&RenderOptions { subtitle_path: Some(PathBuf::from("/tmp/a:b'srt")), ..RenderOptions::default() }).unwrap();
        assert!(filter.contains("a\\:b\\'srt"));
        assert!(!filter.contains(";"));
    }

    #[test]
    fn subtitle_sidecar_keeps_utf8_and_tick_boundaries() {
        let cue = super::super::timeline::SubtitleCue { id: "c1".into(), start_ticks: 0, end_ticks: 240_000, text: "你好\n字幕".into(), anchor_clip_id: None };
        assert_eq!(format_srt(&[cue]), "1\n00:00:00,000 --> 00:00:01,000\n你好\n字幕\n");
    }

    #[test]
    #[ignore = "requires explicitly configured FFmpeg and FFprobe"]
    fn renders_ten_seconds_as_300_frames_with_a_continuous_audio_stream() {
        let ffmpeg = configured_ffmpeg().expect("FRAMEFORGE_FFMPEG or ffmpeg on PATH");
        let directory = tempfile::tempdir().unwrap();
        let colors = ["red", "green", "blue"];
        let durations = ["4", "3", "3"];
        let lengths = [960_000, 720_000, 720_000];
        let mut assets = Vec::new();
        let mut clips = Vec::new();
        let mut cursor = 0;
        for index in 0..3 {
            let path = directory.path().join(format!("source-{index}.mp4"));
            let status = Command::new(&ffmpeg).args(["-nostdin", "-v", "error", "-f", "lavfi", "-i", &format!("color=c={}:s=320x240:r=30", colors[index]), "-t", durations[index], "-c:v", "libx264", "-pix_fmt", "yuv420p", path.to_str().unwrap()]).status().unwrap();
            assert!(status.success());
            let asset_id = format!("asset-{index}");
            assets.push(RenderAsset { asset_id: asset_id.clone(), path, kind: "video".into(), has_audio: false });
            clips.push(CompiledClip { id: format!("clip-{index}"), asset_id, source_in_ticks: 0, source_out_ticks: lengths[index], timeline_in_ticks: cursor, timeline_out_ticks: cursor + lengths[index], frame_count: lengths[index] / TICKS_PER_FRAME });
            cursor += lengths[index];
        }
        let plan = TimelinePlan { clips, audio_tracks: vec![], total_ticks: cursor, issues: vec![], warnings: vec![] };
        let staging = directory.path().join("staging");
        let output = directory.path().join("final.mp4");
        let result = render(&ffmpeg, &plan, &assets, &RenderOptions { width: 320, height: 568, ..RenderOptions::default() }, &staging, &output, &|| false).unwrap();
        assert_eq!(result.summary.frame_count, 300);
        assert!(result.summary.has_audio);
        let ffprobe = super::super::probe::configured_ffprobe().expect("FRAMEFORGE_FFPROBE or ffprobe on PATH");
        let probed = super::super::probe::probe(&ffprobe, &output).unwrap();
        assert!(probed.has_audio);
        assert!((probed.duration_ticks - 2_400_000).abs() <= TICKS_PER_FRAME);
    }

    #[test]
    #[ignore = "requires explicitly configured FFmpeg and FFprobe"]
    fn renders_two_trimmed_audio_tracks_at_their_timeline_offsets_and_gains() {
        let ffmpeg = configured_ffmpeg().expect("FRAMEFORGE_FFMPEG or ffmpeg on PATH");
        let directory = tempfile::tempdir().unwrap();
        let video_path = directory.path().join("video.mp4");
        let status = Command::new(&ffmpeg)
            .args(["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x240:r=30", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p"])
            .arg(&video_path)
            .status()
            .unwrap();
        assert!(status.success());

        let mut assets = vec![RenderAsset { asset_id: "video".into(), path: video_path, kind: "video".into(), has_audio: false }];
        for (id, frequency) in [("voice", "440"), ("music", "880")] {
            let path = directory.path().join(format!("{id}.wav"));
            let status = Command::new(&ffmpeg)
                .args(["-nostdin", "-v", "error", "-f", "lavfi", "-i", &format!("sine=frequency={frequency}:duration=3"), "-c:a", "pcm_s16le"])
                .arg(&path)
                .status()
                .unwrap();
            assert!(status.success());
            assets.push(RenderAsset { asset_id: id.into(), path, kind: "audio".into(), has_audio: false });
        }
        let plan = TimelinePlan {
            clips: vec![CompiledClip { id: "clip".into(), asset_id: "video".into(), source_in_ticks: 0, source_out_ticks: 720_000, timeline_in_ticks: 0, timeline_out_ticks: 720_000, frame_count: 90 }],
            audio_tracks: vec![
                super::super::timeline::AudioTrack { id: "voice-track".into(), asset_id: "voice".into(), source_in_ticks: 120_000, source_out_ticks: 360_000, timeline_in_ticks: 120_000, gain: 0.5 },
                super::super::timeline::AudioTrack { id: "music-track".into(), asset_id: "music".into(), source_in_ticks: 240_000, source_out_ticks: 480_000, timeline_in_ticks: 360_000, gain: 1.0 },
            ],
            total_ticks: 720_000,
            issues: vec![],
            warnings: vec![],
        };
        let output = directory.path().join("mixed.mp4");
        render(&ffmpeg, &plan, &assets, &RenderOptions { width: 320, height: 240, ..RenderOptions::default() }, &directory.path().join("staging"), &output, &|| false).unwrap();
        let ffprobe = super::super::probe::configured_ffprobe().expect("FRAMEFORGE_FFPROBE or ffprobe on PATH");
        let probed = super::super::probe::probe(&ffprobe, &output).unwrap();
        assert!(probed.has_audio);
        assert!((probed.duration_ticks - 720_000).abs() <= TICKS_PER_FRAME);

        let mean_volume = |start: &str| {
            let result = Command::new(&ffmpeg)
                .args(["-nostdin", "-hide_banner", "-ss", start, "-t", "0.2", "-i"])
                .arg(&output)
                .args(["-vn", "-af", "volumedetect", "-f", "null", "-"])
                .output()
                .unwrap();
            assert!(result.status.success());
            let stderr = String::from_utf8_lossy(&result.stderr);
            let line = stderr.lines().find(|line| line.contains("mean_volume:")).unwrap();
            line.split("mean_volume:").nth(1).unwrap().trim().trim_end_matches(" dB").parse::<f64>().unwrap()
        };
        assert!(mean_volume("0.7") > -40.0);
        assert!(mean_volume("1.7") > -35.0);
        assert!(mean_volume("2.7") < -60.0);
    }
}
