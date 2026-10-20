//! Belytschko–Tsay 4-node shell (RS1 RS-8c). Source: LS-DYNA R14 Theory Manual ([E2]) Ch. 9, §13.4, §22.3, §25.3, read from rendered pages
//! (PHY-19 TECHNICAL_SPEC §13.8):
//! - corotational frame `ê3 = (r31 × r42)/|…|`, `ê1 = (r21 − (r21·ê3)ê3)/|…|`, `ê2 = ê3 × ê1` (Eqs. 9.1–9.6); stresses live in it, so no
//!   objective-rate rotation is needed;
//! - one-point rates at the centre (Eqs. 9.22a–g): `d̂x = B1 v̂x + ẑ B1 θ̂y`, `d̂y = B2 v̂y − ẑ B2 θ̂x`, `2d̂xy = B2 v̂x + B1 v̂y + ẑ(B2 θ̂y − B1 θ̂x)`,
//!   `2d̂xz = B1 v̂z + N θ̂y`, `2d̂yz = B2 v̂z − N θ̂x`, `N = ¼`; `B1 = ∂N/∂x̂`, `B2 = ∂N/∂ŷ` at ξ = η = 0 from the centre Jacobian (the closed form
//!   `B1 = (1/2A)[ŷ24, ŷ31, ŷ42, ŷ13]` is checked against it in the tests);
//! - Gauss points through the thickness (default 2, *SECTION_SHELL NIP), resultants `f^R = Σ w σ̂`, `m^R = −Σ w ẑ σ̂` (Eqs. 9.23–9.24);
//! - nodal forces and moments (Eqs. 9.25–9.30) with the shear factor κ (5/6, the *SECTION_SHELL SHRF value the manual suggests for
//!   isotropic materials; its default is 1);
//! - Belytschko–Tsay hourglass (Eqs. 9.31–9.42) with `r = 0.1` (QM default; QB = QW = QM), accumulated as printed in Eq. 9.39
//!   (`Q^{n+1} = Q^n + ΔtQ̇`; the manual calls them viscosity stresses, the equation integrates them like a stiffness: implemented as printed);
//! - plane stress: `σ̂zz = 0` by the elastic estimate of `Δε̂zz` (Eq. 22.3.18) and, when the point yields, secant iterations on it
//!   (Eqs. 22.3.20–22.3.22, tolerance 1e-4, at most 10) around the J2 / Johnson–Cook return of `material.rs`;
//! - time step `L_s / c`, `L_s = A / max(L1..L4)`, `c = √(E/(ρ(1 − ν²)))` (Eqs. 25.13–25.15);
//! - lumped mass `ρAt/4` per node and rotary inertia `αM`, `α = max(t²/12, A/8)` (Eqs. 13.51–13.57 for a mid-surface shell).

use crate::material::{update, von_mises, PointState, Sym};
use crate::model::Material;
use crate::projection::Projection;

/// Transverse shear factor κ (SHRF value suggested for isotropic materials, [E3] *SECTION_SHELL).
pub const SHEAR_FACTOR: f64 = 5.0 / 6.0;
/// Hourglass coefficients r_θ = r_w = r_m (QM default 0.1, QB = QW = QM).
const HOURGLASS: f64 = 0.1;
const NATURAL: [(f64, f64); 4] = [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)];
const H: [f64; 4] = [1.0, -1.0, 1.0, -1.0];

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
fn unit(a: [f64; 3]) -> [f64; 3] {
    let length = dot(a, a).sqrt();
    a.map(|value| value / length)
}

