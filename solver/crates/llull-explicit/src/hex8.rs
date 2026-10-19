//! 8-node hexahedron with one-point (mean-strain) integration and Flanagan–Belytschko viscous hourglass control.
//!
//! Sources (PHY-19 TECHNICAL_SPEC §13, decision Q10):
//! - Mean-strain gradient operator `B_iI = ∫ N_I,i dV` in closed form: Sierra/SolidMechanics 4.50 Theory Manual (SAND2018-10680) Eq. 15.21
//!   with the nodal permutations of its Table 15.2, after Flanagan & Belytschko (1981, IJNME 17:679–706); `V = (1/3) Σ x_I B_xI` (Eq. 15.12).
//! - Node order: LS-DYNA R14 Theory Manual Fig. 4.1 (1–4 bottom face counter-clockwise, 5–8 above them).
//! - Hourglass base vectors Γ: LS-DYNA R14 Theory Manual Table 4 (§4.3); orthogonalised γ_α = Γ_α − (1/V)(Γ_α·x_i) B_i (Eq. 4.53); viscous
//!   Flanagan–Belytschko form (hourglass type 2, Eq. 4.55) `f_iI = −a_h g_iα γ_αI`, `g_iα = v_iI γ_αI`, `a_h = Q_hg ρ V^{2/3} c / 4` (Eq. 4.49).
//! - Characteristic length `L_e = V / A_max` (largest face area): LS-DYNA R14 Theory Manual §25.1.

/// Nodes substituted for (2, 3, 4, 5, 6, 7, 8) of the node-1 formula when computing node I (SIERRA Table 15.2), 0-based.
const PERMUTATION: [[usize; 7]; 8] = [
    [1, 2, 3, 4, 5, 6, 7],
    [2, 3, 0, 5, 6, 7, 4],
    [3, 0, 1, 6, 7, 4, 5],
    [0, 1, 2, 7, 4, 5, 6],
    [7, 6, 5, 0, 3, 2, 1],
    [4, 7, 6, 1, 0, 3, 2],
    [5, 4, 7, 2, 1, 0, 3],
    [6, 5, 4, 3, 2, 1, 0],
];

/// Hourglass base vectors Γ_α (rows α = 1..4, columns node 1..8): LS-DYNA R14 Theory Manual Table 4.
pub const GAMMA: [[f64; 8]; 4] = [
    [1.0, 1.0, -1.0, -1.0, -1.0, -1.0, 1.0, 1.0],
    [1.0, -1.0, -1.0, 1.0, -1.0, 1.0, 1.0, -1.0],
    [1.0, -1.0, 1.0, -1.0, 1.0, -1.0, 1.0, -1.0],
    [1.0, -1.0, 1.0, -1.0, -1.0, 1.0, -1.0, 1.0],
];

/// Faces as node quadruples (for the characteristic length).
const FACES: [[usize; 4]; 6] = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];

/// SIERRA Eq. 15.21 for node 1 with the coordinates of the 8 nodes in the order `p` (p[0] = node 1, p[1..8] = the permuted nodes 2..8):
/// `[y2(z63 − z45) + y3 z24 + y4(z38 − z52) + y5(z86 − z24) + y6 z52 + y8 z45] / 12`.
fn component(y: &[f64; 8], z: &[f64; 8], node: usize) -> f64 {
    let p = &PERMUTATION[node];
    // n(k) = coordinate index of the node playing "node k" (1-based k = 2..8) of the reference formula.
    let n = |k: usize| p[k - 2];
    let zz = |a: usize, b: usize| z[n(a)] - z[n(b)];
    (y[n(2)] * (zz(6, 3) - zz(4, 5))
        + y[n(3)] * zz(2, 4)
        + y[n(4)] * (zz(3, 8) - zz(5, 2))
        + y[n(5)] * (zz(8, 6) - zz(2, 4))
        + y[n(6)] * zz(5, 2)
        + y[n(8)] * zz(4, 5))
        / 12.0
}

