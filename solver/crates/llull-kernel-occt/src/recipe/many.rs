//! The multi-tool `boolean` node (ASC M1a): `{ op: "boolean", boolean: "union" | "subtract", a, b, many: n }` where `b` is the balanced
//! union of `n` tools (what `boolean.ts` builds, and what every kernel without the native op evaluates). Here the `n` tools are read back
//! out of that tree and handed to ONE General Fuse / Cut; when its result is refused the balanced tree `b` is evaluated as before and the
//! node's report says `KRN_FUSE_FALLBACK`.

use super::{canonical_key, refused, shape_of, EvalError, Evaluated, Evaluator};
use crate::{BooleanOp, ManyOutcome};
use serde_json::{json, Value};
use std::rc::Rc;

/// Most tools one node may name (the TS `MAX_BOOLEAN_TOOLS`); a larger `many` is untrusted input and evaluates as the plain tree.
const MAX_MANY: usize = 1000;

/// The `n` leaves of a balanced union built by splitting at `ceil(n / 2)`; None when `tree` is not that shape.
fn tools_of(tree: &Value, count: usize, out: &mut Vec<Value>) -> Option<()> {
    if count == 1 {
        out.push(tree.clone());
        return Some(());
    }
    if tree.get("op").and_then(Value::as_str) != Some("boolean") || tree.get("boolean").and_then(Value::as_str) != Some("union") {
        return None;
    }
    let head = count.div_ceil(2);
    tools_of(tree.get("a")?, head, out)?;
    tools_of(tree.get("b")?, count - head, out)
}

/// Ops whose parameters are topology indices (`edges`, `faces`, ...) of their source: they read the source's edge / face ORDER, which the
/// General Fuse and the balanced tree do not share (same faces, another edge order), so such a node never evaluates a `many` below it.
pub(super) const INDEXED_OPS: [&str; 6] = ["fillet", "chamfer", "blend", "faceOp", "faceBlend", "fullRound"];

/// `recipe` with every `many` of the boolean nodes along its `a` / `b` / `source` paths removed (the plain balanced trees); None when it has none.
pub(super) fn without_many(recipe: &Value) -> Option<Value> {
    let mut changed = false;
    let mut copy = recipe.clone();
    if let Some(fields) = copy.as_object_mut() {
        changed |= fields.remove("many").is_some();
        for field in ["a", "b", "source"] {
            if let Some(stripped) = fields.get(field).and_then(without_many) {
                fields.insert(field.to_string(), stripped);
                changed = true;
            }
        }
    }
    changed.then_some(copy)
}

impl Evaluator {
    /// The node as one multi-tool operation, or None when it is not one (no / bad `many`, intersect, a `b` that is not the balanced tree).
    pub(super) fn boolean_many(&mut self, recipe: &Value, operation: BooleanOp, threaded: bool) -> Option<Evaluated> {
        let count = usize::try_from(recipe.get("many")?.as_u64()?).ok().filter(|count| (2..=MAX_MANY).contains(count))?;
        if operation == BooleanOp::Intersect {
            return None;
        }
        let mut tools = Vec::new();
        tools_of(recipe.get("b")?, count, &mut tools)?;
        Some(self.fuse_or_cut(recipe, operation, &tools, threaded))
    }

    fn fuse_or_cut(&mut self, recipe: &Value, operation: BooleanOp, tools: &[Value], threaded: bool) -> Evaluated {
        let Some(a) = self.child(recipe, "a")? else { return refused() };
        let mut shapes: Vec<Rc<crate::Shape>> = Vec::with_capacity(tools.len());
        for tool in tools {
            let Some(shape) = self.evaluate(tool)? else { return refused() };
            shapes.push(shape);
        }
        let borrowed: Vec<&crate::Shape> = shapes.iter().map(Rc::as_ref).collect();
        let key = canonical_key(recipe);
        let reason = match crate::boolean_many(operation, &a, &borrowed, !threaded).map_err(EvalError::Failure)? {
            ManyOutcome::Built(shape) => {
                self.reports.insert(key, json!({ "mode": "general-fuse", "tools": tools.len() }));
                return shape_of(Ok(Some(*shape)));
            }
            ManyOutcome::Fallback(reason) => reason.to_string(),
        };
        eprintln!("KRN_FUSE_FALLBACK: {} tools, {reason}; the balanced tree ran", tools.len());
        self.reports.insert(
            key,
            json!({ "mode": "balanced-tree", "tools": tools.len(), "fallback": true, "code": "KRN_FUSE_FALLBACK", "reason": reason }),
        );
        let Some(b) = self.child(recipe, "b")? else { return refused() };
        shape_of(crate::boolean(operation, &a, &b, !threaded))
    }

    /// `booleanReport`: how the multi-tool `boolean` node `recipe` ran (`general-fuse` or the `balanced-tree` fallback with
    /// `code: KRN_FUSE_FALLBACK`); null for another node.
    pub fn boolean_report(&mut self, recipe: &Value) -> Result<Value, EvalError> {
        if recipe.get("op").and_then(Value::as_str) != Some("boolean") || recipe.get("many").is_none() {
            return Ok(Value::Null);
        }
        self.evaluate(recipe)?;
        Ok(self.reports.get(&canonical_key(recipe)).cloned().unwrap_or(Value::Null))
    }
}
