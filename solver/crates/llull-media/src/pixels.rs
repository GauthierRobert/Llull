//! Decoding one input frame (a PNG from the host's `frame-%05d.png`) to packed 8-bit RGB.

use std::io::Cursor;

/// One decoded frame: `rgb` is `width * height * 3` bytes, row-major.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rgb {
    pub width: usize,
    pub height: usize,
    pub rgb: Vec<u8>,
}

/// Decodes a PNG (any colour type or bit depth; alpha is composited over white). A string describes the failure.
pub fn decode_png(bytes: &[u8]) -> Result<Rgb, String> {
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(|error| format!("not a readable PNG: {error}"))?;
    let mut buffer = vec![0u8; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buffer).map_err(|error| format!("PNG decode failed: {error}"))?;
    let (width, height) = (info.width as usize, info.height as usize);
    let data = &buffer[..info.buffer_size()];
    let over_white = |value: u8, alpha: u8| ((u32::from(value) * u32::from(alpha) + 255 * (255 - u32::from(alpha)) + 127) / 255) as u8;
    let rgb: Vec<u8> = match info.color_type {
        png::ColorType::Rgb => data.to_vec(),
        png::ColorType::Rgba => {
            data.chunks_exact(4).flat_map(|p| [over_white(p[0], p[3]), over_white(p[1], p[3]), over_white(p[2], p[3])]).collect()
        }
        png::ColorType::Grayscale => data.iter().flat_map(|&g| [g, g, g]).collect(),
        png::ColorType::GrayscaleAlpha => data
            .chunks_exact(2)
            .flat_map(|p| {
                let g = over_white(p[0], p[1]);
                [g, g, g]
            })
            .collect(),
        png::ColorType::Indexed => return Err("an indexed PNG was not expanded".to_string()),
    };
    if rgb.len() != width * height * 3 {
        return Err(format!("PNG pixel data is {} bytes for {width} x {height}", rgb.len()));
    }
    Ok(Rgb { width, height, rgb })
}

#[cfg(test)]
pub mod testing {
    use super::Rgb;

    /// A deterministic CAD-like test picture: a grid, a bar sliding with `k`, a ring (anti-aliasing-free).
    pub fn picture(width: usize, height: usize, k: usize) -> Rgb {
        let mut rgb = Vec::with_capacity(width * height * 3);
        for y in 0..height {
            for x in 0..width {
                let mut c = [30u8 + (y * 40 / height) as u8, 34, 48];
                if x % 16 == 0 || y % 16 == 0 {
                    c = [70, 74, 88];
                }
                let bar = (k * 3) % width.max(1);
                if x >= bar && x < bar + width / 6 && y > height / 3 && y < 2 * height / 3 {
                    c = [255, 159, 28];
                }
                let (dx, dy) = (x as i64 - (width / 2) as i64, y as i64 - (height / 2) as i64);
                if (dx * dx + dy * dy - (height as i64 / 5).pow(2)).abs() < 40 {
                    c = [60, 150, 240];
                }
                rgb.extend_from_slice(&c);
            }
        }
        Rgb { width, height, rgb }
    }

    /// `picture` as an 8-bit RGB PNG.
    pub fn png_bytes(frame: &Rgb) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut out, frame.width as u32, frame.height as u32);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&frame.rgb).unwrap();
        }
        out
    }
}
