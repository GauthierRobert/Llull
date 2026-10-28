# 08 ASC — Assembly scale — Technical specification

Status: specification only (2026-10-28). Functional view: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md). Validation:
[`validation/README.md`](validation/README.md). Laws: [`.claude/rules/architecture.md`](../../../.claude/rules/architecture.md).

## 1. Current state in llull (measured on main 52c1c51e, 2026-10-28)

| Area | Where | Behaviour today | Limit |
| ---- | ----- | --------------- | ----- |
| Boolean tool list | `packages/core/src/commands/brep/boolean.ts:35,41-45,88,95-97` | `b` = 1..1000 ids (`MAX_TOOLS`); tools combined by `balancedUnion` (recursive halving into nested `boolean union` recipe nodes), then ONE `{op:'boolean', a, b}` recipe sent to the kernel. `engine: auto` uses the mesh engine only when every operand is triangle-only. Instances are refused | union of disjoint tools re-intersected; superlinear |
| Native boolean | `solver/crates/llull-kernel-occt/src/recipe.rs:379-385`, `cpp/facade.cxx:286-318` | `BRepAlgoAPI_Fuse/Cut/Common builder(a, b)` (two-shape constructor), then `ShapeUpgrade_UnifySameDomain(result, true, true, false)`. No `SetRunParallel`, `SetUseOBB`, `SetCheckInverted`, `SetFuzzyValue`, `SetToFillHistory`, no progress range. Fuzzy is still the open TR-KRN-12 (`server/tests/nativeKernelReference.test.ts:226` `it.todo`) | no parallelism, no cancellation |
| Kernel timeout | `server/src/geometryKernel.ts:39-44` (`DEFAULT_OCC_CALL_TIMEOUT_MS = 30_000`, `LLULL_OCC_TIMEOUT_MS`), `server/src/isolatedKernel.ts:104-105,151,179,191` | `Atomics.wait`; on timeout the worker is killed and the call returns null (not retried) | lost work, unexplained `kernel returned null` |
| Patterns | `packages/core/src/commands/edit/transform.ts:149-167,174,214`; `commands/limits.ts:2` (`MAX_COPIES_PER_COMMAND = 10_000`) | `array_linear` / `array_polar` → full entity copies with `patternSourceId`. Components exist (`commands/assembly/assemblies.ts:62` `create_component`, `:133` `insert_instance`, `explode_instance`); `pattern_along_path` has a `componentId` instance mode (`edit/patternAlongPath.ts:72`) | no instance mode on arrays |
| check_assembly | `packages/core/src/commands/inspect/assemblyCheckRun.ts:39-46,152,201,213,278-279`; `geometry/assemblyCheck/pairClassify.ts:30-102`; `geometry/assemblyCheck/connectivity.ts:46-77` | `MAX_PARTS = 500`, `MAX_PAIRS = 20_000`. Broad phase: sort-and-sweep on x then y/z interval test (no BVH). Narrow phase all kernel: `kernel.distance`, then exact `boolean intersect` + `analyze` for the volume. Connectivity union-find: strong links = same body, joints, weld/thread/press-fit intents, hard or allowed overlaps; touch = weak → `FPR_PART_RESTING_ONLY` (warn) / `FPR_PART_FLOATING` (fail). Instances are one part each (`geometry/assemblyParts.ts:2-3`) | cap, O(k) exact ops, no symmetry, per-pair intents only |
| Intents, grounding | `commands/review/intents.ts:21-64`, `commands/review/grounding.ts:15`, `model/types.ts:661` (`doc.prototype`) | `allow_interference {a, b, kind, reason}`, one pair per call | thousands of calls for a bladed row |
| Bounding box | `commands/inspect/measureSolid.ts:36-44,57`; `geometry/bounds.ts:197-211,241-249,276-289` | exact OCC bounds only for meshes with a `brep`; otherwise analytic tight bounds for rotated cylinder/cone/sphere/torus, else the AABB of the 8 rotated local-AABB corners | 1.37× radius on a rotated revolve |
| Ruled loft | `commands/solids/loft.ts:39,57,126`; `geometry/sectionRing.ts:15,22,84-87`; `cpp/features.cxx:722-737` | each section resampled to 24 arc-length points (`SECTION_RING_POINTS`), turned into a closed centripetal Catmull-Rom Bézier chain, then `BRepOffsetAPI_ThruSections(true, ruled, 1e-6)`. Exact path only when every section is a `nurbs_curve` | rounded corners, non-planar "flat" faces |
| render_view | `commands/render/budget.ts:8,28-73`; `render/scene.ts:20,79,109`; `render/renderView.ts:126`; `render/viewRequest.ts:34-35,85-96` | vector budget 20,000 (clamp 500–100,000), raster ≥ 400,000; over-budget entities decimated evenly (fair share). `renderer: "native"` = llull-compute raster through `ctx.raster` | fragments; no app capture verb (none in `server/src/cli`) |
| Design language | `packages/design-lang/src/schemaValue.ts:156,192-205`; `run.ts:343-360,420-454`; `parse.ts:197` | JSON object/list values bound verbatim (no schema check, no alias resolution). Bare word on `string \| string[]` → string branch → `ids[0]` (`run.ts:420-422`). Indexing regex `/^(.*)\[(\d+)\]$/`. Alias binds to records before entities. No `include` / `use` | limits 5–8 of the functional spec |
| Airfoils | `packages/domain-aero/src/surfacing/airfoilCommands.ts:56-57,66,122-131` | `affected = [airfoilId, curveEntityId]`; `loft_sections` needs entity ids (`loft.ts:39,126`) | alias → record, unusable in a loft |
| Installer | `desktop/package.json:33`, `server/package.json:30` (`"llull": "file:.."`, not imported by any source); `desktop/scripts/prepare-python.mjs:61-65` (`execFileSync('tar', …)`) | electron-builder treats the repo as a production dependency; `tar` chosen by `PATH` | 16 GB unpacked; Windows extract failure |

