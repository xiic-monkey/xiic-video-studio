//! 旧项目导入：把旧版 Frameforge 项目 JSON 映射成新画布文档。
//!
//! 输入一个旧项目 JSON，输出新画布文档 + 运行记录 + 中文警告，并把素材复制进 CAS。
//! 所有文件读写与网络请求都在 Rust 侧完成：本地路径必须落在允许的目录内，
//! 远端地址必须是通过 `security::validate_remote_url` 校验的公网 https。
//!
//! P0 边界（写死在这里，避免越界）：
//! - 只映射到 P0 原语节点：characters → 文本 + 图片节点，scenes → 文本节点，
//!   shots → 视频节点，storyboards / referenceBindings → 图片节点 + 边。
//!   P1 的 CharacterEntity / ShotEntity / 三视图 / 时间线不在这里。
//! - 导入产生的节点带 `ui.pinned`：它们是既有成果，不参与过期传播；
//!   改动上游后由用户手动解锁重生成。
//! - 每个镜头的视频模式必须自洽：有首/尾帧 → `firstLast`；无帧但有参考 → `reference`；
//!   两者都无 → `t2v`。这样导入出来的画布不会一进 `validateBoard` 就报
//!   `GRAPH_PORT_HIDDEN` / `VIDEO_MODE_CONFLICT`。

use crate::assets;
use crate::db;
use crate::gateway::AppError;
use crate::runs::{self, RunRecord};
use crate::security;
use crate::AppState;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

pub const MAX_H3_REFERENCES: usize = 9;
pub const MAX_LEGACY_JSON_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_ASSET_BYTES: u64 = 256 * 1024 * 1024;
pub const NODE_BUDGET_WARNING: usize = 500;

const COLUMN: f64 = 340.0;
const ORIGIN_X: f64 = 40.0;
const ROW_CHARACTER: f64 = 40.0;
const ROW_PORTRAIT: f64 = 240.0;
const ROW_SCENE: f64 = 470.0;
const ROW_SHOT: f64 = 700.0;
const ROW_MEDIA: f64 = 930.0;
const MEDIA_STEP: f64 = 200.0;

/// 旧项目里需要下载进 CAS 的素材来源（远端 URL 或旧本地路径）。
#[derive(Debug, Clone, PartialEq)]
pub struct LegacySource {
    pub url: String,
    pub kind: &'static str,
}

/// 导入结果：前端据此刷新项目库，并把警告原样展示给用户。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyImportResult {
    pub project: Value,
    pub board: Value,
    pub asset_count: usize,
    pub run_count: usize,
    pub warnings: Vec<String>,
}

fn str_field(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or("").trim().to_string()
}

fn as_array<'a>(value: &'a Value, key: &str) -> Vec<&'a Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|items| items.iter().collect())
        .unwrap_or_default()
}

fn kind_for_candidate(value: &Value) -> &'static str {
    match str_field(value, "kind").as_str() {
        "video" => "video",
        "audio" => "audio",
        _ => "image",
    }
}

fn kind_for_url(url: &str) -> &'static str {
    let lowered = url.to_ascii_lowercase();
    if [".mp4", ".mov", ".webm", ".mkv"].iter().any(|suffix| lowered.ends_with(suffix)) {
        "video"
    } else if [".mp3", ".wav", ".m4a", ".aac", ".ogg"].iter().any(|suffix| lowered.ends_with(suffix)) {
        "audio"
    } else {
        "image"
    }
}

/// 候选标签是否指向某个镜头。旧数据没有 shotId，只能靠 label 兜底；
/// 这里做「整词」匹配，避免「镜头 1」误匹配「镜头 12」、「sh1」误匹配「sh12」。
fn label_matches_shot(label: &str, shot_id: &str, number: i64) -> bool {
    if contains_token(label, shot_id) {
        return true;
    }
    const MARKER: &str = "镜头 ";
    let mut cursor = 0;
    while let Some(at) = label[cursor..].find(MARKER) {
        let after = &label[cursor + at + MARKER.len()..];
        let digits: String = after.chars().take_while(|value| value.is_ascii_digit()).collect();
        if !digits.is_empty() && digits.parse::<i64>().ok() == Some(number) {
            return true;
        }
        cursor += at + MARKER.len();
    }
    false
}

/// 标签里是否出现完整的标识符：后面不能再紧跟字母或数字。
fn contains_token(label: &str, token: &str) -> bool {
    if token.is_empty() {
        return false;
    }
    let mut cursor = 0;
    while let Some(at) = label[cursor..].find(token) {
        let after = &label[cursor + at + token.len()..];
        let boundary_ok = after.chars().next().map(|value| !value.is_ascii_alphanumeric()).unwrap_or(true);
        if boundary_ok {
            return true;
        }
        cursor += at + token.len();
    }
    false
}

/// 收集旧项目里所有需要导入的素材来源（去重，保持首次出现的顺序）。
pub fn collect_asset_sources(value: &Value) -> Vec<LegacySource> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut sources: Vec<LegacySource> = Vec::new();
    let mut push = |url: &str, kind: &'static str| {
        let trimmed = url.trim();
        if trimmed.is_empty() || trimmed.starts_with("blob:") {
            return;
        }
        if seen.insert(trimmed.to_string()) {
            sources.push(LegacySource { url: trimmed.to_string(), kind });
        }
    };

    for character in as_array(value, "characters") {
        push(&str_field(character, "portraitUrl"), "image");
    }
    for storyboard in as_array(value, "storyboards") {
        if storyboard.get("selected").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        push(&str_field(storyboard, "url"), "image");
    }
    let mut candidates: HashMap<String, &Value> = HashMap::new();
    for candidate in as_array(value, "candidates") {
        let id = str_field(candidate, "id");
        if !id.is_empty() {
            candidates.insert(id, candidate);
        }
    }
    for binding in as_array(value, "referenceBindings") {
        let asset_id = str_field(binding, "assetId");
        match candidates.get(&asset_id) {
            Some(candidate) => push(&str_field(candidate, "url"), kind_for_candidate(candidate)),
            None => push(&str_field(binding, "sourceUrl"), kind_for_url(&str_field(binding, "sourceUrl"))),
        }
    }
    for candidate in as_array(value, "candidates") {
        if candidate.get("selected").and_then(Value::as_bool) == Some(true) {
            push(&str_field(candidate, "url"), kind_for_candidate(candidate));
        }
    }
    sources
}

