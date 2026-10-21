//! Triangle primitives, transliterated from `packages/core/src/geometry/triangleQueries.ts` and `lib/segmentTriangle.ts`: same formulas
//! and the same evaluation order, so every result is bit-identical to the TypeScript (Rust does not contract `a * b + c` into an FMA).

pub type Vec3 = [f64; 3];
pub type Triangle = [Vec3; 3];

/// A closest pair: distance and the witness points on the first and second geometry.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClosestPair {
    pub distance: f64,
    pub point_a: Vec3,
    pub point_b: Vec3,
}

#[inline]
pub fn sub(a: &Vec3, b: &Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

#[inline]
pub fn add(a: &Vec3, b: &Vec3) -> Vec3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

#[inline]
pub fn scale(a: &Vec3, s: f64) -> Vec3 {
    [a[0] * s, a[1] * s, a[2] * s]
}

#[inline]
pub fn dot(a: &Vec3, b: &Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

#[inline]
pub fn cross(a: &Vec3, b: &Vec3) -> Vec3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

#[inline]
pub fn length(a: &Vec3) -> f64 {
    dot(a, a).sqrt()
}

/// ECMAScript `Math.min` of two non-NaN numbers (-0 below +0).
#[inline]
pub fn js_min(a: f64, b: f64) -> f64 {
    if a < b || (a == b && a.is_sign_negative()) {
        a
    } else {
        b
    }
}

/// ECMAScript `Math.max` of two non-NaN numbers (+0 above -0).
#[inline]
pub fn js_max(a: f64, b: f64) -> f64 {
    if a > b || (a == b && b.is_sign_negative()) {
        a
    } else {
        b
    }
}

/// Closest point of triangle `abc` to `p` (Ericson 5.1.5).
pub fn closest_point_on_triangle(p: &Vec3, [a, b, c]: &Triangle) -> Vec3 {
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
        return add(b, &scale(&sub(c, b), (d4 - d3) / (d4 - d3 + (d5 - d6))));
    }
    let denominator = 1.0 / (va + vb + vc);
    add(a, &add(&scale(&ab, vb * denominator), &scale(&ac, vc * denominator)))
}

/// The TS `clamp01` (`f64::clamp` keeps NaN and -0 the same way).
fn clamp01(value: f64) -> f64 {
    value.clamp(0.0, 1.0)
}

/// Closest points between segments `p1q1` and `p2q2` (Ericson 5.1.9).
pub fn closest_points_of_segments(p1: &Vec3, q1: &Vec3, p2: &Vec3, q2: &Vec3) -> ClosestPair {
    let d1 = sub(q1, p1);
    let d2 = sub(q2, p2);
    let r = sub(p1, p2);
    let a = dot(&d1, &d1);
    let e = dot(&d2, &d2);
    let f = dot(&d2, &r);
    let mut s = 0.0;
    let mut t = 0.0;
    if a <= 1e-300 && e <= 1e-300 {
        // both segments are points: s = t = 0
    } else if a <= 1e-300 {
        t = clamp01(f / e);
    } else {
        let c = dot(&d1, &r);
        if e <= 1e-300 {
            s = clamp01(-c / a);
        } else {
            let b = dot(&d1, &d2);
            let denominator = a * e - b * b;
            s = if denominator > 1e-300 { clamp01((b * f - c * e) / denominator) } else { 0.0 };
            t = (b * s + f) / e;
            if t < 0.0 {
                t = 0.0;
                s = clamp01(-c / a);
            } else if t > 1.0 {
                t = 1.0;
                s = clamp01((b - c) / a);
            }
        }
    }
    let point_a = add(p1, &scale(&d1, s));
    let point_b = add(p2, &scale(&d2, t));
    let delta = sub(&point_a, &point_b);
    ClosestPair { distance: dot(&delta, &delta).sqrt(), point_a, point_b }
}

/// Point where segment `pq` pierces the plane interior of the triangle (non-coplanar crossing only).
#[allow(clippy::manual_range_contains)] // the TS comparisons, NaN behaviour included
pub fn segment_pierces_triangle(p: &Vec3, q: &Vec3, [a, b, c]: &Triangle) -> Option<Vec3> {
    let normal = cross(&sub(b, a), &sub(c, a));
    let direction = sub(q, p);
    let denominator = dot(&normal, &direction);
    if denominator == 0.0 {
        return None;
    }
    let t = dot(&normal, &sub(a, p)) / denominator;
    if t < 0.0 || t > 1.0 {
        return None;
    }
    let point = add(p, &scale(&direction, t));
    let slack = -1e-12 * dot(&normal, &normal);
    let inside = dot(&cross(&sub(b, a), &sub(&point, a)), &normal) >= slack
        && dot(&cross(&sub(c, b), &sub(&point, b)), &normal) >= slack
        && dot(&cross(&sub(a, c), &sub(&point, c)), &normal) >= slack;
    inside.then_some(point)
}

fn edges(t: &Triangle) -> [(Vec3, Vec3); 3] {
    [(t[0], t[1]), (t[1], t[2]), (t[2], t[0])]
}

/// Minimum distance between two triangles with witness points; 0 (witness = the crossing point) when they intersect. Same candidate order
/// as the TypeScript: piercing edges of `first`, of `second`, edge-edge pairs, vertex-triangle pairs; the first strictly smaller wins.
pub fn triangle_distance(first: &Triangle, second: &Triangle) -> ClosestPair {
    for (p, q) in edges(first) {
        if let Some(hit) = segment_pierces_triangle(&p, &q, second) {
            return ClosestPair { distance: 0.0, point_a: hit, point_b: hit };
        }
    }
    for (p, q) in edges(second) {
        if let Some(hit) = segment_pierces_triangle(&p, &q, first) {
            return ClosestPair { distance: 0.0, point_a: hit, point_b: hit };
        }
    }
    let mut best: Option<ClosestPair> = None;
    let mut consider = |candidate: ClosestPair| {
        if best.is_none_or(|b| candidate.distance < b.distance) {
            best = Some(candidate);
        }
    };
    for (p1, q1) in edges(first) {
        for (p2, q2) in edges(second) {
            consider(closest_points_of_segments(&p1, &q1, &p2, &q2));
        }
    }
    for vertex in first {
        let on_second = closest_point_on_triangle(vertex, second);
        let delta = sub(vertex, &on_second);
        consider(ClosestPair { distance: dot(&delta, &delta).sqrt(), point_a: *vertex, point_b: on_second });
    }
    for vertex in second {
        let on_first = closest_point_on_triangle(vertex, first);
        let delta = sub(vertex, &on_first);
        consider(ClosestPair { distance: dot(&delta, &delta).sqrt(), point_a: on_first, point_b: *vertex });
    }
    best.unwrap_or(ClosestPair { distance: f64::INFINITY, point_a: first[0], point_b: second[0] })
}

/// Ray parameter of the double-sided hit of `origin + t direction` with the triangle, t in [t_min, t_max] (Möller-Trumbore).
#[allow(clippy::manual_range_contains)] // the TS comparisons, NaN behaviour included
pub fn ray_triangle_distance(origin: &Vec3, direction: &Vec3, [a, b, c]: &Triangle, t_min: f64, t_max: f64) -> Option<f64> {
    let edge1 = sub(b, a);
    let edge2 = sub(c, a);
    let h = cross(direction, &edge2);
    let determinant = dot(&edge1, &h);
    if determinant.abs() < 1e-300 {
        return None;
    }
    let inverse = 1.0 / determinant;
    let s = sub(origin, a);
    let u = inverse * dot(&s, &h);
    if u < -1e-12 || u > 1.0 + 1e-12 {
        return None;
    }
    let q = cross(&s, &edge1);
    let v = inverse * dot(direction, &q);
    if v < -1e-12 || u + v > 1.0 + 1e-12 {
        return None;
    }
    let t = inverse * dot(&edge2, &q);
    (t >= t_min && t <= t_max).then_some(t)
}

/// True when the open segment `start`..`end` crosses the interior of the triangle (grazing and end contacts do not count).
pub fn segment_hits_triangle(start: &Vec3, end: &Vec3, [a, b, c]: &Triangle) -> bool {
    const EPSILON: f64 = 1e-12;
    const END_MARGIN: f64 = 1e-9;
    let direction = sub(end, start);
    let edge1 = sub(b, a);
    let edge2 = sub(c, a);
    let p = cross(&direction, &edge2);
    let determinant = dot(&edge1, &p);
    // TS `x ** 0.5` is V8 pow, which returns sqrt(x) for y = 0.5 and x >= 0 (fdlibm special case)
    if determinant.abs() < EPSILON * dot(&direction, &direction).sqrt() * dot(&edge1, &edge1).sqrt() {
        return false;
    }
    let offset = sub(start, a);
    let u = dot(&offset, &p) / determinant;
    if u <= 0.0 || u >= 1.0 {
        return false;
    }
    let q = cross(&offset, &edge1);
    let v = dot(&direction, &q) / determinant;
    if v <= 0.0 || u + v >= 1.0 {
        return false;
    }
    let t = dot(&edge2, &q) / determinant;
    t > END_MARGIN && t < 1.0 - END_MARGIN
}

#[cfg(test)]
mod tests {
    use super::*;

    const UNIT: Triangle = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];

    #[test]
    fn parallel_triangles_are_their_gap_apart() {
        let above: Triangle = [[0.0, 0.0, 2.0], [1.0, 0.0, 2.0], [0.0, 1.0, 2.0]];
        assert_eq!(triangle_distance(&UNIT, &above).distance, 2.0);
    }

    #[test]
    fn crossing_triangles_have_zero_distance() {
        let through: Triangle = [[0.2, 0.2, -1.0], [0.2, 0.2, 1.0], [0.3, 0.25, 1.0]];
        let pair = triangle_distance(&UNIT, &through);
        assert_eq!(pair.distance, 0.0);
        assert_eq!(pair.point_a, pair.point_b);
    }

    #[test]
    fn rays_and_segments_hit_the_interior_only() {
        assert_eq!(ray_triangle_distance(&[0.2, 0.2, 1.0], &[0.0, 0.0, -1.0], &UNIT, 0.0, 10.0), Some(1.0));
        assert_eq!(ray_triangle_distance(&[0.2, 0.2, 1.0], &[0.0, 0.0, 1.0], &UNIT, 0.0, 10.0), None);
        assert!(segment_hits_triangle(&[0.2, 0.2, 1.0], &[0.2, 0.2, -1.0], &UNIT));
        assert!(!segment_hits_triangle(&[0.2, 0.2, 1.0], &[0.2, 0.2, 0.0], &UNIT));
        assert!(!segment_hits_triangle(&[2.0, 2.0, 1.0], &[2.0, 2.0, -1.0], &UNIT));
    }

    #[test]
    fn closest_point_regions_and_js_min_max() {
        assert_eq!(closest_point_on_triangle(&[-1.0, -1.0, 0.0], &UNIT), [0.0, 0.0, 0.0]);
        assert_eq!(closest_point_on_triangle(&[0.5, -1.0, 0.0], &UNIT), [0.5, 0.0, 0.0]);
        assert_eq!(closest_point_on_triangle(&[0.25, 0.25, 3.0], &UNIT), [0.25, 0.25, 0.0]);
        assert_eq!(js_min(0.0, -0.0).to_bits(), (-0.0f64).to_bits());
        assert_eq!(js_max(-0.0, 0.0).to_bits(), 0.0f64.to_bits());
    }
}
