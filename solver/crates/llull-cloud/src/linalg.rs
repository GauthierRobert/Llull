//! Small dense linear algebra for the fits and registrations: 3-vectors, row-major 4 × 4 affine transforms, cyclic Jacobi eigen-solver
//! (the method of `domain-cae/thermomech/plane.ts`, TECHNICAL_SPEC §5.4) and Gaussian elimination with partial pivoting. Everything is
//! sequential and branch-deterministic, so results are bit-reproducible.

use crate::cloud::Vec3;

pub fn add(a: &Vec3, b: &Vec3) -> Vec3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

pub fn sub(a: &Vec3, b: &Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

pub fn scale(a: &Vec3, s: f64) -> Vec3 {
    [a[0] * s, a[1] * s, a[2] * s]
}

pub fn dot(a: &Vec3, b: &Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub fn cross(a: &Vec3, b: &Vec3) -> Vec3 {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

pub fn norm(a: &Vec3) -> f64 {
    dot(a, a).sqrt()
}

pub fn distance(a: &Vec3, b: &Vec3) -> f64 {
    norm(&sub(a, b))
}

/// `a / |a|`, or None for a (near) zero vector.
pub fn unit(a: &Vec3) -> Option<Vec3> {
    let n = norm(a);
    (n > 1e-300).then(|| scale(a, 1.0 / n))
}

/// Two unit vectors completing `a` (unit) to a right-handed orthonormal frame (u, w): a × u = w.
pub fn frame(a: &Vec3) -> (Vec3, Vec3) {
    let helper = if a[0].abs() < 0.9 { [1.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0] };
    let u = unit(&cross(a, &helper)).unwrap_or([0.0, 1.0, 0.0]);
    (u, cross(a, &u))
}

pub fn mean(points: &[Vec3]) -> Vec3 {
    let mut sum = [0.0; 3];
    for p in points {
        sum = add(&sum, p);
    }
    scale(&sum, 1.0 / points.len().max(1) as f64)
}

/// Row-major 4 × 4 affine transform (translation in column 3).
pub type Mat4 = [f64; 16];

pub const IDENTITY: Mat4 = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];

pub fn apply(m: &Mat4, p: &Vec3) -> Vec3 {
    [
        m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
        m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
        m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
    ]
}

/// Rotation part only (directions, normals).
pub fn rotate(m: &Mat4, v: &Vec3) -> Vec3 {
    [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[4] * v[0] + m[5] * v[1] + m[6] * v[2], m[8] * v[0] + m[9] * v[1] + m[10] * v[2]]
}

pub fn multiply(a: &Mat4, b: &Mat4) -> Mat4 {
    let mut out = [0.0; 16];
    for row in 0..4 {
        for column in 0..4 {
            out[row * 4 + column] = (0..4).map(|k| a[row * 4 + k] * b[k * 4 + column]).sum();
        }
    }
    out
}

/// Inverse of an affine transform, or None when its 3 × 3 part is singular.
pub fn invert_affine(m: &Mat4) -> Option<Mat4> {
    let a = |r: usize, c: usize| m[r * 4 + c];
    let cof = |r: usize, c: usize| {
        let rows: Vec<usize> = (0..3).filter(|&i| i != r).collect();
        let cols: Vec<usize> = (0..3).filter(|&i| i != c).collect();
        let sign = if (r + c).is_multiple_of(2) { 1.0 } else { -1.0 };
        sign * (a(rows[0], cols[0]) * a(rows[1], cols[1]) - a(rows[0], cols[1]) * a(rows[1], cols[0]))
    };
    let det = a(0, 0) * cof(0, 0) + a(0, 1) * cof(0, 1) + a(0, 2) * cof(0, 2);
    if det.abs() <= 1e-300 || !det.is_finite() {
        return None;
    }
    let mut out = IDENTITY;
    for r in 0..3 {
        for c in 0..3 {
            out[r * 4 + c] = cof(c, r) / det;
        }
        out[r * 4 + 3] = -(0..3).map(|k| out[r * 4 + k] * m[k * 4 + 3]).sum::<f64>();
    }
    Some(out)
}

/// Rigid transform from a rotation (row-major 3 × 3) and a translation.
pub fn rigid(r: &[[f64; 3]; 3], t: &Vec3) -> Mat4 {
    [r[0][0], r[0][1], r[0][2], t[0], r[1][0], r[1][1], r[1][2], t[1], r[2][0], r[2][1], r[2][2], t[2], 0.0, 0.0, 0.0, 1.0]
}

/// Rotation angle of the 3 × 3 part, degrees.
pub fn rotation_angle_deg(m: &Mat4) -> f64 {
    let trace = m[0] + m[5] + m[10];
    libm::acos(((trace - 1.0) / 2.0).clamp(-1.0, 1.0)).to_degrees()
}

/// Eigen-decomposition of a symmetric N × N matrix by cyclic Jacobi rotations: eigenvalues ascending, eigenvectors as COLUMNS of the
/// returned matrix (column k belongs to value k).
#[allow(clippy::needless_range_loop)]
pub fn jacobi_eigen<const N: usize>(matrix: [[f64; N]; N]) -> ([f64; N], [[f64; N]; N]) {
    let mut a = matrix;
    let mut v = [[0.0; N]; N];
    for (i, row) in v.iter_mut().enumerate() {
        row[i] = 1.0;
    }
    for _sweep in 0..100 {
        let off: f64 = (0..N).flat_map(|p| (p + 1..N).map(move |q| (p, q))).map(|(p, q)| a[p][q] * a[p][q]).sum();
        let scale: f64 = (0..N).map(|i| a[i][i] * a[i][i]).sum::<f64>().max(1e-300);
        if off <= 1e-30 * scale {
            break;
        }
        for p in 0..N {
            for q in p + 1..N {
                if a[p][q] == 0.0 {
                    continue;
                }
                let theta = (a[q][q] - a[p][p]) / (2.0 * a[p][q]);
                let t = theta.signum() / (theta.abs() + (theta * theta + 1.0).sqrt());
                let t = if theta == 0.0 { 1.0 } else { t };
                let c = 1.0 / (t * t + 1.0).sqrt();
                let s = t * c;
                for k in 0..N {
                    let (akp, akq) = (a[k][p], a[k][q]);
                    a[k][p] = c * akp - s * akq;
                    a[k][q] = s * akp + c * akq;
                }
                for k in 0..N {
                    let (apk, aqk) = (a[p][k], a[q][k]);
                    a[p][k] = c * apk - s * aqk;
                    a[q][k] = s * apk + c * aqk;
                }
                for k in 0..N {
                    let (vkp, vkq) = (v[k][p], v[k][q]);
                    v[k][p] = c * vkp - s * vkq;
                    v[k][q] = s * vkp + c * vkq;
                }
            }
        }
    }
    let mut order: [usize; N] = std::array::from_fn(|i| i);
    order.sort_by(|&i, &j| a[i][i].total_cmp(&a[j][j]).then(i.cmp(&j)));
    let values = std::array::from_fn(|k| a[order[k]][order[k]]);
    let vectors = std::array::from_fn(|r| std::array::from_fn(|k| v[r][order[k]]));
    (values, vectors)
}

/// Column `k` of a column-eigenvector matrix.
pub fn column<const N: usize>(m: &[[f64; N]; N], k: usize) -> [f64; N] {
    std::array::from_fn(|r| m[r][k])
}

/// Solves `a x = b` (dense, n × n) by Gaussian elimination with partial pivoting; None when singular.
#[allow(clippy::needless_range_loop)]
pub fn solve(mut a: Vec<Vec<f64>>, mut b: Vec<f64>) -> Option<Vec<f64>> {
    let n = b.len();
    for col in 0..n {
        let pivot = (col..n).max_by(|&i, &j| a[i][col].abs().total_cmp(&a[j][col].abs()).then(j.cmp(&i)))?;
        if a[pivot][col].abs() < 1e-300 {
            return None;
        }
        a.swap(col, pivot);
        b.swap(col, pivot);
        for row in col + 1..n {
            let factor = a[row][col] / a[col][col];
            if factor == 0.0 {
                continue;
            }
            for k in col..n {
                a[row][k] -= factor * a[col][k];
            }
            b[row] -= factor * b[col];
        }
    }
    let mut x = vec![0.0; n];
    for row in (0..n).rev() {
        let sum: f64 = (row + 1..n).map(|k| a[row][k] * x[k]).sum();
        x[row] = (b[row] - sum) / a[row][row];
    }
    x.iter().all(|v| v.is_finite()).then_some(x)
}

/// Inverse of a dense n × n matrix (column by column); None when singular.
pub fn inverse(a: &[Vec<f64>]) -> Option<Vec<Vec<f64>>> {
    let n = a.len();
    let mut columns = Vec::with_capacity(n);
    for k in 0..n {
        let mut e = vec![0.0; n];
        e[k] = 1.0;
        columns.push(solve(a.to_vec(), e)?);
    }
    Some((0..n).map(|r| (0..n).map(|c| columns[c][r]).collect()).collect())
}

/// Scatter matrix Σ (p − c)(p − c)ᵀ of `points` about `centre`.
pub fn scatter(points: &[Vec3], centre: &Vec3) -> [[f64; 3]; 3] {
    let mut m = [[0.0; 3]; 3];
    for p in points {
        let d = sub(p, centre);
        for r in 0..3 {
            for c in 0..3 {
                m[r][c] += d[r] * d[c];
            }
        }
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jacobi_recovers_a_known_spectrum() {
        let (values, vectors) = jacobi_eigen([[2.0, 1.0, 0.0], [1.0, 2.0, 0.0], [0.0, 0.0, 5.0]]);
        assert!((values[0] - 1.0).abs() < 1e-12 && (values[1] - 3.0).abs() < 1e-12 && (values[2] - 5.0).abs() < 1e-12);
        let v0 = column(&vectors, 0);
        assert!((v0[0].abs() - std::f64::consts::FRAC_1_SQRT_2).abs() < 1e-12 && (v0[0] + v0[1]).abs() < 1e-12);
    }

    #[test]
    fn solve_and_invert_small_systems() {
        let x = solve(vec![vec![2.0, 1.0], vec![1.0, 3.0]], vec![3.0, 5.0]).unwrap();
        assert!((x[0] - 0.8).abs() < 1e-12 && (x[1] - 1.4).abs() < 1e-12);
        assert!(solve(vec![vec![1.0, 2.0], vec![2.0, 4.0]], vec![1.0, 2.0]).is_none());
        let inv = inverse(&[vec![4.0, 0.0], vec![0.0, 2.0]]).unwrap();
        assert_eq!(inv, vec![vec![0.25, 0.0], vec![0.0, 0.5]]);
        let m = [0.0, -1.0, 0.0, 1.0, 1.0, 0.0, 0.0, 2.0, 0.0, 0.0, 2.0, 3.0, 0.0, 0.0, 0.0, 1.0];
        let back = multiply(&invert_affine(&m).unwrap(), &m);
        assert!(back.iter().zip(IDENTITY.iter()).all(|(a, b)| (a - b).abs() < 1e-12));
        assert!(invert_affine(&[0.0; 16]).is_none());
    }
}