/// 旧项目 → 新项目文档（画布之外的样式指南与画幅）。
pub fn build_legacy_project(value: &Value, project_id: &str) -> Value {
    let now = chrono::Utc::now().to_rfc3339();
    let guide = value.get("styleGuide").cloned().unwrap_or_else(|| json!({}));
    let ratio = match str_field(value, "aspectRatio").as_str() {
        "16:9" => "16:9",
        "1:1" => "1:1",
        _ => "9:16",
    };
    let name = str_field(value, "name");
    let name = if name.is_empty() { "导入的旧项目".to_string() } else { name };
    json!({
        "schemaVersion": 1,
        "id": project_id,
        "name": name,
        "aspectRatio": ratio,
        "styleGuide": {
            "genre": str_field(&guide, "genre"),
            "visualStyle": str_field(&guide, "visualStyle"),
            "colorLanguage": str_field(&guide, "colorLanguage"),
            "cameraLanguage": str_field(&guide, "cameraLanguage"),
            "era": str_field(&guide, "era"),
            "constraints": str_field(&guide, "constraints"),
            "negative": str_field(&guide, "negativeConstraints"),
            "version": 1
        },
        "createdAt": now,
        "updatedAt": now
    })
}

fn column(index: usize) -> f64 {
    ORIGIN_X + index as f64 * COLUMN
}

fn node(node_type: &str, id: &str, x: f64, y: f64, data: Value, pinned: bool) -> Value {
    let mut node = json!({
        "id": id, "type": node_type, "typeVersion": 1,
        "position": { "x": x, "y": y }, "z": 0, "data": data
    });
    if pinned {
        node["ui"] = json!({ "pinned": true });
    }
    node
}

fn edge(id: &str, source: &str, source_port: &str, target: &str, target_port: &str, role: &str) -> Value {
    json!({
        "id": id, "source": source, "sourcePort": source_port,
        "target": target, "targetPort": target_port, "role": role,
        "createdAt": chrono::Utc::now().to_rfc3339()
    })
}

/// 导入出来的素材算一次「已完成的运行」：不参与过期传播，也能在画布上显示为已有结果。
fn imported_run(project_id: &str, board_id: &str, node_id: &str, asset_id: &str, prompt: &str) -> RunRecord {
    let now = chrono::Utc::now().to_rfc3339();
    RunRecord {
        id: format!("run_{}", uuid::Uuid::new_v4()),
        project_id: project_id.to_string(),
        board_id: board_id.to_string(),
        node_id: node_id.to_string(),
        entity_id: None,
        action: "import".to_string(),
        cache_key: format!("imported-{node_id}"),
        status: "succeeded".to_string(),
        provider_id: None,
        model: None,
        prompt_snapshot: json!({
            "text": prompt, "segments": [], "hash": format!("imported-{asset_id}"), "locked": true
        }),
        params: json!({}),
        input_asset_ids: vec![],
        output_asset_ids: vec![asset_id.to_string()],
        selected_asset_id: Some(asset_id.to_string()),
        cost: Some(json!({ "estimated": { "amount": 0, "currency": "", "unit": "导入" } })),
        error: None,
        route: vec![],
        started_at: now.clone(),
        finished_at: Some(now),
    }
}

