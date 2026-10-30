//! 01 DEF §17.1: the exact warp of an `infinite` region against the closed forms, and the golden vectors of the shared pack (TS <-> C++ parity).

use super::deform_tests::{bar, build, entity, node, refusal, relative, span};
use serde_json::{json, Value};
use std::f64::consts::{FRAC_PI_2, PI};

#[test]
fn the_law_library_matches_the_golden_vectors_of_the_pack() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../docs/design/01-body-deformation/validation/data/point_vectors.json");
    let vectors: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("pack data")).unwrap();
    let header = |kind: f64, params: &Value, region: (f64, f64, f64)| {
        // kind, tolerance, origin, axis, reference, region start / end / falloff, preserveAnalytic, region.infinite
        let infinite = if params["infinite"].as_bool().unwrap_or(false) { 1.0 } else { 0.0 };
        vec![kind, 1e-3, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, region.0, region.1, region.2, 0.0, infinite]
    };
    let number = |params: &Value, key: &str| params[key].as_f64().unwrap_or(0.0);
    let falloff = |params: &Value| match params["falloff"].as_str() {
        Some("smooth") => 2.0,
        Some("none") => 0.0,
        _ => 1.0,
    };
    let mut checked = 0;
    for (name, law) in vectors["laws"].as_object().unwrap() {
        let params = &law["params"];
        let region = (number(params, "z0"), number(params, "z1").max(number(params, "z0") + 1.0), falloff(params));
        let spec = match name.as_str() {
            "twist" | "twist_smooth" | "twist_infinite" => [header(1.0, params, region), vec![number(params, "angleRad")]].concat(),
            "taper" | "taper_flat" | "taper_infinite" | "taper_flat_infinite" => {
                let flat = if name.starts_with("taper_flat") { 1.0 } else { 0.0 };
                [header(2.0, params, region), vec![number(params, "scaleEnd"), flat]].concat()
            }
            "bend" | "bend_infinite" | "bend_infinite_symmetric" => {
                let symmetric = if params["symmetric"].as_bool().unwrap_or(false) { 1.0 } else { 0.0 };
                [header(4.0, params, region), vec![number(params, "radius"), symmetric]].concat()
            }
            "stretch" | "stretch_infinite" => [header(3.0, params, (region.0, region.1, 0.0)), vec![number(params, "factor")]].concat(),
            "flow_base_line" | "flow_base_arc" | "flow_base_line_stretch" => {
                let (ratio, length, step) = (number(params, "ratio"), number(params, "baseLength"), number(params, "step"));
                let target = arc_stations(number(params, "targetRadius"), ratio * length, step);
                let base = arc_stations(number(params, "baseRadius"), length, step);
                let mut numbers = vec![0.0, ratio, step, (target.len() / 12) as f64];
                numbers.extend(target);
                numbers.extend([(base.len() / 12) as f64, step]);
                numbers.extend(base);
                [header(7.0, params, region), numbers].concat()
            }
            "flow_surface_base_plane" | "flow_surface_base_cylinder" => {
                let (step, length, half) = (number(params, "step"), number(params, "length"), number(params, "halfWidth"));
                let (x0, nx, y0, ny) =
                    (-0.6, ((length + 1.2) / step).round() as usize + 1, -half, (2.0 * half / step).round() as usize + 1);
                let target = sheet_nodes(number(params, "targetRadius"), (x0, step, nx), (y0, step, ny));
                let base = sheet_nodes(number(params, "baseRadius"), (x0, step, nx), (y0, step, ny));
                let mut numbers = vec![x0, y0, step, step, nx as f64, ny as f64];
                numbers.extend(target);
                numbers.extend(base);
                [header(8.0, params, region), numbers].concat()
            }
            "scale_nonuniform" => {
                let f = params["factors"].as_array().unwrap();
                let (x, y, z) = (f[0].as_f64().unwrap(), f[1].as_f64().unwrap(), f[2].as_f64().unwrap());
                [header(0.0, params, region), vec![x, 0.0, 0.0, 0.0, y, 0.0, 0.0, 0.0, z, 0.0, 0.0, 0.0]].concat()
            }
            "point_push" => {
                let c = params["center"].as_array().unwrap();
                let d = params["direction"].as_array().unwrap();
                let mut numbers = vec![c[0].as_f64().unwrap(), c[1].as_f64().unwrap(), c[2].as_f64().unwrap()];
                numbers.extend([d[0].as_f64().unwrap(), d[1].as_f64().unwrap(), d[2].as_f64().unwrap()]);
                numbers.extend([number(params, "distance"), number(params, "radius"), 0.0]);
                [header(6.0, params, region), numbers].concat()
            }
            "ffd" | "ffd_spline" | "ffd_oriented" | "ffd_spline_oriented" => {
                let take = |key: &str| -> Vec<f64> {
                    let key = if key == "splineDegrees_or_zero" {
                        if params.get("splineDegrees").is_some() {
                            "splineDegrees"
                        } else {
                            return vec![0.0; 3];
                        }
                    } else {
                        key
                    };
                    params[key].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect::<Vec<f64>>()
                };
                let (min, max, degrees) = (take("min"), take("max"), take("degrees"));
                let counts: Vec<usize> = degrees.iter().map(|d| *d as usize + 1).collect();
                let mut offsets = vec![0.0; 3 * counts[0] * counts[1] * counts[2]];
                for moved in params["moved"].as_array().unwrap() {
                    let index: Vec<usize> = moved["index"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as usize).collect();
                    let slot = (index[0] * counts[1] + index[1]) * counts[2] + index[2];
                    for axis in 0..3 {
                        offsets[3 * slot + axis] += moved["delta"][axis].as_f64().unwrap();
                    }
                }
                // the optional trailer: spline degrees (0: Bernstein), an oriented flag, the box axes (rows)
                let mut trailer = Vec::new();
                if params.get("splineDegrees").is_some() || params.get("axes").is_some() {
                    let spline = take("splineDegrees_or_zero");
                    trailer.extend(spline);
                    let rows: Vec<f64> = params["axes"]
                        .as_array()
                        .map(|rows| rows.iter().flat_map(|row| row.as_array().unwrap().iter().map(|v| v.as_f64().unwrap())).collect())
                        .unwrap_or_default();
                    trailer.push(if rows.is_empty() { 0.0 } else { 1.0 });
                    trailer.extend(if rows.is_empty() { vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0] } else { rows });
                }
                [header(5.0, params, region), min, max, degrees, offsets, trailer].concat()
            }
            _ => continue,
        };
        let points: Vec<f64> = law["points"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|p| p["in"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()))
            .collect();
        let images = crate::deform::warp_points(&spec, &points).unwrap();
        let determinants = crate::deform::warp_determinants(&spec, &points).unwrap();
        for (k, point) in law["points"].as_array().unwrap().iter().enumerate() {
            // the pack's ffd vectors hold the identity outside the lattice box (TECHNICAL_SPEC §5.3), so every point is checked
            for axis in 0..3 {
                let expected = point["out"][axis].as_f64().unwrap();
                assert!(
                    (images[3 * k + axis] - expected).abs()
                        < if name.starts_with("flow_base") {
                            1e-8
                        } else if name.starts_with("flow_surface_base") {
                            2e-5
                        } else {
                            1e-9
                        },
                    "{name} point {k} axis {axis}: {} vs {expected}",
                    images[3 * k + axis]
                );
            }
            // det J from the forward-mode derivatives (a mis-scaled implicit derivative of the base projection would pass the images); not on a kink of the map
            let infinite = params["infinite"].as_bool().unwrap_or(false);
            let on_kink = !infinite
                && [number(params, "z0"), number(params, "z1")].iter().any(|z| (point["in"][2].as_f64().unwrap() - z).abs() < 1e-9);
            if let (false, Some(expected)) = (on_kink, point["det"].as_f64()) {
                assert!(
                    (determinants[k] - expected).abs() < if name.starts_with("flow_surface_base") { 2e-4 } else { 1e-6 },
                    "{name} point {k} det {} vs {expected}",
                    determinants[k]
                );
            }
        }
        checked += 1;
    }
    assert_eq!(checked, 23, "every law of the pack except the flow onto a cylinder (the flow along a curve is tested against the bend)");
}

