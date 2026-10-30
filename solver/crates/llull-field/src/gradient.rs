//! Forward-mode gradient of a tape: twin of `packages/core/src/geometry/field/gradient.ts` (`evaluateWithGradient`), same formulas and operation
//! order, so value and gradient are bit-identical to the TypeScript engine. `mesh_sdf` / `strut_set` differentiate by central differences.

use crate::eval::{chamfer_min, smooth_min_exp, smooth_min_quad, Evaluator};
use crate::jsnum::jmin;
use crate::tape::Op;
use llull_jsmath::{atan2, cos, exp, sin};

const STEP: f64 = 1e-6;

/// Scratch of `value_gradient_at`: value and the three partials per register.
pub struct GradientScratch {
    v: Vec<f64>,
    g: [Vec<f64>; 3],
}

impl GradientScratch {
    pub fn new(registers: usize) -> GradientScratch {
        GradientScratch { v: vec![0.0; registers], g: [vec![0.0; registers], vec![0.0; registers], vec![0.0; registers]] }
    }
}

impl Evaluator {
    /// Value and gradient of the output register at (x, y, z).
    pub fn value_gradient_at(&self, s: &mut GradientScratch, x: f64, y: f64, z: f64) -> (f64, [f64; 3]) {
        let reg = |v: &[f64], slot: i64| usize::try_from(slot).ok().and_then(|i| v.get(i)).copied().unwrap_or(0.0);
        for (i, instr) in self.instrs.iter().enumerate() {
            let [sa, sb, sc, sm, sr] = instr.args;
            let (a, b, c) = (reg(&s.v, sa), reg(&s.v, sb), reg(&s.v, sc));
            let [ax, ay, az] = [reg(&s.g[0], sa), reg(&s.g[1], sa), reg(&s.g[2], sa)];
            let [bx, by, bz] = [reg(&s.g[0], sb), reg(&s.g[1], sb), reg(&s.g[2], sb)];
            let [cx, cy, cz] = [reg(&s.g[0], sc), reg(&s.g[1], sc), reg(&s.g[2], sc)];
            let (value, d): (f64, [f64; 3]) = match instr.op {
                Op::Const => (self.constants[sa as usize], [0.0; 3]),
                Op::X => (x, [1.0, 0.0, 0.0]),
                Op::Y => (y, [0.0, 1.0, 0.0]),
                Op::Z => (z, [0.0, 0.0, 1.0]),
                Op::Add => (a + b, [ax + bx, ay + by, az + bz]),
                Op::Sub => (a - b, [ax - bx, ay - by, az - bz]),
                Op::Mul => (a * b, [ax * b + a * bx, ay * b + a * by, az * b + a * bz]),
                Op::Div => (a / b, [(ax - (a / b) * bx) / b, (ay - (a / b) * by) / b, (az - (a / b) * bz) / b]),
                Op::Neg => (-a, [-ax, -ay, -az]),
                Op::Abs => {
                    let sign = if a < 0.0 { -1.0 } else { 1.0 };
                    (a.abs(), [sign * ax, sign * ay, sign * az])
                }
                Op::Min => {
                    if a <= b {
                        (a, [ax, ay, az])
                    } else {
                        (b, [bx, by, bz])
                    }
                }
                Op::Max => {
                    if a >= b {
                        (a, [ax, ay, az])
                    } else {
                        (b, [bx, by, bz])
                    }
                }
                Op::Sqrt => {
                    let root = a.sqrt();
                    let scale = if root > 0.0 { 1.0 / (2.0 * root) } else { 0.0 };
                    (root, [ax * scale, ay * scale, az * scale])
                }
                Op::Square => (a * a, [2.0 * a * ax, 2.0 * a * ay, 2.0 * a * az]),
                Op::Sin => (sin(a), [cos(a) * ax, cos(a) * ay, cos(a) * az]),
                Op::Cos => (cos(a), [-sin(a) * ax, -sin(a) * ay, -sin(a) * az]),
                Op::Atan2 => {
                    let r2 = a * a + b * b;
                    let k = if r2 > 0.0 { 1.0 / r2 } else { 0.0 };
                    (atan2(a, b), [(b * ax - a * bx) * k, (b * ay - a * by) * k, (b * az - a * bz) * k])
                }
                Op::Floor => (a.floor(), [0.0; 3]),
                Op::Fract => (a - a.floor(), [ax, ay, az]),
                Op::Clamp => {
                    let (mid, mx, my, mz) = if a >= b { (a, ax, ay, az) } else { (b, bx, by, bz) };
                    if mid <= c {
                        (mid, [mx, my, mz])
                    } else {
                        (c, [cx, cy, cz])
                    }
                }
                Op::Select => {
                    if a < 0.0 {
                        (b, [bx, by, bz])
                    } else {
                        (c, [cx, cy, cz])
                    }
                }
                Op::SminQuad => {
                    let delta = (a - b).abs();
                    let value = smooth_min_quad(a, b, c);
                    if (c.is_nan() || c <= 0.0) || delta >= c {
                        let [ex, ey, ez] = if a <= b { [ax, ay, az] } else { [bx, by, bz] };
                        (value, [ex, ey, ez])
                    } else {
                        let h = (c - delta) / c;
                        let (wa, wb) = if a <= b { (1.0 - h / 2.0, h / 2.0) } else { (h / 2.0, 1.0 - h / 2.0) };
                        let dk = -(c * c - delta * delta) / (4.0 * c * c);
                        (value, [wa * ax + wb * bx + dk * cx, wa * ay + wb * by + dk * cy, wa * az + wb * bz + dk * cz])
                    }
                }
                Op::SminExp => {
                    let value = smooth_min_exp(a, b, c);
                    if c.is_nan() || c <= 0.0 {
                        let [ex, ey, ez] = if a <= b { [ax, ay, az] } else { [bx, by, bz] };
                        (value, [ex, ey, ez])
                    } else {
                        let m = jmin(a, b);
                        let (ea, eb) = (exp(-(a - m) / c), exp(-(b - m) / c));
                        let (wa, wb) = (ea / (ea + eb), eb / (ea + eb));
                        let dk = (value - (wa * a + wb * b)) / c;
                        (value, [wa * ax + wb * bx + dk * cx, wa * ay + wb * by + dk * cy, wa * az + wb * bz + dk * cz])
                    }
                }
                Op::ChamferMin => {
                    let m = jmin(a, b);
                    let chamfer = (a + b - c) * std::f64::consts::FRAC_1_SQRT_2;
                    if chamfer < m {
                        let k = std::f64::consts::FRAC_1_SQRT_2;
                        (chamfer_min(a, b, c), [(ax + bx - cx) * k, (ay + by - cy) * k, (az + bz - cz) * k])
                    } else if a <= b {
                        (m, [ax, ay, az])
                    } else {
                        (m, [bx, by, bz])
                    }
                }
                Op::MeshSdf | Op::StrutSet => {
                    let radius = if sr >= 0 { reg(&s.v, sr) } else { -1.0 };
                    let sdf = |px: f64, py: f64, pz: f64| -> f64 {
                        if instr.op == Op::MeshSdf {
                            self.meshes.get(sm as usize).map_or(f64::INFINITY, |m| m.distance(px, py, pz))
                        } else {
                            self.struts.get(sm as usize).map_or(f64::INFINITY, |t| t.distance(px, py, pz, radius))
                        }
                    };
                    let gxi = (sdf(a + STEP, b, c) - sdf(a - STEP, b, c)) / (2.0 * STEP);
                    let gyi = (sdf(a, b + STEP, c) - sdf(a, b - STEP, c)) / (2.0 * STEP);
                    let gzi = (sdf(a, b, c + STEP) - sdf(a, b, c - STEP)) / (2.0 * STEP);
                    (sdf(a, b, c), [gxi * ax + gyi * bx + gzi * cx, gxi * ay + gyi * by + gzi * cy, gxi * az + gyi * bz + gzi * cz])
                }
            };
            s.v[i] = value;
            s.g[0][i] = d[0];
            s.g[1][i] = d[1];
            s.g[2][i] = d[2];
        }
        let out = self.output;
        (s.v[out], [s.g[0][out], s.g[1][out], s.g[2][out]])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tape::{Instr, SLOTS};

    fn tape(ops: &[(Op, [i64; SLOTS])], output: usize) -> Evaluator {
        Evaluator {
            instrs: ops.iter().map(|&(op, args)| Instr { op, args }).collect(),
            output,
            constants: vec![],
            meshes: vec![],
            struts: vec![],
        }
    }

    #[test]
    fn product_rule_and_sqrt_at_the_origin() {
        let xy = tape(&[(Op::X, [-1; SLOTS]), (Op::Y, [-1; SLOTS]), (Op::Mul, [0, 1, -1, -1, -1])], 2);
        let mut s = GradientScratch::new(3);
        assert_eq!(xy.value_gradient_at(&mut s, 3.0, 4.0, 0.0), (12.0, [4.0, 3.0, 0.0]));
        let root = tape(&[(Op::X, [-1; SLOTS]), (Op::Sqrt, [0, -1, -1, -1, -1])], 1);
        let mut s = GradientScratch::new(2);
        assert_eq!(root.value_gradient_at(&mut s, 0.0, 0.0, 0.0), (0.0, [0.0, 0.0, 0.0]), "sqrt at 0 has a zero slope, not infinity");
        assert_eq!(root.value_gradient_at(&mut s, 4.0, 0.0, 0.0), (2.0, [0.25, 0.0, 0.0]));
    }

    #[test]
    fn select_and_clamp_follow_the_active_branch() {
        let clamp = tape(&[(Op::X, [-1; SLOTS]), (Op::Y, [-1; SLOTS]), (Op::Z, [-1; SLOTS]), (Op::Clamp, [0, 1, 2, -1, -1])], 3);
        let mut s = GradientScratch::new(4);
        assert_eq!(clamp.value_gradient_at(&mut s, 5.0, 0.0, 1.0), (1.0, [0.0, 0.0, 1.0]));
        assert_eq!(clamp.value_gradient_at(&mut s, -5.0, 0.0, 1.0), (0.0, [0.0, 1.0, 0.0]));
    }
}
