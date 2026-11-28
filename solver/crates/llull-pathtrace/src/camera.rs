//! Camera rays (RV1 §5b): perspective (vertical `fovY`) or orthographic (`orthoHeight`), thin-lens depth of field when
//! `apertureRadius` > 0 (focus plane at `focusDistance` along `forward`). Pixel (0, 0) is the top-left; samples are jittered with a
//! tent filter of radius one pixel.

use crate::job::Projection;
use crate::math::{Vec3, PI};

#[derive(Debug, Clone, Copy)]
pub struct Camera {
    pub position: Vec3,
    pub forward: Vec3,
    pub right: Vec3,
    pub up: Vec3,
    pub projection: Projection,
    pub tan_half: f32,
    pub half_height: f32,
    pub aperture: f32,
    pub focus: f32,
    pub width: u32,
    pub height: u32,
}

/// Tent-distributed offset in [−1, 1] from a uniform value.
fn tent(u: f32) -> f32 {
    let r = 2.0 * u;
    if r < 1.0 {
        r.sqrt() - 1.0
    } else {
        1.0 - (2.0 - r).max(0.0).sqrt()
    }
}

/// Concentric map of the unit square to the unit disk (Shirley and Chiu).
fn disk(u1: f32, u2: f32) -> (f32, f32) {
    let (a, b) = (2.0 * u1 - 1.0, 2.0 * u2 - 1.0);
    if a == 0.0 && b == 0.0 {
        return (0.0, 0.0);
    }
    let (r, theta) = if a.abs() > b.abs() { (a, PI / 4.0 * (b / a)) } else { (b, PI / 2.0 - PI / 4.0 * (a / b)) };
    (r * theta.cos(), r * theta.sin())
}

impl Camera {
    /// Ray (origin, unit direction) through pixel (x, y) for the random values (jitter x, jitter y, lens u, lens v).
    pub fn ray(&self, x: u32, y: u32, u: [f32; 4]) -> (Vec3, Vec3) {
        let px = x as f32 + 0.5 + tent(u[0]);
        let py = y as f32 + 0.5 + tent(u[1]);
        let aspect = self.width as f32 / self.height as f32;
        let sx = (2.0 * px / self.width as f32 - 1.0) * aspect;
        let sy = 1.0 - 2.0 * py / self.height as f32;
        let (origin, direction) = match self.projection {
            Projection::Perspective => {
                (self.position, (self.forward + self.right * (sx * self.tan_half) + self.up * (sy * self.tan_half)).normalized())
            }
            Projection::Orthographic => {
                (self.position + self.right * (sx * self.half_height) + self.up * (sy * self.half_height), self.forward)
            }
        };
        if self.aperture <= 0.0 {
            return (origin, direction);
        }
        let focus_point = origin + direction * (self.focus / direction.dot(self.forward));
        let (lx, ly) = disk(u[2], u[3]);
        let lens = origin + self.right * (lx * self.aperture) + self.up * (ly * self.aperture);
        (lens, (focus_point - lens).normalized())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::math::v3;

    #[test]
    fn the_tent_is_centred_and_bounded() {
        assert_eq!(tent(0.5), 0.0);
        assert_eq!(tent(0.0), -1.0);
        assert!(tent(0.999_999) < 1.0);
        let (x, y) = disk(1.0, 0.5);
        assert!((x - 1.0).abs() < 1e-6 && y.abs() < 1e-6);
    }

    #[test]
    fn the_centre_ray_looks_forward_and_lens_rays_meet_at_focus() {
        let camera = Camera {
            position: v3(0.0, 0.0, 0.0),
            forward: v3(0.0, 1.0, 0.0),
            right: v3(1.0, 0.0, 0.0),
            up: v3(0.0, 0.0, 1.0),
            projection: Projection::Perspective,
            tan_half: 0.5,
            half_height: 1.0,
            aperture: 0.2,
            focus: 5.0,
            width: 10,
            height: 10,
        };
        let at_focus = |lens: [f32; 2]| {
            let (o, d) = camera.ray(4, 4, [0.75, 0.75, lens[0], lens[1]]);
            o + d * ((5.0 - o.y) / d.y)
        };
        let (a, b) = (at_focus([0.1, 0.9]), at_focus([0.8, 0.3]));
        assert!((a - b).length() < 1e-4, "{a:?} {b:?}");
        let (o, d) = camera.ray(4, 4, [0.5, 0.5, 0.5, 0.5]);
        assert!(o.length() < 1e-6 && (d - v3(-0.05, 1.0, 0.05).normalized()).length() < 1e-5, "{d:?}");
    }
}
