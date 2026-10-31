//! Feature recipe nodes and freeform solid kinds, following the retired opencascade.js kernel (fillet, chamfer, blend,
//! shell, curved profiles, loft, sweep, subdivision) and the `feature` walk of `packages/core/src/geometry/shapeKernel.ts`.
//!
//! The pure TypeScript geometry those builders read (oriented curve chains, Catmull-Rom ring curves, sweep frames, subdivision
//! patches, feature lowering and hole profiles) is computed by the host, which sends it ready to build
//! (`server/src/native/kernelLeaves.ts`, `kernelFeatures.ts`); this side runs the same OCCT algorithms on it.
//! Encoded chain: per segment a type code (0 line, 1 arc, 2 cubic Bezier, 3 ellipse quarter [start, centre, end]), then its 2 / 3 / 4 / 3 xyz points.

use super::floor::floor_edge_indices;
use super::profile_node::profile_plan;
use super::setback_node::setback_specs;
use super::wrap_nodes::{loops_ok, surface_data_ok};
use super::{number, place_entity, positive, refused, shape_of, vec3, EvalError, Evaluated, Evaluator};
use crate::features;
use crate::features_surface;
use crate::{BooleanOp, Shape};
use serde_json::Value;
use std::rc::Rc;

pub(super) fn numbers(value: Option<&Value>) -> Option<Vec<f64>> {
    value?.as_array()?.iter().map(Value::as_f64).collect()
}

pub(super) fn chains(value: Option<&Value>) -> Option<Vec<Vec<f64>>> {
    value?.as_array()?.iter().map(|chain| numbers(Some(chain))).collect()
}

pub(super) fn indices(value: Option<&Value>) -> Option<Vec<u32>> {
    value?.as_array()?.iter().map(|index| index.as_u64().and_then(|value| u32::try_from(value).ok())).collect()
}

pub(super) fn vec3_of(value: Option<&Value>) -> Option<[f64; 3]> {
    match numbers(value)?.as_slice() {
        [x, y, z] => Some([*x, *y, *z]),
        _ => None,
    }
}

/// Whether the recipe holds a modelled-thread groove tool (`occtThreadMark.ts`): its booleans skip UnifySameDomain.
pub(super) fn thread_bearing(recipe: &Value) -> bool {
    if let Some(entity) = recipe.get("entity") {
        return entity.get("threadTool").and_then(Value::as_bool) == Some(true);
    }
    let sources = recipe.get("sources").and_then(Value::as_array).into_iter().flatten();
    ["source", "a", "b", "tool"].iter().filter_map(|field| recipe.get(field)).chain(sources).any(thread_bearing)
}

/// The face of an extrusion / revolution profile: the host's oriented exact chain when sent, else `None` (polygon path).
pub(super) fn profile_chain_face(entity: &Value) -> Option<Result<Option<Shape>, String>> {
    let chain = numbers(entity.get("chain"))?;
    Some(features::chain_face(&chain))
}

pub(super) fn prism(face: Shape, depth: f64, entity: &Value) -> Evaluated {
    place_entity(shape_of(features::prism_of_face(&face, [0.0, 0.0, depth]))?, entity, [0.0; 3])
}

pub(super) fn revolution(face: Shape, axis: [f64; 3], angle: f64, entity: &Value) -> Evaluated {
    place_entity(shape_of(features::revolution_of_face(&face, axis, angle))?, entity, [0.0; 3])
}

/// Loft (`loftedSolid`): ThruSections through the ring curves (`native.chains`), placed. With the capability `bsplineSections` the host also
/// sends each exact section as ONE B-spline (`native.bsplines`): those are tried first, and a refusal or malformed data falls back to the chains.
/// An advanced loft (end conditions, alignment, coupling, closed, guides) is a `sheetSolid` node, not a leaf (`sheet_node.rs`).
pub(super) fn loft(entity: &Value) -> Evaluated {
    let native = entity.get("native");
    let ruled = native.and_then(|inner| inner.get("ruled")).and_then(Value::as_bool).unwrap_or(false);
    if let Some(curves) = chains(native.and_then(|inner| inner.get("bsplines"))) {
        if let Ok(Some(shape)) = features::skinned_solid_bsplines(&curves, ruled) {
            return place_entity(Some(Rc::new(shape)), entity, [0.0; 3]);
        }
    }
    let Some(rings) = chains(native.and_then(|inner| inner.get("chains"))) else { return refused() };
    place_entity(shape_of(features::skinned_solid(&rings, ruled))?, entity, [0.0; 3])
}

