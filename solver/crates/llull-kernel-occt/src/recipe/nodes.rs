//! Feature recipe nodes and freeform solid kinds, following the retired opencascade.js kernel (fillet, chamfer, blend,
//! shell, curved profiles, loft, sweep, subdivision) and the `feature` walk of `packages/core/src/geometry/shapeKernel.ts`.
//!
//! The pure TypeScript geometry those builders read (oriented curve chains, Catmull-Rom ring curves, sweep frames, subdivision
//! patches, feature lowering and hole profiles) is computed by the host, which sends it ready to build
//! (`server/src/native/kernelLeaves.ts`, `kernelFeatures.ts`); this side runs the same OCCT algorithms on it.
//! Encoded chain: per segment a type code (0 line, 1 arc, 2 cubic Bezier, 3 ellipse quarter [start, centre, end]), then its 2 / 3 / 4 / 3 xyz points.

use super::floor::floor_edge_indices;
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

fn chains(value: Option<&Value>) -> Option<Vec<Vec<f64>>> {
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
pub(super) fn loft(entity: &Value) -> Evaluated {
    let native = entity.get("native");
    // an advanced loft (end conditions, alignment, coupling, closed, guides) arrives as its exact NURBS faces: sewn and capped like a fitted sweep
    if let Some(faces) = chains(native.and_then(|inner| inner.get("faces"))) {
        let tolerance = native.and_then(|inner| inner.get("tolerance")).and_then(Value::as_f64).unwrap_or(1e-6);
        if faces.is_empty() || !faces.iter().all(|face| surface_data_ok(0, face)) || !positive(tolerance) {
            return refused();
        }
        let caps =
            native.and_then(|inner| inner.get("caps")).and_then(Value::as_i64).filter(|caps| (0..=2).contains(caps)).unwrap_or(2) as i32;
        return place_entity(shape_of(features::sheet_solid_capped(&faces, tolerance, caps))?, entity, [0.0; 3]);
    }
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

/// The MakePipeShell fast path of a sweep (capability `pipeShell`, `native.pipeShell`): the host sends the spine and section as for a pipe plus the
/// trihedron mode, a homothetic law, the transition mode and probe points of its exact evaluator; the result is used only when it passes the probes, so
/// `None` (refused, no payload, or a missed probe) falls through to the fitted faces / the plain pipe.
fn pipe_shell(native: &Value, volume: f64) -> Evaluated {
    let Some(settings) = native.get("pipeShell") else { return Ok(None) };
    let Some(spine) = numbers(native.get("spine")) else { return Ok(None) };
    if !features::chain_wire_ok(&spine).map_err(EvalError::Failure)? {
        return Ok(None);
    }
    let section = if let Some(circle) = native.get("circle") {
        let (Some(center), Some(normal)) = (vec3_of(circle.get("center")), vec3_of(circle.get("normal"))) else { return Ok(None) };
        features::circle_section(center, normal, number(circle, "radius").unwrap_or(f64::NAN), number(circle, "innerRadius"))
    } else {
        let Some(chain) = numbers(native.get("chain")) else { return Ok(None) };
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

/// Sweep (`sweptSolid`): fitted lateral faces (capability `sheetSolid`, laws / frames MakePipe cannot do) are sewn and capped; else the spine
/// must make a wire, and a variable sweep skins its station rings, else MakePipe of the section.
pub(super) fn sweep(entity: &Value) -> Evaluated {
    let Some(native) = entity.get("native") else { return refused() };
    // fitted faces first: their volume is what the MakePipeShell attempt must reproduce (probes alone cannot see a pipe that is too fat)
    let fitted = if let Some(faces) = chains(native.get("faces")) {
        let tolerance = native.get("tolerance").and_then(Value::as_f64).unwrap_or(1e-6);
        if faces.is_empty() || !faces.iter().all(|face| surface_data_ok(0, face)) || !positive(tolerance) {
            return refused();
        }
        // a sweep round a closed path has no end sections to cap
        let caps = native.get("caps").and_then(Value::as_i64).filter(|caps| (0..=2).contains(caps)).unwrap_or(2) as i32;
        Some(shape_of(features::sheet_solid_capped(&faces, tolerance, caps))?)
    } else {
        None
    };
    let volume = fitted
        .as_ref()
        .and_then(|solid| solid.as_ref())
        .and_then(|solid| crate::mass_properties(solid).ok())
        .map_or(0.0, |properties| properties.volume);
    if let Some(exact) = pipe_shell(native, volume)? {
        return place_entity(Some(exact), entity, [0.0; 3]);
    }
    if let Some(solid) = fitted {
        return place_entity(solid, entity, [0.0; 3]);
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
/// `interpolation: "linear"`, else 0), n, then n (t, size) pairs; `None` when the list does not match the edges or a law is not positive / strictly increasing inside (0, 1).
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
        let linear = law.get("interpolation").and_then(Value::as_str) == Some("linear");
        flat.extend([size, end, if linear { 1.0 } else { 0.0 }, points.len() as f64]);
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

/// A `chamfer` node (BLD M1): symmetric `size` by default; with `faces` (one unique face index per edge, the face carrying the first leg) a second
/// leg `size2` (distance-distance) or `angleDeg` (distance-angle, degrees measured on that face, 0 < angle < 90).
fn chamfer_node(source: &Shape, edges: &[u32], size: f64, recipe: &Value) -> Evaluated {
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

/// BLD M2: the flat layout of `features::fillet_profile` for a fillet node with a conic / curvature `profile` or a `size2` leg (7 numbers per
/// edge); `Ok(None)` for a circular, symmetric fillet, `Err` when the node is malformed (a size that varies, rho / shape outside 0.05..0.95).
fn profile_specs(recipe: &Value, edges: &[u32]) -> Result<Option<Vec<f64>>, ()> {
    let profile = recipe.get("profile").filter(|profile| !profile.is_null());
    let name = profile.and_then(|profile| profile.get("type")).and_then(Value::as_str).unwrap_or("circular");
    let laws: Vec<&Value> = match recipe.get("radii").filter(|radii| !radii.is_null()) {
        Some(radii) => radii.as_array().ok_or(())?.iter().collect(),
        None => vec![recipe; edges.len()],
    };
    let sided = laws.iter().any(|law| law.get("size2").is_some_and(|size2| !size2.is_null()));
    if name == "circular" && !sided {
        return Ok(None);
    }
    if laws.len() != edges.len() || edges.is_empty() {
        return Err(());
    }
    let factor = |field: &str| profile.and_then(|profile| number(profile, field)).filter(|value| (0.05..=0.95).contains(value));
    let (kind, param) = match name {
        "conic" => (0.0, factor("rho").ok_or(())?),
        "curvature" => (1.0, factor("shape").ok_or(())?),
        "circular" => (2.0, 0.0),
        _ => return Err(()),
    };
    let mut flat = Vec::new();
    for (edge, law) in edges.iter().zip(laws) {
        let size = number(law, "size").filter(|size| positive(*size)).ok_or(())?;
        let varying = law.get("sizeEnd").is_some_and(|end| !end.is_null())
            || law.get("sizes").and_then(Value::as_array).is_some_and(|sizes| !sizes.is_empty());
        if varying {
            return Err(());
        }
        let size2 = match law.get("size2").filter(|size2| !size2.is_null()) {
            Some(value) => value.as_f64().filter(|size2| positive(*size2)).ok_or(())?,
            None => f64::NAN,
        };
        let side = law.get("sideFace").and_then(Value::as_u64).map_or(-1.0, |face| face as f64);
        if !size2.is_nan() && side < 0.0 {
            return Err(());
        }
        flat.extend([f64::from(*edge), kind, param, size, size2, side, 0.0]);
    }
    Ok(Some(flat))
}

const FACE_SET_REASON: &str = "[BLD_FACE_BLEND_UNSUPPORTED] this build blends one planar face per set";

/// The single unique face index of a face set, `None` when the set is empty or has several faces.
fn one_face(recipe: &Value, field: &str) -> Option<f64> {
    match indices(recipe.get(field))?.as_slice() {
        [face] => Some(f64::from(*face)),
        _ => None,
    }
}

/// BLD M4 `faceBlend` node as the flat spec of `features::face_blend`: face A, face B, radius, section kind, rho / shape.
fn face_blend_spec(recipe: &Value) -> Option<[f64; 5]> {
    let radius = number(recipe, "radius").filter(|radius| positive(*radius))?;
    let profile = recipe.get("profile").filter(|profile| !profile.is_null());
    let factor = |field: &str| profile.and_then(|profile| number(profile, field)).filter(|value| (0.05..=0.95).contains(value));
    let (kind, param) = match profile.and_then(|profile| profile.get("type")).and_then(Value::as_str).unwrap_or("circular") {
        "circular" => (2.0, 0.0),
        "conic" => (0.0, factor("rho")?),
        "curvature" => (1.0, factor("shape")?),
        _ => return None,
    };
    Some([one_face(recipe, "facesA")?, one_face(recipe, "facesB")?, radius, kind, param])
}

/// BLD M4 `fullRound` node as the flat spec of `features::full_round`: side 1, center, side 2.
fn full_round_spec(recipe: &Value) -> Option<[f64; 3]> {
    Some([one_face(recipe, "side1")?, one_face(recipe, "center")?, one_face(recipe, "side2")?])
}

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
            match profile_specs(recipe, &edges) {
                Err(()) => return refused(),
                Ok(Some(specs)) => return shape_of(features::fillet_profile(&source, &specs)),
                Ok(None) => {}
            }
        }
        if let (false, Some(radii)) = (chamfer, recipe.get("radii").filter(|radii| !radii.is_null())) {
            let Some(laws) = radius_laws(radii, edges.len()) else { return refused() };
            return shape_of(features::fillet_laws(&source, &edges, &laws));
        }
        let size = number(recipe, "size").unwrap_or(f64::NAN);
        let size_end = if chamfer { None } else { number(recipe, "sizeEnd") };
        if !positive(size) || size_end.is_some_and(|end| !positive(end)) {
            return refused();
        }
        if chamfer {
            return chamfer_node(&source, &edges, size, recipe);
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
        if op != Some("fillet") {
            return Ok(Value::Null);
        }
        let Some(source) = self.child(recipe, "source")? else { return Ok(Value::Null) };
        let Some(edges) = indices(recipe.get("edges")) else { return Ok(Value::Null) };
        match profile_specs(recipe, &edges) {
            Err(()) => {
                return Ok(blend_stage_report(
                    "profile",
                    "the profile blend parameters are malformed (a varying size, rho or shape outside 0.05..0.95, size2 without a side)",
                ))
            }
            Ok(Some(specs)) => {
                let reason = features::profile_reason(&source, &specs).map_err(EvalError::Failure)?;
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

    /// `blend` (`blendedUnion`).
    pub(super) fn blend(&mut self, recipe: &Value) -> Evaluated {
        let Some(sources) = recipe.get("sources").and_then(Value::as_array) else { return refused() };
        let mut shapes: Vec<Rc<Shape>> = Vec::with_capacity(sources.len());
        for source in sources {
            let Some(shape) = self.evaluate(source)? else { return refused() };
            shapes.push(shape);
        }
        let borrowed: Vec<&Shape> = shapes.iter().map(Rc::as_ref).collect();
        shape_of(features::blend(&borrowed, number(recipe, "radius").unwrap_or(f64::NAN)))
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
