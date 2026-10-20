use super::*;
use crate::queries::read_brep;
use crate::{make_box, mass_properties};
use serde_json::json;
use std::sync::{Mutex, MutexGuard};

/// OCCT's STEP writer, XCAF application and Interface_Static are process-global: these tests run one at a time.
static SERIAL: Mutex<()> = Mutex::new(());

pub(super) fn serial() -> MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(super) fn block(size: f64) -> Shape {
    make_box([0.0, 0.0, 0.0], [size, size, size]).unwrap().unwrap()
}

pub(super) fn options() -> ImportOptions {
    ImportOptions { precision: 1e-4, max_tolerance: 0.1, heal: true, sew: true }
}

pub(super) fn product<'a>(name: &str, shape: &'a Shape, color: &str, validation: Option<[f64; 5]>) -> ExchangeProduct<'a> {
    ExchangeProduct {
        name: name.to_string(),
        description: String::new(),
        color: color.to_string(),
        layer: "Layer A".to_string(),
        material: String::new(),
        density: -1.0,
        solids: vec![ExchangeSolid { shape, name: name.to_string(), color: color.to_string() }],
        validation,
        pmi: Default::default(),
    }
}

pub(super) fn request<'a>(products: Vec<ExchangeProduct<'a>>, uses: Vec<ExchangeUse>, schema: i32, unit: &'a str) -> WriteRequest<'a> {
    WriteRequest {
        products,
        uses,
        schema,
        unit,
        file_name: "t.stp",
        timestamp: "2026-10-20T00:00:00",
        originating_system: "llull test",
        root_name: "Assembly",
        root_validation: Some([2000.0, 1200.0, 50.0, 5.0, 5.0]),
    }
}

fn two_uses() -> Vec<ExchangeUse> {
    vec![
        ExchangeUse { parent: -1, product: 0, name: "Block 1".to_string(), rotation: [0.0; 3], position: [0.0; 3] },
        ExchangeUse {
            parent: -1,
            product: 0,
            name: "Block 2".to_string(),
            rotation: [0.0, 0.0, std::f64::consts::FRAC_PI_2],
            position: [100.0, 0.0, 0.0],
        },
    ]
}

#[test]
fn writes_ap242_with_structure_names_colours_layers_and_validation_properties() {
    let _guard = serial();
    let shape = block(10.0);
    let text =
        write_exchange(&request(vec![product("Block", &shape, "#3366cc", Some([1000.0, 600.0, 5.0, 5.0, 5.0]))], two_uses(), 5, "mm"))
            .unwrap()
            .unwrap();
    assert!(text.contains("AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF"), "{}", &text[..400]);
    assert!(text.contains("FILE_NAME('t.stp','2026-10-20T00:00:00'"));
    assert_eq!(text.matches("MANIFOLD_SOLID_BREP(").count(), 1, "one part written once");
    assert_eq!(text.matches("NEXT_ASSEMBLY_USAGE_OCCURRENCE(").count(), 2);
    assert!(text.contains("'Block 1'") && text.contains("'Block 2'"));
    assert!(text.contains("PRESENTATION_LAYER_ASSIGNMENT('Layer A'"));
    assert_eq!(text.matches("'geometric validation property'").count(), 6, "volume, area and centroid of the part and of the root");
    assert!(text.contains("'volume measure'") && text.contains("'surface area measure'"));
    assert!(text.contains("COLOUR_RGB('',0.199999"));
    let without = write_exchange(&request(vec![product("Block", &shape, "#3366cc", None)], two_uses(), 5, "mm")).unwrap().unwrap();
    assert!(without.len() < text.len(), "a product without validation properties is written shorter");
}

#[test]
fn schemas_and_units() {
    let _guard = serial();
    let shape = block(10.0);
    let write = |schema: i32, unit: &str| {
        write_exchange(&request(vec![product("Block", &shape, "", None)], two_uses(), schema, unit)).unwrap().unwrap()
    };
    assert!(write(4, "mm").contains("AUTOMOTIVE_DESIGN"));
    assert!(write(3, "mm").contains("CONFIG_CONTROL_DESIGN"));
    assert!(write(5, "in").contains("CONVERSION_BASED_UNIT('INCH'"));
    // OCCT numbers records in an address-dependent order, so two writes of one shape agree in content, not in bytes (the host canonicalises)
    let (first, second) = (write(5, "mm"), write(5, "mm"));
    assert_eq!(first.matches(';').count(), second.matches(';').count());
    assert_eq!(first.matches("ADVANCED_FACE(").count(), second.matches("ADVANCED_FACE(").count());
    assert!(write_exchange(&request(vec![product("Block", &shape, "", None)], two_uses(), 9, "mm")).is_err());
    assert!(write_exchange(&request(vec![product("Block", &shape, "", None)], two_uses(), 5, "parsec")).is_err());
}

