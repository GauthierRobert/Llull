//! Periodic numerical homogenisation of a unit cell on the voxel H8 elements (05 IMP 14.15; Andreassen & Andreasen 2014, Hashin & Shtrikman 1963 for the bounds the
//! tests use): the six unit macro strains are imposed on a cell with periodic fluctuation displacements, the cell problem `K u~ = -sum_e s_e K_e chi_e` is solved by
//! Jacobi-preconditioned conjugate gradient, matrix-free, and the effective stiffness is the energy `C_ij = (1/V) sum_e s_e (chi_i + u~_i)^T K_e (chi_j + u~_j)`.
//! The base material has E = 1, so `C` is in units of the solid's Young modulus; a voxel of density `rho` has the stiffness factor `emin + (1 - emin) rho` (linear, no
//! penalisation: the density is a partial volume, not a design variable). Voigt order `xx yy zz yz zx xy` with engineering shear strains.
//! Deterministic: every vector operation is element-wise or a reduction over fixed chunks added in order, so the bytes do not depend on the thread count.
//! @invariant node 0 is pinned (the rigid translations of the periodic cell), the problem is symmetric positive definite on the rest because `emin > 0`

use crate::grid::LOCAL_NODES;
use crate::ke::h8;
use crate::MIN_LEN;
use rayon::prelude::*;

/// A cell of `nx` x `ny` x `nz` cubic voxels of edge `h`, with the density of every voxel (x fastest).
pub struct Cell<'a> {
    pub dims: [usize; 3],
    pub h: f64,
    pub density: &'a [f64],
    /// Poisson ratio of the base material.
    pub nu: f64,
    /// Stiffness factor of a void voxel (a fraction of the solid's).
    pub emin: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Homogenized {
    /// 6 x 6 effective stiffness, row-major, Voigt `xx yy zz yz zx xy`, in units of the solid Young modulus.
    pub c: [f64; 36],
    /// CG iterations and final relative residual of each of the six load cases.
    pub iterations: [usize; 6],
    pub residuals: [f64; 6],
    pub converged: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// A dimension below 2, a density that is not in [0, 1], a length that does not match, a non-positive size, `nu` outside (-1, 0.5), `emin` outside (0, 1).
    Input(String),
}

/// Solver settings.
#[derive(Debug, Clone, Copy)]
pub struct Settings {
    pub tolerance: f64,
    pub max_iterations: usize,
}

impl Default for Settings {
    fn default() -> Self {
        Self { tolerance: 1e-9, max_iterations: 6000 }
    }
}

const CHUNK: usize = 4096;

struct Periodic<'a> {
    nx: usize,
    ny: usize,
    nz: usize,
    /// Element matrix of the cube of edge h with E = 1: `h * KE`.
    ke: Vec<f64>,
    scale: Vec<f64>,
    cell: &'a Cell<'a>,
}

fn dot(a: &[f64], b: &[f64]) -> f64 {
    let partial: Vec<f64> =
        a.par_chunks(CHUNK).zip(b.par_chunks(CHUNK)).map(|(x, y)| x.iter().zip(y).fold(0.0, |s, (p, q)| s + p * q)).collect();
    partial.into_iter().fold(0.0, |s, p| s + p)
}

