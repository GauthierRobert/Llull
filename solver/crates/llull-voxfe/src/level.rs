//! The operators of the multigrid levels in the V-cycle's float type `T`: the fine level as element scales × KE columns,
//! the coarse levels as Galerkin element matrices ([`ElementMatrices`]), and the dense Cholesky factor of the coarsest level
//! (f64).

use crate::galerkin::ElementMatrices;
use crate::grid::Grid;
use crate::operator::{scaled_product, Operator};
use crate::real::Real;
use crate::scatter;

/// The fine operator rounded to `T`: KE by columns (`[t][r] = KE[r][t]`) and the element scales.
pub struct Fine<T: Real> {
    grid: Grid,
    columns: Vec<T>,
    scale: Vec<T>,
    fixed: Vec<bool>,
    free: Vec<bool>,
}

impl<T: Real> Fine<T> {
    pub fn new(op: &Operator) -> Fine<T> {
        let nd = op.grid().element_dofs();
        let ke = op.ke();
        let columns = (0..nd * nd).map(|i| T::of(ke[(i % nd) * nd + i / nd])).collect();
        let scale = op.scale().iter().map(|&s| T::of(s)).collect();
        Fine { grid: *op.grid(), columns, scale, fixed: op.fixed().to_vec(), free: op.free().to_vec() }
    }

    /// Takes the scales of `op` (same grid, supports and activity).
    pub fn set_scale(&mut self, op: &Operator) {
        for (value, &s) in self.scale.iter_mut().zip(op.scale()) {
            *value = T::of(s);
        }
    }

    fn apply(&self, u: &[T], y: &mut [T]) {
        if self.grid.dim == 3 {
            let columns: [[T; 24]; 24] = std::array::from_fn(|t| std::array::from_fn(|r| self.columns[t * 24 + r]));
            scatter::apply_3d(&self.grid, &self.free, u, y, |e, ue, out| scaled_product(self.scale[e], &columns, ue, out));
        } else {
            let columns: [[T; 8]; 8] = std::array::from_fn(|t| std::array::from_fn(|r| self.columns[t * 8 + r]));
            scatter::apply_2d(&self.grid, &self.free, u, y, |e, ue, out| scaled_product(self.scale[e], &columns, ue, out));
        }
    }
}

/// One level's operator.
pub enum LevelOperator<T: Real> {
    Fine(Fine<T>),
    Assembled(ElementMatrices<T>),
}

impl<T: Real> LevelOperator<T> {
    pub fn grid(&self) -> &Grid {
        match self {
            LevelOperator::Fine(op) => &op.grid,
            LevelOperator::Assembled(op) => op.grid(),
        }
    }

    pub fn free(&self) -> &[bool] {
        match self {
            LevelOperator::Fine(op) => &op.free,
            LevelOperator::Assembled(op) => op.free(),
        }
    }

    pub fn fixed(&self) -> &[bool] {
        match self {
            LevelOperator::Fine(op) => &op.fixed,
            LevelOperator::Assembled(op) => op.fixed(),
        }
    }

    /// `y = K u` on the free DOFs, 0 elsewhere.
    pub fn apply(&self, u: &[T], y: &mut [T]) {
        match self {
            LevelOperator::Fine(op) => op.apply(u, y),
            LevelOperator::Assembled(op) => op.apply(u, y),
        }
    }

    /// Writes element `e`'s matrix (f64, row-major) into `out`; false for an element without stiffness.
    fn element_matrix(&self, e: usize, out: &mut [f64]) -> bool {
        match self {
            LevelOperator::Fine(op) => {
                let nd = op.grid.element_dofs();
                let s = op.scale[e].get();
                for (i, value) in out.iter_mut().enumerate() {
                    *value = s * op.columns[(i % nd) * nd + i / nd].get();
                }
                s != 0.0
            }
            LevelOperator::Assembled(op) => {
                for (value, m) in out.iter_mut().zip(op.matrix(e)) {
                    *value = m.get();
                }
                op.active(e)
            }
        }
    }
}

