# PERF1 — Binding performance budgets (2026-11-18)

**Status:** decided by the owner's request ("a binding performance objective; rewrite in Rust where needed; analyses first, then the
whole application"), built for the scenarios of §3, open for the items of §5. Gate: `npm run perf`.

## 1. The objective

A user never waits on llull itself without knowing why. Every interaction belongs to one class, and each class has a ceiling on the
reference machine (§2):

| Class | What it covers | Ceiling |
| --- | --- | --- |
| `instant` | direct manipulation: one command on a loaded document, a read of a loaded result, the state hash, the autosave text | **100 ms** |
| `responsive` | a heavier read or refresh: first read of a process, margins, checks, an export of a drawing | **1 s** |
| `job` | a run the user launched and watches (solve, simulation, mesh): llull's own share around an external solver, or the native run itself | a number per scenario, with progress and cancel |

Rules:

1. **The budgets are code**: `server/tests/perf/budgets.ts`. `npm run perf` (`server/vitest.perf.config.mts`, one worker) measures
   every scenario and fails when one is over its budget. A change that touches a measured path runs it before merge.
2. **A budget is only ever lowered.** Raising one is an owner decision recorded here. A new heavy feature adds its scenario and budget
   in the same change (like its test).
3. **Scale is part of the scenario.** Each scenario names its model size; a feature that is fast on a toy model is not within budget.
4. **No silent trade of results for speed.** A faster path that changes numbers (threads, iterative solvers, GPU) is an option the
   caller chooses and the result records (AF-13, RS1 rule 3). Everything done under PERF1 so far returns bit-identical results,
   except where §4 says otherwise.
5. Technology follows C7: native code (Rust in `solver/`) where it is the better tool; a TypeScript path is first made
   algorithmically right (most findings below were O(n) or O(n²) work repeated per call, not a language limit).

## 2. Reference machine and calibration

Budgets are wall-clock milliseconds on the reference machine: the 4-core Linux container the baseline was taken on (Node 22). The
harness (`server/tests/perf/harness.ts`) times a fixed single-thread workload first and scales every budget by
`measured / 110 ms`, clamped to [0.6, 3], so a slower runner does not fail a healthy build and a faster workstation does not hide a
regression. Outside the clamp a machine reports, it does not judge.

## 3. Scenarios, budgets and where they stood

Measured 2026-11-18. "Before" is the same scenario on `main` before this work.

