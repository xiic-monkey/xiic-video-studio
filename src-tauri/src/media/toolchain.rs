use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RESPONSE_BYTES: u64 = 64 * 1024;
const PROBE_FRAME_BYTES: usize = 320 * 180 * 3;
const PROBE_SUBTITLE: &str = "1\n00:00:00,000 --> 00:00:00,400\n中文测试\n";

pub(crate) struct ToolchainConfig {
    pub(crate) ffmpeg: PathBuf,
    pub(crate) ffprobe: PathBuf,
    pub(crate) h264_encoder: H264Encoder,
    pub(crate) subtitle_font: Option<SubtitleFont>,
}

#[derive(Clone, Copy)]
pub(crate) enum H264Encoder {
    VideoToolbox,
    LibX264,
}

impl H264Encoder {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::VideoToolbox => "h264_videotoolbox",
            Self::LibX264 => "libx264",
        }
    }
}

pub(crate) struct SubtitleFont {
    pub(crate) path: PathBuf,
    pub(crate) family: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct MediaCapabilities {
    pub(crate) probe: bool,
    pub(crate) decode: bool,
    pub(crate) h264: bool,
    pub(crate) aac: bool,
    pub(crate) subtitle_burn_in: bool,
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub(crate) enum MediaError {
    #[error("Media tool unavailable: {0}")]
    ToolUnavailable(&'static str),
    #[error("Media capability unavailable: {0}")]
    CapabilityUnavailable(&'static str),
    #[error("Could not stage the media capability probe")]
    ProbeStaging,
}

#[derive(Debug)]
pub(crate) struct MediaToolchain {
    pub(crate) ffmpeg: PathBuf,
    pub(crate) ffprobe: PathBuf,
    pub(crate) h264_encoder: &'static str,
    pub(crate) build_fingerprint: String,
    capabilities: MediaCapabilities,
}

impl MediaToolchain {
    pub(crate) fn configured(require_subtitles: bool) -> Result<Self, MediaError> {
        let ffmpeg = std::env::var_os("FRAMEFORGE_FFMPEG").map(PathBuf::from).ok_or(MediaError::ToolUnavailable("ffmpeg"))?;
        let ffprobe = std::env::var_os("FRAMEFORGE_FFPROBE").map(PathBuf::from).ok_or(MediaError::ToolUnavailable("ffprobe"))?;
        let encoder = match std::env::var("FRAMEFORGE_H264_ENCODER").as_deref() {
            Ok("h264_videotoolbox") => H264Encoder::VideoToolbox,
            Ok("libx264") | Err(_) => H264Encoder::LibX264,
            _ => return Err(MediaError::CapabilityUnavailable("h264")),
        };
        let subtitle_font = match (std::env::var_os("FRAMEFORGE_FONT_FILE"), std::env::var("FRAMEFORGE_FONT_FAMILY")) {
            (Some(path), Ok(family)) => Some(SubtitleFont { path: PathBuf::from(path), family }),
            _ => None,
        };
        let toolchain = Self::probe(&ToolchainConfig { ffmpeg, ffprobe, h264_encoder: encoder, subtitle_font })?;
        if require_subtitles { toolchain.require_release_capabilities()?; }
        Ok(toolchain)
    }

    pub(crate) fn probe(config: &ToolchainConfig) -> Result<Self, MediaError> {
        let ffmpeg = resolve_tool(&config.ffmpeg, "ffmpeg")?;
        let ffprobe = resolve_tool(&config.ffprobe, "ffprobe")?;
        let staging = tempfile::tempdir().map_err(|_| MediaError::ProbeStaging)?;
        let workspace = staging.path();
        let ffmpeg_build = tool_version(&ffmpeg, workspace, "ffmpeg", b"ffmpeg version ")?;
        let ffprobe_build = tool_version(&ffprobe, workspace, "ffprobe", b"ffprobe version ")?;
        let h264_encoder = config.h264_encoder.name();
        fs::write(workspace.join("probe.srt"), PROBE_SUBTITLE)
            .map_err(|_| MediaError::ProbeStaging)?;

        let sidecar = inspect(&ffprobe, workspace, "probe.srt")
            .ok_or(MediaError::CapabilityUnavailable("srtProbe"))?;
        if !streams(&sidecar)
            .any(|stream| stream["codec_type"] == "subtitle" && stream["codec_name"] == "subrip")
        {
            return Err(MediaError::CapabilityUnavailable("srtProbe"));
        }

        run_ffmpeg(
            &ffmpeg,
            workspace,
            &[
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=320x180:r=30",
                "-f",
                "lavfi",
                "-i",
                "anullsrc=r=48000:cl=stereo",
                "-t",
                "0.4",
                "-c:v",
                h264_encoder,
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "probe.mp4",
            ],
        )
        .ok_or(MediaError::CapabilityUnavailable("mp4Encode"))?;
        let mp4 = inspect(&ffprobe, workspace, "probe.mp4")
            .ok_or(MediaError::CapabilityUnavailable("mp4Probe"))?;
        if !mp4["format"]["format_name"]
            .as_str()
            .is_some_and(|names| names.split(',').any(|name| name == "mp4"))
        {
            return Err(MediaError::CapabilityUnavailable("mp4Probe"));
        }
        if !streams(&mp4).any(|stream| {
            stream["codec_type"] == "video"
                && stream["codec_name"] == "h264"
                && stream["pix_fmt"] == "yuv420p"
                && stream["avg_frame_rate"] == "30/1"
                && stream["width"] == 320
                && stream["height"] == 180
        }) {
            return Err(MediaError::CapabilityUnavailable("h264"));
        }
        if !streams(&mp4).any(|stream| {
            stream["codec_type"] == "audio"
                && stream["codec_name"] == "aac"
                && stream["sample_rate"] == "48000"
                && stream["channels"] == 2
        }) {
            return Err(MediaError::CapabilityUnavailable("aac"));
        }
        run_ffmpeg(
            &ffmpeg,
            workspace,
            &[
                "-i",
                "probe.mp4",
                "-map",
                "0:v:0",
                "-map",
                "0:a:0",
                "-f",
                "null",
                "-",
            ],
        )
        .ok_or(MediaError::CapabilityUnavailable("decode"))?;

        let subtitle_burn_in = config
            .subtitle_font
            .as_ref()
            .is_some_and(|font| probe_subtitle(&ffmpeg, workspace, font));
        let mut fingerprint = Sha256::new();
        for input in [
            &ffmpeg_build[..],
            &ffprobe_build[..],
            h264_encoder.as_bytes(),
        ] {
            fingerprint.update((input.len() as u64).to_le_bytes());
            fingerprint.update(input);
        }
        Ok(Self {
            ffmpeg,
            ffprobe,
            h264_encoder,
            build_fingerprint: hex::encode(fingerprint.finalize()),
            capabilities: MediaCapabilities {
                probe: true,
                decode: true,
                h264: true,
                aac: true,
                subtitle_burn_in,
            },
        })
    }

    pub(crate) fn capabilities(&self) -> &MediaCapabilities {
        &self.capabilities
    }

    pub(crate) fn require_release_capabilities(&self) -> Result<(), MediaError> {
        if !self.capabilities.subtitle_burn_in {
            return Err(MediaError::CapabilityUnavailable("subtitleBurnIn"));
        }
        Ok(())
    }
}

fn resolve_tool(path: &Path, name: &'static str) -> Result<PathBuf, MediaError> {
    if !path.is_absolute() {
        return Err(MediaError::ToolUnavailable(name));
    }
    match fs::canonicalize(path) {
        Ok(path) if path.is_file() => Ok(path),
        _ => Err(MediaError::ToolUnavailable(name)),
    }
}

fn tool_version(
    tool: &Path,
    workspace: &Path,
    name: &'static str,
    prefix: &[u8],
) -> Result<Vec<u8>, MediaError> {
    run(tool, workspace, &["-version"])
        .filter(|output| output.starts_with(prefix))
        .ok_or(MediaError::ToolUnavailable(name))
}

fn inspect(ffprobe: &Path, workspace: &Path, path: &str) -> Option<Value> {
    let output = run(
        ffprobe,
        workspace,
        &[
            "-v",
            "error",
            "-show_entries",
            "format=format_name:stream=codec_name,codec_type,pix_fmt,avg_frame_rate,width,height,sample_rate,channels",
            "-of",
            "json",
            path,
        ],
    )?;
    serde_json::from_slice(&output).ok()
}

fn streams(metadata: &Value) -> impl Iterator<Item = &Value> {
    metadata["streams"].as_array().into_iter().flatten()
}

fn probe_subtitle(ffmpeg: &Path, workspace: &Path, font: &SubtitleFont) -> bool {
    if font.family.is_empty()
        || !font
            .family
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b' ' | b'-' | b'_'))
        || !font.path.is_absolute()
    {
        return false;
    }
    let Some(extension @ ("otf" | "ttf" | "ttc")) = font
        .path
        .extension()
        .and_then(|extension| extension.to_str())
    else {
        return false;
    };
    let fonts = workspace.join("fonts");
    if fs::create_dir(&fonts).is_err()
        || fs::copy(&font.path, fonts.join(format!("probe.{extension}"))).is_err()
    {
        return false;
    }
    let filter = format!(
        "subtitles=filename=probe.srt:fontsdir=fonts:force_style='FontName={}'",
        font.family
    );
    let frame = |filter, path| {
        run_ffmpeg(
            ffmpeg,
            workspace,
            &[
                "-i",
                "probe.mp4",
                "-an",
                "-vf",
                filter,
                "-frames:v",
                "1",
                "-pix_fmt",
                "rgb24",
                "-f",
                "rawvideo",
                path,
            ],
        )?;
        let pixels = fs::read(workspace.join(path)).ok()?;
        (pixels.len() == PROBE_FRAME_BYTES).then_some(pixels)
    };
    match (frame("null", "plain.rgb"), frame(&filter, "subtitle.rgb")) {
        (Some(plain), Some(subtitle)) => plain != subtitle,
        _ => false,
    }
}

fn run_ffmpeg(ffmpeg: &Path, workspace: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let args = [&["-nostdin", "-v", "error", "-xerror"][..], args].concat();
    run(ffmpeg, workspace, &args)
}

fn run(tool: &Path, workspace: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let mut stdout: File = tempfile::tempfile().ok()?;
    let mut child = Command::new(tool)
        .args(args)
        .current_dir(workspace)
        .stdin(Stdio::null())
        .stdout(stdout.try_clone().ok()?)
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) => return None,
            Ok(None) if started.elapsed() < PROBE_TIMEOUT => {
                thread::sleep(Duration::from_millis(10));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    stdout.seek(SeekFrom::Start(0)).ok()?;
    let mut output = Vec::new();
    stdout
        .take(MAX_RESPONSE_BYTES + 1)
        .read_to_end(&mut output)
        .ok()?;
    (output.len() as u64 <= MAX_RESPONSE_BYTES).then_some(output)
}

#[cfg(all(test, unix))]
mod tests;
