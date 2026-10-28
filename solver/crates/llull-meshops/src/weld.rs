//! Vertex welding (twin of `weldMesh` in `weld.ts`): with tolerance 0 vertices with bit-identical coordinates (-0 equals +0) share one index; with a tolerance
//! above 0 a vertex joins the lowest-index earlier vertex within it. The output order is the first use in a traversal of the triangles' corners and vertices no
//! triangle uses are dropped.

use std::collections::HashMap;

pub struct Welded {
    /// Flat xyz of the welded vertices, in first-use order.
    pub positions: Vec<f64>,
    /// Corner indices, same triangle order as the input.
    pub triangles: Vec<u32>,
    /// Input vertices a triangle references minus welded vertices.
    pub merged: usize,
}

/// Weld at `tolerance` (finite, at least 0): 0 merges bit-identical coordinates only. Every index is below the vertex count (the job reader checks).
pub fn weld(positions: &[f64], triangles: &[u32], tolerance: f64) -> Welded {
    if tolerance > 0.0 {
        weld_within(positions, triangles, tolerance)
    } else {
        weld_exact(positions, triangles)
    }
}

/// Weld `positions` / `triangles` at tolerance 0.
pub fn weld_exact(positions: &[f64], triangles: &[u32]) -> Welded {
    let mut remap = vec![u32::MAX; positions.len() / 3];
    let mut welded: Vec<f64> = Vec::new();
    let mut by_coordinates: HashMap<[u64; 3], u32> = HashMap::with_capacity(positions.len() / 6);
    let mut out = Vec::with_capacity(triangles.len());
    let mut referenced = 0usize;
    for &corner in triangles {
        let mut mapped = remap[corner as usize];
        if mapped == u32::MAX {
            referenced += 1;
            let p = &positions[corner as usize * 3..corner as usize * 3 + 3];
            // `+ 0.0` turns -0 into +0, as the strict equality of the TypeScript comparison does; the job reader refuses NaN
            let key = [(p[0] + 0.0).to_bits(), (p[1] + 0.0).to_bits(), (p[2] + 0.0).to_bits()];
            mapped = *by_coordinates.entry(key).or_insert_with(|| {
                welded.extend_from_slice(p);
                (welded.len() / 3 - 1) as u32
            });
            remap[corner as usize] = mapped;
        }
        out.push(mapped);
    }
    let merged = referenced - welded.len() / 3;
    Welded { positions: welded, triangles: out, merged }
}

/// JavaScript `ToInt32` (`x | 0`): the integer part modulo 2^32 as a signed 32-bit value; 0 for NaN and the infinities.
fn to_int32(x: f64) -> i32 {
    if !x.is_finite() {
        return 0;
    }
    (x.trunc() % 4_294_967_296.0).rem_euclid(4_294_967_296.0) as u64 as u32 as i32
}

/// The 32-bit hash of a grid cell that `weld.ts` buckets by (`Math.imul` is a wrapping product). A collision only adds candidates, which the distance test checks.
fn cell_hash(cell: [f64; 3]) -> i32 {
    to_int32(cell[0]).wrapping_mul(0x9e37_79b1_u32 as i32)
        ^ to_int32(cell[1]).wrapping_mul(0x85eb_ca77_u32 as i32)
        ^ to_int32(cell[2]).wrapping_mul(0xc2b2_ae3d_u32 as i32)
}

