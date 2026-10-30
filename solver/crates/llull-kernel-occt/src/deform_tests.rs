//! 01 DEF M2: the exact warp (`cpp/deform.cxx`) against the closed forms and the golden vectors of `docs/design/01-body-deformation/validation`.

use crate::mass_properties;
use crate::recipe::{EvalError, Evaluator};
use serde_json::{json, Value};
use std::f64::consts::{FRAC_PI_2, PI};

pub(super) fn entity(kind: &str, fields: Value) -> Value {
    let mut base = json!({ "id": "e", "kind": kind, "position": [0, 0, 0], "rotation": [0, 0, 0], "layerId": "l", "color": "#888" });
    if let (Some(target), Some(extra)) = (base.as_object_mut(), fields.as_object()) {
        target.extend(extra.clone());
    }
    json!({ "op": "solid", "entity": base })
}

/// A `deform` node; the frame is `origin`, axis +z, reference +x unless the test needs another.
pub(super) fn node(source: &Value, law: Value, region: Option<Value>, tolerance: f64, origin: [f64; 3]) -> Value {
    let mut node = json!({
        "op": "deform", "source": source, "law": law,
        "frame": { "origin": origin, "axis": [0, 0, 1], "reference": [1, 0, 0] },
        "output": { "mode": "exact", "tolerance": tolerance, "preserveAnalytic": false },
    });
    if let Some(region) = region {
        node["region"] = region;
    }
    node
}

pub(super) fn span(start: f64, end: f64, falloff: &str) -> Value {
    json!({ "start": start, "end": end, "falloff": falloff, "beyond": "rigid" })
}

pub(super) struct Built {
    pub(super) volume: f64,
    pub(super) area: f64,
    pub(super) bounds: Vec<f64>,
    pub(super) report: Value,
}

pub(super) fn build(tree: &Value) -> Built {
    let mut evaluator = Evaluator::new(16);
    let shape = evaluator.evaluate(tree).expect("evaluates").expect("the warp builds");
    let report = evaluator.deform_report(tree).expect("report");
    assert_eq!(report["ok"], json!(true), "{report}");
    assert!(crate::analyze(&shape).unwrap().valid, "the warped shape is a valid B-rep: {report}");
    let mass = mass_properties(&shape).unwrap();
    Built { volume: mass.volume, area: mass.area, bounds: mass.bounds, report }
}

pub(super) fn refusal(tree: &Value) -> Value {
    let mut evaluator = Evaluator::new(16);
    assert!(evaluator.evaluate(tree).expect("evaluates").is_none(), "the warp is refused");
    evaluator.deform_report(tree).expect("report")
}

pub(super) fn relative(measured: f64, expected: f64) -> f64 {
    ((measured - expected) / expected).abs()
}

/// 10 x 10 x 100 box on z in [0, 100]; frame origin on its middle.
pub(super) fn bar() -> Value {
    entity("box", json!({ "size": [10, 10, 100], "position": [0, 0, 50] }))
}

#[test]
fn a_linear_twist_of_a_box_has_the_asinh_area_and_the_volume_of_the_box() {
    // VC-DEF-01 / VC-DEF-02: 10 x 10 x 100 box, linear twist over its whole length
    for (degrees, area) in [(90.0_f64, 4204.10854), (120.0, 4207.29884), (360.0, 4264.85605)] {
        let twisted = node(
            &bar(),
            json!({ "kind": "twist", "angleRad": degrees.to_radians() }),
            Some(span(-50.0, 50.0, "linear")),
            1e-4,
            [0.0, 0.0, 50.0],
        );
        let built = build(&twisted);
        assert!(relative(built.volume, 10000.0) < 1e-6, "{degrees} deg volume {}", built.volume);
        assert!(relative(built.area, area) < 1e-6, "{degrees} deg area {}", built.area);
        assert!(built.report["maxError"].as_f64().unwrap() <= 1e-4, "the fit stays within the tolerance: {}", built.report);
        assert_eq!(built.report["faces"], json!(6));
    }
}

#[test]
fn a_partial_region_splits_the_faces_it_crosses_and_keeps_the_volume() {
    let twisted = node(&bar(), json!({ "kind": "twist", "angleRad": 1.5 }), Some(span(20.0, 60.0, "smooth")), 1e-3, [0.0; 3]);
    let built = build(&twisted);
    assert!(relative(built.volume, 10000.0) < 1e-6, "volume {}", built.volume);
    assert_eq!(built.report["splitFaces"], json!(8), "two planes cut four side faces each");
    assert_eq!(built.report["faces"], json!(14));
}

#[test]
fn a_stretch_adds_its_region_share_of_the_volume() {
    // VC-DEF-10: factor 1.5 in [20, 60] of a 10 x 10 x 100 bar: V = 10000 + 0.5 * 100 * 40
    let stretched = node(&bar(), json!({ "kind": "stretch", "factor": 1.5 }), Some(span(20.0, 60.0, "none")), 1e-3, [0.0; 3]);
    let built = build(&stretched);
    assert!(relative(built.volume, 12000.0) < 1e-9, "volume {}", built.volume);
    assert!(relative(built.area, 5000.0) < 1e-9, "area {}", built.area);
}

