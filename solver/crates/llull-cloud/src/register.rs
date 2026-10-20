//! Registration (TECHNICAL_SPEC §5.8): sphere targets (algebraic then geometric LM fit), the closed-form absolute orientation of Horn 1987
//! (unit quaternion = eigenvector of the largest eigenvalue of the 4 × 4 matrix N) and trimmed ICP (Besl & McKay 1992 point-to-point;
//! Chen & Medioni 1992 point-to-plane, one linearised Gauss–Newton step per iteration; trimming after Chetverikov 2002).

use crate::cloud::Vec3;
use crate::error::{CloudError, CloudResult};
use crate::kdtree::{median_spacing, KdTree};
use crate::linalg::{self, column, cross, dot, jacobi_eigen, mean, multiply, norm, rigid, scatter, sub, Mat4};
use crate::lm::minimise;
use crate::normals::pca_normals;
use rayon::prelude::*;

/// Rotation matrix (row-major) of a unit quaternion (w, x, y, z).
pub fn quaternion_matrix([w, x, y, z]: [f64; 4]) -> [[f64; 3]; 3] {
    [
        [w * w + x * x - y * y - z * z, 2.0 * (x * y - w * z), 2.0 * (x * z + w * y)],
        [2.0 * (x * y + w * z), w * w - x * x + y * y - z * z, 2.0 * (y * z - w * x)],
        [2.0 * (x * z - w * y), 2.0 * (y * z + w * x), w * w - x * x - y * y + z * z],
    ]
}

