//! The self-intersection search of `analyze` (twin of `findSelfIntersections` in `selfIntersection.ts`, DES-7c step 7 slice 4): the face pairs that cross each other
//! transversally, counted, with the lowest `max_listed` of them as `[low, high]`.
//!
//! What a pair is does not depend on the broad phase: two faces form a crossing pair when they share no vertex index, their boxes overlap (`<=`, so touching boxes
//! count) and an edge of one passes through the interior of the other (`segmentHitsTriangle`, Moller-Trumbore, ported operation for operation). The TypeScript grid
//! only decides which pairs reach that test, and it reaches every pair whose boxes overlap (the cell range of a box is monotone in the box), so this twin may use
//! another broad phase: a uniform grid of the same cell size, a face looked up in the cells of its own range. Count and listed pairs equal the TypeScript ones bit
//! for bit; the box sizes are added in the TypeScript order only because they size the cells.

use crate::geom::{dot, js_max, js_min, Vec3};
use llull_jsmath::pow;
use rayon::prelude::*;
use std::sync::atomic::{AtomicU64, Ordering};

/// Grid cells one triangle may occupy before it is treated as a large triangle (tested against every other face instead of filling the grid).
const MAX_CELLS_PER_FACE: f64 = 64.0;
/// Candidate pairs (after the grid, before the box test) one search may examine: past it the search ends with [`Costly`] (about 20 s on 22 cores).
pub const CANDIDATE_LIMIT: u64 = 40_000_000_000;
/// `EPSILON` and `END_MARGIN` of `segmentTriangle.ts`.
const EPSILON: f64 = 1e-12;
const END_MARGIN: f64 = 1e-9;
/// Faces handled by one parallel task.
const CHUNK: usize = 512;

type Corners = [Vec3; 3];

#[derive(Debug, PartialEq, Eq)]
pub struct Found {
    pub count: usize,
    /// The lowest `max_listed` pairs, ascending, as `[low, high]`.
    pub pairs: Vec<[usize; 2]>,
}

/// The search would examine more than [`CANDIDATE_LIMIT`] candidate pairs.
#[derive(Debug, PartialEq, Eq)]
pub struct Costly {
    pub candidates: u64,
}

fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/// `segmentHitsTriangle`: the open segment `start`-`end` crosses the interior of the triangle (grazing and end contacts do not count).
fn segment_hits_triangle(start: Vec3, end: Vec3, [a, b, c]: &Corners) -> bool {
    let direction = sub(end, start);
    let edge1 = sub(*b, *a);
    let edge2 = sub(*c, *a);
    let p = cross(direction, edge2);
    let determinant = dot(edge1, p);
    if determinant.abs() < EPSILON * pow(dot(direction, direction), 0.5) * pow(dot(edge1, edge1), 0.5) {
        return false;
    }
    let offset = sub(start, *a);
    let u = dot(offset, p) / determinant;
    if u <= 0.0 || u >= 1.0 {
        return false;
    }
    let q = cross(offset, edge1);
    let v = dot(direction, q) / determinant;
    if v <= 0.0 || u + v >= 1.0 {
        return false;
    }
    let t = dot(edge2, q) / determinant;
    t > END_MARGIN && t < 1.0 - END_MARGIN
}

/// `trianglesCross`: transversal crossings only (coplanar overlaps and pure contacts are not counted).
fn triangles_cross(a: &Corners, b: &Corners) -> bool {
    (0..3).any(|k| segment_hits_triangle(a[k], a[(k + 1) % 3], b) || segment_hits_triangle(b[k], b[(k + 1) % 3], a))
}

/// A mixing hash of a cell; collisions only add candidates, which the box test then rejects.
fn cell_key(cell: [i64; 3]) -> u64 {
    let mut h = 0x9e37_79b9_7f4a_7c15u64;
    for c in cell {
        h ^= c as u64;
        h = h.wrapping_mul(0xff51_afd7_ed55_8ccd);
        h ^= h >> 32;
    }
    h
}

struct Index {
    faces: Vec<Corners>,
    triangles: Vec<[u32; 3]>,
    /// min xyz, max xyz of each face.
    boxes: Vec<[f64; 6]>,
    /// (cell key, face) of every face in the grid, ascending.
    entries: Vec<(u64, u32)>,
    /// Cell range of every face in the grid: low and high corner.
    ranges: Vec<([i64; 3], [i64; 3])>,
    large: Vec<u32>,
    is_large: Vec<bool>,
}

