//! Point evaluation of a tape: twin of `interpret.ts` (`scalarOp`, `evaluateAt`), f64 throughout, V8-exact `sin` / `cos` / `atan2` / `exp` / `log`.

use crate::jsnum::{jmax, jmin};
use crate::meshsdf::MeshSdf;
use crate::sampled::Sampled;
use crate::struts::StrutEval;
use crate::tape::{Instr, Op, Program};
use llull_jsmath::{atan2, cos, exp, log, sin};

pub struct Evaluator {
    pub instrs: Vec<Instr>,
    pub output: usize,
    pub constants: Vec<f64>,
    pub meshes: Vec<MeshSdf>,
    pub struts: Vec<StrutEval>,
    pub sampled: Vec<Sampled>,
}

pub fn smooth_min_quad(a: f64, b: f64, k: f64) -> f64 {
    let m = jmin(a, b);
    if k.is_nan() || k <= 0.0 {
        return m;
    }
    let h = jmax(k - (a - b).abs(), 0.0) / k;
    m - (h * h * k) / 4.0
}

pub fn smooth_min_exp(a: f64, b: f64, k: f64) -> f64 {
    let m = jmin(a, b);
    if k.is_nan() || k <= 0.0 {
        return m;
    }
    m - k * log(1.0 + exp(-(a - b).abs() / k))
}

pub fn chamfer_min(a: f64, b: f64, k: f64) -> f64 {
    jmin(jmin(a, b), (a + b - k) * std::f64::consts::FRAC_1_SQRT_2)
}

/// Arithmetic ops on scalars (`scalarOp` of interpret.ts).
pub fn scalar_op(op: Op, a: f64, b: f64, c: f64) -> f64 {
    match op {
        Op::Add => a + b,
        Op::Sub => a - b,
        Op::Mul => a * b,
        Op::Div => a / b,
        Op::Neg => -a,
        Op::Abs => a.abs(),
        Op::Min => jmin(a, b),
        Op::Max => jmax(a, b),
        Op::Sqrt => a.sqrt(),
        Op::Square => a * a,
        Op::Sin => sin(a),
        Op::Cos => cos(a),
        Op::Atan2 => atan2(a, b),
        Op::Floor => a.floor(),
        Op::Fract => a - a.floor(),
        Op::Clamp => jmin(jmax(a, b), c),
        Op::Select => {
            if a < 0.0 {
                b
            } else {
                c
            }
        }
        Op::SminQuad => smooth_min_quad(a, b, c),
        Op::SminExp => smooth_min_exp(a, b, c),
        Op::ChamferMin => chamfer_min(a, b, c),
        _ => f64::NAN,
    }
}

impl Evaluator {
    pub fn new(program: &Program) -> Evaluator {
        Evaluator {
            instrs: program.instrs.clone(),
            output: program.output,
            constants: program.constants.clone(),
            meshes: program.meshes.iter().map(|soup| MeshSdf::new(soup.clone())).collect(),
            struts: program.struts.iter().map(StrutEval::new).collect(),
            sampled: program.sampled.clone(),
        }
    }

    /// Value of the output register at (x, y, z); `registers` is scratch of at least one double per instruction.
    pub fn value_at(&self, registers: &mut [f64], x: f64, y: f64, z: f64) -> f64 {
        let reg = |registers: &[f64], slot: i64| usize::try_from(slot).ok().and_then(|i| registers.get(i)).copied().unwrap_or(0.0);
        for (i, instr) in self.instrs.iter().enumerate() {
            let [sa, sb, sc, sm, sr] = instr.args;
            let (a, b, c) = (reg(registers, sa), reg(registers, sb), reg(registers, sc));
            registers[i] = match instr.op {
                Op::Const => self.constants[sa as usize],
                Op::X => x,
                Op::Y => y,
                Op::Z => z,
                Op::MeshSdf => self.meshes.get(sm as usize).map_or(f64::INFINITY, |m| m.distance(a, b, c)),
                Op::StrutSet => {
                    let radius = if sr >= 0 { reg(registers, sr) } else { -1.0 };
                    self.struts.get(sm as usize).map_or(f64::INFINITY, |s| s.distance(a, b, c, radius))
                }
                Op::SampleField => self.sampled.get(sm as usize).map_or(f64::NAN, |s| s.value(a, b, c)),
                op => scalar_op(op, a, b, c),
            };
        }
        registers[self.output]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tape::SLOTS;

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

    #[test]
    fn ops_follow_the_semantics_table() {
        assert_eq!(scalar_op(Op::Fract, -0.25, 0.0, 0.0), 0.75);
        assert_eq!(scalar_op(Op::Clamp, 5.0, 0.0, 3.0), 3.0);
        assert_eq!(scalar_op(Op::Select, -1.0, 7.0, 9.0), 7.0);
        assert_eq!(scalar_op(Op::Select, 0.0, 7.0, 9.0), 9.0);
        assert!(scalar_op(Op::Sqrt, -1.0, 0.0, 0.0).is_nan());
        assert!(scalar_op(Op::Const, 0.0, 0.0, 0.0).is_nan(), "non-arithmetic ops are not scalar ops");
        assert_eq!(smooth_min_quad(1.0, 1.0, 2.0), 1.0 - 0.5);
        assert_eq!(smooth_min_quad(1.0, 5.0, 2.0), 1.0);
        assert_eq!(smooth_min_quad(3.0, 1.0, 0.0), 1.0);
        assert!((smooth_min_exp(0.0, 0.0, 1.0) + std::f64::consts::LN_2).abs() < 1e-15);
        assert_eq!(smooth_min_exp(2.0, 3.0, -1.0), 2.0);
        assert_eq!(chamfer_min(0.0, 0.0, 1.0), -std::f64::consts::FRAC_1_SQRT_2);
        assert_eq!(scalar_op(Op::Atan2, 1.0, 1.0, 0.0), std::f64::consts::FRAC_PI_4);
    }

    #[test]
    fn evaluates_a_sphere_tape_and_ignores_unused_registers() {
        // |p| - 2 = sqrt(x^2 + y^2 + z^2) - r
        let e = tape(
            &[
                (Op::X, [-1; SLOTS]),
                (Op::Y, [-1; SLOTS]),
                (Op::Z, [-1; SLOTS]),
                (Op::Square, [0, -1, -1, -1, -1]),
                (Op::Square, [1, -1, -1, -1, -1]),
                (Op::Square, [2, -1, -1, -1, -1]),
                (Op::Add, [3, 4, -1, -1, -1]),
                (Op::Add, [6, 5, -1, -1, -1]),
                (Op::Sqrt, [7, -1, -1, -1, -1]),
                (Op::Const, [0, -1, -1, -1, -1]),
                (Op::Sub, [8, 9, -1, -1, -1]),
            ],
            vec![2.0],
            10,
        );
        let mut regs = vec![0.0; e.instrs.len()];
        assert_eq!(e.value_at(&mut regs, 2.0, 0.0, 0.0), 0.0);
        assert_eq!(e.value_at(&mut regs, 0.0, 0.0, 0.0), -2.0);
        assert_eq!(e.value_at(&mut regs, 3.0, 4.0, 0.0), 3.0);
    }
}
