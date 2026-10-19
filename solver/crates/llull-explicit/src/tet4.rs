//! 4-node constant-strain tetrahedron (LS-DYNA R14 Theory Manual §4.6: linear shape functions, one point, no hourglass modes).
//! Gradients use the same unnormalised form as the hexahedron, `B_Ij = V ∂N_I/∂x_j`, so `f_iI = σ_ij B_Ij` and `L_ij = v_iI B_Ij / V`.
//! Characteristic length: the minimum altitude `3V / A_max` (LS-DYNA R14 Theory Manual §25.1).

fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// `B[I] = V ∇N_I` and the signed volume (positive for node 4 on the side of (2−1) × (3−1)).
pub fn gradients(x: &[[f64; 3]; 4]) -> ([[f64; 3]; 4], f64) {
    let a = sub(x[1], x[0]);
    let b = sub(x[2], x[0]);
    let c = sub(x[3], x[0]);
    let det = dot(a, cross(b, c));
    let volume = det / 6.0;
    // ∇N2 = (b × c)/det, ∇N3 = (c × a)/det, ∇N4 = (a × b)/det; V ∇N = (·)/6.
    let g2 = cross(b, c).map(|value| value / 6.0);
    let g3 = cross(c, a).map(|value| value / 6.0);
    let g4 = cross(a, b).map(|value| value / 6.0);
    let g1 = [-(g2[0] + g3[0] + g4[0]), -(g2[1] + g3[1] + g4[1]), -(g2[2] + g3[2] + g4[2])];
    ([g1, g2, g3, g4], volume)
}

/// Minimum altitude `3V / A_max`.
pub fn characteristic_length(x: &[[f64; 3]; 4], volume: f64) -> f64 {
    let faces = [[1, 2, 3], [0, 2, 3], [0, 1, 3], [0, 1, 2]];
    let largest = faces
        .iter()
        .map(|face| {
            let n = cross(sub(x[face[1]], x[face[0]]), sub(x[face[2]], x[face[0]]));
            0.5 * dot(n, n).sqrt()
        })
        .fold(0.0_f64, f64::max);
    3.0 * volume / largest
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_tet_gradients_and_altitude() {
        let x = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
        let (b, volume) = gradients(&x);
        assert!((volume - 1.0 / 6.0).abs() < 1e-15);
        // ∇N1 = (−1, −1, −1), so B_1 = −V(1, 1, 1).
        assert!(b[0].iter().all(|value| (value + 1.0 / 6.0).abs() < 1e-15));
        assert!((b[1][0] - 1.0 / 6.0).abs() < 1e-15 && b[1][1].abs() < 1e-15);
        // Σ_I x_iI B_jI = V δ_ij.
        for i in 0..3 {
            for j in 0..3 {
                let sum: f64 = (0..4).map(|node| x[node][i] * b[node][j]).sum();
                assert!((sum - if i == j { volume } else { 0.0 }).abs() < 1e-15);
            }
        }
        let largest = 0.5 * 3.0_f64.sqrt();
        assert!((characteristic_length(&x, volume) - 0.5 / largest).abs() < 1e-15);
    }
}
