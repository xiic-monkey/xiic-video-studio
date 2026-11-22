use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ShotReferenceInput {
    pub subject_version_ids: Vec<String>,
    pub generic_reference_ids: Vec<String>,
    pub first_frame_id: Option<String>,
    pub last_frame_id: Option<String>,
    #[serde(default)]
    pub previous_tail_frame_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResolvedShotReferences {
    pub descriptor: String,
    pub ordered_inputs: Vec<String>,
    pub excluded_inputs: Vec<ExcludedInput>,
    pub fingerprint: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExcludedInput { pub id: String, pub reason: String }
pub(crate) fn resolve_shot_references(input: &ShotReferenceInput) -> ResolvedShotReferences {
    let mut ordered = Vec::new();
    let mut excluded = Vec::new();
    for id in &input.subject_version_ids {
        if ordered.contains(id) { excluded.push(ExcludedInput { id: id.clone(), reason: "duplicate_subject_version".into() }); }
        else { ordered.push(id.clone()); }
    }
    for id in &input.generic_reference_ids {
        if input.first_frame_id.as_ref() == Some(id) || input.last_frame_id.as_ref() == Some(id) {
            excluded.push(ExcludedInput { id: id.clone(), reason: "frame_port_reference_conflict".into() });
        } else if !ordered.contains(id) { ordered.push(id.clone()); }
    }
    if let Some(id) = &input.first_frame_id { ordered.push(id.clone()); }
    if let Some(id) = &input.last_frame_id { ordered.push(id.clone()); }
    if let Some(id) = &input.previous_tail_frame_id { ordered.push(id.clone()); }
    let descriptor = format!("subjects:{};generic:{};first:{};last:{}", input.subject_version_ids.len(), input.generic_reference_ids.len(), input.first_frame_id.is_some(), input.last_frame_id.is_some());
    let mut h = Sha256::new();
    h.update(serde_json::to_vec(&serde_json::json!({"descriptor":descriptor,"orderedInputs":ordered})).unwrap_or_default());
    ResolvedShotReferences { descriptor, ordered_inputs: ordered, excluded_inputs: excluded, fingerprint: hex::encode(h.finalize()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_shared_resolution_cases() {
        let a = resolve_shot_references(&ShotReferenceInput {
            subject_version_ids: vec!["r".into(), "r".into()],
            generic_reference_ids: vec!["g".into()],
            first_frame_id: Some("f".into()),
            last_frame_id: Some("l".into()),
            previous_tail_frame_id: None,
        });
        assert_eq!(a.ordered_inputs, vec!["r", "g", "f", "l"]);
        assert_eq!(a.excluded_inputs.len(), 1);
    }
    #[test]
    fn fingerprint_includes_frozen_previous_tail() {
        let a = resolve_shot_references(&ShotReferenceInput {
            subject_version_ids: vec!["v1".into()],
            generic_reference_ids: vec![],
            first_frame_id: None,
            last_frame_id: None,
            previous_tail_frame_id: Some("tail-a".into()),
        });
        let b = resolve_shot_references(&ShotReferenceInput {
            subject_version_ids: vec!["v2".into()],
            generic_reference_ids: vec![],
            first_frame_id: None,
            last_frame_id: None,
            previous_tail_frame_id: Some("tail-b".into()),
        });
        assert_ne!(a.fingerprint, b.fingerprint);
    }
}
