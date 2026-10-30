//! The `faceOp` recipe node: kinds `draft`, `pushPull`, `splitFace` (SC-F1) and `moveFaces`, `deleteFaces` (04 DIR M6): `packages/core/src/model/faceOps.ts` on the source's unique faces.

use super::nodes::{indices, vec3_of};
use super::{number, refused, shape_of, vec3, EvalError, Evaluated, Evaluator};
use crate::features;
use serde_json::Value;

impl Evaluator {
    /// `faceOp` (SC-F1, `packages/core/src/model/faceOps.ts`): draft, pushPull or splitFace on the source's unique faces.
    pub(super) fn face_op(&mut self, recipe: &Value) -> Evaluated {
        let Some(source) = self.child(recipe, "source")? else { return refused() };
        let Some(faces) = indices(recipe.get("faces")).filter(|faces| !faces.is_empty()) else { return refused() };
        let plane = |field: &str| {
            let plane = recipe.get(field)?;
            Some((vec3_of(plane.get("origin"))?, vec3_of(plane.get("normal"))?))
        };
        match recipe.get("kind").and_then(Value::as_str) {
            Some("draft") => {
                let (Some(pull), Some((origin, normal))) = (vec3(recipe, "pull"), plane("neutral")) else { return refused() };
                let angle = number(recipe, "angle").unwrap_or(f64::NAN);
                if !angle.is_finite() || angle == 0.0 {
                    return refused();
                }
                shape_of(features::draft(&source, &faces, angle, pull, origin, normal))
            }
            Some("pushPull") => {
                let distance = number(recipe, "distance").unwrap_or(f64::NAN);
                match faces.as_slice() {
                    [face] if distance.is_finite() && distance != 0.0 => shape_of(features::push_pull(&source, *face, distance)),
                    _ => refused(),
                }
            }
            Some("splitFace") => match plane("plane") {
                Some((origin, normal)) => shape_of(features::split_faces(&source, &faces, origin, normal)),
                None => refused(),
            },
            Some("moveFaces") => {
                let Some(move_spec) = recipe.get("move") else { return refused() };
                let value = |field: &str| number(move_spec, field).unwrap_or(f64::NAN);
                // `unchecked` (a dry run for a ghost) is the only way to skip the validity check of the prism route
                let check = !recipe.get("unchecked").and_then(Value::as_bool).unwrap_or(false);
                let built = match move_spec.get("type").and_then(Value::as_str) {
                    Some("offset") => features::move_faces(&source, &faces, 0, &[], &[], value("distance"), check),
                    Some("translate") => match vec3(move_spec, "vector") {
                        Some(vector) => features::move_faces(&source, &faces, 1, &vector, &[], 0.0, check),
                        None => return refused(),
                    },
                    Some("rotate") => {
                        let axis = move_spec.get("axis");
                        let (Some(origin), Some(direction)) =
                            (vec3_of(axis.and_then(|axis| axis.get("origin"))), vec3_of(axis.and_then(|axis| axis.get("direction"))))
                        else {
                            return refused();
                        };
                        features::move_faces(&source, &faces, 2, &origin, &direction, value("angle"), check)
                    }
                    _ => return refused(),
                };
                shape_of(built)
            }
            Some("deleteFaces") => shape_of(features::delete_faces(&source, &faces)),
            other => Err(EvalError::Unsupported(format!("faceOp kind '{}'", other.unwrap_or("")))),
        }
    }
}