#[test]
fn round_trips_the_product_tree_with_exact_placements() {
    let _guard = serial();
    let shape = block(10.0);
    let text =
        write_exchange(&request(vec![product("Block", &shape, "#99cc33", Some([1000.0, 600.0, 5.0, 5.0, 5.0]))], two_uses(), 5, "mm"))
            .unwrap()
            .unwrap();
    let tree = import_exchange(&text, options()).unwrap();
    let products = tree["products"].as_array().unwrap();
    assert_eq!(products.len(), 2, "the root assembly and the part");
    let part = products.iter().find(|entry| entry["name"] == json!("Block")).unwrap();
    assert_eq!(part["solids"], json!([0]));
    assert_eq!(part["layers"], json!(["Layer A"]));
    assert_eq!(tree["solids"][0]["color"], json!("#99cc33"));
    let uses = tree["occurrences"].as_array().unwrap();
    assert_eq!(uses.len(), 2);
    let second = uses.iter().find(|entry| entry["name"] == json!("Block 2")).unwrap();
    let matrix: Vec<f64> = second["matrix"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
    assert!((matrix[3] - 100.0).abs() < 1e-9 && (matrix[1] + 1.0).abs() < 1e-9 && (matrix[4] - 1.0).abs() < 1e-9, "{matrix:?}");
    let solid = read_brep(tree["solids"][0]["brep"].as_str().unwrap()).unwrap().unwrap();
    assert!((mass_properties(&solid).unwrap().volume - 1000.0).abs() < 1e-6);
}

#[test]
fn keeps_the_documents_own_numbers_in_inches() {
    let _guard = serial();
    let shape = block(1.0);
    let text = write_exchange(&request(vec![product("Cube", &shape, "", None)], two_uses(), 5, "in")).unwrap().unwrap();
    let tree = import_exchange(&text, options()).unwrap();
    let solid = read_brep(tree["solids"][0]["brep"].as_str().unwrap()).unwrap().unwrap();
    // 1 in x 1 in x 1 in read back in millimetres
    assert!((mass_properties(&solid).unwrap().volume - 25.4_f64.powi(3)).abs() < 1e-6);
}

#[test]
fn refuses_garbage_and_unknown_products() {
    let _guard = serial();
    assert_eq!(import_exchange("garbage", options()).unwrap()["error"], json!("unreadable"));
    let shape = block(2.0);
    let bad_use = vec![ExchangeUse { parent: -1, product: 5, name: "x".to_string(), rotation: [0.0; 3], position: [0.0; 3] }];
    assert!(write_exchange(&request(vec![product("Block", &shape, "", None)], bad_use, 5, "mm")).is_err());
}

#[test]
fn iges_availability_matches_the_build() {
    let _guard = serial();
    let shape = block(10.0);
    let products = vec![product("Block", &shape, "", None)];
    if !iges_available() {
        assert_eq!(import_iges("x", options(), 0.0).unwrap()["error"], json!("unavailable"));
        assert_eq!(export_iges(&products, true, "mm").unwrap(), None);
        return;
    }
    let text = export_iges(&products, true, "mm").unwrap().unwrap();
    assert!(text.lines().next().unwrap().len() >= 73);
    let back = import_iges(&text, options(), 0.0).unwrap();
    assert_eq!(back["solids"].as_array().unwrap().len(), 1, "{back}");
    let solid = read_brep(back["solids"][0]["brep"].as_str().unwrap()).unwrap().unwrap();
    assert!((mass_properties(&solid).unwrap().volume - 1000.0).abs() < 1e-3);
    assert_eq!(import_iges("not iges", options(), 0.0).unwrap()["error"], json!("unreadable"));
}
