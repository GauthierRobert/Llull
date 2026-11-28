//! Textures of a job (`tex-<i>.<png|jpg|hdr>`): decoded once, sampled bilinear with repeat wrap, image row 0 at v = 1 (RV1 §5b).
//! LDR images stay 8-bit RGBA (sRGB decoded per texel through a table), HDR images f32 RGB.

use crate::job::{ColorSpace, TextureFormat};
use crate::math::{v3, Vec3};
use crate::PathTraceError;
use std::sync::OnceLock;

/// Longest side accepted (the `import_texture` limit).
pub const MAX_SIDE: u32 = 8192;

#[derive(Debug, Clone)]
pub enum Pixels {
    Ldr(Vec<[u8; 4]>),
    Hdr(Vec<Vec3>),
}

#[derive(Debug, Clone)]
pub struct Texture {
    pub width: u32,
    pub height: u32,
    pub pixels: Pixels,
    pub srgb: bool,
}

pub(crate) fn srgb_table() -> &'static [f32; 256] {
    static TABLE: OnceLock<[f32; 256]> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut table = [0.0f32; 256];
        for (i, value) in table.iter_mut().enumerate() {
            let c = i as f64 / 255.0;
            *value = if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) } as f32;
        }
        table
    })
}

fn texture_error(message: String) -> PathTraceError {
    PathTraceError { code: "PATHTRACE_TEXTURE_INVALID", message }
}

impl Texture {
    /// Decodes a texture file's bytes in the declared format.
    pub fn decode(name: &str, bytes: &[u8], format: TextureFormat, color_space: ColorSpace) -> Result<Texture, PathTraceError> {
        let image_format = match format {
            TextureFormat::Png => image::ImageFormat::Png,
            TextureFormat::Jpeg => image::ImageFormat::Jpeg,
            TextureFormat::Hdr => image::ImageFormat::Hdr,
        };
        let decoded = image::load_from_memory_with_format(bytes, image_format)
            .map_err(|error| texture_error(format!("{name}: not a decodable {format:?} image ({error})")))?;
        let (width, height) = (decoded.width(), decoded.height());
        if width == 0 || height == 0 || width > MAX_SIDE || height > MAX_SIDE {
            return Err(texture_error(format!("{name}: {width} x {height} px is outside 1..{MAX_SIDE} per side")));
        }
        let pixels = match format {
            TextureFormat::Hdr => {
                let rgb = decoded.to_rgb32f();
                Pixels::Hdr(rgb.pixels().map(|p| v3(p.0[0].max(0.0), p.0[1].max(0.0), p.0[2].max(0.0))).collect())
            }
            TextureFormat::Png | TextureFormat::Jpeg => Pixels::Ldr(decoded.to_rgba8().pixels().map(|p| p.0).collect()),
        };
        if let Pixels::Hdr(values) = &pixels {
            if values.iter().any(|v| !v.is_finite()) {
                return Err(texture_error(format!("{name}: non-finite HDR texel")));
            }
        }
        Ok(Texture { width, height, pixels, srgb: color_space == ColorSpace::Srgb && format != TextureFormat::Hdr })
    }

    /// Linear RGB of texel (x, y), row 0 at the top of the image.
    pub fn texel(&self, x: u32, y: u32) -> Vec3 {
        let index = (y * self.width + x) as usize;
        match &self.pixels {
            Pixels::Hdr(values) => values[index],
            Pixels::Ldr(values) => {
                let p = values[index];
                if self.srgb {
                    let table = srgb_table();
                    v3(table[p[0] as usize], table[p[1] as usize], table[p[2] as usize])
                } else {
                    v3(f32::from(p[0]), f32::from(p[1]), f32::from(p[2])) * (1.0 / 255.0)
                }
            }
        }
    }

    /// Bilinear sample at (u, v), repeat wrap in u; in v repeat (materials) or clamp (`clamp_v`, the environment's poles).
    pub fn sample(&self, u: f32, v: f32, clamp_v: bool) -> Vec3 {
        if !u.is_finite() || !v.is_finite() {
            return Vec3::ZERO;
        }
        let (w, h) = (self.width as i64, self.height as i64);
        let x = u * self.width as f32 - 0.5;
        let y = (1.0 - v) * self.height as f32 - 0.5;
        let (x0, y0) = (x.floor(), y.floor());
        let (fx, fy) = (x - x0, y - y0);
        let wrap_x = |i: i64| i.rem_euclid(w) as u32;
        let wrap_y = |i: i64| if clamp_v { i.clamp(0, h - 1) as u32 } else { i.rem_euclid(h) as u32 };
        let (xa, xb) = (wrap_x(x0 as i64), wrap_x(x0 as i64 + 1));
        let (ya, yb) = (wrap_y(y0 as i64), wrap_y(y0 as i64 + 1));
        let top = self.texel(xa, ya).lerp(self.texel(xb, ya), fx);
        let bottom = self.texel(xa, yb).lerp(self.texel(xb, yb), fx);
        top.lerp(bottom, fy)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn checker() -> Texture {
        Texture {
            width: 2,
            height: 2,
            pixels: Pixels::Ldr(vec![[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [255, 255, 255, 255]]),
            srgb: false,
        }
    }

    #[test]
    fn texel_centres_return_their_texel_and_row_zero_is_v_one() {
        let t = checker();
        assert_eq!(t.sample(0.25, 0.75, false), v3(1.0, 0.0, 0.0));
        assert_eq!(t.sample(0.75, 0.25, false), v3(1.0, 1.0, 1.0));
        let wrapped = t.sample(1.25, 0.75, false);
        assert_eq!(wrapped, v3(1.0, 0.0, 0.0));
        let midpoint = t.sample(0.5, 0.75, false);
        assert!((midpoint - v3(0.5, 0.5, 0.0)).length() < 1e-6);
    }

    #[test]
    fn srgb_decodes_through_the_transfer_curve() {
        let t = Texture { width: 1, height: 1, pixels: Pixels::Ldr(vec![[128, 128, 128, 255]]), srgb: true };
        assert!((t.texel(0, 0).x - 0.2158605).abs() < 1e-5);
    }

    #[test]
    fn garbage_is_a_named_texture_error() {
        let error = Texture::decode("tex-0.png", b"not a png", TextureFormat::Png, ColorSpace::Srgb).unwrap_err();
        assert_eq!(error.code, "PATHTRACE_TEXTURE_INVALID");
    }
}
