//! Compiles the cxx facade (every `cpp/*.cxx`) against a SHARED Netgen 6.2.2604 and the SHARED OCCT 7.9.2 it was built with, and links
//! both dynamically (LGPL-2.1, docs/decisions/NG1-netgen-mesher.md).
//!
//! Netgen comes from `solver/scripts/build-netgen.mjs` (its prefix: `LLULL_NETGEN_DIR`, else the script's per-user default), OCCT from
//! `solver/scripts/build-occt.mjs` (`LLULL_OCCT_DIR`, else its default). Nothing is built here. Both prefixes' library directories are
//! exported to dependents (`links = "netgen"`): binaries set their runtime search path from them (`solver/bins/llull-mesh/build.rs`).

use std::path::{Path, PathBuf};

const NETGEN_VERSION: &str = "6.2.2604";
const OCCT_VERSION: &str = "7.9.2";

/// Netgen's own shared libraries.
const NETGEN_LIBS: &[&str] = &["nglib", "ngcore"];

/// The OCCT toolkits the facade calls directly (dynamic: order does not matter); nglib loads the rest of its OCC set itself.
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
    "TKFeat",
    "TKShHealing",
    "TKMesh",
    "TKXSBase",
    "TKDESTEP",
    "TKCDF",
    "TKLCAF",
    "TKCAF",
    "TKXCAF",
];

/// Mirrors `defaultOcctPrefix()` / `defaultNetgenPrefix()` of `solver/scripts/build-{occt,netgen}.mjs`.
fn default_prefix(name: &str) -> Option<PathBuf> {
    let env_dir = |var: &str| std::env::var_os(var).filter(|value| !value.is_empty()).map(PathBuf::from);
    let home = env_dir("HOME").or_else(|| env_dir("USERPROFILE"));
    let base = match std::env::var("CARGO_CFG_TARGET_OS").as_deref() {
        Ok("macos") => home.map(|home| home.join("Library").join("Caches")),
        Ok("windows") => env_dir("LOCALAPPDATA").or_else(|| home.map(|home| home.join("AppData").join("Local"))),
        _ => env_dir("XDG_CACHE_HOME").or_else(|| home.map(|home| home.join(".cache"))),
    }?;
    Some(base.join("llull").join(name))
}

fn prefix(variable: &str, name: &str, script: &str) -> PathBuf {
    println!("cargo:rerun-if-env-changed={variable}");
    let root = std::env::var_os(variable).filter(|value| !value.is_empty()).map(PathBuf::from).or_else(|| default_prefix(name));
    match root {
        Some(root) if root.join("include").exists() && root.join("lib").exists() => root,
        other => panic!(
            "{name} (shared) not found at {}: run `node solver/scripts/{script}` (or set {variable} to its install prefix)",
            other.map_or_else(|| "<no home directory>".to_owned(), |path| path.display().to_string())
        ),
    }
}

fn has_library(lib_dir: &Path, name: &str) -> bool {
    ["lib{}.so", "lib{}.dylib", "{}.lib", "lib{}.dll.a"].iter().any(|pattern| lib_dir.join(pattern.replace("{}", name)).exists())
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

fn main() {
    for name in ["HOME", "XDG_CACHE_HOME", "LOCALAPPDATA"] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    let netgen = prefix("LLULL_NETGEN_DIR", &format!("netgen-{NETGEN_VERSION}"), "build-netgen.mjs");
    let occt = prefix("LLULL_OCCT_DIR", &format!("occt-{OCCT_VERSION}"), "build-occt.mjs");
    let windows = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows");
    let (netgen_lib, occt_lib) = (netgen.join("lib"), occt.join("lib"));
    for (dir, names) in [(&netgen_lib, NETGEN_LIBS), (&occt_lib, OCCT_LIBS)] {
        println!("cargo:rustc-link-search=native={}", dir.display());
        for name in names {
            assert!(has_library(dir, name), "{name} missing in {} (rebuild with build-netgen.mjs / build-occt.mjs)", dir.display());
        }
    }
    // Consumed by dependents' build scripts as DEP_NETGEN_*: runtime search path (Linux / macOS), DLL folders (Windows).
    println!("cargo:lib_dir={}", netgen_lib.display());
    println!("cargo:bin_dir={}", netgen.join("bin").display());
    println!("cargo:occt_lib_dir={}", occt_lib.display());
    println!("cargo:occt_bin_dir={}", occt.join("bin").display());
    if !windows {
        // this crate's own unit tests find the shared libraries through absolute runtime paths
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", netgen_lib.display());
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", occt_lib.display());
    }

    let sources = facade_sources();
    let mut build = cxx_build::bridge("src/lib.rs");
    for source in sources.iter().filter(|path| path.extension().is_some_and(|extension| extension == "cxx")) {
        build.file(source);
    }
    let occt_include = occt.join("include").join("opencascade");
    let netgen_include = netgen.join("include").join("netgen");
    // `llull-netgen/cpp/*.hxx` resolves through cxx's crate symlink, which Windows only creates with symlink rights: add the parent too.
    let crates_dir = Path::new(env!("CARGO_MANIFEST_DIR")).parent().expect("crate has a parent directory");
    build
        .include(crates_dir)
        .include(&netgen_include)
        .include(netgen_include.join("include"))
        .include(if occt_include.exists() { occt_include } else { occt.join("include") })
        .std("c++17")
        .define("OCCGEOMETRY", None)
        .define("_USE_MATH_DEFINES", None)
        .flag_if_supported("-w");
    if windows {
        // the interface definitions of Netgen's exported ngcore target (lib/cmake/netgen/netgen-targets.cmake)
        for define in ["WNT", "WNT_WINDOW", "NOMINMAX", "MSVC_EXPRESS", "_CRT_SECURE_NO_WARNINGS", "HAVE_STRUCT_TIMESPEC", "WIN32"] {
            build.define(define, None);
        }
        build.define("_WIN32_WINNT", Some("0x1000")).flag_if_supported("/bigobj").flag_if_supported("/Zc:__cplusplus");
    }
    let compiler = build.get_compiler();
    if compiler.is_like_gnu() && !compiler.is_like_clang() {
        build.flag("-fno-ipa-cp-clone");
    }
    build.compile("llull-netgen-facade");
    // After the static facade: a single-pass linker resolves its symbols only from libraries named after it.
    for name in NETGEN_LIBS.iter().chain(OCCT_LIBS) {
        println!("cargo:rustc-link-lib=dylib={name}");
    }

    println!("cargo:rerun-if-changed=src/lib.rs");
    println!("cargo:rerun-if-changed=cpp");
    for source in &sources {
        println!("cargo:rerun-if-changed={}", source.display());
    }
}
