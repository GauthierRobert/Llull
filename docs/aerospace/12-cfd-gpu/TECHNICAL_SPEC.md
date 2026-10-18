# Gap 12 CFD — Local GPU flow simulation: technical specification

Companion of [FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md). Laws: `.claude/rules/architecture.md` (L1–L10). Owner directives (CLI only,
local only, GPU first) are in FUNCTIONAL_SPEC, top of file.

## 1. Current state in llull (before this gap)

- **Aerodynamics at formula level** (`packages/domain-aero/src/aerodynamics/`, 10 AER): atmosphere, panel method, lifting line,
  frontal area, drag, skin friction. **Compressible 1D relations** (`packages/domain-aero/src/fluids/`, 11 FLD): isentropic, normal and
  oblique shocks, Prandtl-Meyer. No flow field exists anywhere.
- **The external-solver template exists** in the FEA work (05): Gmsh through the Python bridge and CalculiX as a tracked child
  (`server/src/fea/{transports,ccxProcess,feaSolve}.ts`); results stored by content hash (`server/src/fea/artifactStore`), then
  written into the document by validated record commands (`record_fe_mesh`, `record_fea_results`, 05 §4.1 trust model). The CLI runs
  these transports (`server/src/cli/exchange.ts`, `usage.ts`).
- **The FEA transport port is declared in `@mcp`** (`packages/mcp/src/feaTools.ts`, `FeaToolsPort`). With MCP being removed, a port
  declared there would disappear with it. This pack therefore declares its transport in a host-neutral place (§2) and lists the FEA
  port move as an open question (§11).
- **Result colours exist only as 2D images**: `@lib/isoBands` (`resultColor`) and `packages/domain-cae/src/results/fieldRaster.ts`
  paint FEA results into SVG/PNG. The 3D viewport has no result overlay.
- **Triangles in world space** come from `@core/geometry/entityTriangles` (instances expanded); units convert through
  `@core/model/units`. Booleans go through `ctx.kernel` (Manifold: watertight output by construction; OCCT: sewing and healing).
- **Convergence tooling** exists: `@lib/convergence` (observed order, Richardson, GCI) and `check_convergence` (PHY-00).
- **Python is bundled** on the desktop (`desktop/scripts/prepare-python.mjs`, CPython 3.12 + CadQuery). No native solver binary is
  bundled yet besides `ccx` (05).

## 2. Target architecture

```
                  CLI (server/src/cli)            desktop (Electron) --app         UI (src/ui) — review surface only
                         │ transports                    │                               │ overlay reads result blobs
                         ▼                               ▼                               ▼
server/src/cfd/   cfdTransports.ts  ── spawns ──►  llull-flow (native sidecar, Rust + wgpu)  ◄── GPU (Vulkan / Metal / DX12) or CPU
                  flowProcess.ts                   solver/flow/  (own Cargo workspace)
                  surfaceExport.ts  (doc → binary STL in metres, via ctx.kernel union)
                  resultStore.ts    (content-addressed, reuses the FEA artifact store)
                         │ dispatches validated record commands through execute()
                         ▼
packages/domain-aero/src/cfd/   plugin `cfd`: case commands, prepare checks (pure TS), record + report queries
packages/core/src/model/cfd.ts  data types of the `cfd` document slice (AERO3: plugin data types live in core model/)
packages/core/src/commands/types.ts  `CfdResultPort` (read-only result-store check for record commands), like `ctx.feaArtifacts`
```

Placement and laws:

- **Commands (L1, L10).** Everything that changes the document is a command of the plugin `cfd` in `packages/domain-aero/src/cfd/`
  (one more `CadPlugin` of the AERO3 package). The plugin has a palette group "Flow"; it has **no MCP toolset** (owner directive 1).
- **Solving is a host transport (L6),** like `fea_solve`: `server/src/cfd/` runs the sidecar, stores the artifacts, then dispatches the
  validated record command. The transport type `CfdTransport` is declared in `server/src/cfd/types.ts` and wired into the CLI transport
  table, **not** in `packages/mcp`.
- **The solver is a native sidecar,** a separate executable `llull-flow` built from a new top-level Rust workspace `solver/flow/`
  (sibling of `server/` and `desktop/`, own toolchain, own tests). It is bundled by `desktop/scripts/prepare-flow.mjs` per OS / arch,
  like CPython and `ccx`. It talks to the host through files plus newline-delimited JSON on stdout (§6). Nothing in `packages/*`
  depends on it (L2), and llull stays fully usable without it (`CFD_SOLVER_MISSING`).
