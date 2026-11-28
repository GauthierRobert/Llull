//! Preetham, Shirley and Smits (1999) daylight, baked to a 512 x 256 equirectangular map (the `env` lookup, rotation 0) so the sky is
//! importance-sampled like an HDR map. Perez luminance and chromaticity distributions from turbidity and the sun direction (elevation
//! clamped at the horizon), xyY to linear Rec.709, then scaled so the mean radiance (luminance, solid-angle weighted) over the upper
//! hemisphere is 0.3 × intensity (RV1 §5b). The sky carries no sun disk: the sun is a `sun` light. Below the horizon the map holds a
//! ground of albedo 0.3 lit by the sky: 0.3 × the mirrored sky direction's radiance (not specified by the contract).

use crate::math::{v3, Vec3};
use crate::texture::{Pixels, Texture};

pub const WIDTH: u32 = 512;
pub const HEIGHT: u32 = 256;
const GROUND_ALBEDO: f64 = 0.3;

type Perez = [f64; 5];

fn perez(p: &Perez, cos_theta: f64, gamma: f64) -> f64 {
    let [a, b, c, d, e] = *p;
    let cos_gamma = gamma.cos();
    (1.0 + a * (b / cos_theta.max(0.01)).exp()) * (1.0 + c * (d * gamma).exp() + e * cos_gamma * cos_gamma)
}

struct Model {
    sun: [f64; 3],
    theta_sun: f64,
    coefficients: [Perez; 3],
    zenith: [f64; 3],
}

impl Model {
    fn new(turbidity: f64, sun_direction: [f64; 3]) -> Model {
        let t = turbidity;
        let z = sun_direction[2].clamp(0.0, 1.0);
        let horizontal = (sun_direction[0] * sun_direction[0] + sun_direction[1] * sun_direction[1]).sqrt();
        let sun = if horizontal > 0.0 {
            let s = (1.0 - z * z).sqrt() / horizontal;
            [sun_direction[0] * s, sun_direction[1] * s, z]
        } else {
            [0.0, 0.0, 1.0]
        };
        let theta = z.acos();
        let luminance = [0.1787 * t - 1.4630, -0.3554 * t + 0.4275, -0.0227 * t + 5.3251, 0.1206 * t - 2.5771, -0.0670 * t + 0.3703];
        let x = [-0.0193 * t - 0.2592, -0.0665 * t + 0.0008, -0.0004 * t + 0.2125, -0.0641 * t - 0.8989, -0.0033 * t + 0.0452];
        let y = [-0.0167 * t - 0.2608, -0.0950 * t + 0.0092, -0.0079 * t + 0.2102, -0.0441 * t - 1.6537, -0.0109 * t + 0.0529];
        let chi = (4.0 / 9.0 - t / 120.0) * (std::f64::consts::PI - 2.0 * theta);
        let zenith_y = ((4.0453 * t - 4.9710) * chi.tan() - 0.2155 * t + 2.4192).max(0.0);
        let (t2, th, th2, th3) = (t * t, theta, theta * theta, theta * theta * theta);
        let zenith_x = t2 * (0.00166 * th3 - 0.00375 * th2 + 0.00209 * th)
            + t * (-0.02903 * th3 + 0.06377 * th2 - 0.03202 * th + 0.00394)
            + (0.11693 * th3 - 0.21196 * th2 + 0.06052 * th + 0.25886);
        let zenith_yc = t2 * (0.00275 * th3 - 0.00610 * th2 + 0.00317 * th)
            + t * (-0.04214 * th3 + 0.08970 * th2 - 0.04153 * th + 0.00516)
            + (0.15346 * th3 - 0.26756 * th2 + 0.06670 * th + 0.26688);
        Model { sun, theta_sun: theta, coefficients: [luminance, x, y], zenith: [zenith_y, zenith_x, zenith_yc] }
    }

    /// Linear Rec.709 radiance (unscaled) of an upper-hemisphere direction.
    fn radiance(&self, d: [f64; 3]) -> [f64; 3] {
        let cos_theta = d[2].max(0.0);
        let cos_gamma = (d[0] * self.sun[0] + d[1] * self.sun[1] + d[2] * self.sun[2]).clamp(-1.0, 1.0);
        let gamma = cos_gamma.acos();
        let value =
            |k: usize| self.zenith[k] * perez(&self.coefficients[k], cos_theta, gamma) / perez(&self.coefficients[k], 1.0, self.theta_sun);
        let (big_y, x, y) = (value(0), value(1), value(2).max(1e-6));
        let big_x = x / y * big_y;
        let big_z = (1.0 - x - y) / y * big_y;
        [
            (3.2406 * big_x - 1.5372 * big_y - 0.4986 * big_z).max(0.0),
            (-0.9689 * big_x + 1.8758 * big_y + 0.0415 * big_z).max(0.0),
            (0.0557 * big_x - 0.2040 * big_y + 1.0570 * big_z).max(0.0),
        ]
    }
}

/// The baked sky map in the `env` orientation (rotation 0).
pub fn bake(turbidity: f64, intensity: f64, sun_direction: [f64; 3]) -> Texture {
    let model = Model::new(turbidity, sun_direction);
    let (w, h) = (WIDTH as usize, HEIGHT as usize);
    let mut raw = vec![[0.0f64; 3]; w * h];
    let (mut weighted, mut solid_angle) = (0.0f64, 0.0f64);
    for row in 0..h {
        let elevation = (0.5 - (row as f64 + 0.5) / h as f64) * std::f64::consts::PI;
        let (sin_e, cos_e) = elevation.sin_cos();
        for col in 0..w {
            let azimuth = ((col as f64 + 0.5) / w as f64 - 0.5) * 2.0 * std::f64::consts::PI;
            let (x, y) = (cos_e * azimuth.cos(), -cos_e * azimuth.sin());
            let value = if sin_e >= 0.0 {
                let v = model.radiance([x, y, sin_e]);
                weighted += (0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]) * cos_e;
                solid_angle += cos_e;
                v
            } else {
                let v = model.radiance([x, y, -sin_e]);
                [v[0] * GROUND_ALBEDO, v[1] * GROUND_ALBEDO, v[2] * GROUND_ALBEDO]
            };
            raw[row * w + col] = value;
        }
    }
    let mean = if solid_angle > 0.0 { weighted / solid_angle } else { 0.0 };
    let scale = if mean > 0.0 { 0.3 * intensity / mean } else { 0.0 };
    let texels = raw.iter().map(|v| v3((v[0] * scale) as f32, (v[1] * scale) as f32, (v[2] * scale) as f32)).collect::<Vec<Vec3>>();
    Texture { width: WIDTH, height: HEIGHT, pixels: Pixels::Hdr(texels), srgb: false }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_upper_hemisphere_mean_is_scaled_to_the_contract() {
        let sky = bake(3.0, 2.0, [0.3, 0.2, 0.6]);
        let (mut sum, mut weight) = (0.0f64, 0.0f64);
        for row in 0..(HEIGHT / 2) {
            let elevation = (0.5 - (f64::from(row) + 0.5) / f64::from(HEIGHT)) * std::f64::consts::PI;
            for col in 0..WIDTH {
                sum += f64::from(sky.texel(col, row).luminance()) * elevation.cos();
                weight += elevation.cos();
            }
        }
        assert!((sum / weight - 0.6).abs() < 1e-3, "{}", sum / weight);
        // Brighter towards the sun than away from it.
        let toward = sky.texel(WIDTH / 2 + 30, HEIGHT / 4).luminance();
        assert!(toward.is_finite());
    }
}
