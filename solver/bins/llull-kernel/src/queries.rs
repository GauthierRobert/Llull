//! Query and exchange ops of the session (`KernelOps` names): `topology`, `distance`, every `faceQuery.<method>`,
//! `exportStepAssembly`, `importShapes` and `loadBlob`. Arguments arrive as the worker protocol sends them (handles rewritten by
//! `server/src/native/kernelProtocol.ts`); results have the `GeometryKernel` shapes (`@core/geometry/kernel`).
//!
//! `faceQuery.tessellateFace` and `bspline` answer null (the retired opencascade.js build lacked the bindings, and no caller reads them yet).

use crate::session::{Reply, Session, BAD_REQUEST, OCC_FAILURE};
use llull_kernel_occt::queries::{self, AssemblyPart, ImportOptions, PartUse, UvRequest};
use llull_kernel_occt::xde;
use llull_kernel_occt::Shape;
use serde_json::Value;
use std::rc::Rc;

/// Ops this module answers.
pub const QUERY_OPS: [&str; 18] = [
    "topology",
    "distance",
    "exportStepAssembly",
    "importShapes",
    "loadBlob",
    "faceQuery.faceDetails",
    "faceQuery.faceContains",
    "faceQuery.faceGraph",
    "faceQuery.faceGeometry",
    "faceQuery.projectOnFace",
    "faceQuery.evaluateFace",
    "faceQuery.tessellateFace",
    "faceQuery.faceSamples",
    "faceQuery.edgeSamples",
    "faceQuery.edgeContinuity",
    "faceQuery.projectCurves",
    "faceQuery.distance",
    "faceQuery.bspline",
];

/// `KernelInfo.capabilities` these ops add.
pub const QUERY_CAPABILITIES: [&str; 6] = ["topology", "distance", "faceQuery", "importShapes", "exportStepAssembly", "brepBlobs"];

/// Face-query port defaults (occtFaceQuery.ts).
const DEFAULT_SAMPLES: f64 = 64.0;
const DEFAULT_CONTAINS_TOLERANCE: f64 = 1e-6;

fn bad(message: impl std::fmt::Display) -> Reply {
    Reply::fail(BAD_REQUEST, message)
}

fn arg(args: &[Value], index: usize) -> &Value {
    args.get(index).unwrap_or(&Value::Null)
}

fn vec3(value: &Value) -> Option<[f64; 3]> {
    match value.as_array()?.as_slice() {
        [x, y, z] => Some([x.as_f64()?, y.as_f64()?, z.as_f64()?]),
        _ => None,
    }
}

/// `[[a, b, …], …]` with `width` numbers per entry, flattened.
fn flat(value: &Value, width: usize) -> Option<Vec<f64>> {
    let mut out = Vec::new();
    for entry in value.as_array()? {
        let items = entry.as_array()?;
        if items.len() != width {
            return None;
        }
        for item in items {
            out.push(item.as_f64()?);
        }
    }
    Some(out)
}

/// The face index argument; a non-number answers like an out-of-range index (null).
fn face_index(value: &Value) -> f64 {
    value.as_f64().unwrap_or(-1.0)
}

fn answered(result: Result<Value, String>) -> Reply {
    match result {
        Ok(value) => Reply::ok(value),
        Err(error) => Reply::fail(OCC_FAILURE, error),
    }
}

/// Answers `op` when it is a query op, else `None`.
pub fn dispatch(session: &mut Session, op: &str, args: &[Value]) -> Option<Reply> {
    let first = arg(args, 0);
    let reply = match op {
        "topology" => session.with_shape(first, queries::topology),
        "distance" => distance(session, args),
        "exportStepAssembly" => export_assembly(session, first),
        "importShapes" => import_shapes(args),
        "loadBlob" => load_blob(session, args),
        _ => match op.strip_prefix("faceQuery.") {
            Some(method) if QUERY_OPS.contains(&op) => face_query(session, method, args),
            _ => return None,
        },
    };
    Some(reply)
}