/// Unnormalised mean-strain gradients `B[I] = [B_Ix, B_Iy, B_Iz]` and the volume of a hexahedron with nodal coordinates `x`.
pub fn gradients(x: &[[f64; 3]; 8]) -> ([[f64; 3]; 8], f64) {
    let xs: [f64; 8] = std::array::from_fn(|node| x[node][0]);
    let ys: [f64; 8] = std::array::from_fn(|node| x[node][1]);
    let zs: [f64; 8] = std::array::from_fn(|node| x[node][2]);
    let b: [[f64; 3]; 8] = std::array::from_fn(|node| [component(&ys, &zs, node), component(&zs, &xs, node), component(&xs, &ys, node)]);
    let volume = (0..8).map(|node| xs[node] * b[node][0]).sum::<f64>();
    (b, volume)
}

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn norm(a: [f64; 3]) -> f64 {
    (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt()
}

/// `V / A_max` with each face area taken as half the norm of the cross product of its diagonals.
pub fn characteristic_length(x: &[[f64; 3]; 8], volume: f64) -> f64 {
    let largest =
        FACES.iter().map(|face| 0.5 * norm(cross(sub(x[face[2]], x[face[0]]), sub(x[face[3]], x[face[1]])))).fold(0.0_f64, f64::max);
    volume / largest
}

/// Orthogonalised hourglass vectors γ_α (Eq. 4.53).
pub fn hourglass_vectors(x: &[[f64; 3]; 8], b: &[[f64; 3]; 8], volume: f64) -> [[f64; 8]; 4] {
    std::array::from_fn(|alpha| {
        let gamma = &GAMMA[alpha];
        let projection: [f64; 3] = std::array::from_fn(|i| (0..8).map(|node| gamma[node] * x[node][i]).sum::<f64>());
        std::array::from_fn(|node| {
            gamma[node] - (projection[0] * b[node][0] + projection[1] * b[node][1] + projection[2] * b[node][2]) / volume
        })
    })
}

/// Viscous hourglass forces (added to the external side, i.e. resisting) and the dissipated power `a_h Σ g²` for nodal velocities `v`.
pub fn hourglass_forces(gamma: &[[f64; 8]; 4], v: &[[f64; 3]; 8], a_h: f64) -> ([[f64; 3]; 8], f64) {
    let mut forces = [[0.0; 3]; 8];
    let mut power = 0.0;
    for row in gamma {
        let g: [f64; 3] = std::array::from_fn(|i| (0..8).map(|node| v[node][i] * row[node]).sum::<f64>());
        power += a_h * (g[0] * g[0] + g[1] * g[1] + g[2] * g[2]);
        for node in 0..8 {
            for i in 0..3 {
                forces[node][i] -= a_h * g[i] * row[node];
            }
        }
    }
    (forces, power)
}

/// Lumped (row-sum) nodal masses `ρ ∫ N_I dV` of a trilinear hexahedron by 2 × 2 × 2 Gauss quadrature (exact for the trilinear map).
pub fn lumped_masses(x: &[[f64; 3]; 8], density: f64) -> [f64; 8] {
    const NATURAL: [[f64; 3]; 8] = [
        [-1.0, -1.0, -1.0],
        [1.0, -1.0, -1.0],
        [1.0, 1.0, -1.0],
        [-1.0, 1.0, -1.0],
        [-1.0, -1.0, 1.0],
        [1.0, -1.0, 1.0],
        [1.0, 1.0, 1.0],
        [-1.0, 1.0, 1.0],
    ];
    let point = 1.0 / 3.0_f64.sqrt();
    let mut masses = [0.0; 8];
    for gauss in NATURAL {
        let at = [gauss[0] * point, gauss[1] * point, gauss[2] * point];
        let shape: [f64; 8] = std::array::from_fn(|node| {
            (1.0 + NATURAL[node][0] * at[0]) * (1.0 + NATURAL[node][1] * at[1]) * (1.0 + NATURAL[node][2] * at[2]) / 8.0
        });
        let mut jacobian = [[0.0; 3]; 3];
        for node in 0..8 {
            let n = NATURAL[node];
            let d = [
                n[0] * (1.0 + n[1] * at[1]) * (1.0 + n[2] * at[2]) / 8.0,
                n[1] * (1.0 + n[0] * at[0]) * (1.0 + n[2] * at[2]) / 8.0,
                n[2] * (1.0 + n[0] * at[0]) * (1.0 + n[1] * at[1]) / 8.0,
            ];
            for (row, derivative) in d.iter().enumerate() {
                for (column, coordinate) in x[node].iter().enumerate() {
                    jacobian[row][column] += derivative * coordinate;
                }
            }
        }
        let det = jacobian[0][0] * (jacobian[1][1] * jacobian[2][2] - jacobian[1][2] * jacobian[2][1])
            - jacobian[0][1] * (jacobian[1][0] * jacobian[2][2] - jacobian[1][2] * jacobian[2][0])
            + jacobian[0][2] * (jacobian[1][0] * jacobian[2][1] - jacobian[1][1] * jacobian[2][0]);
        for node in 0..8 {
            masses[node] += density * shape[node] * det;
        }
    }
    masses
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cube(scale: [f64; 3]) -> [[f64; 3]; 8] {
        let unit = [[0., 0., 0.], [1., 0., 0.], [1., 1., 0.], [0., 1., 0.], [0., 0., 1.], [1., 0., 1.], [1., 1., 1.], [0., 1., 1.]];
        unit.map(|p| [p[0] * scale[0], p[1] * scale[1], p[2] * scale[2]])
    }

    #[test]
    fn unit_cube_gradients_are_quarter_face_areas() {
        let (b, volume) = gradients(&cube([1.0, 1.0, 1.0]));
        assert!((volume - 1.0).abs() < 1e-15);
        assert!((b[0][0] + 0.25).abs() < 1e-15 && (b[0][1] + 0.25).abs() < 1e-15 && (b[0][2] + 0.25).abs() < 1e-15);
        assert!((b[6][0] - 0.25).abs() < 1e-15 && (b[6][1] - 0.25).abs() < 1e-15 && (b[6][2] - 0.25).abs() < 1e-15);
        // Every node: B_Ii = (sign of the node's natural coordinate) / 4 on the unit cube.
        let unit = cube([1.0, 1.0, 1.0]);
        for node in 0..8 {
            for i in 0..3 {
                let expected = if unit[node][i] > 0.5 { 0.25 } else { -0.25 };
                assert!((b[node][i] - expected).abs() < 1e-15, "B[{node}][{i}] = {}", b[node][i]);
            }
        }
    }

    #[test]
    fn hourglass_vectors_are_orthogonal_to_linear_fields_on_a_distorted_hex() {
        let mut x = cube([2.0, 1.0, 3.0]);
        x[6] = [2.3, 1.2, 3.4];
        x[1] = [2.1, -0.2, 0.1];
        let (b, volume) = gradients(&x);
        let gamma = hourglass_vectors(&x, &b, volume);
        for row in &gamma {
            for i in 0..3 {
                let dot: f64 = (0..8).map(|node| row[node] * x[node][i]).sum();
                assert!(dot.abs() < 1e-12, "γ·x_{i} = {dot}");
            }
            assert!((0..8).map(|node| row[node]).sum::<f64>().abs() < 1e-12);
        }
    }

    #[test]
    fn row_sum_masses_add_up_to_the_element_mass() {
        let mut x = cube([1.0, 2.0, 3.0]);
        x[7] = [0.2, 2.1, 3.3];
        let (_, volume) = gradients(&x);
        let total: f64 = lumped_masses(&x, 2.0).iter().sum();
        assert!((total - 2.0 * volume).abs() < 1e-12 * volume);
        assert!((characteristic_length(&cube([1.0, 2.0, 4.0]), 8.0) - 1.0).abs() < 1e-15);
    }
}