- **Why Rust + wgpu.** One code base runs on Vulkan, Metal and D3D12 [R11], i.e. NVIDIA, AMD, Intel and Apple GPUs on the three
  desktop OSes, with no CUDA lock-in. Kernels are written in WGSL; the same algorithms exist as plain Rust (rayon) for the CPU fallback
  and as the reference the GPU path is tested against (VC-CFD-26).
- **Geometry (L9).** The flow surface is built from a `ShapeRecipe` union through `ctx.kernel` when a kernel is installed (watertight
  by construction with Manifold; sewn and healed with OCCT), and from display triangles otherwise, with the watertight check deciding
  whether that is acceptable. Commands that need the union declare `requiresKernel: true`.
- **UI (L1, L4).** `src/ui/viewport/3d/CfdOverlay.tsx` renders result blobs (surface colours, streamlines, slices, legend). It is
  presentation only and never computes flow. Rendering the same overlay to PNG goes through the existing `render_view` path.

```
packages/domain-aero/src/cfd/
  catalog.ts plugin.ts codes.ts          plugin `cfd`, palette group "Flow", CFD_* codes + remediation
  caseCommands.ts                        cfd_create_case, cfd_update_case, cfd_delete_case, cfd_set_boundary
  prepareCommand.ts                      cfd_prepare (query): runs the checks below, returns the report
  regime.ts                              free stream -> regime -> solver; refusal ranges
  domainSizing.ts                        COST 732 / AIJ and aero defaults -> domain box; blockage
  watertight.ts                          edge-manifold, orientation, signed volume on indexed triangles
  smallFeatures.ts                       thin-wall / gap / small-hole detection against the target cell size
  memoryEstimate.ts                      cells, bytes per cell per solver, run-time estimate
  recordCommands.ts                      record_cfd_results (validated, §4.1)
  reportCommand.ts                       cfd_report (query): forces, coefficients, peaks, convergence, provenance, stale
  checkCommand.ts                        check_cfd (query): AF-20 pass / warn / fail list over every case
packages/core/src/model/cfd.ts           CfdCase, CfdBoundaryTag, CfdResultSummary, CfdProvenance
server/src/cfd/
  cfdTransports.ts flowProcess.ts surfaceExport.ts resultStore.ts types.ts
solver/flow/                             Rust workspace (not an npm workspace)
  crates/flow-core    grid, octree, voxeliser, cut cells, boundary conditions, forces, probes, streamlines (CPU reference)
  crates/flow-lbm     D3Q19 / D3Q27 LBM (CPU + WGSL kernels)
  crates/flow-euler   cut-cell finite-volume Euler (CPU + WGSL kernels)
  crates/flow-gpu     wgpu device selection, buffers, chunking, deterministic reductions
  crates/flow-cli     `llull-flow` binary: case.json in, NDJSON progress out, result files
src/ui/viewport/3d/CfdOverlay.tsx, src/ui/panels/flow/FlowPanel.tsx
```

## 3. Data model

A new document slice `cfd`, owned by the plugin through `DocumentExtension` (validated on load, carried on replay). No core field;
no document version bump (absent until used, like `analysis`).