impl Periodic<'_> {
    fn nodes(&self) -> usize {
        self.nx * self.ny * self.nz
    }

    fn node(&self, i: usize, j: usize, k: usize) -> usize {
        (i % self.nx) + self.nx * ((j % self.ny) + self.ny * (k % self.nz))
    }

    fn element(&self, i: usize, j: usize, k: usize) -> usize {
        i + self.nx * (j + self.ny * k)
    }

    /// The eight nodes of element (i, j, k), wrapped, in `LOCAL_NODES` order.
    fn element_nodes(&self, i: usize, j: usize, k: usize) -> [usize; 8] {
        std::array::from_fn(|a| self.node(i + LOCAL_NODES[a][0], j + LOCAL_NODES[a][1], k + LOCAL_NODES[a][2]))
    }

    /// `y = K u` with node 0 pinned (its entries of `u` are ignored, of `y` zero).
    fn apply(&self, u: &[f64], y: &mut [f64]) {
        let (nx, ny, nz) = (self.nx, self.ny, self.nz);
        y.par_chunks_mut(3).enumerate().with_min_len(MIN_LEN / 4).for_each(|(n, out)| {
            out.fill(0.0);
            if n == 0 {
                return;
            }
            let (i, j, k) = (n % nx, (n / nx) % ny, n / (nx * ny));
            for (a, [ox, oy, oz]) in LOCAL_NODES.iter().enumerate() {
                // the element that has this node as its local node `a`
                let (ei, ej, ek) = ((i + nx - ox) % nx, (j + ny - oy) % ny, (k + nz - oz) % nz);
                let s = self.scale[self.element(ei, ej, ek)];
                let nodes = self.element_nodes(ei, ej, ek);
                for (c, value) in out.iter_mut().enumerate() {
                    let row = &self.ke[(a * 3 + c) * 24..(a * 3 + c) * 24 + 24];
                    let mut sum = 0.0;
                    for (b, node) in nodes.iter().enumerate() {
                        if *node == 0 {
                            continue;
                        }
                        for d in 0..3 {
                            sum += row[b * 3 + d] * u[node * 3 + d];
                        }
                    }
                    *value += s * sum;
                }
            }
        });
    }

    fn diagonal(&self) -> Vec<f64> {
        let (nx, ny, nz) = (self.nx, self.ny, self.nz);
        let mut diagonal = vec![0.0; self.nodes() * 3];
        diagonal.par_chunks_mut(3).enumerate().with_min_len(MIN_LEN / 4).for_each(|(n, out)| {
            let (i, j, k) = (n % nx, (n / nx) % ny, n / (nx * ny));
            for (a, [ox, oy, oz]) in LOCAL_NODES.iter().enumerate() {
                let s = self.scale[self.element((i + nx - ox) % nx, (j + ny - oy) % ny, (k + nz - oz) % nz)];
                for (c, value) in out.iter_mut().enumerate() {
                    *value += s * self.ke[(a * 3 + c) * 24 + a * 3 + c];
                }
            }
            if n == 0 {
                out.fill(1.0);
            }
        });
        diagonal
    }

    /// The affine displacement `chi` of the eight nodes of an element for the unit Voigt strain `case` (node coordinates `0..1` times `h`, the element at the origin).
    fn affine(&self, case: usize) -> [f64; 24] {
        let mut strain = [0.0; 6];
        strain[case] = 1.0;
        let [exx, eyy, ezz, gyz, gzx, gxy] = strain;
        let h = self.cell.h;
        std::array::from_fn(|t| {
            let [ox, oy, oz] = LOCAL_NODES[t / 3];
            let (x, y, z) = (ox as f64 * h, oy as f64 * h, oz as f64 * h);
            match t % 3 {
                0 => exx * x + 0.5 * gxy * y + 0.5 * gzx * z,
                1 => 0.5 * gxy * x + eyy * y + 0.5 * gyz * z,
                _ => 0.5 * gzx * x + 0.5 * gyz * y + ezz * z,
            }
        })
    }

    fn ke_times(&self, v: &[f64; 24]) -> [f64; 24] {
        std::array::from_fn(|r| (0..24).fold(0.0, |s, t| s + self.ke[r * 24 + t] * v[t]))
    }

    /// Right-hand side `-sum_e s_e K_e chi_e` of the cell problem for `case`, node 0 zeroed.
    fn load(&self, case: usize) -> Vec<f64> {
        let chi = self.affine(case);
        let ke_chi = self.ke_times(&chi);
        let (nx, ny, nz) = (self.nx, self.ny, self.nz);
        let mut b = vec![0.0; self.nodes() * 3];
        b.par_chunks_mut(3).enumerate().with_min_len(MIN_LEN / 4).for_each(|(n, out)| {
            if n == 0 {
                return;
            }
            let (i, j, k) = (n % nx, (n / nx) % ny, n / (nx * ny));
            for (a, [ox, oy, oz]) in LOCAL_NODES.iter().enumerate() {
                let s = self.scale[self.element((i + nx - ox) % nx, (j + ny - oy) % ny, (k + nz - oz) % nz)];
                for (c, value) in out.iter_mut().enumerate() {
                    *value -= s * ke_chi[a * 3 + c];
                }
            }
        });
        b
    }

    /// `chi + u~` of one element for a solved case.
    fn total(&self, chi: &[f64; 24], u: &[f64], nodes: &[usize; 8]) -> [f64; 24] {
        std::array::from_fn(|t| chi[t] + if nodes[t / 3] == 0 { 0.0 } else { u[nodes[t / 3] * 3 + t % 3] })
    }
}

