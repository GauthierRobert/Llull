//! Native vs TypeScript reference (VC-FAT-43 / VC-TMC-10 at crate level): the fixtures are written by
//! `tests/unit/native/nativeReference.test.ts` from the TS code; every number must be identical (bit for bit).

use llull_post::fatigue::{self, FatigueJob};
use llull_post::map::{map_field, MapInput};
use llull_post::rainflow::{count_cycles, CountingMethod, ResidueRule};
use llull_post::stress::{max_principal, signed_von_mises, Tensor};
use serde_json::Value;
use std::collections::HashMap;

fn fixture(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn numbers(value: &Value) -> Vec<f64> {
    value.as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect()
}

fn rows<const N: usize>(value: &Value) -> Vec<[f64; N]> {
    value.as_array().unwrap().iter().map(|row| std::array::from_fn(|i| row[i].as_f64().unwrap())).collect()
}

fn same(actual: f64, expected: f64) -> bool {
    actual.to_bits() == expected.to_bits() || (actual == 0.0 && expected == 0.0)
}

#[test]
fn rainflow_cycles_are_identical() {
    let cases = fixture("rainflow.json");
    for case in cases.as_array().unwrap() {
        let method: CountingMethod = serde_json::from_value(case["method"].clone()).unwrap();
        let residue: ResidueRule = serde_json::from_value(case["residue"].clone()).unwrap();
        let cycles = count_cycles(&numbers(&case["series"]), method, residue, case["gate"].as_f64().unwrap());
        let expected = rows::<5>(&case["cycles"]);
        assert_eq!(cycles.len(), expected.len(), "{method:?} {residue:?}");
        for (cycle, row) in cycles.iter().zip(&expected) {
            assert_eq!([cycle.from, cycle.to, cycle.range, cycle.mean, cycle.count], *row);
        }
    }
}

#[test]
fn stress_measures_are_identical() {
    let cases = fixture("stress.json");
    for (index, row) in rows::<8>(&cases).iter().enumerate() {
        let tensor: Tensor = std::array::from_fn(|i| row[i]);
        assert!(same(max_principal(&tensor), row[6]), "case {index}: max principal {} vs {}", max_principal(&tensor), row[6]);
        assert!(same(signed_von_mises(&tensor), row[7]), "case {index}: signed von Mises {} vs {}", signed_von_mises(&tensor), row[7]);
    }
}

#[test]
fn fatigue_fields_are_identical_for_every_node() {
    let cases = fixture("fatigue_jobs.json");
    for case in cases.as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let job: FatigueJob = serde_json::from_value(case["job"].clone()).unwrap();
        let field = fatigue::run(&job, &numbers(&case["tensors"])).unwrap();
        let expected = numbers(&case["field"]);
        assert_eq!(field.len(), expected.len(), "{name}");
        for (index, (actual, wanted)) in field.iter().zip(&expected).enumerate() {
            assert!(same(*actual, *wanted), "{name}: node {} component {}: {actual} vs {wanted}", index / 4, index % 4);
        }
    }
}

#[test]
fn fatigue_fields_do_not_depend_on_the_thread_count() {
    let cases = fixture("fatigue_jobs.json");
    let case = &cases[0];
    let job: FatigueJob = serde_json::from_value(case["job"].clone()).unwrap();
    let tensors = numbers(&case["tensors"]);
    let single = rayon::ThreadPoolBuilder::new().num_threads(1).build().unwrap().install(|| fatigue::run(&job, &tensors).unwrap());
    let many = rayon::ThreadPoolBuilder::new().num_threads(4).build().unwrap().install(|| fatigue::run(&job, &tensors).unwrap());
    assert_eq!(single, many);
}

#[test]
fn mapped_fields_are_identical() {
    let cases = fixture("map.json");
    for case in cases.as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let source_nodes = rows::<4>(&case["sourceNodes"]);
        let target_nodes = rows::<4>(&case["targetNodes"]);
        let source_elements: Vec<Vec<u64>> = case["sourceElements"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e.as_array().unwrap().iter().map(|id| id.as_u64().unwrap()).collect())
            .collect();
        let source_values: HashMap<u64, f64> = rows::<2>(&case["sourceValues"]).into_iter().map(|[id, v]| (id as u64, v)).collect();
        let input = MapInput { source_nodes: &source_nodes, source_elements, source_values, target_nodes: &target_nodes };
        let (nodes, report) = map_field(&input).unwrap();
        let (values, elements, distances) = (numbers(&case["values"]), numbers(&case["elements"]), numbers(&case["distances"]));
        for (index, node) in nodes.iter().enumerate() {
            assert_eq!(node.element as f64, elements[index], "{name}: element of target node {index}");
            assert!(same(node.value, values[index]), "{name}: value of target node {index}: {} vs {}", node.value, values[index]);
            assert!(same(node.distance, distances[index]), "{name}: distance of target node {index}");
        }
        let wanted = &case["report"];
        assert_eq!(report.outside as u64, wanted["outside"].as_u64().unwrap(), "{name}");
        assert_eq!(report.coincident_nodes as u64, wanted["coincidentNodes"].as_u64().unwrap(), "{name}");
        assert!(same(report.max_mapping_distance, wanted["maxMappingDistance"].as_f64().unwrap()), "{name}");
        assert!(same(report.coincident_max_error, wanted["coincidentMaxError"].as_f64().unwrap()), "{name}");
    }
}
