//! Query and exchange operations of the native kernel (`cpp/queries.hxx`): exact topology, the face-query port (01 §5.9), distances,
//! STEP assemblies, STEP import + healing and B-rep blobs. The C++ side answers each query as JSON text in the WASM kernel's result
//! shape (`packages/kernel-occt`), parsed here once; `Value::Null` is the WASM kernel's null.
//!
//! Index rule (topology, face queries, fillet / chamfer edges): index k = the k-th distinct sub-shape (`IsSame`) in `TopExp_Explorer`
//! order, i.e. `TopExp::MapShapes` order, the same numbering as `uniqueSubShapes` in `packages/kernel-occt/src/occtTopology.ts`.

use crate::{inner, occt, OcctResult, Shape};
use serde_json::Value;

// Second cxx bridge of the crate (generated unsafe glue only, as in lib.rs); it reuses lib.rs's opaque `Shape`.
#[allow(unsafe_code)]
#[cxx::bridge(namespace = "llull")]
mod ffi {
    unsafe extern "C++" {
        include!("llull-kernel-occt/cpp/queries.hxx");

        type Shape = crate::ffi::Shape;
        type StepAssembly;

        fn topology_json(shape: &Shape) -> Result<String>;
        fn face_details_json(shape: &Shape, samples: i32) -> Result<String>;
        fn face_contains_json(shape: &Shape, face: i32, point: &[f64], tolerance: f64) -> Result<String>;
        fn face_graph_json(shape: &Shape) -> Result<String>;
        fn face_geometry_json(shape: &Shape, face: i32) -> Result<String>;
        fn project_on_face_json(shape: &Shape, face: i32, points: &[f64]) -> Result<String>;
        fn evaluate_face_json(shape: &Shape, face: i32, uv: &[f64]) -> Result<String>;
        fn face_samples_json(shape: &Shape, face: i32, uv: &[f64], nu: i32, nv: i32) -> Result<String>;
        fn point_distances_json(shape: &Shape, points: &[f64]) -> Result<String>;
        fn shape_distance_json(a: &Shape, b: &Shape) -> Result<String>;

        fn new_step_assembly() -> UniquePtr<StepAssembly>;
        fn assembly_part(assembly: Pin<&mut StepAssembly>) -> i32;
        fn assembly_add_shape(assembly: Pin<&mut StepAssembly>, part: i32, shape: &Shape) -> Result<()>;
        fn assembly_add_use(assembly: Pin<&mut StepAssembly>, parent: i32, part: i32, rotation: &[f64], position: &[f64]) -> Result<()>;
        fn assembly_write(assembly: Pin<&mut StepAssembly>) -> Result<String>;

        fn read_brep(text: &str) -> Result<UniquePtr<Shape>>;
        fn write_brep(shape: &Shape) -> Result<String>;
        fn import_step_json(text: &str, precision: f64, max_tolerance: f64, heal: bool, sew: bool) -> Result<String>;
    }
}

fn parsed(text: Result<String, cxx::Exception>) -> OcctResult<Value> {
    let text = occt(text)?;
    serde_json::from_str(&text).map_err(|error| format!("query facade answered unreadable JSON: {error}"))
}

/// A face / edge index as the facade takes it; `None` (the WASM kernel's null) for a negative, fractional or huge index.
fn index(value: f64) -> Option<i32> {
    (value.fract() == 0.0 && (0.0..=f64::from(i32::MAX)).contains(&value)).then_some(value as i32)
}

/// `ShapeTopology` (faces, edges, vertex and solid counts, volume).
pub fn topology(shape: &Shape) -> OcctResult<Value> {
    parsed(ffi::topology_json(inner(shape)?))
}

/// `faceDetails`: one located record per face with up to `samples` interior points.
pub fn face_details(shape: &Shape, samples: i32) -> OcctResult<Value> {
    parsed(ffi::face_details_json(inner(shape)?, samples))
}

pub fn face_contains(shape: &Shape, face: f64, point: [f64; 3], tolerance: f64) -> OcctResult<Value> {
    let Some(face) = index(face) else { return Ok(Value::Null) };
    parsed(ffi::face_contains_json(inner(shape)?, face, &point, tolerance))
}

pub fn face_graph(shape: &Shape) -> OcctResult<Value> {
    parsed(ffi::face_graph_json(inner(shape)?))
}

pub fn face_geometry(shape: &Shape, face: f64) -> OcctResult<Value> {
    let Some(face) = index(face) else { return Ok(Value::Null) };
    parsed(ffi::face_geometry_json(inner(shape)?, face))
}

/// `projectOnFace` of `points` (x, y, z triples).
pub fn project_on_face(shape: &Shape, face: f64, points: &[f64]) -> OcctResult<Value> {
    let Some(face) = index(face) else { return Ok(Value::Null) };
    parsed(ffi::project_on_face_json(inner(shape)?, face, points))
}

/// `evaluateFace` at `uv` (u, v pairs).
pub fn evaluate_face(shape: &Shape, face: f64, uv: &[f64]) -> OcctResult<Value> {
    let Some(face) = index(face) else { return Ok(Value::Null) };
    parsed(ffi::evaluate_face_json(inner(shape)?, face, uv))
}

/// Where `faceSamples` samples: explicit (u, v) pairs or the cell centres of an `nu` x `nv` grid over the face's uv box.
pub enum UvRequest<'a> {
    Pairs(&'a [f64]),
    Grid { nu: i32, nv: i32 },
}

