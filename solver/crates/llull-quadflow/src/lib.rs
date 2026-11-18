//! QuadriFlow (field-aligned quad remeshing, Huang et al., SGP 2018) behind a narrow cxx facade for `llull-meshops` (07 MSH M6).
//! The sources are vendored in `vendor/` (see `vendor/README.md` for the upstream commit, the licences and the changes made).
//!
//! The call is deterministic: QuadriFlow runs single-threaded here (no OpenMP, no TBB) and its random number generators are seeded.
//! QuadriFlow keeps process-wide random state (`srand` / `rand`): one call at a time, which [`quad_remesh`] enforces.

use std::fmt;
use std::sync::mpsc::{channel, Sender};
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
        /// Keep the boundary of an open mesh: boundary edges are treated as sharp edges (the quad edges follow them).
        preserve_boundary: bool,
    }

    /// An indexed quad mesh: `positions` x, y, z per vertex, `quads` four vertex indices each.
    #[derive(Debug, Default)]
    struct QuadMesh {
        positions: Vec<f64>,
        quads: Vec<u32>,
    }

    extern "Rust" {
        /// Where the C++ pipeline reports its stages (see [`quad_remesh_with_stages`]).
        type StageSink;
        fn report(self: &mut StageSink, stage: &str, fraction: f64);
    }

    unsafe extern "C++" {
        include!("llull-quadflow/cpp/facade.hxx");

        fn quad_remesh(positions: &[f64], triangles: &[u32], params: &QuadParams, sink: &mut StageSink) -> Result<QuadMesh>;
    }
}

/// The pipeline side of the stage channel: the C++ facade calls [`StageSink::report`] on the worker thread.
pub struct StageSink {
    sender: Sender<(String, f64)>,
}

impl StageSink {
    fn report(&mut self, stage: &str, fraction: f64) {
        let _ = self.sender.send((stage.to_string(), fraction));
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

/// Stack of the worker thread that runs the pipeline (QuadriFlow recurses over the hierarchy and the flow graph; the main thread's 1 MiB on Windows is small).
const WORKER_STACK_BYTES: usize = 256 * 1024 * 1024;

/// What QuadriFlow cannot survive: an empty mesh divides by zero and a zero-area triangle never terminates, both of which would end the
/// process instead of coming back as an [`Error`]. Refused here, before the C++ pipeline, with the first offender named.
fn input_problem(positions: &[f64], triangles: &[u32]) -> Option<String> {
    if positions.is_empty() || triangles.is_empty() {
        return Some("the mesh is empty".to_string());
    }
    if !positions.len().is_multiple_of(3) || !triangles.len().is_multiple_of(3) {
        return Some("positions and triangles must hold three values per vertex and per triangle".to_string());
    }
    if let Some(index) = positions.iter().position(|value| !value.is_finite()) {
        return Some(format!("vertex {} has a coordinate that is not a finite number", index / 3));
    }
    let vertices = positions.len() / 3;
    let point = |index: u32| -> [f64; 3] {
        let at = index as usize * 3;
        [positions[at], positions[at + 1], positions[at + 2]]
    };
    for (face, corner) in triangles.chunks_exact(3).enumerate() {
        if let Some(bad) = corner.iter().find(|&&index| index as usize >= vertices) {
            return Some(format!("triangle {face} names vertex {bad}, but the mesh has {vertices} vertices"));
        }
        let (a, b, c) = (point(corner[0]), point(corner[1]), point(corner[2]));
        let (u, v) = ([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
        let cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        if cross == [0.0, 0.0, 0.0] {
            return Some(format!("triangle {face} has no area (its three corners are on one line or coincide)"));
        }
    }
    None
}

/// Quad-remeshes the indexed triangle mesh (`positions` xyz per vertex, `triangles` three indices each): a manifold mesh with consistent
/// winding (the caller checks). An empty mesh, a non-finite coordinate, an out-of-range index and a zero-area triangle are refused here;
/// every C++ throw comes back as an [`Error`].
pub fn quad_remesh(positions: &[f64], triangles: &[u32], params: &QuadParams) -> Result<QuadMesh, Error> {
    quad_remesh_with_stages(positions, triangles, params, &mut |_, _| {})
}

/// [`quad_remesh`] that tells `on_stage(name, fraction)` when each stage of the pipeline starts (`fraction` = share of the whole run done by
/// then, 0 to 1; the shares are the measured wall-clock weights of the stages). `on_stage` runs on the calling thread while the pipeline
/// runs on a worker thread, so a caller can write each stage to its output as it happens. The result does not depend on `on_stage`.
pub fn quad_remesh_with_stages(
    positions: &[f64],
    triangles: &[u32],
    params: &QuadParams,
    on_stage: &mut dyn FnMut(&str, f64),
) -> Result<QuadMesh, Error> {
    if let Some(problem) = input_problem(positions, triangles) {
        return Err(Error(format!("quad_remesh refused: {problem}")));
    }
    let _guard = QUADFLOW.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let (sender, receiver) = channel();
    std::thread::scope(|scope| {
        let worker =
            std::thread::Builder::new().name("quadriflow".to_string()).stack_size(WORKER_STACK_BYTES).spawn_scoped(scope, move || {
                let mut sink = StageSink { sender };
                ffi::quad_remesh(positions, triangles, params, &mut sink).map_err(|error| Error(error.what().to_string()))
            });
        let Ok(worker) = worker else { return Err(Error("cannot start the QuadriFlow worker thread".to_string())) };
        for (stage, fraction) in receiver {
            on_stage(&stage, fraction);
        }
        worker.join().unwrap_or_else(|_| Err(Error("the QuadriFlow worker thread panicked".to_string())))
    })
}
