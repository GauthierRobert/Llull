//! Netgen 6.2 (nglib + ngcore, shared, from `solver/scripts/build-netgen.mjs`, linked dynamically) and the OCCT 7.9.2 it meshes, behind a
//! narrow cxx facade (`cpp/*.{hxx,cxx}`) for the FE mesher llull-mesh (docs/decisions/NG1-netgen-mesher.md).
//!
//! Rust sees an opaque [`Shape`] (an OCCT shape numbered like Netgen numbers it: faces, edges and solids are 1-based and a mesh element's
//! face / edge number is the B-rep face / edge it lies on) and coarse operations: import, fragment, defeature, distance queries, mesh.
//! Meshes are first order; every C++ throw comes back as an [`Error`].

use std::fmt;
use std::sync::{Mutex, MutexGuard};

pub use ffi::{MeshData, MeshParams, Sizes};

// cxx generates the FFI glue as unsafe code; this module is the only unsafe surface of the crate and holds no hand-written unsafe
// blocks (the workspace denies `unsafe_code`; the bridge crate lifts it locally, like llull-kernel-occt).
#[allow(unsafe_code)]
#[cxx::bridge(namespace = "llull_netgen")]
mod ffi {
    /// Netgen meshing parameters (MeshingParameters); lengths in the model unit.
    #[derive(Clone, Debug)]
    struct MeshParams {
        max_h: f64,
        min_h: f64,
        grading: f64,
        curvature_safety: f64,
        segments_per_edge: f64,
        optimize_steps_3d: i32,
        optimize_steps_2d: i32,
        /// Surface meshes: quadrilateral-dominated instead of triangles.
        quad_dominated: bool,
        /// Mesh the faces only (shell / midsurface parts).
        surface_only: bool,
        /// STL surfaces: dihedral angle (degrees) above which a facet edge is a geometric edge.
        stl_edge_angle: f64,
    }

    /// Local mesh sizes: `face_ids[i]` gets at most `face_sizes[i]` (same for edges); `points` = x, y, z, h quadruples.
    #[derive(Clone, Debug, Default)]
    struct Sizes {
        face_ids: Vec<i32>,
        face_sizes: Vec<f64>,
        edge_ids: Vec<i32>,
        edge_sizes: Vec<f64>,
        points: Vec<f64>,
    }

    /// A first-order mesh: `points` x, y, z per Netgen point (point numbers are 1-based), `tets` 4 points each with the solid they fill
    /// (`tet_domains`), `surface` 4 points per element (4th = 0 for a triangle) with its face (`surface_faces`), `segments` 2 points
    /// each with the edge they lie on (`segment_edges`; a segment is listed once per adjacent face).
    #[derive(Debug, Default)]
    struct MeshData {
        points: Vec<f64>,
        tets: Vec<i32>,
        tet_domains: Vec<i32>,
        surface: Vec<i32>,
        surface_faces: Vec<i32>,
        segments: Vec<i32>,
        segment_edges: Vec<i32>,
    }

    unsafe extern "C++" {
        include!("llull-netgen/cpp/facade.hxx");

        type Shape;
        type ShapeList;

        fn netgen_version() -> String;
        fn occt_version() -> String;

        fn read_step(path: &str, scale: f64) -> Result<UniquePtr<Shape>>;
        fn planar_faces(coords: &[f64], loop_sizes: &[u32], face_loops: &[u32], fuzzy: f64) -> Result<UniquePtr<Shape>>;
        fn new_shape_list() -> UniquePtr<ShapeList>;
        fn push_shape(list: Pin<&mut ShapeList>, shape: &Shape);
        fn fragment(list: &ShapeList) -> Result<UniquePtr<Shape>>;

        fn solid_count(self: &Shape) -> i32;
        fn face_count(self: &Shape) -> i32;
        fn edge_count(self: &Shape) -> i32;
        fn solid_faces(self: &Shape, solid: i32) -> Result<Vec<i32>>;
        fn face_edges(self: &Shape, face: i32) -> Result<Vec<i32>>;
        fn owners(self: &Shape, item: i32) -> Vec<i32>;
        fn bounds(self: &Shape) -> Result<Vec<f64>>;
        fn face_area(self: &Shape, face: i32) -> Result<f64>;
        fn face_centroid(self: &Shape, face: i32) -> Result<Vec<f64>>;
        fn face_distance(self: &Shape, face: i32, x: f64, y: f64, z: f64) -> Result<Vec<f64>>;
        fn edge_distance(self: &Shape, edge: i32, x: f64, y: f64, z: f64) -> Result<f64>;
        fn face_radius(self: &Shape, face: i32) -> Result<f64>;
        fn sample_face(self: &Shape, face: i32, spacing: f64) -> Result<Vec<f64>>;
        fn sample_edge(self: &Shape, edge: i32, spacing: f64) -> Result<Vec<f64>>;
        fn defeatured(self: &Shape, faces: &[i32]) -> Result<UniquePtr<Shape>>;

        fn mesh_shape(shape: &Shape, params: &MeshParams, sizes: &Sizes) -> Result<MeshData>;
        fn mesh_stl(facets: &[f64], params: &MeshParams, sizes: &Sizes) -> Result<MeshData>;
    }
}

pub type Point = [f64; 3];

