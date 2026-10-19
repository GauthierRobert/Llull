//! The element-by-element product `y = Σ_e A_e u_e` shared by [`crate::operator::Operator`] and
//! [`crate::galerkin::ElementMatrices`], as a two-colour scatter over element slabs.
//!
//! A slab is one element layer along the last axis (an element row in 2D, an element plane in 3D); slab `s` touches node
//! layers `s` and `s + 1` only. Colour 0 runs the even slabs in parallel, then colour 1 the odd ones: within a colour the
//! slabs write disjoint node layers, each slab is one sequential task (elements in index order, local nodes in local order),
//! so every node sums its contributions in the same order for any thread count (colour 0 first, then colour 1). No
//! per-element product buffer and no separate gather pass; an element row is walked with the 2 (2D) or 4 (3D) node rows it
//! touches cut out as slices, local nodes in [`crate::grid::LOCAL_NODES`] order.

use crate::grid::Grid;
use crate::MIN_LEN;
use rayon::prelude::*;

/// `y = Σ_e A_e u_e` on the free DOFs of a 2D grid, 0 elsewhere. `element(e, u_e, out)` writes `A_e u_e` and returns false
/// for an element without stiffness (then `out` is ignored).
pub fn apply_2d<F>(grid: &Grid, free: &[bool], u: &[f64], y: &mut [f64], element: F)
where
    F: Fn(usize, &[f64; 8], &mut [f64; 8]) -> bool + Sync,
{
    let row = (grid.nx + 1) * 2;
    slabs(grid, free, y, row, |slab, lower, upper| {
        let start = slab * row;
        let u0 = &u[start..start + row];
        let u1 = &u[start + row..start + 2 * row];
        let first = slab * grid.nx;
        let mut ue = [0.0f64; 8];
        let mut out = [0.0f64; 8];
        for i in 0..grid.nx {
            let x = 2 * i;
            ue[0..4].copy_from_slice(&u0[x..x + 4]);
            ue[4..6].copy_from_slice(&u1[x + 2..x + 4]);
            ue[6..8].copy_from_slice(&u1[x..x + 2]);
            if !element(first + i, &ue, &mut out) {
                continue;
            }
            add(&mut lower[x..x + 4], &out[0..4]);
            add(&mut upper[x + 2..x + 4], &out[4..6]);
            add(&mut upper[x..x + 2], &out[6..8]);
        }
    });
}

/// [`apply_2d`] for a 3D grid (24 DOFs per element).
pub fn apply_3d<F>(grid: &Grid, free: &[bool], u: &[f64], y: &mut [f64], element: F)
where
    F: Fn(usize, &[f64; 24], &mut [f64; 24]) -> bool + Sync,
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
            let mut ue = [0.0f64; 24];
            let mut out = [0.0f64; 24];
            for i in 0..grid.nx {
                let (x, z) = (3 * i, 3 * i + 3);
                ue[0..3].copy_from_slice(&u00[x..x + 3]);
                ue[3..6].copy_from_slice(&u00[z..z + 3]);
                ue[6..9].copy_from_slice(&u10[z..z + 3]);
                ue[9..12].copy_from_slice(&u10[x..x + 3]);
                ue[12..15].copy_from_slice(&u01[x..x + 3]);
                ue[15..18].copy_from_slice(&u01[z..z + 3]);
                ue[18..21].copy_from_slice(&u11[z..z + 3]);
                ue[21..24].copy_from_slice(&u11[x..x + 3]);
                if !element(first + i, &ue, &mut out) {
                    continue;
                }
                add(&mut y00[x..x + 3], &out[0..3]);
                add(&mut y00[z..z + 3], &out[3..6]);
                add(&mut y10[z..z + 3], &out[6..9]);
                add(&mut y10[x..x + 3], &out[9..12]);
                add(&mut y01[x..x + 3], &out[12..15]);
                add(&mut y01[z..z + 3], &out[15..18]);
                add(&mut y11[z..z + 3], &out[18..21]);
                add(&mut y11[x..x + 3], &out[21..24]);
            }
        }
    });
}

#[inline(always)]
fn add(target: &mut [f64], values: &[f64]) {
    for (t, v) in target.iter_mut().zip(values) {
        *t += v;
    }
}

/// Runs `slab(s, lower, upper)` (the two node layers of slab `s`, each `layer` values) for the even slabs in parallel, then
/// the odd ones, on a zeroed `y`; then zeroes the non-free DOFs.
fn slabs<S>(grid: &Grid, free: &[bool], y: &mut [f64], layer: usize, slab: S)
where
    S: Fn(usize, &mut [f64], &mut [f64]) + Sync,
{
    let count = if grid.dim == 3 { grid.nz } else { grid.ny };
    for colour in 0..2 {
        y[colour * layer..].par_chunks_mut(2 * layer).enumerate().for_each(|(index, chunk)| {
            if colour == 0 {
                chunk.fill(0.0);
            }
            let s = colour + 2 * index;
            if s < count {
                let (lower, upper) = chunk.split_at_mut(layer);
                slab(s, lower, upper);
            }
        });
    }
    y.par_iter_mut().with_min_len(MIN_LEN).zip(free).for_each(|(value, &free)| {
        if !free {
            *value = 0.0;
        }
    });
}
