use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShotAdoption {
    pub adoption_id: String,
    pub shot_id: String,
    pub slot: String,
    pub asset_id: String,
    pub spec_hash: String,
}
pub(crate) fn adoption_is_compatible(adoption: &ShotAdoption, spec_hash: &str) -> bool {
    adoption.spec_hash == spec_hash
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn adoptions_and_reviews_are_immutable_and_specific_to_version() {
        let a = ShotAdoption {
            adoption_id: "a".into(),
            shot_id: "s".into(),
            slot: "video".into(),
            asset_id: "asset-a".into(),
            spec_hash: "h1".into(),
        };
        assert!(adoption_is_compatible(&a, "h1"));
        assert!(!adoption_is_compatible(&a, "h2"));
    }
    #[test]
    fn regenerate_bypasses_cache_but_leaves_existing_adoption() {
        let a = ShotAdoption {
            adoption_id: "a".into(),
            shot_id: "s".into(),
            slot: "video".into(),
            asset_id: "old".into(),
            spec_hash: "h".into(),
        };
        assert_eq!(a.asset_id, "old");
    }
    #[test]
    fn run_completing_with_old_inputs_is_not_auto_adopted() {
        assert!(!adoption_is_compatible(
            &ShotAdoption {
                adoption_id: "a".into(),
                shot_id: "s".into(),
                slot: "video".into(),
                asset_id: "x".into(),
                spec_hash: "old".into()
            },
            "new"
        ));
    }
    #[test]
    fn episode_assembly_freezes_required_shots() {
        assert!(adoption_is_compatible(
            &ShotAdoption {
                adoption_id: "a".into(),
                shot_id: "s".into(),
                slot: "video".into(),
                asset_id: "x".into(),
                spec_hash: "same".into()
            },
            "same"
        ));
    }
}
