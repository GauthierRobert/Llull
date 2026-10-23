//! Small vector helpers, written with the same operation order as the TypeScript engine (`editMesh.ts`, `lib/vec3.ts`) so every result is
//! bit-identical (RS1 §2 rule 3). No fused multiply-add: Rust never contracts `a * b + c`.

use llull_jsmath::hypot;

pub type Vec3 = [f64; 3];

/// `normalOf`: the unnormalised normal (twice the area vector) of triangle `a b c`.
pub fn normal_of(a: Vec3, b: Vec3, c: Vec3) -> Vec3 {
    let [ux, uy, uz] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let [vx, vy, vz] = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]
}

/// V8 `Math.hypot(...v)`.
pub fn length(v: Vec3) -> f64 {
    hypot(&v)
}

pub fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// Diagonal of the bounding box of flat xyz positions (`meshDiagonal`); 0 below one vertex.
pub fn diagonal(positions: &[f64]) -> f64 {
    if positions.len() < 3 {
        return 0.0;
    }
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for p in positions.chunks_exact(3) {
        for axis in 0..3 {
            if p[axis] < min[axis] {
                min[axis] = p[axis];
            }
            if p[axis] > max[axis] {
                max[axis] = p[axis];
            }
        }
    }
    hypot(&[max[0] - min[0], max[1] - min[1], max[2] - min[2]])
}

/// A spherical working region: `insideRegion` of the TypeScript engine.
#[derive(Debug, Clone, Copy)]
pub struct Sphere {
    pub center: Vec3,
    pub radius: f64,
}

impl Sphere {
    pub fn contains(&self, p: Vec3) -> bool {
        hypot(&[p[0] - self.center[0], p[1] - self.center[1], p[2] - self.center[2]]) <= self.radius
    }
}
