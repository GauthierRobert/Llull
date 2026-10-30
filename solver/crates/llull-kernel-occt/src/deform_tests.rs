//! 01 DEF M2: the exact warp (`cpp/deform.cxx`) against the closed forms and the golden vectors of `docs/design/01-body-deformation/validation`.

use crate::mass_properties;
use crate::recipe::{EvalError, Evaluator};
use serde_json::{json, Value};
use std::f64::consts::{FRAC_PI_2, PI};

fn entity(kind: &str, fields: Value) -> Value {
    let mut base = json!({ "id": "e", "kind": kind, "position": [0, 0, 0], "rotation": [0, 0, 0], "layerId": "l", "color": "#888" });
    if let (Some(target), Some(extra)) = (base.as_object_mut(), fields.as_object()) {
        target.extend(extra.clone());
    }
    json!({ "op": "solid", "entity": base })
}

/// A `deform` node; the frame is `origin`, axis +z, reference +x unless the test needs another.
fn node(source: &Value, law: Value, region: Option<Value>, tolerance: f64, origin: [f64; 3]) -> Value {
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

fn span(start: f64, end: f64, falloff: &str) -> Value {
    json!({ "start": start, "end": end, "falloff": falloff, "beyond": "rigid" })
}

struct Built {
    volume: f64,
    area: f64,
    report: Value,
}

fn build(tree: &Value) -> Built {
    let mut evaluator = Evaluator::new(16);
    let shape = evaluator.evaluate(tree).expect("evaluates").expect("the warp builds");
    let report = evaluator.deform_report(tree).expect("report");
    assert_eq!(report["ok"], json!(true), "{report}");
    assert!(crate::analyze(&shape).unwrap().valid, "the warped shape is a valid B-rep: {report}");
    let mass = mass_properties(&shape).unwrap();
    Built { volume: mass.volume, area: mass.area, report }
}

fn refusal(tree: &Value) -> Value {
    let mut evaluator = Evaluator::new(16);
    assert!(evaluator.evaluate(tree).expect("evaluates").is_none(), "the warp is refused");
    evaluator.deform_report(tree).expect("report")
}

fn relative(measured: f64, expected: f64) -> f64 {
    ((measured - expected) / expected).abs()
}

/// 10 x 10 x 100 box on z in [0, 100]; frame origin on its middle.
fn bar() -> Value {
    entity("box", json!({ "size": [10, 10, 100], "position": [0, 0, 50] }))
}

#[test]
fn the_law_library_matches_the_golden_vectors_of_the_pack() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../docs/design/01-body-deformation/validation/data/point_vectors.json");
    let vectors: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("pack data")).unwrap();
    let header = |kind: f64, params: &Value, region: (f64, f64, f64)| {
        // kind, tolerance, origin, axis, reference, region start / end / falloff, preserveAnalytic, reserved
        let mut spec = vec![kind, 1e-3, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, region.0, region.1, region.2, 0.0, 0.0];
        let _ = params;
        spec.shrink_to_fit();
        spec
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
            "twist" | "twist_smooth" => [header(1.0, params, region), vec![number(params, "angleRad")]].concat(),
            "taper" | "taper_flat" => {
                [header(2.0, params, region), vec![number(params, "scaleEnd"), if name == "taper_flat" { 1.0 } else { 0.0 }]].concat()
            }
            "bend" => [header(4.0, params, region), vec![number(params, "radius"), 0.0]].concat(),
            "stretch" => [header(3.0, params, (region.0, region.1, 0.0)), vec![number(params, "factor")]].concat(),
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
            "ffd" => {
                let take = |key: &str| params[key].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect::<Vec<f64>>();
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
                [header(5.0, params, region), min, max, degrees, offsets].concat()
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
        for (k, point) in law["points"].as_array().unwrap().iter().enumerate() {
            // the pack's ffd vectors hold the identity outside the lattice box (TECHNICAL_SPEC §5.3), so every point is checked
            for axis in 0..3 {
                let expected = point["out"][axis].as_f64().unwrap();
                assert!(
                    (images[3 * k + axis] - expected).abs() < 1e-9,
                    "{name} point {k} axis {axis}: {} vs {expected}",
                    images[3 * k + axis]
                );
            }
        }
        checked += 1;
    }
    assert_eq!(checked, 9, "every law of the pack except the flow onto a cylinder (the flow along a curve is tested against the bend)");
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
    // header: kind, tolerance, origin, axis, reference, region start / end / falloff, preserveAnalytic, reserved
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