fn overlaps(a: &[f64; 6], b: &[f64; 6]) -> bool {
    (0..3).all(|axis| a[axis] <= b[axis + 3] && b[axis] <= a[axis + 3])
}

fn build(positions: &[f64], triangles: &[u32]) -> Index {
    let corner = |v: u32| -> Vec3 { [positions[v as usize * 3], positions[v as usize * 3 + 1], positions[v as usize * 3 + 2]] };
    let tri: Vec<[u32; 3]> = triangles.chunks_exact(3).map(|t| [t[0], t[1], t[2]]).collect();
    let faces: Vec<Corners> = tri.par_iter().map(|t| [corner(t[0]), corner(t[1]), corner(t[2])]).collect();
    let boxes: Vec<[f64; 6]> = faces
        .par_iter()
        .map(|c| {
            let mut b = [0.0; 6];
            for axis in 0..3 {
                b[axis] = js_min(js_min(c[0][axis], c[1][axis]), c[2][axis]);
                b[axis + 3] = js_max(js_max(c[0][axis], c[1][axis]), c[2][axis]);
            }
            b
        })
        .collect();
    let (mut size_sum, mut lo) = (0.0, [f64::INFINITY; 3]);
    for b in &boxes {
        for axis in 0..3 {
            size_sum += b[axis + 3] - b[axis];
            lo[axis] = js_min(lo[axis], b[axis]);
        }
    }
    let n = faces.len();
    let cell = if n > 0 && size_sum > 0.0 { (size_sum / (n as f64 * 3.0)) * 2.0 } else { 1.0 };
    // the cell range of every face; a face over MAX_CELLS_PER_FACE cells is large
    let spans: Vec<([f64; 3], [f64; 3])> = boxes
        .par_iter()
        .map(|b| (std::array::from_fn(|a| ((b[a] - lo[a]) / cell).floor()), std::array::from_fn(|a| ((b[a + 3] - lo[a]) / cell).floor())))
        .collect();
    let is_large: Vec<bool> =
        spans.par_iter().map(|(l, h)| (h[0] - l[0] + 1.0) * (h[1] - l[1] + 1.0) * (h[2] - l[2] + 1.0) > MAX_CELLS_PER_FACE).collect();
    let large: Vec<u32> = (0..n as u32).filter(|&f| is_large[f as usize]).collect();
    // a small face spans at most 64 cells, so the casts below keep every difference of the range exact (a huge index saturates to the same cell)
    let ranges: Vec<([i64; 3], [i64; 3])> = spans.iter().map(|(l, h)| (l.map(|v| v as i64), h.map(|v| v as i64))).collect();
    let mut entries: Vec<(u64, u32)> = Vec::new();
    for (f, (l, h)) in ranges.iter().enumerate() {
        if is_large[f] {
            continue;
        }
        for i in l[0]..=h[0] {
            for j in l[1]..=h[1] {
                for k in l[2]..=h[2] {
                    entries.push((cell_key([i, j, k]), f as u32));
                }
            }
        }
    }
    entries.par_sort_unstable();
    Index { faces, triangles: tri, boxes, entries, ranges, large, is_large }
}

impl Index {
    /// The grid faces (ascending, once each) that share a cell with the small face `x` and are above it.
    fn above_in_grid(&self, x: usize, out: &mut Vec<u32>) {
        out.clear();
        let (l, h) = self.ranges[x];
        for i in l[0]..=h[0] {
            for j in l[1]..=h[1] {
                for k in l[2]..=h[2] {
                    let key = cell_key([i, j, k]);
                    let start = self.entries.partition_point(|e| e.0 < key);
                    out.extend(self.entries[start..].iter().take_while(|e| e.0 == key).map(|e| e.1).filter(|&y| y as usize > x));
                }
            }
        }
        out.sort_unstable();
        out.dedup();
    }

    /// True when faces `x` and `y` are a crossing pair.
    fn crosses(&self, x: usize, y: usize) -> bool {
        let (a, b) = (&self.triangles[x], &self.triangles[y]);
        let shares = a.iter().any(|v| b.contains(v));
        !shares && overlaps(&self.boxes[x], &self.boxes[y]) && triangles_cross(&self.faces[x], &self.faces[y])
    }
}