fn pcg(op: &Periodic, b: &[f64], inverse_diagonal: &[f64], settings: Settings) -> (Vec<f64>, usize, f64, bool) {
    let n = b.len();
    let mut x = vec![0.0; n];
    let norm = dot(b, b).sqrt();
    if norm == 0.0 {
        return (x, 0, 0.0, true);
    }
    let mut r = b.to_vec();
    let mut z: Vec<f64> = r.iter().zip(inverse_diagonal).map(|(r, d)| r * d).collect();
    let mut p = z.clone();
    let mut rz = dot(&r, &z);
    let mut ap = vec![0.0; n];
    let mut residual = 1.0;
    let mut iterations = 0;
    while residual > settings.tolerance && iterations < settings.max_iterations {
        op.apply(&p, &mut ap);
        let curvature = dot(&p, &ap);
        if curvature.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
            break;
        }
        let alpha = rz / curvature;
        x.par_iter_mut().zip(p.par_iter()).for_each(|(x, p)| *x += alpha * p);
        r.par_iter_mut().zip(ap.par_iter()).for_each(|(r, a)| *r -= alpha * a);
        z.par_iter_mut().zip(r.par_iter().zip(inverse_diagonal)).for_each(|(z, (r, d))| *z = r * d);
        let next = dot(&r, &z);
        let beta = next / rz;
        rz = next;
        p.par_iter_mut().zip(z.par_iter()).for_each(|(p, z)| *p = z + beta * *p);
        residual = dot(&r, &r).sqrt() / norm;
        iterations += 1;
    }
    (x, iterations, residual, residual <= settings.tolerance)
}

/// Effective stiffness of `cell`.
pub fn homogenize(cell: &Cell, settings: Settings) -> Result<Homogenized, Refusal> {
    let [nx, ny, nz] = cell.dims;
    let bad = |message: String| Err(Refusal::Input(message));
    if nx < 2 || ny < 2 || nz < 2 {
        return bad(format!("a cell needs at least 2 voxels along every axis, got {nx} x {ny} x {nz}"));
    }
    if cell.density.len() != nx * ny * nz {
        return bad(format!("{} densities for {} voxels", cell.density.len(), nx * ny * nz));
    }
    if !(cell.h.is_finite() && cell.h > 0.0) {
        return bad(format!("voxel size must be positive, got {}", cell.h));
    }
    if !(cell.nu > -1.0 && cell.nu < 0.5) {
        return bad(format!("nu must be in (-1, 0.5), got {}", cell.nu));
    }
    if !(cell.emin > 0.0 && cell.emin < 1.0) {
        return bad(format!("emin must be in (0, 1), got {}", cell.emin));
    }
    if cell.density.iter().any(|d| !(0.0..=1.0).contains(d)) {
        return bad("every density must be a number from 0 to 1".to_string());
    }
    let ke: Vec<f64> = h8(cell.nu).iter().map(|v| v * cell.h).collect();
    let scale: Vec<f64> = cell.density.iter().map(|d| cell.emin + (1.0 - cell.emin) * d).collect();
    let op = Periodic { nx, ny, nz, ke, scale, cell };
    let inverse: Vec<f64> = op.diagonal().iter().map(|d| if *d > 0.0 { 1.0 / d } else { 1.0 }).collect();
    let volume = (nx * ny * nz) as f64 * cell.h.powi(3);
    let mut solved = Vec::with_capacity(6);
    let (mut iterations, mut residuals, mut converged) = ([0usize; 6], [0.0f64; 6], true);
    for case in 0..6 {
        let (u, it, residual, ok) = pcg(&op, &op.load(case), &inverse, settings);
        iterations[case] = it;
        residuals[case] = residual;
        converged &= ok;
        solved.push(u);
    }
    let chis: Vec<[f64; 24]> = (0..6).map(|case| op.affine(case)).collect();
    // sum over elements in chunks of a fixed size, added in order
    let elements = nx * ny * nz;
    let partial: Vec<[f64; 36]> = (0..elements.div_ceil(512))
        .into_par_iter()
        .map(|chunk| {
            let mut sum = [0.0; 36];
            for e in chunk * 512..((chunk + 1) * 512).min(elements) {
                let (i, j, k) = (e % nx, (e / nx) % ny, e / (nx * ny));
                let nodes = op.element_nodes(i, j, k);
                let totals: Vec<[f64; 24]> = (0..6).map(|case| op.total(&chis[case], &solved[case], &nodes)).collect();
                let products: Vec<[f64; 24]> = totals.iter().map(|v| op.ke_times(v)).collect();
                let s = op.scale[e];
                for a in 0..6 {
                    for b in 0..6 {
                        sum[a * 6 + b] += s * (0..24).fold(0.0, |t, q| t + totals[a][q] * products[b][q]);
                    }
                }
            }
            sum
        })
        .collect();
    let mut c = [0.0; 36];
    for part in &partial {
        for (total, value) in c.iter_mut().zip(part) {
            *total += value;
        }
    }
    for value in &mut c {
        *value /= volume;
    }
    Ok(Homogenized { c, iterations, residuals, converged })
}

