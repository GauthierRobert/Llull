//! `llull-compute post map <job-folder>` (PHY-04 TR-TMC-24): nodal values of a source tet mesh interpolated at every node of a target
//! mesh, a port of `mapNodalField` (`thermomech/mapping.ts`): the lowest-index containing element wins (`llull-bvh`), C3D4 / C3D10 shape
//! functions, a node outside every element takes the value at the nearest point of the nearest element. Target nodes run in parallel;
//! the report is reduced afterwards in node order, so it is identical to the sequential TypeScript.

use crate::life::js_max;
use crate::JobError;
use llull_bvh::geometry::{barycentric, closest_on_tet};
use llull_bvh::{Aabb, Bvh, Vec3};
use llull_jsmath::hypot;
use rayon::prelude::*;
use serde::Serialize;
use std::collections::HashMap;

/// Source mesh element: node ids (4 or 10, CalculiX order), corner coordinates and bounds.
struct Element {
    nodes: Vec<u64>,
    corners: [Vec3; 4],
    bounds: Aabb,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MappingReport {
    pub max_mapping_distance: f64,
    pub outside: usize,
    pub coincident_max_error: f64,
    pub coincident_nodes: usize,
}

/// Mapped value, source element index (0-based, mesh order) and distance moved, per target node.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MappedNode {
    pub value: f64,
    pub element: usize,
    pub distance: f64,
}

pub struct MapInput<'a> {
    /// `[id, x, y, z]` per source node.
    pub source_nodes: &'a [[f64; 4]],
    /// Source elements in block / element order, as node-id lists.
    pub source_elements: Vec<Vec<u64>>,
    /// Finite source values by node id.
    pub source_values: HashMap<u64, f64>,
    /// `[id, x, y, z]` per target node.
    pub target_nodes: &'a [[f64; 4]],
}

fn shape(l: &[f64; 4], nodes: usize) -> Vec<f64> {
    let [l1, l2, l3, l4] = *l;
    if nodes == 4 {
        return vec![l1, l2, l3, l4];
    }
    vec![
        l1 * (2.0 * l1 - 1.0),
        l2 * (2.0 * l2 - 1.0),
        l3 * (2.0 * l3 - 1.0),
        l4 * (2.0 * l4 - 1.0),
        4.0 * l1 * l2,
        4.0 * l2 * l3,
        4.0 * l3 * l1,
        4.0 * l1 * l4,
        4.0 * l2 * l4,
        4.0 * l3 * l4,
    ]
}

/// `x|y|z` key of a point as JavaScript strings compare it (-0 and +0 are the same key).
fn point_key(x: f64, y: f64, z: f64) -> [u64; 3] {
    let bits = |v: f64| if v == 0.0 { 0 } else { v.to_bits() };
    [bits(x), bits(y), bits(z)]
}

fn elements_of(input: &MapInput<'_>) -> Option<Vec<Element>> {
    let coordinates: HashMap<u64, Vec3> = input.source_nodes.iter().map(|n| (n[0] as u64, [n[1], n[2], n[3]])).collect();
    let mut out = Vec::with_capacity(input.source_elements.len());
    for nodes in &input.source_elements {
        if nodes.len() != 4 && nodes.len() != 10 {
            return None;
        }
        let points: Option<Vec<Vec3>> = nodes.iter().map(|id| coordinates.get(id).copied()).collect();
        let points = points?;
        let mut low = [f64::INFINITY; 3];
        let mut high = [f64::NEG_INFINITY; 3];
        for point in &points {
            for axis in 0..3 {
                low[axis] = low[axis].min(point[axis]);
                high[axis] = high[axis].max(point[axis]);
            }
        }
        out.push(Element { nodes: nodes.clone(), corners: [points[0], points[1], points[2], points[3]], bounds: Aabb { low, high } });
    }
    Some(out)
}

fn map_node(tree: &Bvh, elements: &[Element], values: &HashMap<u64, f64>, p: Vec3) -> Result<MappedNode, String> {
    let leaf = |item: usize| closest_on_tet(&elements[item].corners, &p);
    let Some(hit) = tree.nearest(&p, &leaf) else {
        return Err("no source element found for a target node".to_string());
    };
    let element = &elements[hit.item];
    let Some(l) = barycentric(&element.corners, &hit.point) else {
        return Err(format!("source element {} is degenerate", hit.item + 1));
    };
    let weights = shape(&l, element.nodes.len());
    let mut value = 0.0;
    for (i, node) in element.nodes.iter().enumerate() {
        match values.get(node) {
            Some(nodal) if nodal.is_finite() => value += weights[i] * nodal,
            _ => return Err(format!("the source has no finite value at node {node}")),
        }
    }
    Ok(MappedNode { value, element: hit.item, distance: hit.distance })
}