/// Pairs of `[low, high]` kept sorted and bounded by `limit`.
fn keep_lowest(pairs: &mut Vec<[usize; 2]>, limit: usize) {
    if pairs.len() > limit {
        pairs.sort_unstable();
        pairs.truncate(limit);
    }
}

/// The crossing face pairs of `triangles` (indices into `positions`, finite coordinates): their number and the lowest `max_listed`; [`Costly`] past `limit` candidate pairs (normally [`CANDIDATE_LIMIT`]).
pub fn find_self_intersections(positions: &[f64], triangles: &[u32], max_listed: usize, limit: u64) -> Result<Found, Costly> {
    let index = build(positions, triangles);
    let n = index.faces.len();
    // every small face meets every large one; two large faces meet once
    let work = index.large.len() as u64 * n as u64;
    if work > limit {
        return Err(Costly { candidates: work });
    }
    let examined = AtomicU64::new(0);
    let starts: Vec<usize> = (0..n).step_by(CHUNK).collect();
    let chunks: Vec<(usize, Vec<[usize; 2]>)> = starts
        .par_iter()
        .map(|&start| {
            let (mut count, mut pairs, mut near) = (0usize, Vec::new(), Vec::new());
            for x in start..(start + CHUNK).min(n) {
                if examined.load(Ordering::Relaxed) > limit {
                    break;
                }
                let mut tested = 0u64;
                let mut test = |y: usize, pairs: &mut Vec<[usize; 2]>, count: &mut usize| {
                    tested += 1;
                    if index.crosses(x, y) {
                        *count += 1;
                        pairs.push([x.min(y), x.max(y)]);
                    }
                };
                if index.is_large[x] {
                    for &y in index.large.iter().filter(|&&y| y as usize > x) {
                        test(y as usize, &mut pairs, &mut count);
                    }
                } else {
                    index.above_in_grid(x, &mut near);
                    for &y in &near {
                        test(y as usize, &mut pairs, &mut count);
                    }
                    for &y in &index.large {
                        test(y as usize, &mut pairs, &mut count);
                    }
                }
                examined.fetch_add(tested, Ordering::Relaxed);
                keep_lowest(&mut pairs, (2 * max_listed).max(16));
            }
            keep_lowest(&mut pairs, max_listed);
            pairs.sort_unstable();
            pairs.truncate(max_listed);
            (count, pairs)
        })
        .collect();
    let total = examined.load(Ordering::Relaxed);
    if total > limit {
        return Err(Costly { candidates: total });
    }
    let count = chunks.iter().map(|c| c.0).sum();
    let mut pairs: Vec<[usize; 2]> = chunks.into_iter().flat_map(|c| c.1).collect();
    pairs.sort_unstable();
    pairs.truncate(max_listed);
    Ok(Found { count, pairs })
}

#[cfg(test)]
mod tests {
    use super::{find_self_intersections, Found, CANDIDATE_LIMIT};

    /// Two triangles crossing like a plus sign, a third far away.
    #[test]
    fn a_plus_of_two_triangles_is_one_pair() {
        let positions = [
            0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 1.0, 0.0, 2.0, // in the xz plane
            1.0, -1.0, 0.5, 1.0, 1.0, 0.5, 1.0, 0.0, 3.0, // in the plane x = 1
            50.0, 0.0, 0.0, 51.0, 0.0, 0.0, 50.0, 1.0, 0.0,
        ];
        let found = find_self_intersections(&positions, &[0, 1, 2, 3, 4, 5, 6, 7, 8], 5, CANDIDATE_LIMIT).unwrap();
        assert_eq!(found, Found { count: 1, pairs: vec![[0, 1]] });
        assert_eq!(
            find_self_intersections(&positions, &[0, 1, 2, 3, 4, 5, 6, 7, 8], 0, CANDIDATE_LIMIT).unwrap(),
            Found { count: 1, pairs: vec![] }
        );
        assert_eq!(find_self_intersections(&[], &[], 5, CANDIDATE_LIMIT).unwrap(), Found { count: 0, pairs: vec![] });
    }
}