```ts
// packages/core/src/model/cfd.ts
export type CfdRegime = 'auto' | 'low_speed' | 'compressible';
export type CfdSolver = 'lbm' | 'euler';
export type CfdBoundaryKind = 'wall' | 'inlet' | 'outlet' | 'symmetry' | 'ground';
export type CfdQuality = 'draft' | 'standard' | 'fine';
export type CfdDomainRule = 'external_aero' | 'buildings' | 'custom';

export interface CfdFreestream {
  readonly mach?: number;                    // compressible cases
  readonly speedMS?: number;                 // low-speed cases (one of mach / speedMS)
  readonly altitudeM?: number;               // -> 10 AER standard_atmosphere (or explicit air state)
  readonly air?: { readonly densityKgM3: number; readonly temperatureK: number; readonly viscosityPaS: number };
  readonly alphaDeg: number;                 // angle of attack, rotation about the case lateral axis
  readonly betaDeg: number;                  // sideslip
}

export interface CfdBoundaryTag {
  readonly kind: CfdBoundaryKind;
  readonly entityId: string;
  readonly faceRefs?: readonly string[];     // stable face refs (01 KRN FaceQueryPort) when available; whole entity otherwise
}

export interface CfdCase {
  readonly id: string;
  readonly entityIds: readonly string[];     // bodies in the flow (unioned)
  readonly excludedEntityIds: readonly string[];
  readonly regime: CfdRegime;
  readonly freestream: CfdFreestream;
  readonly flowAxis: Vec3;                   // body axis aligned with the free stream at alpha = beta = 0 (default +X)
  readonly upAxis: Vec3;                     // default +Z
  readonly reference: { readonly areaM2: number; readonly lengthM: number; readonly momentPointM: Vec3 };
  readonly domain: { readonly rule: CfdDomainRule; readonly box?: { readonly min: Vec3; readonly max: Vec3 }; readonly symmetryPlane?: 'xz' | null };
  readonly ground: { readonly enabled: boolean; readonly moving: boolean };
  readonly boundaries: readonly CfdBoundaryTag[];
  readonly quality: CfdQuality;
  readonly cellsPerReferenceLength?: number; // overrides quality
  readonly solver?: CfdSolver;               // forced; refused outside its range
  readonly outputs: { readonly surfaceFields: readonly string[]; readonly slices: readonly CfdSlice[]; readonly probes: readonly Vec3[] };
}

export interface CfdResultSummary {
  readonly caseId: string;
  readonly resultsHash: string;              // sha256 of the result bundle in the store
  readonly caseHash: string;                 // canonical JSON hash of the case
  readonly geometryHash: string;             // hash of the exported flow surface
  readonly solver: CfdSolver;
  readonly converged: boolean;
  readonly forces: { readonly totalN: Vec3; readonly momentNm: Vec3; readonly cd: number; readonly cl: number; readonly cs: number; readonly cm: Vec3; readonly cdAM2: number };
  readonly perBody: readonly { readonly entityId: string; readonly forceN: Vec3 }[];
  readonly peaks: readonly { readonly field: string; readonly min: number; readonly max: number; readonly minAt: Vec3; readonly maxAt: Vec3; readonly unit: string }[];
  readonly grid: { readonly cells: number; readonly finestCellM: number; readonly levels: number };
  readonly provenance: CfdProvenance;
  readonly verified: boolean;                // false when replayed without the artifact (05 TR-FEA-05 rule)
}

export interface CfdProvenance {
  readonly solverVersion: string;            // llull-flow semver + git hash
  readonly device: { readonly backend: 'vulkan' | 'metal' | 'dx12' | 'cpu'; readonly name: string; readonly driver: string };
  readonly wallTimeS: number;
  readonly steps: number;
  readonly notModelled: readonly string[];   // e.g. ['viscosity'] for Euler, ['wall-resolved boundary layer'] for LBM
  readonly defaults: readonly { readonly path: string; readonly value: unknown; readonly source: string }[]; // AF-31
}

export interface CfdDocumentSlice {
  readonly cases: Readonly<Record<string, CfdCase>>;
  readonly results: Readonly<Record<string, CfdResultSummary>>;
}
```

Heavy data (surface fields, streamlines, slices, residual histories) lives only in the result store, never in the document.
A result is **stale** when the current `caseHash` or `geometryHash` differs from the recorded one; `cfd_report` and `check_cfd` say so.

## 4. Commands (plugin `cfd`, palette group "Flow")