/// 旧项目 → 新画布文档。`asset_ids` 是「旧素材 URL → 新素材 id」的映射，
/// 由上一段（下载进 CAS）填充；查不到的素材会被跳过并写进警告。
pub fn build_legacy_board(
    value: &Value,
    project_id: &str,
    board_id: &str,
    asset_ids: &HashMap<String, String>,
) -> (Value, Vec<RunRecord>, Vec<String>) {
    let mut warnings: Vec<String> = Vec::new();
    let mut nodes: serde_json::Map<String, Value> = serde_json::Map::new();
    let mut edges: serde_json::Map<String, Value> = serde_json::Map::new();
    let mut runs: Vec<RunRecord> = Vec::new();

    let mut push_node = |id: String, item: Value| {
        nodes.insert(id, item);
    };
    let mut push_edge = |id: String, item: Value| {
        edges.insert(id, item);
    };

    // 角色：简介文本节点 + 定妆图片节点
    let characters = as_array(value, "characters");
    for (index, character) in characters.iter().enumerate() {
        let brief_id = format!("node_char_{}", index + 1);
        let portrait_id = format!("node_portrait_{}", index + 1);
        let name = str_field(character, "name");
        let brief = format!(
            "角色：{name}\n定位：{}\n背景：{}",
            str_field(character, "role"),
            str_field(character, "bio")
        );
        push_node(
            brief_id.clone(),
            node(
                "text",
                &brief_id,
                column(index),
                ROW_CHARACTER,
                json!({
                    "prompt": brief, "system": "", "mode": "generate", "providerId": "", "model": ""
                }),
                true,
            ),
        );

        let portrait_url = str_field(character, "portraitUrl");
        let asset_id = if portrait_url.is_empty() {
            None
        } else {
            asset_ids.get(portrait_url.as_str()).cloned()
        };
        if !portrait_url.is_empty() && asset_id.is_none() {
            let label = if name.is_empty() { "角色" } else { name.as_str() };
            warnings.push(format!("「{label}」的素材未能导入，节点保留为空"));
        }
        push_node(
            portrait_id.clone(),
            node(
                "image",
                &portrait_id,
                column(index),
                ROW_PORTRAIT,
                json!({
                    "prompt": format!("{name} 的标准三视图与定妆照，{brief}"),
                    "negative": "", "size": "1024x1536", "count": 1,
                    "selectedAssetId": asset_id.clone()
                }),
                asset_id.is_some(),
            ),
        );
        let brief_edge_id = format!("edge_{}", uuid::Uuid::new_v4());
        push_edge(
            brief_edge_id.clone(),
            edge(&brief_edge_id, &brief_id, "text", &portrait_id, "prompt", "prompt"),
        );
        if let Some(asset) = asset_id {
            runs.push(imported_run(project_id, board_id, &portrait_id, &asset, "导入自旧项目角色定妆照"));
        }
    }

    // 场景：文本节点（P0 先不落 Script 实体）
    let scenes = as_array(value, "scenes");
    for (index, scene) in scenes.iter().enumerate() {
        let scene_id = format!("node_scene_{}", index + 1);
        let body = format!(
            "{}\n{}\n台词：{}\n情绪：{}\n钩子：{}",
            str_field(scene, "heading"),
            str_field(scene, "action"),
            str_field(scene, "dialogue"),
            str_field(scene, "emotionalBeat"),
            str_field(scene, "hook")
        );
        push_node(
            scene_id.clone(),
            node(
                "text",
                &scene_id,
                column(index),
                ROW_SCENE,
                json!({
                    "prompt": body, "system": "", "mode": "generate", "providerId": "", "model": ""
                }),
                true,
            ),
        );
    }

    // 分镜参考：binding + storyboard，按镜头归组
    let candidates: HashMap<String, &Value> = {
        let mut map: HashMap<String, &Value> = HashMap::new();
        for candidate in as_array(value, "candidates") {
            let id = str_field(candidate, "id");
            if !id.is_empty() {
                map.insert(id, candidate);
            }
        }
        map
    };
    let mut shot_frames: HashMap<String, Vec<(String, String)>> = HashMap::new();
    let mut shot_references: HashMap<String, Vec<String>> = HashMap::new();
    let mut skipped_middle: usize = 0;

    for binding in as_array(value, "referenceBindings") {
        let shot_id = str_field(binding, "shotId");
        if shot_id.is_empty() {
            continue;
        }
        let asset_id = str_field(binding, "assetId");
        let url = match candidates.get(&asset_id) {
            Some(candidate) => str_field(candidate, "url"),
            None => str_field(binding, "sourceUrl"),
        };
        if url.is_empty() {
            continue;
        }
        match str_field(binding, "role").as_str() {
            "start" | "end" => shot_frames.entry(shot_id).or_default().push((str_field(binding, "role"), url)),
            "middle" => skipped_middle += 1,
            _ => shot_references.entry(shot_id).or_default().push(url),
        }
    }
    for storyboard in as_array(value, "storyboards") {
        // 与 collect_asset_sources 保持一致：未选中的分镜不会被下载，也就不该进画布，
        // 否则用户会看到一堆「素材未能导入」的假警告。
        if storyboard.get("selected").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        let shot_id = str_field(storyboard, "shotId");
        let url = str_field(storyboard, "url");
        if shot_id.is_empty() || url.is_empty() {
            continue;
        }
        if str_field(storyboard, "role") == "clean" {
            shot_frames.entry(shot_id).or_default().push(("start".to_string(), url));
        } else {
            shot_references.entry(shot_id).or_default().push(url);
        }
    }
    if skipped_middle > 0 {
        warnings.push(format!("{skipped_middle} 个中间帧未导入：P0 视频节点没有中间帧端口"));
    }

    // 选中视频候选按镜头 id 前缀尽力归组（旧数据没有 shotId，只能靠 label 兜底）
    let mut shot_videos: HashMap<String, Vec<String>> = HashMap::new();
    for candidate in as_array(value, "candidates") {
        if candidate.get("selected").and_then(Value::as_bool) != Some(true) {
            continue;
        }
        if kind_for_candidate(candidate) != "video" {
            continue;
        }
        let url = str_field(candidate, "url");
        let label = str_field(candidate, "label");
        for shot in as_array(value, "shots") {
            let shot_id = str_field(shot, "id");
            let number = shot.get("number").and_then(Value::as_i64).unwrap_or(0);
            if !shot_id.is_empty() && label_matches_shot(&label, &shot_id, number) {
                shot_videos.entry(shot_id).or_default().push(url.clone());
            }
        }
    }

    let shots = as_array(value, "shots");
    let scene_index: HashMap<String, usize> = scenes
        .iter()
        .enumerate()
        .map(|(index, scene)| (str_field(scene, "id"), index))
        .collect();
    let character_index: HashMap<String, usize> = characters
        .iter()
        .enumerate()
        .map(|(index, character)| (str_field(character, "id"), index))
        .collect();
    let character_names: HashMap<String, String> = characters
        .iter()
        .map(|character| (str_field(character, "id"), str_field(character, "name")))
        .collect();
    let portrait_by_index: HashMap<usize, String> = characters
        .iter()
        .enumerate()
        .map(|(at, character)| (at, str_field(character, "portraitUrl")))
        .collect();

    for (index, shot) in shots.iter().enumerate() {
        if shot.get("archived").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let shot_id = str_field(shot, "id");
        let number = shot.get("number").and_then(Value::as_i64).unwrap_or((index + 1) as i64);
        let node_id = format!("node_shot_{}", index + 1);
        let frames = shot_frames.remove(&shot_id).unwrap_or_default();
        let raw_references = shot_references.remove(&shot_id).unwrap_or_default();
        let character_ids: Vec<String> = shot
            .get("characters")
            .and_then(Value::as_array)
            .map(|ids| ids.iter().filter_map(|id| id.as_str().map(ToString::to_string)).collect())
            .unwrap_or_default();
        let character_portraits: Vec<String> = character_ids
            .iter()
            .filter_map(|id| character_index.get(id).map(|at| format!("node_portrait_{}", at + 1)))
            .collect();
        let character_reference_urls: Vec<String> = character_ids
            .iter()
            .filter_map(|id| character_index.get(id))
            .filter_map(|at| portrait_by_index.get(at))
            .filter(|url| !url.is_empty())
            .map(|url| url.to_string())
            .collect();

        let mut mode = "t2v";
        // (视频节点端口, 素材 id)：只放真正导入成功的素材，模式才由它决定。
        let mut media: Vec<(String, String)> = Vec::new();

        let duration_raw = shot.get("duration").and_then(Value::as_f64).unwrap_or(6.0);
        let duration = duration_raw.round().clamp(5.0, 15.0) as i64;
        if duration != duration_raw.round() as i64 {
            warnings.push(format!("镜头 {number} 时长 {duration_raw} 秒被夹到 H3 支持的 {duration} 秒"));
        }

        // 首尾帧：每个端口只留一个来源（视频节点的首帧/尾帧端口是单输入）
        let mut frame_slots: Vec<(&str, String)> = Vec::new();
        for (role, url) in frames.iter() {
            let port = if role == "end" { "end" } else { "start" };
            if !frame_slots.iter().any(|(existing, _)| *existing == port) {
                frame_slots.push((port, url.clone()));
            }
        }

        // 参考：旧参考素材 + 角色定妆照（同一个素材只算一次）
        let mut reference_urls: Vec<String> = Vec::new();
        for url in raw_references.iter().chain(character_reference_urls.iter()) {
            if !url.is_empty() && !reference_urls.contains(url) {
                reference_urls.push(url.clone());
            }
        }
        let references_over_limit = reference_urls.len() > MAX_H3_REFERENCES;
        let trimmed_reference_urls: Vec<String> =
            reference_urls.iter().take(MAX_H3_REFERENCES).cloned().collect();

        let frame_assets: Vec<(&str, String)> = frame_slots
            .iter()
            .filter_map(|(port, url)| asset_ids.get(url.trim()).map(|asset| (*port, asset.clone())))
            .collect();
        let reference_assets: Vec<String> = trimmed_reference_urls
            .iter()
            .filter_map(|url| asset_ids.get(url.trim()).cloned())
            .collect();

        if !frame_assets.is_empty() {
            mode = "firstLast";
            media = frame_assets
                .iter()
                .map(|(port, asset)| (port.to_string(), asset.clone()))
                .collect();
            let dropped = raw_references.len() + character_portraits.len();
            if dropped > 0 {
                warnings.push(format!(
                    "镜头 {number} 已用首尾帧模式，{dropped}/{dropped} 个参考素材未导入（H3 首尾帧与参考互斥）"
                ));
            }
        } else if !reference_assets.is_empty() {
            mode = "reference";
            media = reference_assets
                .iter()
                .map(|asset| ("references".to_string(), asset.clone()))
                .collect();
            if !frame_slots.is_empty() {
                warnings.push(format!("镜头 {number} 的首尾帧素材未能导入，已改用参考素材模式"));
            }
            if references_over_limit {
                warnings.push(format!(
                    "镜头 {number} 参考素材 {} 个，超过 H3 上限 {}，只导入前 {} 个",
                    reference_urls.len(),
                    MAX_H3_REFERENCES,
                    MAX_H3_REFERENCES
                ));
            }
            if raw_references.is_empty() && !character_portraits.is_empty() {
                warnings.push(format!("镜头 {number} 的旧项目参考素材未导入，已改用角色定妆照作为参考图"));
            }
            let missing_portraits = character_reference_urls
                .iter()
                .filter(|url| !asset_ids.contains_key(url.trim()))
                .count();
            if missing_portraits > 0 {
                warnings.push(format!("镜头 {number} 的角色参考素材未能导入"));
            }
        } else {
            // 一张素材都没导进来：退回文生视频，并把原因写清楚
            if !frame_slots.is_empty() {
                warnings.push(format!("镜头 {number} 的首尾帧素材未能导入，已改为文生视频模式"));
            }
            if !reference_urls.is_empty() {
                warnings.push(format!("镜头 {number} 的参考素材未能导入，已改为文生视频模式"));
            }
        }

        // 场景文本作为提示词来源
        let prompt_port = scene_index
            .get(&str_field(shot, "sceneId"))
            .map(|scene_at| format!("node_scene_{}", scene_at + 1));

        let prompt = format!(
            "镜头 {number}：{}{}，{}。角色：{}。声音：{}",
            str_field(shot, "framing"),
            {
                let motion = str_field(shot, "cameraMotion");
                if motion.is_empty() { String::new() } else { format!("，{motion}") }
            },
            str_field(shot, "action"),
            {
                // 用角色名而不是旧 id：这段提示词会直接交给模型，旧 id 对模型没有意义。
                let names: Vec<String> = character_ids
                    .iter()
                    .map(|id| match character_names.get(id) {
                        Some(name) if !name.is_empty() => name.clone(),
                        _ => id.clone(),
                    })
                    .collect();
                if names.is_empty() { "无".to_string() } else { names.join("、") }
            },
            {
                let cue = str_field(shot, "audioCue");
                if cue.is_empty() { "环境声".to_string() } else { cue }
            }
        );

        let videos = shot_videos.remove(&shot_id).unwrap_or_default();
        let selected_video = videos.iter().find_map(|url| asset_ids.get(url.trim()).cloned());

        // 同一资产可能同时出现在首帧与参考，端口去重后只建一个上游节点
        let mut unique: Vec<(String, String)> = Vec::new();
        for (port, asset_id) in media {
            if !unique.iter().any(|(_, existing)| *existing == asset_id) {
                unique.push((port, asset_id));
            }
        }

        for (slot, (port, asset_id)) in unique.iter().enumerate() {
            let media_node = format!("node_media_{}_{}", index + 1, slot + 1);
            push_node(
                media_node.clone(),
                node(
                    "image",
                    &media_node,
                    column(index),
                    ROW_MEDIA + slot as f64 * MEDIA_STEP,
                    json!({
                        "prompt": format!("镜头 {number} 的{port}素材（旧项目导入）", port = if port.as_str() == "end" { "尾帧" } else { "首帧/参考" }),
                        "negative": "", "size": "1024x1536", "count": 1,
                        "selectedAssetId": asset_id.clone()
                    }),
                    true,
                ),
            );
            let media_edge_id = format!("edge_{}", uuid::Uuid::new_v4());
            push_edge(
                media_edge_id.clone(),
                edge(
                    &media_edge_id,
                    &media_node,
                    "image",
                    &node_id,
                    port,
                    if port.as_str() == "end" { "last_frame" } else if port.as_str() == "start" { "first_frame" } else { "reference_image" },
                ),
            );
            runs.push(imported_run(project_id, board_id, &media_node, asset_id, "导入自旧项目分镜素材"));
        }

        push_node(
            node_id.clone(),
            node(
                "video",
                &node_id,
                column(index),
                ROW_SHOT,
                json!({
                    "prompt": prompt, "negative": "", "mode": mode, "duration": duration,
                    "resolution": "768P", "aspectRatio": if str_field(shot, "aspectRatio") == "16:9" { "16:9" } else { "9:16" },
                    "generateAudio": true, "selectedAssetId": selected_video.clone()
                }),
                selected_video.is_some(),
            ),
        );

        if let Some(source) = prompt_port {
            let prompt_edge_id = format!("edge_{}", uuid::Uuid::new_v4());
            push_edge(
                prompt_edge_id.clone(),
                edge(&prompt_edge_id, &source, "text", &node_id, "prompt", "prompt"),
            );
        }
        if let Some(asset) = selected_video {
            runs.push(imported_run(project_id, board_id, &node_id, &asset, "导入自旧项目成片候选"));
        }
    }

    if !shot_frames.is_empty() || !shot_references.is_empty() || !shot_videos.is_empty() {
        warnings.push("部分旧镜头没有对应节点，其素材已导入但未连线".to_string());
    }
    let node_count = nodes.len();
    if node_count > NODE_BUDGET_WARNING {
        warnings.push(format!("导入生成 {node_count} 个节点，画布会明显变重，建议按集拆分项目"));
    }

    let board_name = format!(
        "{} · 导入",
        {
            let name = str_field(value, "name");
            if name.is_empty() { "旧项目".to_string() } else { name }
        }
    );
    let now = chrono::Utc::now().to_rfc3339();
    let board = json!({
        "schemaVersion": 1,
        "id": board_id,
        "projectId": project_id,
        "name": board_name,
        "nodes": Value::Object(nodes),
        "edges": Value::Object(edges),
        "viewport": { "x": 0, "y": 0, "zoom": 0.55 },
        "createdAt": now,
        "updatedAt": now
    });
    (board, runs, warnings)
}

