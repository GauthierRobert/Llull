//! Horseshoe vortex-lattice influence build: the operations of `packages/domain-aero/src/aerodynamics/vlmKernel.ts` in the same order, so
//! the matrix is bit-identical to the TypeScript one (only `+ − × ÷` and `sqrt`).

use rayon::prelude::*;

/// f64 per panel: Ax Ay Az Bx By Bz Cx Cy Cz nx ny nz.
pub const PANEL_STRIDE: usize = 12;
const FOUR_PI: f64 = 4.0 * std::f64::consts::PI;
const CORE: f64 = 1e-20;

/// Velocity induced at `p` by the unit horseshoe `panel` (bound segment A→B, trailing legs to +∞ along +x).
#[inline]
fn horseshoe(panel: &[f64], px: f64, py: f64, pz: f64) -> [f64; 3] {
    let (ax, ay, az, bx, by, bz) = (panel[0], panel[1], panel[2], panel[3], panel[4], panel[5]);
    let (mut u, mut v, mut w) = (0.0, 0.0, 0.0);
    let (r1x, r1y, r1z) = (px - ax, py - ay, pz - az);
    let (r2x, r2y, r2z) = (px - bx, py - by, pz - bz);
    let cx = r1y * r2z - r1z * r2y;
    let cy = r1z * r2x - r1x * r2z;
    let cz = r1x * r2y - r1y * r2x;
    let c2 = cx * cx + cy * cy + cz * cz;
    let n1 = (r1x * r1x + r1y * r1y + r1z * r1z).sqrt();
    let n2 = (r2x * r2x + r2y * r2y + r2z * r2z).sqrt();
    if c2 > CORE * (n1 * n1) * (n2 * n2) {
        let k =
            ((bx - ax) * (r1x / n1 - r2x / n2) + (by - ay) * (r1y / n1 - r2y / n2) + (bz - az) * (r1z / n1 - r2z / n2)) / (FOUR_PI * c2);
        u += k * cx;
        v += k * cy;
        w += k * cz;
    }
    let d2b = r2y * r2y + r2z * r2z;
    if d2b > CORE * (n2 * n2) {
        let k = (1.0 + r2x / n2) / (FOUR_PI * d2b);
        v += k * -r2z;
        w += k * r2y;
    }
    let d2a = r1y * r1y + r1z * r1z;
    if d2a > CORE * (n1 * n1) {
        let k = (1.0 + r1x / n1) / (FOUR_PI * d2a);
        v -= k * -r1z;
        w -= k * r1y;
    }
    // The TS accumulates into a zeroed velocity: 0 + u is u for every u except −0 (0 + −0 = +0).
    [0.0 + u, 0.0 + v, 0.0 + w]
}

/// Row `i` of the influence matrix: a_ij = V_j(C_i)·n_i.
pub fn influence_row(panels: &[f64], i: usize, row: &mut [f64]) {
    let p = &panels[i * PANEL_STRIDE..(i + 1) * PANEL_STRIDE];
    let (px, py, pz, nx, ny, nz) = (p[6], p[7], p[8], p[9], p[10], p[11]);
    for (j, value) in row.iter_mut().enumerate() {
        let [u, v, w] = horseshoe(&panels[j * PANEL_STRIDE..(j + 1) * PANEL_STRIDE], px, py, pz);
        *value = u * nx + v * ny + w * nz;
    }
}

/// Trefftz-plane wake velocity (v, w) at (y, z) of every trailing leg pair for circulations `gamma` (the TS `trefftzVelocity`).
fn trefftz_velocity(panels: &[f64], gamma: &[f64], y: f64, z: f64) -> (f64, f64) {
    let (mut v, mut w) = (0.0, 0.0);
    for (p, g) in panels.chunks_exact(PANEL_STRIDE).zip(gamma) {
        let g = g / (2.0 * std::f64::consts::PI);
        let (dby, dbz, day, daz) = (y - p[4], z - p[5], y - p[1], z - p[2]);
        let rb = dby * dby + dbz * dbz;
        let ra = day * day + daz * daz;
        if rb > 0.0 {
            v -= g * dbz / rb;
            w += g * dby / rb;
        }
        if ra > 0.0 {
            v += g * daz / ra;
            w -= g * day / ra;
        }
    }
    (v, w)
}

/// Trefftz velocities at every bound-vortex midpoint for Γx and Γz (the TS `trefftzBasis` layout: v0 w0 v1 w1 … for Γx, then for Γz).
pub fn trefftz_basis(panels: &[f64], gamma_x: &[f64], gamma_z: &[f64]) -> Vec<f64> {
    let n = panels.len() / PANEL_STRIDE;
    let rows: Vec<[f64; 4]> = (0..n)
        .into_par_iter()
        .map(|i| {
            let p = &panels[i * PANEL_STRIDE..(i + 1) * PANEL_STRIDE];
            let (y, z) = ((p[1] + p[4]) / 2.0, (p[2] + p[5]) / 2.0);
            let (xv, xw) = trefftz_velocity(panels, gamma_x, y, z);
            let (zv, zw) = trefftz_velocity(panels, gamma_z, y, z);
            [xv, xw, zv, zw]
        })
        .collect();
    let mut out = vec![0.0; 4 * n];
    for (i, [xv, xw, zv, zw]) in rows.into_iter().enumerate() {
        out[2 * i] = xv;
        out[2 * i + 1] = xw;
        out[2 * n + 2 * i] = zv;
        out[2 * n + 2 * i + 1] = zw;
    }
    out
}

/// Right-hand sides −V·n for the free streams x̂ and ẑ.
pub fn basis_rhs(panels: &[f64]) -> (Vec<f64>, Vec<f64>) {
    panels.chunks_exact(PANEL_STRIDE).map(|p| (-p[9], -p[11])).unzip()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_bound_vortex_induces_the_biot_savart_velocity() {
        // A semi-infinite-legged horseshoe from (0,-1,0) to (0,1,0), point 1 downstream on the centre line: the bound segment induces
        // −(1/4π)(2/√2)/1 ẑ = −1/(2√2 π) and each leg −(1/4π)(1 + 1/√2) ... summed below from the closed forms.
        let panel = [0.0, -1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0];
        let [u, v, w] = horseshoe(&panel, 1.0, 0.0, 0.0);
        let bound = -(2.0 / 2f64.sqrt()) / FOUR_PI;
        let leg = -(1.0 + 1.0 / 2f64.sqrt()) / FOUR_PI;
        assert!(u.abs() < 1e-15 && v.abs() < 1e-15);
        assert!((w - (bound + 2.0 * leg)).abs() < 1e-15, "{w}");
    }
}