/// A surface sheet (`nurbs_surface` leaf, capability `nurbsSurface`): the host sends `native.surface` (encoded clamped B-spline patch) and
/// `native.loops` (its (u, v) trim loops, absent = the natural boundary); the face is placed like any entity. Without the payload it is refused.
pub(super) fn nurbs_surface(entity: &Value) -> Evaluated {
    let native = entity.get("native");
    let Some(surface) = numbers(native.and_then(|inner| inner.get("surface"))) else { return refused() };
    let loops = numbers(native.and_then(|inner| inner.get("loops"))).unwrap_or_default();
    if !surface_data_ok(0, &surface) || !loops_ok(&loops) {
        return refused();
    }
    place_entity(shape_of(features_surface::surface_face(0, &surface, &loops))?, entity, [0.0; 3])
}

/// The MakePipeShell fast path (capability `pipeShell`, TECHNICAL_SPEC 5.5): `source` holds the spine and the section (`circle` or `chain`) as for a pipe,
/// `settings` the trihedron mode, a homothetic law, the transition mode and probe points of the host's exact evaluator. The result is used only when it
/// passes the probes (and, with `volume` > 0, the volume of the fitted faces), so `None` (refused, no payload, or a missed probe) falls through.
pub(super) fn pipe_shell(source: &Value, settings: &Value, volume: f64) -> Evaluated {
    let Some(spine) = numbers(source.get("spine")) else { return Ok(None) };
    if !features::chain_wire_ok(&spine).map_err(EvalError::Failure)? {
        return Ok(None);
    }
    let section = if let Some(circle) = source.get("circle") {
        let (Some(center), Some(normal)) = (vec3_of(circle.get("center")), vec3_of(circle.get("normal"))) else { return Ok(None) };
        features::circle_section(center, normal, number(circle, "radius").unwrap_or(f64::NAN), number(circle, "innerRadius"))
    } else {
        let Some(chain) = numbers(source.get("chain")) else { return Ok(None) };
        features::chain_face(&chain)
    };
    let Some(section) = section.map_err(EvalError::Failure)? else { return Ok(None) };
    let law = numbers(settings.get("law")).unwrap_or_default();
    let probes = numbers(settings.get("probes")).unwrap_or_default();
    let integer = |field: &str| settings.get(field).and_then(Value::as_i64).and_then(|value| i32::try_from(value).ok());
    let (Some(mode), Some(transition)) = (integer("mode"), integer("transition")) else { return Ok(None) };
    let (tolerance, check) = (number(settings, "tolerance").unwrap_or(1e-6), number(settings, "check").unwrap_or(1e-6));
    if !positive(tolerance) || !positive(check) {
        return Ok(None);
    }
    let shell = features::PipeShell {
        mode,
        direction: vec3_of(settings.get("direction")).unwrap_or([0.0, 0.0, 1.0]),
        law: &law,
        transition,
        tolerance,
        probes: &probes,
        check,
        volume,
    };
    shape_of(features::pipe_shell_solid(&spine, &section, &shell))
}

