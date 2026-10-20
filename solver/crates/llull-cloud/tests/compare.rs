//! VC-SCN-40 (C2M-A point-to-triangle), VC-SCN-41 (DEV-A analytic deviation and pipe axis offset), VC-SCN-42 (64-segment tessellation
//! within its sagitta bound), VC-SCN-43 (CLH-A hard / clearance / clear), noise and own-surface exclusion, thread-count determinism.

mod common;

use common::{csv, json, vec3};
use llull_cloud::compare::{clash, deviation, ClashSettings, DeviationSettings};
use llull_cloud::distance::{Entity, EntitySpec, PipeAxis, Primitive};

fn entity(id: &str, primitives: Vec<Primitive>, pipe: Option<PipeAxis>) -> Entity {
    Entity::prepare(&EntitySpec { id: id.into(), primitives, pipe })
}

#[test]
fn vc_scn_40_point_to_triangle_distances_are_exact() {
    let case = &json("synthetic_truth.json")["cases"]["C2M-A"];
    let vertices: Vec<[f64; 3]> = case["mesh"]["positions"].as_array().unwrap().iter().map(vec3).collect();
    let mut flat = Vec::new();
    for t in case["mesh"]["triangles"].as_array().unwrap() {
        for i in t.as_array().unwrap() {
            flat.extend(vertices[i.as_u64().unwrap() as usize]);
        }
    }
    let square = entity("square", vec![Primitive::Mesh { triangles: flat }], None);
    for (p, expected) in case["points_m"].as_array().unwrap().iter().zip(case["expectedUnsignedDistance_m"].as_array().unwrap()) {
        let d = square.distance(&vec3(p)).abs();
        assert!((d - expected.as_f64().unwrap()).abs() <= 1e-12, "{p}: {d} vs {expected}");
    }
}

fn dev_a() -> (Vec<[f64; 3]>, PipeAxis) {
    let case = &json("synthetic_truth.json")["cases"]["DEV-A"];
    let design = &case["design"];
    (
        csv("synthetic/clh-a.csv"),
        PipeAxis { start: vec3(&design["start"]), end: vec3(&design["end"]), radius: design["radius_m"].as_f64().unwrap() },
    )
}

#[test]
fn vc_scn_41_analytic_deviation_of_the_scanned_dn200_run() {
    let expected = &json("synthetic_truth.json")["cases"]["DEV-A"]["expected"];
    let (points, design) = dev_a();
    let pipe = entity("pipe", vec![Primitive::Cylinder { start: design.start, end: design.end, radius: design.radius }], Some(design));
    let settings = DeviationSettings { max_distance: 0.1, threshold: 0.010, signed: true, bins: 20 };
    let stats = &deviation(&points, std::slice::from_ref(&pipe), &settings)[0];
    assert_eq!(stats.points_used, points.len() as u64);
    assert!((stats.max.unwrap() - expected["signedDistanceMax_m"].as_f64().unwrap()).abs() <= 1e-6, "max {:?}", stats.max);
    assert!((stats.min.unwrap() - expected["signedDistanceMin_m"].as_f64().unwrap()).abs() <= 1e-6, "min {:?}", stats.min);
    assert!((stats.rms.unwrap() - expected["rmsDistance_m"].as_f64().unwrap()).abs() <= 1e-6, "rms {:?}", stats.rms);
    assert_eq!(stats.fraction_beyond_threshold.unwrap(), expected["pointsBeyond10mm_fraction"].as_f64().unwrap());
    assert_eq!(stats.histogram.iter().sum::<u64>(), points.len() as u64);
    let refit = stats.pipe.as_ref().unwrap();
    assert!((refit.fitted_axis_offset - expected["fittedAxisOffset_m"].as_f64().unwrap()).abs() <= 1e-5, "{refit:?}");
    assert!(refit.offset_vector[1] > 0.0 && refit.radius_delta.abs() < 1e-5);
    let one = rayon::ThreadPoolBuilder::new()
        .num_threads(1)
        .build()
        .unwrap()
        .install(|| deviation(&points, std::slice::from_ref(&pipe), &settings));
    assert_eq!(one[0].rms.unwrap().to_bits(), stats.rms.unwrap().to_bits(), "bit-identical for any thread count");
    let unsigned = deviation(&points, std::slice::from_ref(&pipe), &DeviationSettings { signed: false, ..settings });
    assert!(unsigned[0].min.unwrap() >= 0.0);
}

