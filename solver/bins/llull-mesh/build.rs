//! Runtime search path of the shared Netgen and OCCT libraries (LGPL-2.1 dynamic linking, docs/decisions/NG1-netgen-mesher.md).
//!
//! Bundled (desktop `build/native/`): Netgen in `netgen/lib`, OCCT in `occt/lib` next to the binary — `$ORIGIN/...` (Linux),
//! `@loader_path/...` (macOS); Windows loads DLLs from the executable's directory, so `prepare-native.mjs` copies them there.
//! Development (`target/<profile>/`): both install prefixes' `lib/` as absolute entries, left out when `LLULL_OCCT_RPATH_BUNDLE_ONLY=1`
//! (set by `desktop/scripts/prepare-native.mjs` so a shipped binary names no build path).

fn main() {
    println!("cargo:rerun-if-env-changed=LLULL_OCCT_RPATH_BUNDLE_ONLY");
    let netgen = std::env::var("DEP_NETGEN_LIB_DIR").expect("DEP_NETGEN_LIB_DIR from llull-netgen (links = \"netgen\")");
    let occt = std::env::var("DEP_NETGEN_OCCT_LIB_DIR").expect("DEP_NETGEN_OCCT_LIB_DIR from llull-netgen");
    let bundle_only = std::env::var("LLULL_OCCT_RPATH_BUNDLE_ONLY").as_deref() == Ok("1");
    let origin = match std::env::var("CARGO_CFG_TARGET_OS").as_deref() {
        Ok("linux") => "$ORIGIN",
        Ok("macos") => "@loader_path",
        _ => return,
    };
    println!("cargo:rustc-link-arg=-Wl,-rpath,{origin}/netgen/lib");
    println!("cargo:rustc-link-arg=-Wl,-rpath,{origin}/occt/lib");
    if !bundle_only {
        println!("cargo:rustc-link-arg=-Wl,-rpath,{netgen}");
        println!("cargo:rustc-link-arg=-Wl,-rpath,{occt}");
    }
}