/// The rigid transform minimising Σ|R mᵢ + t − fᵢ|² (Horn 1987, unit quaternions). Needs ≥ 3 pairs.
pub fn horn(moving: &[Vec3], fixed: &[Vec3]) -> Mat4 {
    let (cm, cf) = (mean(moving), mean(fixed));
    let mut s = [[0.0; 3]; 3];
    for (m, f) in moving.iter().zip(fixed) {
        let (a, b) = (sub(m, &cm), sub(f, &cf));
        for r in 0..3 {
            for c in 0..3 {
                s[r][c] += a[r] * b[c];
            }
        }
    }
    let [[sxx, sxy, sxz], [syx, syy, syz], [szx, szy, szz]] = s;
    let n = [
        [sxx + syy + szz, syz - szy, szx - sxz, sxy - syx],
        [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
        [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
        [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz],
    ];
    let (_, vectors) = jacobi_eigen(n);
    let mut q = column(&vectors, 3);
    let length = q.iter().map(|v| v * v).sum::<f64>().sqrt();
    q.iter_mut().for_each(|v| *v /= length);
    let r = quaternion_matrix(q);
    let rc = [dot(&r[0], &cm), dot(&r[1], &cm), dot(&r[2], &cm)];
    rigid(&r, &sub(&cf, &rc))
}

/// A fitted sphere.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Sphere {
    pub centre: Vec3,
    pub radius: f64,
    pub rms: f64,
    pub points: usize,
}

/// Algebraic fit |x|² = 2c·x + k, then LM on the geometric residual |x − c| − r. None for fewer than 4 points or a degenerate set.
pub fn fit_sphere(points: &[Vec3]) -> Option<Sphere> {
    if points.len() < 4 {
        return None;
    }
    let mut ata = vec![vec![0.0; 4]; 4];
    let mut atb = vec![0.0; 4];
    for p in points {
        let row = [2.0 * p[0], 2.0 * p[1], 2.0 * p[2], 1.0];
        let b = dot(p, p);
        for a in 0..4 {
            atb[a] += row[a] * b;
            for c in 0..4 {
                ata[a][c] += row[a] * row[c];
            }
        }
    }
    let x = linalg::solve(ata, atb)?;
    let c0 = [x[0], x[1], x[2]];
    let r0 = (x[3] + dot(&c0, &c0)).max(0.0).sqrt();
    let f = |q: &[f64]| points.iter().map(|p| norm(&sub(p, &[q[0], q[1], q[2]])) - q[3]).collect::<Vec<f64>>();
    let fit = minimise(&f, &[c0[0], c0[1], c0[2], r0], 100);
    let q = &fit.params;
    let rms = (fit.residuals.iter().map(|r| r * r).sum::<f64>() / points.len() as f64).sqrt();
    (q.iter().all(|v| v.is_finite()) && q[3] > 0.0).then_some(Sphere {
        centre: [q[0], q[1], q[2]],
        radius: q[3],
        rms,
        points: points.len(),
    })
}

/// One target pair: a sphere segmented around a seed, or a picked point.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetPair {
    pub name: String,
    pub kind: TargetKind,
    pub fixed: Vec3,
    pub moving: Vec3,
    /// Sphere radius (metres): segmentation within 2r of the seed.
    #[serde(default)]
    pub radius: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetKind {
    Sphere,
    Point,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetResult {
    pub name: String,
    pub fixed_centre: Vec3,
    pub moving_centre: Vec3,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fixed_sphere_radius: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub moving_sphere_radius: Option<f64>,
    pub residual: f64,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetRegistration {
    /// Moving document frame → fixed document frame.
    pub transform: Mat4,
    pub targets: Vec<TargetResult>,
    pub rms: f64,
}

fn sphere_at(cloud: &KdTree, seed: &Vec3, radius: f64, name: &str, side: &str) -> CloudResult<Sphere> {
    let near: Vec<Vec3> = cloud.within(seed, 2.0 * radius).into_iter().map(|i| *cloud.point(i)).collect();
    if near.len() < 10 {
        return Err(CloudError::new(
            "SCN_REG_TARGET_NOT_FOUND",
            format!("target '{name}': {} {side} points within 2r of the seed", near.len()),
        ));
    }
    fit_sphere(&near)
        .ok_or_else(|| CloudError::new("SCN_REG_TARGET_NOT_FOUND", format!("target '{name}': no sphere fits the {side} points")))
}

/// Target registration: centres, degeneracy test (second singular value of the centred fixed centres > 1e-3 × the first), Horn.
/// @failure < 3 pairs -> SCN_REG_TARGETS_INSUFFICIENT; collinear / coincident -> SCN_REG_DEGENERATE; no sphere -> SCN_REG_TARGET_NOT_FOUND
pub fn register_targets(fixed: &KdTree, moving: &KdTree, pairs: &[TargetPair]) -> CloudResult<TargetRegistration> {
    if pairs.len() < 3 {
        return Err(CloudError::new("SCN_REG_TARGETS_INSUFFICIENT", format!("{} target pair(s); at least 3 are needed", pairs.len())));
    }
    let mut results = Vec::new();
    for pair in pairs {
        let (f, m, fr, mr) = match pair.kind {
            TargetKind::Point => (pair.fixed, pair.moving, None, None),
            TargetKind::Sphere => {
                let radius = pair
                    .radius
                    .filter(|r| *r > 0.0)
                    .ok_or_else(|| CloudError::input(format!("target '{}': a sphere needs radius > 0", pair.name)))?;
                let a = sphere_at(fixed, &pair.fixed, radius, &pair.name, "fixed")?;
                let b = sphere_at(moving, &pair.moving, radius, &pair.name, "moving")?;
                (a.centre, b.centre, Some(a.radius), Some(b.radius))
            }
        };
        results.push(TargetResult {
            name: pair.name.clone(),
            fixed_centre: f,
            moving_centre: m,
            fixed_sphere_radius: fr,
            moving_sphere_radius: mr,
            residual: 0.0,
        });
    }
    let fixed_centres: Vec<Vec3> = results.iter().map(|r| r.fixed_centre).collect();
    let moving_centres: Vec<Vec3> = results.iter().map(|r| r.moving_centre).collect();
    let (values, _) = jacobi_eigen(scatter(&fixed_centres, &mean(&fixed_centres)));
    let (first, second) = (values[2].max(0.0).sqrt(), values[1].max(0.0).sqrt());
    if second.is_nan() || second <= 1e-3 * first {
        return Err(CloudError::new(
            "SCN_REG_DEGENERATE",
            format!("the targets are collinear or coincident (singular values {first:.3e}, {second:.3e})"),
        ));
    }
    let transform = horn(&moving_centres, &fixed_centres);
    let mut sum = 0.0;
    for r in &mut results {
        r.residual = norm(&sub(&linalg::apply(&transform, &r.moving_centre), &r.fixed_centre));
        sum += r.residual * r.residual;
    }
    Ok(TargetRegistration { transform, rms: (sum / results.len() as f64).sqrt(), targets: results })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IcpMethod {
    PointToPoint,
    PointToPlane,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IcpResult {
    pub transform: Mat4,
    pub rms: f64,
    /// Fraction of moving points with a fixed neighbour within 3 × the fixed spacing at the final transform.
    pub overlap: f64,
    pub iterations: u32,
    pub converged: bool,
    pub pairs: usize,
    pub fixed_spacing: f64,
}

/// Floor of the pair-rejection distance (metres): keeps every pair once the median is below the noise.
const REJECT_FLOOR_M: f64 = 1e-4;

fn exp_rotation(w: &Vec3) -> [[f64; 3]; 3] {
    let angle = norm(w);
    if angle < 1e-300 {
        return [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    }
    let k = [w[0] / angle, w[1] / angle, w[2] / angle];
    let (s, c) = (libm::sin(angle), libm::cos(angle));
    let v = 1.0 - c;
    [
        [c + k[0] * k[0] * v, k[0] * k[1] * v - k[2] * s, k[0] * k[2] * v + k[1] * s],
        [k[1] * k[0] * v + k[2] * s, c + k[1] * k[1] * v, k[1] * k[2] * v - k[0] * s],
        [k[2] * k[0] * v - k[1] * s, k[2] * k[1] * v + k[0] * s, c + k[2] * k[2] * v],
    ]
}

/// Trimmed ICP of `moving` onto `fixed` from `initial` (both in the document frame). Each iteration: nearest neighbours (rayon over fixed
/// chunks), rejection d > max(3 × median, 1e-4 m), trimming to the `trim_ratio` closest, then one closed-form (point-to-point) or
/// linearised (point-to-plane) update. Stops when |ΔRMS| < 1e-9 m.
pub fn icp(fixed: &KdTree, moving: &[Vec3], initial: &Mat4, method: IcpMethod, max_iterations: u32, trim_ratio: f64) -> IcpResult {
    let spacing = median_spacing(fixed, 2000);
    let normals = match method {
        IcpMethod::PointToPlane => pca_normals(fixed, 20, &mean(&(0..fixed.len()).map(|i| *fixed.point(i)).collect::<Vec<_>>())),
        IcpMethod::PointToPoint => Vec::new(),
    };
    let mut transform = *initial;
    let mut previous: Option<f64> = None;
    let mut converged = false;
    let mut iterations = 0;
    let mut rms = f64::INFINITY;
    let mut kept_count = 0;
    for _ in 0..max_iterations.max(1) {
        iterations += 1;
        let moved: Vec<Vec3> = moving.iter().map(|p| linalg::apply(&transform, p)).collect();
        let matches: Vec<(usize, f64)> =
            moved.par_chunks(4096).flat_map_iter(|c| c.iter().map(|p| fixed.nearest(p, None).unwrap_or((0, f64::INFINITY)))).collect();
        let mut distances: Vec<f64> = matches.iter().map(|m| m.1).collect();
        distances.sort_by(f64::total_cmp);
        let median = distances[distances.len() / 2];
        let limit = (3.0 * median).max(REJECT_FLOOR_M);
        let mut kept: Vec<usize> = (0..moved.len()).filter(|&i| matches[i].1 <= limit).collect();
        kept.sort_by(|&a, &b| matches[a].1.total_cmp(&matches[b].1).then(a.cmp(&b)));
        kept.truncate(((kept.len() as f64) * trim_ratio.clamp(0.05, 1.0)).ceil() as usize);
        kept.sort_unstable();
        kept_count = kept.len();
        if kept.len() < 3 {
            break;
        }
        rms = (kept.iter().map(|&i| matches[i].1 * matches[i].1).sum::<f64>() / kept.len() as f64).sqrt();
        if previous.is_some_and(|p| (p - rms).abs() < 1e-9) {
            converged = true;
            break;
        }
        previous = Some(rms);
        let step = match method {
            IcpMethod::PointToPoint => {
                let a: Vec<Vec3> = kept.iter().map(|&i| moved[i]).collect();
                let b: Vec<Vec3> = kept.iter().map(|&i| *fixed.point(matches[i].0)).collect();
                horn(&a, &b)
            }
            IcpMethod::PointToPlane => {
                let mut ata = vec![vec![0.0; 6]; 6];
                let mut atb = vec![0.0; 6];
                for &i in &kept {
                    let (p, j) = (moved[i], matches[i].0);
                    let (q, n) = (fixed.point(j), normals[j].0);
                    let c = cross(&p, &n);
                    let row = [c[0], c[1], c[2], n[0], n[1], n[2]];
                    let e = dot(&sub(&p, q), &n);
                    for a in 0..6 {
                        atb[a] -= row[a] * e;
                        for b in 0..6 {
                            ata[a][b] += row[a] * row[b];
                        }
                    }
                }
                match linalg::solve(ata, atb) {
                    Some(x) => rigid(&exp_rotation(&[x[0], x[1], x[2]]), &[x[3], x[4], x[5]]),
                    None => break,
                }
            }
        };
        transform = multiply(&step, &transform);
    }
    let threshold = (3.0 * spacing).max(REJECT_FLOOR_M);
    let overlapping =
        moving.iter().filter(|p| fixed.nearest(&linalg::apply(&transform, p), None).is_some_and(|(_, d)| d <= threshold)).count();
    IcpResult {
        transform,
        rms,
        overlap: overlapping as f64 / moving.len().max(1) as f64,
        iterations,
        converged,
        pairs: kept_count,
        fixed_spacing: spacing,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn horn_recovers_a_rigid_motion() {
        let m = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 2.0, 0.0], [0.0, 0.0, 3.0], [1.0, 1.0, 1.0]];
        let r = quaternion_matrix([0.9, 0.1, -0.3, 0.2].map(|v: f64| v / (0.81f64 + 0.01 + 0.09 + 0.04).sqrt()));
        let truth = rigid(&r, &[1.0, -2.0, 0.5]);
        let f: Vec<Vec3> = m.iter().map(|p| linalg::apply(&truth, p)).collect();
        let got = horn(&m, &f);
        assert!(got.iter().zip(truth.iter()).all(|(a, b)| (a - b).abs() < 1e-12), "{got:?}");
    }

    #[test]
    fn sphere_fit_is_exact_on_exact_points() {
        let points: Vec<Vec3> = (0..200)
            .map(|i| {
                let (t, p) = (f64::from(i) * 0.37, f64::from(i) * 0.11);
                [1.0 + 0.5 * libm::cos(t) * libm::sin(p), -2.0 + 0.5 * libm::sin(t) * libm::sin(p), 3.0 + 0.5 * libm::cos(p)]
            })
            .collect();
        let s = fit_sphere(&points).unwrap();
        assert!((s.radius - 0.5).abs() < 1e-10 && norm(&sub(&s.centre, &[1.0, -2.0, 3.0])) < 1e-10, "{s:?}");
        assert!(fit_sphere(&points[..3]).is_none());
    }
}
