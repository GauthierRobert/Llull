//! The element-by-element product `y = Σ_e A_e u_e` shared by [`crate::operator::Operator`] and
//! [`crate::galerkin::ElementMatrices`], as a two-colour scatter over element slabs.
//!
//! A slab is one element layer along the last axis (an element row in 2D, an element plane in 3D); slab `s` touches node
//! layers `s` and `s + 1` only. Colour 0 runs the even slabs in parallel, then colour 1 the odd ones: within a colour the
//! slabs write disjoint node layers, each slab is one sequential task (elements in index order, local nodes in local order),
//! so every node sums its contributions in the same order for any thread count (colour 0 first, then colour 1). No
//! per-element product buffer and no separate gather pass; an element row is walked with the 2 (2D) or 4 (3D) node rows it
//! touches cut out as slices. Element vectors are in row order ([`ROW_ORDER`]): the element's nodes as they lie in memory, so
//! `u_e` is read and `A_e u_e` added back as 2 (2D) or 4 (3D) contiguous runs.

use crate::grid::Grid;
use crate::real::Real;
use rayon::prelude::*;

/// Row order of the element nodes: position `p` holds local node `ROW_ORDER[p]` ([`crate::grid::LOCAL_NODES`] numbering;
/// 2D uses the first four). It swaps the two nodes of each upper row, so it is its own inverse.
pub const ROW_ORDER: [usize; 8] = [0, 1, 3, 2, 4, 5, 7, 6];

/// The local element DOF (LOCAL_NODES order, `dim` DOFs per node) at row-order position `d`, and back (an involution).
pub fn local_dof(d: usize, dim: usize) -> usize {
    ROW_ORDER[d / dim] * dim + d % dim
}

/// `y = Σ_e A_e u_e` on the free DOFs of a 2D grid, 0 elsewhere. `element(e, u_e, out)` writes `A_e u_e` (both in row order)
/// and returns false for an element without stiffness (then `out` is ignored).
pub fn apply_2d<T: Real, F>(grid: &Grid, free: &[bool], u: &[T], y: &mut [T], element: F)
where
    F: Fn(usize, &[T; 8], &mut [T; 8]) -> bool + Sync,
{
    let row = (grid.nx + 1) * 2;
    slabs(grid, free, y, row, |slab, lower, upper| {
        let start = slab * row;
        let u0 = &u[start..start + row];
        let u1 = &u[start + row..start + 2 * row];
        let first = slab * grid.nx;
        let mut ue = [T::ZERO; 8];
        let mut out = [T::ZERO; 8];
        for i in 0..grid.nx {
            let x = 2 * i;
            ue[0..4].copy_from_slice(&u0[x..x + 4]);
            ue[4..8].copy_from_slice(&u1[x..x + 4]);
            if !element(first + i, &ue, &mut out) {
                continue;
            }
            add(&mut lower[x..x + 4], &out[0..4]);
            add(&mut upper[x..x + 4], &out[4..8]);
        }
    });
}

/// [`apply_2d`] for a 3D grid (24 DOFs per element).
pub fn apply_3d<T: Real, F>(grid: &Grid, free: &[bool], u: &[T], y: &mut [T], element: F)
where
    F: Fn(usize, &[T; 24], &mut [T; 24]) -> bool + Sync,
{
    let row = (grid.nx + 1) * 3;
    let layer = row * (grid.ny + 1);
    slabs(grid, free, y, layer, |slab, lower, upper| {
        for j in 0..grid.ny {
            let start = slab * layer + j * row;
            let u00 = &u[start..start + row];
            let u10 = &u[start + row..start + 2 * row];
            let u01 = &u[start + layer..start + layer + row];
            let u11 = &u[start + layer + row..start + layer + 2 * row];
            let (y00, y10) = lower[j * row..(j + 2) * row].split_at_mut(row);
            let (y01, y11) = upper[j * row..(j + 2) * row].split_at_mut(row);
            let first = (slab * grid.ny + j) * grid.nx;
            let mut ue = [T::ZERO; 24];
            let mut out = [T::ZERO; 24];
            for i in 0..grid.nx {
                let x = 3 * i;
                ue[0..6].copy_from_slice(&u00[x..x + 6]);
                ue[6..12].copy_from_slice(&u10[x..x + 6]);
                ue[12..18].copy_from_slice(&u01[x..x + 6]);
                ue[18..24].copy_from_slice(&u11[x..x + 6]);
                if !element(first + i, &ue, &mut out) {
                    continue;
                }
                add(&mut y00[x..x + 6], &out[0..6]);
                add(&mut y10[x..x + 6], &out[6..12]);
                add(&mut y01[x..x + 6], &out[12..18]);
                add(&mut y11[x..x + 6], &out[18..24]);
            }
        }
    });
}

#[inline(always)]
fn add<T: Real>(target: &mut [T], values: &[T]) {
    for (t, &v) in target.iter_mut().zip(values) {
        *t += v;
    }
}

/// Runs `slab(s, lower, upper)` (the two node layers of slab `s`, each `layer` values) for the even slabs in parallel, then
/// the odd ones, on a zeroed `y`, and zeroes the non-free DOFs of each layer in the task that completes it (layer `l` is
/// complete once slabs `l − 1` and `l` ran).
fn slabs<T: Real, S>(grid: &Grid, free: &[bool], y: &mut [T], layer: usize, slab: S)
where
    S: Fn(usize, &mut [T], &mut [T]) + Sync,
{
    let count = if grid.dim == 3 { grid.nz } else { grid.ny };
    let mask = |l: usize, values: &mut [T]| {
        for (value, &free) in values.iter_mut().zip(&free[l * layer..(l + 1) * layer]) {
            if !free {
                *value = T::ZERO;
            }
        }
    };
    for colour in 0..2 {
        y[colour * layer..].par_chunks_mut(2 * layer).enumerate().for_each(|(index, chunk)| {
            if colour == 0 {
                chunk.fill(T::ZERO);
            }
            let s = colour + 2 * index;
            if s < count {
                let (lower, upper) = chunk.split_at_mut(layer);
                slab(s, lower, upper);
                // colour 1 completes both its layers; colour 0 only the first and the last layer of the grid
                if colour == 1 || s == 0 {
                    mask(s, lower);
                }
                if colour == 1 || s + 1 == count {
                    mask(s + 1, upper);
                }
            }
        });
    }
}
