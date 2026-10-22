//! The D3Q19 lattice: 19 discrete velocities, their weights, opposites and the specular reflections about each axis. The
//! lattice speed of sound is `c_s² = 1/3` (lattice units: cell 1, time step 1, reference density 1).

/// Number of discrete velocities.
pub const Q: usize = 19;

/// Discrete velocities `c_q` (the rest particle first, then the six axis neighbours, then the twelve edge neighbours).
pub const C: [[i32; 3]; Q] = [
    [0, 0, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
    [1, 1, 0],
    [-1, -1, 0],
    [1, -1, 0],
    [-1, 1, 0],
    [1, 0, 1],
    [-1, 0, -1],
    [1, 0, -1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, -1],
    [0, 1, -1],
    [0, -1, 1],
];

/// Weights `w_q` (f64; the f32 twin and the WGSL kernel round them once).
pub const W: [f64; Q] = [
    1.0 / 3.0,
    1.0 / 18.0,
    1.0 / 18.0,
    1.0 / 18.0,
    1.0 / 18.0,
    1.0 / 18.0,
    1.0 / 18.0,
    1.0 / 36.0,
    1.0 / 36.0,
    1.0 / 36.0,
    1.0 / 36.0,
    1.0 / 36.0,
    1.0 / 36.0,
    1.0 / 36.0,
    1.0 / 36.0,
    1.0 / 36.0,
    1.0 / 36.0,
    1.0 / 36.0,
    1.0 / 36.0,
];

/// `OPP[q]` has velocity `−c_q`.
pub const OPP: [usize; Q] = [0, 2, 1, 4, 3, 6, 5, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15, 18, 17];

/// `REFLECT[axis][q]` has velocity `c_q` with component `axis` negated (specular reflection about a wall normal to `axis`).
pub const REFLECT: [[usize; Q]; 3] = [
    [0, 2, 1, 3, 4, 5, 6, 10, 9, 8, 7, 14, 13, 12, 11, 15, 16, 17, 18],
    [0, 1, 2, 4, 3, 5, 6, 9, 10, 7, 8, 11, 12, 13, 14, 18, 17, 16, 15],
    [0, 1, 2, 3, 4, 6, 5, 7, 8, 9, 10, 13, 14, 11, 12, 17, 18, 15, 16],
];

/// Lattice speed of sound squared.
pub const CS2: f64 = 1.0 / 3.0;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weights_sum_to_one_and_velocities_are_isotropic() {
        let total: f64 = W.iter().sum();
        assert!((total - 1.0).abs() < 1e-15);
        for &axis in &[0usize, 1, 2] {
            let second: f64 = (0..Q).map(|q| W[q] * f64::from(C[q][axis] * C[q][axis])).sum();
            assert!((second - CS2).abs() < 1e-15, "axis {axis}: {second}");
        }
    }

    #[test]
    fn opposites_and_reflections_match_the_velocity_table() {
        for q in 0..Q {
            for (axis, reflect) in REFLECT.iter().enumerate() {
                assert_eq!(C[OPP[q]][axis], -C[q][axis], "OPP[{q}]");
                let mut expected = C[q];
                expected[axis] = -expected[axis];
                assert_eq!(C[reflect[q]], expected, "REFLECT[{axis}][{q}]");
            }
        }
    }
}
