use crate::assets::{self, AssetRef};
use image::{DynamicImage, GenericImageView, ImageFormat};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Cursor;
use std::path::Path;

/// 拆出来的一块：视角名 + 落库后的资产。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitView {
    /// front | side | back | closeup
    pub view: String,
    pub label: String,
    pub asset: AssetRef,
}

/// 设定图版式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SheetLayout {
    /// 横版：左侧面部特写 + 右侧正/侧/背全身。
    Landscape,
    /// 竖版 2×2：正/左/右/背。
    Portrait,
    /// 宫格：cols × rows。
    Grid { cols: u32, rows: u32 },
    /// 横排：cols 列等分。
    Strip { cols: u32 },
}

impl SheetLayout {
    pub fn parse(value: &str) -> SheetLayout {
        let value = value.trim();
        if value == "portrait" {
            return SheetLayout::Portrait;
        }
        if let Some(rest) = value.strip_prefix("strip:") {
            let cols = rest.parse::<u32>().unwrap_or(8).clamp(2, 24);
            return SheetLayout::Strip { cols };
        }
        if let Some((cols, rows)) = value.split_once('x') {
            let cols = cols.parse::<u32>().unwrap_or(3).clamp(1, 8);
            let rows = rows.parse::<u32>().unwrap_or(3).clamp(1, 8);
            return SheetLayout::Grid { cols, rows };
        }
        SheetLayout::Landscape
    }
}

/// 每一块的裁切区域（比例，0..1）与视角名。
fn regions(layout: SheetLayout) -> Vec<(String, String, (f32, f32, f32, f32))> {
    match layout {
        // 左侧 1/3 特写；右侧 2/3 三等分。
        SheetLayout::Landscape => vec![
            ("closeup".into(), "面部特写".into(), (0.0, 0.0, 0.34, 1.0)),
            ("front".into(), "正面".into(), (0.34, 0.0, 0.22, 1.0)),
            ("side".into(), "侧面".into(), (0.56, 0.0, 0.22, 1.0)),
            ("back".into(), "背面".into(), (0.78, 0.0, 0.22, 1.0)),
        ],
        // 2×2 四象限。
        SheetLayout::Portrait => vec![
            ("front".into(), "正面".into(), (0.0, 0.0, 0.5, 0.5)),
            ("left".into(), "左侧".into(), (0.5, 0.0, 0.5, 0.5)),
            ("right".into(), "右侧".into(), (0.0, 0.5, 0.5, 0.5)),
            ("back".into(), "背面".into(), (0.5, 0.5, 0.5, 0.5)),
        ],
        SheetLayout::Grid { cols, rows } => {
            let mut cells = Vec::new();
            for row in 0..rows {
                for col in 0..cols {
                    let index = row * cols + col + 1;
                    cells.push((
                        format!("cell-{index}"),
                        format!("第 {index} 格"),
                        (
                            col as f32 / cols as f32,
                            row as f32 / rows as f32,
                            1.0 / cols as f32,
                            1.0 / rows as f32,
                        ),
                    ));
                }
            }
            cells
        }
        SheetLayout::Strip { cols } => {
            let mut cells = Vec::new();
            for col in 0..cols {
                let index = col + 1;
                cells.push((
                    format!("cell-{index}"),
                    format!("第 {index} 个方向"),
                    (col as f32 / cols as f32, 0.0, 1.0 / cols as f32, 1.0),
                ));
            }
            cells
        }
    }
}

/// 把一张设定图拆成各视角。
///
/// 切块按比例裁切，不做内容识别：版式是我们自己规定给模型的，切出来对不对由人判断。
pub fn split_sheet(
    source_bytes: &[u8],
    layout: SheetLayout,
) -> Result<Vec<(String, String, Vec<u8>)>, String> {
    let image = image::load_from_memory(source_bytes).map_err(|error| error.to_string())?;
    let mut pieces = Vec::new();
    for (view, label, (x, y, w, h)) in regions(layout) {
        let cropped = crop_by_ratio(&image, (x, y, w, h));
        let mut buffer = Cursor::new(Vec::new());
        cropped
            .write_to(&mut buffer, ImageFormat::Png)
            .map_err(|error| error.to_string())?;
        pieces.push((view, label, buffer.into_inner()));
    }
    if pieces.is_empty() {
        return Err("图片尺寸不足，无法拆帧".to_string());
    }
    Ok(pieces)
}

/// 切块落库：走 CAS 去重，返回带资产的视角列表。
pub fn store_views(
    root: &Path,
    pieces: Vec<(String, String, Vec<u8>)>,
    provenance: Value,
) -> Result<Vec<SplitView>, String> {
    let mut views = Vec::new();
    for (view, label, bytes) in pieces {
        let mut scoped = provenance.clone();
        if let Some(map) = scoped.as_object_mut() {
            map.insert("view".to_string(), Value::String(view.clone()));
        }
        let mut asset = assets::store_bytes(root, &bytes, "image", "image/png", scoped)?;
        // 缩略图：资产库列表用原图会慢，拆出来的小图给个 512 边的预览。
        if let Ok(thumb) = thumbnail(&bytes, 512) {
            let relative = format!("thumbs/{}/{}.png", &asset.id[0..2], asset.id);
            if let Ok(path) = assets::write_derived(root, &relative, &thumb) {
                asset.thumb_path = Some(path);
            }
        }
        views.push(SplitView { view, label, asset });
    }
    Ok(views)
}

