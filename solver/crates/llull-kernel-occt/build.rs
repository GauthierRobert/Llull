//! Compiles the cxx facade (every `cpp/*.cxx`) against a SHARED OCCT 7.9.2 and links it dynamically (LGPL-2.1, RS1 §2 rule 7).
//!
//! OCCT comes from `solver/scripts/build-occt.mjs` (pinned source + cmake recipe, about an hour on 4 cores the first time): its
//! install prefix (`include/opencascade`, `lib/`) is `LLULL_OCCT_DIR`, else the script's per-user default prefix. Nothing is built
//! here. The prefix's `lib/` is exported to dependents as `DEP_OCCT_LIB_DIR` (`links = "occt"`): binaries set their runtime search
//! path from it (`solver/bins/llull-kernel/build.rs`).

use std::path::{Path, PathBuf};

const OCCT_VERSION: &str = "7.9.2";

/// The OCCT toolkits the facade links (dynamic: order does not matter). The ONE list; `build-occt.mjs` TOOLKITS builds them.
/// TKXCAF's own dependencies (TKVCAF, TKV3d, TKService, TKHLR) load transitively and need no entry here.
const OCCT_LIBS: &[&str] = &[
    "TKernel",
    "TKMath",
    "TKG2d",
    "TKG3d",
    "TKGeomBase",
    "TKBRep",
    "TKGeomAlgo",
    "TKTopAlgo",
    "TKPrim",
    "TKBO",
    "TKBool",
    "TKFillet",
    "TKOffset",
    "TKFeat",
    "TKMesh",
    "TKShHealing",
    "TKXSBase",
    "TKDE",
    "TKDESTEP",
    "TKDEIGES",
    "TKCDF",
    "TKLCAF",
    "TKCAF",
    "TKXCAF",
];

/// Rust modules holding a `#[cxx::bridge]`.
const BRIDGES: [&str; 3] = ["src/lib.rs", "src/features.rs", "src/queries.rs"];

/// Mirrors `defaultOcctPrefix()` of `solver/scripts/build-occt.mjs`.
fn default_prefix() -> Option<PathBuf> {
    let env_dir = |name: &str| std::env::var_os(name).filter(|value| !value.is_empty()).map(PathBuf::from);
    let home = env_dir("HOME").or_else(|| env_dir("USERPROFILE"));
    let base = match std::env::var("CARGO_CFG_TARGET_OS").as_deref() {
        Ok("macos") => home.map(|home| home.join("Library").join("Caches")),
        Ok("windows") => env_dir("LOCALAPPDATA").or_else(|| home.map(|home| home.join("AppData").join("Local"))),
        _ => env_dir("XDG_CACHE_HOME").or_else(|| home.map(|home| home.join(".cache"))),
    }?;
    Some(base.join("llull").join(format!("occt-{OCCT_VERSION}")))
}

fn occt_root() -> PathBuf {
    for name in ["LLULL_OCCT_DIR", "HOME", "XDG_CACHE_HOME", "LOCALAPPDATA"] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    let root = std::env::var_os("LLULL_OCCT_DIR").filter(|value| !value.is_empty()).map(PathBuf::from).or_else(default_prefix);
    match root {
        Some(root) if root.join("include").exists() && root.join("lib").exists() => root,
        other => panic!(
            "OCCT {OCCT_VERSION} (shared) not found at {}: run `node solver/scripts/build-occt.mjs` (or set LLULL_OCCT_DIR to its install prefix)",
            other.map_or_else(|| "<no home directory>".to_owned(), |path| path.display().to_string())
        ),
    }
}

fn facade_sources() -> Vec<PathBuf> {
    let mut sources: Vec<PathBuf> = std::fs::read_dir("cpp")
        .expect("cpp/ directory")
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().is_some_and(|extension| extension == "cxx" || extension == "hxx"))
        .collect();
    sources.sort();
    sources
}

fn has_library(lib_dir: &Path, name: &str) -> bool {
    ["lib{}.so", "lib{}.dylib", "{}.lib"].iter().any(|pattern| lib_dir.join(pattern.replace("{}", name)).exists())
}

fn main() {
    let root = occt_root();
    let lib_dir = root.join("lib");
    let include_dir = root.join("include").join("opencascade");
    let include_dir = if include_dir.exists() { include_dir } else { root.join("include") };

    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    for name in OCCT_LIBS {
        assert!(has_library(&lib_dir, name), "OCCT toolkit {name} missing in {} (rebuild with build-occt.mjs)", lib_dir.display());
        println!("cargo:rustc-link-lib=dylib={name}");
    }
    // Consumed by dependents' build scripts as DEP_OCCT_LIB_DIR / DEP_OCCT_BIN_DIR (runtime search path, Windows DLLs).
    println!("cargo:lib_dir={}", lib_dir.display());
    println!("cargo:bin_dir={}", root.join("bin").display());
    // This crate's own unit tests find the shared toolkits through an absolute runtime path.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", lib_dir.display());
    }

    // Every cpp/*.cxx translation unit (sorted, reproducible); one cxx bridge per Rust module that declares one.
    let sources = facade_sources();
    let mut build = cxx_build::bridges(BRIDGES);
    for source in sources.iter().filter(|path| path.extension().is_some_and(|extension| extension == "cxx")) {
        build.file(source);
    }
    build.include(&include_dir).std("c++17").define("_USE_MATH_DEFINES", None).flag_if_supported("-w").compile("llull-kernel-occt-facade");

    println!("cargo:rerun-if-changed=cpp");
    for path in BRIDGES {
        println!("cargo:rerun-if-changed={path}");
    }
    for source in &sources {
        println!("cargo:rerun-if-changed={}", source.display());
    }
}
