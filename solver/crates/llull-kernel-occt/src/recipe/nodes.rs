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

/// Loft (`loftedSolid`): ThruSections through the ring curves (`native.chains`), placed. With the capability `bsplineSections` the host also
/// sends each exact section as ONE B-spline (`native.bsplines`): those are tried first, and a refusal or malformed data falls back to the chains.
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

/// Largest count a surface description may declare (mirrors `packages/core/src/geometry/surfaceWire.ts`).
const MAX_COUNT: f64 = 100_000.0;

/// An integer in `[minimum, MAX_COUNT]` stored as a double, or `None` (NaN, fractional, out of range).
fn count_of(value: Option<&f64>, minimum: f64) -> Option<usize> {
    let value = *value?;
    (value >= minimum && value <= MAX_COUNT && value.fract() == 0.0).then_some(value as usize)
}

/// Whether `data` is a consistent description of the surface `kind` (0 B-spline, 1 plane, 2 cylinder, 3 cone): the layout the C++ reads.
fn surface_data_ok(kind: i32, data: &[f64]) -> bool {
    match kind {
        1 => data.len() == 9,
        2 | 3 => data.len() == 10 && data[9] > 0.0,
        0 => {
            let (Some(_), Some(_)) = (count_of(data.first(), 1.0), count_of(data.get(1), 1.0)) else { return false };
            let (Some(count_u), Some(count_v)) = (count_of(data.get(2), 2.0), count_of(data.get(3), 2.0)) else { return false };
            let (Some(knots_u), Some(knots_v)) = (count_of(data.get(4), 2.0), count_of(data.get(5), 2.0)) else { return false };
            let rational = match data.get(6) {
                Some(flag) if *flag == 0.0 => 0,
                Some(flag) if *flag == 1.0 => 1,
                _ => return false,
            };
            let poles = count_u * count_v;
            let head = 7 + 3 * poles + rational * poles;
            data.len() == head + 2 * (knots_u + knots_v)
                && data[head + knots_u..head + 2 * knots_u]
                    .iter()
                    .chain(&data[head + 2 * knots_u + knots_v..])
                    .all(|m| count_of(Some(m), 1.0).is_some())
        }
        _ => false,
    }
}

/// Whether `loops` is empty (the natural boundary) or a list of exactly one outer loop plus holes, each with >= 3 points, and nothing else.
fn loops_ok(loops: &[f64]) -> bool {
    if loops.is_empty() {
        return true;
    }
    let Some(count) = count_of(loops.first(), 1.0) else { return false };
    let (mut offset, mut outer) = (1_usize, 0_usize);
    for _ in 0..count {
        let Some(points) = count_of(loops.get(offset), 3.0) else { return false };
        match loops.get(offset + 1) {
            Some(flag) if *flag == 1.0 => outer += 1,
            Some(flag) if *flag == 0.0 => {}
            _ => return false,
        }
        offset += 2 + 2 * points;
        if offset > loops.len() {
            return false;
        }
    }
    offset == loops.len() && outer == 1
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
    place_entity(shape_of(features::surface_face(0, &surface, &loops))?, entity, [0.0; 3])
}

