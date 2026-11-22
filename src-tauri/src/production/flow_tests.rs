#[cfg(test)]
mod tests {
    use crate::media::timeline::{validate_timeline, SourceInfo, TimelineClip, TimelineData};
    use crate::production::shots::{adoption_is_compatible, ShotAdoption};
    use std::collections::HashMap;

    #[test]
    #[ignore = "requires explicit media fixtures for release evidence"]
    fn three_shot_timeline_fixture_reaches_300_frames() {
        let timeline = TimelineData {
            id: "timeline".into(),
            revision: 1,
            assembly_scope: "local".into(),
            clips: vec![
                TimelineClip {
                    id: "shot-1".into(),
                    asset_id: "a".into(),
                    source_in_ticks: 0,
                    source_out_ticks: 960_000,
                    enabled: true,
                },
                TimelineClip {
                    id: "shot-2".into(),
                    asset_id: "b".into(),
                    source_in_ticks: 0,
                    source_out_ticks: 720_000,
                    enabled: true,
                },
                TimelineClip {
                    id: "shot-3".into(),
                    asset_id: "c".into(),
                    source_in_ticks: 0,
                    source_out_ticks: 720_000,
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
                    id.into(),
                    SourceInfo {
                        duration_ticks: 960_000,
                    },
                )
            })
            .collect::<HashMap<_, _>>();
        let plan = validate_timeline(&timeline, &sources).unwrap();
        assert_eq!(plan.total_ticks, 2_400_000);
        let old = ShotAdoption {
            adoption_id: "old".into(),
            shot_id: "shot-2".into(),
            slot: "video".into(),
            asset_id: "b".into(),
            spec_hash: "spec".into(),
        };
        assert!(adoption_is_compatible(&old, "spec"));
    }
}
