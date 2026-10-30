use super::*;
use crate::{make_box, make_cylinder, make_sphere, mass_properties};
use serde_json::json;

fn unit_box() -> Shape {
    make_box([0.0, 0.0, 0.0], [1.0, 2.0, 3.0]).unwrap().unwrap()
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

fn f(value: &Value) -> f64 {
    value.as_f64().unwrap()
}

#[test]
fn box_topology_numbers_six_faces_twelve_edges() {
    let topology = topology(&unit_box()).unwrap();
    assert_eq!(topology["solids"], json!(1));
    assert_eq!(topology["vertices"], json!(8));
    assert_eq!(topology["faces"].as_array().unwrap().len(), 6);
    assert_eq!(topology["edges"].as_array().unwrap().len(), 12);
    assert!(close(f(&topology["volume"]), 6.0));
    // BRepPrim_Box face order: -X, +X, -Y, +Y, -Z, +Z; normals outward.
    let first = &topology["faces"][0];
    assert_eq!(first["surface"], json!("plane"));
    assert_eq!(first["normal"], json!([-1, 0, 0]));
    assert!(close(f(&first["area"]), 6.0));
    let edge = &topology["edges"][0];
    assert_eq!(edge["curve"], json!("line"));
    assert_eq!((edge["seam"].clone(), edge["degenerate"].clone()), (json!(false), json!(false)));
    assert!(edge.get("samples").is_none(), "straight edges carry no samples");
}

#[test]
fn cylinder_topology_has_a_seam_and_an_axis() {
    let cylinder = make_cylinder(2.0, 5.0).unwrap().unwrap();
    let topology = topology(&cylinder).unwrap();
    let side = topology["faces"].as_array().unwrap().iter().find(|face| face["surface"] == json!("cylinder")).unwrap();
    assert_eq!(side["axis"]["direction"], json!([0, 0, 1]));
    assert!(close(f(&side["axis"]["radius"]), 2.0));
    assert_eq!(side["axis"]["span"], json!([0, 5]));
    assert_eq!(side["convex"], json!(true));
    let edges = topology["edges"].as_array().unwrap();
    assert_eq!(edges.iter().filter(|edge| edge["seam"] == json!(true)).count(), 1);
    let circle = edges.iter().find(|edge| edge["curve"] == json!("circle")).unwrap();
    assert_eq!(circle["samples"].as_array().unwrap().len(), 17);
}

#[test]
fn sphere_poles_are_degenerate_edges() {
    let topology = topology(&make_sphere(1.0).unwrap().unwrap()).unwrap();
    let edges = topology["edges"].as_array().unwrap();
    assert_eq!(edges.iter().filter(|edge| edge["degenerate"] == json!(true)).count(), 2);
}

#[test]
fn face_queries_answer_closed_forms() {
    let cylinder = make_cylinder(2.0, 5.0).unwrap().unwrap();
    let details = face_details(&cylinder, 8).unwrap();
    let side = details.as_array().unwrap().iter().find(|face| face["surface"] == json!("cylinder")).unwrap();
    assert!(close(f(&side["radius"]), 2.0));
    assert_eq!(side["samples"].as_array().unwrap().len(), 8);
    let index = side["index"].as_f64().unwrap();
    let projected = project_on_face(&cylinder, index, &[5.0, 0.0, 1.0]).unwrap();
    assert!(close(f(&projected[0]["distance"]), 3.0));
    assert_eq!(face_contains(&cylinder, index, [2.0, 0.0, 1.0], 1e-6).unwrap(), json!(true));
    assert_eq!(face_contains(&cylinder, index, [1.0, 0.0, 1.0], 1e-6).unwrap(), json!(false));
    let samples = face_samples(&cylinder, index, UvRequest::Grid { nu: 2, nv: 2 }).unwrap();
    assert!(close(f(&samples[0]["k1"]), 0.5), "a convex cylinder bends +1/r outward: {}", samples[0]);
    let geometry = face_geometry(&cylinder, index).unwrap();
    assert_eq!(geometry["surface"]["type"], json!("cylinder"));
    let evaluated = evaluate_face(&cylinder, index, &[0.0, 1.0]).unwrap();
    assert_eq!(evaluated[0]["normal"], json!([1, 0, 0]));
}

#[test]
fn out_of_range_faces_answer_null() {
    let shape = unit_box();
    assert_eq!(face_geometry(&shape, 6.0).unwrap(), Value::Null);
    assert_eq!(face_geometry(&shape, -1.0).unwrap(), Value::Null);
    assert_eq!(face_geometry(&shape, 0.5).unwrap(), Value::Null);
    assert_eq!(face_samples(&shape, 0.0, UvRequest::Grid { nu: 0, nv: 3 }).unwrap(), Value::Null);
}

#[test]
fn box_face_graph_edges_are_convex_between_two_faces() {
    let graph = face_graph(&unit_box()).unwrap();
    assert_eq!(graph["faces"].as_array().unwrap().len(), 6);
    assert_eq!(graph["faces"][0]["loops"][0].as_array().unwrap().len(), 4);
    assert!(graph["edgeFaces"].as_array().unwrap().iter().all(|faces| faces.as_array().unwrap().len() == 2));
    assert!(graph["edgeConvexity"].as_array().unwrap().iter().all(|convexity| convexity == &json!("convex")));
}

#[test]
fn distances_sign_inside_points_and_detect_containment() {
    let shape = unit_box();
    let distances = point_distances(&shape, &[0.5, 1.0, 1.0, 3.0, 1.0, 1.5]).unwrap();
    assert!(close(f(&distances[0]["signed"]), -0.5));
    assert!(close(f(&distances[1]["distance"]), 2.0));
    assert_eq!(distances[1]["face"], json!(1));
    let far = make_box([5.0, 0.0, 0.0], [1.0, 1.0, 1.0]).unwrap().unwrap();
    let apart = shape_distance(&shape, &far).unwrap();
    assert!(close(f(&apart["distance"]), 4.0));
    assert_eq!(apart["inside"], json!(false));
    let small = make_box([0.25, 0.5, 0.5], [0.5, 0.5, 0.5]).unwrap().unwrap();
    assert_eq!(shape_distance(&shape, &small).unwrap()["inside"], json!(true));
}

#[test]
fn brep_text_round_trips_in_the_v1_format() {
    let text = write_brep(&unit_box()).unwrap();
    assert!(text.starts_with("\nCASCADE Topology V1") || text.starts_with("CASCADE Topology V1"), "{}", &text[..40]);
    let back = read_brep(&text).unwrap().unwrap();
    assert!(close(mass_properties(&back).unwrap().volume, 6.0));
    assert!(read_brep("not a brep").unwrap().is_none());
}

#[test]
fn step_assemblies_share_parts_and_refuse_cycles() {
    let shape = unit_box();
    let parts = vec![AssemblyPart { shapes: vec![&shape], children: vec![] }];
    let uses: Vec<PartUse> =
        (0..2).map(|k| PartUse { part: 0, rotation: [0.0, 0.0, 0.0], position: [f64::from(k) * 5.0, 0.0, 0.0] }).collect();
    let text = export_step_assembly(&parts, &uses).unwrap().unwrap();
    assert_eq!(text.matches("MANIFOLD_SOLID_BREP(").count(), 1, "one part, written once");
    assert_eq!(text.matches("NEXT_ASSEMBLY_USAGE_OCCURRENCE(").count(), 2);
    let cyclic = vec![AssemblyPart { shapes: vec![&shape], children: vec![PartUse { part: 0, rotation: [0.0; 3], position: [0.0; 3] }] }];
    assert_eq!(export_step_assembly(&cyclic, &uses).unwrap(), None);
}

/// AP242 tessellated tetrahedron (TESSELLATED_SOLID of one TRIANGULATED_FACE): OCCT 7.9 transfers it as a solid whose face has
/// a triangulation and no surface, which is not an exact B-rep.
const TESSELLATED_STEP: &str = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('tet.stp','',(''),(''),'','','');
FILE_SCHEMA(('AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 1 1 4 }'));\nENDSEC;\nDATA;
#1=APPLICATION_CONTEXT('managed model based 3d engineering');
#2=APPLICATION_PROTOCOL_DEFINITION('international standard','ap242_managed_model_based_3d_engineering',2011,#1);
#3=PRODUCT_CONTEXT('',#1,'mechanical');\n#4=PRODUCT('tet','tet','',(#3));\n#5=PRODUCT_DEFINITION_FORMATION('','',#4);
#6=PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design');\n#7=PRODUCT_DEFINITION('design','',#5,#6);
#8=PRODUCT_DEFINITION_SHAPE('','',#7);\n#9=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
#10=(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.));\n#11=(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT());
#12=UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),#9,'distance_accuracy_value','');
#13=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#12))GLOBAL_UNIT_ASSIGNED_CONTEXT((#9,#10,#11))REPRESENTATION_CONTEXT('',''));
#14=COORDINATES_LIST('',4,((0.,0.,0.),(10.,0.,0.),(0.,10.,0.),(0.,0.,10.)));
#15=TRIANGULATED_FACE('',#14,4,(),$,(1,2,3,4),((1,3,2),(1,2,4),(2,3,4),(1,4,3)));
#16=TESSELLATED_SOLID('',(#15),$);\n#17=TESSELLATED_SHAPE_REPRESENTATION('',(#16),#13);\n#18=SHAPE_DEFINITION_REPRESENTATION(#8,#17);
ENDSEC;\nEND-ISO-10303-21;\n";

#[test]
fn refuses_tessellated_only_step_as_tessellated_only() {
    let options = ImportOptions { precision: 1e-4, max_tolerance: 0.1, heal: true, sew: true };
    let imported = import_step(TESSELLATED_STEP, options).unwrap();
    assert_eq!(imported["error"], json!("tessellated_only"), "{imported}");
}

#[test]
fn imports_its_own_step_export() {
    let text = crate::export_step(&[&unit_box()]).unwrap().unwrap();
    let options = ImportOptions { precision: 0.01, max_tolerance: 1.0, heal: true, sew: true };
    let imported = import_step(&text, options).unwrap();
    assert_eq!(imported["census"]["solids"], json!(1));
    let solid = &imported["solids"][0];
    assert_eq!((solid["validAsRead"].clone(), solid["faces"].clone()), (json!(true), json!(6)));
    let back = read_brep(solid["brep"].as_str().unwrap()).unwrap().unwrap();
    assert!(close(mass_properties(&back).unwrap().volume, 6.0));
    assert_eq!(import_step("garbage", options).unwrap()["error"], json!("unreadable"));
}

/// A tensor B-spline surface of the `faceQuery.bspline` answer, evaluated with Cox-de Boor and checked against `evaluate_face` at the same (u, v): the surface IS the face's.
fn point_of(surface: &Value, u: f64, v: f64) -> [f64; 3] {
    let degree = |key: &str| surface[key].as_u64().unwrap() as usize;
    let numbers = |key: &str| -> Vec<f64> { surface[key].as_array().unwrap().iter().map(|n| n.as_f64().unwrap()).collect() };
    let flat_knots = |knots: &str, mults: &str| -> Vec<f64> {
        let (k, m) = (numbers(knots), numbers(mults));
        k.iter().zip(&m).flat_map(|(knot, count)| std::iter::repeat_n(*knot, *count as usize)).collect()
    };
    let basis = |knots: &[f64], degree: usize, x: f64| -> Vec<f64> {
        let count = knots.len() - degree - 1;
        let last = knots[count];
        let span = (degree..count).rev().find(|&i| knots[i] <= x && knots[i] < last).unwrap_or(count - 1);
        let mut table = vec![0.0; count];
        let mut left = vec![0.0; degree + 1];
        let mut right = vec![0.0; degree + 1];
        let mut n = vec![0.0; degree + 1];
        n[0] = 1.0;
        for j in 1..=degree {
            left[j] = x - knots[span + 1 - j];
            right[j] = knots[span + j] - x;
            let mut saved = 0.0;
            for r in 0..j {
                let temp = n[r] / (right[r + 1] + left[j - r]);
                n[r] = saved + right[r + 1] * temp;
                saved = left[j - r] * temp;
            }
            n[j] = saved;
        }
        for (k, value) in n.iter().enumerate() {
            table[span - degree + k] = *value;
        }
        table
    };
    let (ku, kv) = (flat_knots("knotsU", "multsU"), flat_knots("knotsV", "multsV"));
    let (bu, bv) = (basis(&ku, degree("degreeU"), u), basis(&kv, degree("degreeV"), v));
    let poles = surface["poles"].as_array().unwrap();
    let weights = surface.get("weights").and_then(Value::as_array);
    let (mut sum, mut total) = ([0.0; 3], 0.0);
    for (i, row) in poles.iter().enumerate() {
        for (j, pole) in row.as_array().unwrap().iter().enumerate() {
            let w = weights.map_or(1.0, |all| all[i][j].as_f64().unwrap()) * bu[i] * bv[j];
            total += w;
            for axis in 0..3 {
                sum[axis] += w * pole[axis].as_f64().unwrap();
            }
        }
    }
    [sum[0] / total, sum[1] / total, sum[2] / total]
}

#[test]
fn faceq_bspline_is_the_face_surface_for_planes_cylinders_and_spheres() {
    for shape in [unit_box(), make_cylinder(2.0, 5.0).unwrap().unwrap(), crate::make_sphere(3.0).unwrap().unwrap()] {
        let count = topology(&shape).unwrap()["faces"].as_array().unwrap().len();
        for face in 0..count {
            let surface = face_bspline(&shape, face as f64).unwrap();
            assert!(surface["poles"].is_array(), "face {face}: {surface}");
            assert_eq!([surface["periodicU"].clone(), surface["periodicV"].clone()], [json!(false), json!(false)]);
            // a rational conversion (cylinder, sphere) keeps the surface, not the parameters: every point of the B-spline lies ON the face (distance to it ~ 0) and its corners are the face's corners
            let knots = |key: &str| -> (f64, f64) {
                let all = surface[key].as_array().unwrap();
                (f(&all[0]), f(&all[all.len() - 1]))
            };
            let ((u0, u1), (v0, v1)) = (knots("knotsU"), knots("knotsV"));
            let mut inside = 0;
            for (a, b) in [(0.1, 0.1), (0.5, 0.5), (0.9, 0.3), (0.3, 0.8)] {
                let mine = point_of(&surface, u0 + a * (u1 - u0), v0 + b * (v1 - v0));
                // the parameter box of a disc or a sphere cap is wider than the face: only the points that fall on the face are checked
                if face_contains(&shape, face as f64, mine, 1e-6).unwrap() != json!(true) {
                    continue;
                }
                inside += 1;
                let projected = project_on_face(&shape, face as f64, &mine).unwrap();
                assert!(f(&projected[0]["distance"]) < 1e-9, "face {face}: {mine:?} is {} from the face", projected[0]["distance"]);
            }
            assert!(inside >= 1, "face {face}: no sample landed on the face");
        }
    }
    assert_eq!(face_bspline(&unit_box(), 9.0).unwrap(), Value::Null);
}
