use crate::session::Session;
use serde_json::{json, Value};
use std::sync::{Mutex, MutexGuard};

/// OCCT's STEP writer and XCAF application are process-global: these tests run one at a time.
static SERIAL: Mutex<()> = Mutex::new(());

fn serial() -> MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn call(session: &mut Session, op: &str, args: Value) -> Value {
    session.handle_line(&json!({ "id": 1, "op": op, "args": args }).to_string())
}

fn box_handle(key: &str, size: f64) -> Value {
    json!({ "key": key, "recipe": { "op": "solid", "entity": { "id": key, "kind": "box", "position": [0, 0, 0], "rotation": [0, 0, 0], "size": [size, size, size] } } })
}

fn request(format: &str) -> Value {
    json!({
        "format": format, "schema": "ap242", "unit": "mm", "rootName": "Assembly",
        "header": { "fileName": "t.stp", "originatingSystem": "llull test", "timestamp": "2026-10-20T00:00:00" },
        "products": [{
            "key": "p", "name": "Block", "color": "#ff0000", "layer": "L1",
            "validation": { "volume": 1000.0, "area": 600.0, "centroid": [0, 0, 0] },
            "solids": [{ "name": "Block", "color": "#ff0000", "shape": box_handle("b", 10.0) }]
        }],
        "occurrences": [
            { "parent": null, "product": "p", "name": "Block 1", "position": [0, 0, 0], "rotation": [0, 0, 0] },
            { "parent": null, "product": "p", "name": "Block 2", "position": [50, 0, 0], "rotation": [0, 0, 0] }
        ]
    })
}

fn options() -> Value {
    json!({ "precision": 1e-4, "maxTolerance": 0.1, "heal": true, "sew": true })
}

#[test]
fn writes_a_product_tree_and_reads_it_back() {
    let _guard = serial();
    let mut session = Session::new();
    let written = call(&mut session, "writeExchange", json!([request("step")]));
    let step = written["result"].as_str().unwrap_or("");
    assert!(step.contains("AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF"), "{written}");
    assert_eq!(step.matches("NEXT_ASSEMBLY_USAGE_OCCURRENCE(").count(), 2);
    let read = call(&mut session, "importExchange", json!(["step", step, options()]));
    assert_eq!(read["result"]["occurrences"].as_array().map(Vec::len), Some(2), "{read}");
    assert_eq!(read["result"]["solids"][0]["color"], json!("#ff0000"));
    let unreadable = call(&mut session, "importExchange", json!(["step", "garbage", options()]));
    assert_eq!(unreadable["result"]["error"], json!("unreadable"));
    assert_eq!(call(&mut session, "importExchange", json!(["jt", "x", options()]))["result"], Value::Null);
    let info = call(&mut session, "info", json!([]));
    let capabilities = info["result"]["capabilities"].as_array().unwrap();
    assert!(capabilities.contains(&json!("writeExchange")) && capabilities.contains(&json!("importExchange")));
}

#[test]
fn refuses_malformed_requests() {
    let _guard = serial();
    let mut session = Session::new();
    let error_of = |reply: &Value| reply["error"].as_str().unwrap_or("").to_string();
    assert!(error_of(&call(&mut session, "writeExchange", json!([{}]))).starts_with("NATIVE_BAD_REQUEST"));
    let mut bad_schema = request("step");
    bad_schema["schema"] = json!("ap999");
    assert!(error_of(&call(&mut session, "writeExchange", json!([bad_schema]))).starts_with("NATIVE_BAD_REQUEST"));
    let mut bad_parent = request("step");
    bad_parent["occurrences"][0]["parent"] = json!("nope");
    assert!(error_of(&call(&mut session, "writeExchange", json!([bad_parent]))).contains("not a product"));
    let mut bad_unit = request("step");
    bad_unit["unit"] = json!("parsec");
    assert!(error_of(&call(&mut session, "writeExchange", json!([bad_unit]))).starts_with("NATIVE_OCC_FAILURE"));
    assert!(error_of(&call(&mut session, "importExchange", json!(["step"]))).starts_with("NATIVE_BAD_REQUEST"));
}

#[test]
fn writes_iges_when_the_build_has_the_translator() {
    let _guard = serial();
    let mut session = Session::new();
    let written = call(&mut session, "writeExchange", json!([request("iges")]));
    if llull_kernel_occt::xde::iges_available() {
        assert!(written["result"].as_str().is_some_and(|text| text.contains("186")), "{written}");
    } else {
        assert_eq!(written["result"], Value::Null);
    }
}

#[test]
fn carries_pmi_modifiers_through_the_json_vocabulary() {
    let _guard = serial();
    let mut session = Session::new();
    let mut tree = request("step");
    tree["products"][0]["pmi"] = json!({
        "datums": [{ "label": "A", "faces": [4], "modifiers": ["maximum_material_requirement"] }],
        "tolerances": [{
            "characteristic": "position", "value": 0.2, "diameterZone": true, "faces": [3], "datums": ["A"],
            "materialRequirement": "maximum", "modifiers": ["common_zone"]
        }],
        "dimensions": [{ "type": "size_diameter", "value": 8.0, "faces": [2], "modifiers": ["two_point_size"], "range": { "lower": 7.9, "upper": 8.1 } }]
    });
    let written = call(&mut session, "writeExchange", json!([tree]));
    let step = written["result"].as_str().unwrap_or("");
    assert!(!step.is_empty(), "{written}");
    let read = call(&mut session, "importExchange", json!(["step", step, options()]));
    let products = read["result"]["products"].as_array().unwrap();
    let pmi = &products.iter().find(|product| product["name"] == json!("Block")).expect("the Block product")["pmi"];
    assert_eq!(pmi["tolerances"][0]["materialRequirement"], json!("maximum"), "{pmi}");
    assert_eq!(pmi["tolerances"][0]["modifiers"], json!(["common_zone"]), "{pmi}");
    assert_eq!(pmi["datums"][0]["modifiers"], json!(["maximum_material_requirement"]), "{pmi}");
    assert_eq!(pmi["dimensions"][0]["range"], json!({ "lower": 7.9, "upper": 8.1 }), "{pmi}");

    let mut refused = request("step");
    refused["products"][0]["pmi"] = json!({
        "datums": [], "dimensions": [],
        "tolerances": [{ "characteristic": "flatness", "value": 0.05, "faces": [5], "modifiers": ["all_around"] }]
    });
    let reply = call(&mut session, "writeExchange", json!([refused]));
    assert!(reply["error"].is_object() || reply["result"].is_null(), "an unwritable modifier is refused loudly: {reply}");
}