#[test]
fn a_taper_turns_a_cylinder_into_the_exact_cone_frustum() {
    // VC-DEF-06: r 5, h 40, scale 0.4 at the top; the axis is the cylinder's own (z through its middle)
    let pin = entity("cylinder", json!({ "radius": 5, "height": 40 }));
    let tapered =
        node(&pin, json!({ "kind": "taper", "scaleEnd": 0.4, "flat": false }), Some(span(0.0, 40.0, "linear")), 1e-4, [0.0, 0.0, -20.0]);
    let built = build(&tapered);
    let caps = PI * 25.0 + PI * 4.0;
    assert!(relative(built.volume, 1633.62818) < 1e-5, "volume {}", built.volume);
    assert!(relative(built.area, 882.116478 + caps) < 1e-5, "area {}", built.area);
}

#[test]
fn a_bar_bends_onto_a_torus_segment_with_the_pappus_volume() {
    // VC-DEF-08: r 5 cylinder bent on R 50: 90 and 180 degrees, then the closed 360 degree ring (its end caps dropped and sewn)
    let cases = [
        (PI / 2.0, 6168.50275, 2467.40110 + 2.0 * PI * 25.0, 3),
        (PI, 12337.0055, 4934.8022 + 2.0 * PI * 25.0, 3),
        (2.0 * PI, 24674.0110, 9869.60440, 1),
    ];
    for (angle, volume, area, faces) in cases {
        let length = 50.0 * angle;
        let rod = entity("cylinder", json!({ "radius": 5, "height": length }));
        let bent = node(
            &rod,
            json!({ "kind": "bend", "radius": 50, "symmetric": false }),
            Some(span(0.0, length, "linear")),
            1e-4,
            [0.0, 0.0, -length / 2.0],
        );
        let built = build(&bent);
        assert!(relative(built.volume, volume) < 1e-6, "{angle} rad volume {}", built.volume);
        assert!(relative(built.area, area) < 1e-6, "{angle} rad area {}", built.area);
        assert_eq!(built.report["faces"], json!(faces));
        assert_eq!(built.report["ring"], json!(angle > 6.0));
    }
}

#[test]
fn a_ring_that_closes_only_within_the_tolerance_still_sews() {
    // the pack's plan: the rod is 314.159265 long, 3.6e-7 short of 2 pi R
    let rod = entity("cylinder", json!({ "radius": 5, "height": 314.159265 }));
    let bent = node(
        &rod,
        json!({ "kind": "bend", "radius": 50, "symmetric": false }),
        Some(span(0.0, 314.159265, "linear")),
        1e-4,
        [0.0, 0.0, -314.159265 / 2.0],
    );
    let built = build(&bent);
    assert_eq!(built.report["ring"], json!(true));
    assert!(relative(built.volume, 24674.0110) < 1e-5, "volume {}", built.volume);
}

#[test]
fn a_fine_tolerance_costs_more_poles_not_accuracy() {
    let coarse =
        build(&node(&bar(), json!({ "kind": "twist", "angleRad": FRAC_PI_2 }), Some(span(-50.0, 50.0, "linear")), 1e-2, [0.0, 0.0, 50.0]));
    let fine =
        build(&node(&bar(), json!({ "kind": "twist", "angleRad": FRAC_PI_2 }), Some(span(-50.0, 50.0, "linear")), 1e-5, [0.0, 0.0, 50.0]));
    assert!(coarse.report["maxError"].as_f64().unwrap() > fine.report["maxError"].as_f64().unwrap());
    assert!(relative(fine.area, 4204.10854) < relative(coarse.area, 4204.10854));
}

#[test]
fn a_ground_sphere_scaled_through_the_exact_path_has_the_spheroid_volume_and_area() {
    // VC-DEF-11: r 10 sphere x [1, 1, 2] by the host-lowered gtransform; the adaptive mass rule recovers what the fixed Gauss rule loses
    let sphere = entity("sphere", json!({ "radius": 10 }));
    let egg = json!({ "op": "gtransform", "source": sphere, "matrix": [1, 0, 0, 0, 1, 0, 0, 0, 2], "translation": [0, 0, 0] });
    let mut evaluator = Evaluator::new(4);
    let shape = evaluator.evaluate(&egg).unwrap().unwrap();
    let mass = mass_properties(&shape).unwrap();
    assert!(relative(mass.volume, 8377.58041) < 1e-6, "volume {}", mass.volume);
    assert!(relative(mass.area, 2147.84353) < 1e-6, "area {}", mass.area);
}

#[test]
fn a_map_that_folds_the_body_is_refused_with_its_code() {
    // R 3 is inside the bar (half width 5): det J = (R - y) / R reaches -0.67 on its surface
    let bent =
        node(&bar(), json!({ "kind": "bend", "radius": 3, "symmetric": false }), Some(span(-50.0, 50.0, "linear")), 1e-3, [0.0, 0.0, 50.0]);
    let mut tree = bent;
    tree["frame"]["reference"] = json!([0, 1, 0]);
    let report = refusal(&tree);
    assert_eq!(report["code"], json!("DEF_FOLDOVER"), "{report}");
}

