//! Exact vertex welding (twin of `weldMesh(mesh, 0)` in `weld.ts`): vertices with bit-identical coordinates (-0 equals +0) share one index; the output order is
//! the first use in a traversal of the triangles' corners and vertices no triangle uses are dropped.

use std::collections::HashMap;

pub struct Welded {
    /// Flat xyz of the welded vertices, in first-use order.
    pub positions: Vec<f64>,
    /// Corner indices, same triangle order as the input.
    pub triangles: Vec<u32>,
    /// Input vertices a triangle references minus welded vertices.
    pub merged: usize,
}

/// Weld `positions` / `triangles` (every index below the vertex count: the job reader checks).
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

#[cfg(test)]
mod tests {
    use super::weld_exact;

    #[test]
    fn identical_coordinates_share_a_vertex_in_first_use_order_and_unused_vertices_vanish() {
        // vertices 0 and 3 coincide (one is -0), vertex 2 is unused
        let positions = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 9.0, 9.0, 9.0, -0.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        let welded = weld_exact(&positions, &[3, 1, 4, 0, 4, 1]);
        assert_eq!(welded.triangles, [0, 1, 2, 0, 2, 1]);
        assert_eq!(welded.positions, [-0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0]);
        assert_eq!(welded.merged, 1);
    }
}
