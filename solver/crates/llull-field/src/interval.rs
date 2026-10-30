//! Interval evaluation of a tape over a box: twin of `packages/core/src/geometry/field/interval.ts` (sound enclosure; non-finite results
//! widen to +-Infinity). Used to prove whole tiles of the grid empty or full without sampling them.

use crate::eval::Evaluator;
use crate::jsnum::{hypot3, jmax, jmax4, jmin, jmin4};
use crate::sampled::Sampled;
use crate::tape::Op;
use llull_jsmath::sin;
use std::f64::consts::{FRAC_1_SQRT_2, FRAC_PI_2, LN_2, PI, TAU};

fn safe_mul(a: f64, b: f64) -> f64 {
    if a == 0.0 || b == 0.0 {
        0.0
    } else {
        a * b
    }
}

fn sin_range(lo: f64, hi: f64) -> (f64, f64) {
    if hi - lo >= TAU || (hi - lo).is_nan() {
        return (-1.0, 1.0);
    }
    let contains_max = ((hi - FRAC_PI_2) / TAU).floor() >= ((lo - FRAC_PI_2) / TAU).ceil();
    let contains_min = ((hi + FRAC_PI_2) / TAU).floor() >= ((lo + FRAC_PI_2) / TAU).ceil();
    let (s_lo, s_hi) = (sin(lo), sin(hi));
    (if contains_min { -1.0 } else { jmin(s_lo, s_hi) }, if contains_max { 1.0 } else { jmax(s_lo, s_hi) })
}

/// Scratch buffers of one interval evaluation (reused across tiles by one thread).
pub struct IntervalScratch {
    lo: Vec<f64>,
    hi: Vec<f64>,
}

impl IntervalScratch {
    pub fn new(registers: usize) -> IntervalScratch {
        IntervalScratch { lo: vec![0.0; registers], hi: vec![0.0; registers] }
    }
}

fn slot(values: &[f64], index: i64) -> f64 {
    usize::try_from(index).ok().and_then(|i| values.get(i)).copied().unwrap_or(0.0)
}