/// Sweep (`sweptSolid`) leaf: a mitred sweep tries MakePipeShell first (`native.pipeShell`); else the spine must make a wire, and a variable sweep skins
/// its station rings, else MakePipe of the section. A sweep with laws or frame modes is a `sheetSolid` node, not a leaf (`sheet_node.rs`).
pub(super) fn sweep(entity: &Value) -> Evaluated {
    let Some(native) = entity.get("native") else { return refused() };
    if let Some(settings) = native.get("pipeShell") {
        if let Some(exact) = pipe_shell(native, settings, 0.0)? {
            return place_entity(Some(exact), entity, [0.0; 3]);
        }
    }
    let Some(spine) = numbers(native.get("spine")) else { return refused() };
    if !features::chain_wire_ok(&spine).map_err(EvalError::Failure)? {
        return refused();
    }
    if let Some(rings) = chains(native.get("rings")) {
        return place_entity(shape_of(features::skinned_solid(&rings, false))?, entity, [0.0; 3]);
    }
    let section = if let Some(circle) = native.get("circle") {
        let (Some(center), Some(normal)) = (vec3_of(circle.get("center")), vec3_of(circle.get("normal"))) else { return refused() };
        let radius = number(circle, "radius").unwrap_or(f64::NAN);
        features::circle_section(center, normal, radius, number(circle, "innerRadius"))
    } else {
        let Some(chain) = numbers(native.get("chain")) else { return refused() };
        features::chain_face(&chain)
    };
    let Some(section) = section.map_err(EvalError::Failure)? else { return refused() };
    if let Some(helix) = numbers(native.get("helix")) {
        if let Some(exact) = shape_of(features::helix_pipe_solid(&helix, &section))? {
            return place_entity(Some(exact), entity, [0.0; 3]);
        }
    }
    place_entity(shape_of(features::pipe_solid(&spine, &section))?, entity, [0.0; 3])
}

/// Subdivision (`entityToOccShape`): smooth cages become sewn B-spline patches (placed); a faceted cage, or any patch failure, keeps
/// the subdivided triangles (world space, sewn).
pub(super) fn subdivision(entity: &Value) -> Evaluated {
    let native = entity.get("native");
    let read = |field: &str| native.and_then(|inner| inner.get(field));
    if let Some(poles) = numbers(read("patches")) {
        let tolerance = read("tolerance").and_then(Value::as_f64).unwrap_or(1e-7);
        let exact = place_entity(shape_of(features::bspline_patch_solid(&poles, tolerance))?, entity, [0.0; 3])?;
        if exact.is_some() {
            return Ok(exact);
        }
    }
    let triangles = read("triangles");
    let (Some(positions), Some(indices)) =
        (numbers(triangles.and_then(|mesh| mesh.get("positions"))), indices(triangles.and_then(|mesh| mesh.get("indices"))))
    else {
        return refused();
    };
    if positions.is_empty() {
        return refused();
    }
    shape_of(crate::make_sewn_solid(&positions, &indices))
}

/// `radii` (one `EdgeRadius` per edge, `packages/core/src/model/types.ts`) flattened per edge as size, sizeEnd (NaN = constant), mode (1 =
/// `interpolation: "linear"`, 2 = "monotone", else 0), n, then n (t, size) pairs; `None` when the list does not match the edges or a law is not positive / strictly increasing inside (0, 1).
pub(super) fn radius_laws(radii: &Value, edge_count: usize) -> Option<Vec<f64>> {
    let laws = radii.as_array()?;
    if laws.len() != edge_count || edge_count == 0 {
        return None;
    }
    let mut flat = Vec::new();
    for law in laws {
        let size = number(law, "size")?;
        let end = law.get("sizeEnd").and_then(Value::as_f64).unwrap_or(f64::NAN);
        if !positive(size) || (!end.is_nan() && !positive(end)) {
            return None;
        }
        let points = law.get("sizes").and_then(Value::as_array).cloned().unwrap_or_default();
        let mode = match law.get("interpolation").and_then(Value::as_str) {
            Some("linear") => 1.0,
            Some("monotone") => 2.0,
            _ => 0.0,
        };
        flat.extend([size, end, mode, points.len() as f64]);
        let mut last_t = 0.0;
        for point in &points {
            let (t, radius) = (number(point, "t")?, number(point, "size")?);
            if !(t > last_t && t < 1.0) || !positive(radius) {
                return None;
            }
            last_t = t;
            flat.extend([t, radius]);
        }
    }
    Some(flat)
}

