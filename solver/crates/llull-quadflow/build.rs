//! Compiles the vendored QuadriFlow (every `vendor/quadriflow/src/*.cpp`) and the cxx facade (`cpp/facade.cxx`) into one static library.
//! Nothing is downloaded or found on the machine: Eigen (MPL-2.0 only), LEMON (headers + `base.cc`) and pcg32 sit in `vendor/`.

use std::path::{Path, PathBuf};

fn sources(dir: &Path, extension: &str) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .unwrap_or_else(|error| panic!("{}: {error}", dir.display()))
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().is_some_and(|found| found == extension))
        .collect();
    files.sort();
    files
}

fn main() {
    let manifest = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let vendor = manifest.join("vendor");
    let quadriflow = vendor.join("quadriflow").join("src");
    println!("cargo:rerun-if-changed=vendor");
    println!("cargo:rerun-if-changed=cpp");
    println!("cargo:rerun-if-changed=src/lib.rs");

    let prelude = quadriflow.join("llull_prelude.hpp");
    let mut build = cxx_build::bridge("src/lib.rs");
    for file in sources(&quadriflow, "cpp") {
        build.file(file);
    }
    build.file("cpp/lemon_statics.cxx").file("cpp/facade.cxx");
    // `llull-quadflow/cpp/facade.hxx` resolves through cxx's crate symlink, which Windows only creates with symlink rights: add the parent too.
    let crates_dir = manifest.parent().expect("crate has a parent directory");
    build
        .include(vendor.join("shim"))
        .include(crates_dir)
        .include(&quadriflow)
        .include(&vendor)
        .include(vendor.join("eigen"))
        .include(vendor.join("lemon"))
        .std("c++17")
        .define("EIGEN_MPL2_ONLY", None)
        .flag_if_supported("-w");
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        build.define("_USE_MATH_DEFINES", None).define("_CRT_SECURE_NO_WARNINGS", None).flag("/bigobj").flag("/EHsc");
        build.flag(format!("/FI{}", prelude.display()));
    } else {
        build.flag("-include").flag(prelude.to_str().expect("UTF-8 path"));
    }
    build.compile("llull-quadflow-facade");
}
