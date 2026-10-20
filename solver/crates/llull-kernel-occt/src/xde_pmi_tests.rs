use super::tests::{block, options, product, request, serial};
use super::*;
use crate::make_box;
use serde_json::json;

fn plate_pmi() -> ExchangePmi {
    ExchangePmi {
        datums: vec![PmiDatum { label: "A".to_string(), faces: vec![4], attrs: vec![] }],
        tolerances: vec![
            PmiTolerance {
                characteristic: "flatness".to_string(),
                value: 0.05,
                diameter_zone: false,
                faces: vec![5],
                datums: vec![],
                attrs: vec![],
            },
            PmiTolerance {
                characteristic: "position".to_string(),
                value: 0.2,
                diameter_zone: true,
                faces: vec![3],
                datums: vec!["A".to_string()],
                attrs: vec![],
            },
        ],
        dimensions: vec![PmiDimension {
            kind: "location_linear_distance".to_string(),
            value: 10.0,
            tolerance: Some((0.1, 0.2)),
            faces: vec![0],
            faces_second: vec![1],
            attrs: vec![],
        }],
    }
}

#[test]
fn round_trips_semantic_pmi_on_faces_in_ap242() {
    let _guard = serial();
    let shape = make_box([0.0, 0.0, 0.0], [10.0, 20.0, 30.0]).unwrap().unwrap();
    let mut plate = product("Plate", &shape, "", None);
    plate.pmi = plate_pmi();
    let text = write_exchange(&request(vec![plate], vec![], 5, "mm")).unwrap().unwrap();
    for entity in ["FLATNESS_TOLERANCE(", "POSITION_TOLERANCE()", "DIMENSIONAL_LOCATION(", "DATUM(", "PLUS_MINUS_TOLERANCE("] {
        assert!(text.contains(entity), "{entity} missing");
    }
    let tree = import_exchange(&text, options()).unwrap();
    let pmi = &tree["products"][0]["pmi"];
    assert_eq!(pmi["datums"], json!([{ "label": "A", "faces": [4] }]), "{pmi}");
    let tolerances = pmi["tolerances"].as_array().unwrap();
    let flatness = tolerances.iter().find(|entry| entry["characteristic"] == json!("flatness")).unwrap();
    assert_eq!((flatness["value"].clone(), flatness["faces"].clone(), flatness["datums"].clone()), (json!(0.05), json!([5]), json!([])));
    let position = tolerances.iter().find(|entry| entry["characteristic"] == json!("position")).unwrap();
    assert_eq!(
        (position["diameterZone"].clone(), position["datums"].clone(), position["faces"].clone()),
        (json!(true), json!(["A"]), json!([3]))
    );
    let location = &pmi["dimensions"][0];
    assert_eq!(location["type"], json!("location_linear_distance"));
    assert_eq!(location["value"].as_f64(), Some(10.0));
    assert_eq!((location["faces"].clone(), location["facesSecond"].clone()), (json!([0]), json!([1])));
    assert_eq!(location["tolerance"], json!({ "plus": 0.1, "minus": 0.2 }));
    assert_eq!(tree["pmiUnmapped"], json!(0));
}

#[test]
fn refuses_pmi_that_cannot_be_written() {
    let _guard = serial();
    let shape = block(10.0);
    let with = |edit: &dyn Fn(&mut ExchangePmi)| {
        let mut plate = product("Plate", &shape, "", None);
        plate.pmi = plate_pmi();
        edit(&mut plate.pmi);
        write_exchange(&request(vec![plate], vec![], 5, "mm"))
    };
    assert!(with(&|pmi| pmi.tolerances[0].faces = vec![99]).is_err(), "a face the product does not have");
    assert!(with(&|pmi| pmi.tolerances[0].characteristic = "wobble".to_string()).is_err());
    assert!(with(&|pmi| pmi.tolerances[1].datums = vec!["Z".to_string()]).is_err(), "a datum the product does not define");
    assert!(with(&|pmi| pmi.dimensions[0].kind = "size_cube".to_string()).is_err());
    let mut plate = product("Plate", &shape, "", None);
    plate.pmi = plate_pmi();
    assert!(write_exchange(&request(vec![plate], vec![], 4, "mm")).is_err(), "PMI needs AP242");
}

fn attr(key: &str, text: &str, number: f64) -> PmiAttr {
    (key.to_string(), text.to_string(), number)
}