#[test]
fn bad_input_is_refused_not_thrown() {
    let degenerate = node(&bar(), json!({ "kind": "twist", "angleRad": 1.0 }), Some(span(0.0, 100.0, "linear")), 1e-3, [0.0; 3]);
    let mut parallel = degenerate.clone();
    parallel["frame"]["reference"] = json!([0, 0, 1]);
    assert_eq!(refusal(&parallel)["code"], json!("DEF_KERNEL_REFUSED"), "reference parallel to the axis");
    let mut no_tolerance = degenerate.clone();
    no_tolerance["output"]["tolerance"] = json!(0);
    assert_eq!(refusal(&no_tolerance)["code"], json!("DEF_KERNEL_REFUSED"));
    let mut empty_region = degenerate.clone();
    empty_region["region"] = span(10.0, 10.0, "linear");
    assert_eq!(refusal(&empty_region)["code"], json!("DEF_KERNEL_REFUSED"));
    // too fine for the point budget: refused with the approximation code instead of a wrong surface
    let demanding = node(&bar(), json!({ "kind": "twist", "angleRad": 40.0 }), Some(span(0.0, 100.0, "linear")), 1e-9, [0.0; 3]);
    assert_eq!(refusal(&demanding)["code"], json!("DEF_APPROX_TOLERANCE"));
    // an unknown law is a capability gap (the host falls back), a malformed node is too
    let mut evaluator = Evaluator::new(4);
    let mut unknown = degenerate;
    unknown["law"] = json!({ "kind": "flowCurve" });
    assert!(matches!(evaluator.evaluate(&unknown), Err(EvalError::Unsupported(_))));
    assert_eq!(evaluator.deform_report(&entity("box", json!({ "size": [1, 1, 1] }))).unwrap(), Value::Null);
}

#[test]
fn a_lattice_and_a_point_push_move_the_surface() {
    // VC-DEF-15: push 2 at r 10 along the normal of a face, the support sphere cuts a full disk: dV = d pi r^2 / 4
    let slab = entity("box", json!({ "size": [40, 40, 10], "position": [0, 0, 5] }));
    let push =
        json!({ "kind": "point", "center": [0, 0, 10], "direction": [0, 0, 1], "distance": 2, "radius": 10, "falloff": "smooth_c2" });
    let pushed = node(&slab, push, None, 1e-4, [0.0; 3]);
    let built = build(&pushed);
    assert!((built.volume - (16000.0 + 2.0 * PI * 100.0 / 4.0)).abs() < 1e-2 * PI * 100.0 / 4.0 * 2.0, "volume {}", built.volume);
    // an identity lattice (no offsets) leaves the volume untouched
    let lattice = json!({ "kind": "lattice", "degrees": [1, 1, 1], "box": { "min": [-30, -30, -1], "max": [30, 30, 11] }, "offsets": [] });
    let same = build(&node(&slab, lattice, None, 1e-3, [0.0; 3]));
    assert!(relative(same.volume, 16000.0) < 1e-9, "volume {}", same.volume);
}

#[test]
fn a_flow_table_of_a_circle_is_the_bend_in_the_native_laws_too() {
    // stations of the circle of radius 50 centred at (0, 50, 0) in the y-z plane, N = x, T = (0, sin, cos), B = T x N
    let radius = 50.0_f64;
    let length = radius * FRAC_PI_2;
    let count = 129;
    let step = length / (count - 1) as f64;
    let mut stations = Vec::new();
    for k in 0..count {
        let angle = k as f64 * step / radius;
        let (sin, cos) = angle.sin_cos();
        let tangent = [0.0, sin, cos];
        let normal = [1.0, 0.0, 0.0];
        let binormal = [
            tangent[1] * normal[2] - tangent[2] * normal[1],
            tangent[2] * normal[0] - tangent[0] * normal[2],
            tangent[0] * normal[1] - tangent[1] * normal[0],
        ];
        stations.extend([0.0, radius * (1.0 - cos), radius * sin]);
        stations.extend(tangent);
        stations.extend(normal);
        stations.extend(binormal);
    }
    // header: kind, tolerance, origin, axis, reference, region start / end / falloff, preserveAnalytic, region.infinite
    let header = |kind: f64| vec![kind, 1e-3, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, length, 1.0, 0.0, 0.0];
    let flow = [header(7.0), vec![0.0, 1.0, step, count as f64], stations].concat();
    let bend = [header(4.0), vec![radius, 0.0]].concat();
    let probes = [0.0, 0.0, 10.0, 5.0, 5.0, 40.0, -5.0, -5.0, 70.0, 3.0, -2.0, 0.1, 5.0, 5.0, length - 0.01, 2.0, 4.0, length + 5.0];
    let (a, b) = (crate::deform::warp_points(&flow, &probes).unwrap(), crate::deform::warp_points(&bend, &probes).unwrap());
    for (k, (x, y)) in a.iter().zip(&b).enumerate() {
        // the table is cubic Hermite on 129 stations: about (h / R)^4 R / 384 = 1e-10 on the curve, the blended frames add (h / R)^2 / 8 per unit of width
        assert!((x - y).abs() < 2e-5, "probe component {k}: flow {x} against bend {y}");
    }
    // beyond the table the ends continue straight (the bend continues rigidly: the same thing for a circle only at the start)
    let before = crate::deform::warp_points(&flow, &[0.0, 0.0, -3.0]).unwrap();
    assert!((before[2] + 3.0).abs() < 1e-12 && before[1].abs() < 1e-12);
    // a flow table that is too short or has a non-positive step is refused, not mis-read
    let short = [header(7.0), vec![0.0, 1.0, step, 1.0], vec![0.0; 12]].concat();
    assert!(crate::deform::warp_points(&short, &probes).is_err());
}

