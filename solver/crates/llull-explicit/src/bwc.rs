//! Belytschko–Wong–Chiang improvements of the Belytschko–Tsay shell (LS-DYNA R14 Theory Manual [E2] §9.6, pp. 9-9 to 9-11, read from the
//! rendered pages; PHY-19 TECHNICAL_SPEC §13.10).
//! - Fibers (Eqs. 9.55–9.56): `x = (x_I + ζ̄ p_I) N_I`, `ζ̄ = ζh/2`, with the nodal fibers `p_I` = the shared nodal normals. The in-plane rates
//!   gain the coupling terms of Eqs. 9.57–9.59: `d_xx = b_x v̂_x + ζ̄ (b^c_x v̂_x + b_x ṗ_x)`, `d_yy = b_y v̂_y + ζ̄ (b^c_y v̂_y + b_y ṗ_y)`,
//!   `2d_xy = b_x v̂_y + b_y v̂_x + ζ̄ (b^c_x v̂_y + b_x ṗ_y + b^c_y v̂_x + b_y ṗ_x)`, `ṗ = ω × p`. Eq. 9.60 prints the leading term of `b^c`
//!   (`b^c_x ∝ [p_y2 − p_y4, …]`) and leaves "the details" to the Belytschko papers; here `b^c` is the exact derivative of the centre
//!   gradients `B(ζ̄)` of the fiber-shifted geometry at ζ̄ = 0 (the printed term over 2A plus the change of the area), checked against
//!   finite differences in the tests.
//! - Transverse shear (Eqs. 9.61–9.65): on each side IJ the tangential shear `γ_IJ = (ŵ_J − ŵ_I)/L_IJ + ½(θ_I + θ_J)·r(t)` (Eq. 9.65, with
//!   `r(t) = (t_x, −t_y)` acting on (θ_y, θ_x) so that a rigid rotation is strain free: the printed signs depend on Fig. 9.4's conventions);
//!   the corner value from its two sides (Eqs. 9.63–9.64), solved exactly on the two side tangents (it equals the printed normal-projection
//!   sum on a rectangle); the centre shear `γ = Σ N_I γ_I`, `N_I = ¼` (Eqs. 9.61–9.62).

/// Derivatives `(∂B1/∂ζ̄, ∂B2/∂ζ̄)` of the centre gradients of the corners `p` (element frame) shifted by `ζ̄ q` (`q` = in-plane fiber parts).
pub fn fiber_gradients(p: &[[f64; 2]; 4], q: &[[f64; 2]; 4]) -> ([f64; 4], [f64; 4]) {
    const NATURAL: [(f64, f64); 4] = [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)];
    let jacobian = |c: &[[f64; 2]; 4]| {
        let (mut x_xi, mut x_eta, mut y_xi, mut y_eta) = (0.0, 0.0, 0.0, 0.0);
        for (k, (a, b)) in NATURAL.iter().enumerate() {
            x_xi += 0.25 * a * c[k][0];
            y_xi += 0.25 * a * c[k][1];
            x_eta += 0.25 * b * c[k][0];
            y_eta += 0.25 * b * c[k][1];
        }
        (x_xi, x_eta, y_xi, y_eta)
    };
    let (x_xi, x_eta, y_xi, y_eta) = jacobian(p);
    let (dx_xi, dx_eta, dy_xi, dy_eta) = jacobian(q);
    let det = x_xi * y_eta - x_eta * y_xi;
    let d_det = dx_xi * y_eta + x_xi * dy_eta - dx_eta * y_xi - x_eta * dy_xi;
    let b1: [f64; 4] = std::array::from_fn(|k| (y_eta * 0.25 * NATURAL[k].0 - y_xi * 0.25 * NATURAL[k].1) / det);
    let b2: [f64; 4] = std::array::from_fn(|k| (-x_eta * 0.25 * NATURAL[k].0 + x_xi * 0.25 * NATURAL[k].1) / det);
    let c1 = std::array::from_fn(|k| (dy_eta * 0.25 * NATURAL[k].0 - dy_xi * 0.25 * NATURAL[k].1) / det - b1[k] * d_det / det);
    let c2 = std::array::from_fn(|k| (-dx_eta * 0.25 * NATURAL[k].0 + dx_xi * 0.25 * NATURAL[k].1) / det - b2[k] * d_det / det);
    (c1, c2)
}

