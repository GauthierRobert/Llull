//! QuadriFlow (field-aligned quad remeshing, Huang et al., SGP 2018) behind a narrow cxx facade for `llull-meshops` (07 MSH M6).
//! The sources are vendored in `vendor/` (see `vendor/README.md` for the upstream commit, the licences and the changes made).
//!
//! The call is deterministic: QuadriFlow runs single-threaded here (no OpenMP, no TBB) and its random number generators are seeded.
//! QuadriFlow keeps process-wide random state (`srand` / `rand`): one call at a time, which [`quad_remesh`] enforces.

use std::fmt;
use std::sync::Mutex;

pub use ffi::{QuadMesh, QuadParams};

// cxx generates the FFI glue as unsafe code; this module is the only unsafe surface of the crate and holds no hand-written unsafe
// blocks (the workspace denies `unsafe_code`; the bridge crate lifts it locally, like llull-netgen).
#[allow(unsafe_code)]
#[cxx::bridge(namespace = "llull_quadflow")]
mod ffi {
    /// QuadriFlow options (upstream command-line flags `-f`, `-sharp`, `-adaptive`). `target_faces` is the wanted number of output quads (<= 0: about one per vertex).
    #[derive(Clone, Debug)]
    struct QuadParams {
        target_faces: i32,
        /// Align quads to edges whose dihedral cosine is below `sharp_cos`.
        preserve_sharp: bool,
        sharp_cos: f64,
        /// Smaller quads where the surface curves more.
        adaptive: bool,
    }

    /// An indexed quad mesh: `positions` x, y, z per vertex, `quads` four vertex indices each.
    #[derive(Debug, Default)]
    struct QuadMesh {
        positions: Vec<f64>,
        quads: Vec<u32>,
    }

    unsafe extern "C++" {
        include!("llull-quadflow/cpp/facade.hxx");

        fn quad_remesh(positions: &[f64], triangles: &[u32], params: &QuadParams) -> Result<QuadMesh>;
    }
}

/// A QuadriFlow failure, with the C++ message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(pub String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

static QUADFLOW: Mutex<()> = Mutex::new(());

/// Quad-remeshes the indexed triangle mesh (`positions` xyz per vertex, `triangles` three indices each): a manifold mesh with consistent
/// winding and no degenerate face (the caller checks). Every C++ throw comes back as an [`Error`].
pub fn quad_remesh(positions: &[f64], triangles: &[u32], params: &QuadParams) -> Result<QuadMesh, Error> {
    let _guard = QUADFLOW.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    ffi::quad_remesh(positions, triangles, params).map_err(|error| Error(error.what().to_string()))
}