/// Dense Cholesky factor (f64) of a level's free-DOF matrix: the coarsest level of the V-cycle.
pub struct Coarse {
    dofs: Vec<usize>,
    factor: Vec<f64>,
}

impl Coarse {
    pub fn new<T: Real>(op: &LevelOperator<T>) -> Coarse {
        let g = op.grid();
        let dofs: Vec<usize> = (0..g.dofs()).filter(|&d| op.free()[d]).collect();
        let m = dofs.len();
        let mut index = vec![usize::MAX; g.dofs()];
        for (i, &d) in dofs.iter().enumerate() {
            index[d] = i;
        }
        let nd = g.element_dofs();
        let mut a = vec![0.0; m * m];
        let mut element = vec![0.0; nd * nd];
        for e in 0..g.elements() {
            if !op.element_matrix(e, &mut element) {
                continue;
            }
            let nodes = g.element_nodes(e);
            let global = |r: usize| index[nodes[r / g.dim] * g.dim + r % g.dim];
            for r in 0..nd {
                let gr = global(r);
                if gr == usize::MAX {
                    continue;
                }
                for col in 0..nd {
                    let gc = global(col);
                    if gc != usize::MAX {
                        a[gr * m + gc] += element[r * nd + col];
                    }
                }
            }
        }
        let max_diagonal = (0..m).map(|i| a[i * m + i]).fold(0.0, f64::max);
        for j in 0..m {
            let original = a[j * m + j];
            let mut d = original;
            for k in 0..j {
                d -= a[j * m + k] * a[j * m + k];
            }
            // a pivot lost to round-off (near-singular coarse level) is replaced by the original diagonal: still SPD
            let pivot = if d > 1e-13 * max_diagonal { d.sqrt() } else { original.max(f64::MIN_POSITIVE).sqrt() };
            a[j * m + j] = pivot;
            for i in j + 1..m {
                let mut s = a[i * m + j];
                for k in 0..j {
                    s -= a[i * m + k] * a[j * m + k];
                }
                a[i * m + j] = s / pivot;
            }
        }
        Coarse { dofs, factor: a }
    }

    /// The free DOFs of the level, in factor order.
    pub fn dofs(&self) -> &[usize] {
        &self.dofs
    }

    /// The dense inverse `K⁻¹` of the free-DOF matrix (row-major, `dofs × dofs`, symmetrised).
    pub fn inverse(&self) -> Vec<f64> {
        let m = self.dofs.len();
        let mut inverse = vec![0.0; m * m];
        let mut unit = vec![0.0f64; self.dofs.iter().max().map_or(0, |d| d + 1)];
        let mut column = vec![0.0f64; unit.len()];
        for (j, &dj) in self.dofs.iter().enumerate() {
            unit[dj] = 1.0;
            self.solve(&unit, &mut column);
            unit[dj] = 0.0;
            for (i, &di) in self.dofs.iter().enumerate() {
                inverse[i * m + j] = column[di];
            }
        }
        for i in 0..m {
            for j in i + 1..m {
                let mean = 0.5 * (inverse[i * m + j] + inverse[j * m + i]);
                inverse[i * m + j] = mean;
                inverse[j * m + i] = mean;
            }
        }
        inverse
    }

    /// `z = K⁻¹ r` on the free DOFs (0 elsewhere).
    pub fn solve<T: Real>(&self, r: &[T], z: &mut [T]) {
        let m = self.dofs.len();
        let l = &self.factor;
        let mut y: Vec<f64> = self.dofs.iter().map(|&d| r[d].get()).collect();
        for i in 0..m {
            let mut s = y[i];
            for k in 0..i {
                s -= l[i * m + k] * y[k];
            }
            y[i] = s / l[i * m + i];
        }
        for i in (0..m).rev() {
            let mut s = y[i];
            for k in i + 1..m {
                s -= l[k * m + i] * y[k];
            }
            y[i] = s / l[i * m + i];
        }
        z.fill(T::ZERO);
        for (&d, &v) in self.dofs.iter().zip(&y) {
            z[d] = T::of(v);
        }
    }
}
