//! Tetrahedron and triangle queries, ports of `closestPointOnTriangle` (`@core/geometry/triangleQueries`) and of `barycentric` /
//! `closestOnTet` (`thermomech/mapping.ts`), same expression order.

use crate::Vec3;
use llull_jsmath::hypot;

/// Barycentric slack that still counts as inside a tetrahedron (a point on a shared face).
pub const INSIDE: f64 = 1e-9;

fn sub(a: &Vec3, b: &Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn add(a: &Vec3, b: &Vec3) -> Vec3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn scale(a: &Vec3, s: f64) -> Vec3 {
    [a[0] * s, a[1] * s, a[2] * s]
}

fn dot(a: &Vec3, b: &Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn cross(a: &Vec3, b: &Vec3) -> Vec3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/// Distance between two points (V8 `Math.hypot` of the difference).
pub fn distance(a: &Vec3, b: &Vec3) -> f64 {
    let d = sub(a, b);
    hypot(&d)
}

/// Closest point of triangle `[a, b, c]` to `p` (Ericson 5.1.5).
pub fn closest_point_on_triangle(p: &Vec3, [a, b, c]: [&Vec3; 3]) -> Vec3 {
    let ab = sub(b, a);
    let ac = sub(c, a);
    let ap = sub(p, a);
    let d1 = dot(&ab, &ap);
    let d2 = dot(&ac, &ap);
    if d1 <= 0.0 && d2 <= 0.0 {
        return *a;
    }
    let bp = sub(p, b);
    let d3 = dot(&ab, &bp);
    let d4 = dot(&ac, &bp);
    if d3 >= 0.0 && d4 <= d3 {
        return *b;
    }
    let vc = d1 * d4 - d3 * d2;
    if vc <= 0.0 && d1 >= 0.0 && d3 <= 0.0 {
        return add(a, &scale(&ab, d1 / (d1 - d3)));
    }
    let cp = sub(p, c);
    let d5 = dot(&ab, &cp);
    let d6 = dot(&ac, &cp);
    if d6 >= 0.0 && d5 <= d6 {
        return *c;
    }
    let vb = d5 * d2 - d1 * d6;
    if vb <= 0.0 && d2 >= 0.0 && d6 <= 0.0 {
        return add(a, &scale(&ac, d2 / (d2 - d6)));
    }
    let va = d3 * d6 - d5 * d4;
    if va <= 0.0 && d4 - d3 >= 0.0 && d5 - d6 >= 0.0 {
        return add(b, &scale(&sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6))));
    }
    let denominator = 1.0 / (va + vb + vc);
    add(a, &add(&scale(&ab, vb * denominator), &scale(&ac, vc * denominator)))
}

/// Barycentric coordinates of `p` in tetrahedron `c` (`None` for a degenerate one).
pub fn barycentric(c: &[Vec3; 4], p: &Vec3) -> Option<[f64; 4]> {
    let a = sub(&c[1], &c[0]);
    let b = sub(&c[2], &c[0]);
    let d = sub(&c[3], &c[0]);
    let det = dot(&a, &cross(&b, &d));
    if !det.is_finite() || det.abs() < 1e-300 {
        return None;
    }
    let q = sub(p, &c[0]);
    let l1 = dot(&q, &cross(&b, &d)) / det;
    let l2 = dot(&a, &cross(&q, &d)) / det;
    let l3 = dot(&a, &cross(&b, &q)) / det;
    Some([1.0 - l1 - l2 - l3, l1, l2, l3])
}

const FACES: [[usize; 3]; 4] = [[0, 1, 2], [0, 3, 1], [1, 3, 2], [2, 3, 0]];

/// Closest point of the closed tetrahedron to `p` and its distance (0 and `p` itself inside, within `INSIDE`).
pub fn closest_on_tet(c: &[Vec3; 4], p: &Vec3) -> (f64, Vec3) {
    if let Some(inside) = barycentric(c, p) {
        if inside.iter().all(|&l| l >= -INSIDE) {
            return (0.0, *p);
        }
    }
    let mut best = c[0];
    let mut best_distance = f64::INFINITY;
    for [i, j, k] in FACES {
        let point = closest_point_on_triangle(p, [&c[i], &c[j], &c[k]]);
        let gap = distance(p, &point);
        if gap < best_distance {
            best = point;
            best_distance = gap;
        }
    }
    (best_distance, best)
}

#[cfg(test)]
mod tests {
    use super::*;

    const TET: [Vec3; 4] = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

    #[test]
    fn inside_and_outside_points() {
        assert_eq!(closest_on_tet(&TET, &[0.1, 0.1, 0.1]), (0.0, [0.1, 0.1, 0.1]));
        let (gap, point) = closest_on_tet(&TET, &[0.2, 0.2, -1.0]);
        assert_eq!(gap, 1.0);
        assert!(distance(&point, &[0.2, 0.2, 0.0]) < 1e-15);
        assert_eq!(closest_on_tet(&TET, &[-1.0, -1.0, -1.0]).1, [0.0, 0.0, 0.0]);
        let coords = barycentric(&TET, &[0.25, 0.25, 0.25]).unwrap();
        assert_eq!(coords, [0.25, 0.25, 0.25, 0.25]);
        assert!(barycentric(&[[0.0; 3]; 4], &[0.0; 3]).is_none());
    }

    #[test]
    fn triangle_regions() {
        let (a, b, c) = ([0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]);
        let tri = [&a, &b, &c];
        assert_eq!(closest_point_on_triangle(&[-1.0, -1.0, 0.0], tri), a);
        assert_eq!(closest_point_on_triangle(&[2.0, -0.5, 0.0], tri), b);
        assert_eq!(closest_point_on_triangle(&[-0.5, 2.0, 0.0], tri), c);
        assert_eq!(closest_point_on_triangle(&[0.5, -1.0, 0.0], tri), [0.5, 0.0, 0.0]);
        assert_eq!(closest_point_on_triangle(&[-1.0, 0.5, 0.0], tri), [0.0, 0.5, 0.0]);
        assert_eq!(closest_point_on_triangle(&[1.0, 1.0, 0.0], tri), [0.5, 0.5, 0.0]);
        assert_eq!(closest_point_on_triangle(&[0.25, 0.25, 3.0], tri), [0.25, 0.25, 0.0]);
    }
}