fn face_query(session: &mut Session, method: &str, args: &[Value]) -> Reply {
    let (handle, face) = (arg(args, 0), face_index(arg(args, 1)));
    match method {
        "faceDetails" => {
            let samples = arg(args, 1).get("samples").and_then(Value::as_f64).unwrap_or(DEFAULT_SAMPLES).floor().max(0.0);
            session.with_shape(handle, |shape| queries::face_details(shape, samples.min(f64::from(i32::MAX)) as i32))
        }
        "faceContains" => {
            let Some(point) = vec3(arg(args, 2)) else { return bad("faceContains expects a [x, y, z] point") };
            let tolerance = arg(args, 3).as_f64().unwrap_or(DEFAULT_CONTAINS_TOLERANCE);
            session.with_shape(handle, |shape| queries::face_contains(shape, face, point, tolerance))
        }
        "faceGraph" => session.with_shape(handle, queries::face_graph),
        "faceGeometry" => session.with_shape(handle, |shape| queries::face_geometry(shape, face)),
        "projectOnFace" => {
            let Some(points) = flat(arg(args, 2), 3) else { return bad("projectOnFace expects [[x, y, z], …]") };
            session.with_shape(handle, |shape| queries::project_on_face(shape, face, &points))
        }
        "evaluateFace" => {
            let Some(uv) = flat(arg(args, 2), 2) else { return bad("evaluateFace expects [[u, v], …]") };
            session.with_shape(handle, |shape| queries::evaluate_face(shape, face, &uv))
        }
        "edgeSamples" | "edgeContinuity" => {
            let (edge, count) = (arg(args, 1).as_f64().unwrap_or(-1.0), arg(args, 2).as_f64().unwrap_or(-1.0));
            session.with_shape(handle, |shape| {
                if method == "edgeSamples" {
                    queries::edge_samples(shape, edge, count)
                } else {
                    queries::edge_continuity(shape, edge, count)
                }
            })
        }
        "projectCurves" => project_curves(session, handle, arg(args, 1)),
        "faceSamples" => face_samples(session, handle, face, arg(args, 2)),
        "distance" => {
            let Some(points) = flat(arg(args, 1), 3) else { return bad("faceQuery.distance expects [[x, y, z], …]") };
            session.with_shape(handle, |shape| queries::point_distances(shape, &points))
        }
        _ => Reply::ok(Value::Null),
    }
}

/// One curve of a `projectCurves` request (degree, poles, optional weights, knots, multiplicities) in the facade's flat layout, or None when malformed.
fn encode_curve(curve: &Value) -> Option<Vec<f64>> {
    let poles = flat(curve.get("poles")?, 3)?;
    let weights = curve
        .get("weights")
        .filter(|value| !value.is_null())
        .map(|value| value.as_array()?.iter().map(Value::as_f64).collect::<Option<Vec<f64>>>());
    let knots: Vec<f64> = curve.get("knots")?.as_array()?.iter().map(Value::as_f64).collect::<Option<_>>()?;
    let multiplicities: Vec<f64> = curve.get("multiplicities")?.as_array()?.iter().map(Value::as_f64).collect::<Option<_>>()?;
    let weights = match weights {
        Some(Some(list)) => Some(list),
        Some(None) => return None,
        None => None,
    };
    let mut out =
        vec![curve.get("degree")?.as_f64()?, (poles.len() / 3) as f64, knots.len() as f64, if weights.is_some() { 1.0 } else { 0.0 }];
    out.extend(poles);
    out.extend(weights.unwrap_or_default());
    out.extend(knots);
    out.extend(multiplicities);
    Some(out)
}

/// `projectCurves(shape, { faces, curves, direction | closest: { maxDistance }, sampleStep, tolerance })`.
fn project_curves(session: &mut Session, handle: &Value, request: &Value) -> Reply {
    let faces: Option<Vec<u32>> = request
        .get("faces")
        .and_then(Value::as_array)
        .and_then(|list| list.iter().map(|face| face.as_u64().and_then(|index| u32::try_from(index).ok())).collect());
    let curves: Option<Vec<Vec<f64>>> =
        request.get("curves").and_then(Value::as_array).and_then(|list| list.iter().map(encode_curve).collect());
    let (Some(faces), Some(curves)) = (faces, curves) else { return bad("projectCurves expects { faces: [index], curves: [curve] }") };
    let lengths: Option<Vec<u32>> = curves.iter().map(|curve| u32::try_from(curve.len()).ok()).collect();
    let Some(lengths) = lengths else { return bad("projectCurves: a curve is too long") };
    let closest = request.get("closest").and_then(|value| value.get("maxDistance")).and_then(Value::as_f64);
    let direction = request.get("direction").and_then(vec3);
    let (mode, direction, max_distance) = match (closest, direction) {
        (Some(distance), _) if distance > 0.0 => (1, [0.0, 0.0, 1.0], distance),
        (_, Some(direction)) => (0, direction, 0.0),
        _ => return bad("projectCurves needs a direction or closest.maxDistance > 0"),
    };
    let (Some(step), Some(tolerance)) = (
        request.get("sampleStep").and_then(Value::as_f64).filter(|value| *value > 0.0),
        request.get("tolerance").and_then(Value::as_f64).filter(|value| *value > 0.0),
    ) else {
        return bad("projectCurves needs sampleStep > 0 and tolerance > 0");
    };
    session.with_shape(handle, |shape| {
        queries::project_curves(shape, &faces, &curves.concat(), &lengths, mode, direction, max_distance, step, tolerance)
    })
}

