//! Element stiffness matrices for E = 1 (TECHNICAL_SPEC §5.3, TR-TOP-05), row-major, DOFs ordered node by node in
//! [`crate::grid::LOCAL_NODES`] order (x, y[, z] per node).
//!
//! - 2D: bilinear Q4 plane stress on the unit square, thickness 1: top88's closed form `(A + ν B) / (24 (1 − ν²))`
//!   with its integer blocks. KE\[0\]\[0\] = (12 − 4ν)/(24(1 − ν²)), KE\[0\]\[1\] = (3 + 3ν)/(24(1 − ν²)). A square element's
//!   in-plane stiffness does not depend on its size, so the operator scales it by E·t only.
//! - 3D: trilinear H8 on the unit cube, 2 × 2 × 2 Gauss integration of Bᵀ D B (exact for this element). A cube of edge h
//!   has stiffness h · KE, so the operator scales it by E·h.

/// The 8 × 8 Q4 plane-stress stiffness of top88 (E = 1, t = 1, unit square).
pub fn q4_plane_stress(nu: f64) -> Vec<f64> {
    const A11: [[f64; 4]; 4] = [[12.0, 3.0, -6.0, -3.0], [3.0, 12.0, 3.0, 0.0], [-6.0, 3.0, 12.0, -3.0], [-3.0, 0.0, -3.0, 12.0]];
    const A12: [[f64; 4]; 4] = [[-6.0, -3.0, 0.0, 3.0], [-3.0, -6.0, -3.0, -6.0], [0.0, -3.0, -6.0, 3.0], [3.0, -6.0, 3.0, -6.0]];
    const B11: [[f64; 4]; 4] = [[-4.0, 3.0, -2.0, 9.0], [3.0, -4.0, -9.0, 4.0], [-2.0, -9.0, -4.0, -3.0], [9.0, 4.0, -3.0, -4.0]];
    const B12: [[f64; 4]; 4] = [[2.0, -3.0, 4.0, -9.0], [-3.0, 2.0, 9.0, -2.0], [4.0, 9.0, 2.0, 3.0], [-9.0, -2.0, 3.0, 2.0]];
    let block = |p11: &[[f64; 4]; 4], p12: &[[f64; 4]; 4], i: usize, j: usize| -> f64 {
        match (i < 4, j < 4) {
            (true, true) => p11[i][j],
            (true, false) => p12[i][j - 4],
            (false, true) => p12[j][i - 4],
            (false, false) => p11[i - 4][j - 4],
        }
    };
    let factor = 1.0 / (1.0 - nu * nu) / 24.0;
    let mut ke = vec![0.0; 64];
    for i in 0..8 {
        for j in 0..8 {
            ke[i * 8 + j] = factor * (block(&A11, &A12, i, j) + nu * block(&B11, &B12, i, j));
        }
    }
    ke
}

/// The 24 × 24 H8 stiffness of the unit cube (E = 1), isotropic, 2 × 2 × 2 Gauss.
pub fn h8(nu: f64) -> Vec<f64> {
    let lambda = nu / ((1.0 + nu) * (1.0 - 2.0 * nu));
    let mu = 1.0 / (2.0 * (1.0 + nu));
    let mut d = [[0.0; 6]; 6];
    for (a, row) in d.iter_mut().enumerate().take(3) {
        for (b, value) in row.iter_mut().enumerate().take(3) {
            *value = lambda + if a == b { 2.0 * mu } else { 0.0 };
        }
    }
    for (a, row) in d.iter_mut().enumerate().skip(3) {
        row[a] = mu;
    }
    let g = 0.5 / 3f64.sqrt();
    let points = [0.5 - g, 0.5 + g];
    let mut ke = vec![0.0; 24 * 24];
    for &x in &points {
        for &y in &points {
            for &z in &points {
                let mut b = [[0.0; 24]; 6];
                for (a, [ox, oy, oz]) in crate::grid::LOCAL_NODES.iter().enumerate() {
                    let f = |o: usize, t: f64| if o == 1 { t } else { 1.0 - t };
                    let s = |o: usize| if o == 1 { 1.0 } else { -1.0 };
                    let dx = s(*ox) * f(*oy, y) * f(*oz, z);
                    let dy = f(*ox, x) * s(*oy) * f(*oz, z);
                    let dz = f(*ox, x) * f(*oy, y) * s(*oz);
                    let c = a * 3;
                    b[0][c] = dx;
                    b[1][c + 1] = dy;
                    b[2][c + 2] = dz;
                    b[3][c] = dy;
                    b[3][c + 1] = dx;
                    b[4][c + 1] = dz;
                    b[4][c + 2] = dy;
                    b[5][c] = dz;
                    b[5][c + 2] = dx;
                }
                let mut db = [[0.0; 24]; 6];
                for r in 0..6 {
                    for c in 0..24 {
                        db[r][c] = (0..6).map(|m| d[r][m] * b[m][c]).sum();
                    }
                }
                for i in 0..24 {
                    for j in 0..24 {
                        ke[i * 24 + j] += 0.125 * (0..6).map(|m| b[m][i] * db[m][j]).sum::<f64>();
                    }
                }
            }
        }
    }
    ke
}

