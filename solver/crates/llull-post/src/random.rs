//! `llull-compute post random <job-folder>` (PHY-09 TR-DYN-44, RS1 RS-7): the nodal rms field of a random base-excitation response by
//! modal superposition. The host (`server/src/native/randomField.ts`) writes `job.json` (integration grid, modal basis, participation,
//! components) and node-major `modal.f64` (nodes x modes x sources mode-shape values) from the pure TypeScript builder
//! `dynamics/nodalField.ts`; this job writes `field.f64` (nodes x components rms).
//!
//! The arithmetic is a line-for-line port of `dynamics/math/randomResponse.ts` (modal quadratic forms, then `c^T A c` per node and
//! component) with only `+ - * /` and `sqrt` in the same order, so every value is identical to the TypeScript reference bit for bit
//! (RS1 §2 rules 3 and 4). Nodes run in parallel (rayon); each node's numbers come from its own sequential loops.

use crate::JobError;
use rayon::prelude::*;
use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    /// `-sum_j c_j g_j`: displacement relative to the base, modal stress.
    Relative,
    /// `d + w^2 sum_j c_j g_j`: absolute acceleration (d = 1 along the excitation).
    Absolute,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Component {
    pub source: usize,
    pub kind: Kind,
    pub unity: bool,
    pub scale: f64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RandomJob {
    pub node_count: usize,
    pub modes: usize,
    pub sources: usize,
    /// Integration nodes (Hz) and Simpson weight x ASD (g^2) per node.
    pub f_hz: Vec<f64>,
    pub weight: Vec<f64>,
    /// w_j (rad/s) and the imaginary part a_j + b_j w of D_j = w_j^2 - w^2 + i (a_j + b_j w).
    pub omega: Vec<f64>,
    pub damping_a: Vec<f64>,
    pub damping_b: Vec<f64>,
    /// Participation factor per mode in the excitation direction.
    pub gamma: Vec<f64>,
    pub components: Vec<Component>,
}

/// Modal quadratic forms of the grid (`modalForms` of randomResponse.ts, power 0).
pub struct Forms {
    pub modes: usize,
    pub relative: Vec<f64>,
    pub absolute: Vec<f64>,
    pub cross: Vec<f64>,
    pub total: f64,
}

/// Loop order k (grid), j, l >= j, then mirrored: the order of the TypeScript reference.
pub fn modal_forms(job: &RandomJob) -> Forms {
    let modes = job.modes;
    let mut relative = vec![0.0; modes * modes];
    let mut absolute = vec![0.0; modes * modes];
    let mut cross = vec![0.0; modes];
    let mut gr = vec![0.0; modes];
    let mut gi = vec![0.0; modes];
    let mut total = 0.0;
    for (&f, &w) in job.f_hz.iter().zip(&job.weight) {
        let omega = 2.0 * std::f64::consts::PI * f;
        let omega2 = omega * omega;
        let omega4 = omega2 * omega2;
        for j in 0..modes {
            let wj = job.omega[j];
            let dr = wj * wj - omega2;
            let di = job.damping_a[j] + job.damping_b[j] * omega;
            let den = dr * dr + di * di;
            gr[j] = dr / den;
            gi[j] = -di / den;
        }
        total += w;
        for j in 0..modes {
            let (rj, ij) = (gr[j], gi[j]);
            cross[j] += w * omega2 * rj;
            for l in j..modes {
                let product = rj * gr[l] + ij * gi[l];
                relative[j * modes + l] += w * product;
                absolute[j * modes + l] += w * omega4 * product;
            }
        }
    }
    for j in 0..modes {
        for l in 0..j {
            relative[j * modes + l] = relative[l * modes + j];
            absolute[j * modes + l] = absolute[l * modes + j];
        }
    }
    Forms { modes, relative, absolute, cross, total }
}

/// `c^T M c` as `sum_j c_j (sum_l M_jl c_l)`.
fn quadratic(matrix: &[f64], c: &[f64], modes: usize) -> f64 {
    let mut q = 0.0;
    for j in 0..modes {
        let mut s = 0.0;
        for l in 0..modes {
            s += matrix[j * modes + l] * c[l];
        }
        q += c[j] * s;
    }
    q
}

/// Mean square of one component with modal coefficients `c` (`meanSquare` of randomResponse.ts).
pub fn mean_square(forms: &Forms, c: &[f64], component: &Component) -> f64 {
    match component.kind {
        Kind::Relative => quadratic(&forms.relative, c, forms.modes),
        Kind::Absolute => {
            let qa = quadratic(&forms.absolute, c, forms.modes);
            if !component.unity {
                return qa;
            }
            let mut linear = 0.0;
            for (cj, crossj) in c.iter().zip(&forms.cross) {
                linear += cj * crossj;
            }
            forms.total + 2.0 * linear + qa
        }
    }
}

/// `scale * sqrt(max(q, 0))` with JavaScript `Math.max(q, 0)` semantics (-0 and negatives give +0).
pub fn rms_of(q: f64, component: &Component) -> f64 {
    component.scale * (if q > 0.0 { q } else { 0.0 }).sqrt()
}

/// Validates the job against the modal buffer (`node_count * modes * sources` values, node-major).
pub fn check(job: &RandomJob, modal: &[f64]) -> Result<(), JobError> {
    let expected = job.node_count.checked_mul(job.modes).and_then(|v| v.checked_mul(job.sources));
    if expected != Some(modal.len()) {
        return Err(JobError::input(format!(
            "modal.f64 holds {} values, expected node_count {} x modes {} x sources {}",
            modal.len(),
            job.node_count,
            job.modes,
            job.sources
        )));
    }
    let per_mode = [job.omega.len(), job.damping_a.len(), job.damping_b.len(), job.gamma.len()];
    if per_mode.iter().any(|&len| len != job.modes) {
        return Err(JobError::input(format!("omega / dampingA / dampingB / gamma must hold {} values each", job.modes)));
    }
    if job.f_hz.len() != job.weight.len() {
        return Err(JobError::input("fHz and weight differ in length".to_string()));
    }
    if let Some(bad) = job.components.iter().find(|c| c.source >= job.sources) {
        return Err(JobError::input(format!("component source {} >= sources {}", bad.source, job.sources)));
    }
    Ok(())
}

/// The nodal rms field: node-major `node_count x components`.
pub fn run(job: &RandomJob, modal: &[f64]) -> Result<Vec<f64>, JobError> {
    check(job, modal)?;
    let forms = modal_forms(job);
    let width = job.components.len();
    let mut out = vec![0.0; job.node_count * width];
    if width == 0 || job.modes == 0 {
        return Ok(out);
    }
    let per_node = job.modes * job.sources;
    out.par_chunks_mut(width).enumerate().for_each(|(node, row)| {
        let values = &modal[node * per_node..(node + 1) * per_node];
        let mut c = vec![0.0; job.modes];
        for (slot, component) in row.iter_mut().zip(&job.components) {
            for (j, coefficient) in c.iter_mut().enumerate() {
                *coefficient = values[j * job.sources + component.source] * job.gamma[j];
            }
            *slot = rms_of(mean_square(&forms, &c, component), component);
        }
    });
    Ok(out)
}
