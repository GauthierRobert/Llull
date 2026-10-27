//! Error quadrics of the decimation (Garland and Heckbert 1997), with the operation order of the TypeScript engine (`decimate.ts`).

use crate::geom::Vec3;

/// Upper triangle of the symmetric 4x4 matrix of a plane (or a sum of planes), row by row.
pub type Quadric = [f64; 10];

pub fn plane_quadric(n: Vec3, point: Vec3, weight: f64) -> Quadric {
    let d = -(n[0] * point[0] + n[1] * point[1] + n[2] * point[2]);
    let p = [n[0], n[1], n[2], d];
    let mut q = [0.0; 10];
    let mut k = 0;
    for i in 0..4 {
        for j in i..4 {
            q[k] = weight * p[i] * p[j];
            k += 1;
        }
    }
    q
}

pub fn add_into(target: &mut Quadric, source: &Quadric) {
    for (t, s) in target.iter_mut().zip(source) {
        *t += s;
    }
}

pub fn quadric_cost(q: &Quadric, x: f64, y: f64, z: f64) -> f64 {
    q[0] * x * x
        + 2.0 * q[1] * x * y
        + 2.0 * q[2] * x * z
        + 2.0 * q[3] * x
        + q[4] * y * y
        + 2.0 * q[5] * y * z
        + 2.0 * q[6] * y
        + q[7] * z * z
        + 2.0 * q[8] * z
        + q[9]
}

/// The point that minimises the quadric, `None` when its 3x3 block is (nearly) singular.
pub fn optimal_position(q: &Quadric) -> Option<Vec3> {
    let (a, b, c, d, e, f) = (q[0], q[1], q[2], q[4], q[5], q[7]);
    let det = a * (d * f - e * e) - b * (b * f - c * e) + c * (b * e - c * d);
    let trace = a + d + f;
    // `!(x > y)` in the TypeScript engine: also true for NaN.
    if det.abs().partial_cmp(&(1e-12 * (trace * trace * trace))) != Some(std::cmp::Ordering::Greater) {
        return None;
    }
    let rhs = [-q[3], -q[6], -q[8]];
    let inv = [
        [d * f - e * e, c * e - b * f, b * e - c * d],
        [c * e - b * f, a * f - c * c, b * c - a * e],
        [b * e - c * d, b * c - a * e, a * d - b * b],
    ];
    let solve = |row: [f64; 3]| (row[0] * rhs[0] + row[1] * rhs[1] + row[2] * rhs[2]) / det;
    Some([solve(inv[0]), solve(inv[1]), solve(inv[2])])
}

#[cfg(test)]
mod tests {
    use super::{add_into, optimal_position, plane_quadric, quadric_cost};

    #[test]
    fn three_orthogonal_planes_meet_at_their_corner_with_no_error_and_parallel_ones_have_none() {
        let mut sum = [0.0; 10];
        for normal in [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]] {
            add_into(&mut sum, &plane_quadric(normal, [1.0, 2.0, 3.0], 1.0));
        }
        let at = optimal_position(&sum).unwrap();
        assert_eq!(at, [1.0, 2.0, 3.0]);
        assert_eq!(quadric_cost(&sum, at[0], at[1], at[2]), 0.0);
        assert_eq!(quadric_cost(&sum, 2.0, 2.0, 3.0), 1.0);
        let slab = plane_quadric([0.0, 0.0, 1.0], [0.0, 0.0, 0.0], 2.0);
        assert!(optimal_position(&slab).is_none());
    }
}