/// 读取旧项目文件：只认 `.json`、限制体积、必须是对象且带旧版已知段落。
/// 路径必须落在允许的目录内（见 [`resolve_local_bytes`]）。
pub fn read_legacy_document(path: &Path, allowed_roots: &[PathBuf]) -> Result<Value, AppError> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if extension != "json" {
        return Err(AppError::new("IMPORT_TYPE_INVALID", "旧项目文件必须是 .json", false));
    }
    let bytes = resolve_local_bytes(path, allowed_roots)?;
    if bytes.len() as u64 > MAX_LEGACY_JSON_BYTES {
        return Err(AppError::new(
            "IMPORT_TOO_LARGE",
            "旧项目文件超过 8MB 上限，请拆分后再导入",
            false,
        ));
    }
    let mut value: Value = serde_json::from_slice(&bytes)
        .map_err(|error| AppError::new("IMPORT_JSON_INVALID", format!("旧项目文件不是合法 JSON：{error}"), false))?;
    if !value.is_object() {
        return Err(AppError::new("IMPORT_TYPE_INVALID", "旧项目文件的顶层必须是对象", false));
    }
    let known_sections = [
        "characters",
        "scenes",
        "shots",
        "storyboards",
        "referenceBindings",
        "candidates",
        "styleGuide",
    ];
    if !known_sections.iter().any(|key| value.get(*key).is_some()) {
        return Err(AppError::new(
            "IMPORT_SCHEMA_UNKNOWN",
            "这个 JSON 不像旧版 Frameforge 项目导出文件",
            false,
        ));
    }
    // 旧项目里可能混着 API Key 之类的字段：进内存之前先剥掉，
    // 免得它们随项目包、画布文档一起落库。
    crate::strip_sensitive_fields(&mut value);
    Ok(value)
}