/// The faces and the second leg (start, end) of a variable chamfer: none (symmetric, NaN legs) without `faces`, else `faces` with `size2` and `size2End` (both > 0);
/// None when the node is malformed.
fn variable_legs(recipe: &Value) -> Option<(Vec<u32>, f64, f64)> {
    let Some(faces) = recipe.get("faces").filter(|faces| !faces.is_null()) else {
        return recipe.get("size2End").is_none_or(Value::is_null).then(|| (Vec::new(), f64::NAN, f64::NAN));
    };
    let faces = indices(Some(faces))?;
    let (second, second_end) = (number(recipe, "size2")?, number(recipe, "size2End")?);
    (positive(second) && positive(second_end) && number(recipe, "angleDeg").is_none()).then_some((faces, second, second_end))
}

/// A `chamfer` node (BLD M1): symmetric `size` by default; with `faces` (one unique face index per edge, the face carrying the first leg) a second
/// leg `size2` (distance-distance) or `angleDeg` (distance-angle, degrees measured on that face, 0 < angle < 90); with `sizeEnd` a symmetric
/// distance that runs linearly from `size` to `sizeEnd` along each edge; with `faces` also `size2` -> `size2End` for the other leg (straight or curved edges, BLD M5).
fn chamfer_node(source: &Shape, edges: &[u32], size: f64, size_end: Option<f64>, recipe: &Value) -> Evaluated {
    if let Some(end) = size_end {
        // BLD M5: a distance running linearly from `size` to `end`; with `faces` the other leg runs from `size2` to `size2End`
        let (faces, second, second_end) = match variable_legs(recipe) {
            Some(legs) => legs,
            None => return refused(),
        };
        return shape_of(features::chamfer_variable(source, edges, &faces, size, end, second, second_end));
    }
    let Some(faces) = recipe.get("faces").filter(|faces| !faces.is_null()) else {
        return shape_of(features::chamfer(source, edges, size));
    };
    let (Some(faces), size2, angle) = (indices(Some(faces)), number(recipe, "size2"), number(recipe, "angleDeg")) else {
        return refused();
    };
    if faces.len() != edges.len() {
        return refused();
    }
    match (size2, angle) {
        (Some(second), None) if positive(second) => shape_of(features::chamfer_sided(source, edges, &faces, size, second, false)),
        (None, Some(degrees)) if degrees > 0.0 && degrees < 90.0 => {
            shape_of(features::chamfer_sided(source, edges, &faces, size, degrees.to_radians(), true))
        }
        _ => refused(),
    }
}

/// The blend report of a profile / face blend / full round: `stage` with the reason (a leading `[BLD_CODE]` names the stable code), or `none` when it
/// builds (`reason` empty).
fn blend_stage_report(stage: &str, reason: &str) -> Value {
    let builds = reason.is_empty();
    let mut report = serde_json::json!({
        "contours": [], "vertices": [], "unsupportedVertices": [], "partial": false,
        "stage": if builds { "none" } else { stage }, "done": builds, "valid": builds,
    });
    if !builds {
        report["message"] = Value::String(reason.to_string());
    }
    report
}

const FACE_SET_REASON: &str = "[BLD_FACE_BLEND_UNSUPPORTED] this build blends one planar face per set";

/// The single unique face index of a face set, `None` when the set is empty or has several faces.
fn one_face(recipe: &Value, field: &str) -> Option<f64> {
    match indices(recipe.get(field))?.as_slice() {
        [face] => Some(f64::from(*face)),
        _ => None,
    }
}