/// A region whose `start` and `end` only fix the rate: the law holds on the whole axis (`region.infinite`, 01 DEF §17.1).
fn endless(start: f64, end: f64, falloff: &str) -> Value {
    let mut region = span(start, end, falloff);
    region["infinite"] = json!(true);
    region
}

#[test]
fn an_infinite_twist_keeps_its_rate_beyond_both_region_ends() {
    // rate 36 deg per 20 units over a bar of 100: the same twist as 180 degrees linear over the whole bar, with no face split at the region ends
    let law = |angle: f64| json!({ "kind": "twist", "angleRad": angle.to_radians() });
    let endless_twist = build(&node(&bar(), law(36.0), Some(endless(-10.0, 10.0, "linear")), 1e-4, [0.0, 0.0, 50.0]));
    let whole = build(&node(&bar(), law(180.0), Some(span(-50.0, 50.0, "linear")), 1e-4, [0.0, 0.0, 50.0]));
    assert!(relative(endless_twist.volume, 10000.0) < 1e-6, "volume {}", endless_twist.volume);
    assert!(relative(endless_twist.area, whole.area) < 1e-6, "area {} against {}", endless_twist.area, whole.area);
    assert_eq!(endless_twist.report["faces"], json!(6));
    assert_eq!(endless_twist.report["splitFaces"], json!(0));
}