/// 读取白名单目录内的本地文件：目录之外的路径一律拒绝（防 `..` 穿越与绝对路径逃逸）。
pub fn resolve_local_bytes(path: &Path, allowed_roots: &[PathBuf]) -> Result<Vec<u8>, AppError> {
    let meta = std::fs::symlink_metadata(path).map_err(|error| {
        AppError::new("IMPORT_FILE_MISSING", format!("无法读取旧项目文件：{error}"), false)
    })?;
    if meta.is_symlink() || !meta.is_file() {
        return Err(AppError::new("IMPORT_TYPE_INVALID", "素材必须是普通文件", false));
    }
    if meta.len() > MAX_ASSET_BYTES {
        return Err(AppError::new(
            "IMPORT_TOO_LARGE",
            "单个素材超过 256 MB",
            false,
        ));
    }
    let canonical = path.canonicalize().map_err(|error| {
        AppError::new("IMPORT_FILE_MISSING", format!("无法读取旧项目文件：{error}"), false)
    })?;
    let allowed = allowed_roots
        .iter()
        .filter_map(|root| root.canonicalize().ok())
        .any(|root| canonical.starts_with(&root));
    if !allowed {
        return Err(AppError::new(
            "IMPORT_PATH_ESCAPE",
            "旧项目文件必须位于允许的目录内",
            false,
        ));
    }
    std::fs::read(&canonical).map_err(|error| {
        AppError::new("IMPORT_FILE_MISSING", format!("无法读取旧项目文件：{error}"), false)
    })
}

/// 落盘失败统一走一个错误码，方便前端区分「导入整体失败」与「单个素材失败」。
fn storage_error(message: impl Into<String>) -> AppError {
    AppError::new("STORAGE_IO", message, false)
}

/// 素材类型：优先看 MIME，MIME 不认识时退回 URL 后缀。
fn guess_kind(mime: &str, url: &str) -> &'static str {
    if mime.starts_with("video/") {
        "video"
    } else if mime.starts_with("audio/") {
        "audio"
    } else if mime.starts_with("image/") {
        "image"
    } else if mime.starts_with("text/") || mime.ends_with("/json") {
        "text"
    } else {
        match kind_for_url(url) {
            "video" => "video",
            "audio" => "audio",
            _ => "image",
        }
    }
}

/// 下载远端素材：只允许公网 https，重定向后再校验一次目标地址（防 SSRF）。
async fn fetch_remote(client: &reqwest::Client, raw: &str) -> Result<(Vec<u8>, String), AppError> {
    let url = security::validate_remote_url(raw)?;
    let response = client
        .get(url.clone())
        .send()
        .await
        .map_err(|error| AppError::new("PROVIDER_NETWORK", error.to_string(), true))?;
    let status = response.status();
    if !status.is_success() {
        return Err(AppError::new(
            "PROVIDER_HTTP_STATUS",
            format!("素材下载失败：{status}"),
            status.is_server_error(),
        ));
    }
    // 重定向后必须再校验一次，避免 https 公网地址把请求带到私网。
    security::validate_remote_url(response.url().as_str())?;
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .split(';')
        .next()
        .unwrap_or("application/octet-stream")
        .to_string();
    // 服务器声明了体积就先拒绝，别把超大响应整个读进内存。
    if response.content_length().unwrap_or(0) > MAX_ASSET_BYTES {
        return Err(AppError::new("IMPORT_TOO_LARGE", "远端素材超过 256 MB", false));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| AppError::new("PROVIDER_NETWORK", error.to_string(), true))?;
    if bytes.len() as u64 > MAX_ASSET_BYTES {
        return Err(AppError::new("IMPORT_TOO_LARGE", "远端素材超过 256 MB", false));
    }
    Ok((bytes.to_vec(), mime))
}

/// 把旧项目里的本地路径写法识别出来：`file://` 与绝对路径。
/// 相对路径不认：它取决于进程工作目录，含义不确定。
fn local_source(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if let Some(stripped) = trimmed.strip_prefix("file://") {
        return Some(PathBuf::from(percent_decode(stripped)));
    }
    if trimmed.starts_with('/') || (trimmed.len() > 2 && trimmed.as_bytes()[1] == b':') {
        return Some(PathBuf::from(trimmed));
    }
    None
}