/// Gauss points and weights through the thickness on ẑ ∈ [−t/2, t/2] (weights sum to t).
pub fn thickness_points(points: usize, thickness: f64) -> Vec<(f64, f64)> {
    let half = thickness / 2.0;
    let rule: &[(f64, f64)] = match points {
        1 => &[(0.0, 2.0)],
        2 => &[(-0.577_350_269_189_625_8, 1.0), (0.577_350_269_189_625_8, 1.0)],
        3 => &[(-0.774_596_669_241_483_4, 5.0 / 9.0), (0.0, 8.0 / 9.0), (0.774_596_669_241_483_4, 5.0 / 9.0)],
        4 => &[
            (-0.861_136_311_594_052_6, 0.347_854_845_137_453_9),
            (-0.339_981_043_584_856_3, 0.652_145_154_862_546_1),
            (0.339_981_043_584_856_3, 0.652_145_154_862_546_1),
            (0.861_136_311_594_052_6, 0.347_854_845_137_453_9),
        ],
        _ => &[
            (-0.906_179_845_938_664, 0.236_926_885_056_189_1),
            (-0.538_469_310_105_683_1, 0.478_628_670_499_366_5),
            (0.0, 0.568_888_888_888_888_9),
            (0.538_469_310_105_683_1, 0.478_628_670_499_366_5),
            (0.906_179_845_938_664, 0.236_926_885_056_189_1),
        ],
    };
    rule.iter().map(|&(xi, weight)| (xi * half, weight * half)).collect()
}

/// Corotational frame (columns ê1, ê2, ê3) of a quad with corners `x`.
pub fn frame(x: &[[f64; 3]; 4]) -> [[f64; 3]; 3] {
    let e3 = unit(cross(sub(x[2], x[0]), sub(x[3], x[1])));
    let r21 = sub(x[1], x[0]);
    let along = dot(r21, e3);
    let e1 = unit([r21[0] - along * e3[0], r21[1] - along * e3[1], r21[2] - along * e3[2]]);
    [e1, cross(e3, e1), e3]
}

fn local(frame: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    [dot(frame[0], v), dot(frame[1], v), dot(frame[2], v)]
}

fn global(frame: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|i| frame[0][i] * v[0] + frame[1][i] * v[1] + frame[2][i] * v[2])
}

/// `B1`, `B2` (∂N_I/∂x̂, ∂N_I/∂ŷ at the centre) and the area `4 det J(0, 0)` of the quad with local in-plane coordinates `p`.
pub fn gradients(p: &[[f64; 2]; 4]) -> ([f64; 4], [f64; 4], f64) {
    let (mut x_xi, mut x_eta, mut y_xi, mut y_eta) = (0.0, 0.0, 0.0, 0.0);
    for (k, (a, b)) in NATURAL.iter().enumerate() {
        x_xi += 0.25 * a * p[k][0];
        y_xi += 0.25 * a * p[k][1];
        x_eta += 0.25 * b * p[k][0];
        y_eta += 0.25 * b * p[k][1];
    }
    let det = x_xi * y_eta - x_eta * y_xi;
    let b1 = std::array::from_fn(|k| (y_eta * 0.25 * NATURAL[k].0 - y_xi * 0.25 * NATURAL[k].1) / det);
    let b2 = std::array::from_fn(|k| (-x_eta * 0.25 * NATURAL[k].0 + x_xi * 0.25 * NATURAL[k].1) / det);
    (b1, b2, 4.0 * det)
}

/// Lumped translational mass per node and rotary inertia per node of one shell.
pub fn masses(x: &[[f64; 3]; 4], thickness: f64, density: f64) -> (f64, f64) {
    let f = frame(x);
    let p: [[f64; 2]; 4] = std::array::from_fn(|k| {
        let l = local(&f, sub(x[k], x[0]));
        [l[0], l[1]]
    });
    let (_, _, area) = gradients(&p);
    let mass = density * area * thickness / 4.0;
    (mass, mass * (thickness * thickness / 12.0).max(area / 8.0))
}

/// State of one shell between steps.
#[derive(Debug, Clone, PartialEq)]
pub struct ShellState {
    pub points: Vec<PointState>,
    /// Hourglass resultants Q^B_x, Q^B_y, Q^B_3, Q^M_x, Q^M_y (Eqs. 9.36–9.39).
    pub hourglass: [f64; 5],
}

impl ShellState {
    pub fn new(points: usize, temperature: f64) -> ShellState {
        ShellState { points: vec![PointState { temperature, ..PointState::default() }; points], hourglass: [0.0; 5] }
    }

    /// Eroded: every point through the thickness failed (llull rule, §13.9).
    pub fn failed(&self) -> bool {
        self.points.iter().all(|point| point.failed)
    }
}