/// The unit element matrix of a `dim`-dimensional grid.
pub fn element_matrix(dim: usize, nu: f64) -> Vec<f64> {
    if dim == 3 {
        h8(nu)
    } else {
        q4_plane_stress(nu)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel(a: f64, b: f64) -> f64 {
        (a - b).abs() / b.abs()
    }

    #[test]
    fn q4_matches_the_closed_forms_of_vc_top_01() {
        let nu = 0.3;
        let ke = q4_plane_stress(nu);
        assert!(rel(ke[0], (12.0 - 4.0 * nu) / (24.0 * (1.0 - nu * nu))) < 1e-12);
        assert!(rel(ke[1], (3.0 + 3.0 * nu) / (24.0 * (1.0 - nu * nu))) < 1e-12);
        // expected_results.json VC-TOP-01.a/b (printed to 12 significant digits)
        assert!(rel(ke[0], 0.494505494505) < 1e-11);
        assert!(rel(ke[1], 0.178571428571) < 1e-11);
        for i in 0..8 {
            assert!(ke[i * 8..i * 8 + 8].iter().sum::<f64>().abs() < 1e-14, "row {i} does not sum to zero");
            for j in 0..8 {
                assert_eq!(ke[i * 8 + j], ke[j * 8 + i]);
            }
        }
    }

    #[test]
    fn h8_matches_its_closed_forms_and_has_six_rigid_modes() {
        let nu = 0.3;
        let ke = h8(nu);
        let scale = (1.0 + nu) * (1.0 - 2.0 * nu);
        assert!(rel(ke[0], (2.0 - 3.0 * nu) / (9.0 * scale)) < 1e-12);
        assert!(rel(ke[1], 1.0 / (24.0 * scale)) < 1e-12);
        for i in 0..24 {
            for j in 0..24 {
                assert!((ke[i * 24 + j] - ke[j * 24 + i]).abs() < 1e-15);
            }
        }
        // translations and rotations about the cube centre carry no energy
        let coords: Vec<[f64; 3]> = crate::grid::LOCAL_NODES.iter().map(|o| o.map(|v| v as f64 - 0.5)).collect();
        let modes: [fn([f64; 3]) -> [f64; 3]; 6] = [
            |_| [1.0, 0.0, 0.0],
            |_| [0.0, 1.0, 0.0],
            |_| [0.0, 0.0, 1.0],
            |[x, y, _]| [-y, x, 0.0],
            |[_, y, z]| [0.0, -z, y],
            |[x, _, z]| [z, 0.0, -x],
        ];
        for mode in modes {
            let u: Vec<f64> = coords.iter().flat_map(|&p| mode(p)).collect();
            for i in 0..24 {
                let f: f64 = (0..24).map(|j| ke[i * 24 + j] * u[j]).sum();
                assert!(f.abs() < 1e-14, "rigid mode produces force {f}");
            }
        }
    }
}