/// The centre transverse shear `[γ_xz, γ_yz] = G u` as two rows over `u = [ŵ_k, θ̂x_k, θ̂y_k]` (index `3k + i`), corners `p` in the frame.
pub fn edge_shear(p: &[[f64; 2]; 4]) -> [[f64; 12]; 2] {
    // Tangential shear of side k (k -> k+1) as a row over u.
    let side = |k: usize| -> ([f64; 2], [f64; 12]) {
        let j = (k + 1) % 4;
        let (dx, dy) = (p[j][0] - p[k][0], p[j][1] - p[k][1]);
        let length = (dx * dx + dy * dy).sqrt();
        let t = [dx / length, dy / length];
        let mut row = [0.0; 12];
        row[3 * k] -= 1.0 / length;
        row[3 * j] += 1.0 / length;
        for node in [k, j] {
            row[3 * node + 2] += 0.5 * t[0];
            row[3 * node + 1] -= 0.5 * t[1];
        }
        (t, row)
    };
    let mut centre = [[0.0; 12]; 2];
    for k in 0..4 {
        // Corner k: tangents of its outgoing side (k -> k+1) and incoming side (k-1 -> k); solve [t1; t0] γ = [γ1; γ0].
        let (t1, r1) = side(k);
        let (t0, r0) = side((k + 3) % 4);
        let det = t1[0] * t0[1] - t1[1] * t0[0];
        for i in 0..12 {
            let gx = (t0[1] * r1[i] - t1[1] * r0[i]) / det;
            let gy = (-t0[0] * r1[i] + t1[0] * r0[i]) / det;
            centre[0][i] += 0.25 * gx;
            centre[1][i] += 0.25 * gy;
        }
    }
    centre
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::gradients;

    const DISTORTED: [[f64; 2]; 4] = [[0.0, 0.0], [2.0, 0.3], [1.7, 1.6], [-0.2, 1.1]];

    #[test]
    fn fiber_gradients_are_the_derivative_of_the_shifted_gradients() {
        let q = [[0.03, -0.02], [-0.01, 0.04], [0.02, 0.01], [-0.05, 0.0]];
        let (c1, c2) = fiber_gradients(&DISTORTED, &q);
        let h = 1e-6;
        let shifted = |s: f64| std::array::from_fn(|k| [DISTORTED[k][0] + s * q[k][0], DISTORTED[k][1] + s * q[k][1]]);
        let (plus1, plus2, _) = gradients(&shifted(h));
        let (minus1, minus2, _) = gradients(&shifted(-h));
        for k in 0..4 {
            assert!((c1[k] - (plus1[k] - minus1[k]) / (2.0 * h)).abs() < 1e-7);
            assert!((c2[k] - (plus2[k] - minus2[k]) / (2.0 * h)).abs() < 1e-7);
        }
        let (zero1, zero2) = fiber_gradients(&DISTORTED, &[[0.0; 2]; 4]);
        assert!(zero1.iter().chain(&zero2).all(|value| *value == 0.0), "flat fibers: no coupling");
    }

    #[test]
    fn edge_shear_is_strain_free_in_rigid_rotation_and_exact_for_linear_fields() {
        let g = edge_shear(&DISTORTED);
        let apply = |u: &dyn Fn(usize) -> [f64; 3]| -> [f64; 2] {
            std::array::from_fn(|r| (0..4).map(|k| (0..3).map(|i| g[r][3 * k + i] * u(k)[i]).sum::<f64>()).sum())
        };
        // Rigid rotation about x̂ (θx = 1, ŵ = y) and about ŷ (θy = 1, ŵ = −x): γ = ∇w + (θy, −θx) = 0.
        let about_x = apply(&|k| [DISTORTED[k][1], 1.0, 0.0]);
        let about_y = apply(&|k| [-DISTORTED[k][0], 0.0, 1.0]);
        assert!(about_x.iter().chain(&about_y).all(|value| value.abs() < 1e-12), "{about_x:?} {about_y:?}");
        // A linear ŵ with no rotation: γ = ∇w exactly.
        let slope = apply(&|k| [0.3 * DISTORTED[k][0] - 0.7 * DISTORTED[k][1], 0.0, 0.0]);
        assert!((slope[0] - 0.3).abs() < 1e-12 && (slope[1] + 0.7).abs() < 1e-12);
        // A rectangle reproduces the one-point form γ_xz = B1·ŵ + ¼Σθy, γ_yz = B2·ŵ − ¼Σθx.
        let rectangle = [[0.0, 0.0], [2.0, 0.0], [2.0, 1.0], [0.0, 1.0]];
        let (b1, b2, _) = gradients(&rectangle);
        let r = edge_shear(&rectangle);
        for k in 0..4 {
            assert!((r[0][3 * k] - b1[k]).abs() < 1e-12 && (r[1][3 * k] - b2[k]).abs() < 1e-12);
            assert!((r[0][3 * k + 2] - 0.25).abs() < 1e-12 && (r[1][3 * k + 1] + 0.25).abs() < 1e-12);
        }
    }
}