Related specs: [`../../decisions/LIM1-scale.md`](../../decisions/LIM1-scale.md) (list-of-tools booleans, 400 tools in 1.9 s for
simple cuts), [`../../physics/21-functional-prototype/TECHNICAL_SPEC.md`](../../physics/21-functional-prototype/TECHNICAL_SPEC.md)
(check_assembly, FR-FPR-*), [`../../aerospace/01-exact-brep-kernel/`](../../aerospace/01-exact-brep-kernel/) (TR-KRN-*, TR-KRN-12 fuzzy),
[`../02-sweep-loft-guides/`](../02-sweep-loft-guides/) (loft fit), [`../../DESIGN_LANGUAGE.md`](../../DESIGN_LANGUAGE.md).

## 2. Target architecture

| Milestone | Layer | Placement | Laws |
| --------- | ----- | --------- | ---- |
| M0 installer | `desktop/`, `server/` packaging | drop the `file:..` dependency; extract with a pinned extractor | L6 (host only) |
| M1 kernel booleans | native `llull-kernel` (Rust + C++ facade), `server/src/isolatedKernel.ts` | General Fuse options, progress / cancel protocol, pattern-sector fuse as a native op behind `GeometryKernel` | L9 (kernel behind port), C7 (native) |
| M2 instances | core `commands/edit/transform.ts`, `geometry/`, `src/ui/viewport/3d`, exchange | `as: "instances"` on arrays → component + instances; renderer instancing; STEP / glTF writers | L1, L4, L7, L8 |
| M3 assembly check | core `geometry/assemblyCheck/*`, kernel port additions, new commands in `commands/review/` | BVH broad phase, mesh narrow phase, exact confirm, symmetry reduction, pair cache, connection groups | L1, L3, L9 |
| M4 design language | `packages/design-lang/src` (plugin `design`) | expression evaluator, typed values, modules; still ONE `design_source` step | L8, removability (DESIGN_LANGUAGE §2) |
| M5 fidelity | core `geometry/bounds.ts`, `commands/solids/loft.ts`, kernel `features.cxx` | exact boxes via kernel; polygon-preserving ruled loft | L9 |
| M6 visibility | `desktop/` (main process), `server/` route, core command `capture_viewport` | the command asks the host through an injected port `ctx.viewportCapture` (absent ⇒ named refusal) | L2 (no DOM in core), L6 |

No law needs to change. `capture_viewport` is a read-only command whose effect lives in the host behind a port, like
`ctx.raster`.

### Technical requirements