#[test]
fn round_trips_modifiers_material_requirement_boundary_and_fit_class() {
    let _guard = serial();
    let shape = make_box([0.0, 0.0, 0.0], [10.0, 20.0, 30.0]).unwrap().unwrap();
    let mut plate = product("Plate", &shape, "", None);
    plate.pmi = ExchangePmi {
        datums: vec![PmiDatum {
            label: "A".to_string(),
            faces: vec![4],
            attrs: vec![attr("modifier", "maximum_material_requirement", 0.0), attr("modifier", "contacting_feature", 0.0)],
        }],
        tolerances: vec![PmiTolerance {
            characteristic: "position".to_string(),
            value: 0.2,
            diameter_zone: true,
            faces: vec![3],
            datums: vec!["A".to_string()],
            attrs: vec![
                attr("modifier", "maximum_material_requirement", 0.0),
                attr("modifier", "common_zone", 0.0),
                attr("modifier", "free_state", 0.0),
            ],
        }],
        dimensions: vec![PmiDimension {
            kind: "size_diameter".to_string(),
            value: 8.0,
            tolerance: None,
            faces: vec![2],
            faces_second: vec![],
            attrs: vec![
                attr("modifier", "two_point_size", 0.0),
                attr("class_hole", "true", 0.0),
                attr("class_variance", "H", 0.0),
                attr("class_grade", "IT7", 0.0),
                attr("range_lower", "", 7.9),
                attr("range_upper", "", 8.1),
            ],
        }],
    };
    let text = write_exchange(&request(vec![plate], vec![], 5, "mm")).unwrap().unwrap();
    let tree = import_exchange(&text, options()).unwrap();
    let pmi = &tree["products"][0]["pmi"];
    let datum = &pmi["datums"][0];
    assert_eq!(datum["label"], json!("A"), "{pmi}");
    let modifiers = datum["modifiers"].as_array().unwrap();
    assert!(modifiers.contains(&json!("maximum_material_requirement")), "datum boundary MMB: {datum}");
    assert!(modifiers.contains(&json!("contacting_feature")), "{datum}");
    let tolerance = &pmi["tolerances"][0];
    assert_eq!(tolerance["materialRequirement"], json!("maximum"), "{tolerance}");
    assert_eq!(tolerance["value"].as_f64(), Some(0.2), "a modified tolerance keeps its value (not x1000): {tolerance}");
    let tolerance_modifiers = tolerance["modifiers"].as_array().unwrap();
    assert!(tolerance_modifiers.contains(&json!("common_zone")) && tolerance_modifiers.contains(&json!("free_state")), "{tolerance}");
    let dimension = &pmi["dimensions"][0];
    assert_eq!(dimension["classOfTolerance"], json!({ "hole": true, "variance": "H", "grade": "IT7" }), "{dimension}");
    assert!(dimension["modifiers"].as_array().unwrap().contains(&json!("two_point_size")), "{dimension}");
    assert_eq!(dimension["range"], json!({ "lower": 7.9, "upper": 8.1 }), "{dimension}");
}

#[test]
fn a_tolerance_without_dimension_or_datum_is_written_in_the_files_own_length_unit() {
    let _guard = serial();
    let shape = make_box([0.0, 0.0, 0.0], [10.0, 20.0, 30.0]).unwrap().unwrap();
    let mut plate = product("Plate", &shape, "", None);
    plate.pmi = ExchangePmi {
        datums: vec![],
        tolerances: vec![PmiTolerance {
            characteristic: "flatness".to_string(),
            value: 0.05,
            diameter_zone: false,
            faces: vec![5],
            datums: vec![],
            attrs: vec![attr("modifier", "free_state", 0.0)],
        }],
        dimensions: vec![],
    };
    let text = write_exchange(&request(vec![plate], vec![], 5, "mm")).unwrap().unwrap();
    let measure =
        text.lines().find(|line| line.contains("LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(5.E-02)")).expect("the tolerance magnitude");
    let unit = measure.rsplit_once(",#").map(|(_, id)| id.trim_end_matches(");")).expect("its unit reference");
    let unit_line = text.lines().find(|line| line.starts_with(&format!("#{unit} = "))).expect("the unit record");
    assert!(unit_line.contains("MILLI"), "0.05 mm must not read as 0.05 m in another reader: {unit_line}");
    let back = import_exchange(&text, options()).unwrap();
    assert_eq!(back["products"][0]["pmi"]["tolerances"][0]["value"].as_f64(), Some(0.05));
}

#[test]
fn refuses_vocabulary_this_writer_cannot_carry_and_unknown_names() {
    let _guard = serial();
    let shape = block(10.0);
    let with = |edit: &dyn Fn(&mut ExchangePmi)| {
        let mut plate = product("Plate", &shape, "", None);
        plate.pmi = plate_pmi();
        edit(&mut plate.pmi);
        write_exchange(&request(vec![plate], vec![], 5, "mm"))
    };
    for name in ["wobbly", "all_around", "all_over"] {
        assert!(with(&|pmi| pmi.tolerances[0].attrs.push(attr("modifier", name, 0.0))).is_err(), "{name}");
    }
    assert!(with(&|pmi| pmi.tolerances[0].attrs.push(attr("sparkle", "", 1.0))).is_err());
    assert!(with(&|pmi| pmi.tolerances[0].attrs.push(attr("max_value", "", 0.1))).is_err(), "maximum tolerance is not read back");
    assert!(with(&|pmi| pmi.tolerances[0].attrs.push(attr("zone_modifier", "projected", 0.0))).is_err(), "not written by OCC 7.9.2");
    assert!(with(&|pmi| pmi.datums[0].attrs.push(attr("modifier", "wobbly", 0.0))).is_err());
    assert!(with(&|pmi| pmi.datums[0].attrs.push(attr("modifier_with_value", "distance", 1.0))).is_err());
    assert!(with(&|pmi| pmi.dimensions[0].attrs.push(attr("qualifier", "min", 0.0))).is_err());
    assert!(with(&|pmi| pmi.dimensions[0].attrs.push(attr("modifier", "between", 0.0))).is_err());
    for grade in ["IT99", "IT0", "IT1"] {
        assert!(with(&|pmi| pmi.dimensions[0].attrs.push(attr("class_grade", grade, 0.0))).is_err(), "{grade}");
    }
}