#[test]
fn an_infinite_stretch_scales_the_whole_body_about_the_region_start() {
    let stretched = node(&bar(), json!({ "kind": "stretch", "factor": 1.5 }), Some(endless(-10.0, 10.0, "none")), 1e-3, [0.0, 0.0, 50.0]);
    let built = build(&stretched);
    assert!(relative(built.volume, 15000.0) < 1e-9, "volume {}", built.volume);
    assert!(relative(built.area, 4.0 * 10.0 * 150.0 + 200.0) < 1e-9, "area {}", built.area);
    assert_eq!(built.report["splitFaces"], json!(0));
}

#[test]
fn an_infinite_taper_extends_its_slope_and_is_refused_where_it_folds() {
    // r 5, h 40 from z = 0: s = 1 - 0.2 z / 80 reaches 0.9 at the top, a frustum of 5 and 4.5
    let pin = entity("cylinder", json!({ "radius": 5, "height": 40 }));
    let law = |scale_end: f64| json!({ "kind": "taper", "scaleEnd": scale_end, "flat": false });
    let frustum = build(&node(&pin, law(0.8), Some(endless(0.0, 80.0, "linear")), 1e-4, [0.0, 0.0, -20.0]));
    let expected = PI * 40.0 / 3.0 * (25.0 + 5.0 * 4.5 + 4.5 * 4.5);
    assert!(relative(frustum.volume, expected) < 1e-5, "volume {} against {expected}", frustum.volume);
    // s = 1 - 0.6 z / 20 is -0.2 at the top: a finite region would have stopped at 0.4
    let report = refusal(&node(&pin, law(0.4), Some(endless(0.0, 20.0, "linear")), 1e-4, [0.0, 0.0, -20.0]));
    assert_eq!(report["code"], json!("DEF_FOLDOVER"), "{report}");
}

#[test]
fn an_infinite_bend_curves_a_rod_longer_than_its_region_into_one_arc() {
    // R 50, rate pi / 2 per 78.54: the rod of twice that length is the 180 degree torus segment of VC-DEF-08, not a quarter arc and a straight tail
    let quarter = 50.0 * FRAC_PI_2;
    let rod = entity("cylinder", json!({ "radius": 5, "height": 2.0 * quarter }));
    let bent = node(
        &rod,
        json!({ "kind": "bend", "radius": 50, "symmetric": false }),
        Some(endless(0.0, quarter, "linear")),
        1e-4,
        [0.0, 0.0, -quarter],
    );
    let built = build(&bent);
    assert!(relative(built.volume, 12337.0055) < 1e-6, "volume {}", built.volume);
    assert!(relative(built.area, 4934.8022 + 2.0 * PI * 25.0) < 1e-6, "area {}", built.area);
    assert_eq!(built.report["faces"], json!(3));
    assert_eq!(built.report["ring"], json!(false));
}

#[test]
fn an_infinite_symmetric_bend_keeps_the_region_middle_and_the_arc() {
    // R 50, rate pi / 2 per 78.54 on a rod of twice that length: symmetric moves the same 180 degree torus segment so the point at the region middle stays put
    let quarter = 50.0 * FRAC_PI_2;
    let rod = entity("cylinder", json!({ "radius": 5, "height": 2.0 * quarter }));
    let law = |symmetric: bool| json!({ "kind": "bend", "radius": 50, "symmetric": symmetric });
    let place = |symmetric: bool| node(&rod, law(symmetric), Some(endless(0.0, quarter, "linear")), 1e-4, [0.0, 0.0, -quarter]);
    let (plain, moved) = (build(&place(false)), build(&place(true)));
    assert!(relative(moved.volume, plain.volume) < 1e-6, "same arc: {} against {}", moved.volume, plain.volume);
    assert!(relative(moved.area, plain.area) < 1e-6);
    // bounds are [min x y z, max x y z]. Plain arc: the furthest y is the outer tube at the end face, 50 + 50 + 5 = 105. Symmetric: the arc spans theta in
    // [-45, 135] degrees about its centre, so y reaches 50 + 55 cos(45 deg) = 88.89 instead
    assert!((plain.bounds[4] - 105.0).abs() < 1e-3, "{:?}", plain.bounds);
    assert!((moved.bounds[4] - (50.0 + 55.0 * (PI / 4.0).cos())).abs() < 1e-3, "{:?}", moved.bounds);
}

