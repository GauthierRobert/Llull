//! Display mesh of a shape, with the closure policy of the retired opencascade.js kernel (occtMesh.ts): a closed solid whose triangulation
//! comes out open (a face without triangles, a seam gap) is meshed again finer, then refused rather than shown holed.
//! Deviation from that policy: the finer retry runs for every open solid, not only freeform-heavy or thread-bearing ones.

use crate::{bounding_diagonal, tessellate, MeshOut, OcctResult, Shape};
use std::collections::HashMap;

/// Display deflections: linear (document units), angular (radians) — the retired kernel's values.
pub const DISPLAY_DEFLECTION: (f64, f64) = (0.1, 0.5);
/// Retry deflections for a closed solid whose display mesh is open.
pub const FINE_DEFLECTION: (f64, f64) = (0.02, 0.2);

/// Diagonal (document units) up to which a part keeps the linear floor; above it the deflection is `floor x diagonal / KNEE_DIAGONAL`, i.e. 1e-3 of the
/// diagonal at the display floor (0.1), 2e-4 at the fine retry (0.02). The constant is in document units whatever they are: a metre document starts
/// scaling at a 100 m diagonal. Small parts mesh exactly as before.
const KNEE_DIAGONAL: f64 = 100.0;
/// Diagonals above this are treated as unbounded (an open box reads as 1e100): the floor is kept.
const MAX_DIAGONAL: f64 = 1e12;
/// Largest ratio of the bounding-box diagonal to an explicit linear deflection a host may ask for (about 1.7 triangles per unit of it on a sphere): beyond it the
/// request is refused with `NATIVE_TESSELLATION_BUDGET`. The TypeScript side (`geometry/exactMesh.ts`) states the same number.
pub const MAX_DIAGONAL_PER_DEFLECTION: f64 = 1e6;

/// Linear deflection for a shape whose bounding box has the given diagonal; the floor for a non-finite or unbounded one.
pub fn scaled_linear(floor: f64, diagonal: f64) -> f64 {
    if diagonal.is_finite() && diagonal <= MAX_DIAGONAL {
        floor.max(floor * diagonal / KNEE_DIAGONAL)
    } else {
        floor
    }
}

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

/// Display mesh of `shape` at the deflection scaled with its size; `None` for an empty triangulation or a closed solid that stays open at the fine deflection.
pub fn display_mesh(shape: &Shape) -> OcctResult<Option<MeshOut>> {
    let diagonal = bounding_diagonal(shape)?;
    mesh_with(
        shape,
        (scaled_linear(DISPLAY_DEFLECTION.0, diagonal), DISPLAY_DEFLECTION.1),
        (scaled_linear(FINE_DEFLECTION.0, diagonal), FINE_DEFLECTION.1),
    )
}

/// Mesh of `shape` at the absolute deflections the caller asked for (document units, radians), without the size scaling; an open closed-solid mesh is
/// retried at 0.2 x the linear and 0.4 x the angular deflection, the ratios of the display retry.
pub fn mesh_at(shape: &Shape, linear: f64, angular: f64) -> OcctResult<Option<MeshOut>> {
    mesh_with(shape, (linear, angular), (linear * 0.2, angular * 0.4))
}

fn mesh_with(shape: &Shape, first: (f64, f64), fine: (f64, f64)) -> OcctResult<Option<MeshOut>> {
    let coarse = tessellate(shape, first.0, first.1)?;
    if !coarse.closed_solid || acceptable(&coarse) {
        return Ok(if coarse.positions.is_empty() { None } else { Some(coarse) });
    }
    let retry = tessellate(shape, fine.0, fine.1)?;
    Ok(if acceptable(&retry) { Some(retry) } else { None })
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
