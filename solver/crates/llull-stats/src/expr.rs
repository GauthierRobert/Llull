//! Stack-up expression tree (the JSON of `StackNode`, `packages/core/src/lib/stackExpression.ts`): parsed by the host, evaluated here once
//! per sample. Variables are contributor positions; the differentiable built-ins of the TypeScript grammar.

use serde::Deserialize;

/// Wire form of one node (`kind` tags the variant, like the TypeScript union).
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Node {
    Num { value: f64 },
    Var { index: usize },
    Neg { operand: Box<Node> },
    Bin { op: String, left: Box<Node>, right: Box<Node> },
    Call { name: String, args: Vec<Node> },
}

/// A validated, directly evaluable tree.
#[derive(Debug)]
pub enum Expr {
    Num(f64),
    Var(usize),
    Neg(Box<Expr>),
    Add(Box<Expr>, Box<Expr>),
    Sub(Box<Expr>, Box<Expr>),
    Mul(Box<Expr>, Box<Expr>),
    Div(Box<Expr>, Box<Expr>),
    Unary(fn(f64) -> f64, Box<Expr>),
    Binary(fn(f64, f64) -> f64, Box<Expr>, Box<Expr>),
}

fn unary(name: &str) -> Option<fn(f64) -> f64> {
    Some(match name {
        "sin" => f64::sin,
        "cos" => f64::cos,
        "tan" => f64::tan,
        "asin" => f64::asin,
        "acos" => f64::acos,
        "atan" => f64::atan,
        "sqrt" => f64::sqrt,
        "abs" => f64::abs,
        "exp" => f64::exp,
        "ln" => f64::ln,
        _ => return None,
    })
}

fn binary(name: &str) -> Option<fn(f64, f64) -> f64> {
    Some(match name {
        "pow" => f64::powf,
        "hypot" => f64::hypot,
        _ => return None,
    })
}

impl Expr {
    /// Validates `node` against `variables` contributors: known operators / functions, right arity, variable indices in range.
    pub fn build(node: Node, variables: usize) -> Result<Expr, String> {
        Ok(match node {
            Node::Num { value } => Expr::Num(value),
            Node::Var { index } if index < variables => Expr::Var(index),
            Node::Var { index } => return Err(format!("variable index {index} is out of range ({variables} contributors)")),
            Node::Neg { operand } => Expr::Neg(Box::new(Expr::build(*operand, variables)?)),
            Node::Bin { op, left, right } => {
                let (l, r) = (Box::new(Expr::build(*left, variables)?), Box::new(Expr::build(*right, variables)?));
                match op.as_str() {
                    "+" => Expr::Add(l, r),
                    "-" => Expr::Sub(l, r),
                    "*" => Expr::Mul(l, r),
                    "/" => Expr::Div(l, r),
                    other => return Err(format!("unknown operator '{other}'")),
                }
            }
            Node::Call { name, mut args } => match (args.len(), unary(&name), binary(&name)) {
                (1, Some(f), _) => Expr::Unary(f, Box::new(Expr::build(args.remove(0), variables)?)),
                (2, _, Some(f)) => {
                    let second = args.remove(1);
                    Expr::Binary(f, Box::new(Expr::build(args.remove(0), variables)?), Box::new(Expr::build(second, variables)?))
                }
                _ => return Err(format!("unknown function '{name}' or wrong argument count ({})", args.len())),
            },
        })
    }

    pub fn eval(&self, values: &[f64]) -> f64 {
        match self {
            Expr::Num(value) => *value,
            Expr::Var(index) => values[*index],
            Expr::Neg(operand) => -operand.eval(values),
            Expr::Add(l, r) => l.eval(values) + r.eval(values),
            Expr::Sub(l, r) => l.eval(values) - r.eval(values),
            Expr::Mul(l, r) => l.eval(values) * r.eval(values),
            Expr::Div(l, r) => l.eval(values) / r.eval(values),
            Expr::Unary(f, operand) => f(operand.eval(values)),
            Expr::Binary(f, a, b) => f(a.eval(values), b.eval(values)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str, variables: usize) -> Result<Expr, String> {
        Expr::build(serde_json::from_str(text).map_err(|error| error.to_string())?, variables)
    }

    #[test]
    fn evaluates_arithmetic_and_calls() {
        // H - hypot(A, 2) * 0.5, with H = x0, A = x1
        let tree = r#"{"kind":"bin","op":"-","left":{"kind":"var","index":0},"right":{"kind":"bin","op":"*",
            "left":{"kind":"call","name":"hypot","args":[{"kind":"var","index":1},{"kind":"num","value":2}]},
            "right":{"kind":"num","value":0.5}}}"#;
        let expr = parse(tree, 2).unwrap();
        assert_eq!(expr.eval(&[10.0, 1.5]), 10.0 - 1.5f64.hypot(2.0) * 0.5);
        let negated = parse(r#"{"kind":"neg","operand":{"kind":"call","name":"sqrt","args":[{"kind":"var","index":0}]}}"#, 1).unwrap();
        assert_eq!(negated.eval(&[9.0]), -3.0);
    }

    #[test]
    fn refuses_unknown_names_bad_arity_and_out_of_range_variables() {
        assert!(parse(r#"{"kind":"var","index":2}"#, 2).unwrap_err().contains("out of range"));
        assert!(parse(r#"{"kind":"call","name":"nope","args":[{"kind":"num","value":1}]}"#, 1).unwrap_err().contains("unknown function"));
        assert!(parse(r#"{"kind":"call","name":"pow","args":[{"kind":"num","value":1}]}"#, 1).is_err());
        assert!(parse(r#"{"kind":"bin","op":"%","left":{"kind":"num","value":1},"right":{"kind":"num","value":1}}"#, 1)
            .unwrap_err()
            .contains("unknown operator"));
    }
}