/// Weld at `tolerance` (finite, above 0): a vertex joins the lowest-index earlier vertex whose squared distance is at most the tolerance squared among the 27
/// cells around its own (cells of the tolerance's size, bucketed by [`cell_hash`] exactly as the TypeScript engine does, so the same candidates are seen).
fn weld_within(positions: &[f64], triangles: &[u32], tolerance: f64) -> Welded {
    let limit = tolerance * tolerance;
    let mut remap = vec![u32::MAX; positions.len() / 3];
    let mut welded: Vec<f64> = Vec::new();
    let mut buckets: HashMap<i32, Vec<u32>> = HashMap::new();
    let mut out = Vec::with_capacity(triangles.len());
    let mut referenced = 0usize;
    for &corner in triangles {
        let mut mapped = remap[corner as usize];
        if mapped == u32::MAX {
            referenced += 1;
            let p = &positions[corner as usize * 3..corner as usize * 3 + 3];
            let cell = [(p[0] / tolerance).floor(), (p[1] / tolerance).floor(), (p[2] / tolerance).floor()];
            let mut best = u32::MAX;
            for di in -1..=1 {
                for dj in -1..=1 {
                    for dk in -1..=1 {
                        let key = cell_hash([cell[0] + f64::from(di), cell[1] + f64::from(dj), cell[2] + f64::from(dk)]);
                        for &candidate in buckets.get(&key).map(Vec::as_slice).unwrap_or_default() {
                            let c = &welded[candidate as usize * 3..candidate as usize * 3 + 3];
                            let (dx, dy, dz) = (c[0] - p[0], c[1] - p[1], c[2] - p[2]);
                            if dx * dx + dy * dy + dz * dz <= limit && candidate < best {
                                best = candidate;
                            }
                        }
                    }
                }
            }
            if best == u32::MAX {
                best = (welded.len() / 3) as u32;
                welded.extend_from_slice(p);
                buckets.entry(cell_hash(cell)).or_default().push(best);
            }
            mapped = best;
            remap[corner as usize] = mapped;
        }
        out.push(mapped);
    }
    let merged = referenced - welded.len() / 3;
    Welded { positions: welded, triangles: out, merged }
}

#[cfg(test)]
mod tests {
    use super::{to_int32, weld, weld_exact};

    #[test]
    fn identical_coordinates_share_a_vertex_in_first_use_order_and_unused_vertices_vanish() {
        // vertices 0 and 3 coincide (one is -0), vertex 2 is unused
        let positions = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 9.0, 9.0, 9.0, -0.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let welded = weld_exact(&positions, &[3, 1, 4, 0, 4, 1]);
        assert_eq!(welded.triangles, [0, 1, 2, 0, 2, 1]);
        assert_eq!(welded.positions, [-0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0]);
        assert_eq!(welded.merged, 1);
    }

    #[test]
    fn to_int32_wraps_like_javascript() {
        assert_eq!(to_int32(2_147_483_648.0), -2_147_483_648);
        assert_eq!(to_int32(4_294_967_297.0), 1);
        assert_eq!(to_int32(-1.5), -1);
        assert_eq!(to_int32(-4_294_967_297.0), -1);
        assert_eq!(to_int32(1e300), 0);
        assert_eq!(to_int32(f64::INFINITY), 0);
        assert_eq!(to_int32(f64::NAN), 0);
        assert_eq!(to_int32(-0.0), 0);
    }

    #[test]
    fn a_tolerance_weld_joins_the_lowest_earlier_vertex_within_reach() {
        // 1 is 0.08 and 2 is 0.05 from vertex 0: both join it (first come wins), 3 is far away
        let positions = [0.0, 0.0, 0.0, 0.08, 0.0, 0.0, 0.05, 0.0, 0.0, 5.0, 5.0, 5.0];
        let welded = weld(&positions, &[0, 1, 2, 2, 3, 0], 0.1);
        assert_eq!(welded.triangles, [0, 0, 0, 0, 1, 0]);
        assert_eq!(welded.positions, [0.0, 0.0, 0.0, 5.0, 5.0, 5.0]);
        assert_eq!(welded.merged, 2);
        // vertex 1 is 0.15 from vertex 0 and stays; vertex 2 is within reach of both and joins the lower one, 0
        let positions = [0.0, 0.0, 0.0, 0.15, 0.0, 0.0, 0.075, 0.0, 0.0];
        assert_eq!(weld(&positions, &[0, 1, 2], 0.1).triangles, [0, 1, 0]);
        // cells far past 2^31 wrap like `| 0`; the distance test still decides
        let far = [4.3e9, 0.0, 0.0, 0.0, 0.0, 0.0];
        assert_eq!(weld(&far, &[0, 1, 0], 1.0).merged, 0);
        // tolerance 0 is the exact weld
        assert_eq!(weld(&positions, &[0, 1, 2], 0.0).merged, 0);
    }
}
