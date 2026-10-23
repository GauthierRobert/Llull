//! OCCT 7.9.2 (shared, from `solver/scripts/build-occt.mjs`, linked dynamically) behind a narrow cxx facade (`cpp/*.{hxx,cxx}`) for the native llull kernel (RS-1).
//!
//! The facade is coarse on purpose: Rust never touches OCCT classes, only opaque shapes and a dozen operations that mirror
//! `packages/kernel-occt` (the opencascade.js kernel), so both kernels build the same B-rep for the same recipe. Every C++ throw,
//! OCCT's `Standard_Failure` included, comes back as an `Err` (see the `trycatch` override in `facade.hxx`).
//! [`recipe`] evaluates llull `ShapeRecipe` JSON on top of it.

pub mod features;
pub mod lru;
pub mod mesh;
pub mod queries;
pub mod recipe;
pub mod xde;

/// Blend tests (fillet, chamfer, boolean tools) share OCCT builders that are not safe to run on several test threads at once (parallel runs
/// made fillets fail now and then); the sidecar itself is single-threaded. Each such test holds this guard.
#[cfg(test)]
pub(crate) fn serial_blends() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod blend_tests;
#[cfg(test)]
mod naming_tests;
#[cfg(test)]
mod wrap_tests;

pub use ffi::{AnalysisOut, MassOut, MeshOut};

// cxx generates the FFI glue as unsafe code; this module is the only unsafe surface of the kernel and holds no hand-written
// unsafe blocks (the workspace denies `unsafe_code`; RS1 §2 allows the bridge crate to lift it locally).
#[allow(unsafe_code)]
#[cxx::bridge(namespace = "llull")]
mod ffi {
    /// Display triangulation in world space, outward winding (one vertex list per face, not welded).
    struct MeshOut {
        positions: Vec<f64>,
        indices: Vec<u32>,
        missing_faces: u32,
        closed_solid: bool,
    }

    /// Unit-density mass properties; `inertia` = [Ixx, Iyy, Izz, Ixy, Ixz, Iyz] at the centroid, `bounds` = min xyz then max xyz.
    struct MassOut {
        volume: f64,
        area: f64,
        centroid: Vec<f64>,
        inertia: Vec<f64>,
        bounds: Vec<f64>,
        rel_error: f64,
    }

    /// BRepCheck validity, free faces / edges and one lump per solid: `lumps` = [volume, area, min xyz, max xyz] per solid.
    struct AnalysisOut {
        valid: bool,
        free_faces: i32,
        free_edges: i32,
        solids: i32,
        area: f64,
        lumps: Vec<f64>,
    }

    unsafe extern "C++" {
        include!("llull-kernel-occt/cpp/facade.hxx");

        type Shape;
        type StepWriter;

        fn init_runtime();
        fn occt_version() -> String;

        fn make_box(origin: &[f64], size: &[f64]) -> Result<UniquePtr<Shape>>;
        fn make_cylinder(radius: f64, height: f64) -> Result<UniquePtr<Shape>>;
        fn make_sphere(radius: f64) -> Result<UniquePtr<Shape>>;
        fn make_cone(base_radius: f64, top_radius: f64, height: f64) -> Result<UniquePtr<Shape>>;
        fn make_torus(ring_radius: f64, tube_radius: f64) -> Result<UniquePtr<Shape>>;
        fn make_prism(polygon: &[f64], direction: &[f64]) -> Result<UniquePtr<Shape>>;
        fn make_revolution(polygon: &[f64], axis: &[f64], angle: f64) -> Result<UniquePtr<Shape>>;
        fn make_sewn_solid(positions: &[f64], indices: &[u32]) -> Result<UniquePtr<Shape>>;

        fn placed(shape: &Shape, rotation: &[f64], position: &[f64], anchor_shift: &[f64]) -> Result<UniquePtr<Shape>>;
        fn scaled(shape: &Shape, factor: f64) -> Result<UniquePtr<Shape>>;
        fn gtransformed(shape: &Shape, matrix: &[f64], translation: &[f64]) -> Result<UniquePtr<Shape>>;
        fn boolean_op(a: &Shape, b: &Shape, operation: i32, unify: bool) -> Result<UniquePtr<Shape>>;
        fn prefixed(shape: &Shape, prefix: &str) -> Result<UniquePtr<Shape>>;

        fn tessellate(shape: &Shape, linear_deflection: f64, angular_deflection: f64) -> Result<MeshOut>;
        fn mass_properties(shape: &Shape) -> Result<MassOut>;
        fn analyze(shape: &Shape) -> Result<AnalysisOut>;

        fn new_step_writer() -> UniquePtr<StepWriter>;
        fn step_add(writer: Pin<&mut StepWriter>, shape: &Shape) -> Result<bool>;
        fn step_finish(writer: Pin<&mut StepWriter>) -> Result<String>;
    }
}