/// Every target node mapped, plus the report; `Err(message)` with the same refusal text as the TypeScript (first failing node).
pub fn map_field(input: &MapInput<'_>) -> Result<(Vec<MappedNode>, MappingReport), String> {
    let elements = match elements_of(input) {
        Some(elements) if !elements.is_empty() => elements,
        _ => return Err("the source mesh has no C3D4 / C3D10 elements with all their nodes".to_string()),
    };
    let boxes: Vec<Aabb> = elements.iter().map(|element| element.bounds).collect();
    let tree = Bvh::build(&boxes).ok_or_else(|| "the source mesh has no C3D4 / C3D10 elements with all their nodes".to_string())?;
    let mut low = [f64::INFINITY; 3];
    let mut high = [f64::NEG_INFINITY; 3];
    for node in input.source_nodes {
        for axis in 0..3 {
            low[axis] = low[axis].min(node[axis + 1]);
            high[axis] = high[axis].max(node[axis + 1]);
        }
    }
    let size = hypot(&[high[0] - low[0], high[1] - low[1], high[2] - low[2]]);
    let tolerance = 1e-9 * size;
    let mut exact: HashMap<[u64; 3], u64> = HashMap::with_capacity(input.source_nodes.len());
    for node in input.source_nodes {
        exact.insert(point_key(node[1], node[2], node[3]), node[0] as u64);
    }
    let mapped: Vec<Result<MappedNode, String>> =
        input.target_nodes.par_iter().map(|node| map_node(&tree, &elements, &input.source_values, [node[1], node[2], node[3]])).collect();
    let mut nodes = Vec::with_capacity(mapped.len());
    let mut report = MappingReport { max_mapping_distance: 0.0, outside: 0, coincident_max_error: 0.0, coincident_nodes: 0 };
    for (result, target) in mapped.into_iter().zip(input.target_nodes) {
        let node = result?;
        if node.distance > tolerance {
            report.outside += 1;
            report.max_mapping_distance = js_max(report.max_mapping_distance, node.distance);
        }
        if let Some(same) = exact.get(&point_key(target[1], target[2], target[3])) {
            report.coincident_nodes += 1;
            let source = input.source_values.get(same).copied().unwrap_or(f64::NAN);
            report.coincident_max_error = js_max(report.coincident_max_error, (node.value - source).abs());
        }
        nodes.push(node);
    }
    Ok((nodes, report))
}

/// Parses the flat element buffer: for each element its node count followed by its node ids.
pub fn parse_elements(flat: &[f64]) -> Result<Vec<Vec<u64>>, JobError> {
    let mut elements = Vec::new();
    let mut at = 0;
    while at < flat.len() {
        let count = flat[at] as usize;
        let end = at + 1 + count;
        if count == 0 || end > flat.len() {
            return Err(JobError::input(format!("source_elements.f64 is truncated at value {at}")));
        }
        elements.push(flat[at + 1..end].iter().map(|&id| id as u64).collect());
        at = end;
    }
    Ok(elements)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NODES: [[f64; 4]; 5] =
        [[1.0, 0.0, 0.0, 0.0], [2.0, 1.0, 0.0, 0.0], [3.0, 0.0, 1.0, 0.0], [4.0, 0.0, 0.0, 1.0], [5.0, 1.0, 1.0, 1.0]];

    fn input<'a>(targets: &'a [[f64; 4]]) -> MapInput<'a> {
        MapInput {
            source_nodes: &NODES,
            source_elements: vec![vec![1, 2, 3, 4], vec![2, 3, 4, 5]],
            source_values: NODES.iter().map(|n| (n[0] as u64, n[1] + 2.0 * n[2] + 3.0 * n[3])).collect(),
            target_nodes: targets,
        }
    }

    #[test]
    fn interpolates_linear_fields_exactly_and_projects_outside_nodes() {
        let targets = [[10.0, 0.25, 0.25, 0.25], [11.0, 0.0, 0.0, 0.0], [12.0, 0.25, 0.25, -1.0]];
        let (nodes, report) = map_field(&input(&targets)).unwrap();
        assert_eq!(nodes[0].value, 1.5);
        assert_eq!(nodes[0].element, 0);
        assert_eq!(nodes[1].value, 0.0);
        assert_eq!(nodes[2].distance, 1.0);
        assert_eq!(report, MappingReport { max_mapping_distance: 1.0, outside: 1, coincident_max_error: 0.0, coincident_nodes: 1 });
    }

    #[test]
    fn refusals_carry_the_reference_messages() {
        let targets = [[10.0, 0.25, 0.25, 0.25]];
        let mut bad = input(&targets);
        bad.source_elements = vec![vec![1, 2, 3]];
        assert!(map_field(&bad).unwrap_err().contains("no C3D4 / C3D10"));
        let mut missing = input(&targets);
        missing.source_values.remove(&1);
        assert_eq!(map_field(&missing).unwrap_err(), "the source has no finite value at node 1");
        let mut flat = input(&targets);
        flat.source_elements = vec![vec![1, 1, 1, 1]];
        assert_eq!(map_field(&flat).unwrap_err(), "source element 1 is degenerate");
        assert_eq!(parse_elements(&[4.0, 1.0, 2.0, 3.0, 4.0]).unwrap(), vec![vec![1, 2, 3, 4]]);
        assert!(parse_elements(&[4.0, 1.0]).is_err());
    }
}
