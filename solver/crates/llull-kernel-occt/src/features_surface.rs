//! The surface half of the feature operations (03 WRP): exact faces of a plane / cylinder / cone / sphere / torus / B-spline surface trimmed by (u, v) loops, face slabs, emboss tools,
//! pcurve edges and the splitter. Its own cxx bridge over the declarations of `cpp/features.hxx` (implemented in `cpp/surfaces.cxx`), reusing the facade's opaque `Shape`.

use crate::{built, inner, Built, Shape};

// Generated FFI glue (unsafe by construction), like the bridge in lib.rs; no hand-written unsafe block.
#[allow(unsafe_code)]
#[cxx::bridge(namespace = "llull")]
mod ffi {
    unsafe extern "C++" {
        include!("llull-kernel-occt/cpp/features.hxx");

        type Shape = crate::ffi::Shape;

        fn surface_face(kind: i32, surface: &[f64], loops: &[f64]) -> Result<UniquePtr<Shape>>;
        fn face_slab(
            kind: i32,
            surface: &[f64],
            loops: &[f64],
            from: f64,
            to: f64,
            direction: &[f64],
            tolerance: f64,
        ) -> Result<UniquePtr<Shape>>;

        #[allow(clippy::too_many_arguments)]
        fn emboss_tools(
            kind: i32,
            surface: &[f64],
            regions: &[f64],
            from: f64,
            to: f64,
            direction: &[f64],
            tolerance: f64,
            faces_only: bool,
        ) -> Result<UniquePtr<Shape>>;
        fn pcurve_edge_tools(kind: i32, surface: &[f64], chains: &[f64]) -> Result<UniquePtr<Shape>>;
        fn face_edge_tools(source: &Shape, face_index: u32, chains: &[f64]) -> Result<UniquePtr<Shape>>;
        fn split_shape(source: &Shape, tools: &Shape) -> Result<UniquePtr<Shape>>;
    }
}

/// Exact face of a surface description (B-spline, plane, cylinder, cone, sphere, torus: see `cpp/features.hxx`) trimmed by (u, v) loops; `None` when OCC refuses.
pub fn surface_face(kind: i32, surface: &[f64], loops: &[f64]) -> Built {
    built(ffi::surface_face(kind, surface, loops))
}

/// Solid between the offsets `range` of such a face along `direction` (sewn base, offset face and ruled walls); `None` when OCC refuses.
pub fn face_slab(kind: i32, surface: &[f64], loops: &[f64], range: [f64; 2], direction: [f64; 3], tolerance: f64) -> Built {
    built(ffi::face_slab(kind, surface, loops, range[0], range[1], &direction, tolerance))
}

/// Tools of an emboss (03 WRP): a compound of one face-slab per region of `regions` (encoded as in `cpp/features.hxx`) between the offsets `range`, or with
/// `faces_only` of the trimmed faces themselves; `None` when OCC refuses.
pub fn emboss_tools(
    kind: i32,
    surface: &[f64],
    regions: &[f64],
    range: [f64; 2],
    direction: [f64; 3],
    tolerance: f64,
    faces_only: bool,
) -> Built {
    built(ffi::emboss_tools(kind, surface, regions, range[0], range[1], &direction, tolerance, faces_only))
}

/// Edges on a surface from open or closed (u, v) chains (encoded as in `cpp/features.hxx`): the tools of a split by curves; `None` when OCC refuses.
pub fn pcurve_edge_tools(kind: i32, surface: &[f64], chains: &[f64]) -> Built {
    built(ffi::pcurve_edge_tools(kind, surface, chains))
}

/// Edges on the surface of face `face` of `source` from (u, v) chains in that face's own parameters; `None` when OCC refuses.
pub fn face_edge_tools(source: &Shape, face: u32, chains: &[f64]) -> Built {
    built(ffi::face_edge_tools(inner(source)?, face, chains))
}

/// `source` divided by the faces or edges of `tools` that lie on it (same volume); `None` when the splitter fails.
pub fn split_shape(source: &Shape, tools: &Shape) -> Built {
    built(ffi::split_shape(inner(source)?, inner(tools)?))
}
