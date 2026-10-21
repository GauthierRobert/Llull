//! `llull-mesh`: the llull FE mesher. Reads ONE mesh request (JSON) on stdin and writes ONE response line (JSON) on stdout; the
//! request / response are those of the Python bridge op `mesh` it replaces (server/src/fea/feaMesh.ts builds the request):
//!
//!   request  {"lengthScale", "parts": [{"entityId", "geometry": {"kind": "step"|"stl"|"midsurface", ...}, "faces"?, "defeature"?}],
//!             "targets": [{"key", "entityId"|null, "facesNear"?, "faceIndices"?, "edgesNear"?, "pointsNear"?}],
//!             "controls": {"order", "elementFamily"?, "bonding"?, "globalSize", "minSize"?, "refinements": [{"key", "size"}]}}
//!   response {"ok": true, "mesher": "gmsh", "mesherVersion", "nodes", "blocks", "nodeSets", "faceSets", "targets", "faceMap", "defeatured"}
//!            | {"ok": false, "code"?: "FEA_*", "error"}
//!
//! Lengths come in document units and leave in the analysis unit (`lengthScale`). Gmsh is loaded at run time (`llull-gmsh`); without it
//! the answer is FEA_TOOL_MISSING. `llull-mesh --version` prints the version and, when found, the Gmsh version and library.

mod assemble;
mod common;
mod conformal;
mod fields;
mod raw;
mod shell;
mod solid;

use common::MeshError;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::process::ExitCode;

fn version_line() -> String {
    let gmsh = llull_gmsh::load().and_then(|gmsh| {
        gmsh.initialize().map_err(|error| error.to_string())?;
        let version = gmsh.get_string("General.Version").map_err(|error| error.to_string());
        let _ = gmsh.finalize();
        version.map(|version| format!("Gmsh {version}, {}", gmsh.library))
    });
    match gmsh {
        Ok(gmsh) => format!("llull-mesh {} ({gmsh})", env!("CARGO_PKG_VERSION")),
        Err(error) => format!("llull-mesh {} (no Gmsh: {error})", env!("CARGO_PKG_VERSION")),
    }
}

fn failure(error: MeshError) -> Value {
    match error.code {
        Some(code) => json!({ "ok": false, "code": code, "error": error.message }),
        None => json!({ "ok": false, "error": error.message }),
    }
}

/// A private scratch folder for the geometry files Gmsh imports (removed afterwards): created new (an existing path is refused, so a
/// planted folder or link is never used), owner-only on Unix.
fn scratch_dir() -> Result<std::path::PathBuf, MeshError> {
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let dir = std::env::temp_dir().join(format!("llull-mesh-{}-{stamp}", std::process::id()));
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(&dir).map_err(|error| MeshError { code: None, message: format!("cannot create {}: {error}", dir.display()) })?;
    Ok(dir)
}

fn respond(input: &str) -> Value {
    let request: Value = match serde_json::from_str(input) {
        Ok(request) => request,
        Err(error) => return failure(common::malformed(&error.to_string())),
    };
    let gmsh = match llull_gmsh::load() {
        Ok(gmsh) => gmsh,
        Err(error) => return failure(MeshError::new("FEA_TOOL_MISSING", error)),
    };
    let workdir = match scratch_dir() {
        Ok(dir) => dir,
        Err(error) => return failure(error),
    };
    let result = gmsh.initialize().map_err(MeshError::from).and_then(|()| {
        let response = assemble::mesh(&gmsh, &request, &workdir);
        let _ = gmsh.finalize();
        response
    });
    let _ = std::fs::remove_dir_all(&workdir);
    result.unwrap_or_else(failure)
}

fn main() -> ExitCode {
    if std::env::args().skip(1).any(|arg| arg == "--version") {
        println!("{}", version_line());
        return ExitCode::SUCCESS;
    }
    let mut input = String::new();
    if let Err(error) = std::io::stdin().read_to_string(&mut input) {
        eprintln!("llull-mesh: cannot read the request: {error}");
        return ExitCode::from(2);
    }
    let response = respond(&input);
    let mut out = std::io::stdout().lock();
    // a leading newline keeps the response on its own line even if Gmsh wrote to stdout; the host parses the last line
    if writeln!(out, "\n{response}").and_then(|()| out.flush()).is_err() {
        return ExitCode::from(1);
    }
    ExitCode::SUCCESS
}
