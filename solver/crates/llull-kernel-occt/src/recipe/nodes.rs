//! Feature recipe nodes and freeform solid kinds, following the retired opencascade.js kernel (fillet, chamfer, blend,
//! shell, curved profiles, loft, sweep, subdivision) and the `feature` walk of `packages/core/src/geometry/shapeKernel.ts`.
//!
//! The pure TypeScript geometry those builders read (oriented curve chains, Catmull-Rom ring curves, sweep frames, subdivision
//! patches, feature lowering and hole profiles) is computed by the host, which sends it ready to build
//! (`server/src/native/kernelLeaves.ts`, `kernelFeatures.ts`); this side runs the same OCCT algorithms on it.
//! Encoded chain: per segment a type code (0 line, 1 arc, 2 cubic Bezier), then its 2 / 3 / 4 xyz points.

use super::floor::floor_edge_indices;
use super::{number, place_entity, positive, refused, shape_of, vec3, EvalError, Evaluated, Evaluator};
use crate::features;
use crate::{BooleanOp, Shape};
use serde_json::Value;
use std::rc::Rc;

fn numbers(value: Option<&Value>) -> Option<Vec<f64>> {
    value?.as_array()?.iter().map(Value::as_f64).collect()
}

fn chains(value: Option<&Value>) -> Option<Vec<Vec<f64>>> {
    value?.as_array()?.iter().map(|chain| numbers(Some(chain))).collect()
}

fn indices(value: Option<&Value>) -> Option<Vec<u32>> {
    value?.as_array()?.iter().map(|index| index.as_u64().and_then(|value| u32::try_from(value).ok())).collect()
}