#[test]
fn a_surface_flow_table_of_a_drum_is_the_cylindrical_map() {
    // VC-DEF-17: (x, y, w) -> ((R + w) sin(x / R), y, (R + w) cos(x / R) - R) on R = 30, tabulated every 1 mm in x and 2 mm in y
    let radius = 30.0_f64;
    let (nx, ny, hx, hy, x0, y0) = (81_usize, 17_usize, 1.0_f64, 2.0_f64, -10.0_f64, -2.0_f64);
    let mut nodes = Vec::new();
    for i in 0..nx {
        let angle = (x0 + i as f64 * hx) / radius;
        for j in 0..ny {
            nodes.extend([radius * angle.sin(), y0 + j as f64 * hy, radius * angle.cos() - radius, angle.sin(), 0.0, angle.cos()]);
        }
    }
    let header = vec![8.0, 1e-3, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0];
    let spec = [header, vec![x0, y0, hx, hy, nx as f64, ny as f64], nodes].concat();
    let probes = [0.0, 0.0, 0.0, 12.3, 4.7, 2.0, 59.9, 19.9, 1.0, 30.0, 10.0, 0.5];
    let images = crate::deform::warp_points(&spec, &probes).unwrap();
    for (k, probe) in probes.chunks(3).enumerate() {
        let angle = probe[0] / radius;
        let expected = [(radius + probe[2]) * angle.sin(), probe[1], (radius + probe[2]) * angle.cos() - radius];
        for axis in 0..3 {
            assert!(
                (images[3 * k + axis] - expected[axis]).abs() < 2e-4,
                "probe {k} axis {axis}: {} vs {}",
                images[3 * k + axis],
                expected[axis]
            );
        }
    }
    let short = [vec![8.0, 1e-3, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0], vec![0.0, 0.0, 1.0, 1.0, 2.0, 2.0]]
        .concat();
    assert!(crate::deform::warp_points(&short, &probes).is_err());
}