/// `faceSlab` (capability `faceSlab`): a trimmed face of a B-spline / plane / cylinder / cone (`surface.type` + `surface.data`, `loops`) lifted
/// along its normal from offset `from` to `to` (a solid of constant thickness; `direction` = lift direction at the first loop vertex).
pub(super) fn face_slab(recipe: &Value) -> Evaluated {
    let Some(surface) = recipe.get("surface") else { return refused() };
    let kind = match surface.get("type").and_then(Value::as_str) {
        Some("bspline") => 0,
        Some("plane") => 1,
        Some("cylinder") => 2,
        Some("cone") => 3,
        _ => return refused(),
    };
    let (Some(data), Some(loops), Some(from), Some(to), Some(direction)) = (
        numbers(surface.get("data")),
        numbers(recipe.get("loops")),
        number(recipe, "from"),
        number(recipe, "to"),
        vec3(recipe, "direction"),
    ) else {
        return refused();
    };
    if !surface_data_ok(kind, &data) || !loops_ok(&loops) || !from.is_finite() || !to.is_finite() {
        return refused();
    }
    let tolerance = number(recipe, "tolerance").unwrap_or(1e-6);
    if to.partial_cmp(&from) != Some(std::cmp::Ordering::Greater) || !positive(tolerance) {
        return refused();
    }
    shape_of(features::face_slab(kind, &data, &loops, [from, to], direction, tolerance))
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

impl Evaluator {
    /// `fillet` / `chamfer` (`roundEdges`): unique-edge indices in explorer order, `[]` = all.
    pub(super) fn round(&mut self, recipe: &Value, chamfer: bool) -> Evaluated {
        let Some(source) = self.child(recipe, "source")? else { return refused() };
        let Some(edges) = indices(recipe.get("edges")) else { return refused() };
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
fn brep_feat(source: &Rc<Shape>, recipe: &Value) -> Result<Option<Shape>, EvalError> {
    if let Some(holes) = recipe.get("holes") {
        let (Some(profiles), Some(origins), Some(normal)) =
            (chains(holes.get("profiles")), holes.get("origins").and_then(Value::as_array), vec3(holes, "normal"))
        else {
            return Ok(None);
        };
        let mut current: Option<Shape> = None;
        for (profile, origin) in profiles.iter().zip(origins) {
            let Some(origin) = vec3_of(Some(origin)) else { return Ok(None) };
            let base: &Shape = current.as_ref().unwrap_or(source);
            match features::feature_revol_cut(base, profile, origin, normal).map_err(EvalError::Failure)? {
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
    features::feature_prism_cut(source, &chain, origin, normal, &probes, length).map_err(EvalError::Failure)
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
    fn a_sheet_leaf_and_a_face_slab_build_from_their_payloads() {
        let mut evaluator = Evaluator::new(16);
        // bilinear sheet over [0, 4] x [0, 3] (u, v in [0, 1]), trimmed to the middle half in u, placed 1 up in z
        let surface = [
            1.0, 1.0, 2.0, 2.0, 2.0, 2.0, 0.0, 0.0, 0.0, 0.0, 0.0, 3.0, 0.0, 4.0, 0.0, 0.0, 4.0, 3.0, 0.0, 0.0, 1.0, 2.0, 2.0, 0.0, 1.0,
            2.0, 2.0,
        ];
        let trim = [1.0, 4.0, 1.0, 0.25, 0.0, 0.75, 0.0, 0.75, 1.0, 0.25, 1.0];
        let sheet = |native: Value| json!({ "op": "solid", "entity": { "id": "s", "kind": "nurbs_surface", "position": [0, 0, 1], "rotation": [0, 0, 0], "native": native } });
        let area = |evaluated: Evaluated| crate::mass_properties(&evaluated.unwrap().unwrap()).unwrap();
        let whole = area(evaluator.evaluate(&sheet(json!({ "surface": surface }))));
        assert!((whole.area - 12.0).abs() < 1e-9 && (whole.bounds[2] - 1.0).abs() < 1e-3, "placed sheet area {}", whole.area);
        let trimmed = area(evaluator.evaluate(&sheet(json!({ "surface": surface, "loops": trim }))));
        assert!((trimmed.area - 6.0).abs() < 1e-9, "trimmed sheet area {}", trimmed.area);
        assert!(evaluator.evaluate(&sheet(json!({}))).unwrap().is_none(), "a sheet without its payload is refused");
        let slab = json!({
            "op": "faceSlab", "surface": { "type": "bspline", "data": surface }, "loops": trim, "from": 0.5, "to": 1.0, "direction": [0, 0, 1],
        });
        assert!((volume(evaluator.evaluate(&slab)) - 3.0).abs() < 1e-6, "slab = trimmed area x thickness");
        let backwards = json!({ "op": "faceSlab", "surface": { "type": "plane", "data": [0, 0, 0, 1, 0, 0, 0, 1, 0] }, "loops": trim, "from": 1, "to": 1, "direction": [0, 0, 1] });
        assert!(evaluator.evaluate(&backwards).unwrap().is_none());
    }

    #[test]
    fn malformed_payloads_are_refused_before_the_kernel_reads_them() {
        let mut evaluator = Evaluator::new(16);
        let plane = json!({ "type": "plane", "data": [0, 0, 0, 1, 0, 0, 0, 1, 0] });
        let square = json!([1, 4, 1, 0, 0, 1, 0, 1, 1, 0, 1]);
        let slab = |surface: Value, loops: Value| json!({ "op": "faceSlab", "surface": surface, "loops": loops, "from": 0, "to": 1, "direction": [0, 0, 1] });
        assert!((volume(evaluator.evaluate(&slab(plane.clone(), square.clone()))) - 1.0).abs() < 1e-9);
        let refused = [
            slab(plane.clone(), json!([1, 1e19, 1, 0, 0])),
            slab(plane.clone(), json!([1, 4, 1, 0, 0])),
            slab(plane.clone(), json!([2, 4, 1, 0, 0, 1, 0, 1, 1, 0, 1, 4, 1, 0, 0, 1, 0, 1, 1, 0, 1])),
            slab(plane.clone(), json!([1, 4, 0, 0, 0, 1, 0, 1, 1, 0, 1])),
            slab(plane.clone(), json!([])),
            slab(json!({ "type": "plane", "data": [0, 0, 0] }), square.clone()),
            slab(json!({ "type": "cylinder", "data": [0, 0, 0, 0, 0, 1, 1, 0, 0, -1] }), square.clone()),
            slab(json!({ "type": "bspline", "data": [1, 1, 1e19, 2, 2, 2, 0] }), square.clone()),
            slab(json!({ "type": "bspline", "data": [] }), square.clone()),
            slab(json!({ "type": "torus", "data": [] }), square.clone()),
        ];
        for recipe in &refused {
            assert!(evaluator.evaluate(recipe).unwrap().is_none(), "{recipe}");
        }
        let sheet = json!({ "op": "solid", "entity": { "id": "s", "kind": "nurbs_surface", "position": [0, 0, 0], "rotation": [0, 0, 0], "native": { "surface": [1, 1, 2, 2, 2, 2, 0], "loops": [] } } });
        assert!(evaluator.evaluate(&sheet).unwrap().is_none());
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
        // the same loft from B-spline sections (degree 1, five poles, closed square): volume 8; malformed B-spline data falls back to the chains
        let bspline_square = |z: f64| -> Vec<f64> {
            let corners = [[1.0, 1.0], [-1.0, 1.0], [-1.0, -1.0], [1.0, -1.0], [1.0, 1.0]];
            let mut data = vec![1.0, 5.0, 5.0, 0.0, 0.0];
            data.extend(corners.iter().flat_map(|corner| [corner[0], corner[1], z]));
            data.extend([0.0, 1.0, 2.0, 3.0, 4.0, 2.0, 1.0, 1.0, 1.0, 2.0]);
            data
        };
        let exact = json!({ "kind": "loft", "native": { "bsplines": [bspline_square(0.0), bspline_square(2.0)], "chains": [square(0.0), square(2.0)], "ruled": true } });
        assert!((volume(evaluator.evaluate(&leaf(exact))) - 8.0).abs() < 1e-6, "B-spline sections");
        let malformed =
            json!({ "kind": "loft", "native": { "bsplines": [[1.0, 5.0], [1.0]], "chains": [square(0.0), square(2.0)], "ruled": true } });
        assert!((volume(evaluator.evaluate(&leaf(malformed))) - 8.0).abs() < 1e-6, "fallback to the chains");
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
