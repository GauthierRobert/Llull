//! `ShapeRecipe` JSON (`packages/core/src/model/types.ts`) -> OCCT shape, mirroring `packages/kernel-occt/src/occtShapes.ts` and the
//! recipe walk of `packages/core/src/geometry/shapeKernel.ts`. Sub-recipes are cached by the sha256 of their canonical JSON (serde_json
//! maps are sorted), so an unchanged prefix of the feature tree is built once.
//!
//! Native: recipe ops `solid`, `boolean`, `place`, `scale`, `brep` (a document blob loaded with [`Evaluator::load_blob`]), `fillet`,
//! `chamfer`, `blend`, `shell` and `featureCut` (a `feature` node the host lowered, see [`nodes`]); solid kinds box, cylinder, sphere,
//! cone, torus, wedge, extrusion and revolution (polygon or exact curve chain), triangle mesh (thread groove tools included), loft,
//! sweep and subdivision. Anything else is [`EvalError::Unsupported`]: the host evaluates that recipe with the WASM kernel instead.
//! Fillet / chamfer edge indices come from `topology`, which numbers edges like the WASM kernel (unique sub-shapes in explorer order).

use crate::lru::Lru;
use crate::{BooleanOp, Built, Shape};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::rc::Rc;

mod floor;
mod nodes;