| Name | Kind | Params (sketch) | data | Failure codes |
| ---- | ---- | --------------- | ---- | ------------- |
| `cfd_create_case` | mutating | `id`, `entityIds[]`, `regime`, `freestream`, `reference`, `domain`, `ground`, `quality`, `solver?`, `outputs?` | case, defaults named | `CFD_PARAM_INVALID`, `CFD_ENTITY_NOT_FOUND`, `CFD_CASE_EXISTS`, `CFD_REGIME_MISMATCH` |
| `cfd_update_case` | mutating | `caseId` + any case field | case, results now stale | as above + `CFD_CASE_NOT_FOUND` |
| `cfd_delete_case` | mutating | `caseId` | — | `CFD_CASE_NOT_FOUND` |
| `cfd_set_boundary` | mutating | `caseId`, `kind`, `entityId`, `faceRefs?` | boundary list | `CFD_ENTITY_NOT_FOUND`, `CFD_BOUNDARY_CONFLICT` |
| `cfd_prepare` | query, `requiresKernel` | `caseId`, `quality?` | §5.1 report: checks[], surface stats, small features[], domain, blockage, cells, memory, time estimate, solver | `CFD_GEOMETRY_NOT_WATERTIGHT`, `CFD_GEOMETRY_SELF_INTERSECTING`, `CFD_BLOCKAGE_TOO_HIGH`, `CFD_NO_GEOMETRY` (as check rows, not a refusal) |
| `record_cfd_results` | mutating, validated | `caseId`, `summary` | — | `CFD_RESULT_MISSING`, `CFD_RESULT_HASH_MISMATCH`, `CFD_INPUT_STALE` (no-op with reason) |
| `cfd_report` | query | `caseId`, `include?: ('forces'\|'peaks'\|'convergence'\|'probes'\|'provenance')[]` | summary, stale, warnings, `reviewRequired` | `CFD_CASE_NOT_FOUND`, `CFD_NO_RESULT`, `CFD_RESULT_STALE` (warning) |
| `check_cfd` | query | `caseIds?` | pass / warn / fail per case (AF-20) | — |

Host transports (CLI, desktop; not registry commands):

| Name | Params | What it does |
| ---- | ------ | ------------ |
| `cfd_solve` | `caseId`, `timeoutS?=3600`, `device?: 'auto'\|'gpu'\|'cpu'`, `gridStudy?: boolean` | runs `cfd_prepare`; refuses on any fail row; exports the surface; runs `llull-flow`; streams progress; stores the bundle; dispatches `record_cfd_results`. `gridStudy` runs three resolutions (ratio 2) and records the GCI |
| `cfd_streamlines` | `caseId`, `rake` (`line` \| `plane` \| `sphere`), `count`, `field?`, `maxLengthM?` | traces on the stored field (no re-solve), adds a streamline set to the bundle under a new hash, re-records |
| `cfd_slice` | `caseId`, `plane: { origin, normal }`, `field` | samples a plane, stores it, re-records |
| `cfd_probe` | `caseId`, `points[]`, `heightAboveGroundM?` | values at points; speed-up ratio U/U_ref when the case has a ground |
| `cfd_stop` | `caseId` | stops a running solve (the partial result is recorded `converged: false`) |

Every command carries `@affects / @invariant / @failure` tags (C2). `cfd_report` sets `reviewRequired: true` with the reason whenever
the case is tagged `designLoad: true` (AF-33).

## 5. Algorithms

### 5.1 Geometry preparation (TR-CFD-01..06): `cfd_prepare`

Preparation is the step that turns any llull model into a valid flow body. The owner asked for advice here, and the choice of
Cartesian solvers is driven by it: an immersed or cut-cell grid needs only a closed surface, while a body-fitted mesh needs a clean,
sewn B-rep with no slivers. The steps:

1. **Collect the bodies.** `entityIds` minus `excludedEntityIds`; instances expanded; 2D entities refused (`CFD_NO_GEOMETRY`).
2. **Union to one surface.** Kernel boolean union of the recipes (`ctx.kernel`), so overlapping parts (a wing through a fuselage, a
   rider on a bike) lose their internal faces. Without a kernel: display triangles of each body, unioned only if they do not overlap
   (checked by a BVH triangle-triangle test); otherwise `CFD_KERNEL_REQUIRED`.
3. **Weld and index.** Vertices welded at `1e-6 × body length`; triangles indexed; degenerate triangles (area < 1e-12 L²) dropped
   and counted.
4. **Watertight check.** Every undirected edge must be used by exactly two triangles with opposite orientations. Open edges
   (used once) and non-manifold edges (used more than twice) are reported with counts and up to 20 midpoints. Fail row
   `CFD_GEOMETRY_NOT_WATERTIGHT`.
5. **Orientation and volume.** Signed volume (divergence theorem) must be positive; if negative, the surface is flipped and a warning
   is reported. Self-intersections: BVH triangle-pair test; fail row `CFD_GEOMETRY_SELF_INTERSECTING` with pairs.
6. **Target cell size.** h = L_ref / N, with N from `quality` (draft 64, standard 128, fine 256 cells per reference length) or
   `cellsPerReferenceLength`. For the Euler octree, h is the finest level near the surface.
