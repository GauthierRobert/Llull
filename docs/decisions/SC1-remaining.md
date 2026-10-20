# SC1 — remaining work (closed 2026-10-20)

Every item of the 2026-10-20 handoff is done on branch `feat/sc-remaining`. Kept as the record of how it was closed.

## 1. SC-NATIVE — native kernel compiled and verified (Windows 11, VS 2022 Build Tools 14.44, Rust 1.97.0 MSVC)

- OCCT 7.9.2 rebuilt with `TKDEIGES` (`node solver/scripts/build-occt.mjs`, ~25 min on 20 threads). The naming / face-op / radius-law /
  IGES C++ and Rust compiled first time; `npm run native:check` with `LLULL_NATIVE_KERNEL=1` green (fmt, clippy `-D warnings`,
  `cargo test --workspace`, incl. the 11 `naming_tests` and the radius-law tests).
- Windows notes: rustup must use the **MSVC** toolchain (`RUSTUP_TOOLCHAIN=1.97.0-x86_64-pc-windows-msvc` when the default host is GNU,
  which needs `dlltool`), and `%LOCALAPPDATA%\llull\occt-7.9.2\bin` must be on `PATH` for `cargo test` / the server suites (OCCT is shared).
- `LLULL_REQUIRE_NATIVE_KERNEL=1 npm --prefix server test`: every native suite runs (oracle 115, IGES, fillet laws, primitives, queries,
  features, exchange). It found real gaps, all fixed (main CI `native-kernel` was red on them):
  - `measure_bounding_box` read the display mesh of kernel results (curved parts ~0.5–1.5 % small): it now takes the kernel's exact
    bounds of the placed recipe, and the native `bounds_of` uses `BRepBndLib::AddOptimal` (the loose `Add` bounded curved faces by their
    poles).
  - Exact mass / volume / bounds evaluated a kernel result's `brep` without its later `position` / `rotation` (a moved result reported
    its creation-frame centroid): they evaluate `recipeOf(e)` (placed) now; `occtMassProperties.test.ts` fixture fixed to the invariant.
  - `mass_properties` area of cone / torus / revolution came from the display triangles: closed forms now (Pappus for revolutions).
  - Oracle 48 (union of disjoint boxes): a STEP round trip imports one entity per solid; the case states `stepBodies: 2`.
  - Stale assertion: `importShapes('iges', …)` is supported now and refuses garbage as `unreadable`.
- `npm run oracle`: OCCT column filled in `docs/ORACLE.md`: 115 cases, 114 pass, 1 known failure (106 external thread: the groove tool is
  faceted on every kernel, so the OCCT result has no B-rep; an exact helical sweep would close it). Oracle 104 (per-edge radii) passes:
  its `knownFailure` is removed.
- `npm run action-matrix -- --native --bless`: `tests/action_matrix/baseline.json` gains the `occt` column (9 958 entries, 0 known errors).

## 2. SC-Q4b — mutation judges

New behavioural judges in `tests/golden/` (picked up by `vitest.mutation.config.mts`): a sketch oracle that re-states every constraint kind
and counts DOF by finite-difference rank without solver code (`sketchOracle.ts`); one golden plan per constraint family (`sketchPlans.ts`:
slot, tangent arc chain, symmetric bracket, circles and angles, under-constrained); guard judges (conflict, redundant, flip, triangle
orientation) and a 40-seed DOF property (`sketchGuards.test.ts`); replay equality of every history meta-command, a carried material
edit and an after-the-fact parameter edit (`historyJudges.test.ts`). Measured (standalone clone, `docs/MUTATION.md`): `history` 28.0 % -> 36.7 %,
`parametric` 35.5 % -> 55.9 % (concurrency 6; 16 ran the host out of memory).

## 3. Owner decision — settled

Owner, 2026-10-20: "I don't care how existing document replay, do the best". `extrude_profile` with `id` / `ids` now inherits the drawn
source's rotation (extrudes along its work-plane normal) unless `rotation`, `axis` or `plane` is given; the drag-extrude manipulator
follows the sketch normal too. Older documents with rotated sketches replay into the rotated solid.

## Open

- Weakest mutation files after SC-Q4b: `flipGuard.ts` 23 %, `history/carry.ts` 19 %, `history/replay.ts` 25 %.
- Main CI `e2e` job was also red on `main` (not SC; not investigated here).
- Load-sensitive server tests: `cliProgress` "supervised child" and `hardening` autosave timing failed once each under full parallel
  load and pass repeatedly alone.
