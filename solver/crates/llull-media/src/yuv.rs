//! RGB to YCbCr 4:2:0, BT.709, limited range, in 16-bit fixed point (no floating point: the same bytes on every machine).
//! Luma = 16 + 219/255 (0.2126 R + 0.7152 G + 0.0722 B); chroma = 128 + 224/255 (B - Y') / 1.8556 and (R - Y') / 1.5748 on the mean of each 2x2 block.

use crate::pixels::Rgb;

/// The three planes of a 4:2:0 picture; chroma planes are `width / 2 x height / 2`.
pub struct Yuv420 {
    pub y: Vec<u8>,
    pub u: Vec<u8>,
    pub v: Vec<u8>,
}

/// Planes of `frame` (width and height must be even).
pub fn to_yuv420(frame: &Rgb) -> Yuv420 {
    let (w, h) = (frame.width, frame.height);
    let pixel = |x: usize, y: usize| {
        let at = (y * w + x) * 3;
        (i64::from(frame.rgb[at]), i64::from(frame.rgb[at + 1]), i64::from(frame.rgb[at + 2]))
    };
    let mut y_plane = Vec::with_capacity(w * h);
    for y in 0..h {
        for x in 0..w {
            let (r, g, b) = pixel(x, y);
            y_plane.push((((16 << 16) + 11966 * r + 40254 * g + 4064 * b + 32768) >> 16) as u8);
        }
    }
    let mut u_plane = Vec::with_capacity(w * h / 4);
    let mut v_plane = Vec::with_capacity(w * h / 4);
    for j in 0..h / 2 {
        for i in 0..w / 2 {
            let (mut r, mut g, mut b) = (0, 0, 0);
            for (dy, dx) in [(0, 0), (0, 1), (1, 0), (1, 1)] {
                let p = pixel(2 * i + dx, 2 * j + dy);
                r += p.0;
                g += p.1;
                b += p.2;
            }
            // sums of four pixels: the coefficients are divided by four through the shift of 18 instead of 16
            u_plane.push((((128 << 18) + (1 << 17) + (-6596 * r - 22189 * g + 28784 * b)) >> 18).clamp(16, 240) as u8);
            v_plane.push((((128 << 18) + (1 << 17) + (28784 * r - 26145 * g - 2639 * b)) >> 18).clamp(16, 240) as u8);
        }
    }
    Yuv420 { y: y_plane, u: u_plane, v: v_plane }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flat(r: u8, g: u8, b: u8) -> Yuv420 {
        to_yuv420(&Rgb { width: 2, height: 2, rgb: [r, g, b].repeat(4) })
    }

    #[test]
    fn black_and_white_map_to_the_limited_range_ends() {
        let black = flat(0, 0, 0);
        assert_eq!((black.y[0], black.u[0], black.v[0]), (16, 128, 128));
        let white = flat(255, 255, 255);
        assert_eq!((white.y[0], white.u[0], white.v[0]), (235, 128, 128));
    }

    #[test]
    fn primaries_match_the_bt709_limited_range_table() {
        // BT.709 limited range 8-bit: red (63, 102, 240), green (173, 42, 26), blue (32, 240, 118), within one level of rounding
        for (rgb, expected) in [((255, 0, 0), (63, 102, 240)), ((0, 255, 0), (173, 42, 26)), ((0, 0, 255), (32, 240, 118))] {
            let p = flat(rgb.0, rgb.1, rgb.2);
            let got = (i32::from(p.y[0]), i32::from(p.u[0]), i32::from(p.v[0]));
            assert!(
                (got.0 - expected.0).abs() <= 1 && (got.1 - expected.1).abs() <= 1 && (got.2 - expected.2).abs() <= 1,
                "{rgb:?}: {got:?} vs {expected:?}"
            );
        }
    }
}