/// 10 x 10 x 40 cylinder (r 5) on world z in [-20, 20]: with the frame axis tilted, the world-aligned box overstates its extent along the axis.
fn tilted_taper(start: f64, end: f64, scale_end: f64, axis: [f64; 3]) -> Value {
    let pin = entity("cylinder", json!({ "radius": 5, "height": 10 }));
    let mut tree =
        node(&pin, json!({ "kind": "taper", "scaleEnd": scale_end, "flat": false }), Some(endless(start, end, "linear")), 1e-3, [0.0; 3]);
    tree["frame"]["axis"] = json!(axis);
    tree
}

#[test]
fn an_infinite_taper_whose_zero_is_beyond_the_true_span_on_an_oblique_axis_is_accepted() {
    // axis (1, 1, 1): the cylinder spans z' in +-6.97 (h/2 a_z + r sqrt(a_x^2 + a_y^2)); its world box projects to +-8.66. s = 1 - 0.5 z / L has its zero at 2 L
    let tilted = [1.0, 1.0, 1.0];
    let outside = build(&tilted_taper(0.0, 4.0, 0.5, tilted));
    assert!(outside.volume > 0.0 && outside.report["ok"] == json!(true), "{}", outside.report);
    let inside = refusal(&tilted_taper(0.0, 3.0, 0.5, tilted));
    assert_eq!(inside["code"], json!("DEF_FOLDOVER"), "{inside}");
}

#[test]
fn an_infinite_taper_with_the_whole_body_past_its_zero_is_refused() {
    // cylinder on z in [0, 40], s = 1 + 2 (z - 50) / 10 runs from -9 to -1: det J = s^2 > 0 everywhere but every section is mirrored and nine times larger
    let pin = entity("cylinder", json!({ "radius": 5, "height": 40 }));
    let tree =
        node(&pin, json!({ "kind": "taper", "scaleEnd": 3, "flat": false }), Some(endless(50.0, 60.0, "linear")), 1e-3, [0.0, 0.0, -20.0]);
    assert_eq!(refusal(&tree)["code"], json!("DEF_FOLDOVER"));
}