/// 极简 percent 解码：只处理 `%XX`。
/// 旧项目里的本地路径来自应用自身写入的 `app_data`，不含查询串，够用。
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(value) = u8::from_str_radix(&input[index + 1..index + 3], 16) {
                out.push(value);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

/// 本地素材的 MIME 猜测：只按扩展名，认不出来就用 octet-stream。
fn mime_guess(path: &Path) -> String {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "mp4" | "mov" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "txt" => "text/plain",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// 导入主体：素材复制进 CAS，项目 / 画布 / 运行记录落库。
///
/// 单个素材失败不会中断整个导入：失败原因写进 `warnings`，画布对应的节点保持为空。
pub async fn import_document(
    state: &AppState,
    document: &Value,
    roots: &[PathBuf],
) -> Result<LegacyImportResult, AppError> {
    let project_id = format!("project_{}", uuid::Uuid::new_v4());
    let board_id = format!("board_{}", uuid::Uuid::new_v4());
    let data_dir = state.data_dir.clone();
    let client =
        crate::http_client().map_err(|message| AppError::new("UNAVAILABLE_HTTP", message, false))?;

    let mut asset_ids: HashMap<String, String> = HashMap::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut asset_count = 0usize;

    for source in collect_asset_sources(document) {
        let raw = source.url.as_str();
        let stored: Result<(Vec<u8>, String), AppError> = if let Some((mime, bytes)) =
            assets::decode_data_url(raw)
        {
            Ok((bytes, mime))
        } else if raw.starts_with("https://") {
            fetch_remote(&client, raw).await
        } else if let Some(path) = local_source(raw) {
            let mime = mime_guess(&path);
            resolve_local_bytes(&path, roots).map(|bytes| (bytes, mime))
        } else {
            Err(AppError::new(
                "IMPORT_TYPE_INVALID",
                format!("不支持的素材地址：{raw}"),
                false,
            ))
        };
        match stored {
            Ok((bytes, mime)) => {
                let provenance = json!({
                    "projectId": project_id,
                    "legacy": { "source": raw }
                });
                let kind = guess_kind(&mime, raw);
                let mut asset = assets::store_bytes(&data_dir, &bytes, kind, &mime, provenance)
                    .map_err(|message| AppError::new("STORAGE_ASSET_FAILED", message, false))?;
                asset.provenance["legacy"]["sourceKind"] = json!(source.kind);
                runs::save_asset(state, &asset)?;
                asset_ids.insert(raw.to_string(), asset.id.clone());
                asset_count += 1;
            }
            Err(error) => warnings.push(format!("素材 {} 未能导入：{}", raw, error.message)),
        }
    }

    let project = build_legacy_project(document, &project_id);
    let (board, imported_runs, mut board_warnings) =
        build_legacy_board(document, &project_id, &board_id, &asset_ids);
    warnings.append(&mut board_warnings);

    let path =
        runs::db_path(state).map_err(|message| AppError::new("STORAGE_DB_FAILED", message, false))?;
    let connection =
        db::open(&path).map_err(|message| AppError::new("STORAGE_DB_FAILED", message, false))?;
    let now = chrono::Utc::now().to_rfc3339();
    connection
        .execute(
            "INSERT INTO studio_projects (id, name, payload, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, payload=excluded.payload, updated_at=excluded.updated_at",
            rusqlite::params![
                project_id,
                project.get("name").and_then(Value::as_str).unwrap_or("导入的旧项目"),
                serde_json::to_string(&project).map_err(|error| storage_error(error.to_string()))?,
                now
            ],
        )
        .map_err(|error| storage_error(error.to_string()))?;
    connection
        .execute(
            "INSERT INTO boards (id, project_id, name, payload, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, payload=excluded.payload, updated_at=excluded.updated_at",
            rusqlite::params![
                board_id,
                project_id,
                board.get("name").and_then(Value::as_str).unwrap_or("导入画布"),
                serde_json::to_string(&board).map_err(|error| storage_error(error.to_string()))?,
                now
            ],
        )
        .map_err(|error| storage_error(error.to_string()))?;
    for run in &imported_runs {
        runs::save_run(state, run).map_err(|message| storage_error(message))?;
    }

    Ok(LegacyImportResult {
        project,
        board,
        asset_count,
        run_count: imported_runs.len(),
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn legacy() -> Value {
        json!({
            "id": "legacy_1", "name": "旧短剧", "logline": "雨夜告别", "aspectRatio": "9:16",
            "styleGuide": {
                "genre": "悬疑", "visualStyle": "冷色写实", "colorLanguage": "青灰",
                "cameraLanguage": "手持", "era": "当代", "constraints": "不见血", "negativeConstraints": "卡通感"
            },
            "characters": [
                { "id": "c1", "name": "林淮", "role": "男主", "bio": "沉默寡言的法医", "portraitUrl": "https://cdn.example/portrait.png",
                  "status": "approved", "referenceIds": [], "variants": [] }
            ],
            "scenes": [
                { "id": "s1", "heading": "内景 法医室 - 夜", "action": "林淮盯着屏幕", "dialogue": "他已经死了很久。",
                  "emotionalBeat": "压抑", "hook": "尸体开口", "status": "approved" }
            ],
            "shots": [
                { "id": "sh1", "sceneId": "s1", "number": 1, "duration": 24, "framing": "特写", "cameraMotion": "推进",
                  "action": "瞳孔收缩", "characters": ["c1"], "audioCue": "雨声", "aspectRatio": "9:16", "status": "approved" },
                { "id": "sh2", "sceneId": "s1", "number": 2, "duration": 6, "framing": "中景",
                  "action": "转身离开", "characters": [], "audioCue": "", "aspectRatio": "9:16", "status": "draft" }
            ],
            "storyboards": [
                { "id": "sb1", "shotId": "sh1", "role": "storyboard", "url": "/Users/xiic/frameforge/sb1.png",
                  "version": 1, "selected": true, "createdAt": "2026-10-01T00:00:00Z" }
            ],
            "referenceBindings": [
                { "id": "rb1", "shotId": "sh1", "slot": 0, "role": "start", "sourceUrl": "https://cdn.example/start.png",
                  "label": "首帧", "locked": true }
            ],
            "candidates": [
                { "id": "ca1", "jobId": "j1", "kind": "video", "label": "镜头 1 成片", "url": "https://cdn.example/shot1.mp4",
                  "promptId": "p1", "provider": "h3", "model": "MiniMax-H3", "createdAt": "2026-10-01T00:00:00Z",
                  "selected": true, "metadata": {} }
            ]
        })
    }

    fn asset_map() -> HashMap<String, String> {
        [
            ("https://cdn.example/portrait.png".to_string(), "asset_portrait".to_string()),
            ("https://cdn.example/start.png".to_string(), "asset_start".to_string()),
            ("/Users/xiic/frameforge/sb1.png".to_string(), "asset_sb1".to_string()),
            ("https://cdn.example/shot1.mp4".to_string(), "asset_video1".to_string()),
        ]
        .into_iter()
        .collect()
    }

    #[test]
    fn collects_portrait_frame_storyboard_and_candidate_sources() {
        let sources = collect_asset_sources(&legacy());
        let urls: Vec<&str> = sources.iter().map(|item| item.url.as_str()).collect();
        assert!(urls.contains(&"https://cdn.example/portrait.png"));
        assert!(urls.contains(&"https://cdn.example/start.png"));
        assert!(urls.contains(&"/Users/xiic/frameforge/sb1.png"));
        assert!(urls.contains(&"https://cdn.example/shot1.mp4"));
        assert_eq!(sources.len(), sources.iter().map(|item| item.url.clone()).collect::<HashSet<_>>().len());
    }

    #[test]
    fn frames_win_and_references_are_dropped_with_a_warning() {
        let (board, runs, warnings) = build_legacy_board(&legacy(), "project_1", "board_1", &asset_map());
        let shot = &board["nodes"]["node_shot_1"];
        assert_eq!(shot["data"]["mode"], "firstLast");
        assert!(warnings.iter().any(|item| item.contains("首尾帧")));
        let references = board["edges"]
            .as_object()
            .unwrap()
            .values()
            .filter(|edge| edge["target"] == "node_shot_1" && edge["targetPort"] == "references")
            .count();
        assert_eq!(references, 0);
        let start = board["edges"]
            .as_object()
            .unwrap()
            .values()
            .any(|edge| edge["target"] == "node_shot_1" && edge["targetPort"] == "start");
        assert!(start);
        assert!(runs.iter().any(|run| run.node_id == "node_shot_1" && run.selected_asset_id.as_deref() == Some("asset_video1")));
    }

    #[test]
    fn text_to_video_when_no_media() {
        let (board, _, _) = build_legacy_board(&legacy(), "project_1", "board_1", &asset_map());
        assert_eq!(board["nodes"]["node_shot_2"]["data"]["mode"], "t2v");
    }

    #[test]
    fn duration_is_clamped_into_the_model_range() {
        let (board, _, warnings) = build_legacy_board(&legacy(), "project_1", "board_1", &asset_map());
        assert_eq!(board["nodes"]["node_shot_1"]["data"]["duration"], json!(15));
        assert!(warnings.iter().any(|item| item.contains("时长")));
    }

    #[test]
    fn imported_nodes_are_pinned_and_style_guide_moves_the_negative_constraints() {
        let (board, _, _) = build_legacy_board(&legacy(), "project_1", "board_1", &asset_map());
        assert_eq!(board["nodes"]["node_portrait_1"]["ui"]["pinned"], json!(true));
        assert_eq!(board["nodes"]["node_shot_1"]["ui"]["pinned"], json!(true));
        let project = build_legacy_project(&legacy(), "project_1");
        assert_eq!(project["styleGuide"]["negative"], json!("卡通感"));
        assert_eq!(project["styleGuide"]["version"], json!(1));
        assert_eq!(project["aspectRatio"], json!("9:16"));
    }

    #[test]
    fn reference_mode_is_used_when_only_references_exist() {
        let mut doc = legacy();
        doc["referenceBindings"] = json!([]);
        doc["storyboards"] = json!([]);
        let (board, _, warnings) = build_legacy_board(&doc, "project_1", "board_1", &asset_map());
        assert_eq!(board["nodes"]["node_shot_1"]["data"]["mode"], "reference");
        assert!(warnings.iter().any(|item| item.contains("未导入")));
    }

    #[test]
    fn reference_list_is_trimmed_to_the_model_limit() {
        let mut doc = legacy();
        doc["referenceBindings"] = json!([]);
        doc["storyboards"] = json!([]);
        doc["characters"] = Value::Array((0..12).map(|index| json!({
            "id": format!("c{index}"), "name": format!("角色 {index}"), "role": "", "bio": "",
            "portraitUrl": format!("https://cdn.example/p{index}.png"), "status": "draft", "referenceIds": [], "variants": []
        })).collect());
        doc["shots"][0]["characters"] = json!((0..12).map(|index| format!("c{index}")).collect::<Vec<_>>());
        let mut map = HashMap::new();
        for index in 0..12 {
            map.insert(format!("https://cdn.example/p{index}.png"), format!("asset_{index}"));
        }
        let (board, _, warnings) = build_legacy_board(&doc, "project_1", "board_1", &map);
        let references = board["edges"].as_object().unwrap().values()
            .filter(|edge| edge["target"] == "node_shot_1" && edge["targetPort"] == "references")
            .count();
        assert_eq!(references, MAX_H3_REFERENCES);
        assert!(warnings.iter().any(|item| item.contains("参考")));
    }

    #[test]
    fn missing_asset_ids_degrade_to_unpinned_nodes_instead_of_panicking() {
        let (board, runs, warnings) = build_legacy_board(&legacy(), "project_1", "board_1", &HashMap::new());
        assert!(runs.is_empty());
        assert!(board["nodes"]["node_shot_1"]["ui"].is_null() || board["nodes"]["node_shot_1"]["ui"]["pinned"].is_null());
        assert!(warnings.iter().any(|item| item.contains("素材")));
    }

    #[test]
    fn a_video_candidate_is_not_attached_to_another_shot_by_number_prefix() {
        let mut doc = legacy();
        // 「镜头 12 成片」不能因为前缀相同就挂到 1 号镜头上
        doc["candidates"] = json!([
            { "id": "ca12", "kind": "video", "label": "镜头 12 成片", "url": "https://cdn.example/shot12.mp4",
              "selected": true, "metadata": {} }
        ]);
        let mut map = HashMap::new();
        map.insert("https://cdn.example/shot12.mp4".to_string(), "asset_video12".to_string());
        let (board, _, _) = build_legacy_board(&doc, "project_1", "board_1", &map);
        assert!(board["nodes"]["node_shot_1"]["data"]["selectedAssetId"].is_null());
        assert!(board["nodes"]["node_shot_2"]["data"]["selectedAssetId"].is_null());
    }

    #[test]
    fn shot_prompt_uses_character_names_instead_of_legacy_ids() {
        let (board, _, _) = build_legacy_board(&legacy(), "project_1", "board_1", &asset_map());
        let prompt = board["nodes"]["node_shot_1"]["data"]["prompt"].as_str().unwrap_or("");
        assert!(prompt.contains("林淮"), "提示词应包含角色名：{prompt}");
        assert!(!prompt.contains("角色：c1"), "提示词不应残留旧角色 id：{prompt}");
    }

    #[test]
    fn deselected_storyboards_are_not_imported_as_references() {
        let mut doc = legacy();
        doc["referenceBindings"] = json!([]);
        doc["storyboards"] = json!([
            { "id": "sb1", "shotId": "sh1", "role": "storyboard", "url": "/Users/xiic/frameforge/sb1.png",
              "version": 2, "selected": false }
        ]);
        // 采集端本来就不下载未选中的分镜，映射端必须一致，否则会出现「素材未能导入」的假警告
        assert!(!collect_asset_sources(&doc)
            .iter()
            .any(|item| item.url == "/Users/xiic/frameforge/sb1.png"));
        let (board, _, _) = build_legacy_board(&doc, "project_1", "board_1", &asset_map());
        let references = board["edges"]
            .as_object()
            .unwrap()
            .values()
            .filter(|edge| edge["target"] == "node_shot_1" && edge["targetPort"] == "references")
            .count();
        assert_eq!(references, 1);
    }

    #[test]
    fn local_paths_outside_the_allowed_roots_are_rejected() {
        let root = std::env::temp_dir().join(format!("ff_import_root_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("root");
        let outside = Path::new("/etc/hosts");
        let error = resolve_local_bytes(outside, &[root.clone()]).expect_err("rejected");
        assert_eq!(error.code, "IMPORT_PATH_ESCAPE");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn legacy_document_must_be_a_json_object_with_known_sections() {
        let dir = std::env::temp_dir().join(format!("ff_import_doc_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let wrong_extension = dir.join("project.txt");
        std::fs::write(&wrong_extension, "{}").expect("write");
        assert_eq!(read_legacy_document(&wrong_extension, &[dir.clone()]).expect_err("ext").code, "IMPORT_TYPE_INVALID");

        let not_legacy = dir.join("other.json");
        std::fs::write(&not_legacy, "{\"hello\":1}").expect("write");
        assert_eq!(read_legacy_document(&not_legacy, &[dir.clone()]).expect_err("schema").code, "IMPORT_SCHEMA_UNKNOWN");

        let ok = dir.join("project.json");
        std::fs::write(&ok, legacy().to_string()).expect("write");
        assert!(read_legacy_document(&ok, &[dir.clone()]).is_ok());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn sensitive_fields_are_stripped_before_the_document_is_used() {
        let dir = std::env::temp_dir().join(format!("ff_import_secret_{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("dir");
        let path = dir.join("project.json");
        let mut document = legacy();
        document["apiKey"] = json!("plain-key");
        document["styleGuide"]["apiKey"] = json!("nested-key");
        std::fs::write(&path, document.to_string()).expect("write");
        let read = read_legacy_document(&path, &[dir.clone()]).expect("read");
        assert!(read.get("apiKey").is_none(), "顶层密钥必须被剥掉");
        assert!(read["styleGuide"].get("apiKey").is_none(), "嵌套密钥必须被剥掉");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn local_sources_are_recognized_but_relative_paths_are_not() {
        assert_eq!(
            local_source("/Users/xiic/frameforge/sb1.png"),
            Some(PathBuf::from("/Users/xiic/frameforge/sb1.png"))
        );
        assert_eq!(
            local_source("file:///Users/xiic/frameforge/sb%201.png"),
            Some(PathBuf::from("/Users/xiic/frameforge/sb 1.png"))
        );
        assert_eq!(local_source("sb1.png"), None, "相对路径必须被拒绝");
        assert_eq!(local_source("https://cdn.example/a.png"), None);
        assert_eq!(local_source("http://cdn.example/a.png"), None);
    }

    #[test]
    fn mime_and_kind_guessing_falls_back_to_the_url_suffix() {
        assert_eq!(mime_guess(Path::new("/tmp/a.png")), "image/png");
        assert_eq!(mime_guess(Path::new("/tmp/a.MP4")), "video/mp4");
        assert_eq!(mime_guess(Path::new("/tmp/a.unknown")), "application/octet-stream");
        assert_eq!(guess_kind("image/png", ""), "image");
        assert_eq!(guess_kind("video/mp4", ""), "video");
        assert_eq!(guess_kind("audio/mpeg", ""), "audio");
        assert_eq!(guess_kind("text/plain", ""), "text");
        // MIME 认不出来时看 URL 后缀
        assert_eq!(guess_kind("application/octet-stream", "https://cdn.example/a.mp4"), "video");
        assert_eq!(guess_kind("application/octet-stream", "https://cdn.example/a.png"), "image");
    }

    #[tokio::test]
    async fn remote_assets_must_be_public_https() {
        let client = crate::http_client().expect("client");
        for (target, code) in [
            ("https://127.0.0.1/a.png", "PARAM_URL_PRIVATE"),
            ("https://localhost/a.png", "PARAM_URL_PRIVATE"),
            ("https://192.168.1.2/a.png", "PARAM_URL_PRIVATE"),
            ("http://cdn.example/a.png", "PARAM_URL_INSECURE"),
            ("file:///etc/passwd", "PARAM_URL_INSECURE"),
            ("not-a-url", "PARAM_URL_INVALID"),
        ] {
            let error = fetch_remote(&client, target).await.expect_err("必须拒绝");
            assert_eq!(error.code, code, "{target} 的错误码不对");
        }
    }

    /// 导入一条只带本地素材的旧项目：素材复制进 CAS，项目 / 画布 / 运行记录落库。
    #[tokio::test]
    async fn import_document_copies_assets_into_cas_and_writes_the_board() {
        let root = tempfile::tempdir().expect("root");
        let data = tempfile::tempdir().expect("data");
        let state = crate::AppState {
            db_path: std::sync::Mutex::new(data.path().join("frameforge.sqlite3")),
            data_dir: data.path().to_path_buf(),
        };

        let storyboard = root.path().join("sb1.png");
        std::fs::write(&storyboard, b"fake-png-bytes").expect("write");
        let mut document = legacy();
        document["referenceBindings"] = json!([]);
        document["candidates"] = json!([]);
        document["shots"] = json!([document["shots"][0].clone()]);
        document["shots"][0]["duration"] = json!(6);
        document["characters"][0]["portraitUrl"] = json!("data:image/png;base64,aGVsbG8=");
        document["storyboards"] = json!([{
            "id": "sb1", "shotId": "sh1", "role": "storyboard",
            "url": storyboard.to_string_lossy().to_string(), "selected": true
        }]);

        let roots = vec![root.path().to_path_buf()];
        let result = import_document(&state, &document, &roots).await.expect("import");
        assert_eq!(result.asset_count, 2, "两个素材都该进 CAS：{:?}", result.warnings);
        assert!(result.warnings.is_empty(), "不该有警告：{:?}", result.warnings);
        assert!(result.run_count >= 2, "导入的素材要各留一条运行记录");
        assert_eq!(result.project["schemaVersion"], json!(1));
        assert_eq!(result.board["schemaVersion"], json!(1));

        // 素材落进 CAS，而且不再引用原路径
        let connection = db::open(&state.db_path.lock().expect("lock").clone()).expect("db");
        let mut statement = connection
            .prepare("SELECT payload FROM assets")
            .expect("prepare");
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query")
            .collect::<Result<Vec<String>, _>>()
            .expect("rows");
        assert_eq!(rows.len(), 2);
        for payload in rows {
            let asset: assets::AssetRef = serde_json::from_str(&payload).expect("asset");
            assert!(asset.path.starts_with("assets/"), "素材必须复制进 CAS");
            assert!(data.path().join(&asset.path).exists(), "CAS 里要有文件");
            assert!(asset.provenance["legacy"]["source"].is_string());
            assert!(asset.provenance["legacy"]["sourceKind"].is_string());
        }
        // 项目、画布、运行记录都落库
        let projects: i64 = connection
            .query_row("SELECT COUNT(*) FROM studio_projects", [], |row| row.get(0))
            .expect("projects");
        let boards: i64 = connection
            .query_row("SELECT COUNT(*) FROM boards", [], |row| row.get(0))
            .expect("boards");
        let runs: i64 = connection
            .query_row("SELECT COUNT(*) FROM runs", [], |row| row.get(0))
            .expect("runs");
        assert_eq!(projects, 1);
        assert_eq!(boards, 1);
        assert_eq!(runs as usize, result.run_count);
    }

    /// 素材读不到（越界路径）时不该中断整个导入，只写一条警告。
    #[tokio::test]
    async fn import_document_reports_unreadable_assets_as_warnings() {
        let root = tempfile::tempdir().expect("root");
        let data = tempfile::tempdir().expect("data");
        let state = crate::AppState {
            db_path: std::sync::Mutex::new(data.path().join("frameforge.sqlite3")),
            data_dir: data.path().to_path_buf(),
        };
        let mut document = legacy();
        document["referenceBindings"] = json!([]);
        document["candidates"] = json!([]);
        document["characters"] = json!([{
            "id": "c1", "name": "林淮", "role": "男主", "bio": "",
            "portraitUrl": "/etc/hosts"
        }]);

        let result = import_document(&state, &document, &[root.path().to_path_buf()])
            .await
            .expect("import");
        assert_eq!(result.asset_count, 0);
        assert!(result.warnings.iter().any(|item| item.contains("未能导入")), "{:?}", result.warnings);
        // 画布照样建出来，节点保持为空
        assert!(result.board["nodes"]["node_portrait_1"]["data"]["selectedAssetId"].is_null());
    }
}
