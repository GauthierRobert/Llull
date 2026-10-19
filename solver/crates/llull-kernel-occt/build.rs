//! Builds (or reuses) a static OCCT 7.8.1 and compiles the cxx facade against it.
//!
//! `occt-sys` builds OCCT with cmake into `solver/target/OCCT` (about an hour on 4 cores the first time, then incremental and shared
//! by every profile). `LLULL_OCCT_DIR` points at an existing install (its `include/` and `lib/`) instead, e.g. a CI cache.

use std::path::{Path, PathBuf};

/// Linked toolkits, dependents first (static archives resolve left to right).
const OCCT_LIBS: &[&str] = &[
    "TKDESTEP",
    "TKXCAF",
    "TKVCAF",
    "TKLCAF",
    "TKCAF",
    "TKCDF",
    "TKDE",
    "TKXSBase",
    "TKMesh",
    "TKFeat",
    "TKOffset",
    "TKFillet",
    "TKBool",
    "TKBO",
    "TKShHealing",
    "TKPrim",
    "TKTopAlgo",
    "TKGeomAlgo",
    "TKBRep",
    "TKGeomBase",
    "TKG3d",
    "TKG2d",
    "TKService",
    "TKMath",
    "TKernel",
];

/// Rust modules holding a `#[cxx::bridge]`.
const BRIDGES: [&str; 2] = ["src/lib.rs", "src/features.rs"];

fn occt_root() -> PathBuf {
    println!("cargo:rerun-if-env-changed=LLULL_OCCT_DIR");
    match std::env::var_os("LLULL_OCCT_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => {
            occt_sys::build_occt();
            occt_sys::occt_path()
        }
    }
}

fn library_file(dir: &Path, name: &str) -> bool {
    dir.join(format!("lib{name}.a")).exists() || dir.join(format!("{name}.lib")).exists()
}

fn main() {
    let root = occt_root();
    let lib_dir = root.join("lib");
    let include_dir = root.join("include").join("opencascade");
    let include_dir = if include_dir.exists() { include_dir } else { root.join("include") };

    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    for name in OCCT_LIBS.iter().filter(|name| library_file(&lib_dir, name)) {
        println!("cargo:rustc-link-lib=static={name}");
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rustc-link-lib=dylib=user32");
        println!("cargo:rustc-link-lib=dylib=advapi32");
    }

    // Every C++ source of the facade (cpp/*.cxx), sorted so the build is reproducible.
    let mut sources: Vec<PathBuf> =
        std::fs::read_dir("cpp").map(|entries| entries.filter_map(Result::ok).map(|entry| entry.path()).collect()).unwrap_or_default();
    sources.retain(|path| path.extension().is_some_and(|extension| extension == "cxx"));
    sources.sort();

    cxx_build::bridges(BRIDGES)
        .files(&sources)
        .include(&include_dir)
        .std("c++17")
        .define("_USE_MATH_DEFINES", None)
        .flag_if_supported("-w")
        .compile("llull-kernel-occt-facade");

    println!("cargo:rerun-if-changed=cpp");
    for path in BRIDGES {
        println!("cargo:rerun-if-changed={path}");
    }
}