/// BLD M4 `faceBlend` node as the flat spec of `features::face_blend`: face A, face B, radius, section kind, rho / shape, cliff (0 none, 1 on A, 2 on B).
fn face_blend_spec(recipe: &Value) -> Option<[f64; 6]> {
    let radius = number(recipe, "radius").filter(|radius| positive(*radius))?;
    let profile = recipe.get("profile").filter(|profile| !profile.is_null());
    let factor = |field: &str| profile.and_then(|profile| number(profile, field)).filter(|value| (0.05..=0.95).contains(value));
    let (kind, param) = match profile.and_then(|profile| profile.get("type")).and_then(Value::as_str).unwrap_or("circular") {
        "circular" => (2.0, 0.0),
        "conic" => (0.0, factor("rho")?),
        "curvature" => (1.0, factor("shape")?),
        _ => return None,
    };
    let cliff = match recipe.get("cliff").and_then(Value::as_str) {
        None => 0.0,
        Some("A") => 1.0,
        Some("B") => 2.0,
        Some(_) => return None,
    };
    Some([one_face(recipe, "facesA")?, one_face(recipe, "facesB")?, radius, kind, param, cliff])
}

/// BLD M4 `fullRound` node as the flat spec of `features::full_round`: side 1, center, side 2.
fn full_round_spec(recipe: &Value) -> Option<[f64; 3]> {
    Some([one_face(recipe, "side1")?, one_face(recipe, "center")?, one_face(recipe, "side2")?])
}

/// The evaluated operands of a `blend` node and its flat joint picks.
type BlendOperands = (Vec<Rc<Shape>>, Vec<f64>);

impl Evaluator {
    /// BLD M4 `faceBlend`: a rolling-ball blend between two planar faces (`features::face_blend`).
    pub(super) fn face_blend(&mut self, recipe: &Value) -> Evaluated {
        let Some(source) = self.child(recipe, "source")? else { return refused() };
        let Some(spec) = face_blend_spec(recipe) else { return refused() };
        shape_of(features::face_blend(&source, &spec))
    }

    /// BLD M4 `fullRound`: the half-round that consumes the center face between two parallel sides (`features::full_round`).
    pub(super) fn full_round(&mut self, recipe: &Value) -> Evaluated {
        let Some(source) = self.child(recipe, "source")? else { return refused() };
        let Some(spec) = full_round_spec(recipe) else { return refused() };
        shape_of(features::full_round(&source, &spec))
    }

    /// `fillet` / `chamfer` (`roundEdges`): unique-edge indices in explorer order, `[]` = all.
    pub(super) fn round(&mut self, recipe: &Value, chamfer: bool) -> Evaluated {
        let Some(source) = self.child(recipe, "source")? else { return refused() };
        let Some(edges) = indices(recipe.get("edges")) else { return refused() };
        if !chamfer {
            match setback_specs(recipe) {
                Err(()) => return refused(),
                Ok(Some((setback_edges, setback_corners))) => {
                    return shape_of(features::fillet_setback(&source, &setback_edges, &setback_corners))
                }
                Ok(None) => {}
            }
            match profile_plan(recipe, &edges) {
                Err(()) => return refused(),
                Ok(Some(plan)) => {
                    let built = features::fillet_profile_blend(&source, &plan.specs, &edges, &plan.laws, plan.kind, plan.param);
                    if matches!(built, Ok(None)) {
                        // the reason was computed while building: kept for blend_report, so a refusal is explained without a rebuild
                        let why = features::profile_blend_last_reason().map_err(EvalError::Failure)?;
                        self.reports.insert(super::canonical_key(recipe), Value::String(why));
                    }
                    return shape_of(built);
                }
                Ok(None) => {}
            }
        }
        if let (false, Some(radii)) = (chamfer, recipe.get("radii").filter(|radii| !radii.is_null())) {
            let Some(laws) = radius_laws(radii, edges.len()) else { return refused() };
            return shape_of(features::fillet_laws(&source, &edges, &laws));
        }
        let size = number(recipe, "size").unwrap_or(f64::NAN);
        let size_end = number(recipe, "sizeEnd");
        if !positive(size) || size_end.is_some_and(|end| !positive(end)) {
            return refused();
        }
        if chamfer {
            return chamfer_node(&source, &edges, size, size_end, recipe);
        }
        shape_of(features::fillet(&source, &edges, size, size_end))
    }

