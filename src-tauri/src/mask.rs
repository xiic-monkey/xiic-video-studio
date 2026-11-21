use image::{GenericImageView, ImageBuffer, ImageFormat, Rgba, RgbaImage};
use std::io::Cursor;

/// 把前端导出的 RGBA 蒙版归一化成「双约定」蒙版 PNG。
///
/// 编辑器里是「白笔画在透明底上」，按 alpha 取值得到灰度：
/// 画过的像素 alpha=255 → 灰度 255（白=重绘），没画的 alpha=0 → 灰度 0（黑=保留）。
/// 忽略 RGB，避免不同浏览器的抗锯齿颜色干扰。
///
/// 输出 RGBA8，让两种协议约定同时成立：
/// - RGB = 灰度（重绘区白、保留区黑）：按灰度解读蒙版的协议直接可用；
/// - A = 255 - alpha（重绘区 0、保留区 255）：OpenAI 图片编辑约定
///   「透明处才是要重绘的区域」，只输出灰度会让模型认为整张图都不用改。
pub fn normalize_mask(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let source = image::load_from_memory(bytes).map_err(|error| error.to_string())?;
    let rgba: RgbaImage = source.to_rgba8();
    let (width, height) = rgba.dimensions();
    let normalized: RgbaImage = ImageBuffer::from_fn(width, height, |x, y| {
        let alpha = rgba.get_pixel(x, y)[3];
        Rgba([alpha, alpha, alpha, 255 - alpha])
    });
    let mut buffer = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(normalized)
        .write_to(&mut buffer, ImageFormat::Png)
        .map_err(|error| error.to_string())?;
    Ok(buffer.into_inner())
}

/// 蒙版必须和源图同尺寸，否则图片编辑接口会把整张图按错位蒙版处理。
pub fn ensure_same_size(source: &[u8], mask: &[u8]) -> Result<(u32, u32), String> {
    let source = image::load_from_memory(source)
        .map_err(|error| format!("源图无法解码：{error}"))?;
    let mask = image::load_from_memory(mask)
        .map_err(|error| format!("蒙版无法解码：{error}"))?;
    let expected = source.dimensions();
    let actual = mask.dimensions();
    if expected != actual {
        return Err(format!(
            "蒙版尺寸 {}×{} 与源图 {}×{} 不一致，请重新绘制",
            actual.0, actual.1, expected.0, expected.1,
        ));
    }
    Ok(expected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    fn stroke_mask() -> Vec<u8> {
        let mut image = RgbaImage::new(100, 50);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            let painted = (20..60).contains(&x) && (10..30).contains(&y);
            *pixel = Rgba([255, 255, 255, if painted { 255 } else { 0 }]);
        }
        let mut buffer = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(image)
            .write_to(&mut buffer, ImageFormat::Png)
            .expect("png");
        buffer.into_inner()
    }

    #[test]
    fn alpha_becomes_gray_and_inverted_alpha() {
        let png = normalize_mask(&stroke_mask()).expect("normalize");
        let decoded = image::load_from_memory(&png).expect("decode");
        let rgba = decoded.to_rgba8();
        assert_eq!(rgba.dimensions(), (100, 50));
        // 画过的区域：灰度白（按灰度解读=重绘），但 alpha=0（OpenAI 约定=重绘）。
        let painted = rgba.get_pixel(30, 15);
        assert_eq!(&painted.0, &[255, 255, 255, 0]);
        // 没画的区域：灰度黑（保留），alpha=255（不透明=保留）。
        let kept = rgba.get_pixel(5, 5);
        assert_eq!(&kept.0, &[0, 0, 0, 255]);
    }

    #[test]
    fn normalizing_invalid_bytes_is_an_error() {
        assert!(normalize_mask(b"not an image").is_err());
    }

    #[test]
    fn rejects_a_mask_that_does_not_match_the_source() {
        let source = stroke_mask();
        let mut smaller = RgbaImage::new(80, 50);
        for pixel in smaller.pixels_mut() {
            *pixel = Rgba([0, 0, 0, 0]);
        }
        let mut buffer = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgba8(smaller)
            .write_to(&mut buffer, ImageFormat::Png)
            .expect("png");
        assert!(ensure_same_size(&source, &buffer.into_inner()).is_err());
        assert_eq!(ensure_same_size(&source, &source).expect("same"), (100, 50));
    }
}
