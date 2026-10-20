//! Belytschko–Leviathan projection for warped Belytschko–Tsay shells (LS-DYNA R14 Theory Manual §11.6 Eq. 11.28,
//! `P = I − R(RᵀR)⁻¹Rᵀ`; the warping stiffness of *CONTROL_SHELL BWC = 1 with the full projection PROJ = 1, Keyword Manual Vol. I).
//! The 24 nodal velocity components (per node: 3 translations, 3 rotations, in the element frame) are projected before the strain rates,
//! and the nodal forces and moments after, so the internal power stays invariant. The 7 columns of R are the 3 rigid rotations
//! about the element centroid (translation `e_a × x̂_I`, rotation `e_a` at every node) and the 4 nodal drill rotations (rotation about
//! the nodal normal at one node: the nodal fiber of the Belytschko–Leviathan element, shared by the shells around the node, so that
//! neighbours free the same drill axis; about each element's own normal, two warped neighbours nearly hinge about their common edge). About the centroid, `Σ_I e_a × x̂_I = 0`: rigid translations are orthogonal to R and pass unchanged.

/// Nodal vectors in the element frame: translations (or forces) and rotations (or moments) of the 4 nodes.
pub type NodalPair = ([[f64; 3]; 4], [[f64; 3]; 4]);

/// The projector of one element, built from the nodal coordinates in the element frame relative to the centroid.
pub struct Projection {
    modes: [[f64; 24]; 7],
    /// `(RᵀR)⁻¹`, symmetric.
    inverse: [[f64; 7]; 7],
}

fn pack(translation: &[[f64; 3]; 4], rotation: &[[f64; 3]; 4]) -> [f64; 24] {
    let mut out = [0.0; 24];
    for k in 0..4 {
        for i in 0..3 {
            out[6 * k + i] = translation[k][i];
            out[6 * k + 3 + i] = rotation[k][i];
        }
    }
    out
}

impl Projection {
    /// `x`: nodal coordinates in the element frame, relative to the centroid (z holds the warpage); `normals`: unit nodal normals in
    /// the element frame.
    pub fn new(x: &[[f64; 3]; 4], normals: &[[f64; 3]; 4]) -> Projection {
        let mut modes = [[0.0; 24]; 7];
        for (a, mode) in modes.iter_mut().take(3).enumerate() {
            let axis: [f64; 3] = std::array::from_fn(|i| if i == a { 1.0 } else { 0.0 });
            let translation =
                x.map(|p| [axis[1] * p[2] - axis[2] * p[1], axis[2] * p[0] - axis[0] * p[2], axis[0] * p[1] - axis[1] * p[0]]);
            *mode = pack(&translation, &[axis; 4]);
        }
        for node in 0..4 {
            for i in 0..3 {
                modes[3 + node][6 * node + 3 + i] = normals[node][i];
            }
        }
        let mut gram = [[0.0; 7]; 7];
        for i in 0..7 {
            for j in 0..7 {
                gram[i][j] = (0..24).map(|k| modes[i][k] * modes[j][k]).sum();
            }
        }
        Projection { modes, inverse: invert(gram) }
    }

    /// `P u` for the nodal pair `(translations, rotations)`; P is symmetric, so forces and moments use the same call.
    pub fn apply(&self, translation: &[[f64; 3]; 4], rotation: &[[f64; 3]; 4]) -> NodalPair {
        let u = pack(translation, rotation);
        let rt_u: [f64; 7] = std::array::from_fn(|i| (0..24).map(|k| self.modes[i][k] * u[k]).sum());
        let c: [f64; 7] = std::array::from_fn(|i| (0..7).map(|j| self.inverse[i][j] * rt_u[j]).sum());
        let projected: [f64; 24] = std::array::from_fn(|k| u[k] - (0..7).map(|i| self.modes[i][k] * c[i]).sum::<f64>());
        let t = std::array::from_fn(|n| [projected[6 * n], projected[6 * n + 1], projected[6 * n + 2]]);
        let r = std::array::from_fn(|n| [projected[6 * n + 3], projected[6 * n + 4], projected[6 * n + 5]]);
        (t, r)
    }
}

/// Gauss–Jordan inverse with partial pivoting of the (symmetric positive definite) 7×7 Gram matrix.
fn invert(mut a: [[f64; 7]; 7]) -> [[f64; 7]; 7] {
    let mut inv: [[f64; 7]; 7] = std::array::from_fn(|i| std::array::from_fn(|j| if i == j { 1.0 } else { 0.0 }));
    for col in 0..7 {
        let pivot = (col..7).max_by(|&p, &q| a[p][col].abs().total_cmp(&a[q][col].abs())).unwrap_or(col);
        a.swap(col, pivot);
        inv.swap(col, pivot);
        let d = a[col][col];
        for j in 0..7 {
            a[col][j] /= d;
            inv[col][j] /= d;
        }
        for row in 0..7 {
            if row != col {
                let factor = a[row][col];
                for j in 0..7 {
                    a[row][j] -= factor * a[col][j];
                    inv[row][j] -= factor * inv[col][j];
                }
            }
        }
    }
    inv
}

#[cfg(test)]
mod tests {
    use super::*;

    fn warped() -> [[f64; 3]; 4] {
        [[-1.0, -0.5, 0.1], [1.0, -0.5, -0.1], [1.0, 0.5, 0.1], [-1.0, 0.5, -0.1]]
    }

    #[test]
    fn rigid_rotations_and_drills_are_removed_and_translations_kept() {
        let x = warped();
        let projection = Projection::new(&x, &[[0.0, 0.0, 1.0]; 4]);
        let omega = [0.3, -0.7, 1.1];
        let v = x.map(|p| [omega[1] * p[2] - omega[2] * p[1], omega[2] * p[0] - omega[0] * p[2], omega[0] * p[1] - omega[1] * p[0]]);
        let (t, r) = projection.apply(&v, &[omega; 4]);
        assert!(t.iter().chain(r.iter()).flatten().all(|c| c.abs() < 1e-12), "rigid rotation projects to zero");
        let drill = [[0.0, 0.0, 2.0], [0.0; 3], [0.0; 3], [0.0; 3]];
        let (t, r) = projection.apply(&[[0.0; 3]; 4], &drill);
        assert!(t.iter().chain(r.iter()).flatten().all(|c| c.abs() < 1e-12), "a nodal drill projects to zero");
        let shift = [[0.4, -0.2, 0.9]; 4];
        let (t, r) = projection.apply(&shift, &[[0.0; 3]; 4]);
        assert!((0..4).all(|k| (0..3).all(|i| (t[k][i] - shift[k][i]).abs() < 1e-12 && r[k][i].abs() < 1e-12)), "translation kept");
    }

    #[test]
    fn the_projector_is_idempotent() {
        let projection = Projection::new(&warped(), &[[0.0, 0.0, 1.0]; 4]);
        let t = [[0.1, 0.2, -0.3], [0.5, -0.1, 0.0], [-0.2, 0.3, 0.7], [0.0, 0.0, 0.1]];
        let r = [[0.2, 0.0, 0.4], [-0.1, 0.3, 0.0], [0.0, 0.5, -0.2], [0.1, 0.1, 0.1]];
        let (t1, r1) = projection.apply(&t, &r);
        let (t2, r2) = projection.apply(&t1, &r1);
        assert!((0..4).all(|k| (0..3).all(|i| (t1[k][i] - t2[k][i]).abs() < 1e-12 && (r1[k][i] - r2[k][i]).abs() < 1e-12)));
    }
}