/// An exact OCCT shape owned by Rust.
pub struct Shape(cxx::UniquePtr<ffi::Shape>);

/// A C++ throw (OCCT `Standard_Failure`, bad argument) during an operation.
pub type OcctResult<T> = Result<T, String>;

/// A built shape, `None` when OCC refused the input without throwing (builder not done, invalid wire).
pub type Built = OcctResult<Option<Shape>>;

fn built(result: Result<cxx::UniquePtr<ffi::Shape>, cxx::Exception>) -> Built {
    match result {
        Ok(pointer) if pointer.is_null() => Ok(None),
        Ok(pointer) => Ok(Some(Shape(pointer))),
        Err(error) => Err(error.what().to_string()),
    }
}

fn inner(shape: &Shape) -> OcctResult<&ffi::Shape> {
    shape.0.as_ref().ok_or_else(|| "null shape".to_string())
}

fn occt<T>(result: Result<T, cxx::Exception>) -> OcctResult<T> {
    result.map_err(|error| error.what().to_string())
}

/// Sends OCCT's console output to stderr (stdout carries the protocol). Call once at start.
pub fn init_runtime() {
    ffi::init_runtime();
}

/// OCC_VERSION_COMPLETE of the linked OCCT, e.g. "7.9.2".
pub fn occt_version() -> String {
    ffi::occt_version()
}

/// Recipe-level boolean operation (`BooleanOp` in `packages/core/src/model/types.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BooleanOp {
    Union,
    Subtract,
    Intersect,
}

pub fn make_box(origin: [f64; 3], size: [f64; 3]) -> Built {
    built(ffi::make_box(&origin, &size))
}

pub fn make_cylinder(radius: f64, height: f64) -> Built {
    built(ffi::make_cylinder(radius, height))
}

pub fn make_sphere(radius: f64) -> Built {
    built(ffi::make_sphere(radius))
}

pub fn make_cone(base_radius: f64, top_radius: f64, height: f64) -> Built {
    built(ffi::make_cone(base_radius, top_radius, height))
}

pub fn make_torus(ring_radius: f64, tube_radius: f64) -> Built {
    built(ffi::make_torus(ring_radius, tube_radius))
}

/// Prism of the closed planar polygon `polygon` (x, y, z triples) swept along `direction`.
pub fn make_prism(polygon: &[f64], direction: [f64; 3]) -> Built {
    built(ffi::make_prism(polygon, &direction))
}

/// Revolution of the closed planar polygon about the axis through the origin along `axis`, by `angle` radians.
pub fn make_revolution(polygon: &[f64], axis: [f64; 3], angle: f64) -> Built {
    built(ffi::make_revolution(polygon, &axis, angle))
}

/// Triangles sewn into a shell and promoted to a solid (degenerate triangles skipped).
pub fn make_sewn_solid(positions: &[f64], indices: &[u32]) -> Built {
    built(ffi::make_sewn_solid(positions, indices))
}

/// Copy placed by llull's M = T · Rx · Ry · Rz · anchorShift.
pub fn placed(shape: &Shape, rotation: [f64; 3], position: [f64; 3], anchor_shift: [f64; 3]) -> Built {
    built(ffi::placed(inner(shape)?, &rotation, &position, &anchor_shift))
}

/// Uniform scale about the world origin.
pub fn scaled(shape: &Shape, factor: f64) -> Built {
    built(ffi::scaled(inner(shape)?, factor))
}

/// General affine map p -> M p + t (`matrix`: 9 numbers by rows): BRepBuilderAPI_GTransform, curved faces become B-splines (01 DEF).
pub fn gtransformed(shape: &Shape, matrix: [f64; 9], translation: [f64; 3]) -> Built {
    built(ffi::gtransformed(inner(shape)?, &matrix, &translation))
}

/// `a op b`, then (when `unify`) ShapeUpgrade_UnifySameDomain (face merging keeps indices stable).
pub fn boolean(op: BooleanOp, a: &Shape, b: &Shape, unify: bool) -> Built {
    let code = match op {
        BooleanOp::Union => 0,
        BooleanOp::Subtract => 1,
        BooleanOp::Intersect => 2,
    };
    built(ffi::boolean_op(inner(a)?, inner(b)?, code, unify))
}

/// The same shape with every persistent face name prefixed `<prefix>:` (SC-N1: a leaf names its faces after its entity id).
pub fn prefixed(shape: &Shape, prefix: &str) -> Built {
    built(ffi::prefixed(inner(shape)?, prefix))
}

