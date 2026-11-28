//! Display transform of `image.png`: exposure 2^EV, then the AgX base view transform in the widely used real-time approximation of
//! Troy Sobotka's AgX (Benjamin Wrensch, "Minimal AgX implementation", iolite, 2023), then the sRGB OETF:
//!
//! 1. inset: `x ← M_in · x` (the AgX inset matrix below, Rec.709 primaries),
//! 2. log2 encoding: `x ← (clamp(log2 x, −12.47393, 4.026069) + 12.47393) / 16.500999` (16.5 stops around 0.18 · 2^0),
//! 3. sigmoid: `x ← 15.5x⁶ − 40.14x⁵ + 31.96x⁴ − 6.868x³ + 0.4298x² + 0.1191x − 0.00232` (polynomial fit of the AgX base contrast curve),
//! 4. outset: `x ← M_out · x` (inverse inset), which leaves a display-encoded value; it is decoded with a 2.2 power to display-linear,
//!    as in the reference implementation,
//! 5. sRGB OETF (IEC 61966-2-1) and 8-bit quantisation (round half up).
//!
//! Scene-linear 0.18 maps to about sRGB 0.46 (8-bit ~118); radiance 1 at 0 EV to a near white.

const INSET: [[f32; 3]; 3] =
    [[0.842_479_06, 0.078_433_6, 0.079_223_745], [0.042_328_242, 0.878_468_64, 0.079_166_13], [0.042_375_655, 0.078_433_6, 0.879_143]];
const OUTSET: [[f32; 3]; 3] =
    [[1.196_879, -0.098_020_88, -0.099_029_74], [-0.052_896_85, 1.151_903_1, -0.098_961_18], [-0.052_971_635, -0.098_043_45, 1.151_073_7]];
const MIN_EV: f32 = -12.473_93;
const MAX_EV: f32 = 4.026_069;

fn apply(m: &[[f32; 3]; 3], v: [f32; 3]) -> [f32; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

fn sigmoid(x: f32) -> f32 {
    let x2 = x * x;
    let x4 = x2 * x2;
    15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232
}

fn srgb_oetf(x: f32) -> f32 {
    if x <= 0.003_130_8 {
        12.92 * x
    } else {
        1.055 * x.powf(1.0 / 2.4) - 0.055
    }
}

/// Display-linear [0, 1] RGB of a scene-linear value after exposure (`scale` = 2^EV) and AgX.
pub fn agx(rgb: [f32; 3], scale: f32) -> [f32; 3] {
    let exposed = rgb.map(|c| if c.is_finite() { (c * scale).max(0.0) } else { 0.0 });
    let inset = apply(&INSET, exposed);
    let encoded = inset.map(|c| ((c.max(1e-10).log2().clamp(MIN_EV, MAX_EV) - MIN_EV) / (MAX_EV - MIN_EV)).clamp(0.0, 1.0));
    let curved = encoded.map(sigmoid);
    apply(&OUTSET, curved).map(|c| c.max(0.0).powf(2.2).clamp(0.0, 1.0))
}

/// 8-bit sRGB of a scene-linear value.
pub fn to_srgb8(rgb: [f32; 3], scale: f32) -> [u8; 3] {
    agx(rgb, scale).map(|c| (srgb_oetf(c) * 255.0 + 0.5).clamp(0.0, 255.0) as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn black_mid_grey_and_white_land_where_documented() {
        assert!(to_srgb8([0.0; 3], 1.0).iter().all(|c| *c <= 1));
        let grey = to_srgb8([0.18; 3], 1.0);
        assert!((100..=135).contains(&grey[0]), "{grey:?}");
        let one = to_srgb8([1.0; 3], 1.0);
        assert!(one[0] > 200, "{one:?}");
        let hot = to_srgb8([1000.0; 3], 1.0);
        assert!(hot.iter().all(|c| *c >= 250), "{hot:?}");
        // Monotone in exposure.
        assert!(to_srgb8([0.18; 3], 2.0)[0] > grey[0]);
        assert_eq!(to_srgb8([f32::NAN, 0.5, 0.5], 1.0)[0], to_srgb8([0.0, 0.5, 0.5], 1.0)[0]);
    }
}
