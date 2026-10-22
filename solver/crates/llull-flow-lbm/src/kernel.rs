//! The per-cell step shared by the CPU twin and mirrored by the WGSL kernel (`lbm.wgsl`): pull the 19 populations from the
//! neighbours (boundary rules by the neighbour's flag), then collide (BGK, Smagorinsky LES, Guo body force). Generic over the
//! precision ([`Real`]): in f32 the arithmetic is the WGSL kernel's, operation for operation, so CPU and GPU differ only by
//! rounding; in f64 it is the reference the validation cases run.
//!
//! Boundary pulls at fluid cell x for incoming direction q (source `s = x − c_q`):
//! - SOLID: `f_x[q̄]` (half-way bounce-back); MOVING_WALL adds `2 w_q ρ_x (c_q·u_w) / c_s²`;
//! - INLET: `f_eq(ρ_x, u_in)`; OUTLET: `f_eq(1, u_x) + f_x[q] − f_eq(ρ_x, u_x)` (zero-gradient non-equilibrium, fixed pressure);
//! - SLIP (normal along axis a): `f_x[reflect_a(q)]` (specular reflection).
//!
//! The momentum a wall link gives the body is `−c_q (f_x[q̄] + pulled_q)`, summed over the cell's wall links.

use crate::domain::{Domain, FLUID, INLET, MOVING_WALL, OUTLET, SLIP_X, SOLID};
use crate::lattice::{C, OPP, Q, REFLECT, W};
use crate::real::Real;
use llull_flow_core::voxel::NO_BODY;

/// Lattice-unit parameters of a run.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Params<T: Real> {
    pub tau: T,
    /// Smagorinsky constant; 0 disables the LES.
    pub smagorinsky: T,
    /// Inflow velocity (INLET faces).
    pub u_in: [T; 3],
    /// Velocity of MOVING_WALL cells.
    pub u_wall: [T; 3],
    /// Uniform body force (acceleration × density 1), e.g. the pressure gradient of a periodic channel.
    pub body_force: [T; 3],
}

impl<T: Real> Params<T> {
    /// The same parameters in another precision.
    pub fn cast<U: Real>(&self) -> Params<U> {
        let v = |x: [T; 3]| [U::of(x[0].to_f64()), U::of(x[1].to_f64()), U::of(x[2].to_f64())];
        Params {
            tau: U::of(self.tau.to_f64()),
            smagorinsky: U::of(self.smagorinsky.to_f64()),
            u_in: v(self.u_in),
            u_wall: v(self.u_wall),
            body_force: v(self.body_force),
        }
    }
}

/// What one fluid cell produces per step.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CellOut<T: Real> {
    pub f: [T; Q],
    pub rho: T,
    pub u: [T; 3],
    /// Momentum given to the linked body this step (lattice units).
    pub force: [T; 3],
}

#[inline]
fn c<T: Real>(q: usize) -> [T; 3] {
    [T::of(f64::from(C[q][0])), T::of(f64::from(C[q][1])), T::of(f64::from(C[q][2]))]
}

#[inline]
fn w<T: Real>(q: usize) -> T {
    T::of(W[q])
}

#[inline]
fn cs2<T: Real>() -> T {
    T::of(crate::lattice::CS2)
}