/// Stations (P, T, N, B) every `step` of arc length along an arc of `radius` in the xz plane (centre (R, 0, 0), normal toward it), or a line along +z for radius 0.
fn arc_stations(radius: f64, length: f64, step: f64) -> Vec<f64> {
    (0..=(length / step).round() as usize)
        .flat_map(|k| {
            let s = k as f64 * step;
            if radius == 0.0 {
                return vec![0.0, 0.0, s, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
            }
            let t = s / radius;
            vec![radius * (1.0 - t.cos()), 0.0, radius * t.sin(), t.sin(), 0.0, t.cos(), t.cos(), 0.0, -t.sin(), 0.0, 1.0, 0.0]
        })
        .collect()
}

#[test]
fn a_bent_rod_flowed_from_its_own_arc_onto_a_line_is_straight_again() {
    // quarter torus segment (R 50, r 5) built by the exact bend, then flowed with the bend's centreline as the base and a line as the target:
    // det J = 1 / (1 - x / 50), so the volume is that of the straight rod, V = pi r^2 L, and it spans z in [-L/2, L/2] on the axis
    let quarter = 50.0 * FRAC_PI_2;
    let rod = entity("cylinder", json!({ "radius": 5, "height": quarter }));
    let mut bent = node(
        &rod,
        json!({ "kind": "bend", "radius": 50, "symmetric": false }),
        Some(span(0.0, quarter, "linear")),
        1e-4,
        [0.0, 0.0, -quarter / 2.0],
    );
    bent["frame"]["reference"] = json!([0, -1, 0]);
    let step = 0.2;
    let (target, base) = (arc_stations(0.0, quarter + 2.0, step), arc_stations(50.0, quarter + 2.0, step));
    let flow = json!({
        "kind": "flowCurve", "z0": 0.0, "ratio": 1.0, "step": step, "stations": target,
        "base": { "step": step, "stations": base },
    });
    let straight = build(&node(&bent, flow, None, 1e-3, [0.0, 0.0, -quarter / 2.0]));
    assert!(relative(straight.volume, PI * 25.0 * quarter) < 1e-4, "volume {}", straight.volume);
    // bounds [min x y z, max x y z]: a straight rod of radius 5 along the axis, z from the frame origin up
    assert!(straight.bounds[0] > -5.01 && straight.bounds[3] < 5.01, "{:?}", straight.bounds);
    assert!((straight.bounds[5] - straight.bounds[2] - quarter).abs() < 0.02, "{:?}", straight.bounds);
}

/// Nodes (P then N, i-major) of a sheet on the grid x0 + i hx, y0 + j hy: a cylinder of `radius` about an axis along y through (R, y, 0) with the arc from the origin
/// in the xz plane (normal out of it), or the plane z = 0 (normal +z) for radius 0.
fn sheet_nodes(radius: f64, (x0, hx, nx): (f64, f64, usize), (y0, hy, ny): (f64, f64, usize)) -> Vec<f64> {
    let mut out = Vec::with_capacity(6 * nx * ny);
    for i in 0..nx {
        let x = x0 + i as f64 * hx;
        for j in 0..ny {
            let y = y0 + j as f64 * hy;
            if radius == 0.0 {
                out.extend([x, y, 0.0, 0.0, 0.0, 1.0]);
            } else {
                let t = x / radius;
                out.extend([radius * (1.0 - t.cos()), y, radius * t.sin(), -t.cos(), 0.0, t.sin()]);
            }
        }
    }
    out
}

#[test]
fn a_body_past_the_base_table_is_refused_not_warped_with_an_unconverged_solve() {
    // identity flow on a 6 x 6 plane table of step 1 (x, y in [0, 5]): a body at x in [3, 8] runs past the base table, so the solve cannot converge there
    let nodes = sheet_nodes(0.0, (0.0, 1.0, 6), (0.0, 1.0, 6));
    let law = |with_base: bool| {
        let mut law = json!({ "kind": "flowSurface", "x0": 0.0, "y0": 0.0, "hx": 1.0, "hy": 1.0, "nx": 6, "ny": 6, "nodes": nodes });
        if with_base {
            law["baseNodes"] = json!(nodes);
        }
        law
    };
    let body = entity("box", json!({ "size": [5, 2, 2], "position": [5.5, 2.5, 0] }));
    // the plane base (no base table) builds it: only the unconverged base solve makes the difference
    let tree = node(&body, law(true), None, 1e-3, [0.0; 3]);
    let mut evaluator = crate::recipe::Evaluator::new(16);
    let built = evaluator.evaluate(&tree);
    assert!(!matches!(built, Ok(Some(_))), "an unconverged base solve must not build a shape");
    if let Ok(None) = built {
        assert_eq!(evaluator.deform_report(&tree).expect("report")["code"], json!("DEF_FLOW_BASE_OUTSIDE"));
    }
}

/// 01 DEF §17.9: a cut warped bar keeps the whole-shape adaptive rule (planar caps are exact in either rule, the twisted B-spline sides need the adaptive one): the volume is
/// the closed form 10 x 10 x 50 and the centroid the middle, and the shape asks for the adaptive rule only because it came from a warp.
#[test]
fn a_cut_warped_bar_keeps_the_whole_shape_adaptive_rule() {
    let twisted = node(&bar(), json!({ "kind": "twist", "angleRad": 1.2 }), Some(span(-50.0, 50.0, "linear")), 1e-4, [0.0, 0.0, 50.0]);
    let mut evaluator = crate::recipe::Evaluator::new(16);
    let warped = evaluator.evaluate(&twisted).expect("evaluates").expect("the warp builds");
    assert!(crate::test_bridge::refined_mass(&warped));
    let slab = crate::make_box([-20.0, -20.0, 10.0], [40.0, 40.0, 50.0]).unwrap().unwrap();
    let cut = crate::boolean(crate::BooleanOp::Intersect, &warped, &slab, false).unwrap().unwrap();
    assert!(crate::test_bridge::adaptive_rule(&cut), "B-spline sides are left");
    let mass = crate::mass_properties(&cut).unwrap();
    assert!(relative(mass.volume, 5000.0) < 1e-6, "volume {}", mass.volume);
    assert!((mass.centroid[2] - 35.0).abs() < 1e-5, "centroid {:?}", mass.centroid);
    assert!(mass.centroid[0].abs() < 1e-6 && mass.centroid[1].abs() < 1e-6);
}