#[test]
fn a_fitted_field_is_the_polyharmonic_spline_of_its_centres() {
    // one centre at (1, 0, 0) with weight (0, 2, 0) and the affine part x -> x + 0.5 y: p + a0 + A p + w |p - c|^3
    let header = vec![9.0, 1e-3, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0];
    let law = vec![1.0, 1.0, 0.0, 0.0, 0.0, 2.0, 0.0, 0.1, 0.2, 0.3, 0.0, 0.5, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
    let spec = [header.clone(), law].concat();
    let images = crate::deform::warp_points(&spec, &[1.0, 0.0, 0.0, 4.0, 3.0, 0.0]).unwrap();
    // at the centre r = 0: p + a0 + A p = (1 + 0.1, 0 + 0.2, 0.3)
    assert!((images[0] - 1.1).abs() < 1e-12 && (images[1] - 0.2).abs() < 1e-12 && (images[2] - 0.3).abs() < 1e-12, "{images:?}");
    // at (4, 3, 0): r = sqrt(9 + 9) = 4.2426...; x + 0.1 + 0.5 * 3, y + 0.2 + 2 r^3, z + 0.3
    let r = 18.0_f64.sqrt();
    assert!(
        (images[3] - (4.0 + 0.1 + 1.5)).abs() < 1e-12
            && (images[4] - (3.0 + 0.2 + 2.0 * r * r * r)).abs() < 1e-12
            && (images[5] - 0.3).abs() < 1e-12,
        "{images:?}"
    );
    let empty = [header, vec![0.0, 0.0]].concat();
    assert!(crate::deform::warp_points(&empty, &[0.0, 0.0, 0.0]).is_err());
}

#[test]
fn a_full_turn_bend_of_a_body_without_two_plain_end_caps_is_refused() {
    // a rod whose end edge is rounded has no planar cap left to drop: the ring cannot be closed, and the warp must not return a coincident-ends solid
    let rod = entity("cylinder", json!({ "radius": 5, "height": 314.159265 }));
    let mut refused = None;
    for edge in 0..3 {
        let rounded = json!({ "op": "fillet", "source": rod, "edges": [edge], "size": 1.0 });
        if Evaluator::new(16).evaluate(&rounded).ok().flatten().is_none() {
            continue;
        }
        let bent = node(
            &rounded,
            json!({ "kind": "bend", "radius": 50, "symmetric": false }),
            Some(span(0.0, 314.159265, "linear")),
            1e-4,
            [0.0, 0.0, -314.159265 / 2.0],
        );
        refused = Some(refusal(&bent));
        break;
    }
    let report = refused.expect("one edge of the rod fillets");
    assert_eq!(report["code"], json!("DEF_SELF_INTERSECTION"), "{report}");
    assert_eq!(report["ring"], json!(false));
}

#[test]
fn a_feature_on_a_deformed_body_keeps_the_adaptive_mass_rule() {
    // the adaptive rule reports an error estimate, the fixed Gauss rule none; a fillet of the twisted box must not lose it
    let twisted = node(&bar(), json!({ "kind": "twist", "angleRad": 1.0 }), Some(span(0.0, 100.0, "linear")), 1e-4, [0.0, 0.0, 0.0]);
    let mut evaluator = Evaluator::new(16);
    let direct = evaluator.evaluate(&twisted).unwrap().unwrap();
    assert!(!mass_properties(&direct).unwrap().rel_error.is_nan(), "the warp itself uses the adaptive rule");
    for edge in 0..12 {
        let rounded = json!({ "op": "fillet", "source": twisted, "edges": [edge], "size": 0.5 });
        let Some(shape) = Evaluator::new(16).evaluate(&rounded).ok().flatten() else { continue };
        assert!(!mass_properties(&shape).unwrap().rel_error.is_nan(), "edge {edge}: the fillet kept the rule");
        return;
    }
    panic!("no edge of the twisted box fillets");
}

#[test]
fn a_local_push_on_a_wide_slab_refines_the_fit_only_where_it_acts() {
    // 01 DEF 17.8: the fit nodes concentrate in the push support (r 10) of a 100 mm slab; the volume stays dV = d pi r^2 / 4 of the cap
    let slab = entity("box", json!({ "size": [100, 100, 20], "position": [0, 0, 10] }));
    let push =
        json!({ "kind": "point", "center": [0, 0, 20], "direction": [0, 0, 1], "distance": 3, "radius": 10, "falloff": "smooth_c2" });
    let built = build(&node(&slab, push, None, 1e-3, [0.0; 3]));
    let points = built.report["fitPoints"].as_f64().unwrap();
    // the uniform fit of the same body needed 263294 nodes (maxError 1.1e-5)
    assert!(points < 40000.0, "fit nodes {points}");
    assert!(built.report["maxError"].as_f64().unwrap() <= 1e-3, "{}", built.report);
    let cap = 3.0 * PI * 100.0 / 4.0;
    assert!((built.volume - (200000.0 + cap)).abs() < 2e-3, "volume {}", built.volume);
}

#[test]
fn a_push_hidden_between_the_first_nodes_is_found_by_the_cell_centres() {
    // the 4 x 4 start grid of the top face has nodes 25 mm apart: a push of radius 4 centred in the middle of a cell touches no node line, only the cell middle
    let slab = entity("box", json!({ "size": [100, 100, 20], "position": [0, 0, 10] }));
    let push = json!({ "kind": "point", "center": [-37.5, -37.5, 20], "direction": [0, 0, 1], "distance": 2, "radius": 4, "falloff": "smooth_c2" });
    let built = build(&node(&slab, push, None, 1e-3, [0.0; 3]));
    assert!(built.report["maxError"].as_f64().unwrap() <= 1e-3, "{}", built.report);
    let cap = 2.0 * PI * 16.0 / 4.0;
    assert!((built.volume - (200000.0 + cap)).abs() < 1e-2 * cap, "volume {} vs {}", built.volume, 200000.0 + cap);
}

#[test]
fn two_separated_local_features_are_both_resolved_with_graded_nodes() {
    // a cubic lattice with a control point raised at two far corners of a 100 mm slab: two bumps, one volume of each; the second one lies between samples of the coarse intervals
    let slab = entity("box", json!({ "size": [100, 100, 20], "position": [0, 0, 10] }));
    let lattice = |offsets: Value| {
        json!({
            "kind": "lattice", "degrees": [8, 8, 1], "splineDegrees": [3, 3, 1],
            "box": { "min": [-50, -50, -1], "max": [50, 50, 21] }, "offsets": offsets,
        })
    };
    let one = build(&node(&slab, lattice(json!([{ "index": [1, 1, 1], "delta": [0, 0, 2] }])), None, 1e-3, [0.0; 3]));
    let two = build(&node(
        &slab,
        lattice(json!([{ "index": [1, 1, 1], "delta": [0, 0, 2] }, { "index": [7, 7, 1], "delta": [0, 0, 2] }])),
        None,
        1e-3,
        [0.0; 3],
    ));
    assert!(two.report["maxError"].as_f64().unwrap() <= 1e-3, "{}", two.report);
    let (gain_one, gain_two) = (one.volume - 200000.0, two.volume - 200000.0);
    assert!(gain_one > 1.0, "the first bump adds volume {gain_one}");
    assert!(relative(gain_two, 2.0 * gain_one) < 1e-4, "two bumps {gain_two} vs twice one {}", 2.0 * gain_one);
}

/// The faces of the exact warp of `tree`, as (surface kind, face geometry): `preserveAnalytic` asked.
fn faces_of(tree: &Value) -> (Value, Vec<(String, Value)>) {
    let mut evaluator = Evaluator::new(16);
    let shape = evaluator.evaluate(tree).expect("evaluates").expect("the warp builds");
    let report = evaluator.deform_report(tree).expect("report");
    let count = crate::queries::topology(&shape).unwrap()["faces"].as_array().unwrap().len();
    let faces = (0..count).map(|i| {
        let geometry = crate::queries::face_geometry(&shape, i as f64).unwrap();
        (geometry["surface"]["type"].as_str().unwrap_or("").to_string(), geometry)
    });
    (report, faces.collect())
}

#[test]
fn preserve_analytic_turns_the_tapered_cylinder_back_into_a_cone() {
    // VC-DEF-23: the VC-06 frustum (r 5 -> 2 over h 40) is one cone face of half angle atan(3 / 40) with two planar caps
    let pin = entity("cylinder", json!({ "radius": 5, "height": 40 }));
    let mut tapered =
        node(&pin, json!({ "kind": "taper", "scaleEnd": 0.4, "flat": false }), Some(span(0.0, 40.0, "linear")), 1e-4, [0.0, 0.0, -20.0]);
    tapered["output"]["preserveAnalytic"] = json!(true);
    let (report, faces) = faces_of(&tapered);
    assert_eq!(report["ok"], json!(true), "{report}");
    let kinds: Vec<&str> = faces.iter().map(|(kind, _)| kind.as_str()).collect();
    assert_eq!(kinds.iter().filter(|k| **k == "cone").count(), 1, "{kinds:?} {report}");
    assert_eq!(kinds.iter().filter(|k| **k == "plane").count(), 2, "{kinds:?}");
    assert_eq!(report["analyticFaces"]["cone"], json!(1));
    let cone = faces.iter().find(|(kind, _)| kind == "cone").unwrap();
    let angle = cone.1["surface"]["semiAngle"].as_f64().unwrap().to_degrees();
    assert!((angle - 4.28915332882).abs() < 1e-6, "half angle {angle}");
}

#[test]
fn preserve_analytic_keeps_a_twisted_cylinder_a_cylinder_and_leaves_the_twisted_box_sides_free_form() {
    // VC-DEF-23: a twist about the axis of a cylinder is a rotation of every circle: one cylinder face, two planar caps
    let pin = entity("cylinder", json!({ "radius": 5, "height": 40 }));
    let mut twisted = node(&pin, json!({ "kind": "twist", "angleRad": 1.2 }), Some(span(0.0, 40.0, "linear")), 1e-4, [0.0, 0.0, -20.0]);
    twisted["output"]["preserveAnalytic"] = json!(true);
    let (report, faces) = faces_of(&twisted);
    let kinds: Vec<&str> = faces.iter().map(|(kind, _)| kind.as_str()).collect();
    assert_eq!(kinds.iter().filter(|k| **k == "cylinder").count(), 1, "{kinds:?} {report}");
    assert_eq!(report["analyticFaces"]["cylinder"], json!(1));
    // the sides of a twisted box are not planes: only the caps are recognised, the report says what it looked at
    let mut bar = node(
        &entity("box", json!({ "size": [10, 10, 40], "position": [0, 0, 20] })),
        json!({ "kind": "twist", "angleRad": 1.2 }),
        Some(span(0.0, 40.0, "linear")),
        1e-4,
        [0.0; 3],
    );
    bar["output"]["preserveAnalytic"] = json!(true);
    let (report, faces) = faces_of(&bar);
    let planes = faces.iter().filter(|(kind, _)| kind == "plane").count();
    assert_eq!(planes, 2, "{report}");
    assert_eq!(report["analyticFaces"]["plane"], json!(2));
    assert_eq!(report["analyticFaces"]["tried"], json!(6));
    // the same body without the flag keeps B-spline faces only, and the volumes agree
    let plain = build(&node(
        &entity("box", json!({ "size": [10, 10, 40], "position": [0, 0, 20] })),
        json!({ "kind": "twist", "angleRad": 1.2 }),
        Some(span(0.0, 40.0, "linear")),
        1e-4,
        [0.0; 3],
    ));
    assert!(relative(report["volume"].as_f64().unwrap(), plain.volume) < 1e-6);
}

#[test]
fn preserve_analytic_does_not_erase_a_small_local_push_between_the_nodes() {
    // review of 17.11: a push of radius 1.5 and height 0.05 on a 40 mm face, centred between fit nodes, is not the source plane: the top face stays free-form (the five others are planes)
    let slab = entity("box", json!({ "size": [40, 40, 10], "position": [0, 0, 5] }));
    let push = json!({ "kind": "point", "center": [7.3, 3.1, 10], "direction": [0, 0, 1], "distance": 0.05, "radius": 1.5, "falloff": "smooth_c2" });
    let mut pushed = node(&slab, push, None, 1e-4, [0.0; 3]);
    pushed["output"]["preserveAnalytic"] = json!(true);
    let (report, faces) = faces_of(&pushed);
    let kinds: Vec<&str> = faces.iter().map(|(kind, _)| kind.as_str()).collect();
    assert_eq!(kinds.iter().filter(|k| **k == "plane").count(), 5, "{kinds:?} {report}");
    assert_eq!(kinds.iter().filter(|k| **k == "other").count(), 1, "the pushed face stays a B-spline: {kinds:?}");
    // the volume still carries the bump: the same body without the flag has the same exact volume (the top face was not flattened to the plane: that would lose the bump's volume)
    let mut evaluator = Evaluator::new(16);
    let with_flag = mass_properties(&evaluator.evaluate(&pushed).unwrap().unwrap()).unwrap().volume;
    pushed["output"]["preserveAnalytic"] = json!(false);
    let without = mass_properties(&evaluator.evaluate(&pushed).unwrap().unwrap()).unwrap().volume;
    assert!((with_flag - without).abs() < 1e-6, "{with_flag} vs {without}");
    // smooth_c2: phi(s) = (1 - s^2)^3, the bump of a push centred on the face adds d 2 pi R^2 int phi(t) t dt = d pi R^2 / 4
    let closed = 0.05 * PI * 1.5 * 1.5 / 4.0;
    assert!((without - 16000.0 - closed).abs() < 1e-5, "the bump adds {} against the closed form {closed}", without - 16000.0);
}

#[test]
fn a_push_narrower_than_the_fit_can_resolve_is_refused_by_name_not_lost() {
    // review of 17.14: a radius of 1e-9 on a 1000 mm face is below the finest grid (1 / 2^30 of its length): it used to come back as a flat face
    let slab = entity("box", json!({ "size": [1000, 1000, 10], "position": [0, 0, 5] }));
    let push = json!({ "kind": "point", "center": [123.4, 56.7, 10], "direction": [0, 0, 1], "distance": 0.5, "radius": 1e-9, "falloff": "smooth_c2" });
    let report = refusal(&node(&slab, push, None, 1e-4, [0.0; 3]));
    assert_eq!(report["code"], json!("DEF_APPROX_TOLERANCE"), "{report}");
    assert!(report["message"].as_str().unwrap().contains("below what the fit can resolve"), "{report}");
    // a radius of 1e-3 on the same face is resolvable (a few dozen nodes, 22 halvings): it builds
    let fine = json!({ "kind": "point", "center": [123.4, 56.7, 10], "direction": [0, 0, 1], "distance": 0.5, "radius": 1e-3, "falloff": "smooth_c2" });
    assert!(build(&node(&slab, fine, None, 1e-4, [0.0; 3])).report["ok"] == json!(true));
    // a radius the fit can resolve on a 200 mm face builds, and carries the bump's volume
    let small = entity("box", json!({ "size": [200, 200, 10], "position": [0, 0, 5] }));
    let wide = json!({ "kind": "point", "center": [23.4, 56.7, 10], "direction": [0, 0, 1], "distance": 0.5, "radius": 10, "falloff": "smooth_c2" });
    let built = build(&node(&small, wide, None, 1e-3, [0.0; 3]));
    assert!(built.volume > 200.0 * 200.0 * 10.0 + 10.0, "the bump adds volume: {}", built.volume);
}

/// A radius-2 push on a 1000 mm face is a LOCAL refinement: about log2(1000 / 2) halvings near the support, a few dozen nodes per direction, not the 1500 intervals a uniform grid would need.
/// And the mass properties see the bump (01 DEF 17.16): the adaptive rule used to integrate it as flat (area and volume unchanged to 1e-9), now one face per knot span.
#[test]
fn a_radius_2_push_on_a_1000_mm_face_refines_locally_and_carries_the_bump() {
    let slab = entity("box", json!({ "size": [1000, 1000, 3], "position": [0, 0, 1.5] }));
    let push = json!({ "kind": "point", "center": [123.4, 56.7, 3], "direction": [0, 0, 1], "distance": 0.5, "radius": 2, "falloff": "smooth_c2" });
    let tree = node(&slab, push, None, 1e-3, [0.0; 3]);
    let mut evaluator = Evaluator::new(16);
    let shape = evaluator.evaluate(&tree).expect("evaluates").expect("the warp builds");
    let report = evaluator.deform_report(&tree).unwrap();
    assert!(report["fitPoints"].as_f64().unwrap() < 20000.0, "{report}");
    // the top face (the plane's parameters start at the corner: u = x + 500, v = y + 500)
    let top = |dx: f64, dy: f64| {
        let evaluated = crate::queries::evaluate_face(&shape, 5.0, &[623.4 + dx, 556.7 + dy]).unwrap();
        evaluated[0]["point"][2].as_f64().unwrap()
    };
    for (dx, expected) in
        [(0.0, 0.5), (1.0, 0.5 * (1.0_f64 - 0.25).powi(3)), (1.9, 0.5 * (1.0_f64 - 0.9025).powi(3)), (2.5, 0.0), (30.0, 0.0)]
    {
        assert!((top(dx, 0.0) - 3.0 - expected).abs() < 2e-3, "height at {dx} from the centre: {} against {expected}", top(dx, 0.0) - 3.0);
    }
    // smooth_c2: z = d (1 - s^2)^3, s = r / R. Volume d pi R^2 / 4; area 2 pi int (sqrt(1 + z'^2) - 1) r dr (Simpson, 4000 steps)
    let (d, big_r) = (0.5_f64, 2.0_f64);
    let steps = 4000;
    let integrand = |r: f64| {
        let slope = 6.0 * d * r / (big_r * big_r) * (1.0 - r * r / (big_r * big_r)).powi(2);
        ((1.0 + slope * slope).sqrt() - 1.0) * r
    };
    let h = big_r / steps as f64;
    let simpson: f64 = (0..=steps)
        .map(|k| {
            integrand(k as f64 * h)
                * if k == 0 || k == steps {
                    1.0
                } else if k % 2 == 1 {
                    4.0
                } else {
                    2.0
                }
        })
        .sum::<f64>()
        * h
        / 3.0;
    let (closed_volume, closed_area) = (d * PI * big_r * big_r / 4.0, 2.0 * PI * simpson);
    let mass = mass_properties(&shape).unwrap();
    assert!(
        (mass.volume - 3.0e6 - closed_volume).abs() < 1e-3,
        "the volume gains {} against the closed form {closed_volume}",
        mass.volume - 3.0e6
    );
    assert!(
        (mass.area - (2.0e6 + 4.0 * 3000.0) - closed_area).abs() < 1e-2,
        "the area gains {} against the closed form {closed_area}",
        mass.area - 2.012e6
    );
}

#[test]
fn a_push_centred_on_an_edge_keeps_the_edge_and_the_faces_together() {
    // review of 17.14: the edge curve is refined where the push crosses it, like the faces: the edge / face gap stays within the tolerance and nothing is left to SameParameter
    let slab = entity("box", json!({ "size": [40, 40, 10], "position": [0, 0, 5] }));
    let push =
        json!({ "kind": "point", "center": [20, 3.75, 10], "direction": [0, 0, 1], "distance": 0.05, "radius": 1, "falloff": "smooth_c2" });
    let built = build(&node(&slab, push, None, 1e-3, [0.0; 3]));
    assert!(built.report["shapeTolerance"].as_f64().unwrap() <= 1e-3, "{}", built.report);
    assert!(built.report["maxError"].as_f64().unwrap() <= 1e-3, "{}", built.report);
}

/// The same narrow push as above: every volume and area the kernel reports reads the bump, not only `mass_properties` (the topology totals, the sum of the face areas, the warp's own volume).
#[test]
fn every_volume_and_area_the_kernel_reports_agrees_on_a_narrow_bump() {
    let slab = entity("box", json!({ "size": [1000, 1000, 3], "position": [0, 0, 1.5] }));
    let push = json!({ "kind": "point", "center": [123.4, 56.7, 3], "direction": [0, 0, 1], "distance": 0.5, "radius": 2, "falloff": "smooth_c2" });
    let tree = node(&slab, push, None, 1e-3, [0.0; 3]);
    let mut evaluator = Evaluator::new(16);
    let shape = evaluator.evaluate(&tree).unwrap().unwrap();
    let report = evaluator.deform_report(&tree).unwrap();
    let mass = mass_properties(&shape).unwrap();
    let topology = crate::queries::topology(&shape).unwrap();
    let summed: f64 = topology["faces"].as_array().unwrap().iter().map(|face| face["area"].as_f64().unwrap()).sum();
    assert!(relative(summed, mass.area) < 1e-9, "face areas {summed} against {}", mass.area);
    assert!(relative(topology["volume"].as_f64().unwrap(), mass.volume) < 1e-9, "{} against {}", topology["volume"], mass.volume);
    assert!(
        relative(report["volume"].as_f64().unwrap(), mass.volume) < 1e-8,
        "the warp's own volume {} against {}",
        report["volume"],
        mass.volume
    );
    assert!(mass.volume - 3.0e6 > 1.5, "and it is the slab plus the bump: {}", mass.volume - 3.0e6);
    assert!(crate::test_bridge::span_cut_count(&shape) >= 1, "the top face is cut");
}

/// The bump pushed OUT of the bottom face (the pieces of a reversed face keep their orientation): the same gain, d pi R^2 / 4.
#[test]
fn a_narrow_push_out_of_the_bottom_face_adds_the_same_volume() {
    let slab = entity("box", json!({ "size": [1000, 1000, 3], "position": [0, 0, 1.5] }));
    let push = json!({ "kind": "point", "center": [123.4, 56.7, 0], "direction": [0, 0, -1], "distance": 0.5, "radius": 2, "falloff": "smooth_c2" });
    let mut evaluator = Evaluator::new(16);
    let shape = evaluator.evaluate(&node(&slab, push, None, 1e-3, [0.0; 3])).unwrap().unwrap();
    let mass = mass_properties(&shape).unwrap();
    assert!((mass.volume - 3.0e6 - 0.5 * PI * 4.0 / 4.0).abs() < 1e-3, "the volume gains {}", mass.volume - 3.0e6);
}

/// A TRIMMED B-spline face (a hole through the slab) is not cut: its pcurves are not the sides of the parameter box, so it is integrated by the whole-face rule as before (13.16.1 limits).
#[test]
fn a_trimmed_bspline_face_is_not_cut() {
    let plate = entity("box", json!({ "size": [1000, 1000, 3], "position": [0, 0, 1.5] }));
    let pocketed = json!({ "op": "boolean", "boolean": "subtract", "a": plate, "b": entity("cylinder", json!({ "radius": 100, "height": 10, "position": [-300, -300, -2] })) });
    let push = json!({ "kind": "point", "center": [123.4, 56.7, 3], "direction": [0, 0, 1], "distance": 0.5, "radius": 2, "falloff": "smooth_c2" });
    let mut evaluator = Evaluator::new(16);
    let tree = node(&pocketed, push, None, 1e-3, [0.0; 3]);
    let shape = evaluator.evaluate(&tree).unwrap();
    let report = evaluator.deform_report(&tree).unwrap();
    let shape = shape.unwrap_or_else(|| panic!("the pocketed slab warps: {report}"));
    assert_eq!(crate::test_bridge::span_cut_count(&shape), 0, "the faces with a hole (top, bottom) are trimmed: none is cut");
}