7. **Small features (warning rows).** Measured on the welded surface:
   - thin walls: inward ray from each triangle centroid; local thickness < 2h;
   - gaps: outward ray hitting another part of the surface within 2h;
   - small closed loops of feature edges (holes, bosses) with diameter < 2h.
   Each row gives entity id, size, position and the remedy: exclude the entity, raise the resolution, or (V1) defeature through 07 FTR
   `recognize_features`. Features below h vanish or close on the grid; the report makes that visible instead of silent.
8. **Openings.** Faces tagged `inlet` / `outlet` become boundary patches; an untagged open nozzle or intake fails the watertight check
   and the remediation names `cfd_set_boundary`.
9. **Symmetry.** If `domain.symmetryPlane` is set, the body is checked mirror-symmetric within 1e-4 L (Hausdorff on vertices); the
   domain and cells are halved.
10. **Domain sizing** (`domainSizing.ts`), in the free-stream frame:
    - `buildings` (COST 732 / AIJ [R1][R2]): 5H upstream, 5H on each side, 5H above the tallest building, 15H downstream, ground
      plane at the lowest point. Blockage = frontal area / domain cross-section must be ≤ 3 % (fail row `CFD_BLOCKAGE_TOO_HIGH`).
    - `external_aero`, subsonic: 5L upstream, 5L to the sides and above / below, 15L downstream. These are **named llull defaults**
      (reported in `provenance.defaults`, AF-31), checked by a domain-sensitivity case (VC-CFD-13) rather than claimed from a source.
    - `external_aero`, supersonic: 0.5L upstream (no upstream influence in supersonic flow), lateral extent such that the Mach cone
      from the nose, half-angle μ = asin(1/M), plus 0.5L margin, stays inside at the outlet; 2L downstream.
11. **Memory and time estimate** (§8) against the selected device; fail row `CFD_MEMORY_EXCEEDED` with the largest N that fits.
12. **Solver choice** (`regime.ts`): M < 0.3 → `lbm`; 0.3 ≤ M ≤ 5 → `euler`; else `CFD_REGIME_MISMATCH`. A forced solver outside its
    range is refused.

The report is deterministic for a given document and kernel (AF-13); its canonical hash is the `geometryHash` the result records.

### 5.2 Grid and voxelisation (TR-CFD-10)

- **LBM:** uniform cubes of size h, plus up to 3 nested refinement boxes (factor 2 each) around the body (MVP: boxes from the body
  bounds; V1: adaptive). Cell flags from a GPU voxeliser: parity ray casting along +X per cell row against the surface triangles,
  then wall cells are cells with a fluid neighbour.
- **Euler:** an octree of cubes, balanced 2:1, refined to the finest level on cells cut by the surface and on cells whose flow
  indicator (density gradient × h) exceeds a threshold, re-adapted every N iterations (default 2 adaptations). Cut cells store their
  fluid volume fraction, face apertures, and the wall normal and area (exact polygon clipping of the surface triangles against the
  cube) [R5]. Cells with volume fraction < 0.5 are merged with their largest fluid neighbour (small-cell problem).
- Volume error of the voxelised body is bounded by A_surface × (√3/2) h (VC-CFD-10).

### 5.3 Low-speed solver: lattice Boltzmann (TR-CFD-11)

- **Lattice:** D3Q19 (default), D3Q27 (with cumulant collision, V1) [R7][R8].
- **Collision:** BGK with Smagorinsky LES (C_s = 0.1, named default) in the MVP; cumulant collision V1.
- **Streaming:** single-buffer in-place scheme (AA pattern), so one copy of the distributions is stored (§8).
- **Units:** lattice Mach of the inflow ≤ 0.1 (named default) sets the time step; physical viscosity sets τ; a case whose τ falls
  below 0.5 + 1e-3 without LES refuses `CFD_UNSTABLE_PARAMS`.
- **Boundaries:** half-way bounce-back on wall cells (MVP), interpolated bounce-back with cut distances (Bouzidi [R10], V1);
  velocity inlet by equilibrium distributions; pressure outlet with zero-gradient extrapolation; free-slip side walls and symmetry
  by specular reflection; ground as no-slip, or moving at the free-stream speed when `ground.moving` (cars). The atmospheric
  boundary-layer inlet uses the log law u(z) = (u*/κ) ln((z + z0)/z0) [R3] (V1).
- **Forces:** momentum exchange on wall links, summed per body with a deterministic fixed-order tree reduction.
- **Steady state:** time averaging starts when the running mean of the drag over one flow-through time changes by < 0.5 %
  (named default); the run stops when it changes by < 0.1 % over two flow-throughs, or at the step limit (`converged: false`).