| Budget id | Scenario | Before | Now | Budget |
| --- | --- | --- | --- | --- |
| `fea.mesh.record` | store + summarise + record a 47 040 C3D10 / 68 121 node mesh | 1 420 ms | 480 ms | 700 ms |
| `fea.solve.overhead` | `fea_solve` on that mesh without the solver process (deck, FRD read, store, record) | 5 300 ms | 1 180 ms | 2 000 ms |
| `fea.query.cold` | first `analysis_report` of a process (CLI `--doc`) | 2 100 ms | 290 ms | 700 ms |
| `fea.query.analysis_report` | again in the same process (desktop backend) | 1 530 ms | < 1 ms | 100 ms |
| `fea.query.fea_result_field` | field at a point | 1 345 ms | 57 ms | 100 ms |
| `fea.query.describe_analysis` | | 1 318 ms | < 1 ms | 100 ms |
| `fea.query.compute_margins` | margins over 68k nodes | 2 177 ms | 58 ms | 200 ms |
| `fea.query.check_analysis` | | 3 782 ms | 126 ms | 300 ms |
| `dynamics.simulate.servo_arms` | `simulate_motion` 10 s, 50 bodies / 40 joints / 40 speed motors | 10 400 ms | 3 790 ms | 6 000 ms |
| `dynamics.simulate.closed_loops` | `simulate_motion` 2 s, 8 slider-cranks (8 loops) at 600 rpm | 15 600 ms | 6 090 ms | 9 000 ms |
| `dynamics.clearance.cranks3` | `check_motion_clearance`, 63 part pairs × 361 samples, native distance engine | 29 000 ms | 3 500–4 100 ms | 7 000 ms |
| `dynamics.clearance.cranks3_ts` | the same case without `llull-compute` (TypeScript `meshBvh`) | 39 000 ms | about 9 000–10 500 ms (scaled from 11 600–13 700 ms on a loaded container where the old build took 51–58 s; budget to be reset from a quiet machine) | 20 000 ms |
| `explicit.run.hex10k` | `explicit_run`, 10 240 hex8, 1 206 cycles (native) | 77 000 ms | 11 300 ms | 20 000 ms |
| `thermal.viewfactor.reciprocal3k` | `compute_view_factors integration='reciprocal'`, closed 3 072-facet cube, native | 24 300 ms (full rule) | not yet measured on a quiet machine: CPU 3.1–3.7 s (4 threads; the full rule there runs at CPU / 4 wall, so about 1 s); wall 2.4–6.5 s on loaded containers (load 6–14), where the gate fails (thread contention, not seen by the single-thread calibration) | 3 000 ms |
| `thermal.viewfactor.reciprocal3k_obstructed` | the same with obstruction and a baffle | 27 900 ms (full rule) | not yet measured on a quiet machine: CPU 7.6–10.4 s (about 2–2.6 s by the same ratio); wall 5.1–11.2 s loaded | 5 000 ms |
| `document.command.draft20k` | `draw_polyline` + state hash on 20 000 entities | — | 24 ms | 100 ms |
| `document.hash.mesh300k` | state hash after a 300k-triangle mesh entity changed | 780 ms (100k) | 60–80 ms | 100 ms |
| `document.save.incremental` | autosave text after one command, 20 000 entities | — | 52 ms | 100 ms |
| `document.regenerate.late_edit` | `edit_step_params` on the last of 2 000 steps | 1 200 ms | 20–37 ms | 200 ms |
| `document.export.svg20k` | `export_svg`, 20 000 2D entities (100 000: 69 s before) | 2 100 ms | 100 ms | 400 ms |
| `document.export.dxf20k` | `export_dxf`, 20 000 2D entities | 3 600 ms | 216 ms | 600 ms |

Also measured, no gate scenario yet: `explicit_run` at 20 000 hex8 did not finish in 170 s, now 29 s; `simulate_motion` 10 s of the
8 slider-cranks 78 s, now 29 s.

## 4. What was wrong and what changed

1. **Every read of a solved analysis re-read, re-canonicalized and re-hashed the mesh and results artifacts** (70 % of each query).
   `canonicalJson` writes in one native pass (byte-identical, pinned against the replacer form); the FE artifact store writes the
   canonical text, verifies a file with one native hash, keeps verified artifacts in memory while their file is unchanged
   (`LLULL_FEA_MEMORY_MB`, default 128) and tells readers the hash it verified (`FeArtifactPort.hashOf`); mesh quality, node lookups
   and field maxima are computed once per artifact object (`@lib/memoByObject`).
2. **Singularity screen**: string-keyed grid with a copied bucket per insert; now an integer-keyed grid of half-radius cells
   (and no endless loop when a cell number passes 2^53).
3. **Rigid-body dynamics**: the governor gain schedule ran one full `mj_forward` per servo per step; the extra passes now start at the
   acceleration stage (`mj_forwardSkip`). The redundant-multiplier projection of loop mechanisms runs on flat typed arrays. Same
   numbers: 718 dynamics tests and the golden corpus unchanged.
4. **Explicit solver**: `step_element` built the mid-point coordinates of the WHOLE model for every element (O(elements × nodes) per
   cycle); built once per cycle now.
5. **Topology**: `Math.min(...distances)` over the node list threw a RangeError above ~1.5·10⁵ nodes (a 3D grid of 192k voxels
   could not start).
