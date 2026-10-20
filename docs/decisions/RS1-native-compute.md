# RS1 — Native compute programme (Rust + wgpu, native OCCT)

Status: decided 2026-10-18 (owner: "I accept all the suggestions, strong and medium"), following rule C7 ("always use the
best-suited stack", `.claude/rules/conventions.md`). Board: one line, **RS — NEXT PRIORITY**. This file is the plan; each pack's
TECHNICAL_SPEC carries its own amendment and points back here.

Owner directives that frame it: **CLI only** (MCP will be removed), **local only** (never cloud), **GPU first where it fits**.

## 1. Why

A survey of the 43 spec packs and the compute-heavy TypeScript (2026-10-18) found that most packs are tabular, closed-form or small
and stay in TypeScript. About ten workloads are large, uniform or data-parallel, where TypeScript in one V8 thread either misses its
budget, needs a hard cap, or depends on a risky toolchain. Those move to native code.

Rule of thumb used for every row below:

- **GPU (Rust + wgpu)**: big, uniform, data-parallel work (voxel grids, millions of independent ray / distance tests, rasterising).
- **Rust CPU (rayon)**: branchy work, search, spatial trees, per-node loops, and anything whose numbers must be bit-reproducible.
- **Keep**: TypeScript where budgets are met; external tools (CalculiX, Gmsh, MuJoCo, CEA, JT converter) whose V&V we would lose.

## 2. Architecture (applies to every row)

```
solver/                         one Cargo workspace (sibling of server/ and desktop/; not an npm workspace)
  crates/llull-gpu              wgpu device selection, buffers, chunking, fixed-order (deterministic) reductions, CPU fallback hooks
  crates/llull-protocol         job folder + NDJSON progress protocol, result-bundle writer (sha256), error codes
  crates/llull-bvh              deterministic AABB / triangle BVH, ray and distance queries (CPU + GPU traversal)
  crates/llull-raster           offscreen renderer (wgpu) for render_view, walkthroughs, BCF snapshots, CAE field plots
  crates/llull-voxfe            matrix-free voxel finite elements (Q8 / Q4), PCG + multigrid — shared by topopt and CFD tooling
  crates/llull-flow-{core,lbm,euler}   12 CFD solvers (were `solver/flow/`)
  crates/llull-topopt           physics 17 SIMP loop on llull-voxfe
  crates/llull-cloud            plant 10 point-cloud I/O (E57, LAS, LAZ, COPC), octree, kd-tree, ICP, RANSAC, normals, deviation
  crates/llull-geomq            clearance, wall thickness, view factors (physics 21, 03) on llull-bvh
  crates/llull-post             FE post-processing: rainflow + damage (07), random / SSD response (09), field mapping (04)
  crates/llull-route            plant 02 V2 auto-router (sparse 3D A*)
  crates/llull-stats            aerospace 03 Monte Carlo stack-up (counter-based RNG streams)
  crates/llull-panel            aerospace 10 V1 3D panel / vortex-lattice influence build + dense LU (faer)
  crates/llull-explicit         physics 19 explicit dynamics (V1 / V2)
  crates/llull-kernel-occt      native OCCT 7.9 bindings (cxx) implementing the existing KernelOps worker protocol
  bins/llull-compute            job binary: `llull-compute <job> <job-folder>` (flow, topopt, cloud, raster, geomq, post, route, stats, panel, explicit)
  bins/llull-kernel             long-lived kernel process speaking KernelOps over stdio (replaced the OCCT WASM worker, which LC1 step 5 deleted)
```

Rules:

1. **Layering (L2, L6, L9).** Native code is reached only through host transports in `server/` (job style, like `fea_solve`) or
   through an injected port (`GeometryKernel` for `llull-kernel`). Nothing in `packages/*` imports it. Every capability still has
   its pure command(s) in core or a plugin; results come back through validated record commands (05 §4.1 trust model) or as query
   `data`. The document is never written by native code.
   Synchronous geometric checks (physics 21 clearance / thickness, 03 view factors, 13 contact broad phase) reach native code
   through one injected port, `GeometryQueryEngine` (PHY-21 TR-FPR-19): default implementation `meshBvh.ts`, native one installed
   by the host, same pattern as `ctx.kernel` / `ctx.physics`.
2. **One binary per role, not per feature**: `llull-compute` (jobs) and `llull-kernel` (persistent). 12 CFD's `llull-flow` is
   `llull-compute flow`.
3. **Determinism (AF-13).** Numbers the document records come from the Rust CPU path, or from GPU kernels whose reductions use a
   fixed order (`llull-gpu`), so a run is bit-reproducible on one device and driver. GPU-only fast paths are allowed for exploration
   and pictures and say so in provenance (`device`, `deterministic: false`). Where a pack requires identical hashes across
   machines (plant 09 `svgSha256`, plant 10 TR-SCN-08), the TypeScript or Rust-CPU path stays the reference.
4. **References stay.** Existing TypeScript implementations (`meshBvh.ts`, `computeViewFactors.ts`, `fieldRaster.ts`, the fatigue
   loops, `renderPlan`) remain as the small-case path and the test oracle; native results must match them within each pack's VC
   tolerance (one "native vs reference" VC per row).
5. **Offline and bundled (AF-41).** `desktop/scripts/prepare-native.mjs` builds or fetches the two binaries per OS / arch (like
   CPython and `ccx`); missing binaries refuse with `NATIVE_TOOL_MISSING` and an install hint. llull stays fully usable without them
   (TypeScript paths, smaller caps). Bundle layout `resources/native/{llull-compute,llull-kernel,occt/lib/*,licenses/}`; the desktop
   backend gets `LLULL_NATIVE_DIR` only when the bundle holds a binary.
6. **Gates.** `cargo test` + `cargo clippy -D warnings` run as `npm run native:check`, part of `npm run check` when `cargo` is present
   and in CI always. GPU tests run where an adapter exists and skip with a logged reason otherwise; every GPU kernel has a CPU twin, so
   every VC has a CI path.
7. **Licences.** wgpu MIT / Apache-2.0; OCCT LGPL-2.1 with exception (dynamic linking: shared OCCT 7.9.2 built by
   `solver/scripts/build-occt.mjs`, shipped beside `llull-kernel` with the LGPL text, the exception and a source / relink notice); faer MIT; las / laz-rs / e57 crates
   MIT or Apache; PyFR BSD (12 CFD V2). Nothing GPL is linked into the binaries.

## 3. Programme (priority order)

| Step | Content | Packs (amended specs) | Fit | Replaces / supersedes |
| ---- | ------- | --------------------- | --- | --------------------- |
| **RS-0** | `solver/` workspace, `llull-gpu`, `llull-protocol`, `llull-bvh`, bundling, `native:check`; first job = 12 CFD M2 | 12 CFD | — | 12 CFD's standalone `solver/flow/` |
| **RS-1** (done 2026-10-19; WASM build retired by LC1 step 5; macOS bundle deferred by the owner) | Native OCCT 7.9 kernel sidecar `llull-kernel` behind `KernelOps` | aerospace 01 KRN (carries 02, 04, 07, 08) | native CPU | 01 KRN M2 custom OCCT 7.9 Emscripten build (board AERO-2-M2) |
| **RS-2** (done 2026-10-19: `llull-gpu`, `llull-voxfe`, `llull-topopt`, `llull-compute topopt`, `topology_solve`, plugin `topology`; GPU 1e7 DOF cap provisional until measured on a hardware GPU, VC-TOP-34) | GPU SIMP topology optimisation on `llull-voxfe` | physics 17 TOP | GPU | 17's CPython numpy / scipy bridge |
| **RS-3** (done 2026-10-20: crate `llull-cloud` (E57 / LAS / LAZ / ASCII, octree asset, kd-tree, RANSAC / LM fits, slices, trimmed ICP + sphere targets), `llull-compute cloud`, plugin `scan`, `PointCloudPort`, `llull scan import`; WASM build dropped (LC1); M3 viewport open; plant 10 TECHNICAL_SPEC §13) | Point-cloud import, octree, ICP, RANSAC, normals, fits | plant 10 SCN | Rust CPU | 10's TS readers + lazrs-wasm / laz-perf + libE57 question (Q4); unlocks COPC writing (Q2) |
| **RS-4** (done 2026-10-20: deviation + design-vs-scan clash on the Rust CPU path, `check_point_clouds`, wgpu deviation / clash prune behind `device`, VC-SCN-60 GPU rows) | Scan-vs-design deviation and as-built clash | plant 10 SCN | GPU + CPU final numbers | 10's pure-TS deviation |
| **RS-5** (done 2026-10-20: FEA field plots (VC-FEA-29) + plant 09 VIS-M9: `ctx.raster` port, `llull-compute raster` scene job (CPU twin + wgpu), `render_view` / `render_walkthrough` / `export_bcf` native, VC-VIS-60; plant 09 TECHNICAL_SPEC §12) | Offscreen renderer for headless `render_view`, walkthroughs, BCF snapshots, CAE field plots | plant 09 VIS, aerospace 05 FEA (`fieldRaster.ts`) | GPU | the pure-TS software rasterisers as the default fast path (they stay the hash reference) |
| **RS-6** | Motion clearance + wall-thickness rays; radiation view factors with obstruction; model-scale BVH / clash broad phase | physics 21 FPR, physics 03 THM, plant 09, physics 13 | GPU (BVH traversal), Rust CPU twin | 21's pure-TS clearance plan; 03's 400-facet cap |
| **RS-7** (done 2026-10-20 except `post ssd`, not needed: CalculiX writes the complex field; fatigue, mapping, `post random` (VC-DYN-48), `llull-route` + `auto_route` (VC-RTE-25), `llull-stats` + `stackup_monte_carlo` (VC-GDT-37), `llull-panel` VLM + `vortex_lattice_solve` (VC-AER-33); 3D panel method open) | Medium rows: FE post (07 rainflow on all nodes, 09 random / SSD contraction, 04 mapping); 02 V2 auto-router; 03 GDT Monte Carlo above 2e6; 10 AER V1 3D panel / VLM | physics 07, 09, 04; plant 02; aerospace 03, 10 | Rust CPU | pure-TS hot loops / caps |
| **RS-8** (**done 2026-10-20.** RS-8a 2026-10-19: `llull-explicit`, `llull-compute explicit`, `explicit_run`, plugin `explicit`; RS-8b: J–C erosion, f64 wgpu kernels with a CPU twin, deterministic per device; RS-8c: penalty contact on `llull-bvh`, self contact, Coulomb friction, Belytschko–Tsay shells with Johnson–Cook; completion: WGSL kernels for penalty contact and the shells (deterministic; host BVH candidate search with a motion-checked margin), shells in contact with the thickness offset, shell erosion, the Belytschko–Wong–Chiang shell (Belytschko–Leviathan full projection, fiber coupling, edge-based transverse shear), 05 fixed / pinned / symmetry supports, imposed velocity / displacement histories (`add_imposed_motion`), adiabatic heating (`set_adiabatic_heating`, β 0.9) with c_p(T) read at the element temperature; D1–D5 stay in the explicit set-up (PHY-02 has no failure slot); physics 19 TECHNICAL_SPEC §13, §13.9, §13.10. Nothing of RS-8 is open. Out of scope: the OpenCourant / Radioss hand-off (PHY-19 M2–M4), the alternative path below; rounded shell edges and shell thickness change are LS-DYNA options left to a later physics-19 row) | Own explicit dynamics solver (central difference, lumped mass, contact) | physics 19 EXP (V1 / V2) | GPU | 19's AGPL OpenCourant / Radioss hand-off as the only path (hand-off stays in the MVP) |

Rough effort (from the amended packs): RS-0 3 w (shared with 12 CFD M2), RS-1 6–8 w, RS-2 4 w, RS-3 6 w, RS-4 2 w, RS-5 4 w,
RS-6 4 w, RS-7 6 w, RS-8 16+ w.

## 4. Not moved (recorded so it is not re-litigated)

- TypeScript: plant 01, 03–08 (07 pipe stress: 12k DOF, bit-exact, budget met); physics 00–02, 08, 12–15, 18, 20; aerospace 02, 04
  tokenizer, 06, 07, 08, 09, 11; core tessellation, mass properties, bounds, triangulate, convergence; FRD parsing at today's sizes.
- External tools: CalculiX, Gmsh, MuJoCo, CEA, the JT converter.
- Viewport: stays three.js / WebGL; three.js WebGPURenderer is a later option, not part of RS.
- No Rust B-rep kernel (truck, Fornjot): no robust fillets, healing or STEP AP242 / XCAF.

## 5. TypeScript follow-ups found by the survey (not RS, small)

- `packages/domain-aero/src/aerodynamics/panelMethod.ts`: factorise once and reuse for both right-hand sides; `Float64Array`.
- `packages/core/src/geometry/hiddenLines.ts`: O(E·F) without acceleration; add a 2D grid / BVH.