- **Outputs:** time-averaged velocity and pressure on the grid; surface fields interpolated to the surface vertices (trilinear from
  the nearest fluid cells along the normal).

### 5.4 Compressible solver: Euler on cut cells (TR-CFD-12)

- **Equations:** 3D compressible Euler, ideal gas γ = 1.4, conservative variables (ρ, ρu, ρv, ρw, E).
- **Space:** cell-centred finite volume on the octree; MUSCL reconstruction of primitive variables with a van Albada limiter; HLLC
  flux [R9]; wall faces by a reflecting ghost state on the cut-cell wall polygon.
- **Time:** explicit SSP-RK3 with local time stepping (CFL 0.8, named default) for steady states; global time stepping for the
  Sod verification and for V1 time-accurate runs.
- **Far field:** characteristic (Riemann-invariant) boundary on all outer faces; supersonic outflow extrapolated.
- **Convergence:** density residual L2 falls by 4 orders, or forces change by < 0.1 % over 500 iterations (named defaults).
- **Outputs:** p, Cp, Mach, ρ, entropy deviation s − s∞ (zero in exact smooth inviscid flow: a built-in error indicator reported in
  `peaks`, VC-CFD-35).
- **Drag split:** the Euler drag is pressure drag only; `cfd_report` lists `notModelled: ['viscosity']` and (V1) adds a separate
  flat-plate skin-friction estimate from 10 AER `skinFriction.ts`, never summed silently.

### 5.5 Streamlines, slices, probes (TR-CFD-20..23)

- **Seeds** from rakes: a line (n points), a plane grid (nu × nv), or a sphere around a point (Fibonacci points). Capped at 4096 seeds.
- **Integration** on the GPU, one thread per seed: Dormand-Prince RK45 with error control (relative 1e-5, step ≤ h), trilinear
  velocity interpolation (cell location is O(1) on a Cartesian grid, O(depth) on the octree). Both directions from the seed.
- **Stop reasons:** left the domain, hit a wall cell, speed < 1e-4 U∞ (stagnation), max length (default 3 domain lengths), max steps.
- **Output:** polylines decimated to a chordal tolerance of h/4, a scalar per point (Mach or speed), stop reason per line.
- **Slices:** plane sampling at h spacing; **probes:** trilinear values; speed-up ratio U/U_ref with U_ref the inlet speed at the same
  height (buildings).

### 5.6 GPU execution (TR-CFD-30..33)

- **Device selection:** wgpu adapter with the most memory among discrete GPUs, else integrated, else CPU. `device: 'cpu'` forces the
  rayon backend. The adapter name, backend and driver go into provenance.
- **Memory:** buffers above the adapter's `maxStorageBufferBindingSize` are split into chunks along Z; the estimate (§8) is checked
  against reported adapter memory before allocation (VC-CFD-50).
- **Determinism:** no floating-point atomics in reductions; forces, residuals and peaks use fixed-order tree reductions so that a run
  is bit-reproducible on the same device and driver; GPU vs CPU agree within VC-CFD-26 tolerances.
- **Desktop stability:** kernels are dispatched in slices of ≤ 50 ms so the OS GPU watchdog (Windows TDR) never fires; the desktop
  UI stays responsive while a solve runs.

## 6. Interop and persistence

- **Host → sidecar:** a job folder with `case.json` (the case, air state resolved from 10 AER, boundaries, outputs, resolution) and
  `surface.stl` (binary, metres, one solid per boundary tag).
- **Sidecar → host:** NDJSON lines on stdout: `{"type":"progress","step":…,"residual":…,"cd":…}`, `{"type":"warning","code":…}`,
  `{"type":"done","converged":…}`; result files:
  - `summary.json` (forces, peaks, grid, provenance);
  - `surface.bin` (vertex positions + one float32 array per field, little-endian, documented header);
  - `streamlines.bin` (polyline offsets, points, scalars, stop reasons);
  - `slices/*.bin`, `residuals.csv`, `forces.csv`.
- **Store:** the bundle is content-addressed (sha256) in the existing artifact store under `cfd/`; the document records the hash only.
- **Export:** `--save` writes the bundle or a VTK `.vtu` / `.vtp` copy for ParaView (V1).

## 7. Surfaces and error codes

