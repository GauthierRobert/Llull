//! Tape builder for the unit tests: SSA registers returned as `i64` handles.

use crate::eval::Evaluator;
use crate::tape::{Instr, Op, SLOTS};

#[derive(Default)]
pub struct Tape {
    instrs: Vec<Instr>,
    constants: Vec<f64>,
}

impl Tape {
    pub fn new() -> Tape {
        Tape::default()
    }

    fn push(&mut self, op: Op, args: &[i64]) -> i64 {
        let mut slots = [-1; SLOTS];
        slots[..args.len()].copy_from_slice(args);
        self.instrs.push(Instr { op, args: slots });
        self.instrs.len() as i64 - 1
    }

    pub fn x(&mut self) -> i64 {
        self.push(Op::X, &[])
    }

    pub fn y(&mut self) -> i64 {
        self.push(Op::Y, &[])
    }

    pub fn z(&mut self) -> i64 {
        self.push(Op::Z, &[])
    }

    pub fn c(&mut self, value: f64) -> i64 {
        self.constants.push(value);
        let index = self.constants.len() as i64 - 1;
        self.push(Op::Const, &[index])
    }

    pub fn un(&mut self, op: Op, a: i64) -> i64 {
        self.push(op, &[a])
    }

    pub fn bin(&mut self, op: Op, a: i64, b: i64) -> i64 {
        self.push(op, &[a, b])
    }

    /// Signed distance to the ball of radius `r` at (cx, cy, cz).
    pub fn ball(&mut self, centre: [f64; 3], r: f64) -> i64 {
        let (x, y, z) = (self.x(), self.y(), self.z());
        let mut sum = None;
        for (axis, p) in [x, y, z].into_iter().enumerate() {
            let c = self.c(centre[axis]);
            let d = self.bin(Op::Sub, p, c);
            let sq = self.un(Op::Square, d);
            sum = Some(match sum {
                None => sq,
                Some(s) => self.bin(Op::Add, s, sq),
            });
        }
        let root = self.un(Op::Sqrt, sum.unwrap_or(0));
        let radius = self.c(r);
        self.bin(Op::Sub, root, radius)
    }

    pub fn finish(self, output: i64) -> Evaluator {
        Evaluator {
            instrs: self.instrs,
            output: output as usize,
            constants: self.constants,
            meshes: vec![],
            struts: vec![],
            sampled: vec![],
        }
    }
}