    /// BLD M0: why the `fillet` recipe fails (or that it builds): the source is evaluated (cached), the fillet is rebuilt for the OCCT contour and
    /// vertex diagnostics (`queries::fillet_report`). `Value::Null` for any other recipe or a refused source.
    pub fn blend_report(&mut self, recipe: &Value) -> Result<Value, EvalError> {
        let op = recipe.get("op").and_then(Value::as_str);
        if op == Some("faceBlend") || op == Some("fullRound") {
            let Some(source) = self.child(recipe, "source")? else { return Ok(Value::Null) };
            let (stage, reason) = match (op, face_blend_spec(recipe), full_round_spec(recipe)) {
                (Some("faceBlend"), Some(spec), _) => {
                    ("faceBlend", features::face_blend_reason(&source, &spec).map_err(EvalError::Failure)?)
                }
                (Some("fullRound"), _, Some(spec)) => {
                    ("fullRound", features::full_round_reason(&source, &spec).map_err(EvalError::Failure)?)
                }
                (Some("faceBlend"), None, _) => ("faceBlend", FACE_SET_REASON.to_string()),
                _ => ("fullRound", FACE_SET_REASON.to_string()),
            };
            return Ok(blend_stage_report(stage, &reason));
        }
        if op == Some("blend") {
            let Some((shapes, picks)) = self.blend_operands(recipe)? else { return Ok(Value::Null) };
            let borrowed: Vec<&Shape> = shapes.iter().map(Rc::as_ref).collect();
            let radius = number(recipe, "radius").unwrap_or(f64::NAN);
            // built (cached by the evaluation that asked): what the union reported about its picks and contours, no second build
            if let Some(shape) = self.evaluate(recipe)? {
                let notes = features::shape_notes(&shape).map_err(EvalError::Failure)?;
                let mut report = blend_stage_report("blend", "");
                report["notes"] = serde_json::from_str(&notes).unwrap_or(Value::Null);
                return Ok(report);
            }
            let reason = features::blend_reason(&borrowed, radius, &picks).map_err(EvalError::Failure)?;
            return Ok(blend_stage_report("blend", &reason));
        }
        if op == Some("chamfer") && number(recipe, "sizeEnd").is_some() {
            let Some(source) = self.child(recipe, "source")? else { return Ok(Value::Null) };
            let Some(edges) = indices(recipe.get("edges")) else { return Ok(Value::Null) };
            let (first, last) = (number(recipe, "size").unwrap_or(f64::NAN), number(recipe, "sizeEnd").unwrap_or(f64::NAN));
            let Some((faces, second, second_end)) = variable_legs(recipe) else { return Ok(Value::Null) };
            let reason = features::chamfer_variable_reason(&source, &edges, &faces, first, last, second, second_end).map_err(EvalError::Failure)?;
            return Ok(blend_stage_report("chamfer", &reason));
        }
        if op != Some("fillet") {
            return Ok(Value::Null);
        }
        let Some(source) = self.child(recipe, "source")? else { return Ok(Value::Null) };
        let Some(edges) = indices(recipe.get("edges")) else { return Ok(Value::Null) };
        match setback_specs(recipe) {
            Err(()) => {
                return Ok(blend_stage_report(
                    "setback",
                    "[BLD_CORNER_UNSUPPORTED] the setback corner parameters are malformed or ask for more than this build makes (a radius that varies along an edge, a profile)",
                ))
            }
            Ok(Some((setback_edges, setback_corners))) => {
                let reason = features::setback_reason(&source, &setback_edges, &setback_corners).map_err(EvalError::Failure)?;
                return Ok(blend_stage_report("setback", &reason));
            }
            Ok(None) => {}
        }
        match profile_plan(recipe, &edges) {
            Err(()) => {
                return Ok(blend_stage_report(
                    "profile",
                    "the profile blend parameters are malformed (rho or shape outside 0.05..0.95, size2 without a side, or size2 on an edge whose size varies)",
                ))
            }
            Ok(Some(plan)) => {
                // built (cached by the evaluation that asked): what the builder reported about how
                if let Some(shape) = self.evaluate(recipe)? {
                    let notes = features::shape_notes(&shape).map_err(EvalError::Failure)?;
                    let mut report = blend_stage_report("profile", "");
                    report["notes"] = serde_json::from_str(&notes).unwrap_or(Value::Null);
                    return Ok(report);
                }
                let kept = self.reports.get(&super::canonical_key(recipe)).and_then(|why| why.as_str().map(str::to_string));
                let reason = match kept {
                    Some(why) => why,
                    None => features::profile_blend_reason(&source, &plan.specs, &edges, &plan.laws, plan.kind, plan.param)
                        .map_err(EvalError::Failure)?,
                };
                return Ok(blend_stage_report("profile", &reason));
            }
            Ok(None) => {}
        }
        let laws = match recipe.get("radii").filter(|radii| !radii.is_null()) {
            Some(radii) => radius_laws(radii, edges.len()),
            None => number(recipe, "size").filter(|size| positive(*size)).map(|size| {
                let end = number(recipe, "sizeEnd").unwrap_or(f64::NAN);
                // one law, repeated per listed edge (an empty list = every edge: the facade reuses the single law)
                [size, end, 0.0, 0.0].repeat(edges.len().max(1))
            }),
        };
        let Some(laws) = laws else { return Ok(Value::Null) };
        crate::queries::fillet_report(&source, &edges, &laws).map_err(EvalError::Failure)
    }

