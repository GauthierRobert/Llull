//! Gmsh (4.x) for llull-mesh through its C API (`gmshc.h`), loaded at run time from the shared library the Gmsh SDK / `pip install
//! gmsh` ships (it carries its own OpenCASCADE). Loading at run time keeps the workspace buildable and testable without Gmsh; a
//! missing library is an `Err` the mesher reports as FEA_TOOL_MISSING.
//!
//! Search order ([`library_candidates`]): `LLULL_GMSH_LIB` (a file), the directory of the running executable and its `gmsh/lib`
//! subfolder (the desktop bundle), then the platform loader's own search by name (`LD_LIBRARY_PATH`, `/usr/local/lib`, PATH, ...).
//!
//! The FFI is the only unsafe code (`ffi`, `api`); the workspace denies `unsafe_code` and these modules lift it locally.

mod api;
mod ffi;

pub use api::{DimTag, Gmsh, GmshError, Result};

use std::path::{Path, PathBuf};

/// File names the platform loader is asked for when no file is found in the searched folders.
fn system_names() -> &'static [&'static str] {
    if cfg!(target_os = "windows") {
        &["gmsh-4.15.dll", "gmsh.dll"]
    } else if cfg!(target_os = "macos") {
        &["libgmsh.4.15.dylib", "libgmsh.dylib"]
    } else {
        &["libgmsh.so.4.15", "libgmsh.so.4", "libgmsh.so"]
    }
}

/// Whether `name` is a Gmsh shared library file of this platform.
fn is_gmsh_library(name: &str) -> bool {
    if cfg!(target_os = "windows") {
        name.starts_with("gmsh") && name.ends_with(".dll")
    } else if cfg!(target_os = "macos") {
        name.starts_with("libgmsh") && name.ends_with(".dylib")
    } else {
        name.starts_with("libgmsh.so")
    }
}

/// The Gmsh library in `dir` (the highest version name when several), if any.
fn library_in(dir: &Path) -> Option<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.is_file() && path.file_name().and_then(|name| name.to_str()).is_some_and(is_gmsh_library))
        .collect();
    found.sort();
    found.pop()
}

/// Where `load` looks, in order: explicit files and folders first, then bare names for the platform loader.
pub fn library_candidates(override_path: Option<&str>, executable_dir: Option<&Path>) -> Vec<String> {
    if let Some(path) = override_path.filter(|path| !path.is_empty()) {
        return vec![path.to_string()];
    }
    let mut candidates: Vec<String> = executable_dir
        .into_iter()
        .flat_map(|dir| [dir.to_path_buf(), dir.join("gmsh").join("lib"), dir.join("gmsh")])
        .filter_map(|dir| library_in(&dir))
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    candidates.extend(system_names().iter().map(|name| (*name).to_string()));
    candidates
}

/// Load Gmsh from the first candidate that resolves; the error names every attempt.
#[allow(unsafe_code)]
pub fn load() -> std::result::Result<Gmsh, String> {
    let override_path = std::env::var("LLULL_GMSH_LIB").ok();
    let executable_dir = std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf));
    let mut failures = Vec::new();
    for candidate in library_candidates(override_path.as_deref(), executable_dir.as_deref()) {
        // SAFETY: loading libgmsh runs its static initialisers only (C++ globals), no code of ours.
        match unsafe { libloading::Library::new(&candidate) } {
            Ok(library) => match ffi::Api::resolve(library) {
                Ok(api) => return Ok(Gmsh::new(api, candidate)),
                // an older Gmsh without a symbol llull-mesh calls: try the next candidate
                Err(error) => failures.push(format!("{candidate}: {error}")),
            },
            Err(error) => failures.push(format!("{candidate}: {error}")),
        }
    }
    Err(format!("the Gmsh library was not found or could not be loaded ({}); install Gmsh 4.x (it also needs its system libraries) or set LLULL_GMSH_LIB", failures.join("; ")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_override_is_the_only_candidate() {
        assert_eq!(library_candidates(Some("/opt/gmsh/libgmsh.so.4.15"), None), vec!["/opt/gmsh/libgmsh.so.4.15".to_string()]);
    }

    #[test]
    fn a_library_next_to_the_executable_comes_before_the_system_names() {
        let dir = std::env::temp_dir().join(format!("llull-gmsh-test-{}", std::process::id()));
        let lib = dir.join("gmsh").join("lib");
        std::fs::create_dir_all(&lib).unwrap();
        let name = system_names()[0];
        std::fs::write(lib.join(name), b"").unwrap();
        let candidates = library_candidates(None, Some(&dir));
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(candidates[0], lib.join(name).to_string_lossy());
        assert_eq!(&candidates[1..], system_names().iter().map(|name| name.to_string()).collect::<Vec<_>>().as_slice());
    }

    #[test]
    fn an_empty_override_is_ignored() {
        assert_eq!(library_candidates(Some(""), None).len(), system_names().len());
    }
}