| Id | Pri | Requirement | FR | AF |
| -- | --- | ----------- | -- | -- |
| TR-ASC-01 | MUST | `desktop/package.json` and `server/package.json` drop `"llull": "file:.."`; `electron-builder.yml` `files` excludes `node_modules/**` except declared runtime deps; a packaging test asserts no repo folder in `resources` | 01 | AF-41 |
| TR-ASC-02 | MUST | `prepare-python` extracts with a path-agnostic extractor (Node `tar` package or `%SystemRoot%\System32\tar.exe` on Windows), never the first `tar` on `PATH` | 02 | AF-41 |
| TR-ASC-03 | MUST | native `fuse_many` / `cut_many`: one `BRepAlgoAPI_Fuse` / `Cut` with `SetArguments` + `SetTools`, `SetRunParallel(true)`, `SetUseOBB(true)`, `SetCheckInverted(false)` after one validity pass, `SetToFillHistory` only when needed, `SetNonDestructive(true)`; result validated by `BRepCheck_Analyzer`; on failure the balanced-tree recipe runs and `KRN_FUSE_FALLBACK` is reported (§5.1) | 03 | AF-13 |
| TR-ASC-04 | MUST | every native op takes a `Message_ProgressRange` from an indicator whose `UserBreak()` honours the deadline and a cancel message; the sidecar returns `KRN_TIMEOUT {stage, fraction}` and stays alive; `isolatedKernel.ts` hard-kills only after deadline + 5 s (§5.1) | 04 | AF-40, AF-11 |
| TR-ASC-05 | SHOULD | native `pattern_fuse {body, seed, pattern}` per §5.2, chosen automatically by `boolean` when eligible; result equal to the full fuse (volume 1e-6 rel., face count) | 05 | AF-13 |
| TR-ASC-06 | MUST | `as: "instances"` on `array_polar` / `array_linear` producing a component + instances re-derived on replay; viewport `InstancedMesh` per (definition, material), `BatchedMesh` for unique parts, picking by `instanceId`; STEP NAUO + `mapped_item`; glTF `EXT_mesh_gpu_instancing` (§3, §5.4, §6) | 06, 07 | AF-01, AF-13 |
| TR-ASC-07 | MUST | `check_assembly`: `MAX_PARTS` 20,000; BVH + OBB broad phase (§5.3 steps 1–2) | 08 | AF-12 |
| TR-ASC-08 | MUST | mesh narrow phase (`BRepExtrema_ShapeProximity`, Manifold volume) with exact confirmation of every reported hard / contained / touch-near-deflection pair (§5.3 steps 4–5) | 08 | AF-35 |
| TR-ASC-09 | MUST | native batch `check_pairs` on a thread pool; symmetry reduction for rigid patterns (§5.3 steps 3, 6) | 08, 09 | AF-40 |
| TR-ASC-10 | SHOULD | pair-result cache keyed by shape hashes + relative transform + tolerances (§5.3 step 7) | 13 | AF-40 |
| TR-ASC-11 | MUST | connection groups and fastener tag in `doc.prototype` with commands of §4.3; connectivity rule of §4.3 | 10, 11, 12 | AF-11, AF-20, AF-33 |
| TR-ASC-12 | MUST | `.lld` alias arity typing and expression indexing (§4.4 R1, R2) | 14, 15 | AF-11 |
| TR-ASC-13 | MUST | `.lld` shared pure evaluator: value grammar with schema binding, ranges, comprehensions, `if`, `let`, built-ins, functions, `expand_design`; `af.entity` (§4.4, §5.5) | 16, 17, 18, 20, 21 | AF-05, AF-13 |
| TR-ASC-14 | SHOULD | `.lld` modules with typed params, namespacing, auto layer + group, DAG imports, SHA-256 embedded sources (§3 `DesignSource`, §4.4 R6) | 19 | AF-13, AF-41 |
| TR-ASC-15 | MUST | bounds of kernel-backed entities from `BRepBndLib::AddOptimal` on the transformed shape; `data.bounds = 'conservative'` otherwise (§4.5) | 22 | AF-21 |
| TR-ASC-16 | MUST | ruled `loft_sections` through polygon sections built from exact segments (`BRepBuilderAPI_MakePolygon`), vertex pairing by index after seam alignment, `LOFT_VERTEX_COUNT` (§4.5) | 23 | AF-11 |
| TR-ASC-17 | MUST | `capture_viewport` through injected `ctx.viewportCapture` (desktop: offscreen frame, temporary camera, `webContents.capturePage`); `render_view` routes over-budget scenes to it or to `ctx.raster`, else `RENDER_BUDGET_EXCEEDED` (§4.6) | 24, 25 | AF-22, AF-12 |

## 3. Data model