- **CLI:** `llull <command> '{…}' --json` for the commands; `llull cfd_solve …` and the other transports through the CLI transport
  table (`server/src/cli/exchange.ts` pattern); `--progress`, `--timeout`, `--save`, `--app` as for FEA. Usage lines in
  `server/src/cli/usage.ts`.
- **Desktop:** the same transports run in the desktop backend; `--app` drives them from the CLI and the user watches.
- **UI:** "Flow" panel (cases, state, stale flags, run / stop buttons that call the same transports) and `CfdOverlay` (surface
  colours with `@lib/isoBands` palettes, streamlines as instanced line segments coloured per point, optional animated particles,
  slices, legend with unit and range). `render_view overlay=cfd:<caseId>:<field>` renders the same overlay to PNG (AF-22).
- **No MCP surface** (owner directive 1).

| Code | Meaning |
| ---- | ------- |
| CFD_PARAM_INVALID | a value outside its documented range |
| CFD_CASE_EXISTS / CFD_CASE_NOT_FOUND | duplicate or unknown case id |
| CFD_ENTITY_NOT_FOUND / CFD_NO_GEOMETRY | unknown ids / only 2D entities |
| CFD_KERNEL_REQUIRED | overlapping bodies need a kernel union |
| CFD_GEOMETRY_NOT_WATERTIGHT | open or non-manifold edges (counts + positions) |
| CFD_GEOMETRY_SELF_INTERSECTING | intersecting triangle pairs |
| CFD_SMALL_FEATURE | feature below 2 cells (warning) |
| CFD_BLOCKAGE_TOO_HIGH | blockage above the rule limit |
| CFD_BOUNDARY_CONFLICT | an entity tagged twice with different kinds |
| CFD_REGIME_MISMATCH | Mach outside the solver range |
| CFD_UNSTABLE_PARAMS | LBM relaxation time too close to 0.5 |
| CFD_MEMORY_EXCEEDED | the estimate exceeds device memory (largest fitting resolution given) |
| CFD_SOLVER_MISSING | `llull-flow` not found (install hint) |
| CFD_GPU_UNAVAILABLE | no usable adapter; CPU fallback used (warning) |
| CFD_NOT_CONVERGED | stopped by time / step limit before the criterion |
| CFD_SOLVER_FAILED | NaN / negative density / sidecar crash (log tail attached) |
| CFD_TIMEOUT | `--timeout` reached (partial result recorded) |
| CFD_NO_RESULT / CFD_RESULT_STALE | no result / case or geometry changed since the result |
| CFD_RESULT_MISSING / CFD_RESULT_HASH_MISMATCH / CFD_INPUT_STALE | record-command trust checks (§4.1 of 05, same rules) |

## 8. Performance and robustness budgets

Memory per cell (derived, float32):

| Solver | Stored per cell | Bytes / cell |
| ------ | --------------- | ------------ |
| LBM D3Q19, AA pattern (one copy) | 19 distributions + flags + averaged u, p | 19×4 + 4 + 16 ≈ 96 |
| LBM D3Q19, two copies (A/B) | 2 × 19 distributions + flags + averages | 2×19×4 + 20 ≈ 172 |
| LBM D3Q27 cumulant, AA | 27 distributions + flags + averages | 27×4 + 20 ≈ 128 |
| Euler (SSP-RK3, local time step) | 5 conserved × 2 stages + 5×3 gradients + dt + geometry | (10 + 15 + 1) × 4 + ≈ 40 ≈ 144 |

So an 8 GB device holds about 80 M LBM cells (D3Q19, AA) or about 50 M Euler cells, after a 20 % reserve. The exact figures for
each case come from `memoryEstimate.ts` and are checked against measured allocation (VC-CFD-50).

| Target (to be measured, VC-CFD-54) | Value |
| ---------------------------------- | ----- |
| LBM throughput, mid-range 8 GB GPU | ≥ 1000 M cell-updates / s (D3Q19 float32) |
| Draft case, 16 M cells, steady | ≤ 10 min |
| `cfd_prepare` on a 1 M-triangle model | ≤ 5 s |
| Streamlines, 4096 seeds | ≤ 2 s |
| Overlay frame rate, 1 M surface vertices + 4096 lines | ≥ 30 fps |

Robustness: NaN / negative density / negative pressure stop the run with `CFD_SOLVER_FAILED` and the location; the sidecar never
writes into the document; a crashed sidecar leaves the document unchanged.

