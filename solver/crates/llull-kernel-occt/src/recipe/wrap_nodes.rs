//! The 03 WRP recipe nodes: `faceSlab` and `emboss` (emboss, deboss, scribe, split), and the surface / loop descriptions they and the
//! `nurbs_surface` leaf read. The host sends the (u, v) regions and chains as JSON; they are encoded here into the flat number lists of `cpp/features.hxx`.

use super::nodes::numbers;
use super::{number, positive, refused, shape_of, vec3, EvalError, Evaluated, Evaluator};
use crate::features_surface;
use crate::BooleanOp;
use serde_json::Value;

/// Largest count a surface description may declare (mirrors `packages/core/src/geometry/surfaceWire.ts`).
const MAX_COUNT: f64 = 100_000.0;

/// An integer in `[minimum, MAX_COUNT]` stored as a double, or `None` (NaN, fractional, out of range).
fn count_of(value: Option<&f64>, minimum: f64) -> Option<usize> {
    let value = *value?;
    (value >= minimum && value <= MAX_COUNT && value.fract() == 0.0).then_some(value as usize)
}

/// Whether `data` is a consistent description of the surface `kind` (0 B-spline, 1 plane, 2 cylinder, 3 cone, 4 sphere, 5 torus): the layout the C++ reads.
pub(super) fn surface_data_ok(kind: i32, data: &[f64]) -> bool {
    match kind {
        1 => data.len() == 9,
        2..=4 => data.len() == 10 && data[9] > 0.0,
        5 => data.len() == 11 && data[9] > 0.0 && data[10] > 0.0,
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
pub(super) fn loops_ok(loops: &[f64]) -> bool {
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

/// A (u, v) pair of numbers.
fn pair(value: Option<&Value>) -> Option<[f64; 2]> {
    match numbers(value)?.as_slice() {
        [u, v] => Some([*u, *v]),
        _ => None,
    }
}

/// Appends one loop or chain (`start`, then `segments` of lines and B-spline pcurves) in the layout of `cpp/features.hxx`; None when it is malformed.
fn encode_loop(lp: &Value, out: &mut Vec<f64>) -> Option<()> {
    out.extend(pair(lp.get("start"))?);
    let segments = lp.get("segments")?.as_array()?;
    out.push(segments.len() as f64);
    for segment in segments {
        match segment.get("kind")?.as_str()? {
            "line" => {
                out.push(0.0);
                out.extend(pair(segment.get("to"))?);
            }
            "nurbs" => {
                out.push(1.0);
                let curve = segment.get("curve")?;
                let poles: Vec<[f64; 2]> = curve.get("poles")?.as_array()?.iter().map(|pole| pair(Some(pole))).collect::<Option<_>>()?;
                let weights = numbers(curve.get("weights"));
                let (knots, multiplicities) = (numbers(curve.get("knots"))?, numbers(curve.get("multiplicities"))?);
                out.extend([
                    curve.get("degree")?.as_f64()?,
                    poles.len() as f64,
                    if weights.is_some() { 1.0 } else { 0.0 },
                    knots.len() as f64,
                ]);
                out.extend(poles.iter().flatten());
                out.extend(weights.unwrap_or_default());
                out.extend(knots);
                out.extend(multiplicities);
            }
            _ => return None,
        }
    }
    Some(())
}

/// Flat number list of the `regions` of an `emboss` node (layout: `cpp/features.hxx`), or None when the JSON is not a list of regions of loops of
/// lines and B-spline pcurves. The C++ side validates every count and join again.
fn encode_regions(regions: Option<&Value>) -> Option<Vec<f64>> {
    let list = regions?.as_array()?;
    let mut out = vec![list.len() as f64];
    for region in list {
        let mut loops = vec![(region.get("outer")?, 1.0)];
        loops.extend(region.get("holes")?.as_array()?.iter().map(|hole| (hole, 0.0)));
        out.push(loops.len() as f64);
        for (lp, outer) in loops {
            out.push(outer);
            encode_loop(lp, &mut out)?;
        }
    }
    Some(out)
}

/// Flat number list of the `chains` of a split `emboss` node: the chain count, then each open or closed chain; None when malformed.
fn encode_chains(chains: Option<&Value>) -> Option<Vec<f64>> {
    let list = chains?.as_array()?;
    let mut out = vec![list.len() as f64];
    for chain in list {
        encode_loop(chain, &mut out)?;
    }
    Some(out)
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
        Some("sphere") => 4,
        Some("torus") => 5,
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
    shape_of(features_surface::face_slab(kind, &data, &loops, [from, to], direction, tolerance))
}

impl Evaluator {
    /// `emboss` (03 WRP, `packages/core/src/model/wrap.ts`): one face-slab per region fused with (emboss), cut from (deboss) or splitting (scribe) the source.
    /// The regions are (u, v) loops of lines and B-spline pcurves on the plane / cylinder / cone `surface`; the lift direction is the outward normal.
    pub(super) fn emboss(&mut self, recipe: &Value) -> Evaluated {
        let Some(source) = self.child(recipe, "source")? else { return refused() };
        let Some(surface) = recipe.get("surface") else { return refused() };
        if surface.get("type").and_then(Value::as_str) == Some("face") {
            // split along curves given in the (u, v) of the face's own surface
            let (Some(face), Some(chains)) = (recipe.get("face").and_then(Value::as_u64), encode_chains(recipe.get("chains"))) else {
                return refused();
            };
            let Ok(face) = u32::try_from(face) else { return refused() };
            if recipe.get("mode").and_then(Value::as_str) != Some("split") {
                return refused();
            }
            let Some(tools) = features_surface::face_edge_tools(&source, face, &chains).map_err(EvalError::Failure)? else {
                return refused();
            };
            return shape_of(features_surface::split_shape(&source, &tools));
        }
        let kind = match surface.get("type").and_then(Value::as_str) {
            Some("plane") => 1,
            Some("cylinder") => 2,
            Some("cone") => 3,
            Some("sphere") => 4,
            Some("torus") => 5,
            _ => return refused(),
        };
        let (Some(data), Some(direction), Some(depth)) = (numbers(surface.get("data")), vec3(recipe, "direction"), number(recipe, "depth"))
        else {
            return refused();
        };
        let tolerance = number(recipe, "tolerance").unwrap_or(1e-6);
        if !surface_data_ok(kind, &data) || !positive(tolerance) || !depth.is_finite() || depth < 0.0 {
            return refused();
        }
        let mode = recipe.get("mode").and_then(Value::as_str).unwrap_or("");
        if mode == "split" {
            // split_face_by_curves: the chains become edges on the surface and divide the source along them
            let Some(chains) = encode_chains(recipe.get("chains")) else { return refused() };
            let Some(tools) = features_surface::pcurve_edge_tools(kind, &data, &chains).map_err(EvalError::Failure)? else {
                return refused();
            };
            return shape_of(features_surface::split_shape(&source, &tools));
        }
        let Some(regions) = encode_regions(recipe.get("regions")) else { return refused() };
        let (range, faces_only) = match mode {
            "emboss" if depth > 0.0 => ([0.0, depth], false),
            "deboss" if depth > 0.0 => ([-depth, 0.0], false),
            "scribe" => ([0.0, 1.0], true),
            _ => return refused(),
        };
        let Some(tools) =
            features_surface::emboss_tools(kind, &data, &regions, range, direction, tolerance, faces_only).map_err(EvalError::Failure)?
        else {
            return refused();
        };
        match mode {
            "emboss" => shape_of(crate::boolean(BooleanOp::Union, &source, &tools, true)),
            "deboss" => shape_of(crate::boolean(BooleanOp::Subtract, &source, &tools, true)),
            _ => shape_of(features_surface::split_shape(&source, &tools)),
        }
    }
}
