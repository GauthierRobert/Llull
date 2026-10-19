//! The postfix expression program of `packages/core/src/lib/expressionProgram.ts`, evaluated with JavaScript semantics. Arithmetic,
//! `sqrt`, `abs`, `floor`, `ceil`, `trunc`, `sign`, `min`, `max` and `mod` are IEEE-exact; `pow`, `exp`, `ln`, `log10`, `hypot` and
//! `round` use the V8-exact twins of `llull-jsmath`; trigonometric functions use the platform libm (statistically equal, not bit-equal).

use serde::Deserialize;

/// One program step as the host writes it (`{ "op": "const", "value": 2 }`, `{ "op": "call", "fn": "sqrt", "argc": 1 }`, ...).
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Step {
    Const {
        value: f64,
    },
    Var {
        index: usize,
    },
    Neg,
    Add,
    Sub,
    Mul,
    Div,
    Call {
        #[serde(rename = "fn")]
        function: String,
        argc: usize,
    },
}

#[derive(Debug, Clone, Copy)]
enum Function {
    Sin,
    Cos,
    Tan,
    Asin,
    Acos,
    Atan,
    Atan2,
    Sqrt,
    Abs,
    Floor,
    Ceil,
    Round,
    Trunc,
    Sign,
    Exp,
    Ln,
    Log10,
    Pow,
    Hypot,
    Mod,
    Min,
    Max,
}