#[inline]
fn dot<T: Real>(a: [T; 3], b: [T; 3]) -> T {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// `w_q ρ (1 + c·u / c_s² + (c·u)² / (2 c_s⁴) − u² / (2 c_s²))`.
#[inline]
pub fn equilibrium<T: Real>(rho: T, u: [T; 3], q: usize) -> T {
    let cs2 = cs2::<T>();
    let two = T::of(2.0);
    let cu = dot(c::<T>(q), u);
    let uu = dot(u, u);
    w::<T>(q) * rho * (T::of(1.0) + cu / cs2 + cu * cu / (two * cs2 * cs2) - uu / (two * cs2))
}

/// Density and momentum velocity of 19 populations.
#[inline]
pub fn moments<T: Real>(f: &[T; Q]) -> (T, [T; 3]) {
    let mut rho = T::ZERO;
    let mut m = [T::ZERO; 3];
    for (q, value) in f.iter().enumerate() {
        rho += *value;
        let cq = c::<T>(q);
        m[0] += cq[0] * *value;
        m[1] += cq[1] * *value;
        m[2] += cq[2] * *value;
    }
    (rho, [m[0] / rho, m[1] / rho, m[2] / rho])
}

/// Populations at equilibrium for `(rho, u)` (the initial state).
pub fn equilibrium_set<T: Real>(rho: T, u: [T; 3]) -> [T; Q] {
    let mut f = [T::ZERO; Q];
    for (q, value) in f.iter_mut().enumerate() {
        *value = equilibrium(rho, u, q);
    }
    f
}

/// Pulls the populations of fluid cell `cell` from `f_in` (AoS: `cell * Q + q`) and collides them.
/// @invariant `domain.is_fluid(cell)`; every non-periodic neighbour exists (the face layers are set)
pub fn step_cell<T: Real>(domain: &Domain, f_in: &[T], cell: usize, params: &Params<T>) -> CellOut<T> {
    let cs2 = cs2::<T>();
    let two = T::of(2.0);
    let half = T::of(0.5);
    let own: &[T; Q] = f_in[cell * Q..cell * Q + Q].try_into().expect("Q populations per cell");
    let (rho_x, u_x) = moments(own);
    let (i, j, k) = domain.grid.coords(cell);
    let mut pulled = [T::ZERO; Q];
    let mut force = [T::ZERO; 3];
    pulled[0] = own[0];
    for q in 1..Q {
        let source = domain.source(i, j, k, q);
        let flag = source.map_or(SOLID, |s| domain.flags[s]);
        let cq = c::<T>(q);
        let value = match flag {
            FLUID => f_in[source.unwrap_or(cell) * Q + q],
            SOLID | MOVING_WALL => {
                let bounced = own[OPP[q]];
                let moving = if flag == MOVING_WALL { two * w::<T>(q) * rho_x * dot(cq, params.u_wall) / cs2 } else { T::ZERO };
                let value = bounced + moving;
                if source.is_some_and(|s| domain.body[s] != NO_BODY) {
                    let exchanged = bounced + value;
                    force[0] -= cq[0] * exchanged;
                    force[1] -= cq[1] * exchanged;
                    force[2] -= cq[2] * exchanged;
                }
                value
            }
            INLET => equilibrium(rho_x, params.u_in, q),
            OUTLET => equilibrium(T::of(1.0), u_x, q) + own[q] - equilibrium(rho_x, u_x, q),
            _ => own[REFLECT[usize::from(flag - SLIP_X)][q]],
        };
        pulled[q] = value;
    }

    let (rho, m) = {
        let mut rho = T::ZERO;
        let mut m = [T::ZERO; 3];
        for (q, value) in pulled.iter().enumerate() {
            rho += *value;
            let cq = c::<T>(q);
            m[0] += cq[0] * *value;
            m[1] += cq[1] * *value;
            m[2] += cq[2] * *value;
        }
        (rho, m)
    };
    let g = params.body_force;
    let u = [(m[0] + half * g[0]) / rho, (m[1] + half * g[1]) / rho, (m[2] + half * g[2]) / rho];
    let mut feq = [T::ZERO; Q];
    for (q, value) in feq.iter_mut().enumerate() {
        *value = equilibrium(rho, u, q);
    }
    let tau = if params.smagorinsky > T::ZERO {
        let mut pi = [T::ZERO; 6];
        for (q, (value, eq)) in pulled.iter().zip(&feq).enumerate() {
            let neq = *value - *eq;
            let cq = c::<T>(q);
            pi[0] += neq * cq[0] * cq[0];
            pi[1] += neq * cq[1] * cq[1];
            pi[2] += neq * cq[2] * cq[2];
            pi[3] += neq * cq[0] * cq[1];
            pi[4] += neq * cq[0] * cq[2];
            pi[5] += neq * cq[1] * cq[2];
        }
        let q_bar = (pi[0] * pi[0] + pi[1] * pi[1] + pi[2] * pi[2] + two * (pi[3] * pi[3] + pi[4] * pi[4] + pi[5] * pi[5])).sqrt();
        let cs = params.smagorinsky;
        half * (params.tau + (params.tau * params.tau + T::of(18.0) * T::of(std::f64::consts::SQRT_2) * cs * cs * q_bar / rho).sqrt())
    } else {
        params.tau
    };
    let omega = T::of(1.0) / tau;
    let forcing = T::of(1.0) - half * omega;
    let mut f = [T::ZERO; Q];
    for (q, out) in f.iter_mut().enumerate() {
        let cq = c::<T>(q);
        let cu = dot(cq, u);
        let term = [
            (cq[0] - u[0]) / cs2 + cu * cq[0] / (cs2 * cs2),
            (cq[1] - u[1]) / cs2 + cu * cq[1] / (cs2 * cs2),
            (cq[2] - u[2]) / cs2 + cu * cq[2] / (cs2 * cs2),
        ];
        *out = pulled[q] - omega * (pulled[q] - feq[q]) + forcing * w::<T>(q) * dot(term, g);
    }
    CellOut { f, rho, u, force }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::SLIP_Z;
    use llull_flow_core::grid::Grid;

    fn params() -> Params<f32> {
        Params { tau: 0.8, smagorinsky: 0.0, u_in: [0.05, 0.0, 0.0], u_wall: [0.0; 3], body_force: [0.0; 3] }
    }

    #[test]
    fn equilibrium_moments_recover_density_and_velocity_in_both_precisions() {
        let u = [0.03, -0.02, 0.01];
        let f = equilibrium_set(1.05f64, u);
        let (rho, back) = moments(&f);
        assert!((rho - 1.05).abs() < 1e-12);
        for axis in 0..3 {
            assert!((back[axis] - u[axis]).abs() < 1e-12);
        }
        let single = equilibrium_set(1.05f32, [0.03, -0.02, 0.01]);
        let (rho32, _) = moments(&single);
        assert!((rho32 - 1.05).abs() < 1e-6);
        let cast = params().cast::<f64>();
        assert_eq!(cast.u_in[0], f64::from(0.05f32));
    }

    #[test]
    fn a_uniform_equilibrium_is_a_fixed_point_of_the_periodic_step() {
        let grid = Grid::covering([0.0; 3], [3.0; 3], 1.0);
        let domain = Domain::new(grid, [true; 3]);
        let f = equilibrium_set(1.0f32, [0.05, 0.02, -0.01]);
        let f_in: Vec<f32> = (0..27).flat_map(|_| f).collect();
        let out = step_cell(&domain, &f_in, 13, &params());
        for (q, (a, b)) in out.f.iter().zip(&f).enumerate() {
            assert!((a - b).abs() < 1e-6, "q {q}");
        }
        assert_eq!(out.force, [0.0; 3]);
    }

    #[test]
    fn a_wall_link_pushes_the_body_along_the_flow() {
        // Fluid moving +x at cell 1 with a solid body at cell 2 (x = 2): the body feels a +x force.
        let grid = Grid::covering([0.0; 3], [3.0; 3], 1.0);
        let mut domain = Domain::new(grid.clone(), [true; 3]);
        let solid = grid.index(2, 1, 1);
        domain.flags[solid] = SOLID;
        domain.body[solid] = 0;
        domain.bodies = 1;
        let f = equilibrium_set(1.0f64, [0.1, 0.0, 0.0]);
        let f_in: Vec<f64> = (0..27).flat_map(|_| f).collect();
        let out = step_cell(&domain, &f_in, grid.index(1, 1, 1), &params().cast::<f64>());
        assert!(out.force[0] > 0.0, "{:?}", out.force);
        assert!(out.force[1].abs() < 1e-12 && out.force[2].abs() < 1e-12);
        assert!((out.rho - 1.0).abs() < 0.05);
    }

    #[test]
    fn slip_walls_reflect_without_force_and_keep_tangential_momentum() {
        let grid = Grid::covering([0.0; 3], [3.0; 3], 1.0);
        let mut domain = Domain::new(grid.clone(), [true, true, false]);
        domain.set_face(2, false, SLIP_Z);
        domain.set_face(2, true, SLIP_Z);
        let f = equilibrium_set(1.0f32, [0.1, 0.0, 0.0]);
        let f_in: Vec<f32> = (0..27).flat_map(|_| f).collect();
        let out = step_cell(&domain, &f_in, grid.index(1, 1, 1), &params());
        assert_eq!(out.force, [0.0; 3]);
        assert!((out.u[0] - 0.1).abs() < 1e-6, "{:?}", out.u);
        assert!(out.u[2].abs() < 1e-6);
    }
}
