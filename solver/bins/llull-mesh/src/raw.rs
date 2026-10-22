//! The per-part result the meshers hand to the assembly (`assemble.rs`): mesh in Gmsh tags of one model + resolved targets.

use crate::common::Point;
use serde_json::Value;
use std::collections::{BTreeSet, HashMap, HashSet};

/// One target resolved on one part, in Gmsh tags.
#[derive(Debug, Default)]
pub struct Resolved {
    /// Face regions (solids) / mid surfaces (shells).
    pub faces: BTreeSet<i32>,
    /// Shells: pressure side per mid surface (1 = +normal side, 2 = below), in resolution order.
    pub labels: Vec<(i32, i32)>,
    pub edges: BTreeSet<i32>,
    pub residual: f64,
    /// `pointsNear`, scaled to the analysis unit.
    pub points: Vec<Point>,
}

/// Target key -> resolution, in target order.
pub type ResolvedTargets = Vec<(String, Resolved)>;

/// A local size reduction near resolved faces / curves / points.
pub struct Refinement {
    pub size: f64,
    pub surfaces: Vec<i32>,
    pub curves: Vec<i32>,
    pub points: Vec<Point>,
}

pub struct RawMesh {
    pub coords: HashMap<usize, Point>,
    /// `(CalculiX element type, rows of Gmsh node tags)`.
    pub blocks: Vec<(String, Vec<Vec<usize>>)>,
    pub resolved: ResolvedTargets,
    pub region_nodes: HashMap<i32, HashSet<usize>>,
    /// Region -> `(element position in this part, CalculiX face label)`.
    pub region_faces: HashMap<i32, Vec<(usize, i32)>>,
    pub curve_nodes: HashMap<i32, HashSet<usize>>,
    /// Shells: target key -> `(element position, pressure side)`; replaces the region faces of that target.
    pub target_faces: Option<HashMap<String, Vec<(usize, i32)>>>,
    pub defeatured: Vec<i32>,
    pub face_map: Vec<Value>,
}

/// Every node of the current model on curve `(1, tag)` including its end points, for every curve.
pub fn curve_nodes(gmsh: &llull_gmsh::Gmsh) -> crate::common::MeshResult<HashMap<i32, HashSet<usize>>> {
    let mut out = HashMap::new();
    for (_, curve) in gmsh.entities(1)? {
        out.insert(curve, gmsh.nodes(1, curve, true)?.0.into_iter().collect());
    }
    Ok(out)
}