fn face_samples(session: &mut Session, handle: &Value, face: f64, request: &Value) -> Reply {
    if request.is_array() {
        let Some(uv) = flat(request, 2) else { return bad("faceSamples expects [[u, v], …] or { nu, nv }") };
        return session.with_shape(handle, |shape| queries::face_samples(shape, face, UvRequest::Pairs(&uv)));
    }
    let count = |field: &str| request.get(field).and_then(Value::as_f64).filter(|value| value.fract() == 0.0 && value.abs() < 1e6);
    let (Some(nu), Some(nv)) = (count("nu"), count("nv")) else { return Reply::ok(Value::Null) };
    session.with_shape(handle, |shape| queries::face_samples(shape, face, UvRequest::Grid { nu: nu as i32, nv: nv as i32 }))
}

fn distance(session: &mut Session, args: &[Value]) -> Reply {
    let a = match session.resolve(arg(args, 0)) {
        Ok(Some(shape)) => shape,
        Ok(None) => return Reply::ok(Value::Null),
        Err(reply) => return reply,
    };
    session.with_shape(arg(args, 1), |b| queries::shape_distance(&a, b))
}

/// `[{ parts: [{ shapes: [handle], children: [use] }], occurrences: [use] }]`, use = `{ part, position, rotation }` (the host flattens the
/// part objects so a part shared by several occurrences stays one product).
fn export_assembly(session: &mut Session, tree: &Value) -> Reply {
    let part_use = |value: &Value| -> Option<PartUse> {
        let part = value.get("part")?.as_u64().and_then(|index| usize::try_from(index).ok())?;
        Some(PartUse { part, rotation: vec3(value.get("rotation")?)?, position: vec3(value.get("position")?)? })
    };
    let uses = |value: Option<&Value>| -> Option<Vec<PartUse>> {
        value.map_or(Some(Vec::new()), |list| list.as_array()?.iter().map(part_use).collect())
    };
    let (Some(parts), Some(occurrences)) = (tree.get("parts").and_then(Value::as_array), uses(tree.get("occurrences"))) else {
        return bad("exportStepAssembly expects { parts, occurrences }");
    };
    let mut shapes: Vec<Vec<Rc<Shape>>> = Vec::with_capacity(parts.len());
    let mut children = Vec::with_capacity(parts.len());
    for part in parts {
        let (Some(handles), Some(nested)) = (part.get("shapes").and_then(Value::as_array), uses(part.get("children"))) else {
            return bad("an assembly part needs shapes and children");
        };
        let mut resolved = Vec::with_capacity(handles.len());
        for handle in handles {
            match session.resolve(handle) {
                Ok(Some(shape)) => resolved.push(shape),
                Ok(None) => return Reply::ok(Value::Null),
                Err(reply) => return reply,
            }
        }
        shapes.push(resolved);
        children.push(nested);
    }
    let assembly: Vec<AssemblyPart<'_>> = shapes
        .iter()
        .zip(children)
        .map(|(shapes, children)| AssemblyPart { shapes: shapes.iter().map(Rc::as_ref).collect(), children })
        .collect();
    answered(queries::export_step_assembly(&assembly, &occurrences).map(|text| text.map_or(Value::Null, Value::String)))
}