/// A Netgen or OCCT failure, with the C++ message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(pub String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl From<cxx::Exception> for Error {
    fn from(error: cxx::Exception) -> Self {
        Self(error.what().to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// Netgen keeps process-wide state (shape properties, STL parameters, progress flags): one call at a time.
static NETGEN: Mutex<()> = Mutex::new(());

fn lock() -> MutexGuard<'static, ()> {
    NETGEN.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The Netgen release the facade was compiled against (e.g. "6.2.2604").
pub fn netgen_version() -> String {
    ffi::netgen_version()
}

pub fn occt_version() -> String {
    ffi::occt_version()
}

fn points_of(flat: &[f64]) -> Vec<Point> {
    flat.chunks_exact(3).map(|p| [p[0], p[1], p[2]]).collect()
}

fn present(shape: cxx::UniquePtr<ffi::Shape>) -> Result<Shape> {
    if shape.is_null() {
        Err(Error("the geometry kernel returned no shape".into()))
    } else {
        Ok(Shape(shape))
    }
}

/// An OCCT shape numbered like Netgen numbers it (faces, edges, solids 1..=count).
pub struct Shape(cxx::UniquePtr<ffi::Shape>);

impl Shape {
    /// A STEP file, every coordinate multiplied by `scale` about the origin.
    pub fn read_step(path: &str, scale: f64) -> Result<Self> {
        let _netgen = lock();
        present(ffi::read_step(path, scale)?)
    }

    /// Planar faces from polygon loops (see `planar_faces` in `cpp/facade.hxx`), fragmented together within `fuzzy`; [`Shape::owners`] of a
    /// face = the input faces it came from.
    pub fn planar_faces(coords: &[f64], loop_sizes: &[u32], face_loops: &[u32], fuzzy: f64) -> Result<Self> {
        let _netgen = lock();
        present(ffi::planar_faces(coords, loop_sizes, face_loops, fuzzy)?)
    }

    /// The solids of `parts` fragmented together (touching solids share faces); [`Shape::owners`] of a solid = indices into `parts`.
    pub fn fragment(parts: &[&Shape]) -> Result<Self> {
        let _netgen = lock();
        let mut list = ffi::new_shape_list();
        for part in parts {
            ffi::push_shape(list.pin_mut(), &part.0);
        }
        present(ffi::fragment(&list)?)
    }

    fn count(value: i32) -> usize {
        usize::try_from(value).unwrap_or(0)
    }

    pub fn solid_count(&self) -> usize {
        Self::count(self.0.solid_count())
    }

    pub fn face_count(&self) -> usize {
        Self::count(self.0.face_count())
    }

    pub fn edge_count(&self) -> usize {
        Self::count(self.0.edge_count())
    }

    pub fn solid_faces(&self, solid: i32) -> Result<Vec<i32>> {
        Ok(self.0.solid_faces(solid)?)
    }

    pub fn face_edges(&self, face: i32) -> Result<Vec<i32>> {
        Ok(self.0.face_edges(face)?)
    }

    /// Input indices a solid ([`Shape::fragment`]) or face ([`Shape::planar_faces`]) came from; empty otherwise.
    pub fn owners(&self, item: i32) -> Vec<i32> {
        self.0.owners(item)
    }

    /// `[min xyz, max xyz]` of the exact geometry.
    pub fn bounds(&self) -> Result<[f64; 6]> {
        let b = self.0.bounds()?;
        b.get(..6).and_then(|b| <[f64; 6]>::try_from(b).ok()).ok_or_else(|| Error("bounds: 6 numbers expected".into()))
    }

    pub fn face_area(&self, face: i32) -> Result<f64> {
        Ok(self.0.face_area(face)?)
    }

    pub fn face_centroid(&self, face: i32) -> Result<Point> {
        points_of(&self.0.face_centroid(face)?).first().copied().ok_or_else(|| Error("centroid: 3 numbers expected".into()))
    }

    /// Distance from `point` to the trimmed face and the closest point on it.
    pub fn face_distance(&self, face: i32, point: &Point) -> Result<(f64, Point)> {
        let out = self.0.face_distance(face, point[0], point[1], point[2])?;
        match out.as_slice() {
            [d, x, y, z] => Ok((*d, [*x, *y, *z])),
            _ => Err(Error("face distance: 4 numbers expected".into())),
        }
    }

    /// Distance from `point` to the trimmed edge.
    pub fn edge_distance(&self, edge: i32, point: &Point) -> Result<f64> {
        Ok(self.0.edge_distance(edge, point[0], point[1], point[2])?)
    }

    /// Radius of a cylinder face, minor radius of a torus face, 0 otherwise.
    pub fn face_radius(&self, face: i32) -> Result<f64> {
        Ok(self.0.face_radius(face)?)
    }

    /// Points over the face no further apart than `spacing` (fewer on a face too large for that spacing).
    pub fn sample_face(&self, face: i32, spacing: f64) -> Result<Vec<Point>> {
        Ok(points_of(&self.0.sample_face(face, spacing)?))
    }

    pub fn sample_edge(&self, edge: i32, spacing: f64) -> Result<Vec<Point>> {
        Ok(points_of(&self.0.sample_edge(edge, spacing)?))
    }

    /// The shape without `faces` (OCCT defeaturing); a new numbering.
    pub fn defeatured(&self, faces: &[i32]) -> Result<Shape> {
        let _netgen = lock();
        present(self.0.defeatured(faces)?)
    }

    /// Tetrahedra (or, with `params.surface_only`, surface elements) of the shape.
    pub fn mesh(&self, params: &MeshParams, sizes: &Sizes) -> Result<MeshData> {
        let _netgen = lock();
        Ok(ffi::mesh_shape(&self.0, params, sizes)?)
    }
}

/// Tetrahedra of a closed triangulated surface (9 coordinates per facet).
pub fn mesh_stl(facets: &[f64], params: &MeshParams, sizes: &Sizes) -> Result<MeshData> {
    let _netgen = lock();
    Ok(ffi::mesh_stl(facets, params, sizes)?)
}

#[cfg(test)]
mod tests;