impl Evaluator {
    /// `[lo, hi]` of the output over the box `min..max`.
    pub fn interval(&self, scratch: &mut IntervalScratch, min: [f64; 3], max: [f64; 3]) -> (f64, f64) {
        let (lo, hi) = (&mut scratch.lo, &mut scratch.hi);
        for (i, instr) in self.instrs.iter().enumerate() {
            let [ia, ib, ic, im, ir] = instr.args;
            let (al, ah) = (slot(lo, ia), slot(hi, ia));
            let (bl, bh) = (slot(lo, ib), slot(hi, ib));
            let (cl, ch) = (slot(lo, ic), slot(hi, ic));
            let (l, h): (f64, f64) = match instr.op {
                Op::Const => {
                    let value = self.constants[ia as usize];
                    (value, value)
                }
                Op::X => (min[0], max[0]),
                Op::Y => (min[1], max[1]),
                Op::Z => (min[2], max[2]),
                Op::Add => (al + bl, ah + bh),
                Op::Sub => (al - bh, ah - bl),
                Op::Mul => {
                    let products = [safe_mul(al, bl), safe_mul(al, bh), safe_mul(ah, bl), safe_mul(ah, bh)];
                    (jmin4(products), jmax4(products))
                }
                Op::Div => {
                    if bl <= 0.0 && bh >= 0.0 {
                        (f64::NEG_INFINITY, f64::INFINITY)
                    } else {
                        let products = [safe_mul(al, 1.0 / bl), safe_mul(al, 1.0 / bh), safe_mul(ah, 1.0 / bl), safe_mul(ah, 1.0 / bh)];
                        (jmin4(products), jmax4(products))
                    }
                }
                Op::Neg => (-ah, -al),
                Op::Abs => (if al <= 0.0 && ah >= 0.0 { 0.0 } else { jmin(al.abs(), ah.abs()) }, jmax(al.abs(), ah.abs())),
                Op::Min => (jmin(al, bl), jmin(ah, bh)),
                Op::Max => (jmax(al, bl), jmax(ah, bh)),
                Op::Sqrt => {
                    if ah < 0.0 {
                        (f64::INFINITY, f64::INFINITY)
                    } else {
                        (jmax(al, 0.0).sqrt(), ah.sqrt())
                    }
                }
                Op::Square => (if al <= 0.0 && ah >= 0.0 { 0.0 } else { jmin(al * al, ah * ah) }, jmax(al * al, ah * ah)),
                Op::Sin => sin_range(al, ah),
                Op::Cos => sin_range(al + FRAC_PI_2, ah + FRAC_PI_2),
                Op::Atan2 => (-PI, PI),
                Op::Floor => (al.floor(), ah.floor()),
                Op::Fract => {
                    if al.floor() == ah.floor() {
                        (al - al.floor(), ah - ah.floor())
                    } else {
                        (0.0, 1.0)
                    }
                }
                Op::Clamp => (jmin(jmax(al, bl), cl), jmin(jmax(ah, bh), ch)),
                Op::Select => {
                    if ah < 0.0 {
                        (bl, bh)
                    } else if al >= 0.0 {
                        (cl, ch)
                    } else {
                        (jmin(bl, cl), jmax(bh, ch))
                    }
                }
                Op::SminQuad => (jmin(al, bl) - jmax(ch, 0.0) / 4.0, jmin(ah, bh)),
                Op::SminExp => (jmin(al, bl) - jmax(ch, 0.0) * LN_2, jmin(ah, bh)),
                Op::ChamferMin => {
                    let chamfer_low = (al + bl - ch) * FRAC_1_SQRT_2;
                    let chamfer_high = (ah + bh - cl) * FRAC_1_SQRT_2;
                    (jmin(jmin(al, bl), chamfer_low), jmin(jmin(ah, bh), chamfer_high))
                }
                Op::MeshSdf => {
                    let centre = |index: i64| (slot(lo, index) + slot(hi, index)) / 2.0;
                    let middle = self.meshes.get(im as usize).map_or(f64::INFINITY, |m| m.distance(centre(ia), centre(ib), centre(ic)));
                    let slack = half_diagonal(lo, hi, [ia, ib, ic]);
                    (middle - slack, middle + slack)
                }
                Op::SampleField => self.sampled.get(im as usize).map_or((f64::NEG_INFINITY, f64::INFINITY), Sampled::range),
                Op::StrutSet => {
                    let centre = |index: i64| (slot(lo, index) + slot(hi, index)) / 2.0;
                    let probe = if ir >= 0 { 0.0 } else { -1.0 };
                    let middle =
                        self.struts.get(im as usize).map_or(f64::INFINITY, |s| s.distance(centre(ia), centre(ib), centre(ic), probe));
                    let slack = half_diagonal(lo, hi, [ia, ib, ic]);
                    if ir >= 0 {
                        (middle - slack - slot(hi, ir), middle + slack - slot(lo, ir))
                    } else {
                        (middle - slack, middle + slack)
                    }
                }
            };
            lo[i] = if l.is_nan() { f64::NEG_INFINITY } else { l };
            hi[i] = if h.is_nan() { f64::INFINITY } else { h };
        }
        (lo[self.output], hi[self.output])
    }
}