impl Function {
    /// Name -> function and its accepted argument count range (the TS `BUILTIN_FUNCTIONS` table).
    fn parse(name: &str) -> Option<(Function, usize, usize)> {
        use Function::*;
        Some(match name {
            "sin" => (Sin, 1, 1),
            "cos" => (Cos, 1, 1),
            "tan" => (Tan, 1, 1),
            "asin" => (Asin, 1, 1),
            "acos" => (Acos, 1, 1),
            "atan" => (Atan, 1, 1),
            "atan2" => (Atan2, 2, 2),
            "sqrt" => (Sqrt, 1, 1),
            "abs" => (Abs, 1, 1),
            "floor" => (Floor, 1, 1),
            "ceil" => (Ceil, 1, 1),
            "round" => (Round, 1, 1),
            "trunc" => (Trunc, 1, 1),
            "sign" => (Sign, 1, 1),
            "exp" => (Exp, 1, 1),
            "ln" => (Ln, 1, 1),
            "log10" => (Log10, 1, 1),
            "pow" => (Pow, 2, 2),
            "hypot" => (Hypot, 1, 8),
            "mod" => (Mod, 2, 2),
            "min" => (Min, 1, 16),
            "max" => (Max, 1, 16),
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy)]
enum Op {
    Const(f64),
    Var(usize),
    Neg,
    Add,
    Sub,
    Mul,
    Div,
    Call(Function, usize),
}

/// A validated program: every step is known, the stack never underflows and ends with exactly one value.
#[derive(Debug, Clone)]
pub struct Program {
    ops: Vec<Op>,
    depth: usize,
}

/// JavaScript `Math.sign`.
fn js_sign(x: f64) -> f64 {
    if x.is_nan() || x == 0.0 {
        x
    } else if x > 0.0 {
        1.0
    } else {
        -1.0
    }
}

/// JavaScript `Math.min` / `Math.max`: NaN wins, −0 < +0.
fn js_extreme(args: &[f64], max: bool) -> f64 {
    let mut result = if max { f64::NEG_INFINITY } else { f64::INFINITY };
    for &v in args {
        if v.is_nan() {
            return f64::NAN;
        }
        let better = if max { v > result } else { v < result };
        let signed_zero = v == 0.0 && result == 0.0 && (v.is_sign_negative() != max);
        if better || signed_zero {
            result = v;
        }
    }
    result
}

fn call(function: Function, args: &[f64]) -> f64 {
    use Function::*;
    let a = args[0];
    let b = args.get(1).copied().unwrap_or(f64::NAN);
    match function {
        Sin => a.sin(),
        Cos => a.cos(),
        Tan => a.tan(),
        Asin => a.asin(),
        Acos => a.acos(),
        Atan => a.atan(),
        Atan2 => a.atan2(b),
        Sqrt => a.sqrt(),
        Abs => a.abs(),
        Floor => a.floor(),
        Ceil => a.ceil(),
        Round => llull_jsmath::round(a),
        Trunc => a.trunc(),
        Sign => js_sign(a),
        Exp => llull_jsmath::exp(a),
        Ln => llull_jsmath::log(a),
        Log10 => llull_jsmath::log10(a),
        Pow => llull_jsmath::pow(a, b),
        Hypot => llull_jsmath::hypot(args),
        Mod => a - b * (a / b).floor(),
        Min => js_extreme(args, false),
        Max => js_extreme(args, true),
    }
}

impl Program {
    /// Validates `steps` over `variables` inputs.
    pub fn compile(steps: &[Step], variables: usize) -> Result<Program, String> {
        let mut ops = Vec::with_capacity(steps.len());
        let mut height = 0usize;
        let mut depth = 0usize;
        for (i, step) in steps.iter().enumerate() {
            let (op, pops) = match step {
                Step::Const { value } => (Op::Const(*value), 0),
                Step::Var { index } if *index < variables => (Op::Var(*index), 0),
                Step::Var { index } => return Err(format!("step {i}: variable {index} out of range")),
                Step::Neg => (Op::Neg, 1),
                Step::Add => (Op::Add, 2),
                Step::Sub => (Op::Sub, 2),
                Step::Mul => (Op::Mul, 2),
                Step::Div => (Op::Div, 2),
                Step::Call { function, argc } => {
                    let (f, min, max) = Function::parse(function).ok_or_else(|| format!("step {i}: unknown function {function}"))?;
                    if *argc < min || *argc > max {
                        return Err(format!("step {i}: {function} takes {min}-{max} arguments"));
                    }
                    (Op::Call(f, *argc), *argc)
                }
            };
            if height < pops {
                return Err(format!("step {i}: stack underflow"));
            }
            height = height - pops + 1;
            depth = depth.max(height);
            ops.push(op);
        }
        if height != 1 {
            return Err(format!("the program leaves {height} values (one expected)"));
        }
        Ok(Program { ops, depth })
    }

    /// Scratch stack large enough for `evaluate`.
    pub fn stack(&self) -> Vec<f64> {
        vec![0.0; self.depth]
    }

    /// y = f(x), with the same operations in the same order as the TS closure tree.
    pub fn evaluate(&self, x: &[f64], stack: &mut [f64]) -> f64 {
        let mut top = 0usize;
        for op in &self.ops {
            match *op {
                Op::Const(value) => {
                    stack[top] = value;
                    top += 1;
                }
                Op::Var(index) => {
                    stack[top] = x[index];
                    top += 1;
                }
                Op::Neg => stack[top - 1] = -stack[top - 1],
                Op::Add | Op::Sub | Op::Mul | Op::Div => {
                    let (a, b) = (stack[top - 2], stack[top - 1]);
                    stack[top - 2] = match op {
                        Op::Add => a + b,
                        Op::Sub => a - b,
                        Op::Mul => a * b,
                        _ => a / b,
                    };
                    top -= 1;
                }
                Op::Call(function, argc) => {
                    let value = call(function, &stack[top - argc..top]);
                    top -= argc;
                    stack[top] = value;
                    top += 1;
                }
            }
        }
        stack[0]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn steps(json: &str) -> Vec<Step> {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn evaluates_with_javascript_semantics() {
        let program = Program::compile(
            &steps(
                r#"[{"op":"var","index":0},{"op":"const","value":2},{"op":"call","fn":"pow","argc":2},
                {"op":"var","index":1},{"op":"neg"},{"op":"call","fn":"abs","argc":1},{"op":"add"},
                {"op":"const","value":-0.0},{"op":"const","value":0},{"op":"call","fn":"min","argc":2},{"op":"sub"}]"#,
            ),
            2,
        )
        .unwrap();
        let mut stack = program.stack();
        assert_eq!(program.evaluate(&[3.0, -4.0], &mut stack), 13.0);
        assert_eq!(js_extreme(&[0.0, -0.0], false).to_bits(), (-0.0f64).to_bits());
        assert_eq!(js_extreme(&[-0.0, 0.0], true).to_bits(), 0.0f64.to_bits());
        assert!(js_extreme(&[1.0, f64::NAN], true).is_nan());
        assert_eq!(js_sign(-3.0), -1.0);
        assert!(js_sign(f64::NAN).is_nan());
        assert_eq!(call(Function::Mod, &[-7.0, 3.0]), 2.0);
        assert_eq!(call(Function::Hypot, &[3.0, 4.0]), 5.0);
    }

    #[test]
    fn refuses_malformed_programs() {
        assert!(Program::compile(&steps(r#"[{"op":"add"}]"#), 1).unwrap_err().contains("underflow"));
        assert!(Program::compile(&steps(r#"[{"op":"var","index":3}]"#), 1).unwrap_err().contains("out of range"));
        assert!(Program::compile(&steps(r#"[{"op":"const","value":1},{"op":"call","fn":"nope","argc":1}]"#), 1)
            .unwrap_err()
            .contains("unknown function"));
        assert!(Program::compile(&steps(r#"[{"op":"const","value":1},{"op":"call","fn":"pow","argc":1}]"#), 1)
            .unwrap_err()
            .contains("takes 2-2"));
        assert!(Program::compile(&steps(r#"[{"op":"const","value":1},{"op":"const","value":1}]"#), 1).unwrap_err().contains("leaves 2"));
    }
}