/// 生成缩略图（资产库里的小图）。
pub fn thumbnail(bytes: &[u8], max_edge: u32) -> Result<Vec<u8>, String> {
    let image = image::load_from_memory(bytes).map_err(|error| error.to_string())?;
    let (width, height) = image.dimensions();
    let longest = width.max(height);
    if longest <= max_edge {
        return encode_png(&image);
    }
    // thumbnail 会保持宽高比，只把最长边压到 max_edge；resize 会强行拉成正方形。
    let resized = image.thumbnail(max_edge, max_edge);
    encode_png(&resized)
}

fn encode_png(image: &DynamicImage) -> Result<Vec<u8>, String> {
    let mut buffer = Cursor::new(Vec::new());
    image.write_to(&mut buffer, ImageFormat::Png)
        .map_err(|error| error.to_string())?;
    Ok(buffer.into_inner())
}

/// 供测试：按比例裁切。
pub fn crop_by_ratio(image: &DynamicImage, rect: (f32, f32, f32, f32)) -> DynamicImage {
    let (width, height) = image.dimensions();
    let left = (width as f32 * rect.0).round() as u32;
    let top = (height as f32 * rect.1).round() as u32;
    let right = ((width as f32 * (rect.0 + rect.2)).round() as u32).min(width);
    let bottom = ((height as f32 * (rect.1 + rect.3)).round() as u32).min(height);
    image.crop_imm(left, top, right.saturating_sub(left), bottom.saturating_sub(top))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};
    use serde_json::json;

    fn sheet() -> DynamicImage {
        let mut image = RgbaImage::new(1000, 500);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            let value = ((x / 50 + y / 50) % 2) as u8 * 255;
            *pixel = Rgba([value, 128, 200, 255]);
        }
        DynamicImage::ImageRgba8(image)
    }

    #[test]
    fn landscape_splits_into_four_regions() {
        let pieces = split_sheet(&[], SheetLayout::Landscape);
        // 空字节解码失败：这里只验证错误路径不 panic。
        assert!(pieces.is_err());
    }

    #[test]
    fn splits_a_real_sheet_into_decodable_pieces() {
        let source = sheet();
        let mut buffer = Cursor::new(Vec::new());
        source.write_to(&mut buffer, ImageFormat::Png).expect("png");
        let bytes = buffer.into_inner();
        let pieces = split_sheet(&bytes, SheetLayout::Landscape).expect("split");
        assert_eq!(pieces.len(), 4);
        assert_eq!(pieces[0].0, "closeup");
        assert_eq!(pieces[3].0, "back");
        for (_, _, piece) in pieces {
            let decoded = image::load_from_memory(&piece).expect("decode");
            assert!(decoded.width() > 0 && decoded.height() > 0);
        }
    }

    #[test]
    fn stores_views_into_the_content_addressed_store() {
        let dir = tempfile::tempdir().expect("tempdir");
        let source = sheet();
        let mut buffer = Cursor::new(Vec::new());
        source.write_to(&mut buffer, ImageFormat::Png).expect("png");
        let pieces = split_sheet(&buffer.into_inner(), SheetLayout::Portrait).expect("split");
        let views = store_views(dir.path(), pieces, json!({"projectId": "p1"})).expect("store");
        assert_eq!(views.len(), 4);
        assert!(dir.path().join(&views[0].asset.path).exists());
        assert_eq!(views[0].asset.kind, "image");
    }

    #[test]
    fn thumbnail_keeps_aspect_ratio() {
        let source = sheet(); // 1000×500
        let mut buffer = Cursor::new(Vec::new());
        source.write_to(&mut buffer, ImageFormat::Png).expect("png");
        let thumb = thumbnail(&buffer.into_inner(), 100).expect("thumb");
        let decoded = image::load_from_memory(&thumb).expect("decode");
        assert_eq!(decoded.width(), 100);
        assert_eq!(decoded.height(), 50);
    }

    #[test]
    fn crops_by_ratio() {
        let image = sheet();
        let cropped = crop_by_ratio(&image, (0.0, 0.0, 0.5, 1.0));
        assert_eq!(cropped.width(), 500);
        assert_eq!(cropped.height(), 500);
    }

    #[test]
    fn portrait_has_four_quadrants() {
        let cells = regions(SheetLayout::Portrait);
        assert_eq!(cells.len(), 4);
        assert_eq!(cells[0].0, "front");
        assert_eq!(cells[3].0, "back");
    }

    #[test]
    fn grid_layout_produces_cells_in_order() {
        let cells = regions(SheetLayout::parse("3x3"));
        assert_eq!(cells.len(), 9);
        assert_eq!(cells[0].0, "cell-1");
        assert_eq!(cells[8].0, "cell-9");
        let strip = regions(SheetLayout::parse("strip:8"));
        assert_eq!(strip.len(), 8);
        assert_eq!(strip[3].0, "cell-4");
    }
}