fn half_diagonal(lo: &[f64], hi: &[f64], regs: [i64; 3]) -> f64 {
    let half = |r: i64| (slot(hi, r) - slot(lo, r)) / 2.0;
    hypot3(half(regs[0]), half(regs[1]), half(regs[2]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tape::{Instr, SLOTS};

    fn tape(ops: &[(Op, [i64; SLOTS])], constants: Vec<f64>, output: usize) -> Evaluator {
        Evaluator {
            instrs: ops.iter().map(|&(op, args)| Instr { op, args }).collect(),
            output,
            constants,
            meshes: vec![],
            struts: vec![],
            sampled: vec![],
        }
    }

    fn one(op: Op, a: i64, b: i64, c: i64) -> Evaluator {
        // r0 = x, r1 = y, r2 = z, r3 = const 0.5, r4 = op(a, b, c)
        tape(
            &[(Op::X, [-1; SLOTS]), (Op::Y, [-1; SLOTS]), (Op::Z, [-1; SLOTS]), (Op::Const, [0, -1, -1, -1, -1]), (op, [a, b, c, -1, -1])],
            vec![0.5],
            4,
        )
    }

    fn range(e: &Evaluator, min: [f64; 3], max: [f64; 3]) -> (f64, f64) {
        e.interval(&mut IntervalScratch::new(e.instrs.len()), min, max)
    }

    #[test]
    fn every_op_encloses_its_point_values() {
        let boxes = [([-1.0, 0.5, 2.0], [0.5, 3.0, 3.5]), ([0.2, -2.0, -1.0], [0.9, -0.5, 4.0]), ([-7.0, -7.0, -7.0], [7.0, 7.0, 7.0])];
        let ops: Vec<(Op, i64, i64, i64)> = vec![
            (Op::Add, 0, 1, -1),
            (Op::Sub, 0, 1, -1),
            (Op::Mul, 0, 1, -1),
            (Op::Div, 0, 1, -1),
            (Op::Neg, 0, -1, -1),
            (Op::Abs, 0, -1, -1),
            (Op::Min, 0, 1, -1),
            (Op::Max, 0, 1, -1),
            (Op::Sqrt, 1, -1, -1),
            (Op::Square, 0, -1, -1),
            (Op::Sin, 0, -1, -1),
            (Op::Cos, 1, -1, -1),
            (Op::Atan2, 0, 1, -1),
            (Op::Floor, 0, -1, -1),
            (Op::Fract, 0, -1, -1),
            (Op::Clamp, 0, 1, 2),
            (Op::Select, 0, 1, 2),
            (Op::SminQuad, 0, 1, 3),
            (Op::SminExp, 0, 1, 3),
            (Op::ChamferMin, 0, 1, 3),
        ];
        for (op, a, b, c) in ops {
            let e = one(op, a, b, c);
            let mut regs = vec![0.0; e.instrs.len()];
            for (min, max) in boxes {
                let (lo, hi) = range(&e, min, max);
                for s in 0..=8 {
                    let t = f64::from(s) / 8.0;
                    let p = [0, 1, 2].map(|k| min[k] + (max[k] - min[k]) * t);
                    let v = e.value_at(&mut regs, p[0], p[1], p[2]);
                    // cos is sin shifted by pi/2 (as in the TypeScript), so its bounds are sound to one rounding.
                    assert!(v.is_nan() || (lo - 1e-12 <= v && v <= hi + 1e-12), "{op:?}: {v} not in [{lo}, {hi}] over {min:?}..{max:?}");
                }
            }
        }
    }

    #[test]
    fn division_by_an_interval_across_zero_is_unbounded_and_square_roots_of_negatives_are_empty() {
        let divide = one(Op::Div, 0, 1, -1);
        assert_eq!(range(&divide, [0.0, -1.0, 0.0], [1.0, 1.0, 1.0]), (f64::NEG_INFINITY, f64::INFINITY));
        let root = one(Op::Sqrt, 0, -1, -1);
        assert_eq!(range(&root, [-2.0, 0.0, 0.0], [-1.0, 1.0, 1.0]), (f64::INFINITY, f64::INFINITY));
        let wide_sin = one(Op::Sin, 0, -1, -1);
        assert_eq!(range(&wide_sin, [0.0, 0.0, 0.0], [7.0, 1.0, 1.0]), (-1.0, 1.0));
        let fract = one(Op::Fract, 0, -1, -1);
        assert_eq!(range(&fract, [0.2, 0.0, 0.0], [0.7, 1.0, 1.0]), (0.2, 0.7));
        assert_eq!(range(&fract, [0.2, 0.0, 0.0], [1.7, 1.0, 1.0]), (0.0, 1.0));
    }
}