fn import_shapes(args: &[Value]) -> Reply {
    let format = arg(args, 0).as_str();
    if format != Some("step") && format != Some("iges") {
        return Reply::ok(Value::Null);
    }
    let Some(text) = arg(args, 1).as_str() else { return bad("importShapes expects the file text") };
    let options = arg(args, 2);
    let number = |field: &str| options.get(field).and_then(Value::as_f64);
    let flag = |field: &str| options.get(field).and_then(Value::as_bool);
    let (Some(precision), Some(max_tolerance), Some(heal), Some(sew)) =
        (number("precision"), number("maxTolerance"), flag("heal"), flag("sew"))
    else {
        return bad("importShapes expects { precision, maxTolerance, heal, sew }");
    };
    let options = ImportOptions { precision, max_tolerance, heal, sew };
    // IGES goes through the XDE reader of the exchange ops (sewing at max(1e-6 x diagonal, precision): no file resolution here)
    answered(if format == Some("iges") { xde::import_iges(text, options, 0.0) } else { queries::import_step(text, options) })
}

fn load_blob(session: &mut Session, args: &[Value]) -> Reply {
    let (Some(sha256), Some(text)) = (arg(args, 0).as_str(), arg(args, 1).as_str()) else {
        return bad("loadBlob expects (sha256, text)");
    };
    if !session.load_blob(sha256, text) {
        eprintln!("[llull-kernel] KRN_BLOB_HASH_MISMATCH: blob {sha256} refused (its text hashes differently)");
    }
    Reply::ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use crate::session::Session;
    use llull_kernel_occt::recipe::sha256_hex;
    use serde_json::{json, Value};

    fn box_recipe(size: f64, x: f64) -> Value {
        json!({ "op": "solid", "entity": { "id": "b", "kind": "box", "position": [x, 0, 0], "rotation": [0, 0, 0], "size": [size, size, size] } })
    }

    fn call(session: &mut Session, op: &str, args: Value) -> Value {
        session.handle_line(&json!({ "id": 1, "op": op, "args": args }).to_string())
    }

    fn error_of(reply: &Value) -> &str {
        reply["error"].as_str().unwrap_or("")
    }

    #[test]
    fn answers_topology_and_face_queries_on_handles() {
        let mut session = Session::new();
        let cube = json!({ "key": "c", "recipe": box_recipe(2.0, 0.0) });
        let topology = call(&mut session, "topology", json!([cube]));
        assert_eq!(topology["result"]["faces"].as_array().map(Vec::len), Some(6));
        let details = call(&mut session, "faceQuery.faceDetails", json!([{ "key": "c" }, { "samples": 3 }]));
        assert_eq!(details["result"][0]["samples"].as_array().map(Vec::len), Some(3));
        let projected = call(&mut session, "faceQuery.projectOnFace", json!([{ "key": "c" }, 1, [[5, 0, 0]]]));
        assert_eq!(projected["result"][0]["distance"], json!(4));
        let contains = call(&mut session, "faceQuery.faceContains", json!([{ "key": "c" }, 1, [1, 0, 0]]));
        assert_eq!(contains["result"], json!(true));
        let grid = call(&mut session, "faceQuery.faceSamples", json!([{ "key": "c" }, 0, { "nu": 2, "nv": 2 }]));
        assert_eq!(grid["result"].as_array().map(Vec::len), Some(4));
        let fractional = call(&mut session, "faceQuery.faceSamples", json!([{ "key": "c" }, 0, { "nu": 1.5, "nv": 2 }]));
        assert_eq!(fractional["result"], Value::Null);
        assert_eq!(call(&mut session, "faceQuery.bspline", json!([{ "key": "c" }, 0])), json!({ "id": 1, "result": null }));
        let distances = call(&mut session, "faceQuery.distance", json!([{ "key": "c" }, [[0, 0, 0]]]));
        assert_eq!(distances["result"][0]["signed"], json!(-1));
        let bad = call(&mut session, "faceQuery.projectOnFace", json!([{ "key": "c" }, 1, [[5, 0]]]));
        assert!(error_of(&bad).starts_with("NATIVE_BAD_REQUEST"));
        assert!(error_of(&call(&mut session, "faceQuery.nope", json!([]))).starts_with("NATIVE_UNSUPPORTED"));
    }

    #[test]
    fn answers_edge_samples_and_continuity() {
        let mut session = Session::new();
        let cube = json!({ "key": "c", "recipe": box_recipe(2.0, 0.0) });
        let samples = call(&mut session, "faceQuery.edgeSamples", json!([cube, 0, 3]));
        assert_eq!(samples["result"].as_array().map(Vec::len), Some(3));
        let continuity = call(&mut session, "faceQuery.edgeContinuity", json!([{ "key": "c" }, 0, 2]));
        let g1 = continuity["result"][0]["g1"].as_f64().unwrap_or(0.0);
        assert!((g1 - std::f64::consts::FRAC_PI_2).abs() < 1e-9, "a cube edge is a right angle");
        assert_eq!(call(&mut session, "faceQuery.edgeSamples", json!([{ "key": "c" }, 0, 1]))["result"], Value::Null);
        assert_eq!(call(&mut session, "faceQuery.edgeContinuity", json!([{ "key": "c" }, "x", 2]))["result"], Value::Null);
    }

    #[test]
    fn measures_distance_and_falls_back_for_unsupported_operands() {
        let mut session = Session::new();
        let a = json!({ "key": "a", "recipe": box_recipe(1.0, 0.0) });
        let b = json!({ "key": "b", "recipe": box_recipe(1.0, 3.0) });
        assert_eq!(call(&mut session, "distance", json!([a, b, 10]))["result"]["distance"], json!(2));
        let loft = json!({ "key": "l", "recipe": { "op": "loft", "sections": [] } });
        assert!(error_of(&call(&mut session, "distance", json!([{ "key": "a" }, loft, 10]))).starts_with("NATIVE_UNSUPPORTED"));
    }

    #[test]
    fn writes_assemblies_with_shared_parts() {
        let mut session = Session::new();
        let tree = json!({
            "parts": [{ "shapes": [{ "key": "p", "recipe": box_recipe(1.0, 0.0) }], "children": [] }],
            "occurrences": [
                { "part": 0, "position": [0, 0, 0], "rotation": [0, 0, 0] },
                { "part": 0, "position": [3, 0, 0], "rotation": [0, 0, 1] }
            ]
        });
        let reply = call(&mut session, "exportStepAssembly", json!([tree]));
        assert_eq!(reply["result"].as_str().unwrap_or("").matches("NEXT_ASSEMBLY_USAGE_OCCURRENCE(").count(), 2);
        let malformed = call(&mut session, "exportStepAssembly", json!([{ "parts": [], "occurrences": [{ "part": "x" }] }]));
        assert!(error_of(&malformed).starts_with("NATIVE_BAD_REQUEST"));
    }

    #[test]
    fn imports_step_and_evaluates_its_blob() {
        let mut session = Session::new();
        let step = call(&mut session, "exportStep", json!([[{ "key": "s", "recipe": box_recipe(2.0, 0.0) }]]))["result"].clone();
        let options = json!({ "precision": 0.01, "maxTolerance": 1, "heal": true, "sew": true });
        let imported = call(&mut session, "importShapes", json!(["step", step, options]));
        let brep = imported["result"]["solids"][0]["brep"].as_str().unwrap_or("").to_string();
        let sha256 = sha256_hex(brep.as_bytes());
        let leaf = json!({ "key": "imp", "recipe": { "op": "brep", "blob": sha256, "format": "occt-brep-v1" } });
        assert_eq!(call(&mut session, "massProperties", json!([leaf]))["result"], Value::Null, "blob not loaded yet");
        assert_eq!(call(&mut session, "loadBlob", json!([sha256, brep])), json!({ "id": 1, "result": null }));
        let mass = call(&mut session, "massProperties", json!([leaf]));
        assert!((mass["result"]["volume"].as_f64().unwrap_or(0.0) - 8.0).abs() < 1e-9);
        assert_eq!(call(&mut session, "importShapes", json!(["obj", "", options]))["result"], Value::Null);
        if llull_kernel_occt::xde::iges_available() {
            let request = json!({
                "format": "iges",
                "unit": "mm",
                "products": [{ "key": "p", "solids": [{ "shape": { "key": "s", "recipe": box_recipe(2.0, 0.0) } }] }],
                "occurrences": [],
                "header": {}
            });
            let iges = call(&mut session, "writeExchange", json!([request]))["result"].clone();
            let back = call(&mut session, "importShapes", json!(["iges", iges, options]));
            assert_eq!(back["result"]["solids"].as_array().map(Vec::len), Some(1), "an exported box reads back as one solid: {back}");
        } else {
            assert_eq!(call(&mut session, "importShapes", json!(["iges", "x", options]))["result"]["error"], json!("unavailable"));
        }
        assert!(error_of(&call(&mut session, "importShapes", json!(["step", "x", {}]))).starts_with("NATIVE_BAD_REQUEST"));
        assert!(error_of(&call(&mut session, "loadBlob", json!([1]))).starts_with("NATIVE_BAD_REQUEST"));
    }
}
