# SC1 — what remains (handoff, 2026-10-20)

Branch `feat/sc-parity`. Every SC task is implemented (see "As built" in `SC1-solidcraft-parity.md`). Verified on Windows 11 without
MSVC: `npm run check` green, 10 246 unit tests, server 591, desktop 31, coverage 97.2/88.5/98.9/98.9, oracle 98/98 (Manifold),
action matrix 0 errors, fuzz 500/500.

## 1. SC-NATIVE — compile and verify the native kernel (blocked here: no MSVC)

Written but never compiled: persistent naming through OCCT history (`solver/crates/llull-kernel-occt/cpp/naming*.{hxx,cxx}`,
`facade.cxx`, `features.cxx`, `queries.cxx`, `recipe.rs`, `nodes.rs`, `naming_tests.rs`), face operations (`cpp/face_ops.cxx`,
`faceOp` in `nodes.rs`), per-edge radius laws (`fillet_laws`, `radius_laws`), IGES (`cpp/iges.cxx`, `TKDEIGES` in `build-occt.mjs` +
`build.rs`, sidecar op `exportIges`, `importShapes('iges')`).

Prerequisites (Windows): VS 2022 Build Tools with the C++ workload, CMake, Ninja, rustup. Run in a VS dev shell
(`VsDevCmd.bat -arch=amd64`), from the repo root:

1. `node solver/scripts/build-occt.mjs` — rebuild OCCT 7.9.2; it must now include `TKDEIGES`.
2. `cargo build --release -p llull-kernel` then `cargo clippy --workspace -- -D warnings` and `cargo test --workspace` (in `solver/`).
   Expect compile errors to fix in the new C++/Rust (never built). Tests to watch: `naming_tests`, the `radii` / fillet-law tests,
   the IGES session test.
3. `npm run native:check`.
4. `LLULL_REQUIRE_NATIVE_KERNEL=1 npm --prefix server test` — native suites (incl. `server/tests/nativeIges.test.ts`) must run, not skip.
5. `npm run oracle` — fills the OCCT column of `docs/ORACLE.md` (17 cases + STEP round trip, plus face-op cases 110–115).
6. If oracle case 104 (`fillet-per-edge-radii`) passes on OCCT: remove its `knownFailure` in
   `tools/oracle-analytic/casesFilletDepth.mjs` and regenerate (`tests/oracle/104-fillet-per-edge-radii/expected.json`).
7. `npm run action-matrix -- --native --bless` — commit the refreshed native baseline.
8. `npm run check` again, then update `.claude/work/BOARD.md` (SC-NATIVE → DONE).

## 2. SC-Q4b — mutation judges (TODO)

Mutation scores are low (history 28 %, parametric 35.5 %; `docs/MUTATION.md` lists survivors). Add: golden plans per constraint
family, a DOF property test, replay equality for the history meta-commands; re-run `npm run mutation` **from the main checkout only**
(never inside `.claude/worktrees/*`: on Windows Stryker deleted the main `packages/` once; the script now refuses nested checkouts).

## 3. Owner decision

`extrude_profile` still ignores a sketch's in-plane rotation by default; the opt-in `plane` param extrudes along a sketch plane.
Decide whether the default should follow the sketch rotation (changes replay of existing documents).

## 4. Then

Open the PR `feat/sc-parity` → `main` once SC-NATIVE is green.