#[cfg(test)]
mod tests {
    use super::{homogenize, Cell, Settings};

    fn cell(n: usize, density: &[f64]) -> Cell<'_> {
        Cell { dims: [n, n, n], h: 1.0 / n as f64, density, nu: 0.3, emin: 1e-6 }
    }

    /// Isotropic stiffness of E = 1 in Voigt form.
    fn isotropic(nu: f64) -> [f64; 36] {
        let (lambda, mu) = (nu / ((1.0 + nu) * (1.0 - 2.0 * nu)), 0.5 / (1.0 + nu));
        let mut c = [0.0; 36];
        for a in 0..3 {
            for b in 0..3 {
                c[a * 6 + b] = lambda + if a == b { 2.0 * mu } else { 0.0 };
            }
        }
        for a in 3..6 {
            c[a * 6 + a] = mu;
        }
        c
    }

    #[test]
    fn a_solid_cell_is_the_stiffness_of_its_material() {
        let density = vec![1.0; 6 * 6 * 6];
        let result = homogenize(&cell(6, &density), Settings::default()).unwrap();
        assert!(result.converged);
        for (got, want) in result.c.iter().zip(isotropic(0.3)) {
            assert!((got - want).abs() < 1e-8, "{got} against {want}");
        }
    }

    #[test]
    fn a_void_cell_is_emin_times_the_stiffness() {
        let density = vec![0.0; 6 * 6 * 6];
        let result = homogenize(&cell(6, &density), Settings::default()).unwrap();
        for (got, want) in result.c.iter().zip(isotropic(0.3)) {
            assert!((got - 1e-6 * want).abs() < 1e-12, "{got} against {}", 1e-6 * want);
        }
    }

    /// Three orthogonal square bars (each 4 x 4 voxels of 8 across) through the cell: connected by periodicity, cubic symmetry, a volume fraction the bars share between them.
    #[test]
    fn three_orthogonal_bars_are_cubic_and_between_the_bounds() {
        let n = 8;
        let mut fraction = 0.0;
        let density: Vec<f64> = (0..n * n * n)
            .map(|e| {
                let (i, j, k) = (e % n, (e / n) % n, e / (n * n));
                let inside = [i, j, k].iter().filter(|v| (2..6).contains(*v)).count();
                let solid = f64::from(u8::from(inside >= 2));
                fraction += solid / (n * n * n) as f64;
                solid
            })
            .collect();
        let result = homogenize(&cell(n, &density), Settings::default()).unwrap();
        assert!(result.converged);
        let c = result.c;
        let at = |a: usize, b: usize| c[a * 6 + b];
        assert!((at(0, 0) - at(1, 1)).abs() < 1e-9 && (at(1, 1) - at(2, 2)).abs() < 1e-9);
        assert!((at(0, 1) - at(1, 2)).abs() < 1e-9 && (at(0, 1) - at(0, 2)).abs() < 1e-9);
        assert!((at(3, 3) - at(4, 4)).abs() < 1e-9 && (at(4, 4) - at(5, 5)).abs() < 1e-9);
        for (a, b) in [(0, 3), (0, 4), (0, 5), (3, 4), (3, 5), (1, 3), (2, 5)] {
            assert!(at(a, b).abs() < 1e-9, "C[{a}][{b}] = {}", at(a, b));
        }
        for a in 0..6 {
            for b in 0..6 {
                assert!((at(a, b) - at(b, a)).abs() < 1e-9 * at(0, 0));
            }
        }
        // Voigt bound: fraction times the solid; the bars carry load along their own axis only, so C11 is far below it but well above the void's emin
        assert!(at(0, 0) < fraction * isotropic(0.3)[0] && at(0, 0) > 0.01, "C11 = {} at fraction {fraction}", at(0, 0));
    }

    /// Layers normal to z, half stiffness 1 and half 0.4: the exact laminate (Voigt in the plane for the strain-compatible entries, Reuss through the thickness):
    /// C33 = 1 / <1/C33>, C13 = <C13/C33> / <1/C33>, C11 = <C11> - <C13^2/C33> + <C13/C33>^2 / <1/C33>, C12 likewise, C44 = C55 = 1 / <1/C44>, C66 = <C66>.
    /// Every entry of the 6 x 6 tensor is checked, so a swapped shear component (C44 against C66) or a transposed index cannot pass.
    #[test]
    fn a_two_layer_laminate_matches_the_exact_formulas_entry_by_entry() {
        let (nx, ny, nz) = (4, 4, 8);
        let emin = 1e-6;
        let weak = 0.4;
        let rho2 = (weak - emin) / (1.0 - emin);
        let density: Vec<f64> = (0..nx * ny * nz).map(|e| if e / (nx * ny) < nz / 2 { 1.0 } else { rho2 }).collect();
        let result = homogenize(&Cell { dims: [nx, ny, nz], h: 0.25, density: &density, nu: 0.3, emin }, Settings::default()).unwrap();
        assert!(result.converged);
        let base = isotropic(0.3);
        let layers = [1.0, weak];
        let mean = |f: &dyn Fn(f64) -> f64| layers.iter().map(|s| f(*s)).sum::<f64>() / 2.0;
        let at = |r: usize, q: usize, s: f64| s * base[r * 6 + q];
        let inverse_c33 = mean(&|s| 1.0 / at(2, 2, s));
        let ratio = mean(&|s| at(0, 2, s) / at(2, 2, s));
        let correction = mean(&|s| at(0, 2, s) * at(0, 2, s) / at(2, 2, s)) - ratio * ratio / inverse_c33;
        let mut want = [0.0; 36];
        want[0] = mean(&|s| at(0, 0, s)) - correction;
        want[7] = want[0];
        want[1] = mean(&|s| at(0, 1, s)) - correction;
        want[6] = want[1];
        want[14] = 1.0 / inverse_c33;
        want[2] = ratio / inverse_c33;
        want[12] = want[2];
        want[8] = want[2];
        want[13] = want[2];
        want[21] = 1.0 / mean(&|s| 1.0 / at(3, 3, s));
        want[28] = want[21];
        want[35] = mean(&|s| at(5, 5, s));
        for r in 0..6 {
            for q in 0..6 {
                let (got, expected) = (result.c[r * 6 + q], want[r * 6 + q]);
                assert!((got - expected).abs() < 1e-8, "C[{r}][{q}] = {got}, the laminate says {expected}");
            }
        }
    }

    #[test]
    fn the_result_does_not_depend_on_the_thread_count() {
        let n = 8;
        let density: Vec<f64> = (0..n * n * n).map(|e| if (e * 7 + e / 3) % 5 < 2 { 1.0 } else { 0.0 }).collect();
        let reference = homogenize(&cell(n, &density), Settings::default()).unwrap();
        for threads in [1, 3] {
            let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).build().unwrap();
            let other = pool.install(|| homogenize(&cell(n, &density), Settings::default()).unwrap());
            assert_eq!(other, reference, "{threads} threads");
        }
    }

    #[test]
    fn bad_input_is_refused_by_name() {
        let density = vec![1.0; 8];
        assert!(homogenize(&Cell { dims: [1, 2, 4], h: 1.0, density: &density, nu: 0.3, emin: 1e-6 }, Settings::default()).is_err());
        assert!(homogenize(&Cell { dims: [2, 2, 2], h: 1.0, density: &density[..7], nu: 0.3, emin: 1e-6 }, Settings::default()).is_err());
        assert!(homogenize(&Cell { dims: [2, 2, 2], h: 1.0, density: &density, nu: 0.5, emin: 1e-6 }, Settings::default()).is_err());
        assert!(homogenize(&Cell { dims: [2, 2, 2], h: 1.0, density: &[2.0; 8], nu: 0.3, emin: 1e-6 }, Settings::default()).is_err());
    }
}