#[test]
fn an_inch_document_writes_its_tolerance_in_inches() {
    let _guard = serial();
    let shape = make_box([0.0, 0.0, 0.0], [1.0, 2.0, 3.0]).unwrap().unwrap();
    let mut plate = product("Plate", &shape, "", None);
    plate.pmi = ExchangePmi {
        datums: vec![],
        tolerances: vec![PmiTolerance {
            characteristic: "flatness".to_string(),
            value: 0.002,
            diameter_zone: false,
            faces: vec![5],
            datums: vec![],
            attrs: vec![],
        }],
        dimensions: vec![],
    };
    let text = write_exchange(&request(vec![plate], vec![], 5, "in")).unwrap().unwrap();
    assert!(text.contains("LENGTH_MEASURE(2.E-03)"), "the document's own number is written");
    let back = import_exchange(&text, options()).unwrap();
    let value = back["products"][0]["pmi"]["tolerances"][0]["value"].as_f64().unwrap();
    assert!((value - 0.002 * 25.4).abs() < 1e-9, "read in millimetres: {value}");
}

/// Datums `[a, b, c]` and four tolerances: two positions on the same frame a|b|c, a perpendicularity on a, a flatness without datum.
fn framed_pmi([a, b, c]: [&str; 3]) -> ExchangePmi {
    let datum = |label: &str, face: i32| PmiDatum { label: label.to_string(), faces: vec![face], attrs: vec![] };
    let tolerance = |characteristic: &str, face: i32, datums: &[&str]| PmiTolerance {
        characteristic: characteristic.to_string(),
        value: 0.1,
        diameter_zone: characteristic == "position",
        faces: vec![face],
        datums: datums.iter().map(|name| name.to_string()).collect(),
        attrs: vec![],
    };
    ExchangePmi {
        datums: vec![datum(a, 4), datum(b, 0), datum(c, 2)],
        tolerances: vec![
            tolerance("position", 1, &[a, b, c]),
            tolerance("position", 3, &[a, b, c]),
            tolerance("perpendicularity", 1, &[a]),
            tolerance("flatness", 5, &[]),
        ],
        dimensions: vec![],
    }
}

#[test]
fn writes_one_datum_system_per_distinct_reference_frame_of_a_product() {
    let _guard = serial();
    let first = make_box([0.0, 0.0, 0.0], [10.0, 20.0, 30.0]).unwrap().unwrap();
    let second = make_box([0.0, 0.0, 0.0], [5.0, 5.0, 5.0]).unwrap().unwrap();
    let labels = [["A", "B", "C"], ["D", "E", "F"]];
    let mut plate = product("Plate", &first, "", None);
    plate.pmi = framed_pmi(labels[0]);
    let mut lug = product("Lug", &second, "", None);
    lug.pmi = framed_pmi(labels[1]);
    let uses = vec![
        ExchangeUse { parent: -1, product: 0, name: "Plate 1".to_string(), rotation: [0.0; 3], position: [0.0; 3] },
        ExchangeUse { parent: -1, product: 1, name: "Lug 1".to_string(), rotation: [0.0; 3], position: [50.0, 0.0, 0.0] },
    ];
    let text = write_exchange(&request(vec![plate, lug], uses, 5, "mm")).unwrap().unwrap();
    // per product: a|b|c (shared by both positions) and a (the perpendicularity), each compartment once per frame (OCC wrote 6 and 14)
    assert_eq!(text.matches("DATUM_SYSTEM(").count(), 4, "one datum_system per frame and product");
    assert_eq!(text.matches("DATUM_REFERENCE_COMPARTMENT(").count(), 8);
    let tree = import_exchange(&text, options()).unwrap();
    for (name, [a, b, c]) in [("Plate", labels[0]), ("Lug", labels[1])] {
        let products = tree["products"].as_array().unwrap();
        let pmi = &products.iter().find(|entry| entry["name"] == json!(name)).unwrap()["pmi"];
        let tolerances = pmi["tolerances"].as_array().unwrap();
        let read: Vec<_> =
            tolerances.iter().map(|entry| (entry["characteristic"].clone(), entry["faces"].clone(), entry["datums"].clone())).collect();
        for expected in [
            (json!("position"), json!([1]), json!([a, b, c])),
            (json!("position"), json!([3]), json!([a, b, c])),
            (json!("perpendicularity"), json!([1]), json!([a])),
            (json!("flatness"), json!([5]), json!([])),
        ] {
            assert!(read.contains(&expected), "{expected:?} in {pmi}");
        }
        assert_eq!(pmi["datums"].as_array().unwrap().len(), 3, "{pmi}");
    }
    assert_eq!(tree["pmiUnmapped"], json!(0));
}