/// What a shell contributes in a step (global nodal forces and moments, both on the internal side).
pub struct ShellStep {
    pub state: ShellState,
    pub forces: [[f64; 3]; 4],
    pub moments: [[f64; 3]; 4],
    pub internal_work: f64,
    pub hourglass_work: f64,
    pub dt: f64,
    pub von_mises: f64,
    pub plastic_strain: f64,
}

/// Plane-stress update of one point: Δε̂zz from the elastic estimate (Eq. 22.3.18), then secant iterations when it yields (Eqs. 22.3.20–22).
fn plane_stress(material: &Material, state: &PointState, d: Sym, dt: f64) -> PointState {
    let lambda = material.lambda();
    let mu = material.shear();
    let with = |dzz: f64| {
        let mut rate = d;
        rate[2] = dzz;
        update(material, state, &rate, &[0.0; 3], dt)
    };
    let elastic = -(state.stress[2] / dt + lambda * (d[0] + d[1])) / (lambda + 2.0 * mu);
    let first = with(elastic);
    if material.johnson_cook.is_none() || first.plastic_strain == state.plastic_strain {
        return first;
    }
    // Secant on the zz rate between the elastic estimate and the purely plastic one (−(d11 + d22)).
    let (mut a, mut b) = (elastic, -(d[0] + d[1]));
    let (mut fa, mut fb) = (first.stress[2], with(b).stress[2]);
    for _ in 0..10 {
        if fb == fa {
            break;
        }
        let next = b - (b - a) / (fb - fa) * fb;
        a = b;
        fa = fb;
        b = next;
        fb = with(b).stress[2];
        if (b - a).abs() <= 1e-4 * b.abs().max(1e-30) {
            break;
        }
    }
    with(b)
}

