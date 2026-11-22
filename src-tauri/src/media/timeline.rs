use serde::{Deserialize, Serialize};

pub const TICKS_PER_SECOND: i64 = 240_000;
pub const TICKS_PER_FRAME: i64 = 8_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineClip {
    pub id: String,
    pub asset_id: String,
    pub source_in_ticks: i64,
    pub source_out_ticks: i64,
    #[serde(default = "default_true")]
    pub enabled: bool,
}
fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineData {
    pub id: String,
    pub revision: i64,
    pub assembly_scope: String,
    pub clips: Vec<TimelineClip>,
    #[serde(default)]
    pub subtitle_cues: Vec<SubtitleCue>,
    #[serde(default)]
    pub audio_tracks: Vec<AudioTrack>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrack {
    pub id: String,
    pub asset_id: String,
    pub source_in_ticks: i64,
    pub source_out_ticks: i64,
    pub timeline_in_ticks: i64,
    pub gain: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleCue {
    pub id: String,
    pub start_ticks: i64,
    pub end_ticks: i64,
    pub text: String,
    pub anchor_clip_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub duration_ticks: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompiledClip {
    pub id: String,
    pub asset_id: String,
    pub source_in_ticks: i64,
    pub source_out_ticks: i64,
    pub timeline_in_ticks: i64,
    pub timeline_out_ticks: i64,
    pub frame_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TimelinePlan {
    pub clips: Vec<CompiledClip>,
    pub audio_tracks: Vec<AudioTrack>,
    pub total_ticks: i64,
    /// 阻断级问题：必须定位修复，不能靠「忽略」输出。
    pub issues: Vec<String>,
    /// 必须明确确认级问题：逐项确认后仍可交付。
    pub warnings: Vec<String>,
}

pub fn validate_timeline(
    data: &TimelineData,
    sources: &std::collections::HashMap<String, SourceInfo>,
) -> Result<TimelinePlan, String> {
    if data.assembly_scope != "local" && data.assembly_scope != "episode" {
        return Err("TIMELINE_SCOPE_INVALID".into());
    }
    let mut cursor = 0i64;
    let mut clips = Vec::new();
    let mut issues = Vec::new();
    let mut warnings = Vec::new();
    for clip in &data.clips {
        if !clip.enabled {
            continue;
        }
        let Some(source) = sources.get(&clip.asset_id) else {
            issues.push(format!("TIMELINE_SOURCE_MISSING:{}", clip.id));
            continue;
        };
        if clip.source_in_ticks < 0 || clip.source_out_ticks > source.duration_ticks {
            issues.push(format!("TIMELINE_RANGE_INVALID:{}", clip.id));
            continue;
        }
        let Some(duration) = clip.source_out_ticks.checked_sub(clip.source_in_ticks) else {
            issues.push(format!("TIMELINE_RANGE_INVALID:{}", clip.id));
            continue;
        };
        if duration <= 0 {
            issues.push(format!("TIMELINE_RANGE_INVALID:{}", clip.id));
            continue;
        }
        if duration < TICKS_PER_FRAME {
            issues.push(format!("TIMELINE_CLIP_TOO_SHORT:{}", clip.id));
        }
        let timeline_out_ticks = cursor.saturating_add(duration);
        clips.push(CompiledClip {
            id: clip.id.clone(),
            asset_id: clip.asset_id.clone(),
            source_in_ticks: clip.source_in_ticks,
            source_out_ticks: clip.source_out_ticks,
            timeline_in_ticks: cursor,
            timeline_out_ticks,
            frame_count: duration.saturating_add(TICKS_PER_FRAME / 2) / TICKS_PER_FRAME,
        });
        cursor = timeline_out_ticks;
    }
    let mut cue_ids = std::collections::HashSet::new();
    for cue in &data.subtitle_cues {
        if !cue_ids.insert(&cue.id) || cue.start_ticks < 0 || cue.end_ticks <= cue.start_ticks || cue.end_ticks > cursor {
            issues.push(format!("SUBTITLE_OUT_OF_RANGE:{}", cue.id));
        }
    }
    let mut audio_tracks = Vec::new();
    for track in &data.audio_tracks {
        let Some(source) = sources.get(&track.asset_id) else {
            issues.push(format!("TIMELINE_AUDIO_SOURCE_MISSING:{}", track.id));
            continue;
        };
        let valid = track.source_in_ticks >= 0
            && track.source_out_ticks <= source.duration_ticks
            && track.timeline_in_ticks >= 0
            && track.gain.is_finite()
            && (0.0..=2.0).contains(&track.gain)
            && matches!(track.source_out_ticks.checked_sub(track.source_in_ticks), Some(duration) if duration > 0);
        if !valid {
            warnings.push(format!("TIMELINE_AUDIO_TRACK_INVALID:{}", track.id));
            continue;
        }
        audio_tracks.push(track.clone());
    }
    Ok(TimelinePlan {
        clips,
        audio_tracks,
        total_ticks: cursor,
        issues,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compile_matches_shared_timeline_fixture() {
        let data = TimelineData {
            id: "t".into(),
            revision: 1,
            assembly_scope: "local".into(),
            clips: vec![
                TimelineClip {
                    id: "a".into(),
                    asset_id: "a".into(),
                    source_in_ticks: 120_000,
                    source_out_ticks: 1_080_000,
                    enabled: true,
                },
                TimelineClip {
                    id: "b".into(),
                    asset_id: "b".into(),
                    source_in_ticks: 240_000,
                    source_out_ticks: 960_000,
                    enabled: true,
                },
                TimelineClip {
                    id: "c".into(),
                    asset_id: "c".into(),
                    source_in_ticks: 120_000,
                    source_out_ticks: 840_000,
                    enabled: true,
                },
            ],
            subtitle_cues: vec![],
            audio_tracks: vec![],
        };
        let sources = ["a", "b", "c"]
            .into_iter()
            .map(|id| {
                (
                    id.to_string(),
                    SourceInfo {
                        duration_ticks: 2_000_000,
                    },
                )
            })
            .collect();
        let plan = validate_timeline(&data, &sources).unwrap();
        assert_eq!(plan.total_ticks, 2_400_000);
        assert_eq!(
            plan.clips.iter().map(|clip| clip.frame_count).sum::<i64>(),
            300
        );
        assert!(plan.issues.is_empty());
        assert!(plan.warnings.is_empty());
    }

    fn clip(id: &str, source_in_ticks: i64, source_out_ticks: i64) -> TimelineClip {
        TimelineClip {
            id: id.into(),
            asset_id: "a".into(),
            source_in_ticks,
            source_out_ticks,
            enabled: true,
        }
    }

    fn sources() -> std::collections::HashMap<String, SourceInfo> {
        [("a".to_string(), SourceInfo { duration_ticks: 2_000_000 })]
            .into_iter()
            .collect()
    }

    #[test]
    fn rejects_overflowing_and_negative_tick_ranges_without_panicking() {
        let data = TimelineData {
            id: "t".into(),
            revision: 1,
            assembly_scope: "local".into(),
            clips: vec![
                clip("overflow", i64::MIN, 0),
                clip("negative", -1, 240_000),
                clip("reversed", 480_000, 240_000),
            ],
            subtitle_cues: vec![],
            audio_tracks: vec![],
        };
        let plan = validate_timeline(&data, &sources()).unwrap();
        assert!(plan.clips.is_empty());
        assert_eq!(
            plan.issues,
            vec![
                "TIMELINE_RANGE_INVALID:overflow",
                "TIMELINE_RANGE_INVALID:negative",
                "TIMELINE_RANGE_INVALID:reversed",
            ]
        );
    }

    #[test]
    fn invalid_audio_track_becomes_a_warning_and_is_excluded_from_the_plan() {
        let data = TimelineData {
            id: "t".into(),
            revision: 1,
            assembly_scope: "local".into(),
            clips: vec![],
            subtitle_cues: vec![],
            audio_tracks: vec![
                AudioTrack {
                    id: "good".into(),
                    asset_id: "a".into(),
                    source_in_ticks: 0,
                    source_out_ticks: 240_000,
                    timeline_in_ticks: 0,
                    gain: 1.0,
                },
                AudioTrack {
                    id: "beyond-end".into(),
                    asset_id: "a".into(),
                    source_in_ticks: 0,
                    source_out_ticks: 3_000_000,
                    timeline_in_ticks: 0,
                    gain: 1.0,
                },
                AudioTrack {
                    id: "overflow".into(),
                    asset_id: "a".into(),
                    source_in_ticks: i64::MIN,
                    source_out_ticks: 0,
                    timeline_in_ticks: 0,
                    gain: 1.0,
                },
                AudioTrack {
                    id: "gain".into(),
                    asset_id: "a".into(),
                    source_in_ticks: 0,
                    source_out_ticks: 240_000,
                    timeline_in_ticks: 0,
                    gain: f64::NAN,
                },
            ],
        };
        let plan = validate_timeline(&data, &sources()).unwrap();
        assert_eq!(
            plan.audio_tracks.iter().map(|track| track.id.as_str()).collect::<Vec<_>>(),
            vec!["good"]
        );
        assert!(plan.issues.is_empty());
        assert_eq!(
            plan.warnings,
            vec![
                "TIMELINE_AUDIO_TRACK_INVALID:beyond-end",
                "TIMELINE_AUDIO_TRACK_INVALID:overflow",
                "TIMELINE_AUDIO_TRACK_INVALID:gain",
            ]
        );
    }

    #[test]
    fn missing_audio_source_blocks_and_missing_clip_source_blocks() {
        let data = TimelineData {
            id: "t".into(),
            revision: 1,
            assembly_scope: "local".into(),
            clips: vec![TimelineClip {
                id: "c".into(),
                asset_id: "missing".into(),
                source_in_ticks: 0,
                source_out_ticks: 240_000,
                enabled: true,
            }],
            subtitle_cues: vec![],
            audio_tracks: vec![AudioTrack {
                id: "voice".into(),
                asset_id: "missing".into(),
                source_in_ticks: 0,
                source_out_ticks: 240_000,
                timeline_in_ticks: 0,
                gain: 1.0,
            }],
        };
        let plan = validate_timeline(&data, &sources()).unwrap();
        assert_eq!(
            plan.issues,
            vec![
                "TIMELINE_SOURCE_MISSING:c",
                "TIMELINE_AUDIO_SOURCE_MISSING:voice",
            ]
        );
        assert!(plan.warnings.is_empty());
        assert!(plan.audio_tracks.is_empty());
    }
}