```ts
// M2 — patterns as instances (packages/core/src/model/types.ts)
interface PatternInstanceSet {          // stored on the pattern's FeatureStep result, re-derived on replay (L8)
  componentId: string;                  // definition (existing create_component machinery)
  instanceIds: readonly string[];       // existing instance entities, kind 'instance'
  pattern: { kind: 'polar'; axis: Vec3; center: Vec3; angle: number; count: number }
         | { kind: 'linear'; direction: Vec3; spacing: number; count: number };
}

// M3 — connection groups (doc.prototype, next to grounding and interference intents)
type ConnectionKind = 'bolted' | 'bonded' | 'welded' | 'press_fit' | 'thread';
interface ConnectionGroup {
  id: string;                           // conn-<step>.<k>
  name: string;
  kind: ConnectionKind;
  members: ConnectionMembers;           // resolved at check time, so patterns and layers stay live
  detect?: { toleranceMm: number; faceAngleDeg: number; cylindrical: 'include' | 'exclude' | 'only' };
  reason: string;
  declaredBy: 'agent' | 'user';
}
type ConnectionMembers =
  | { ids: readonly string[] }
  | { patternOf: string }               // every instance / copy of a pattern seed (FR-ASC-11)
  | { layerId: string } | { groupId: string };

// M3 — fastener tag (entity property bag)
interface EntityTags { fastener?: true }

// M3 — pair cache (server-side, not in the document)
type PairKey = `${string}:${string}:${string}`; // hash(a) : hash(b) : hash(relative transform)

// M4 — design step source with modules
interface DesignSource {
  source: string;                       // root .lld text
  modules?: readonly { path: string; sha256: string; text: string }[]; // embedded, so replay needs no files
  languageVersion: '2';
}
```

Document version: new optional fields only. Old documents load unchanged (no migration). Following the owner rule of
2026-10-22 (no backward compatibility for legacy behaviour), the `.lld` changes in §4.4 that alter meaning (bare
alias → all ids) apply to every design. A version-1 design that relied on first-id binding is refused with
`DESIGN_ALIAS_ARITY`, which names the fix.

## 4. Commands

### 4.1 Kernel booleans (M1)

`boolean` keeps its schema. Changes are internal:

- `b` as a list → native `fuse_many` / `cut_many`: one General Fuse with `arguments = [a]`, `tools = b` (no balanced
  tree). The `balancedUnion` recipe stays as the fallback when the native op reports an invalid result (TR-ASC-03).
- New optional param `pattern` is NOT added to `boolean`: pattern-aware fuse is chosen automatically when every tool is a
  rigid copy of one seed under one pattern (`patternSourceId` or instance set) and every copy meets `a` in congruent
  positions (TR-ASC-05). The summary says `pattern fuse (sector ×N)`.

### 4.2 Instances (M2)

| Command | Change | Annotations |
| ------- | ------ | ----------- |
| `array_polar`, `array_linear` | param `as: "copies" \| "instances"` (default `copies`). `instances` wraps the source in a component (or reuses its component) and inserts N instances | `@affects entities, components` `@invariant replay re-derives the same instance ids` `@failure ARRAY_SOURCE_NOT_SOLID` |
| `boolean` | accepts instances in `b` (each expanded through its transform); a pattern instance set triggers the pattern fuse | unchanged |
| `explode_instance` | unchanged (converts back to copies) | — |

### 4.3 Assembly check (M3)

| Command | Kind | Params sketch | Notes |
| ------- | ---- | ------------- | ----- |
| `add_connection_group` | mutating, toolset `review` | `{ name, kind, members, detect?, reason }` | `@affects doc.prototype.connections` `@failure CONN_MEMBERS_EMPTY, CONN_REASON_EMPTY, CONN_UNKNOWN_MEMBER` |
| `delete_connection_group` | mutating | `{ id }` | |
| `set_fastener` | mutating | `{ ids, fastener: boolean }` | tag only |
| `check_assembly` | query (existing) | new optional `{ symmetry: 'auto' \| 'off', cache: boolean, narrowPhase: 'auto' \| 'exact' }` | `MAX_PARTS` → 20,000; adds `connections[]` and `symmetry{ patterns, pairsSkipped }` to `data` |

Connectivity rule (replaces `connectivity.ts` strong-link set): strong link = same body ∨ joint ∨ intent
(weld/thread/press-fit) ∨ hard/allowed overlap ∨ **both parts in one connection group** (with `detect`: only pairs
that touch within `toleranceMm` and face angle). `RESTING_ONLY` is then reported only for parts whose touches are not
covered by any group.

### 4.4 Design language (M4)