pub const RECIPE_OPS: [&str; 10] = ["solid", "boolean", "place", "scale", "brep", "fillet", "chamfer", "blend", "shell", "featureCut"];
pub const SOLID_KINDS: [&str; 12] =
    ["box", "cylinder", "sphere", "cone", "torus", "wedge", "extrusion", "revolution", "mesh", "loft", "sweep", "subdivision"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EvalError {
    /// Not implemented natively (a capability gap): the host falls back to another kernel.
    Unsupported(String),
    /// OCCT threw while building: the recipe is refused (cached as null, like the WASM kernel's refusals).
    Failure(String),
}

pub type Evaluated = Result<Option<Rc<Shape>>, EvalError>;

pub struct Evaluator {
    cache: Lru<Option<Rc<Shape>>>,
    builds: u64,
    /// Document blobs (`BRepTools::Write` text by sha256 hex) that `brep` leaves read.
    blobs: HashMap<String, String>,
}

/// Lower-case hex sha256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Content key of a recipe: sha256 hex of its canonical JSON.
pub fn canonical_key(recipe: &Value) -> String {
    sha256_hex(recipe.to_string().as_bytes())
}

fn shape_of(built: Built) -> Evaluated {
    built.map(|shape| shape.map(Rc::new)).map_err(EvalError::Failure)
}

fn number(value: &Value, field: &str) -> Option<f64> {
    value.get(field)?.as_f64()
}

fn vec3(value: &Value, field: &str) -> Option<[f64; 3]> {
    let items = value.get(field)?.as_array()?;
    match items.as_slice() {
        [x, y, z] => Some([x.as_f64()?, y.as_f64()?, z.as_f64()?]),
        _ => None,
    }
}

fn polygon2(value: &Value, field: &str) -> Option<Vec<[f64; 2]>> {
    value.get(field)?.as_array()?.iter().map(|point| Some([point.get(0)?.as_f64()?, point.get(1)?.as_f64()?])).collect()
}

fn signed_area(points: &[[f64; 2]]) -> f64 {
    let count = points.len();
    (0..count)
        .map(|i| {
            let ([x1, y1], [x2, y2]) = (points[i], points[(i + 1) % count]);
            x1 * y2 - x2 * y1
        })
        .sum::<f64>()
        / 2.0
}

/// `isValidPolygon` of `packages/core/src/lib/polygon.ts`.
fn is_valid_polygon(points: &[[f64; 2]]) -> bool {
    points.len() >= 3 && points.iter().all(|[x, y]| x.is_finite() && y.is_finite()) && signed_area(points).abs() > 1e-12
}

fn counter_clockwise(points: &[[f64; 2]]) -> Vec<[f64; 2]> {
    let mut ordered = points.to_vec();
    if signed_area(points) < 0.0 {
        ordered.reverse();
    }
    ordered
}

/// `revolutionAxisIndex`: the dominant component of the axis, sign ignored (ties favour Z, then Y).
fn revolution_axis_index([x, y, z]: [f64; 3]) -> usize {
    let (ax, ay, az) = (x.abs(), y.abs(), z.abs());
    if az >= ax && az >= ay {
        2
    } else if ay >= ax {
        1
    } else {
        0
    }
}

fn has(value: &Value, field: &str) -> bool {
    value.get(field).is_some_and(|inner| !inner.is_null())
}

/// Entity placement (rotation, position), defaulting to identity like a fresh entity.
fn placement(entity: &Value) -> ([f64; 3], [f64; 3]) {
    (vec3(entity, "rotation").unwrap_or([0.0; 3]), vec3(entity, "position").unwrap_or([0.0; 3]))
}

fn place_entity(shape: Option<Rc<Shape>>, entity: &Value, anchor_shift: [f64; 3]) -> Evaluated {
    let Some(shape) = shape else { return Ok(None) };
    let (rotation, position) = placement(entity);
    shape_of(crate::placed(&shape, rotation, position, anchor_shift))
}

/// `value > 0`, false for NaN (a missing field reads as NaN, like `undefined > 0` in the WASM kernel).
fn positive(value: f64) -> bool {
    value > 0.0
}

fn at_least(value: f64, minimum: f64) -> bool {
    value >= minimum
}

fn refused() -> Evaluated {
    Ok(None)
}

fn box_solid(entity: &Value) -> Evaluated {
    let Some([sx, sy, sz]) = vec3(entity, "size") else { return refused() };
    if !(sx > 0.0 && sy > 0.0 && sz > 0.0) {
        return refused();
    }
    let (rotation, [px, py, pz]) = placement(entity);
    let rotated = rotation.iter().any(|angle| *angle != 0.0);
    let origin = if rotated { [-sx / 2.0, -sy / 2.0, -sz / 2.0] } else { [px - sx / 2.0, py - sy / 2.0, pz - sz / 2.0] };
    let shape = shape_of(crate::make_box(origin, [sx, sy, sz]))?;
    if rotated {
        place_entity(shape, entity, [0.0; 3])
    } else {
        Ok(shape)
    }
}

fn revolved_primitive(entity: &Value, kind: &str) -> Evaluated {
    let radius = number(entity, "radius").unwrap_or(f64::NAN);
    let height = number(entity, "height").unwrap_or(f64::NAN);
    let (built, anchor) = match kind {
        "cylinder" if radius > 0.0 && height > 0.0 => (crate::make_cylinder(radius, height), [0.0, 0.0, -height / 2.0]),
        "sphere" if radius > 0.0 => (crate::make_sphere(radius), [0.0; 3]),
        "cone" if radius > 0.0 && height > 0.0 => (crate::make_cone(radius, 0.0, height), [0.0; 3]),
        "torus" => {
            let ring = number(entity, "ringRadius").unwrap_or(f64::NAN);
            let tube = number(entity, "tubeRadius").unwrap_or(f64::NAN);
            if !(tube > 0.0 && ring > tube) {
                return refused();
            }
            (crate::make_torus(ring, tube), [0.0; 3])
        }
        _ => return refused(),
    };
    place_entity(shape_of(built)?, entity, anchor)
}

fn flat(points: impl Iterator<Item = [f64; 3]>) -> Vec<f64> {
    points.flatten().collect()
}

fn wedge_solid(entity: &Value) -> Evaluated {
    let Some([width, height, depth]) = vec3(entity, "size") else { return refused() };
    if !(width > 0.0 && height > 0.0 && depth > 0.0) {
        return refused();
    }
    let polygon = [0.0, 0.0, 0.0, 0.0, height, 0.0, 0.0, 0.0, depth];
    place_entity(shape_of(crate::make_prism(&polygon, [width, 0.0, 0.0]))?, entity, [0.0; 3])
}

fn extruded_profile(entity: &Value) -> Evaluated {
    if has(entity, "curves") {
        return Err(EvalError::Unsupported("extrusion with exact curves the host did not chain".to_string()));
    }
    let Some(profile) = polygon2(entity, "profile") else { return refused() };
    let depth = number(entity, "depth").unwrap_or(f64::NAN);
    if !is_valid_polygon(&profile) || !positive(depth) {
        return refused();
    }
    if let Some(face) = nodes::profile_chain_face(entity) {
        let Some(face) = face.map_err(EvalError::Failure)? else { return refused() };
        return nodes::prism(face, depth, entity);
    }
    let polygon = flat(counter_clockwise(&profile).into_iter().map(|[x, y]| [x, y, 0.0]));
    place_entity(shape_of(crate::make_prism(&polygon, [0.0, 0.0, depth]))?, entity, [0.0; 3])
}

fn revolved_profile(entity: &Value) -> Evaluated {
    if has(entity, "curves") {
        return Err(EvalError::Unsupported("revolution with exact curves the host did not chain".to_string()));
    }
    let Some(profile) = polygon2(entity, "profile") else { return refused() };
    let angle = number(entity, "angle").unwrap_or(f64::NAN);
    let segments = number(entity, "segments").unwrap_or(f64::NAN);
    let Some(axis) = vec3(entity, "axis") else { return refused() };
    if !is_valid_polygon(&profile) || !positive(angle) || !at_least(segments, 3.0) {
        return refused();
    }
    let frame = revolution_axis_index(axis);
    let sweep_axis = match frame {
        2 => [0.0, 0.0, 1.0],
        1 => [0.0, -1.0, 0.0],
        _ => [1.0, 0.0, 0.0],
    };
    if let Some(face) = nodes::profile_chain_face(entity) {
        let Some(face) = face.map_err(EvalError::Failure)? else { return refused() };
        return nodes::revolution(face, sweep_axis, angle, entity);
    }
    // The profile's winding must agree with the sweep direction or the solid comes out inside-out (occtShapes.ts revolvedProfile).
    let mut ordered = counter_clockwise(&profile);
    if frame != 1 {
        ordered.reverse();
    }
    let place = |[radial, axial]: [f64; 2]| match frame {
        2 => [radial, 0.0, axial],
        1 => [radial, axial, 0.0],
        _ => [axial, radial, 0.0],
    };
    let polygon = flat(ordered.into_iter().map(place));
    place_entity(shape_of(crate::make_revolution(&polygon, sweep_axis, angle))?, entity, [0.0; 3])
}

fn mesh_solid(entity: &Value) -> Evaluated {
    let mesh = entity.get("mesh");
    let read = |field: &str| mesh.and_then(|inner| inner.get(field)).and_then(Value::as_array);
    let (Some(positions), Some(indices)) = (read("positions"), read("indices")) else { return refused() };
    let positions: Option<Vec<f64>> = positions.iter().map(Value::as_f64).collect();
    let indices: Option<Vec<u32>> = indices.iter().map(|index| index.as_u64().and_then(|value| u32::try_from(value).ok())).collect();
    let (Some(positions), Some(indices)) = (positions, indices) else { return refused() };
    let shape = shape_of(crate::make_sewn_solid(&positions, &indices))?;
    let (rotation, position) = placement(entity);
    if rotation.iter().chain(position.iter()).any(|value| *value != 0.0) {
        place_entity(shape, entity, [0.0; 3])
    } else {
        Ok(shape)
    }
}

/// Entity -> placed solid (`entityToOccShape`).
fn solid(entity: &Value) -> Evaluated {
    let kind = entity.get("kind").and_then(Value::as_str).unwrap_or("");
    match kind {
        "box" => box_solid(entity),
        "cylinder" | "sphere" | "cone" | "torus" => revolved_primitive(entity, kind),
        "wedge" => wedge_solid(entity),
        "extrusion" => extruded_profile(entity),
        "revolution" => revolved_profile(entity),
        "mesh" => mesh_solid(entity),
        "loft" => nodes::loft(entity),
        "sweep" => nodes::sweep(entity),
        "subdivision" => nodes::subdivision(entity),
        other => Err(EvalError::Unsupported(format!("solid kind '{other}'"))),
    }
}

fn boolean_op(name: &str) -> Option<BooleanOp> {
    match name {
        "union" => Some(BooleanOp::Union),
        "subtract" => Some(BooleanOp::Subtract),
        "intersect" => Some(BooleanOp::Intersect),
        _ => None,
    }
}

impl Evaluator {
    pub fn new(capacity: usize) -> Self {
        Self { cache: Lru::new(capacity), builds: 0, blobs: HashMap::new() }
    }

    /// Keeps blob `sha256` for `brep` leaves (idempotent) and forgets refusals, which may have been "blob missing"; false when the
    /// text does not hash to `sha256` (`KRN_BLOB_HASH_MISMATCH`, the blob is refused).
    pub fn load_blob(&mut self, sha256: &str, text: &str) -> bool {
        if sha256_hex(text.as_bytes()) != sha256 {
            return false;
        }
        if self.blobs.insert(sha256.to_string(), text.to_string()).is_none() {
            self.cache.retain(Option::is_some);
        }
        true
    }

    /// Recipe nodes actually built (cache misses).
    pub fn build_count(&self) -> u64 {
        self.builds
    }

    pub fn cached_count(&self) -> usize {
        self.cache.len()
    }

    /// The shape of `recipe`; `Ok(None)` = refused (bad sizes, OCC builder not done), also when a sub-recipe was.
    pub fn evaluate(&mut self, recipe: &Value) -> Evaluated {
        let key = canonical_key(recipe);
        if let Some(hit) = self.cache.get(&key) {
            return Ok(hit.clone());
        }
        self.builds += 1;
        let built = self.build(recipe);
        match &built {
            Ok(shape) => self.cache.insert(key, shape.clone()),
            Err(EvalError::Failure(_)) => self.cache.insert(key, None),
            Err(EvalError::Unsupported(_)) => {}
        }
        built
    }

    fn child(&mut self, recipe: &Value, field: &str) -> Evaluated {
        match recipe.get(field) {
            Some(source) => self.evaluate(source),
            None => refused(),
        }
    }

    fn build(&mut self, recipe: &Value) -> Evaluated {
        let op = recipe.get("op").and_then(Value::as_str).unwrap_or("");
        match op {
            "solid" => match recipe.get("entity") {
                Some(entity) => solid(entity),
                None => refused(),
            },
            "boolean" => {
                let Some(operation) = recipe.get("boolean").and_then(Value::as_str).and_then(boolean_op) else { return refused() };
                let Some(a) = self.child(recipe, "a")? else { return refused() };
                let Some(b) = self.child(recipe, "b")? else { return refused() };
                // A modelled-thread operand skips UnifySameDomain, like the WASM kernel (occtThreadMark.ts).
                let threaded = ["a", "b"].iter().filter_map(|field| recipe.get(field)).any(nodes::thread_bearing);
                shape_of(crate::boolean(operation, &a, &b, !threaded))
            }
            "place" => {
                let Some(source) = self.child(recipe, "source")? else { return refused() };
                let (Some(position), Some(rotation)) = (vec3(recipe, "position"), vec3(recipe, "rotation")) else { return refused() };
                shape_of(crate::placed(&source, rotation, position, [0.0; 3]))
            }
            "scale" => {
                let factor = number(recipe, "factor").unwrap_or(f64::NAN);
                let Some(source) = self.child(recipe, "source")? else { return refused() };
                if !positive(factor) {
                    return refused();
                }
                shape_of(crate::scaled(&source, factor))
            }
            "fillet" => self.round(recipe, false),
            "chamfer" => self.round(recipe, true),
            "blend" => self.blend(recipe),
            "shell" => self.shell(recipe),
            "featureCut" => self.feature_cut(recipe),
            "brep" => {
                let blob = recipe.get("blob").and_then(Value::as_str).and_then(|sha256| self.blobs.get(sha256));
                match blob {
                    Some(text) => crate::queries::read_brep(text).map(|shape| shape.map(Rc::new)).map_err(EvalError::Failure),
                    None => refused(),
                }
            }
            other => Err(EvalError::Unsupported(format!("recipe op '{other}'"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn volume(evaluated: Evaluated) -> f64 {
        crate::mass_properties(&evaluated.unwrap().unwrap()).unwrap().volume
    }

    fn entity(kind: &str, fields: Value) -> Value {
        let mut base = json!({ "id": "e", "kind": kind, "position": [0, 0, 0], "rotation": [0, 0, 0], "layerId": "l", "color": "#888" });
        if let (Some(target), Some(extra)) = (base.as_object_mut(), fields.as_object()) {
            target.extend(extra.clone());
        }
        base
    }

    fn leaf(entity: Value) -> Value {
        json!({ "op": "solid", "entity": entity })
    }

    #[test]
    fn primitives_have_their_exact_volumes() {
        let mut evaluator = Evaluator::new(16);
        let pi = std::f64::consts::PI;
        let cases = [
            (entity("box", json!({ "size": [1, 2, 3] })), 6.0),
            (entity("cylinder", json!({ "radius": 1, "height": 2 })), 2.0 * pi),
            (entity("sphere", json!({ "radius": 1 })), 4.0 / 3.0 * pi),
            (entity("cone", json!({ "radius": 1, "height": 3 })), pi),
            (entity("torus", json!({ "ringRadius": 2, "tubeRadius": 0.5 })), 2.0 * pi * pi * 2.0 * 0.25),
            (entity("wedge", json!({ "size": [2, 3, 4] })), 12.0),
            (entity("extrusion", json!({ "profile": [[0, 0], [0, 1], [2, 1], [2, 0]], "depth": 3 })), 6.0),
        ];
        for (shape, expected) in cases {
            let got = volume(evaluator.evaluate(&leaf(shape.clone())));
            assert!((got - expected).abs() < 1e-6 * expected.max(1.0), "{shape}: {got} vs {expected}");
        }
    }

    #[test]
    fn a_revolved_rectangle_is_a_tube() {
        let mut evaluator = Evaluator::new(4);
        let tube = entity(
            "revolution",
            json!({ "profile": [[1, 0], [2, 0], [2, 1], [1, 1]], "axis": [0, 0, 1], "angle": std::f64::consts::TAU, "segments": 32 }),
        );
        let expected = std::f64::consts::PI * (4.0 - 1.0);
        assert!((volume(evaluator.evaluate(&leaf(tube))) - expected).abs() < 1e-6);
    }

    #[test]
    fn booleans_and_transforms_compose_and_reuse_the_cache() {
        let mut evaluator = Evaluator::new(16);
        let a = leaf(entity("box", json!({ "size": [2, 2, 2] })));
        let b = leaf(entity("box", json!({ "size": [2, 2, 2], "position": [1, 0, 0] })));
        let cut = json!({ "op": "boolean", "boolean": "subtract", "a": a, "b": b });
        assert!((volume(evaluator.evaluate(&cut)) - 4.0).abs() < 1e-9);
        let builds = evaluator.build_count();
        let scaled = json!({ "op": "scale", "factor": 2, "source": { "op": "place", "source": cut, "position": [5, 0, 0], "rotation": [0.3, 0, 0] } });
        assert!((volume(evaluator.evaluate(&scaled)) - 32.0).abs() < 1e-6);
        assert_eq!(evaluator.build_count(), builds + 2, "the cut is reused, only place and scale are built");
    }

    #[test]
    fn bad_sizes_are_refused_and_unknown_ops_are_unsupported() {
        let mut evaluator = Evaluator::new(4);
        assert_eq!(evaluator.evaluate(&leaf(entity("sphere", json!({ "radius": -1 })))).map(|shape| shape.is_none()), Ok(true));
        let feature = json!({ "op": "feature", "source": leaf(entity("box", json!({ "size": [1, 1, 1] }))) });
        assert_eq!(evaluator.evaluate(&feature).err(), Some(EvalError::Unsupported("recipe op 'feature'".to_string())));
        assert!(matches!(evaluator.evaluate(&leaf(entity("text3d", json!({})))), Err(EvalError::Unsupported(_))));
        let curved = entity("extrusion", json!({ "profile": [[0, 0], [1, 0], [0, 1]], "depth": 1, "curves": [] }));
        assert!(matches!(evaluator.evaluate(&leaf(curved)), Err(EvalError::Unsupported(_))));
    }

    #[test]
    fn a_closed_triangle_mesh_becomes_a_solid() {
        let mut evaluator = Evaluator::new(4);
        let mesh = entity(
            "mesh",
            json!({ "mesh": { "positions": [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], "indices": [0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2] } }),
        );
        assert!((volume(evaluator.evaluate(&leaf(mesh))) - 1.0 / 6.0).abs() < 1e-9);
    }

    #[test]
    fn brep_leaves_read_loaded_blobs_and_retry_after_a_load() {
        let mut evaluator = Evaluator::new(8);
        let text = crate::queries::write_brep(&crate::make_box([0.0; 3], [1.0, 2.0, 3.0]).unwrap().unwrap()).unwrap();
        assert!(!evaluator.load_blob(&sha256_hex(b"other"), &text), "a blob whose text hashes differently is refused");
        let digest = sha256_hex(text.as_bytes());
        let leaf = json!({ "op": "brep", "blob": digest, "format": "occt-brep-v1" });
        let scaled = json!({ "op": "scale", "factor": 2, "source": leaf });
        assert_eq!(evaluator.evaluate(&scaled).map(|shape| shape.is_none()), Ok(true), "blob not loaded yet: refused");
        assert!(evaluator.load_blob(&digest, &text));
        assert!((volume(evaluator.evaluate(&scaled)) - 48.0).abs() < 1e-9);
    }

    #[test]
    fn canonical_keys_ignore_field_order() {
        let a: Value = serde_json::from_str(r#"{"op":"scale","factor":2,"source":{"op":"solid"}}"#).unwrap();
        let b: Value = serde_json::from_str(r#"{"source":{"op":"solid"},"factor":2,"op":"scale"}"#).unwrap();
        assert_eq!(canonical_key(&a), canonical_key(&b));
    }
}