pub fn face_samples(shape: &Shape, face: f64, request: UvRequest<'_>) -> OcctResult<Value> {
    let Some(face) = index(face) else { return Ok(Value::Null) };
    let (uv, nu, nv) = match request {
        UvRequest::Pairs(uv) => (uv, 0, 0),
        UvRequest::Grid { nu, nv } if nu >= 1 && nv >= 1 => (&[][..], nu, nv),
        UvRequest::Grid { .. } => return Ok(Value::Null),
    };
    parsed(ffi::face_samples_json(inner(shape)?, face, uv, nu, nv))
}

/// Port `distance`: per point the distance to the boundary, negative inside a solid, and the nearest face (-1 on an edge / vertex).
pub fn point_distances(shape: &Shape, points: &[f64]) -> OcctResult<Value> {
    parsed(ffi::point_distances_json(inner(shape)?, points))
}

/// `GeometryKernel.distance`: minimum distance, the two nearest points and whether one shape contains the other.
pub fn shape_distance(a: &Shape, b: &Shape) -> OcctResult<Value> {
    parsed(ffi::shape_distance_json(inner(a)?, inner(b)?))
}

/// One placed use of a part (`StepOccurrence`): `part` indexes [`AssemblyPart`]s, `rotation` radians then `position`.
#[derive(Debug, Clone, PartialEq)]
pub struct PartUse {
    pub part: usize,
    pub rotation: [f64; 3],
    pub position: [f64; 3],
}

/// A STEP product (`StepAssemblyPart`): its solids and the placed uses of other parts inside it.
pub struct AssemblyPart<'a> {
    pub shapes: Vec<&'a Shape>,
    pub children: Vec<PartUse>,
}

/// STEP text of a root assembly (`exportStepAssembly`): each part written once, children before the parts that use them;
/// `None` when the transfer is refused or the parts reference each other in a cycle.
pub fn export_step_assembly(parts: &[AssemblyPart<'_>], occurrences: &[PartUse]) -> OcctResult<Option<String>> {
    let mut assembly = ffi::new_step_assembly();
    let mut built: Vec<Option<i32>> = vec![None; parts.len()];
    let mut visiting = vec![false; parts.len()];
    for occurrence in occurrences {
        let Some(id) = build_part(&mut assembly, parts, occurrence.part, &mut built, &mut visiting)? else { return Ok(None) };
        let Some(pinned) = assembly.as_mut() else { return Err("STEP assembly not created".to_string()) };
        occt(ffi::assembly_add_use(pinned, -1, id, &occurrence.rotation, &occurrence.position))?;
    }
    let Some(pinned) = assembly.as_mut() else { return Err("STEP assembly not created".to_string()) };
    let text = occt(ffi::assembly_write(pinned))?;
    Ok((!text.is_empty()).then_some(text))
}

/// Builds `index` (children first: a compound cannot change once it is used); `None` for an unknown index or a cycle.
fn build_part(
    assembly: &mut cxx::UniquePtr<ffi::StepAssembly>,
    parts: &[AssemblyPart<'_>],
    index: usize,
    built: &mut [Option<i32>],
    visiting: &mut [bool],
) -> OcctResult<Option<i32>> {
    let Some(part) = parts.get(index) else { return Ok(None) };
    if let Some(id) = built[index] {
        return Ok(Some(id));
    }
    if visiting[index] {
        return Ok(None);
    }
    visiting[index] = true;
    let mut children = Vec::with_capacity(part.children.len());
    for child in &part.children {
        let Some(id) = build_part(assembly, parts, child.part, built, visiting)? else { return Ok(None) };
        children.push((id, child));
    }
    let Some(mut pinned) = assembly.as_mut() else { return Err("STEP assembly not created".to_string()) };
    let id = ffi::assembly_part(pinned.as_mut());
    for shape in &part.shapes {
        occt(ffi::assembly_add_shape(pinned.as_mut(), id, inner(shape)?))?;
    }
    for (child, placement) in children {
        occt(ffi::assembly_add_use(pinned.as_mut(), id, child, &placement.rotation, &placement.position))?;
    }
    built[index] = Some(id);
    Ok(Some(id))
}

/// The shape a `BRepTools::Write` text describes (a document blob); `None` when OCCT reads nothing.
pub fn read_brep(text: &str) -> OcctResult<Option<Shape>> {
    match ffi::read_brep(text) {
        Ok(pointer) if pointer.is_null() => Ok(None),
        Ok(pointer) => Ok(Some(Shape(pointer))),
        Err(error) => Err(error.what().to_string()),
    }
}

/// `BRepTools::Write` text (legacy V1 format, readable by every OCCT version) of `shape`.
pub fn write_brep(shape: &Shape) -> OcctResult<String> {
    occt(ffi::write_brep(inner(shape)?))
}

/// Healing options of `importShapes` (`ImportShapesOptions`, lengths in mm).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ImportOptions {
    pub precision: f64,
    pub max_tolerance: f64,
    pub heal: bool,
    pub sew: bool,
}

/// `importShapes('step', …)`: healed solids with their blob text and report, or `{ error, detail }`.
pub fn import_step(text: &str, options: ImportOptions) -> OcctResult<Value> {
    parsed(ffi::import_step_json(text, options.precision, options.max_tolerance, options.heal, options.sew))
}

#[cfg(test)]
#[path = "queries_tests.rs"]
mod tests;