    /// The operands of a `blend` node and its flat joint picks (x, y, z, radius per entry of `joints`; `None` when a pick is malformed).
    fn blend_operands(&mut self, recipe: &Value) -> Result<Option<BlendOperands>, EvalError> {
        let Some(sources) = recipe.get("sources").and_then(Value::as_array) else { return Ok(None) };
        let mut shapes: Vec<Rc<Shape>> = Vec::with_capacity(sources.len());
        for source in sources {
            let Some(shape) = self.evaluate(source)? else { return Ok(None) };
            shapes.push(shape);
        }
        let mut picks: Vec<f64> = Vec::new();
        for joint in recipe.get("joints").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default() {
            let (Some(near), Some(radius)) = (numbers(joint.get("near")), number(joint, "radius")) else { return Ok(None) };
            if near.len() != 3 || !positive(radius) {
                return Ok(None);
            }
            picks.extend(near);
            picks.push(radius);
        }
        Ok(Some((shapes, picks)))
    }

    /// `blend` (`blendedUnion`): every joint `radius`, the joints nearest to the `joints` picks their own radius (BLD M5).
    pub(super) fn blend(&mut self, recipe: &Value) -> Evaluated {
        let Some((shapes, picks)) = self.blend_operands(recipe)? else { return refused() };
        let borrowed: Vec<&Shape> = shapes.iter().map(Rc::as_ref).collect();
        shape_of(features::blend(&borrowed, number(recipe, "radius").unwrap_or(f64::NAN), &picks))
    }

    /// `shell`: open where the faces nearest to `openNear` were (`openShell`), else a sealed cavity (`hollow`).
    pub(super) fn shell(&mut self, recipe: &Value) -> Evaluated {
        let Some(source) = self.child(recipe, "source")? else { return refused() };
        let thickness = number(recipe, "thickness").unwrap_or(f64::NAN);
        let open_near: Option<Vec<f64>> = recipe
            .get("openNear")
            .and_then(Value::as_array)
            .map(|points| points.iter().flat_map(|point| numbers(Some(point)).unwrap_or_default()).collect());
        match open_near {
            Some(points) if !points.is_empty() => shape_of(features::shell_open(&source, thickness, &points)),
            _ => shape_of(features::shell_hollow(&source, thickness)),
        }
    }