## 9. Test strategy

| VC | Test |
| -- | ---- |
| VC-CFD-10..16 | `tests/unit/aero/cfd/prepare.test.ts`, `caseCommands.test.ts` (watertight, orientation, small features, domain sizing, blockage, memory estimate, replay hash) |
| VC-CFD-20..26 | `solver/flow/crates/flow-lbm/tests/*.rs` (Poiseuille order, Taylor-Green, sphere drag, GPU vs CPU) + CLI scenarios |
| VC-CFD-30..35 | `solver/flow/crates/flow-euler/tests/*.rs` (Sod, wedge, stagnation, entropy order) + CLI scenarios |
| VC-CFD-40..43 | `solver/flow/crates/flow-core/tests/streamlines.rs` (analytic sphere field), `tests/component/CfdOverlay.test.tsx` (legend, ranges) |
| VC-CFD-50..55 | `server/tests/cfd/*.test.ts` (refusals, fallback, stale, record trust model) + `npm run quality:cfd` (scenario plans, performance log) |

Scenario plans in `validation/plans/` are CLI scripts (AF-23) run by the benchmark runner (`llull run_benchmarks`, PHY-00) against
`validation/expected_results.json`. The GPU suites run where a GPU is present and are skipped with a logged reason otherwise; the
CPU backend runs everywhere, so every VC has a CI path. Coverage 90/85/90/90 applies to `packages/domain-aero/src/cfd/**`.

## 10. Delivery plan

| Milestone | Content | Depends on | Effort |
| --------- | ------- | ---------- | ------ |
| M1 | Data model, case commands, `cfd_prepare` (§5.1 complete), `check_cfd`, VC-CFD-10..16 | 01 KRN union (done) | 3 eng-weeks |
| M2 | `solver/flow` workspace, wgpu device layer, voxeliser, LBM D3Q19 BGK + LES, forces, CPU backend, bundling, `cfd_solve` transport, `record_cfd_results`, `cfd_report`, VC-CFD-20..22, 26, 50..52, 55 | M1 | 6 eng-weeks |
| M3 | Viewport overlay + legend, `render_view` overlay, streamlines, slices, probes, Flow panel, VC-CFD-40..43 | M2 | 3 eng-weeks |
| M4 | Euler cut-cell octree solver, adaptation, VC-CFD-30..35, shuttle-like CLI scenario | M2 | 7 eng-weeks |
| M5 | Grid study (`gridStudy`, GCI), pinned literature benchmarks (Schäfer-Turek 3D, AIJ, ONERA M6), performance gate | M3, M4 | 3 eng-weeks |
| V1 | cumulant D3Q27, interpolated walls, ABL inlet + comfort maps, defeaturing via 07 FTR, time-accurate + animation, viscous drag estimate | M5 | ≈ 8 eng-weeks |
| V2 | PyFR body-fitted mode (bundled CPython, Gmsh mesh), nozzle / plume (11 FLD) | V1 | ≈ 8 eng-weeks |

MVP (M1–M5): about 22 eng-weeks. M3 also gives FEA its first 3D result overlay (same overlay component, 05 field data).

## 11. Open questions / decisions needed

1. **Rust toolchain in the repo** — *resolved 2026-10-18*: the owner made the stack non-fixed ("always use the best-suited
   stack", `conventions.md` C7). `solver/flow/` is a Cargo workspace; CI and the desktop build gain `cargo`.
2. **FEA port location.** `FeaToolsPort` lives in `packages/mcp`; when MCP is removed it must move to `server/` (transport types) and
   core (`FeArtifactPort` already is). This pack uses the target location from the start.
3. **One artifact store for FEA and CFD.** Proposed: generalise `ctx.feaArtifacts` into a store with namespaces (`fea/`, `cfd/`), or
   add a sibling `ctx.cfdResults` port. Decide before M2.
4. **Face-level boundary tags** need stable face refs from 01 KRN `FaceQueryPort`; until then tags are per entity.
5. **Float16 distribution storage** would roughly halve LBM memory; adopt only if VC-CFD-20..23 still pass (measure in M5).
6. **Licensing of the bundle:** wgpu is MIT / Apache-2.0; PyFR is BSD-3 (V2). Nothing GPL is linked into the sidecar.

## 12. References

See FUNCTIONAL_SPEC §11 and [validation/sources.md](validation/sources.md).
