//! The `deform` recipe node (01 DEF M2): exact warp of the source shape, plus the report of the last build of each node.

use super::{canonical_key, refused, shape_of, EvalError, Evaluated, Evaluator};
use serde_json::Value;

impl Evaluator {
    /// `deform`: the source warped by the node's law; an unknown law is unsupported (the host falls back), a refusal keeps its report.
    pub(super) fn deform(&mut self, recipe: &Value) -> Evaluated {
        let Some(source) = self.child(recipe, "source")? else { return refused() };
        let Some(spec) = crate::deform::spec_of(recipe) else {
            return Err(EvalError::Unsupported("deform law".to_string()));
        };
        let warped = crate::deform::warp(&source, &spec).map_err(EvalError::Failure)?;
        self.reports.insert(canonical_key(recipe), warped.report);
        shape_of(Ok(warped.shape))
    }

    /// `deformReport`: how the `deform` node `recipe` built (or why it was refused), null for another node.
    pub fn deform_report(&mut self, recipe: &Value) -> Result<Value, EvalError> {
        if recipe.get("op").and_then(Value::as_str) != Some("deform") {
            return Ok(Value::Null);
        }
        self.evaluate(recipe)?;
        Ok(self.reports.get(&canonical_key(recipe)).cloned().unwrap_or(Value::Null))
    }
}