fn vec3_of(value: Option<&Value>) -> Option<[f64; 3]> {
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

/// Loft (`loftedSolid`): ThruSections through the ring curves (`native.chains`), placed.
pub(super) fn loft(entity: &Value) -> Evaluated {
    let native = entity.get("native");
    let Some(rings) = chains(native.and_then(|inner| inner.get("chains"))) else { return refused() };
    let ruled = native.and_then(|inner| inner.get("ruled")).and_then(Value::as_bool).unwrap_or(false);
    place_entity(shape_of(features::skinned_solid(&rings, ruled))?, entity, [0.0; 3])
}

/// Sweep (`sweptSolid`): the spine must make a wire; a variable sweep skins its station rings, else MakePipe of the section.
pub(super) fn sweep(entity: &Value) -> Evaluated {
    let Some(native) = entity.get("native") else { return refused() };
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

/// `radii` (one `EdgeRadius` per edge, `packages/core/src/model/types.ts`) flattened per edge as size, sizeEnd (NaN = constant), n, then
/// n (t, size) pairs; `None` when the list does not match the edges or a law is not positive / strictly increasing inside (0, 1).
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
        flat.extend([size, end, points.len() as f64]);
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

impl Evaluator {
    /// `fillet` / `chamfer` (`roundEdges`): unique-edge indices in explorer order, `[]` = all.
    pub(super) fn round(&mut self, recipe: &Value, chamfer: bool) -> Evaluated {
        let Some(source) = self.child(recipe, "source")? else { return refused() };
        let Some(edges) = indices(recipe.get("edges")) else { return refused() };
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
            shape_of(features::chamfer(&source, &edges, size))
        } else {
            shape_of(features::fillet(&source, &edges, size, size_end))
        }
    }

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
            other => Err(EvalError::Unsupported(format!("faceOp kind '{}'", other.unwrap_or("")))),
        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn volume(evaluated: Evaluated) -> f64 {
        crate::mass_properties(&evaluated.unwrap().unwrap()).unwrap().volume
    }

    fn cube_leaf(size: f64) -> Value {
        json!({ "op": "solid", "entity": { "kind": "box", "size": [size, size, size], "position": [0, 0, 0], "rotation": [0, 0, 0] } })
    }

    #[test]
    fn a_feature_cut_tries_brep_feat_then_the_lowered_tool() {
        let mut evaluator = Evaluator::new(16);
        let tool = cube_leaf(1.0);
        let lowered = json!({ "op": "featureCut", "mode": "subtract", "source": cube_leaf(2.0), "tool": tool });
        assert!((volume(evaluator.evaluate(&lowered)) - 7.0).abs() < 1e-9);
        let refused = json!({ "op": "featureCut", "mode": "subtract", "source": cube_leaf(2.0), "tool": null });
        assert!(evaluator.evaluate(&refused).unwrap().is_none());
        let profile = [0.0, 0.0, 1.5, 0.25, 0.0, 1.5, 0.25, 0.0, -1.5, 0.0, 0.0, -1.5];
        let drilled = json!({
            "op": "featureCut", "mode": "subtract", "source": cube_leaf(2.0), "tool": tool,
            "holes": { "profiles": [profile], "origins": [[0, 0, 0]], "normal": [0, 0, 1] },
        });
        let expected = 8.0 - std::f64::consts::PI * 0.0625 * 2.0;
        assert!((volume(evaluator.evaluate(&drilled)) - expected).abs() < 1e-9, "the BRepFeat revolution, not the tool");
    }

    #[test]
    fn a_pocket_floor_fillet_adds_the_concave_fillet_material() {
        let mut evaluator = Evaluator::new(16);
        let source =
            json!({ "op": "solid", "entity": { "kind": "box", "size": [10, 10, 2], "position": [0, 0, 0], "rotation": [0, 0, 0] } });
        let tool = json!({ "op": "solid", "entity": { "kind": "cylinder", "radius": 2, "height": 2, "position": [0, 0, 1], "rotation": [0, 0, 0] } });
        let half = |from: [f64; 2], through: [f64; 2], to: [f64; 2]| json!({ "type": "arc", "points": [from, through, to] });
        let floor = |radius: f64| {
            json!({
                "radius": radius, "floorDepth": 1, "origin": [0, 0, 1], "normal": [0, 0, 1], "xDir": [1, 0, 0],
                "outlines": [[half([2.0, 0.0], [0.0, 2.0], [-2.0, 0.0]), half([-2.0, 0.0], [0.0, -2.0], [2.0, 0.0])]],
            })
        };
        let pocket = |floor: Value| json!({ "op": "featureCut", "mode": "subtract", "source": source, "tool": tool, "floorFillet": floor });
        let (pi, r, big_r) = (std::f64::consts::PI, 0.5, 2.0);
        let material = 2.0 * pi * (r * r * (big_r - r / 2.0) - pi * r * r / 4.0 * (big_r - r) - r.powi(3) / 3.0);
        let expected = 200.0 - 4.0 * pi + material;
        assert!((volume(evaluator.evaluate(&pocket(floor(r)))) - expected).abs() < 1e-6, "Pappus volume of the floor fillet");
        let nowhere =
            json!({ "radius": r, "floorDepth": 0.25, "origin": [0, 0, 1], "normal": [0, 0, 1], "xDir": [1, 0, 0], "outlines": [] });
        assert!(evaluator.evaluate(&pocket(nowhere)).unwrap().is_none(), "no floor edge = refused");
    }

    #[test]
    fn freeform_leaves_build_from_the_host_payload() {
        let mut evaluator = Evaluator::new(16);
        let leaf = |entity: Value| json!({ "op": "solid", "entity": entity });
        let square = |z: f64| -> Vec<f64> {
            let corners = [[1.0, 1.0], [-1.0, 1.0], [-1.0, -1.0], [1.0, -1.0], [1.0, 1.0]];
            corners.windows(2).flat_map(|pair| [0.0, pair[0][0], pair[0][1], z, pair[1][0], pair[1][1], z]).collect()
        };
        let loft = json!({ "kind": "loft", "native": { "chains": [square(0.0), square(2.0)], "ruled": true } });
        assert!((volume(evaluator.evaluate(&leaf(loft))) - 8.0).abs() < 1e-6);
        let sweep = json!({ "kind": "sweep", "native": { "spine": [0, 0, 0, 0, 0, 0, 2], "chain": square(0.0) } });
        assert!((volume(evaluator.evaluate(&leaf(sweep))) - 8.0).abs() < 1e-6);
        let tetra = json!({ "positions": [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], "indices": [0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2] });
        let faceted = json!({ "kind": "subdivision", "native": { "patches": [0.0], "triangles": tetra } });
        assert!((volume(evaluator.evaluate(&leaf(faceted))) - 1.0 / 6.0).abs() < 1e-9, "bad patches fall back to the triangles");
        let extrusion = json!({ "kind": "extrusion", "profile": [[1, 1], [-1, 1], [-1, -1], [1, -1]], "depth": 3, "chain": square(0.0) });
        assert!((volume(evaluator.evaluate(&leaf(extrusion))) - 12.0).abs() < 1e-9);
    }

    #[test]
    fn a_thread_tool_marks_every_recipe_built_on_it() {
        let groove = json!({ "op": "solid", "entity": { "kind": "mesh", "threadTool": true } });
        let union = json!({ "op": "boolean", "boolean": "union", "a": cube_leaf(1.0), "b": { "op": "place", "source": groove } });
        assert!(thread_bearing(&union));
        assert!(!thread_bearing(&json!({ "op": "blend", "sources": [cube_leaf(1.0), cube_leaf(2.0)] })));
    }
}