/// An open tube of `segments` facets (vertices on the circle) around the DEV-A design axis.
fn tube(design: &PipeAxis, segments: usize) -> Vec<f64> {
    let ring = |x: f64, k: usize| -> [f64; 3] {
        let t = std::f64::consts::TAU * k as f64 / segments as f64;
        [x, design.start[1] + design.radius * libm::cos(t), design.start[2] + design.radius * libm::sin(t)]
    };
    let mut flat = Vec::new();
    for k in 0..segments {
        let (a, b, c, d) = (ring(0.0, k), ring(0.0, k + 1), ring(2.0, k + 1), ring(2.0, k));
        // Counter-clockwise seen from outside: (b − a) × (c − a) points away from the axis.
        for v in [a, b, c, a, c, d] {
            flat.extend(v);
        }
    }
    flat
}

#[test]
fn vc_scn_42_a_64_segment_tessellation_stays_within_its_sagitta() {
    let (points, design) = dev_a();
    let bound = json("synthetic_truth.json")["cases"]["DEV-A"]["tolerance"]["meshSagitta_m_at_64_segments"].as_f64().unwrap();
    assert!((design.radius * (1.0 - libm::cos(std::f64::consts::PI / 64.0)) - bound).abs() < 1e-15);
    let exact = entity("exact", vec![Primitive::Cylinder { start: design.start, end: design.end, radius: design.radius }], None);
    let mesh = entity("mesh", vec![Primitive::Mesh { triangles: tube(&design, 64) }], None);
    let worst = points.iter().map(|p| (mesh.distance(p) - exact.distance(p)).abs()).fold(0.0, f64::max);
    assert!(worst <= bound + 1e-12, "worst {worst} vs bound {bound}");
}

#[test]
fn vc_scn_43_new_lines_against_the_scanned_run() {
    let case = &json("synthetic_truth.json")["cases"]["CLH-A"];
    let points = csv("synthetic/clh-a.csv");
    let designs: Vec<&serde_json::Value> = case["designs"].as_array().unwrap().iter().collect();
    let entities: Vec<Entity> = designs
        .iter()
        .enumerate()
        .map(|(i, d)| {
            let off = vec3(&d["designAxisOffset_m"]);
            entity(
                &format!("new-{i}"),
                vec![Primitive::Cylinder {
                    start: off,
                    end: [off[0] + 2.0, off[1], off[2]],
                    radius: d["designRadius_m"].as_f64().unwrap(),
                }],
                None,
            )
        })
        .collect();
    let settings = ClashSettings { clearance: 0.075, min_points: 10, search_distance: 1.0 };
    let (results, spacing) = clash(&points, &entities, &[None, None, None], &settings);
    assert!(spacing > 0.0);
    for (result, design) in results.iter().zip(&designs) {
        assert_eq!(result.status, design["status"].as_str().unwrap(), "{}", result.id);
        let gap = result.min_gap.unwrap();
        assert!((gap - design["minGap_m"].as_f64().unwrap()).abs() <= design["tolerance_m"].as_f64().unwrap(), "{}: gap {gap}", result.id);
    }
    assert!(results[0].clusters.iter().any(|c| c.status == "hard" && c.points >= 10));
}

#[test]
fn clash_ignores_noise_clusters_and_the_entity_own_surface() {
    let points = csv("synthetic/clh-a.csv");
    let scanned = entity("as-built", vec![Primitive::Cylinder { start: [0.0; 3], end: [2.0, 0.0, 0.0], radius: 0.10955 }], None);
    let settings = ClashSettings { clearance: 0.05, min_points: 10, search_distance: 0.5 };
    let (own, _) = clash(&points, std::slice::from_ref(&scanned), &[Some(0.002)], &settings);
    assert_eq!(own[0].status, "clear");
    assert_eq!(own[0].excluded_points, points.len());
    let (unexcluded, _) = clash(&points, std::slice::from_ref(&scanned), &[None], &settings);
    assert_ne!(unexcluded[0].status, "clear");
    let mut sparse: Vec<[f64; 3]> = vec![[5.0, 5.0, 5.0], [5.001, 5.0, 5.0], [9.0, 9.0, 9.0], [9.0, 9.5, 9.0]];
    sparse.extend((0..4).map(|i| [20.0 + f64::from(i), 0.0, 0.0]));
    let ball = entity("ball", vec![Primitive::Sphere { centre: [5.0, 5.0, 5.0], radius: 0.2 }], None);
    let (noise, _) =
        clash(&sparse, std::slice::from_ref(&ball), &[None], &ClashSettings { clearance: 0.1, min_points: 10, search_distance: 1.0 });
    assert_eq!(noise[0].status, "clear");
    assert_eq!(noise[0].noise_points, 2);
}