pub fn tessellate(shape: &Shape, linear_deflection: f64, angular_deflection: f64) -> OcctResult<MeshOut> {
    occt(ffi::tessellate(inner(shape)?, linear_deflection, angular_deflection))
}

pub fn mass_properties(shape: &Shape) -> OcctResult<MassOut> {
    occt(ffi::mass_properties(inner(shape)?))
}

pub fn analyze(shape: &Shape) -> OcctResult<AnalysisOut> {
    occt(ffi::analyze(inner(shape)?))
}

/// ISO 10303-21 text of `shapes` (STEPControl_AsIs, one product per root shape); `None` when a transfer is refused.
pub fn export_step(shapes: &[&Shape]) -> OcctResult<Option<String>> {
    let mut writer = ffi::new_step_writer();
    for shape in shapes {
        let Some(pinned) = writer.as_mut() else { return Err("STEP writer not created".to_string()) };
        if !occt(ffi::step_add(pinned, inner(shape)?))? {
            return Ok(None);
        }
    }
    let Some(pinned) = writer.as_mut() else { return Err("STEP writer not created".to_string()) };
    occt(ffi::step_finish(pinned)).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit_box() -> Shape {
        make_box([0.0, 0.0, 0.0], [1.0, 2.0, 3.0]).unwrap().unwrap()
    }

    #[test]
    fn reports_the_linked_occt_version() {
        assert_eq!(occt_version(), "7.9.2");
    }

    #[test]
    fn box_mass_properties_are_exact() {
        let mass = mass_properties(&unit_box()).unwrap();
        assert!((mass.volume - 6.0).abs() < 1e-9);
        assert!((mass.area - 22.0).abs() < 1e-9);
        assert!((mass.centroid[2] - 1.5).abs() < 1e-9);
    }

    #[test]
    fn torus_inertia_matches_the_closed_form() {
        // VC-KRN-25: BRepGProp's adaptive (Eps) volume rule drifts on toroidal faces (3e-11 here, 2e-6 and Ixx != Iyy on the NIST
        // FTC-11 ring) while reporting ~1e-15; the default Gauss rule of the OCP 7.9.3 reference gives the closed form.
        let (big, small) = (40.0_f64, 8.0_f64);
        let mass = mass_properties(&make_torus(big, small).unwrap().unwrap()).unwrap();
        let volume = 2.0 * std::f64::consts::PI.powi(2) * big * small * small;
        let izz = volume * (big * big + 0.75 * small * small);
        let ixx = volume * (big * big / 2.0 + 0.625 * small * small);
        let relative = |value: f64, expected: f64| (value - expected).abs() / expected;
        assert!(relative(mass.volume, volume) < 1e-13, "volume {}", mass.volume);
        for (value, expected) in [(mass.inertia[0], ixx), (mass.inertia[1], ixx), (mass.inertia[2], izz)] {
            assert!(relative(value, expected) < 1e-13, "inertia {value} vs {expected}");
        }
        assert!(mass.rel_error.is_nan(), "the Gauss rule reports no error estimate");
    }

    #[test]
    fn empty_input_is_refused_and_bad_arguments_throw() {
        assert!(matches!(make_sewn_solid(&[], &[]), Ok(None)));
        assert!(make_prism(&[0.0, 0.0, 0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0]).is_err(), "a two-point polygon is an invalid argument");
    }

    #[test]
    fn an_occt_exception_becomes_an_error() {
        let thrown = make_box([0.0, 0.0, 0.0], [0.0, 1.0, 1.0]);
        assert!(thrown.is_err(), "a zero-size box raises Standard_DomainError");
    }

    #[test]
    fn subtract_removes_the_overlap() {
        let a = unit_box();
        let b = make_box([0.5, 0.0, 0.0], [1.0, 2.0, 3.0]).unwrap().unwrap();
        let cut = boolean(BooleanOp::Subtract, &a, &b, true).unwrap().unwrap();
        assert!((mass_properties(&cut).unwrap().volume - 3.0).abs() < 1e-9);
    }

    #[test]
    fn writes_step_text() {
        let text = export_step(&[&unit_box()]).unwrap().unwrap();
        assert!(text.starts_with("ISO-10303-21;"));
        assert!(text.contains("MANIFOLD_SOLID_BREP"));
    }

    #[test]
    fn analyzes_a_valid_closed_solid() {
        let report = analyze(&unit_box()).unwrap();
        assert!(report.valid);
        assert_eq!((report.solids, report.free_faces, report.free_edges), (1, 0, 0));
        assert_eq!(report.lumps.len(), 8);
    }
}