    /// `featureCut`: a `feature` node lowered by the host. The native BRepFeat cut first (`occtFeatures.ts`), valid and unified;
    /// otherwise `source` op the lowered tool. `tool: null` = the lowering refused the node. A pocket `floorFillet` then rounds the floor
    /// edges found on the cut's topology (`floor.rs`); no such edge = refused.
    pub(super) fn feature_cut(&mut self, recipe: &Value) -> Evaluated {
        let Some(cut) = self.cut_feature(recipe)? else { return refused() };
        let Some(floor) = recipe.get("floorFillet") else { return Ok(Some(cut)) };
        let radius = number(floor, "radius").unwrap_or(f64::NAN);
        let topology = crate::queries::topology(&cut).map_err(EvalError::Failure)?;
        let Some(edges) = floor_edge_indices(&topology, floor).filter(|edges| !edges.is_empty()) else { return refused() };
        if !positive(radius) {
            return refused();
        }
        shape_of(features::fillet(&cut, &edges, radius, None))
    }

    fn cut_feature(&mut self, recipe: &Value) -> Evaluated {
        let Some(source) = self.child(recipe, "source")? else { return refused() };
        let Some(tool_recipe) = recipe.get("tool").filter(|tool| !tool.is_null()) else { return refused() };
        let source_threaded = recipe.get("source").is_some_and(thread_bearing);
        if let Some(native) = brep_feat(&source, recipe)? {
            if features::is_valid(&native).map_err(EvalError::Failure)? {
                return if source_threaded { Ok(Some(Rc::new(native))) } else { shape_of(features::unified(&native)) };
            }
        }
        let Some(tool) = self.evaluate(tool_recipe)? else { return refused() };
        let mode = if recipe.get("mode").and_then(Value::as_str) == Some("union") { BooleanOp::Union } else { BooleanOp::Subtract };
        shape_of(crate::boolean(mode, &source, &tool, !(source_threaded || thread_bearing(tool_recipe))))
    }
}

/// The BRepFeat cut of a hole (one MakeRevol per position) or a pocket (MakePrism from its sketch face); `None` = use the lowering.
/// Feature cuts below `recipe` on its source chain: the rank `n` of the tool tags `hole<n>.<k>` / `pocket<n>` (SC-N1), stable when an
/// upstream parameter changes.
fn feature_rank(recipe: &Value) -> usize {
    let mut rank = 0;
    let mut current = recipe.get("source");
    while let Some(node) = current {
        if node.get("op").and_then(Value::as_str) == Some("featureCut") {
            rank += 1;
        }
        current = node.get("source").or_else(|| node.get("a"));
    }
    rank
}

fn brep_feat(source: &Rc<Shape>, recipe: &Value) -> Result<Option<Shape>, EvalError> {
    let rank = feature_rank(recipe);
    if let Some(holes) = recipe.get("holes") {
        let (Some(profiles), Some(origins), Some(normal)) =
            (chains(holes.get("profiles")), holes.get("origins").and_then(Value::as_array), vec3(holes, "normal"))
        else {
            return Ok(None);
        };
        let mut current: Option<Shape> = None;
        for (index, (profile, origin)) in profiles.iter().zip(origins).enumerate() {
            let Some(origin) = vec3_of(Some(origin)) else { return Ok(None) };
            let base: &Shape = current.as_ref().unwrap_or(source);
            let tag = format!("hole{rank}.{index}");
            match features::feature_revol_cut(base, profile, origin, normal, &tag).map_err(EvalError::Failure)? {
                Some(next) => current = Some(next),
                None => return Ok(None),
            }
        }
        return Ok(current);
    }
    let Some(pocket) = recipe.get("pocket") else { return Ok(None) };
    let (Some(chain), Some(origin), Some(normal), Some(probes)) =
        (numbers(pocket.get("chain")), vec3(pocket, "origin"), vec3(pocket, "normal"), numbers(pocket.get("probes")))
    else {
        return Ok(None);
    };
    let length = number(pocket, "length").unwrap_or(f64::NAN);
    features::feature_prism_cut(source, &chain, origin, normal, &probes, length, &format!("pocket{rank}")).map_err(EvalError::Failure)
}
