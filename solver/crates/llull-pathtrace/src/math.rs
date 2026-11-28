//! Small f32 vector algebra of the tracer: `Vec3`, an orthonormal `Frame` and the 3x4 `Affine` of an instance.

use std::ops::{Add, AddAssign, Div, Index, Mul, MulAssign, Neg, Sub};

pub const PI: f32 = std::f32::consts::PI;
pub const INV_PI: f32 = std::f32::consts::FRAC_1_PI;

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

pub const fn v3(x: f32, y: f32, z: f32) -> Vec3 {
    Vec3 { x, y, z }
}

impl Vec3 {
    pub const ZERO: Vec3 = v3(0.0, 0.0, 0.0);
    pub const ONE: Vec3 = v3(1.0, 1.0, 1.0);

    pub fn splat(value: f32) -> Vec3 {
        v3(value, value, value)
    }

    pub fn from_f64(value: [f64; 3]) -> Vec3 {
        v3(value[0] as f32, value[1] as f32, value[2] as f32)
    }

    pub fn dot(self, other: Vec3) -> f32 {
        self.x * other.x + self.y * other.y + self.z * other.z
    }

    pub fn cross(self, other: Vec3) -> Vec3 {
        v3(self.y * other.z - self.z * other.y, self.z * other.x - self.x * other.z, self.x * other.y - self.y * other.x)
    }

    pub fn length(self) -> f32 {
        self.dot(self).sqrt()
    }

    /// Unit vector; the zero vector stays zero.
    pub fn normalized(self) -> Vec3 {
        let length = self.length();
        if length > 0.0 {
            self * (1.0 / length)
        } else {
            self
        }
    }

    pub fn times(self, other: Vec3) -> Vec3 {
        v3(self.x * other.x, self.y * other.y, self.z * other.z)
    }

    pub fn min(self, other: Vec3) -> Vec3 {
        v3(self.x.min(other.x), self.y.min(other.y), self.z.min(other.z))
    }

    pub fn max(self, other: Vec3) -> Vec3 {
        v3(self.x.max(other.x), self.y.max(other.y), self.z.max(other.z))
    }

    pub fn max_component(self) -> f32 {
        self.x.max(self.y).max(self.z)
    }

    pub fn is_finite(self) -> bool {
        self.x.is_finite() && self.y.is_finite() && self.z.is_finite()
    }

    pub fn is_black(self) -> bool {
        self.x <= 0.0 && self.y <= 0.0 && self.z <= 0.0
    }

    /// Rec.709 luminance.
    pub fn luminance(self) -> f32 {
        0.2126 * self.x + 0.7152 * self.y + 0.0722 * self.z
    }

    pub fn lerp(self, other: Vec3, t: f32) -> Vec3 {
        self + (other - self) * t
    }
}

impl Index<usize> for Vec3 {
    type Output = f32;
    fn index(&self, axis: usize) -> &f32 {
        match axis {
            0 => &self.x,
            1 => &self.y,
            _ => &self.z,
        }
    }
}

impl Add for Vec3 {
    type Output = Vec3;
    fn add(self, o: Vec3) -> Vec3 {
        v3(self.x + o.x, self.y + o.y, self.z + o.z)
    }
}

impl AddAssign for Vec3 {
    fn add_assign(&mut self, o: Vec3) {
        *self = *self + o;
    }
}

impl Sub for Vec3 {
    type Output = Vec3;
    fn sub(self, o: Vec3) -> Vec3 {
        v3(self.x - o.x, self.y - o.y, self.z - o.z)
    }
}

impl Mul<f32> for Vec3 {
    type Output = Vec3;
    fn mul(self, s: f32) -> Vec3 {
        v3(self.x * s, self.y * s, self.z * s)
    }
}

impl MulAssign<Vec3> for Vec3 {
    fn mul_assign(&mut self, o: Vec3) {
        *self = self.times(o);
    }
}

impl Div<f32> for Vec3 {
    type Output = Vec3;
    fn div(self, s: f32) -> Vec3 {
        self * (1.0 / s)
    }
}

impl Neg for Vec3 {
    type Output = Vec3;
    fn neg(self) -> Vec3 {
        v3(-self.x, -self.y, -self.z)
    }
}

/// Orthonormal frame with `n` as local +Z (Duff et al. 2017 branchless basis).
#[derive(Debug, Clone, Copy)]
pub struct Frame {
    pub s: Vec3,
    pub t: Vec3,
    pub n: Vec3,
}

impl Frame {
    pub fn from_normal(n: Vec3) -> Frame {
        let sign = 1.0f32.copysign(n.z);
        let a = -1.0 / (sign + n.z);
        let b = n.x * n.y * a;
        let s = v3(1.0 + sign * n.x * n.x * a, sign * b, -sign * n.x);
        let t = v3(b, sign + n.y * n.y * a, -n.y);
        Frame { s, t, n }
    }

    pub fn to_local(&self, v: Vec3) -> Vec3 {
        v3(v.dot(self.s), v.dot(self.t), v.dot(self.n))
    }

    pub fn to_world(&self, v: Vec3) -> Vec3 {
        self.s * v.x + self.t * v.y + self.n * v.z
    }
}