/// One step of a shell: corners `x0` → `x1`, translational velocities `v` and angular velocities `w` (global) at n+½.
#[allow(clippy::too_many_arguments)]
pub fn step(
    material: &Material,
    thickness: f64,
    state: &ShellState,
    x0: &[[f64; 3]; 4],
    x1: &[[f64; 3]; 4],
    v: &[[f64; 3]; 4],
    w: &[[f64; 3]; 4],
    dt: f64,
    normals: Option<&[[f64; 3]; 4]>,
) -> ShellStep {
    if state.failed() {
        // Eroded (every point reached Johnson-Cook damage 1): no forces, no moments, out of the step computation; the nodes keep their mass.
        return ShellStep {
            state: state.clone(),
            forces: [[0.0; 3]; 4],
            moments: [[0.0; 3]; 4],
            internal_work: 0.0,
            hourglass_work: 0.0,
            dt: f64::INFINITY,
            von_mises: 0.0,
            plastic_strain: state.points.iter().map(|point| point.plastic_strain).fold(0.0, f64::max),
        };
    }
    let mid: [[f64; 3]; 4] = std::array::from_fn(|k| std::array::from_fn(|i| 0.5 * (x0[k][i] + x1[k][i])));
    let f = frame(&mid);
    let p: [[f64; 2]; 4] = std::array::from_fn(|k| {
        let l = local(&f, sub(mid[k], mid[0]));
        [l[0], l[1]]
    });
    let (b1, b2, area) = gradients(&p);
    let vl: [[f64; 3]; 4] = std::array::from_fn(|k| local(&f, v[k]));
    let tl: [[f64; 3]; 4] = std::array::from_fn(|k| local(&f, w[k]));
    // Warping stiffness (BWC = 1, full projection): project the nodal velocities before the rates (§11.6 Eq. 11.28).
    let warp = normals.map(|normals| {
        let centre: [f64; 3] = std::array::from_fn(|i| 0.25 * (0..4).map(|k| mid[k][i]).sum::<f64>());
        Projection::new(&std::array::from_fn(|k| local(&f, sub(mid[k], centre))), &normals.map(|n| local(&f, n)))
    });
    let (vl, tl) = match &warp {
        Some(warp) => warp.apply(&vl, &tl),
        None => (vl, tl),
    };
    let sum = |b: &[f64; 4], c: &dyn Fn(usize) -> f64| (0..4).map(|k| b[k] * c(k)).sum::<f64>();
    let n = 0.25;
    let membrane = [sum(&b1, &|k| vl[k][0]), sum(&b2, &|k| vl[k][1]), sum(&b2, &|k| vl[k][0]) + sum(&b1, &|k| vl[k][1])];
    let bending = [sum(&b1, &|k| tl[k][1]), -sum(&b2, &|k| tl[k][0]), sum(&b2, &|k| tl[k][1]) - sum(&b1, &|k| tl[k][0])];
    let shear_xz = sum(&b1, &|k| vl[k][2]) + n * (0..4).map(|k| tl[k][1]).sum::<f64>();
    let shear_yz = sum(&b2, &|k| vl[k][2]) - n * (0..4).map(|k| tl[k][0]).sum::<f64>();
    let points = thickness_points(state.points.len(), thickness);
    let mut next = state.clone();
    let (mut fr, mut mr) = ([0.0; 5], [0.0; 3]);
    let mut work = 0.0;
    let (mut vm, mut eps) = (0.0_f64, 0.0_f64);
    for (index, &(z, weight)) in points.iter().enumerate() {
        // Rates [xx, yy, zz, xy, yz, zx] (tensor shear = ½ engineering).
        let d: Sym = [
            membrane[0] + z * bending[0],
            membrane[1] + z * bending[1],
            0.0,
            0.5 * (membrane[2] + z * bending[2]),
            0.5 * shear_yz,
            0.5 * shear_xz,
        ];
        let old = state.points[index];
        let updated = plane_stress(material, &old, d, dt);
        let s = updated.stress;
        let mean: Sym = std::array::from_fn(|k| 0.5 * (old.stress[k] + s[k]));
        let power = mean[0] * d[0] + mean[1] * d[1] + mean[2] * d[2] + 2.0 * (mean[3] * d[3] + mean[4] * d[4] + mean[5] * d[5]);
        work += weight * power * area * dt;
        fr = [fr[0] + weight * s[0], fr[1] + weight * s[1], fr[2] + weight * s[3], fr[3] + weight * s[5], fr[4] + weight * s[4]];
        mr = [mr[0] - weight * z * s[0], mr[1] - weight * z * s[1], mr[2] - weight * z * s[3]];
        vm = vm.max(von_mises(&s));
        eps = eps.max(updated.plastic_strain);
        next.points[index] = updated;
    }
    let [fxx, fyy, fxy, fxz, fyz] = fr;
    let [mxx, myy, mxy] = mr;
    let kappa = SHEAR_FACTOR;
    let mut force_local = [[0.0; 3]; 4];
    let mut moment_local = [[0.0; 3]; 4];
    for k in 0..4 {
        force_local[k] =
            [area * (b1[k] * fxx + b2[k] * fxy), area * (b2[k] * fyy + b1[k] * fxy), area * kappa * (b1[k] * fxz + b2[k] * fyz)];
        moment_local[k] =
            [area * (b2[k] * myy + b1[k] * mxy - kappa / 4.0 * fyz), -area * (b1[k] * mxx + b2[k] * mxy - kappa / 4.0 * fxz), 0.0];
    }
    // Belytschko-Tsay hourglass (Eqs. 9.31-9.42).
    let projection = [(0..4).map(|k| H[k] * p[k][0]).sum::<f64>(), (0..4).map(|k| H[k] * p[k][1]).sum::<f64>()];
    let tau: [f64; 4] = std::array::from_fn(|k| H[k] - (projection[0] * b1[k] + projection[1] * b2[k]));
    let bb = (0..4).map(|k| b1[k] * b1[k] + b2[k] * b2[k]).sum::<f64>();
    let (e, g) = (material.youngs_modulus, material.shear());
    let t = thickness;
    let rates = [
        (0..4).map(|k| tau[k] * tl[k][0]).sum::<f64>(),
        (0..4).map(|k| tau[k] * tl[k][1]).sum::<f64>(),
        (0..4).map(|k| tau[k] * vl[k][2]).sum::<f64>(),
        (0..4).map(|k| tau[k] * vl[k][0]).sum::<f64>(),
        (0..4).map(|k| tau[k] * vl[k][1]).sum::<f64>(),
    ];
    let bending_scale = HOURGLASS * e * t.powi(3) * area / 192.0 * bb;
    let warping_scale = HOURGLASS * kappa * g * t.powi(3) * area / 12.0 * bb;
    let membrane_scale = HOURGLASS * e * t * area / 8.0 * bb;
    let scales = [bending_scale, bending_scale, warping_scale, membrane_scale, membrane_scale];
    let mut hourglass_power = 0.0;
    for a in 0..5 {
        next.hourglass[a] = state.hourglass[a] + dt * scales[a] * rates[a];
        hourglass_power += next.hourglass[a] * rates[a];
    }
    let q = next.hourglass;
    for k in 0..4 {
        moment_local[k][0] += tau[k] * q[0];
        moment_local[k][1] += tau[k] * q[1];
        force_local[k][2] += tau[k] * q[2];
        force_local[k][0] += tau[k] * q[3];
        force_local[k][1] += tau[k] * q[4];
    }
    if let Some(warp) = &warp {
        (force_local, moment_local) = warp.apply(&force_local, &moment_local);
    }
    let forces = std::array::from_fn(|k| global(&f, force_local[k]));
    let moments = std::array::from_fn(|k| global(&f, moment_local[k]));
    // Time step (Eqs. 25.13-25.15) on the end-of-step geometry.
    let lengths = (0..4).map(|k| dot(sub(x1[(k + 1) % 4], x1[k]), sub(x1[(k + 1) % 4], x1[k])).sqrt()).fold(0.0, f64::max);
    let speed = (e / (material.density * (1.0 - material.poisson * material.poisson))).sqrt();
    ShellStep {
        state: next,
        forces,
        moments,
        internal_work: work,
        hourglass_work: hourglass_power * dt,
        dt: area / lengths / speed,
        von_mises: vm,
        plastic_strain: eps,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn centre_gradients_match_the_one_point_closed_form() {
        let p = [[0.0, 0.0], [2.0, 0.1], [2.3, 1.4], [-0.2, 1.1]];
        let (b1, b2, area) = gradients(&p);
        let (x, y) = (p.map(|q| q[0]), p.map(|q| q[1]));
        // Shoelace area of the quad.
        let shoelace = 0.5 * (0..4).map(|k| x[k] * y[(k + 1) % 4] - x[(k + 1) % 4] * y[k]).sum::<f64>();
        assert!((area - shoelace).abs() < 1e-12);
        let closed_b1 = [y[1] - y[3], y[2] - y[0], y[3] - y[1], y[0] - y[2]].map(|v| v / (2.0 * area));
        let closed_b2 = [x[3] - x[1], x[0] - x[2], x[1] - x[3], x[2] - x[0]].map(|v| v / (2.0 * area));
        for k in 0..4 {
            assert!((b1[k] - closed_b1[k]).abs() < 1e-12 && (b2[k] - closed_b2[k]).abs() < 1e-12);
        }
        // A linear field u = a x + b y is differentiated exactly.
        let u: Vec<f64> = (0..4).map(|k| 3.0 * x[k] - 2.0 * y[k]).collect();
        assert!(((0..4).map(|k| b1[k] * u[k]).sum::<f64>() - 3.0).abs() < 1e-12);
        assert!(((0..4).map(|k| b2[k] * u[k]).sum::<f64>() + 2.0).abs() < 1e-12);
    }

    #[test]
    fn membrane_stretch_gives_the_plane_stress_modulus() {
        let material =
            Material { density: 7.85e-9, youngs_modulus: 200_000.0, poisson: 0.3, johnson_cook: None, failure: None, heating: None };
        let x0 = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0]];
        // v = (x, 0, 0): unit strain rate along x for dt.
        let v = x0.map(|p| [p[0], 0.0, 0.0]);
        let dt = 1e-6;
        let x1 = std::array::from_fn(|k| [x0[k][0] + dt * v[k][0], x0[k][1], 0.0]);
        let state = ShellState::new(2, 293.15);
        let result = step(&material, 0.1, &state, &x0, &x1, &v, &[[0.0; 3]; 4], dt, None);
        let s = result.state.points[0].stress;
        let modulus = 200_000.0 / (1.0 - 0.09);
        assert!((s[0] / (modulus * dt) - 1.0).abs() < 1e-6, "σxx {}", s[0]);
        assert!((s[1] / (0.3 * modulus * dt) - 1.0).abs() < 1e-6, "σyy {}", s[1]);
        assert!(s[2].abs() < 1e-9 * s[0], "plane stress: σzz {}", s[2]);
    }
}
