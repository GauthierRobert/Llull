//! Runtime search path of the shared OCCT toolkits (LGPL-2.1 dynamic linking, RS1 §2 rule 7).
//!
//! Bundled (desktop `build/native/`): the toolkits sit in `occt/lib` next to the binary — `$ORIGIN/occt/lib` (Linux),
//! `@loader_path/occt/lib` (macOS); Windows loads DLLs from the executable's directory, so `prepare-native.mjs` copies them there.
//! Development (`target/<profile>/`): the OCCT install prefix's `lib/` as an absolute second entry, left out when
//! `LLULL_OCCT_RPATH_BUNDLE_ONLY=1` (set by `desktop/scripts/prepare-native.mjs` so a shipped binary names no build path).

fn main() {
    println!("cargo:rerun-if-env-changed=LLULL_OCCT_RPATH_BUNDLE_ONLY");
    let lib_dir = std::env::var("DEP_OCCT_LIB_DIR").expect("DEP_OCCT_LIB_DIR from llull-kernel-occt (links = \"occt\")");
    let bundle_only = std::env::var("LLULL_OCCT_RPATH_BUNDLE_ONLY").as_deref() == Ok("1");
    let origin = match std::env::var("CARGO_CFG_TARGET_OS").as_deref() {
        Ok("linux") => "$ORIGIN",
        Ok("macos") => "@loader_path",
        _ => return,
    };
    println!("cargo:rustc-link-arg=-Wl,-rpath,{origin}/occt/lib");
    if !bundle_only {
        println!("cargo:rustc-link-arg=-Wl,-rpath,{lib_dir}");
    }
}
