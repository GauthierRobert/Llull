//! What a stroke reports (twins of `signedVolume`, `heightFieldVolume`, `isClosed` and `symmetryErrorOf` of `sculpt.ts`). The per-face terms are computed in
//! parallel and added in face order, so the sums equal the sequential TypeScript ones bit for bit whatever the thread count.

use crate::geom::{dot, js_max, length, Vec3};
use crate::sculpt_brush::Plane;
use llull_jsmath::round;
use rayon::prelude::*;

fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/// `mirror`: the point reflected in `plane` (yz negates x, xz y, xy z).
pub fn mirror(v: Vec3, plane: Plane) -> Vec3 {
    let axis = plane.axis();
    [if axis == 0 { -v[0] } else { v[0] }, if axis == 1 { -v[1] } else { v[1] }, if axis == 2 { -v[2] } else { v[2] }]
}

/// `signedVolume`: the sum of `a . (b x c) / 6` over the faces in order.
pub fn signed_volume(positions: &[Vec3], indices: &[u32]) -> f64 {
    let terms: Vec<f64> = indices
        .par_chunks_exact(3)
        .map(|t| {
            let (a, b, c) = (positions[t[0] as usize], positions[t[1] as usize], positions[t[2] as usize]);
            dot(a, cross(b, c)) / 6.0
        })
        .collect();
    terms.iter().fold(0.0, |sum, term| sum + term)
}

/// `heightFieldVolume`: the area of each face times the mean displacement of its corners along its unit normal, summed in face order (faces of area 0 add nothing).
pub fn height_field_volume(before: &[Vec3], after: &[Vec3], indices: &[u32]) -> f64 {
    let terms: Vec<Option<f64>> = indices
        .par_chunks_exact(3)
        .map(|t| {
            let p = [before[t[0] as usize], before[t[1] as usize], before[t[2] as usize]];
            let n = cross(sub(p[1], p[0]), sub(p[2], p[0]));
            let twice_area = length(n);
            if twice_area == 0.0 {
                return None;
            }
            let nu = if twice_area > 0.0 { [n[0] / twice_area, n[1] / twice_area, n[2] / twice_area] } else { [0.0, 0.0, 0.0] };
            let mut mean = 0.0;
            for k in 0..3 {
                mean += dot(sub(after[t[k] as usize], p[k]), nu) / 3.0;
            }
            Some((twice_area / 2.0) * mean)
        })
        .collect();
    terms.into_iter().flatten().fold(0.0, |total, term| total + term)
}

/// `isClosed`: at least one edge and every edge (low, high corner) used by exactly two corner pairs.
pub fn is_closed(indices: &[u32]) -> bool {
    let mut keys: Vec<u64> = Vec::with_capacity(indices.len());
    for t in indices.chunks_exact(3) {
        for k in 0..3 {
            let (a, b) = (t[k], t[(k + 1) % 3]);
            keys.push((u64::from(a.min(b)) << 32) | u64::from(a.max(b)));
        }
    }
    keys.par_sort_unstable();
    !keys.is_empty() && keys.chunk_by(|x, y| x == y).all(|run| run.len() == 2)
}

/// The grid cell of a point as `cell` of `symmetryErrorOf` builds it: each coordinate over `tolerance`, rounded as `Math.round`. The text key of the TypeScript
/// code makes -0 equal 0 and NaN equal NaN, which the bit patterns below do too.
fn cell(p: Vec3, tolerance: f64) -> [u64; 3] {
    p.map(|c| {
        let cell = round(c / tolerance);
        if cell.is_nan() {
            f64::NAN.to_bits()
        } else {
            (cell + 0.0).to_bits()
        }
    })
}

/// `symmetryErrorOf`: the largest distance between a vertex of `positions` and the mirror of its partner, the vertex of `input` (the last one in vertex order) at the
/// mirrored position of the input; `None` without a pair.
pub fn symmetry_error(input: &[Vec3], positions: &[Vec3], plane: Plane, tolerance: f64) -> Option<f64> {
    let mut buckets: Vec<([u64; 3], u32)> = input.iter().enumerate().map(|(v, &p)| (cell(p, tolerance), v as u32)).collect();
    buckets.par_sort_unstable();
    input
        .par_iter()
        .enumerate()
        .filter_map(|(v, &original)| {
            let key = cell(mirror(original, plane), tolerance);
            let at = buckets.partition_point(|entry| entry.0 <= key);
            let (found, partner) = *buckets.get(at.checked_sub(1)?)?;
            if found != key {
                return None;
            }
            let (a, b) = (positions[v], mirror(positions[partner as usize], plane));
            Some(length(sub(a, b)))
        })
        .reduce_with(js_max)
        .map(|worst| js_max(0.0, worst))
}