| Feature | Grammar sketch | Errors |
| ------- | -------------- | ------ |
| Arity typing (R1) | alias kind fixed at definition: `single` (one id) or `group` (several). `string\|string[]` param: group → all ids. `string` param: group → error | `DESIGN_ALIAS_ARITY` "line 42: cut b= expects one id, got group 'ribs' (12 ids). Use ribs[0] or [ribs]" |
| Expression index (R2) | `alias[expr]`, `alias[-1]`, `alias[a..<b]` | `DESIGN_INDEX_RANGE` |
| Value grammar (R3) | `{ key: expr, … }` and `[expr, …]` parsed as `.lld` values (bare keys, alias refs, params); JSON stays accepted as a subset; each element validated against the zod element schema | `DESIGN_VALUE_SCHEMA` with path `sections[3].span` |
| List expressions (R4) | `a..b`, `a..<b`; `[for i in r: expr]`, `[for i in r if c: expr]`, `each`; `if c then a else b`; `let x = e in body`; built-ins `len sum concat zip linspace` | `DESIGN_EXPR_TYPE`, `DESIGN_LIST_LIMIT` (> 100,000 items) |
| Functions (R5) | `fn name(a, b = 2) = expr` at top level; pure; no commands; no recursion (call graph must be acyclic) | `DESIGN_FN_RECURSION`, `DESIGN_FN_ARGS` |
| Record + entity alias (FR-ASC-21) | `af.entity` = first created entity of a line whose alias names records; `af.entities` = all | `DESIGN_NO_ENTITY` |
| Modules (R6) | `module name(p: length = 1800, n: int = 24) { … export a, b }` in its own file; `use "path.lld" as ns with p=… n=…`; aliases namespaced `ns.a`; layer and group `ns` created automatically | `DESIGN_MODULE_NOT_FOUND`, `DESIGN_MODULE_CYCLE`, `DESIGN_MODULE_PATH` (absolute or outside root), `DESIGN_MODULE_HASH_CHANGED` (warn on regeneration from files), `DESIGN_MODULE_PARAM` |
| Expand (R7) | new read-only command `expand_design { source? }` → `data.lines[]` (file, line, command, resolved params) | — |

Every feature expands to the same flat command list before `execute` runs, in one `design_source` step (L8 intact).

### 4.5 Fidelity (M5)

- `measure_bounding_box` and every bounds consumer: for any entity with a kernel shape, use the kernel's optimal box of
  the *transformed* shape (`BRepBndLib::AddOptimal(shape, box, useTriangulation=false, useShapeTolerance=false)`) [R7].
  Without a kernel, keep the analytic and corner paths, and flag `data.bounds = 'conservative'`.
- `loft_sections`: when every section is a polygon (rectangle, closed polyline) and `ruled: true`, or `coupling:
  'vertices'` is given, build each section as a closed polyline of exact line segments (`BRepBuilderAPI_MakePolygon`).
  No resampling, no Catmull-Rom. Corresponding vertices are paired by index after seam alignment (same vertex count
  required, else `LOFT_VERTEX_COUNT`). `BRepOffsetAPI_ThruSections(ruled=true)` then yields planar or bilinear faces.

### 4.6 Visibility (M6)