/// Row-major 3x4 affine (local to world) in f64, as stored in `instances.f64`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Affine {
    pub m: [[f64; 4]; 3],
}

impl Affine {
    pub const IDENTITY: Affine = Affine { m: [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]] };

    pub fn determinant(&self) -> f64 {
        let m = &self.m;
        m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
            + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    }

    /// Inverse affine; `None` when the linear part is singular.
    pub fn inverse(&self) -> Option<Affine> {
        let det = self.determinant();
        if det == 0.0 || !det.is_finite() {
            return None;
        }
        let m = &self.m;
        let inv_det = 1.0 / det;
        let mut r = [[0.0; 4]; 3];
        r[0][0] = (m[1][1] * m[2][2] - m[1][2] * m[2][1]) * inv_det;
        r[0][1] = (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * inv_det;
        r[0][2] = (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * inv_det;
        r[1][0] = (m[1][2] * m[2][0] - m[1][0] * m[2][2]) * inv_det;
        r[1][1] = (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * inv_det;
        r[1][2] = (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * inv_det;
        r[2][0] = (m[1][0] * m[2][1] - m[1][1] * m[2][0]) * inv_det;
        r[2][1] = (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * inv_det;
        r[2][2] = (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * inv_det;
        for out in r.iter_mut() {
            out[3] = -(out[0] * m[0][3] + out[1] * m[1][3] + out[2] * m[2][3]);
        }
        Some(Affine { m: r })
    }

    pub fn to_f32(&self) -> Affine32 {
        let mut m = [[0.0f32; 4]; 3];
        for (row, source) in m.iter_mut().zip(self.m.iter()) {
            for (value, s) in row.iter_mut().zip(source.iter()) {
                *value = *s as f32;
            }
        }
        Affine32 { m }
    }
}

/// f32 copy of an `Affine` used in the hot loops.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Affine32 {
    pub m: [[f32; 4]; 3],
}

impl Affine32 {
    pub fn point(&self, p: Vec3) -> Vec3 {
        let m = &self.m;
        v3(
            m[0][0] * p.x + m[0][1] * p.y + m[0][2] * p.z + m[0][3],
            m[1][0] * p.x + m[1][1] * p.y + m[1][2] * p.z + m[1][3],
            m[2][0] * p.x + m[2][1] * p.y + m[2][2] * p.z + m[2][3],
        )
    }

    pub fn vector(&self, v: Vec3) -> Vec3 {
        let m = &self.m;
        v3(
            m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z,
            m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z,
            m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z,
        )
    }

    /// Transposed linear part times `v`: with the world-to-local inverse this maps a local normal to world.
    pub fn transpose_vector(&self, v: Vec3) -> Vec3 {
        let m = &self.m;
        v3(
            m[0][0] * v.x + m[1][0] * v.y + m[2][0] * v.z,
            m[0][1] * v.x + m[1][1] * v.y + m[2][1] * v.z,
            m[0][2] * v.x + m[1][2] * v.y + m[2][2] * v.z,
        )
    }
}

/// Offsets a ray origin off a surface along the geometric normal `n` (Wächter and Binder, Ray Tracing Gems ch. 6): integer ulp steps far
/// from the origin, a fixed epsilon near it, so a secondary ray never re-hits its own triangle whatever the coordinate magnitude.
pub fn offset_ray(p: Vec3, n: Vec3) -> Vec3 {
    const ORIGIN: f32 = 1.0 / 32.0;
    const FLOAT_SCALE: f32 = 1.0 / 65536.0;
    const INT_SCALE: f32 = 256.0;
    let step = |value: f32, normal: f32| -> f32 {
        let of_i = (INT_SCALE * normal) as i32;
        let bits = value.to_bits() as i32;
        let moved = f32::from_bits((bits + if value < 0.0 { -of_i } else { of_i }) as u32);
        if value.abs() < ORIGIN {
            value + FLOAT_SCALE * normal
        } else {
            moved
        }
    };
    v3(step(p.x, n.x), step(p.y, n.y), step(p.z, n.z))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_is_orthonormal_and_round_trips() {
        for n in [v3(0.0, 0.0, 1.0), v3(0.0, 0.0, -1.0), v3(0.3, -0.4, 0.866).normalized(), v3(1.0, 0.0, 0.0)] {
            let f = Frame::from_normal(n);
            assert!(f.s.dot(f.t).abs() < 1e-6 && f.s.dot(f.n).abs() < 1e-6 && (f.s.length() - 1.0).abs() < 1e-6);
            let v = v3(0.2, 0.5, -0.7);
            assert!((f.to_world(f.to_local(v)) - v).length() < 1e-6);
        }
    }

    #[test]
    fn affine_inverse_round_trips() {
        let a = Affine { m: [[2.0, 0.0, 0.0, 1.0], [0.0, 0.0, -3.0, 2.0], [0.0, 1.0, 0.0, -4.0]] };
        let inv = a.inverse().unwrap().to_f32();
        let p = v3(0.5, -1.5, 2.0);
        assert!((inv.point(a.to_f32().point(p)) - p).length() < 1e-5);
        assert!(Affine { m: [[0.0; 4]; 3] }.inverse().is_none());
    }
}
