use super::tests::{block, options, product, request, serial};
use super::*;
use crate::make_box;
use serde_json::json;

fn plate_pmi() -> ExchangePmi {
    ExchangePmi {
        datums: vec![("A".to_string(), vec![4])],
        tolerances: vec![
            PmiTolerance { characteristic: "flatness".to_string(), value: 0.05, diameter_zone: false, faces: vec![5], datums: vec![] },
            PmiTolerance {
                characteristic: "position".to_string(),
                value: 0.2,
                diameter_zone: true,
                faces: vec![3],
                datums: vec!["A".to_string()],
            },
        ],
        dimensions: vec![PmiDimension {
            kind: "location_linear_distance".to_string(),
            value: 10.0,
            tolerance: Some((0.1, 0.2)),
            faces: vec![0],
            faces_second: vec![1],
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