| Command | Kind | Params | Behaviour |
| ------- | ---- | ------ | --------- |
| `capture_viewport` | query, toolset `core` | `{ view?, direction?, target?, zoom?, width (64..4096), height, background?, hideLayers? }` | needs `ctx.viewportCapture`; desktop host renders an offscreen frame of the current document with the given camera (not the user's), `webContents.capturePage` [R30] → PNG in `data.image` (`--save x.png`). No app ⇒ `VIEWPORT_UNAVAILABLE` |
| `render_view` | query (existing) | unchanged | over budget: use `ctx.viewportCapture` when present, else `ctx.raster` (native), else return the best effort with `RENDER_BUDGET_EXCEEDED` warning and `data.drawnShare` |

## 5. Kernel and algorithms

### 5.1 General Fuse configuration (TR-ASC-02..04)

```cpp
BRepAlgoAPI_Fuse op;                    // or Cut
op.SetArguments(args);                  // {a}
op.SetTools(tools);                     // all tools, no pre-union
op.SetRunParallel(true);                // [R1][R4]
op.SetUseOBB(true);                     // tighter boxes for twisted blades [R1]
op.SetCheckInverted(false);             // up to 10 % on many solids; inputs validated once [R1]
op.SetToFillHistory(needHistory);       // off unless naming needs it [R4]
op.SetNonDestructive(true);             // cached input shapes stay valid [R1]
op.Build(progress.Start());             // Message_ProgressRange [R5]
if (op.HasErrors() || !BRepCheck_Analyzer(op.Shape()).IsValid()) fallback_tree();
```

Then `ShapeUpgrade_UnifySameDomain` as today.

**Progress and cancel (TR-ASC-04).** A `Message_ProgressIndicator` subclass whose `UserBreak()` returns true after
the call deadline or on a cancel message on the sidecar channel. `Show()` streams `{ stage, fraction }`. After `Build`,
a user-break alert in `GetReport()` ⇒ the sidecar returns `{ error: 'KRN_TIMEOUT', stage, fraction }` and stays alive.
`isolatedKernel.ts` waits `deadline + grace (5 s)` before the hard kill it does today, which stays as the last resort.
Cancel latency is bounded by OCCT's stage polling [R6].

### 5.2 Pattern-sector fuse (TR-ASC-05)

Inputs: body `a`, seed tool `t`, rigid pattern `{R_k}` (k = 0…N−1, polar angle 2π/N), all copies overlapping `a`.

1. Check eligibility:
   - `a` is invariant under `R_1`: revolve about the pattern axis, or a stored symmetry. Otherwise fall back.
   - The sector half-planes at ±π/N do not intersect `t` (`BRepExtrema_DistShapeShape(t, plane) > tol`).
2. Sector `S = a ∩ wedge(−π/N, +π/N)` (`BRepAlgoAPI_Common` with a half-space pair).
3. `U = S ∪ t` (one small boolean).
4. Copies `U_k = U.Moved(R_k)` (`TopLoc_Location`, shared TShape) [R1].
5. Result: compound of `U_k` when the consumer accepts compounds. Otherwise one General Fuse of all `U_k` with
   `SetGlue(BOPAlgo_GlueFull)`: the cut faces of neighbours coincide exactly by construction [R1]. Validate with
   `BRepCheck_Analyzer`.

Cost: 2 small booleans plus N transforms, plus one glued fuse (reported up to 90 % faster than a plain fuse [R1]).

### 5.3 Assembly check at scale (TR-ASC-07..10)

1. **Boxes.** Per part, an OBB `Bnd_OBB` from `BRepBndLib::AddOBB(shape, obb, true, isOptimal=true)` and an optimal
   AABB [R7]. For a pattern, compute both on the master and transform them for each instance.
2. **Broad phase.** BVH over AABBs (rewrite `pairClassify.ts`; sort-and-sweep stays for < 200 parts), then an OBB
   separating-axis test. Target candidate count k ≈ 6–10 per part on dense assemblies.
3. **Symmetry reduction.** For a pattern P of N rigid copies, pairs (i, j) map to (0, (j−i) mod N). Evaluate master vs
   copy d for d = 1…⌊N/2⌋, stopping at the first d whose boxes do not meet. For P vs an outside part Q, evaluate
   `Q·R_k⁻¹` against the master for every k, which uses the cache when Q is itself symmetric (revolves). Report results
   for every concrete pair (`data.symmetry.expanded = true`).
4. **Narrow phase, mesh.** `BRepExtrema_ShapeProximity(s1, s2, tol)` on existing triangulations: tolerance 0 finds
   intersecting faces, tolerance `epsTouch + clearance` finds touch / clearance [R2]. Overlap volume uses the Manifold
   mesh kernel (`intersect` + volume).
5. **Exact confirm.** Only for pairs reported hard or contained by the mesh phase, and for touch pairs whose mesh
   distance is within the deflection: exact `BRepAlgoAPI_Common` + `BRepGProp` volume and `BRepExtrema_DistShapeShape`
   with `SetMultiThread(true)` [R2]. The reported numbers are always exact (as today).
6. **Parallelism.** Pairs are independent. A native batch op `check_pairs` runs them on a thread pool (one shape copy
   per thread for meshing).
7. **Cache.** Key = (shape hash a, shape hash b, relative transform hash, tolerances). Lives in the server process
   (LRU, 64 MB), invalidated by content, never by time.

### 5.4 Instance rendering (TR-ASC-06)

One `THREE.InstancedMesh` per (component definition, material), with `setMatrixAt` per instance and the bounding sphere
recomputed after edits [R19]. Unique parts go into `BatchedMesh` per material with per-object culling [R19]. Picking
maps `instanceId` to the instance entity. Draw calls are measured with `renderer.info.render.calls`. Instancing does
not reduce vertex work [R19], so far instances use the decimated LOD from `llull-meshops`.

### 5.5 Design-language evaluator (TR-ASC-11..14)

One pure evaluator shared by values, comprehensions, functions and modules:

- **Types:** number (with unit literals as today), boolean, string, list, object, alias-ref (single / group), anchor.
- **Totality:** comprehension ranges are finite, at most 100,000 items per list; functions are non-recursive (checked
  on the call graph); module imports form a DAG.
- **Determinism:** no clock, no randomness, no environment.
  - Module paths are relative to the root file and must stay inside its folder.
  - Each module text is hashed (SHA-256) and embedded in the step (`DesignSource.modules`).
  - Regeneration uses the embedded text. `llull apply_design` from files reports changed hashes.
- **Schema binding:** `bindValue` (`schemaValue.ts`) evaluates object and list nodes against the zod JSON schema of
  the target param, element by element. The verbatim `json` branch is removed; a JSON literal is a valid `.lld` value.

## 6. Interop and persistence

- STEP AP242 (`export_step_ap242`): one product per component definition, one `next_assembly_usage_occurrence` per
  instance, shape reuse through `mapped_item` [R20]; XCAF assembly in the writer. Connection groups go out as names in
  product descriptions (no AP242 fastener entity found [R31]).
- glTF (`export_gltf`): instances as `EXT_mesh_gpu_instancing` (`TRANSLATION`, `ROTATION`, `SCALE`) [R21].
- `.llull` documents: new fields per §3, optional. Pattern instance sets are re-derived on load from the feature step.

## 7. Surfaces and stable error codes

| Code | Raised by | Meaning / fix |
| ---- | --------- | ------------- |
| `KRN_TIMEOUT` | any kernel op | deadline reached at `stage` (`fraction`); raise `LLULL_OCC_TIMEOUT_MS` or simplify |
| `KRN_FUSE_FALLBACK` (warn) | boolean | General Fuse result invalid; the balanced-tree path was used |
| `PATTERN_FUSE_INELIGIBLE` (info) | boolean | why the pattern path was not used (body not symmetric, sector plane cuts the tool) |
| `ARRAY_SOURCE_NOT_SOLID` | array_* `as:"instances"` | instancing needs a 3D solid or component |
| `CONN_MEMBERS_EMPTY` / `CONN_UNKNOWN_MEMBER` / `CONN_REASON_EMPTY` | add_connection_group | fix members or reason |
| `FPR_CONN_STALE` (warn) | check_assembly | a group member no longer exists |
| `FPR_FASTENER_THREAD` (info) | check_assembly | fastener-to-host overlap, reported apart |
| `CHECK_PART_LIMIT` | check_assembly | above 20,000 parts; narrow with ids, component or layer |
| `DESIGN_ALIAS_ARITY` / `DESIGN_INDEX_RANGE` / `DESIGN_VALUE_SCHEMA` / `DESIGN_EXPR_TYPE` / `DESIGN_LIST_LIMIT` / `DESIGN_FN_RECURSION` / `DESIGN_FN_ARGS` / `DESIGN_NO_ENTITY` | design language | see §4.4 |
| `DESIGN_MODULE_NOT_FOUND` / `DESIGN_MODULE_CYCLE` / `DESIGN_MODULE_PATH` / `DESIGN_MODULE_PARAM` / `DESIGN_MODULE_HASH_CHANGED` (warn) | design language | see §4.4 |
| `LOFT_VERTEX_COUNT` | loft_sections | polygon sections need equal vertex counts for exact ruled lofts |
| `VIEWPORT_UNAVAILABLE` | capture_viewport | no desktop app; use `--app` or `render_view renderer=native` |
| `RENDER_BUDGET_EXCEEDED` (warn) | render_view | not everything drawn; `drawnShare` given |

CLI: every command is reached through the registry (AF-01). `--progress` shows kernel stages (AF-40). UI: Connections
panel (list, highlight members), instance highlighting, check results with pair focus.

## 8. Performance and robustness budgets (reference machine: the owner's Windows 11 workstation)

| Operation | Today | Budget |
| --------- | ----- | ------ |
| Fuse disk + 36 lofted blades (61-point sections) | 26.4 s | ≤ 10 s (GF); ≤ 1 s (pattern fuse) |
| Fuse disk + 80 blades | > 30 s (killed) | ≤ 2 s (pattern fuse) |
| `check_assembly`, 2,450-part turbofan | refused (> 500) | ≤ 60 s cold, ≤ 10 s with a warm cache after a one-module edit |
| `check_assembly`, 175 parts | 269–283 s | ≤ 20 s |
| Turbofan `apply_design` (instances) | 12 s | ≤ 12 s |
| Viewport, turbofan at full detail | not measured | ≥ 30 fps orbit; ≤ 200 draw calls |
| `capture_viewport` 1600×1000 | — | ≤ 3 s |
| `.lld` evaluation overhead | — | ≤ 5 % of apply time; 100,000-item list ≤ 1 s |

Robustness: every native op keeps the existing worker isolation; a cancelled op leaves no partial document change
(commands stay pure, L3).

## 9. Test strategy

| Level | What | VC |
| ----- | ---- | -- |
| packaging script test (`desktop/tests`) | `stage:server` and builder config exclude repo folders; the extractor is path-agnostic | VC-ASC-01, 02 |
| native reference tests (`server/tests/nativeKernelReference.test.ts`) | GF options, multi-tool fuse volume, progress, cancel, pattern fuse equivalence | VC-ASC-03…06 |
| unit (core) | `as:"instances"` arrays, replay ids, connection groups, connectivity rule, symmetry expansion, bounds | VC-ASC-07, 10…13, 20 |
| unit (design-lang) | arity, indexing, value grammar, comprehensions, functions, modules, hashes, expand | VC-ASC-14…19 |
| golden (`tests/golden`) | a bladed disk plan and a two-module `.lld` regenerate with identical ids | VC-ASC-04, 18 |
| component / desktop tests | instanced render draw calls, picking, `capture_viewport` through the desktop backend | VC-ASC-08, 22 |
| scale gate (`scripts/scaleGate.mjs`) | turbofan rebuild, check_assembly 2,450 parts, viewport fps | VC-ASC-10, 11, 23 |
| exchange | STEP occurrence count, glTF instancing | VC-ASC-09 |

## 10. Delivery plan

| Milestone | Content | Depends on | Effort (agent-days) |
| --------- | ------- | ---------- | ------------------- |
| M0 | installer: remove `file:..` deps, pinned extractor, CI packaging check | — | 0.5 |
| M1a | GF multi-tool fuse with options; progress / cancel protocol; `KRN_TIMEOUT` | — | 3 |
| M4a | `.lld` arity typing, expression indexing, `af.entity` | — | 2 |
| M6a | `capture_viewport` (desktop port, server route, command) | — | 2 |
| M5 | exact bounds; polygon-preserving ruled loft | — | 2 |
| M1b | pattern-sector fuse | M1a | 3 |
| M2 | instance arrays, renderer instancing, STEP / glTF instancing, booleans on instances | M1b for fuse | 6 |
| M3 | BVH + OBB broad phase, mesh narrow phase, exact confirm, native batch, symmetry, cache; connection groups, fastener tag | M2 (symmetry from instance sets) | 7 |
| M4b | value grammar, comprehensions, conditionals, let, built-ins, functions, `expand_design` | M4a | 5 |
| M4c | modules (`use … as … with`), typed params, namespacing, auto layer and group, hashes | M4b | 4 |
| M6b | `render_view` GPU routing | M6a | 1 |

Total ≈ 35 agent-days. Recommended order: M0 → M1a → M4a → M6a → M5 → M1b → M4b → M2 → M3 → M4c → M6b. Each
milestone is reviewed by `cad-reviewer` and gated by `npm run check:coverage`.

## 11. Open questions and proposed decisions

| # | Question | Proposed |
| - | -------- | -------- |
| D1 | Default of `array_* as` | `copies` until every command accepts instances, then `instances` for solids |
| D2 | Should `check_assembly` treat touching faces as connected when no group covers them? | no: keep `RESTING_ONLY` (honest). Groups with `detect` make declaration cheap |
| D3 | Symmetry reduction on by default | yes (`symmetry: 'auto'`), with an `off` switch for audits |
| D4 | `.lld` bare alias semantics change (first id → all ids) | apply to all designs, no compatibility mode (owner rule no-backward-compat) |
| D5 | Module source of truth: files or the embedded copy | the embedded copy (replayable). Files are an authoring convenience; `apply_design` re-reads them and reports changes |
| D6 | Where viewport capture renders | offscreen frame in the running desktop renderer with a temporary camera; hidden `BrowserWindow` when the window is minimised |
| D7 | Native batch check language | Rust + C++ facade in `llull-kernel` (C7, Rust default), Manifold for mesh volumes |

## 12. References

[R1]–[R32] as in [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md) §11; grades and extracts in [`validation/sources.md`](validation/sources.md).
