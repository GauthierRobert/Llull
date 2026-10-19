//! Grid transfer of the multigrid: bilinear / trilinear prolongation P (fine node = weighted coarse nodes, weights 1 or ½
//! per axis) and restriction R = Pᵀ. Both are separable, so they run row by row: a fine row is the weighted sum of the 1D
//! interpolations of at most 2 (2D) or 4 (3D) coarse rows, a coarse row the weighted sum of the 1D restrictions of at most
//! 3 (2D) or 9 (3D) fine rows. Each output row is one task with a fixed summation order (bits independent of the thread
//! count).

use crate::grid::Grid;
use crate::real::Real;
use rayon::prelude::*;

/// Interpolation weights of the coarse nodes covering fine node index `i` along one axis (the second entry has weight 0
/// for an even `i`).
pub fn parents(i: usize) -> [(usize, f64); 2] {
    if i.is_multiple_of(2) {
        [(i / 2, 1.0), (0, 0.0)]
    } else {
        [((i - 1) / 2, 0.5), (i.div_ceil(2), 0.5)]
    }
}

/// Rows of nodes a rayon task gets at least.
fn rows_per_task(nodes_per_row: usize) -> usize {
    (2048 / nodes_per_row).max(1)
}

/// `fine += w · (1D interpolation of the coarse row)`, `D` interleaved components per node.
fn interpolate_row<T: Real, const D: usize>(w: f64, coarse: &[T], fine: &mut [T]) {
    let (half, w) = (T::of(0.5 * w), T::of(w));
    let mut pairs = fine.chunks_mut(2 * D);
    for (ci, node) in coarse.chunks_exact(D).enumerate() {
        let Some(pair) = pairs.next() else { break };
        let (even, odd) = pair.split_at_mut(D.min(pair.len()));
        for (f, &c) in even.iter_mut().zip(node) {
            *f += w * c;
        }
        if !odd.is_empty() {
            let next = &coarse[(ci + 1) * D..(ci + 2) * D];
            for ((f, &a), &b) in odd.iter_mut().zip(node).zip(next) {
                *f += half * (a + b);
            }
        }
    }
}

/// `coarse += w · (1D restriction of the fine row)`: `c_i += w (f_2i + ½ f_2i−1 + ½ f_2i+1)` (nodes past the row omitted).
fn restrict_row<T: Real, const D: usize>(w: f64, fine: &[T], coarse: &mut [T]) {
    let nodes = fine.len() / D;
    let (half, w) = (T::of(0.5), T::of(w));
    for (ci, out) in coarse.chunks_exact_mut(D).enumerate() {
        let i = 2 * ci;
        for (q, value) in out.iter_mut().enumerate() {
            let mut sum = if i < nodes { fine[i * D + q] } else { T::ZERO };
            if i > 0 {
                sum += half * fine[(i - 1) * D + q];
            }
            if i + 1 < nodes {
                sum += half * fine[(i + 1) * D + q];
            }
            *value += w * sum;
        }
    }
}

/// `fine += P coarse` on the fine free DOFs (`fine_free`).
pub fn prolong_add<T: Real>(g: &Grid, c: &Grid, fine_free: &[bool], coarse: &[T], fine: &mut [T]) {
    if g.dim == 3 {
        prolong_fixed::<T, 3>(g, c, fine_free, coarse, fine);
    } else {
        prolong_fixed::<T, 2>(g, c, fine_free, coarse, fine);
    }
}

fn prolong_fixed<T: Real, const D: usize>(g: &Grid, c: &Grid, fine_free: &[bool], coarse: &[T], fine: &mut [T]) {
    let [fnx, fny, _] = g.node_dims();
    let [cnx, _, _] = c.node_dims();
    let (fine_row, coarse_row) = (fnx * D, cnx * D);
    fine.par_chunks_mut(fine_row).enumerate().with_min_len(rows_per_task(fnx)).for_each_init(
        || vec![T::ZERO; fine_row],
        |row_sum, (row, out)| {
            let (j, k) = (row % fny, row / fny);
            row_sum.fill(T::ZERO);
            for (ck, wk) in parents(k) {
                for (cj, wj) in parents(j) {
                    if wk * wj == 0.0 {
                        continue;
                    }
                    let start = c.node(0, cj, ck) * D;
                    interpolate_row::<T, D>(wk * wj, &coarse[start..start + coarse_row], row_sum);
                }
            }
            let free = &fine_free[row * fine_row..(row + 1) * fine_row];
            for ((value, &add), &free) in out.iter_mut().zip(row_sum.iter()).zip(free) {
                if free {
                    *value += add;
                }
            }
        },
    );
}

/// `coarse = R fine` (R = Pᵀ), zero at the coarse non-free DOFs (`coarse_free`).
pub fn restrict<T: Real>(g: &Grid, c: &Grid, coarse_free: &[bool], fine: &[T], coarse: &mut [T]) {
    if g.dim == 3 {
        restrict_fixed::<T, 3>(g, c, coarse_free, fine, coarse);
    } else {
        restrict_fixed::<T, 2>(g, c, coarse_free, fine, coarse);
    }
}

fn restrict_fixed<T: Real, const D: usize>(g: &Grid, c: &Grid, coarse_free: &[bool], fine: &[T], coarse: &mut [T]) {
    let [fnx, fny, fnz] = g.node_dims();
    let [cnx, cny, _] = c.node_dims();
    let (fine_row, coarse_row) = (fnx * D, cnx * D);
    let range = |center: usize, limit: usize| (center * 2).saturating_sub(1)..(center * 2 + 2).min(limit);
    let weight = |f: usize, center: usize| if f == 2 * center { 1.0 } else { 0.5 };
    coarse.par_chunks_mut(coarse_row).enumerate().with_min_len(rows_per_task(cnx)).for_each(|(row, out)| {
        let (cj, ck) = (row % cny, row / cny);
        out.fill(T::ZERO);
        for fk in range(ck, fnz) {
            for fj in range(cj, fny) {
                let start = g.node(0, fj, fk) * D;
                restrict_row::<T, D>(weight(fk, ck) * weight(fj, cj), &fine[start..start + fine_row], out);
            }
        }
        let free = &coarse_free[row * coarse_row..(row + 1) * coarse_row];
        for (value, &free) in out.iter_mut().zip(free) {
            if !free {
                *value = T::ZERO;
            }
        }
    });
}