6. **Document core**: the composites derivation guard regex-tested every entity id on every command of every document (18–26 % of a
   command at 20k–100k entities); the replay cache held 1 024 states whatever the history (past 1 024 steps every edit missed: 1.2 s
   instead of 16 ms; it is sized to the history under a 512 MB budget and switched off beyond it); the live state hash printed every
   number of a mesh entity (now a fold of the IEEE-754 bits, remembered per array); the autosave text re-printed the whole document
   (now joined from per-entity and per-step text remembered by identity).
7. **Exports**: `export_svg` rebuilt a layer's item list per item (quadratic); `hexToAci` rebuilt the 255-colour palette per entity.
8. **`fea_solve threads`** (default 1; host default `LLULL_FEA_THREADS`): CalculiX with 4 threads solved the 47k C3D10 case in 62 s
   instead of 117–120 s, but its results are then not bit-reproducible between runs (2 300 of 434 000 result lines differ in the last
   printed digit), so the count is the caller's choice and is recorded (`solverThreads`, summary, `data.threads`).

## 5. Open, ranked (measured unless marked)

| # | Finding | Measured | Direction |
| --- | --- | --- | --- |
| 1 | **CalculiX itself**: 117 s for 204k DOF (SPOOLES, one thread, reference BLAS). llull's share is now 1 %. | 62 s at 4 threads; 46 s with the iterative solver | Owner decision 2026-11-18: the default stays the direct solver on 1 thread (bit-reproducible). Opt-in per solve: `fea_solve threads=N` (last digits vary between runs) and `fea_solve solver=iterative` (`*STATIC, SOLVER=ITERATIVE CHOLESKY`; solid-only linear static, no contact / pretension; reproducible; agrees with the direct solve to a few 1e-4 relative: 1.7e-4 on the validation bar, 6.6e-5 of the peak stress on the 47k case; recorded as `solverMethod`). Still open: a CalculiX built with PaStiX / PARDISO, or a native solver validated against CalculiX |
| 2 | **The entity bag is a plain object copied per command**: 105 ms per `draw_polyline`, 72 ms per one-entity move, 142 ms per delete at 100 000 entities (24 ms at 20 000) | copying 100 000 string keys costs 43–73 ms in V8 whatever the form (spread, `Object.assign`, key loop); `Object.keys` alone 22 ms | **Blocked on the front-end**: the fix is another container for `CadDocument.entities` (a persistent map: copy 16 ms, iteration 1.4 ms in the same measurement) and `src/ui` reads the record everywhere, so it cannot be done without the front-end review's agreement. The per-command passes PERF1 owns (guard, state hash, autosave text) no longer add to it beyond one pass each |
| 3 | `check_motion_clearance` | done for the native engine (§3): the substeps of the steps the sweep cannot certify clear go out as a second `placedDistanceBatch`. Without `llull-compute` the TypeScript `meshBvh` answered them one by one: 39 s on the reference machine | done: `geometry/triangleDistanceKernel.ts` (triangle-triangle distance on flat scratch, no per-pair allocation) and an allocation-free `dualQuery` in `meshBvh.ts`; 4.3x on the same machine (51–58 s → 11.6–13.7 s on a loaded 4-core container, about 9–10 s scaled to the reference machine; not yet measured on a quiet one); a 4 000 × 4 000 triangle query 0.37 → 0.16 ms. Bit-identical: `tests/unit/geometry/triangleDistanceKernel.test.ts` compares against the frozen old code (`legacyMeshDistance.ts`) on Float64 bits, degenerate pairs and 20 000 random pairs included. Open: still about 3x slower than the native engine |
| 4 | Radiation view factors, 3 072 facets | CPU 42.5 s → 19–20 s without obstruction, 52.3 s → 23 s with ; wall on the quiet 4-core machine 24.3 s → 5.0 s without obstruction and 27.9 s → 5.9 s with (768 facets: 0.37 s / 0.42 s); `result.f64` byte-identical to the previous binary | done: the first-panel values of an edge pair as one AVX2 batch, a surface-area-split occlusion tree. Done (opt-in, other numbers, recorded in `data.integration` + summary): `compute_view_factors integration='reciprocal'` (`GeometryQueryEngine.viewFactorExchange` options; TS reference and llull-geomq bit-identical, fixture-pinned; default `full` byte-identical): one integral per unordered pair, one 8-point panel when centroids are ≥ 5 (r_i + r_j) apart (r = centroid-to-corner radius), obstruction tested both ways. Bound ~2.7e-14 per edge-pair integral (Gauss-Legendre on the Bernstein ellipse, `viewFactorContour.ts` / `viewfactor.rs` `SEPARATION`); vs `full` on the 3 072-facet cube: entries 7.3e-14, row sums 1.9e-14 (tested 1e-12 / 2e-13). CPU at 3 072 facets 19.0 s → 3.1–3.7 s without obstruction, 22.1 s → 7.6–10.4 s with (768: 1.4 s → 0.4–0.5 s, 1.5 s → 0.65 s); loaded container. Open: the host still blocks in `spawnSync`; `deferredRun.ts` is typed for mesh ops (`MeshOpResult`, `MeshOpName`), so the fix is a generic deferred job (payload type parameter), a `viewfactor` job key from the facet bytes, the engine deferring inside a scope, and `compute_view_factors` passing the deferral through |
| 5 | Building plugin re-evaluated every element on every command | 53–58 ms → 6–7 ms per command at 1 500 steel members (10 → 1.5–2.6 ms at 300) | done: an element keeps its entity objects when what its evaluation reads is deeply equal (`shared/evaluationMemo.ts`). Not memoized: walls and curved walls (openings, joined walls), civil |
| 6 | `import_mesh_file` at 1M triangles | binary STL 9.2 s → 4.4 s, OBJ 5.6 s → 4.05 s (3.97 s / 3.61 s through `fileKey`, the CLI path); same welded mesh, LOD, hashes and document | done: typed-array weld tables with an exact-coordinate memo, typed LOD clustering, block-wise sha256, no copy at unit scale 1. The 3 s goal is not met. Open: the OBJ parser (1.5 s: per-line regex split), sha256 of the file in JS (0.5 s at ~100 MB/s), base64 decode (0.44 s), the edge sort of `fastMeasure` (0.4 s); beyond that a `llull-meshops` path |
| 7 | Undo / redo / snapshot of a 117 MB document broadcast the whole document: 0.9–2.2 s | | **Not to be done (owner, 2026-11-18)** |
| 8 | Implicit bodies: the returned multi-million-triangle mesh is re-walked in TypeScript (manifold test, measures, non-finite guard): 3.9–4.9 s per `check_implicit` | closed-manifold test simplified; the rest open | return volume / area / manifoldness from `llull-field` |
| 9 | 2D snapping: all segment intersections recomputed per placed point, 610–870 ms at 100 000 entities | | split cursor-independent intersections from the from-point ones |
| 10 | `render_view`: 0.75–1.9 s at 1280 × 720; the native path pays a process start and a JS PNG encoder per frame | | persistent raster process, native PNG |
| 11 | LBM throughput ~8 M cell-updates/s; topology ~100–330 ms per iteration; `mapNodalField` TypeScript fallback 5–11 s at 69k nodes | not profiled inside the binaries | |
| 12 | 563 `Math.min(...array)` / `Math.max(...array)` spreads remain in `packages/` and `server/`: each is a RangeError above ~1.5·10⁵ items | by grep | a lint rule and linear helpers |

**Scope (owner, 2026-11-18): PERF1 work does not touch the front-end** (`src/ui/**`, `desktop/`): a separate front-end review owns it.
Row 9 (2D snapping, `src/ui/viewport/2d/snapping`) and every viewport frame-time question are handed to that review; nothing in
`src/` or `desktop/` was changed under PERF1.

Not measured here: the viewport (three.js frame times need a GPU: readiness pack 03 PRF owns those budgets), the native OCCT kernel
and the Netgen mesher (not built in the measuring container), GPU solver paths.
