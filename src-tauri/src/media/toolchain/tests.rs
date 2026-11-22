use super::*;
use std::{fs, os::unix::fs::PermissionsExt, path::Path};
use tempfile::TempDir;

fn executable(folder: &TempDir, name: &str, body: &str) -> PathBuf {
    let path = folder.path().join(name);
    fs::write(&path, format!("#!/bin/sh\n{body}")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    path
}

fn local_config(folder: &TempDir, has_subtitles: bool) -> ToolchainConfig {
    let ffmpeg = executable(
        folder,
        "ffmpeg",
        &format!(
            r#"
case "$*" in
  '-version') printf '%s\n' 'ffmpeg version fixture';;
  *subtitle.rgb) if [ '{has_subtitles}' = true ]; then /usr/bin/head -c 172800 /dev/zero | LC_ALL=C /usr/bin/tr '\000' '\377' > subtitle.rgb; else exit 1; fi;;
  *plain.rgb) /usr/bin/head -c 172800 /dev/zero > plain.rgb;;
  *' -c:v libx264 '*' -c:a aac '*probe.mp4) printf 'fixture' > probe.mp4;;
  *'-i probe.mp4'*'-f null -') [ -s probe.mp4 ];;
  *) exit 1;;
esac
"#
        ),
    );
    let ffprobe = executable(
        folder,
        "ffprobe",
        r#"
case "$*" in
  '-version') printf '%s\n' 'ffprobe version fixture';;
  *probe.mp4) [ -s probe.mp4 ] && printf '%s\n' '{"format":{"format_name":"mov,mp4"},"streams":[{"codec_name":"h264","codec_type":"video","pix_fmt":"yuv420p","avg_frame_rate":"30/1","width":320,"height":180},{"codec_name":"aac","codec_type":"audio","sample_rate":"48000","channels":2}]}';;
  *probe.srt) [ -s probe.srt ] && printf '%s\n' '{"streams":[{"codec_name":"subrip","codec_type":"subtitle"}]}';;
  *) exit 1;;
esac
"#,
    );
    let font = folder.path().join("cjk.otf");
    fs::write(&font, b"fixture").unwrap();
    ToolchainConfig {
        ffmpeg,
        ffprobe,
        h264_encoder: H264Encoder::LibX264,
        subtitle_font: Some(SubtitleFont {
            path: font,
            family: "Noto Sans CJK SC".into(),
        }),
    }
}

#[test]
fn rejects_missing_or_incomplete_toolchain() {
    let folder = tempfile::tempdir().unwrap();
    let mut config = local_config(&folder, false);
    let ffprobe = config.ffprobe.clone();
    config.ffprobe = folder.path().join("absent");
    assert_eq!(
        MediaToolchain::probe(&config).unwrap_err(),
        MediaError::ToolUnavailable("ffprobe")
    );

    config.ffprobe = ffprobe;
    config.h264_encoder = H264Encoder::VideoToolbox;
    assert_eq!(
        MediaToolchain::probe(&config).unwrap_err(),
        MediaError::CapabilityUnavailable("mp4Encode")
    );

    config.h264_encoder = H264Encoder::LibX264;
    let toolchain = MediaToolchain::probe(&config).unwrap();
    assert_eq!(
        toolchain.capabilities(),
        &MediaCapabilities {
            probe: true,
            decode: true,
            h264: true,
            aac: true,
            subtitle_burn_in: false,
        }
    );
    assert_eq!(
        toolchain.require_release_capabilities(),
        Err(MediaError::CapabilityUnavailable("subtitleBurnIn"))
    );
    config.ffmpeg = Path::new("ffmpeg").into();
    assert_eq!(
        MediaToolchain::probe(&config).unwrap_err(),
        MediaError::ToolUnavailable("ffmpeg")
    );
}

#[test]
fn passes_only_with_required_capabilities() {
    let folder = tempfile::tempdir().unwrap();
    let mut config = local_config(&folder, true);
    let toolchain = MediaToolchain::probe(&config).unwrap();
    assert!(toolchain.capabilities().subtitle_burn_in);
    assert_eq!(toolchain.require_release_capabilities(), Ok(()));

    config.subtitle_font = None;
    let toolchain = MediaToolchain::probe(&config).unwrap();
    assert_eq!(
        toolchain.require_release_capabilities(),
        Err(MediaError::CapabilityUnavailable("subtitleBurnIn"))
    );
}

#[test]
#[ignore = "requires explicitly configured FFmpeg and FFprobe"]
fn probes_real_local_media_toolchain() {
    let required_path = |name: &str| -> PathBuf {
        std::env::var_os(name)
            .unwrap_or_else(|| panic!("Set {name} to the absolute path of the tested tool"))
            .into()
    };
    let subtitle_font = std::env::var_os("FRAMEFORGE_TEST_FONT_DIR").map(|folder| SubtitleFont {
        path: PathBuf::from(folder).join(
            std::env::var("FRAMEFORGE_TEST_FONT_FILE")
                .unwrap_or_else(|_| "NotoSansCJKsc-Regular.otf".into()),
        ),
        family: std::env::var("FRAMEFORGE_TEST_FONT_FAMILY")
            .unwrap_or_else(|_| "Noto Sans CJK SC".into()),
    });
    let h264_encoder = match std::env::var("FRAMEFORGE_TEST_H264_ENCODER").as_deref() {
        Ok("libx264") => H264Encoder::LibX264,
        Ok("h264_videotoolbox") | Err(std::env::VarError::NotPresent) => H264Encoder::VideoToolbox,
        _ => panic!("FRAMEFORGE_TEST_H264_ENCODER must be libx264 or h264_videotoolbox"),
    };
    let config = ToolchainConfig {
        ffmpeg: required_path("FRAMEFORGE_TEST_FFMPEG"),
        ffprobe: required_path("FRAMEFORGE_TEST_FFPROBE"),
        h264_encoder,
        subtitle_font,
    };
    let toolchain = MediaToolchain::probe(&config).expect("MP4 decode/encode and SRT probe");
    assert_eq!(toolchain.ffmpeg, config.ffmpeg.canonicalize().unwrap());
    assert_eq!(toolchain.ffprobe, config.ffprobe.canonicalize().unwrap());
    assert_eq!(toolchain.h264_encoder, config.h264_encoder.name());
    assert_eq!(toolchain.build_fingerprint.len(), 64);
    assert_eq!(
        toolchain.require_release_capabilities(),
        if config.subtitle_font.is_some() {
            Ok(())
        } else {
            Err(MediaError::CapabilityUnavailable("subtitleBurnIn"))
        }
    );
    eprintln!(
        "probe {:?}, encoder {}, fingerprint {}",
        toolchain.capabilities(),
        toolchain.h264_encoder,
        toolchain.build_fingerprint
    );
}
