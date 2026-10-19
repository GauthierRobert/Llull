//! Display mesh of a shape, with the closure policy of `packages/kernel-occt/src/occtMesh.ts`: a closed solid whose triangulation
//! comes out open (a face without triangles, a seam gap) is meshed again finer, then refused rather than shown holed.
//! Deviation from the WASM kernel: the finer retry runs for every open solid, not only freeform-heavy or thread-bearing ones.

use crate::{tessellate, MeshOut, OcctResult, Shape};
use std::collections::HashMap;

/// Display deflections: linear (document units), angular (radians) — the WASM kernel's values.
pub const DISPLAY_DEFLECTION: (f64, f64) = (0.1, 0.5);
/// Retry deflections for a closed solid whose display mesh is open.
pub const FINE_DEFLECTION: (f64, f64) = (0.02, 0.2);

/// Weld grid of the closure test: 1e-5 document units (`meshClosure.ts`).
const GRID: f64 = 1e5;

/// JavaScript `Math.round` (half toward +infinity), so the weld cells match `meshClosure.ts`.
fn js_round(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

/// Triangle edges used by exactly one triangle once vertices are welded on the grid shifted by `offset`.
pub fn open_edge_count(positions: &[f64], indices: &[u32], offset: f64) -> usize {
    let mut cells: HashMap<(i64, i64, i64), usize> = HashMap::new();
    let welded: Vec<usize> = positions
        .chunks_exact(3)
        .map(|vertex| {
            let key = (js_round(vertex[0] * GRID + offset), js_round(vertex[1] * GRID + offset), js_round(vertex[2] * GRID + offset));
            let next = cells.len();
            *cells.entry(key).or_insert(next)
        })
        .collect();
    let mut uses: HashMap<(usize, usize), u32> = HashMap::new();
    for triangle in indices.chunks_exact(3) {
        for k in 0..3 {
            let (Some(&a), Some(&b)) = (welded.get(triangle[k] as usize), welded.get(triangle[(k + 1) % 3] as usize)) else { continue };
            if a == b {
                continue;
            }
            *uses.entry((a.min(b), a.max(b))).or_insert(0) += 1;
        }
    }
    uses.values().filter(|&&count| count == 1).count()
}

/// Every triangle edge shared, on either of two weld grids half a cell apart (an empty mesh counts as closed).
pub fn is_closed_mesh(positions: &[f64], indices: &[u32]) -> bool {
    positions.is_empty() || open_edge_count(positions, indices, 0.0) == 0 || open_edge_count(positions, indices, 0.5) == 0
}

fn acceptable(mesh: &MeshOut) -> bool {
    mesh.missing_faces == 0 && is_closed_mesh(&mesh.positions, &mesh.indices)
}

/// Display mesh of `shape`; `None` for an empty triangulation or a closed solid that stays open at the fine deflection.
pub fn display_mesh(shape: &Shape) -> OcctResult<Option<MeshOut>> {
    let first = tessellate(shape, DISPLAY_DEFLECTION.0, DISPLAY_DEFLECTION.1)?;
    if !first.closed_solid || acceptable(&first) {
        return Ok(if first.positions.is_empty() { None } else { Some(first) });
    }
    let fine = tessellate(shape, FINE_DEFLECTION.0, FINE_DEFLECTION.1)?;
    Ok(if acceptable(&fine) { Some(fine) } else { None })
}

#[cfg(test)]
mod tests {
    use super::*;

    const TETRA: [f64; 12] = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];

    #[test]
    fn a_closed_tetrahedron_has_no_open_edge() {
        assert!(is_closed_mesh(&TETRA, &[0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]));
    }

    #[test]
    fn a_missing_triangle_opens_three_edges() {
        assert_eq!(open_edge_count(&TETRA, &[0, 2, 1, 0, 1, 3, 1, 2, 3], 0.0), 3);
        assert!(!is_closed_mesh(&TETRA, &[0, 2, 1, 0, 1, 3, 1, 2, 3]));
    }

    #[test]
    fn rounds_half_up_like_javascript() {
        assert_eq!(js_round(-0.5), 0);
        assert_eq!(js_round(0.5), 1);
        assert_eq!(js_round(-1.5), -1);
    }

    #[test]
    fn meshes_a_box_closed() {
        let shape = crate::make_box([0.0, 0.0, 0.0], [2.0, 2.0, 2.0]).unwrap().unwrap();
        let mesh = display_mesh(&shape).unwrap().unwrap();
        assert_eq!(mesh.indices.len(), 36);
        assert!(is_closed_mesh(&mesh.positions, &mesh.indices));
    }
}
