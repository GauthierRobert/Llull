# 08 ASC — Assembly scale — Technical specification

Status: specification only (2026-10-28). Functional view: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md). Validation:
[`validation/README.md`](validation/README.md). Laws: [`.claude/rules/architecture.md`](../../../.claude/rules/architecture.md).

## 1. Current state in llull (measured on main 52c1c51e, 2026-10-28)

| Area               | Where                                                                                                                                                                               | Behaviour today                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Limit                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Boolean tool list  | `packages/core/src/commands/brep/boolean.ts:35,41-45,88,95-97`                                                                                                                      | `b` = 1..1000 ids (`MAX_TOOLS`); tools combined by `balancedUnion` (recursive halving into nested `boolean union` recipe nodes), then ONE `{op:'boolean', a, b}` recipe sent to the kernel. `engine: auto` uses the mesh engine only when every operand is triangle-only. Instances are refused                                                                                                                                                                                 | union of disjoint tools re-intersected; superlinear       |
| Native boolean     | `solver/crates/llull-kernel-occt/src/recipe.rs:379-385`, `cpp/facade.cxx:286-318`                                                                                                   | `BRepAlgoAPI_Fuse/Cut/Common builder(a, b)` (two-shape constructor), then `ShapeUpgrade_UnifySameDomain(result, true, true, false)`. No `SetRunParallel`, `SetUseOBB`, `SetCheckInverted`, `SetFuzzyValue`, `SetToFillHistory`, no progress range. Fuzzy is still the open TR-KRN-12 (`server/tests/nativeKernelReference.test.ts:226` `it.todo`)                                                                                                                               | no parallelism, no cancellation                           |
| Kernel timeout     | `server/src/geometryKernel.ts:39-44` (`DEFAULT_OCC_CALL_TIMEOUT_MS = 30_000`, `LLULL_OCC_TIMEOUT_MS`), `server/src/isolatedKernel.ts:104-105,151,179,191`                           | `Atomics.wait`; on timeout the worker is killed and the call returns null (not retried)                                                                                                                                                                                                                                                                                                                                                                                         | lost work, unexplained `kernel returned null`             |
| Patterns           | `packages/core/src/commands/edit/transform.ts:149-167,174,214`; `commands/limits.ts:2` (`MAX_COPIES_PER_COMMAND = 10_000`)                                                          | `array_linear` / `array_polar` → full entity copies with `patternSourceId`. Components exist (`commands/assembly/assemblies.ts:62` `create_component`, `:133` `insert_instance`, `explode_instance`); `pattern_along_path` has a `componentId` instance mode (`edit/patternAlongPath.ts:72`)                                                                                                                                                                                    | no instance mode on arrays                                |
| check_assembly     | `packages/core/src/commands/inspect/assemblyCheckRun.ts:39-46,152,201,213,278-279`; `geometry/assemblyCheck/pairClassify.ts:30-102`; `geometry/assemblyCheck/connectivity.ts:46-77` | `MAX_PARTS = 500`, `MAX_PAIRS = 20_000`. Broad phase: sort-and-sweep on x then y/z interval test (no BVH). Narrow phase all kernel: `kernel.distance`, then exact `boolean intersect` + `analyze` for the volume. Connectivity union-find: strong links = same body, joints, weld/thread/press-fit intents, hard or allowed overlaps; touch = weak → `FPR_PART_RESTING_ONLY` (warn) / `FPR_PART_FLOATING` (fail). Instances are one part each (`geometry/assemblyParts.ts:2-3`) | cap, O(k) exact ops, no symmetry, per-pair intents only   |
| Intents, grounding | `commands/review/intents.ts:21-64`, `commands/review/grounding.ts:15`, `model/types.ts:661` (`doc.prototype`)                                                                       | `allow_interference {a, b, kind, reason}`, one pair per call                                                                                                                                                                                                                                                                                                                                                                                                                    | thousands of calls for a bladed row                       |
| Bounding box       | `commands/inspect/measureSolid.ts:36-44,57`; `geometry/bounds.ts:197-211,241-249,276-289`                                                                                           | exact OCC bounds only for meshes with a `brep`; otherwise analytic tight bounds for rotated cylinder/cone/sphere/torus, else the AABB of the 8 rotated local-AABB corners                                                                                                                                                                                                                                                                                                       | 1.37× radius on a rotated revolve                         |
| Ruled loft         | `commands/solids/loft.ts:39,57,126`; `geometry/sectionRing.ts:15,22,84-87`; `cpp/features.cxx:722-737`                                                                              | each section resampled to 24 arc-length points (`SECTION_RING_POINTS`), turned into a closed centripetal Catmull-Rom Bézier chain, then `BRepOffsetAPI_ThruSections(true, ruled, 1e-6)`. Exact path only when every section is a `nurbs_curve`                                                                                                                                                                                                                                  | rounded corners, non-planar "flat" faces                  |
| render_view        | `commands/render/budget.ts:8,28-73`; `render/scene.ts:20,79,109`; `render/renderView.ts:126`; `render/viewRequest.ts:34-35,85-96`                                                   | vector budget 20,000 (clamp 500–100,000), raster ≥ 400,000; over-budget entities decimated evenly (fair share). `renderer: "native"` = llull-compute raster through `ctx.raster`                                                                                                                                                                                                                                                                                                | fragments; no app capture verb (none in `server/src/cli`) |
| Design language    | `packages/design-lang/src/schemaValue.ts:156,192-205`; `run.ts:343-360,420-454`; `parse.ts:197`                                                                                     | JSON object/list values bound verbatim (no schema check, no alias resolution). Bare word on `string \| string[]` → string branch → `ids[0]` (`run.ts:420-422`). Indexing regex `/^(.*)\[(\d+)\]$/`. Alias binds to records before entities. No `include` / `use`                                                                                                                                                                                                                | limits 5–8 of the functional spec                         |
| Airfoils           | `packages/domain-aero/src/surfacing/airfoilCommands.ts:56-57,66,122-131`                                                                                                            | `affected = [airfoilId, curveEntityId]`; `loft_sections` needs entity ids (`loft.ts:39,126`)                                                                                                                                                                                                                                                                                                                                                                                    | alias → record, unusable in a loft                        |
| Installer          | `desktop/package.json:33`, `server/package.json:30` (`"llull": "file:.."`, not imported by any source); `desktop/scripts/prepare-python.mjs:61-65` (`execFileSync('tar', …)`)       | electron-builder treats the repo as a production dependency; `tar` chosen by `PATH`                                                                                                                                                                                                                                                                                                                                                                                             | 16 GB unpacked; Windows extract failure                   |

Related specs: [`../../decisions/LIM1-scale.md`](../../decisions/LIM1-scale.md) (list-of-tools booleans, 400 tools in 1.9 s for
simple cuts), [`../../physics/21-functional-prototype/TECHNICAL_SPEC.md`](../../physics/21-functional-prototype/TECHNICAL_SPEC.md)
(check*assembly, FR-FPR-*), [`../../aerospace/01-exact-brep-kernel/`](../../aerospace/01-exact-brep-kernel/) (TR-KRN-\_, TR-KRN-12 fuzzy),
[`../02-sweep-loft-guides/`](../02-sweep-loft-guides/) (loft fit), [`../../DESIGN_LANGUAGE.md`](../../DESIGN_LANGUAGE.md).

## 2. Target architecture

| Milestone          | Layer                                                                                      | Placement                                                                                                    | Laws                                  |
| ------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| M0 installer       | `desktop/`, `server/` packaging                                                            | drop the `file:..` dependency; extract with a pinned extractor                                               | L6 (host only)                        |
| M1 kernel booleans | native `llull-kernel` (Rust + C++ facade), `server/src/isolatedKernel.ts`                  | General Fuse options, progress / cancel protocol, pattern-sector fuse as a native op behind `GeometryKernel` | L9 (kernel behind port), C7 (native)  |
| M2 instances       | core `commands/edit/transform.ts`, `geometry/`, `src/ui/viewport/3d`, exchange             | `as: "instances"` on arrays → component + instances; renderer instancing; STEP / glTF writers                | L1, L4, L7, L8                        |
| M3 assembly check  | core `geometry/assemblyCheck/*`, kernel port additions, new commands in `commands/review/` | BVH broad phase, mesh narrow phase, exact confirm, symmetry reduction, pair cache, connection groups         | L1, L3, L9                            |
| M4 design language | `packages/design-lang/src` (plugin `design`)                                               | expression evaluator, typed values, modules; still ONE `design_source` step                                  | L8, removability (DESIGN_LANGUAGE §2) |
| M5 fidelity        | core `geometry/bounds.ts`, `commands/solids/loft.ts`, kernel `features.cxx`                | exact boxes via kernel; polygon-preserving ruled loft                                                        | L9                                    |
| M6 visibility      | `desktop/` (main process), `server/` route, core command `capture_viewport`                | the command asks the host through an injected port `ctx.viewportCapture` (absent ⇒ named refusal)            | L2 (no DOM in core), L6               |

No law needs to change. `capture_viewport` is a read-only command whose effect lives in the host behind a port, like
`ctx.raster`.

### Technical requirements

| Id        | Pri    | Requirement                                                                                                                                                                                                                                                                                                                                                                                   | FR                 | AF                  |
| --------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------- |
| TR-ASC-01 | MUST   | `desktop/package.json` and `server/package.json` drop `"llull": "file:.."`; `electron-builder.yml` `files` excludes `node_modules/**` except declared runtime deps; a packaging test asserts no repo folder in `resources`                                                                                                                                                                    | 01                 | AF-41               |
| TR-ASC-02 | MUST   | `prepare-python` extracts with a path-agnostic extractor (Node `tar` package or `%SystemRoot%\System32\tar.exe` on Windows), never the first `tar` on `PATH`                                                                                                                                                                                                                                  | 02                 | AF-41               |
| TR-ASC-03 | MUST   | native `fuse_many` / `cut_many`: one `BRepAlgoAPI_Fuse` / `Cut` with `SetArguments` + `SetTools`, `SetRunParallel(true)`, `SetUseOBB(true)`, `SetCheckInverted(false)` after one validity pass, `SetToFillHistory` only when needed, `SetNonDestructive(true)`; result validated by `BRepCheck_Analyzer`; on failure the balanced-tree recipe runs and `KRN_FUSE_FALLBACK` is reported (§5.1) | 03                 | AF-13               |
| TR-ASC-04 | MUST   | every native op takes a `Message_ProgressRange` from an indicator whose `UserBreak()` honours the deadline and a cancel message; the sidecar returns `KRN_TIMEOUT {stage, fraction}` and stays alive; `isolatedKernel.ts` hard-kills only after deadline + 5 s (§5.1)                                                                                                                         | 04                 | AF-40, AF-11        |
| TR-ASC-05 | SHOULD | native `pattern_fuse {body, seed, pattern}` per §5.2, chosen automatically by `boolean` when eligible; result equal to the full fuse (volume 1e-6 rel., face count)                                                                                                                                                                                                                           | 05                 | AF-13               |
| TR-ASC-06 | MUST   | `as: "instances"` on `array_polar` / `array_linear` producing a component + instances re-derived on replay; viewport `InstancedMesh` per (definition, material), `BatchedMesh` for unique parts, picking by `instanceId`; STEP NAUO + `mapped_item`; glTF `EXT_mesh_gpu_instancing` (§3, §5.4, §6)                                                                                            | 06, 07             | AF-01, AF-13        |
| TR-ASC-07 | MUST   | `check_assembly`: `MAX_PARTS` 20,000; BVH + OBB broad phase (§5.3 steps 1–2)                                                                                                                                                                                                                                                                                                                  | 08                 | AF-12               |
| TR-ASC-08 | MUST   | mesh narrow phase (`BRepExtrema_ShapeProximity`, Manifold volume) with exact confirmation of every reported hard / contained / touch-near-deflection pair (§5.3 steps 4–5)                                                                                                                                                                                                                    | 08                 | AF-35               |
| TR-ASC-09 | MUST   | native batch `check_pairs` on a thread pool; symmetry reduction for rigid patterns (§5.3 steps 3, 6)                                                                                                                                                                                                                                                                                          | 08, 09             | AF-40               |
| TR-ASC-10 | SHOULD | pair-result cache keyed by shape hashes + relative transform + tolerances (§5.3 step 7)                                                                                                                                                                                                                                                                                                       | 13                 | AF-40               |
| TR-ASC-11 | MUST   | connection groups and fastener tag in `doc.prototype` with commands of §4.3; connectivity rule of §4.3                                                                                                                                                                                                                                                                                        | 10, 11, 12         | AF-11, AF-20, AF-33 |
| TR-ASC-12 | MUST   | `.lld` alias arity typing and expression indexing (§4.4 R1, R2)                                                                                                                                                                                                                                                                                                                               | 14, 15             | AF-11               |
| TR-ASC-13 | MUST   | `.lld` shared pure evaluator: value grammar with schema binding, ranges, comprehensions, `if`, `let`, built-ins, functions, `expand_design`; `af.entity` (§4.4, §5.5)                                                                                                                                                                                                                         | 16, 17, 18, 20, 21 | AF-05, AF-13        |
| TR-ASC-14 | SHOULD | `.lld` modules with typed params, namespacing, auto layer + group, DAG imports, SHA-256 embedded sources (§3 `DesignSource`, §4.4 R6)                                                                                                                                                                                                                                                         | 19                 | AF-13, AF-41        |
| TR-ASC-15 | MUST   | bounds of kernel-backed entities from `BRepBndLib::AddOptimal` on the transformed shape; `data.bounds = 'conservative'` otherwise (§4.5)                                                                                                                                                                                                                                                      | 22                 | AF-21               |
| TR-ASC-16 | MUST   | ruled `loft_sections` through polygon sections built from exact segments (`BRepBuilderAPI_MakePolygon`), vertex pairing by index after seam alignment; unequal vertex counts resample as before with a `LOFT_VERTEX_COUNT` warning (replay, §4.5)                                                                                                                                             | 23                 | AF-11               |
| TR-ASC-17 | MUST   | `capture_viewport` through injected `ctx.viewportCapture` (desktop: offscreen frame, temporary camera, `webContents.capturePage`); `render_view` routes over-budget scenes to it or to `ctx.raster`, else `RENDER_BUDGET_EXCEEDED` (§4.6)                                                                                                                                                     | 24, 25             | AF-22, AF-12        |

## 3. Data model

```ts
// M2 — patterns as instances (packages/core/src/model/types.ts)
interface PatternInstanceSet {
  // stored on the pattern's FeatureStep result, re-derived on replay (L8)
  componentId: string; // definition (existing create_component machinery)
  instanceIds: readonly string[]; // existing instance entities, kind 'instance'
  pattern:
    | { kind: 'polar'; axis: Vec3; center: Vec3; angle: number; count: number }
    | { kind: 'linear'; direction: Vec3; spacing: number; count: number };
}

// M3 — connection groups (doc.prototype, next to grounding and interference intents)
type ConnectionKind = 'bolted' | 'bonded' | 'welded' | 'press_fit' | 'thread';
interface ConnectionGroup {
  id: string; // conn-<step>.<k>
  name: string;
  kind: ConnectionKind;
  members: ConnectionMembers; // resolved at check time, so patterns and layers stay live
  detect?: { toleranceMm: number; faceAngleDeg: number; cylindrical: 'include' | 'exclude' | 'only' };
  reason: string;
  declaredBy: 'agent' | 'user';
}
type ConnectionMembers =
  | { ids: readonly string[] }
  | { patternOf: string } // every instance / copy of a pattern seed (FR-ASC-11)
  | { layerId: string }
  | { groupId: string };

// M3 — fastener tag (entity property bag)
interface EntityTags {
  fastener?: true;
}

// M3 — pair cache (server-side, not in the document)
type PairKey = `${string}:${string}:${string}`; // hash(a) : hash(b) : hash(relative transform)

// M4 — design step source with modules
interface DesignSource {
  source: string; // root .lld text
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

| Command                       | Change                                                                                                                                                | Annotations                                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `array_polar`, `array_linear` | param `as: "copies" \| "instances"` (default `copies`). `instances` wraps the source in a component (or reuses its component) and inserts N instances | `@affects entities, components` `@invariant replay re-derives the same instance ids` `@failure ARRAY_SOURCE_NOT_SOLID` |
| `boolean`                     | accepts instances in `b` (each expanded through its transform); a pattern instance set triggers the pattern fuse                                      | unchanged                                                                                                              |
| `explode_instance`            | unchanged (converts back to copies)                                                                                                                   | —                                                                                                                      |

### 4.3 Assembly check (M3)

| Command                   | Kind                       | Params sketch                                                                                | Notes                                                                                                      |
| ------------------------- | -------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `add_connection_group`    | mutating, toolset `review` | `{ name, kind, members, detect?, reason }`                                                   | `@affects doc.prototype.connections` `@failure CONN_MEMBERS_EMPTY, CONN_REASON_EMPTY, CONN_UNKNOWN_MEMBER` |
| `delete_connection_group` | mutating                   | `{ id }`                                                                                     |                                                                                                            |
| `set_fastener`            | mutating                   | `{ ids, fastener: boolean }`                                                                 | tag only                                                                                                   |
| `check_assembly`          | query (existing)           | new optional `{ symmetry: 'auto' \| 'off', cache: boolean, narrowPhase: 'auto' \| 'exact' }` | `MAX_PARTS` → 20,000; adds `connections[]` and `symmetry{ patterns, pairsSkipped }` to `data`              |

Connectivity rule (replaces `connectivity.ts` strong-link set): strong link = same body ∨ joint ∨ intent
(weld/thread/press-fit) ∨ hard/allowed overlap ∨ **both parts in one connection group** (with `detect`: only pairs
that touch within `toleranceMm` and face angle). `RESTING_ONLY` is then reported only for parts whose touches are not
covered by any group.

### 4.4 Design language (M4)

| Feature                           | Grammar sketch                                                                                                                                                                             | Errors                                                                                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Arity typing (R1)                 | alias kind fixed at definition: `single` (one id) or `group` (several). `string\|string[]` param: group → all ids. `string` param: group → error                                           | `DESIGN_ALIAS_ARITY` "line 42: cut b= expects one id, got group 'ribs' (12 ids). Use ribs[0] or [ribs]"                                                                                  |
| Expression index (R2)             | `alias[expr]`, `alias[-1]`, `alias[a..<b]`                                                                                                                                                 | `DESIGN_INDEX_RANGE`                                                                                                                                                                     |
| Value grammar (R3)                | `{ key: expr, … }` and `[expr, …]` parsed as `.lld` values (bare keys, alias refs, params); JSON stays accepted as a subset; each element validated against the zod element schema         | `DESIGN_VALUE_SCHEMA` with path `sections[3].span`                                                                                                                                       |
| List expressions (R4)             | `a..b`, `a..<b`; `[for i in r: expr]`, `[for i in r if c: expr]`, `each`; `if c then a else b`; `let x = e in body`; built-ins `len sum concat zip linspace`                               | `DESIGN_EXPR_TYPE`, `DESIGN_LIST_LIMIT` (> 100,000 items)                                                                                                                                |
| Functions (R5)                    | `fn name(a, b = 2) = expr` at top level; pure; no commands; no recursion (call graph must be acyclic)                                                                                      | `DESIGN_FN_RECURSION`, `DESIGN_FN_ARGS`                                                                                                                                                  |
| Record + entity alias (FR-ASC-21) | `af.entity` = first created entity of a line whose alias names records; `af.entities` = all                                                                                                | `DESIGN_NO_ENTITY`                                                                                                                                                                       |
| Modules (R6)                      | `module name(p: length = 1800, n: int = 24) { … export a, b }` in its own file; `use "path.lld" as ns with p=… n=…`; aliases namespaced `ns.a`; layer and group `ns` created automatically | `DESIGN_MODULE_NOT_FOUND`, `DESIGN_MODULE_CYCLE`, `DESIGN_MODULE_PATH` (absolute or outside root), `DESIGN_MODULE_HASH_CHANGED` (warn on regeneration from files), `DESIGN_MODULE_PARAM` |
| Expand (R7)                       | new read-only command `expand_design { source? }` → `data.lines[]` (file, line, command, resolved params)                                                                                  | —                                                                                                                                                                                        |

Every feature expands to the same flat command list before `execute` runs, in one `design_source` step (L8 intact).

### 4.5 Fidelity (M5)

- `measure_bounding_box` and every bounds consumer: for any entity with a kernel shape, use the kernel's optimal box of
  the _transformed_ shape (`BRepBndLib::AddOptimal(shape, box, useTriangulation=false, useShapeTolerance=false)`) [R7].
  Without a kernel, keep the analytic and corner paths, and flag `data.bounds = 'conservative'`.
- `loft_sections`: when every section is a polygon (rectangle, closed polyline) and `ruled: true`, or `coupling:
'vertices'` is given, build each section as a closed polyline of exact line segments (`BRepBuilderAPI_MakePolygon`).
  No resampling, no Catmull-Rom. Corresponding vertices are paired by index after seam alignment (same vertex count
  required; with unequal counts the loft is resampled as before M5 and the summary carries the warning
  `LOFT_VERTEX_COUNT`, because a refusal would break replay of saved histories, L8). Planar or bilinear side faces.

### 4.6 Visibility (M6)

| Command            | Kind                  | Params                                                                                      | Behaviour                                                                                                                                                                                                                                    |
| ------------------ | --------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture_viewport` | query, toolset `core` | `{ view?, direction?, target?, zoom?, width (64..4096), height, background?, hideLayers? }` | needs `ctx.viewportCapture`; desktop host renders an offscreen frame of the current document with the given camera (not the user's), `webContents.capturePage` [R30] → PNG in `data.image` (`--save x.png`). No app ⇒ `VIEWPORT_UNAVAILABLE` |
| `render_view`      | query (existing)      | unchanged                                                                                   | over budget: use `ctx.viewportCapture` when present, else `ctx.raster` (native), else return the best effort with `RENDER_BUDGET_EXCEEDED` warning and `data.drawnShare`                                                                     |

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

| Code                                                                                                                                                                           | Raised by                  | Meaning / fix                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- | ---------------------------------------------------------------------------------- |
| `KRN_TIMEOUT`                                                                                                                                                                  | any kernel op              | deadline reached at `stage` (`fraction`); raise `LLULL_OCC_TIMEOUT_MS` or simplify |
| `KRN_FUSE_FALLBACK` (warn)                                                                                                                                                     | boolean                    | General Fuse result invalid; the balanced-tree path was used                       |
| `PATTERN_FUSE_INELIGIBLE` (info)                                                                                                                                               | boolean                    | why the pattern path was not used (body not symmetric, sector plane cuts the tool) |
| `ARRAY_SOURCE_NOT_SOLID`                                                                                                                                                       | array\_\* `as:"instances"` | instancing needs a 3D solid or component                                           |
| `CONN_MEMBERS_EMPTY` / `CONN_UNKNOWN_MEMBER` / `CONN_REASON_EMPTY`                                                                                                             | add_connection_group       | fix members or reason                                                              |
| `FPR_CONN_STALE` (warn)                                                                                                                                                        | check_assembly             | a group member no longer exists                                                    |
| `FPR_FASTENER_THREAD` (info)                                                                                                                                                   | check_assembly             | fastener-to-host overlap, reported apart                                           |
| `CHECK_PART_LIMIT`                                                                                                                                                             | check_assembly             | above 20,000 parts; narrow with ids, component or layer                            |
| `DESIGN_ALIAS_ARITY` / `DESIGN_INDEX_RANGE` / `DESIGN_VALUE_SCHEMA` / `DESIGN_EXPR_TYPE` / `DESIGN_LIST_LIMIT` / `DESIGN_FN_RECURSION` / `DESIGN_FN_ARGS` / `DESIGN_NO_ENTITY` | design language            | see §4.4                                                                           |
| `DESIGN_MODULE_NOT_FOUND` / `DESIGN_MODULE_CYCLE` / `DESIGN_MODULE_PATH` / `DESIGN_MODULE_PARAM` / `DESIGN_MODULE_HASH_CHANGED` (warn)                                         | design language            | see §4.4                                                                           |
| `LOFT_VERTEX_COUNT`                                                                                                                                                            | loft_sections              | warning: unequal polygon vertex counts, resampled (exact path needs equal counts)  |
| `VIEWPORT_UNAVAILABLE`                                                                                                                                                         | capture_viewport           | no desktop app; use `--app` or `render_view renderer=native`                       |
| `RENDER_BUDGET_EXCEEDED` (warn)                                                                                                                                                | render_view                | not everything drawn; `drawnShare` given                                           |

CLI: every command is reached through the registry (AF-01). `--progress` shows kernel stages (AF-40). UI: Connections
panel (list, highlight members), instance highlighting, check results with pair focus.

## 8. Performance and robustness budgets (reference machine: the owner's Windows 11 workstation)

| Operation                                        | Today           | Budget                                                        |
| ------------------------------------------------ | --------------- | ------------------------------------------------------------- |
| Fuse disk + 36 lofted blades (61-point sections) | 26.4 s          | ≤ 10 s (GF); ≤ 1 s (pattern fuse)                             |
| Fuse disk + 80 blades                            | > 30 s (killed) | ≤ 2 s (pattern fuse)                                          |
| `check_assembly`, 2,450-part turbofan            | refused (> 500) | ≤ 60 s cold, ≤ 10 s with a warm cache after a one-module edit |
| `check_assembly`, 175 parts                      | 269–283 s       | ≤ 20 s                                                        |
| Turbofan `apply_design` (instances)              | 12 s            | ≤ 12 s                                                        |
| Viewport, turbofan at full detail                | not measured    | ≥ 30 fps orbit; ≤ 200 draw calls                              |
| `capture_viewport` 1600×1000                     | —               | ≤ 3 s                                                         |
| `.lld` evaluation overhead                       | —               | ≤ 5 % of apply time; 100,000-item list ≤ 1 s                  |

Robustness: every native op keeps the existing worker isolation; a cancelled op leaves no partial document change
(commands stay pure, L3).

## 9. Test strategy

| Level                                                                 | What                                                                                                  | VC                   |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------- |
| packaging script test (`desktop/tests`)                               | `stage:server` and builder config exclude repo folders; the extractor is path-agnostic                | VC-ASC-01, 02        |
| native reference tests (`server/tests/nativeKernelReference.test.ts`) | GF options, multi-tool fuse volume, progress, cancel, pattern fuse equivalence                        | VC-ASC-03…06         |
| unit (core)                                                           | `as:"instances"` arrays, replay ids, connection groups, connectivity rule, symmetry expansion, bounds | VC-ASC-07, 10…13, 20 |
| unit (design-lang)                                                    | arity, indexing, value grammar, comprehensions, functions, modules, hashes, expand                    | VC-ASC-14…19         |
| golden (`tests/golden`)                                               | a bladed disk plan and a two-module `.lld` regenerate with identical ids                              | VC-ASC-04, 18        |
| component / desktop tests                                             | instanced render draw calls, picking, `capture_viewport` through the desktop backend                  | VC-ASC-08, 22        |
| scale gate (`scripts/scaleGate.mjs`)                                  | turbofan rebuild, check_assembly 2,450 parts, viewport fps                                            | VC-ASC-10, 11, 23    |
| exchange                                                              | STEP occurrence count, glTF instancing                                                                | VC-ASC-09            |

## 10. Delivery plan

| Milestone | Content                                                                                                                 | Depends on                       | Effort (agent-days) |
| --------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------- |
| M0        | installer: remove `file:..` deps, pinned extractor, CI packaging check                                                  | —                                | 0.5                 |
| M1a       | GF multi-tool fuse with options; progress / cancel protocol; `KRN_TIMEOUT`                                              | —                                | 3                   |
| M4a       | `.lld` arity typing, expression indexing, `af.entity`                                                                   | —                                | 2                   |
| M6a       | `capture_viewport` (desktop port, server route, command)                                                                | —                                | 2                   |
| M5        | exact bounds; polygon-preserving ruled loft                                                                             | —                                | 2                   |
| M1b       | pattern-sector fuse                                                                                                     | M1a                              | 3                   |
| M2        | instance arrays, renderer instancing, STEP / glTF instancing, booleans on instances                                     | M1b for fuse                     | 6                   |
| M3        | BVH + OBB broad phase, mesh narrow phase, exact confirm, native batch, symmetry, cache; connection groups, fastener tag | M2 (symmetry from instance sets) | 7                   |
| M4b       | value grammar, comprehensions, conditionals, let, built-ins, functions, `expand_design`                                 | M4a                              | 5                   |
| M4c       | modules (`use … as … with`), typed params, namespacing, auto layer and group, hashes                                    | M4b                              | 4                   |
| M6b       | `render_view` GPU routing                                                                                               | M6a                              | 1                   |

Total ≈ 35 agent-days. Recommended order: M0 → M1a → M4a → M6a → M5 → M1b → M4b → M2 → M3 → M4c → M6b. Each
milestone is reviewed by `cad-reviewer` and gated by `npm run check:coverage`.

## 11. Open questions and proposed decisions

| #   | Question                                                                             | Proposed                                                                                                                     |
| --- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| D1  | Default of `array_* as`                                                              | `copies` until every command accepts instances, then `instances` for solids                                                  |
| D2  | Should `check_assembly` treat touching faces as connected when no group covers them? | no: keep `RESTING_ONLY` (honest). Groups with `detect` make declaration cheap                                                |
| D3  | Symmetry reduction on by default                                                     | yes (`symmetry: 'auto'`), with an `off` switch for audits                                                                    |
| D4  | `.lld` bare alias semantics change (first id → all ids)                              | apply to all designs, no compatibility mode (owner rule no-backward-compat)                                                  |
| D5  | Module source of truth: files or the embedded copy                                   | the embedded copy (replayable). Files are an authoring convenience; `apply_design` re-reads them and reports changes         |
| D6  | Where viewport capture renders                                                       | offscreen frame in the running desktop renderer with a temporary camera; hidden `BrowserWindow` when the window is minimised |
| D7  | Native batch check language                                                          | Rust + C++ facade in `llull-kernel` (C7, Rust default), Manifold for mesh volumes                                            |

## 12. References

[R1]–[R32] as in [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md) §11; grades and extracts in [`validation/sources.md`](validation/sources.md).

## 13. As built

### 13.1 M0 installer (2026-11-21)

- TR-ASC-01: `"llull": "file:.."` removed from `desktop/package.json` and `server/package.json` (no source imported it; the server
  bundle needs only its own runtime dependencies: `@resvg/resvg-js`, `cors`, `express`, `express-rate-limit`, `zod`, and the dynamic
  `manifold-3d` / `@mujoco/mujoco`). Both lockfiles no longer resolve any package outside their folder. `electron-builder.yml` excludes
  `node_modules/**` from app.asar (main + preload are bundled). `desktop/tests/packaging.test.ts` pins all three. Checked by running
  `desktop/scripts/stage-server.mjs`: `build/server/node_modules` holds no `llull` link and `npm ls --omit=dev` lists only the runtime set.
- TR-ASC-02: `desktop/scripts/systemTar.mjs` picks `%SystemRoot%\System32\tar.exe` on Windows and `/usr/bin/tar` or `/bin/tar` elsewhere,
  never `tar` from `PATH`; `prepare-python.mjs` uses it. Not tried on a Windows machine from this session.
- Left: the CI packaging check of TR-ASC-01 that inspects a real `resources` folder needs an `npm run dist` run (electron-builder
  download), not run here.

### 13.2 M4a `.lld` arity typing, indexing, `af.entity` (2026-11-21)

Scope: TR-ASC-12 and the `af.entity` part of TR-ASC-13 (FR-ASC-21). Code: `packages/design-lang/src/aliasRef.ts` (reference
parsing and selection), `schemaValue.ts` (`NameRef` carries the param's arity), `run.ts` (`reference`, `liveEntities`).

- **Arity (R1, D4).** The alias kind is derived from its ids at definition (`ids.length === 1` single, else group). `bindValue`
  tags every name word with `many` (the schema has an array branch, or the param is an untyped value) and `list` (a pure array
  param, which always receives a list). Resolution: single alias, its id; group on `many`, all ids; group on a one-id param,
  `DESIGN_ALIAS_ARITY` naming the param, the group size and `g[0]`, `g[-1]`, `g[i]`. A bare word is now also accepted for a
  `string[]` param. Applies to every design (no compatibility mode).
- **Indexing (R2).** `name[expr]`, `name[-1]`, `name[a..<b]`, `name[a..b]` (inclusive, as for loops); `expr` uses the
  parameters and loop variables through the existing expression evaluator and must be an integer. An index gives a single id, a
  range a group even for one id. Outside the ids or an empty range: `DESIGN_INDEX_RANGE`. Selection runs on the live ids. An
  unbound name with a selector or member is `DESIGN_UNKNOWN_ALIAS` (it was literal text before). `check` params are not indexed yet.
- **`af.entity` / `af.entities`.** Each alias keeps the entities its line created. For a record alias these are the created
  entities, for an entity alias its ids. `.entity` = the first live one, `.entities` all, both indexable. None created:
  `DESIGN_NO_ENTITY`. Entities all consumed: `DESIGN_ALIAS_CONSUMED`.
- **Not in M4a.** Value grammar, comprehensions, `if` / `let`, functions, `expand_design`, modules (M4b, M4c). The VC-ASC-14 exact
  volume (270175.376 mm³) needs the OCCT sidecar; the unit tests assert the arity on the mesh kernel (group cuts more than one tool).
- **Changed existing tests.** `tests/unit/design/{edgeCases,schemaValue}.test.ts` expect the new `NameRef` fields; `feedback.test.ts`
  expects `DESIGN_INDEX_RANGE` (was `DESIGN_UNKNOWN_ALIAS`) for an index beyond the ids. No `.lld` example or validation plan needed
  an edit.

### 13.3 As built (M4b)

Scope: TR-ASC-13 (value grammar with schema binding, ranges, comprehensions, `if`, `let`, built-ins, functions, `expand_design`).
Code: `packages/design-lang/src/{valueExpr,valueEval,valueSchema,functions}.ts`; `parse.ts` (`fn` statement, `expr` value node),
`schemaValue.ts` (`ValueExprRef`), `run.ts` (`valueOf`, `aliasValue`, trace), `commands.ts` (`expand_design`).

- **One step, one evaluator.** Nothing new reaches the document: a value expression is evaluated inside the single `design_source` step
  (L8) and the command receives plain JSON. The same evaluator serves values, loop bounds, `check` numbers and function bodies.
  Parameters are read from the document, so `set_parameter` regenerates as before (`readsOf` already matches names in the source).
- **Binding.** `bindValue` routes `{…}` / `[for …]` nodes, parenthesised `if` / `let` and calls of non-numeric functions to
  `ValueExprRef { expr, spec, param }`; a number slot whose text fails the old arithmetic parser but parses as a value expression takes
  the same route. `coerceValue` walks the result against the param's JSON schema (type, enum, `anyOf` first matching branch, array items,
  object properties, `required`, unknown field refused unless the schema is a free-form record) and reports `DESIGN_VALUE_SCHEMA` with
  the path. List items carry their index in the path (`sections[1].span`). Alias values: single id, group list on a list slot,
  `DESIGN_ALIAS_ARITY` on a one-id slot.
- **Functions.** `buildFunctions` compiles the `fn` lines once per run, refuses duplicates and built-in names (`DESIGN_SYNTAX`) and any
  cycle in the call graph (`DESIGN_FN_RECURSION`, naming the path) before the first command runs. A body sees its arguments and the document
  parameters only.
- **Determinism and bounds.** No clock or randomness; `pow` is `@lib/pow`. Named limits: `MAX_LIST_ITEMS` 100,000 (`DESIGN_LIST_LIMIT`),
  `MAX_EVAL_STEPS` 2,000,000 and `MAX_CALL_DEPTH` 64 (`DESIGN_EVAL_LIMIT`, new code), `MAX_EXPR_NESTING` 100 (`DESIGN_SYNTAX`).
- **`expand_design { source? }`.** Read-only, `requiresKernel` (it runs the commands on a scratch document with the document's units and
  parameters). `data.lines[] { line, command, alias, params }` in execution order; `file` is not reported before modules (M4c). Added to the
  tool-schema snapshot and `docs/FEATURES.md`.
- **Validation.** VC-ASC-15 (wing from a comprehension with aliases inside objects, wrong field names its path) and VC-ASC-17 (a
  comprehension over `fn tip(x)` equals the literal profile point for point) run as unit tests in `tests/unit/design/valueLanguage.test.ts`.
  No M4b plan file exists in `validation/plans`; VC-ASC-18 / 19 (modules) need M4c.
- **Existing behaviour changed.** `{…}` values are no longer verbatim JSON: they are checked against the schema (an object with a field the
  schema does not list is refused) and may use `.lld` values. `parseValue` returns `{ kind: 'expr' }` for them (`parse.test.ts`,
  `schemaValue.test.ts`, `edgeCases.test.ts` updated); list items carry `key[k]` in their schema key.
- **Not built.** The `each` form of R4 (a comprehension covers it); `check` of an alias index (`of=part[2]`); modules, namespacing and
  hashes (M4c).

### 13.4 As built (M2 core) (2026-11-21)

Scope: §4.2, TR-ASC-06 data side (no renderer), §6 interop, decision D1. Code: `packages/core/src/commands/edit/arrayInstances.ts`
(new), `edit/transform.ts`, `commands/brep/boolean.ts`, `geometry/assemblyParts.ts` (`recipeOfPart` exported).

- **`as: "copies" | "instances"`** on `array_linear` / `array_polar` (default `copies`, D1). `instances` reuses the existing component /
  instance model (no second one): a solid source moves into a new component (`comp-<step>.<k>`) and is replaced by instance 0 at the
  identity transform (as `create_component` does); an instance source keeps its component and stays instance 0. Each further member
  is an `instance` entity placed by the rigid transform `x' = R·x + shift` (linear: R = I; polar: `shift = c - R·c`), rotation
  `eulerFromMat(R·R_source)`, scale kept, `patternSourceId` = instance 0. Ids come from `nextId`, so replay re-mints the same set (L8).
  `affected` = every instance id (instance 0 included when the source was a solid). 2D or other non-3D source: coded rejection
  `ARRAY_SOURCE_NOT_SOLID`. Positions and rotations equal the copies mode to rounding (test).
- **No stored `PatternInstanceSet` record.** The set is derivable: instances share `componentId` and `patternSourceId`; the feature
  step already holds the pattern parameters, so a separate record would duplicate them. Add one only if M3 `patternOf` needs it.
- **`boolean`** accepts instances (in `a` or in the `b` list) on the kernel path: each instance becomes the union of its solids'
  recipes through its transform at the kernel boundary (L9), then the operands are consumed. Triangle-only routing is skipped when an
  instance is present; `engine: "mesh"` with an instance is refused (explode first). Missing component or no 3D member: no-op.
  The old refusal "run explode_instance first" is gone (`tests/unit/boolean.test.ts` updated). The pattern fuse (TR-ASC-05) is M1/native.
- **Relocation (review fix).** Moving the source into the component is a relocation, not a deletion: `commands/entity/relocateEntity.ts`
  `relocateEntities` remaps group members, selection, animation targets, `display.materialClassOf`, `exchange.provenance` and the
  `patternSourceId` of earlier copies to the stand-in instance (only sub-shape constraints / joints are pruned, counted in the summary).
  `create_component` uses the same helper; a group whose members all move into one component is dissolved and named in the summary.
  Other commands that held the source id stop resolving it: use instance 0 (stated in the `as` description).
- **Boolean routing.** Instance operands are scanned through their member solids: under `engine: "auto"` an instance built on
  triangle-only / over-cap imported meshes (which would go to the mesh engine) is refused by name (`explode_instance` first). Consuming
  the last instance of a component keeps the component; the summary says `Component X now has no instances (kept in the document)`.
- **mass / bounds / `check_assembly`** already resolved instances through `instanceExpansion` (`mass_properties`, `instanceBoundsFromDoc`,
  `assemblyParts`); the new test pins mass equality between the two modes. A pattern instance is one part in `check_assembly` (cap
  `MAX_PARTS`) as before.
- **Exchange.** `export_gltf instancing: "gpu"` already writes `EXT_mesh_gpu_instancing` (TRANSLATION / ROTATION / SCALE): one node for
  the whole pattern (test). `export_step_ap242` already plans one shared part per component and one NEXT_ASSEMBLY_USAGE_OCCURRENCE
  per instance (test with a recording kernel). Needs the native kernel and is NOT verified here (no sidecar in this container): the
  exact STEP text, and `mapped_item` shape reuse, which is chosen by OCCT's XCAF writer, not by TS code.
- **Left.** Renderer (InstancedMesh / BatchedMesh / `instanceId` picking, TR-ASC-06) for a later lane; `PatternInstanceSet` /
  `patternOf` connection members (M3); flipping the default to `instances` (D1) once every command accepts instances; pattern fuse.

**Renderer (M2, as built).** `src/ui/viewport/3d/componentInstancePlan.ts` (pure) + `ComponentInstancedRenderer.tsx`, wired in `Entities.tsx`.
A component with at least 8 eligible instances whose children are all plain 3D solids is drawn as one `InstancedMesh` per child solid
(geometry from `solidTriangles(child)`, instance matrix = position / Euler XYZ / scale), so a 10,000-member pattern of a one-solid component is
1 draw call (budget §8: ≤ 200). `instanceId` indexes the id-sorted instance ids: a click selects that instance entity, never the batch. Colours go
through `instanceColor` (child or material colour, tint store, selection lerp, as the plant buckets); x-ray raises the batch opacity when any
member is selected; section / clip planes are the scene-wide ones (click guarded by `isClippedAway`). Visibility, layers, explode offsets come from the same
filtered entity list as the per-entity path. Instances that are animated, finished, ghosted, transitioning, mirrored (negative scale), under 8 in
number, or of a component with 2D / nested / decaled children stay on the per-entity path. Reuses `useBatchCapacity`, `makeMaterialArgs`,
`writeBucketColours`. Tests: `tests/component/ComponentInstancedRenderer.test.tsx` (1,000-member polar array = one InstancedMesh, matrices, pick, single-instance tint).
Not built: `BatchedMesh` for unique parts (not used by the plant renderer either; no measurement justifies it), hover by `instanceId`, a
BVH for picking 10,000 instances (default three raycast), LOD swap for far instances, a measured `renderer.info.render.calls` (no GPU here).

### 13.6 As built (M3) (2026-11-21)

Scope: §4.3, §5.3 steps 1-5 and 7 (TS side), TR-ASC-07, 08, 10, 11 and the TS half of 09 (symmetry), D2, D3. Not built: the native batch
`check_pairs` thread pool (D7, step 6): the port it replaces is already in place, see below. Code: `packages/core/src/geometry/assemblyCheck/`
(`broadPhase`, `obb`, `meshNarrowPhase`, `pairPhase`, `pairEvaluation`, `pairCache`, `rigidFrame`, `partFrames`, `connectionMembers`,
`connectionLinks`), `commands/inspect/{checkAssembly,assemblyCheckRun}.ts`, `commands/review/connections.ts`, `model/prototype.ts`.

- **`MAX_PARTS` 20,000** (`CHECK_PART_LIMIT` rejection, was 500 / `FPR_BUDGET_EXCEEDED`); candidate pairs are capped at 200,000
  (`FPR_BUDGET_EXCEEDED`). Context parts outside the scope are built while the document is under the cap.
- **Broad phase (TR-ASC-07).** Sort-and-sweep below 200 parts; from 200 a BVH from the injected `ctx.spatialIndex` (`SpatialIndexPort`, the TS
  build by default) queried with each part box grown by `clearance + epsTouch`; then a separating-axis test on OBBs computed from the display
  mesh (PCA by fixed Jacobi sweeps, extents by projection; 15 axes). Boxes and OBBs come from the display mesh, so a curved solid sticks out of them by the
  chord error: every box, OBB and mesh-distance test grows by `margin + chordBound(a) + chordBound(b)` (`chordBound.ts`, `max(0.1, 1e-3 x diagonal)`); a 32-gon
  elliptic prism pair whose tessellations are 0.046 apart while the exact solids overlap by 0.05 survives (test). The OBB is built from the mesh in
  TS, not from the kernel (`Bnd_OBB` stays a native option); instance masters are not reused for OBBs yet.
- **Mesh narrow phase (TR-ASC-08).** One `ctx.geometryQueries.placedDistanceBatch` over all candidates (the existing batch port, which a native
  `check_pairs` replaces): a pair whose meshes are further apart than `clearance + epsTouch` plus both display chord bounds
  (`max(0.1, 1e-3 x diagonal)`) never reaches the kernel (`data.narrowPhase.meshCulled`). Pairs with one box inside the other, or a part without
  a mesh, are kept (containment has no surface contact). The kernel then classifies the rest: kernel-optional, tagged
  `@invariant kernel-optional`. With the native OCC kernel (`info().active === 'occt-native'`) the answer is exact (distance + `intersect`
  volume, as before); with Manifold it is mesh-accurate. `data.narrowPhase.exactKernel` says which; `narrowPhase: "exact"` demands the exact
  kernel and gives `FPR_KERNEL_UNSUPPORTED` (not_run) otherwise. The exact branch is tested with a fake kernel (no sidecar here).
- **Symmetry (D3, `symmetry: 'auto' | 'off'`, default auto).** Not a pattern detector: every unit-scale instance has a rigid frame
  (`rigidFrame.ts`) and the key of its component-local recipe; a pair is keyed `(localKey a, localKey b, relative placement a^-1 b)` with
  the orientation chosen so (a, b) and (b, a) share a key, quantized (translation 1e-6, rotation 1e-9). For N copies of a polar / linear
  pattern the pairs (i, j) fall in the classes of j - i (folded mod N for a ring), i.e. master vs copy d = 1..N/2; each class is classified once
  and reported for every concrete pair, with the witness points mapped through the instance frames (`data.symmetry`: `patterns`,
  `pairsSkipped`, `pairsEvaluated`, `cacheHits`, `expanded: true`). Scaled instances are not reduced. `off` evaluates every pair.
  `penetrationEstimateMm` reads world axes and is not rotation-invariant, so it is recomputed (one `intersect` + analyze) for every reused hard pair of
  an instance class (`data.symmetry.depthsRecomputed`); auto then equals off on rotated rows (test). Distances, volumes and the class are shared.
  P vs an outside part Q gets no reduction beyond the pair cache.
- **Pair cache (TR-ASC-10).** `PairCache` (`createPairCache`, LRU, default 200,000 entries ~ 64 MB) in `ExecutionContext.pairCache`:
  `defaultContext()` keeps one per installed kernel (WeakMap, like the replay cache), so the server and the CLI process persist it across runs; else a
  `resolveMemo` of the context holds ONE cache under a single tag (`pairCacheOnMemo`, owner = the kernel; it never evicts the mesh memo entries); else
  only the run's own map. Key = tolerances + kernel name and `info()` + narrow-phase mode + the pair key above (world recipe hashes for plain parts). Content only, never time; `cache: false`
  skips it. Measured on this machine (Manifold, no native kernel): see "Budgets".
- **Connection groups (TR-ASC-11, D2).** `doc.prototype.connections` (`conn-<step>.<k>`, `ConnectionGroup` with members `ids | patternOf |
layerId | groupId`, optional `detect`), commands `add_connection_group` (`CONN_REASON_EMPTY`, `CONN_MEMBERS_EMPTY`, `CONN_UNKNOWN_MEMBER`),
  `delete_connection_group`, `set_fastener` (toolset review). `declaredBy` is `'agent' | 'user'` as in §3 (the older intents use `'human'`).
  Members are resolved at check time (`patternOf` = the seed and every entity whose `patternSourceId` is the seed; for an array made with
  `as: "instances"` the seed is instance 0, which the array command returns). Without `detect`, all members are one strong link set; with it a
  member pair joins when the meshes lie within `toleranceMm`, a contact facet pair (facets within the tolerance of the witness points) opposes
  within `faceAngleDeg`, and the `cylindrical` rule holds (a contact is curved when facets near the witness differ by 1 to 45 degrees; a larger
  step is an edge). Touching faces alone never connect (D2). A group with a missing member gives `FPR_CONN_STALE` (warn); `data.connections[]`
  lists id, name, kind, live members, links, stale ids.
- **Fastener tag.** `fastener: true` on an entity (`EntityTags`, in `model/prototype.ts`, extended by `BaseEntity`). A hard / contained pair
  with exactly one fastener and no intent is `FPR_FASTENER_THREAD` (info) and still a strong link; the rest of the pair data is unchanged.
- **Load validation.** `prototypeProblems` checks `connections` (key = id, kind, non-empty name and reason, `declaredBy`, exactly one member selector,
  `detect` ranges); entity `fastener` must be `true` and only on 3D solids / instances. Members are not checked for existence (stale is a check item, not a load error).
- **Budgets (§8), measured here with Manifold on boxes (about 10 mm, 9.5 mm pitch, neighbours overlap), not asserted:** 175 parts, 1,527 pairs
  1.0 s; 2,450 parts, 27,155 pairs 10.2 s cold; the same with a warm cache after one part moved 1.0 s (27,144 hits); a 2,000-copy polar
  instance ring (25,384 pairs) 1.1 s with symmetry (9 evaluated) against 10.9 s with `symmetry: 'off'`. The reference machine and the native kernel will differ.
- **Left.** Native batch `check_pairs` (thread pool, D7) and `BRepExtrema_ShapeProximity`; OBBs from the kernel / reused from instance masters;
  FR-ASC-13 incremental re-check beyond the cache; a Connections panel (UI lane); symmetry for P vs
  an outside part Q; a cheaper rotation-invariant penetration depth than the per-pair recompute.

### 13.7 As built (M6a) `capture_viewport` (2026-11-21)

- **Command.** `capture_viewport` (`commands/render/captureViewport.ts`, toolset `core`, read-only): `{ view?, direction?, target?, zoom? 0.1..50, width? / height? 64..4096 (default 1600 x 1000), background?, hideLayers? (ids or names) }`
  reads the port `ctx.viewportCapture` (`model/viewportCapture.ts`, like `RasterPort`: `capture(request, doc)`; absent => `VIEWPORT_UNAVAILABLE` naming `--app` and `render_view renderer=native`). It returns `data { image (PNG base64), width, height, view }`. Other refusals: `VIEWPORT_TIMEOUT`, `VIEWPORT_CAPTURE_FAILED`, `VIEWPORT_STALE`, `VIEWPORT_CANCELLED`,
  `VIEWPORT_UNKNOWN_LAYER`, `VIEWPORT_BAD_CAMERA` (zero direction), `VIEWPORT_PENDING` (internal: the host runs the command again). `--save x.png` writes `data.image` (`saveFiles.ts`: `image` is a base64 payload key; a `.png` target takes the rasterized `data.svg`, else `data.image`, never text).
- **Async round trip behind a synchronous command.** The deferred-run pattern of 13.8 (07 MSH) is reused, widened: `DeferredJob.op` is `MeshOpName | 'capture_viewport'`, `JobOutcome` gains `CapturedFrame { frame: { png, width, height } }` (held for the resolve only, never in the mesh result cache: a capture is always fresh),
  `engine.noteDeferral()` counts a non-mesh deferral so `resolveDeferred`, replay and the resolve memo discard that run. `server/src/viewport/capturePort.ts` answers from the frame the resolve holds (looked up first), or `scope.request()`s a job and answers `VIEWPORT_PENDING`; the job awaits the renderer, then the command re-runs and finds the image. Cancelling (Ctrl-C, closed connection) aborts the wait and commits nothing.
  Without a resolve or without a connected renderer: `VIEWPORT_UNAVAILABLE`.
- **One frame = one document state.** The port hashes the run's document (`documentHash`, selection excluded); the job key is `hash(request, documentHash)`, so a later identical capture after a change is a new frame. A run whose document is not the live document (steps of a `build_project` before the capture, an uncommitted run) answers `VIEWPORT_STALE` at once and never asks the renderer:
  capture in its own call. The request carries `documentHash`; the renderer waits until its live document (`liveBase`) has that hash (`/live` and the stream are separate connections: `llull add_box --app && llull capture_viewport --app` is safe) and answers `VIEWPORT_STALE` after 5 s.
- **Channel (loopback, per-launch token).** `server/src/viewport/captureRoutes.ts`: `GET /viewport/stream` (SSE, a token is required even where `/live` is open; Bearer or a single-use `?ticket=`) sends `capture { id, request, documentHash }` and `cancel { id }` (timeout / abort: the renderer drops a frame not yet drawn); the renderer answers `POST /viewport/frame/:id`
  `{ png (base64), width, height }` or `{ error: { code?, message } }` (`guardMutation`). An unknown / late id is 404 before the body is parsed; the body is capped by the asked size (`w x h x 4 x 4/3`); the picture must be a PNG (`@lib/pngHeader`, in the hostile-input table) whose IHDR size is the asked and declared size, else 400 and the request ends `VIEWPORT_CAPTURE_FAILED`.
  `captureBroker.ts` sends to the newest renderer and moves a waiting request to the next one when it leaves (else `VIEWPORT_UNAVAILABLE`); `LLULL_VIEWPORT_TIMEOUT_MS` (default 10000) => `VIEWPORT_TIMEOUT`.
- **Renderer (D6, first cut).** `src/ui/hooks/useViewportCapture.ts` (mounted in `App`) holds the stream (fresh ticket per reconnect, 1 s..30 s backoff) and runs captures one at a time (`captureQueue.ts`). `viewport/3d/capture/CaptureRig.tsx` (inside the Canvas) draws the live three.js scene into an offscreen `WebGLRenderTarget` (4x MSAA, sRGB) with a TEMPORARY `PerspectiveCamera`
  (`capturePose.ts`: frames the shown entities, minus the user's own hidden layers / entities, from `view` / `direction`, `target`, `zoom`) and encodes a PNG. No store is written: `hideLayers` is a mask on the scene applied and undone inside one synchronous draw (`frameMask.ts`: per-entity groups tagged `userData.entityId`,
  instanced meshes tagged `userData.instanceIds` have hidden instances collapsed to a zero matrix; the grid, gizmo, edit layers, previews and the measure box are tagged `captureExclude`), so the on-screen canvas never shows it and the user's layer filter is untouched. No window focus is needed (no `capturePage`, no OS screen grab).
- **Tests.** `tests/unit/render/captureViewport.test.ts`; `server/tests/viewportCapture.test.ts` (fake renderer: request -> frame -> re-run, document hash, plan after a mutating step = VIEWPORT_STALE, renderer error, timeout + cancel event, disconnect + fallback renderer, abort, frame route: unknown id before body, wrong-size PNG, oversized body, stream token, `answerOfBody` table);
  `desktop/tests/backend.e2e.test.ts` (real bundle, fake renderer on the real SSE, `llull capture_viewport --app --save`); `tests/component/capturePose.test.ts`, `captureFrameMask.test.ts` (mask undone exactly; two queued hiding captures + a user toggle leave `hiddenLayerIds` identical; queue order / skip); hostile table entry `core: pngHeader`.
- **Left.** No display / Electron could be run here: the real draw (CaptureRig: render target, tone mapping, PNG encode) is not exercised by a test and the 1600 x 1000 <= 3 s budget is unmeasured (VC-ASC-22 on the app). The frame skips the post-processing composer (edge lines, ambient occlusion) and the ACES tone mapping of the on-screen pass, and shows the selection tint of selected instances.
  Capture needs the 3D canvas mounted (2D view or an open sheet answers `VIEWPORT_CAPTURE_FAILED`). The hidden `BrowserWindow` for a minimised window (D6) is not built. `render_view` over-budget routing (§4.6, M6b) is not done.

### 13.5 As built (M4c) (2026-11-21)

Scope: TR-ASC-14, §3 `DesignSource`, §4.4 R6, §5.5, decision D5, VC-ASC-18 / 19. Code: `packages/design-lang/src/{modules,modulePath,moduleRun,aliasBinding}.ts`;
`parse.ts` (`module` / `use` / `export`), `run.ts` (scope, namespaced aliases), `valueEval.ts` (module namespaces in value expressions), `commands.ts`;
host glue `server/src/cli/fileParams.ts` (`withModuleFiles`). Language reference: `docs/DESIGN_LANGUAGE.md` §5.2.

- **Pure packages, host reads files.** `apply_design` / `expand_design` take `modules { path: text }`; the CLI adds them from the `use` lines of a
  `source=@text:` design (transitively, relative to its folder; unreadable or unsafe paths are left out and refused by name by the command). There is no fs in `packages/*`.
- **One step.** `design_source { source, reads, modules? [{ path, sha256, text }] }` (sorted by path, SHA-256 from `@lib/sha256`). Regeneration reads only the embedded
  copy and verifies each hash. The step's own layers / groups (`layer-<step>.k`, `group-<step>.k`) are dropped from the carried document before a re-run, so replay mints them again with identical ids.
- **Scope, not text expansion.** A `use` runs the parsed module body in a scope `{ prefix, overlay, file }`: aliases are bound as `ns.name`, arguments overlay the
  document parameters (so module `fn`s see them), unexported aliases are removed afterwards. Dotted alias references (`fan.blades`, anchors, `.entity`, selectors) are accepted by
  `splitAliasRef` / the anchor pattern; value expressions read `fan.blades` through a namespace value.
- **Layer + group** per instance via `add_layer`, `set_entity_layer`, `group_entities` executed inside the step (an inner instance's entities stay on its layer).
- **Checks inside modules are refused** (a check needs the caller's alias table and the second run of `check_design`); check exported names from the top design.
- **D5 report.** `apply_design` compares the supplied texts with the embedded copy: changed paths are listed in the summary and `data.warnings [{ code: DESIGN_MODULE_HASH_CHANGED, path, previous, current }]`; the new text is embedded.
- **`expand_design`** lines gain `file`; it runs with a scratch context (own ids, no step) so it cannot shift the ids of a plan it runs in.
- **Limits (named).** 64 files, 8 deep, 256 KB per file, 256 instances (`DESIGN_MODULE_LIMIT`); instances also count toward the 5000-command limit.
- **Validation.** `tests/unit/design/modules.test.ts` runs `validation/plans/target_v2_modules/engine.lld` (+ `fan.lld`, `stage.lld`) on the Manifold kernel: VC-ASC-18 (modules `fan`, `hpc1`, `hpc2`
  namespaced, own layers and groups, aliases resolve) and VC-ASC-19 (`replay_history` without files gives the identical document; edited file then `apply_design` reports `DESIGN_MODULE_HASH_CHANGED`).
  The plan runs whole except `check max of=fan.blades path=2` (the fan blade tip is 356 mm on this plan, not 867.5: a modeling matter of the plan), which the test strips.
  The plan was corrected to supported syntax: `mod(i, 2)` instead of an `i mod 2` operator, a closed casing profile (the zigzag alone was collinear), and valid
  `add_connection_group` lines (`name`, `members={ids: concat(…)}` / `{patternOf: blades[0]}`, complete `detect`).
- **Also changed.** A bare parameter / loop-variable name inside a nested list of a schema-less slot (`profile=[[45, 60], [hubR, 60]]`) now reads as its number (it was the string).
- **Not built.** Cross-file `fn` sharing, string / bool module params, `check` inside modules, a CLI end-to-end test of `@text:` module discovery (the helper is unit-tested).
- **Review round (run budget, host, export).** One `RunBudget` (`budget.ts`, 10,000,000 steps) is shared by every value evaluation of a run, charged per expression step,
  list cell, loop iteration (and per `evaluate`): nested empty loops and many near-limit values give `DESIGN_EVAL_LIMIT` naming the line. Loop bounds must be safe integers (a 1e26 bound looped without advancing).
  `expand_design`'s scratch context is pinned by a test that passes a caller `stepKey` / ids / provenance scope (goes red without it). Module size counts UTF-8 bytes; files being loaded count toward the 64-file
  limit; an alias may not equal a module namespace (`DESIGN_MODULE_NAMESPACE`). `export_design` returns `data.modules [{ path, text }]` (the embedded copy) and CLI `--save` writes them next to the design.
  `withModuleFiles` resolves real paths (a symlink leaving the design folder is skipped) and skips files over 1 MB before reading. Hostile readers: `design: modules` (cycle, depth, 65 files, 300 KB / multibyte, NUL / backslash / drive-letter paths, diamond ladder) and `design: run budget`.

### 13.8 As built (M6b) `render_view` over budget (2026-11-21)

- **Over budget** = the polygon budget decimated or skipped entities (`simplifiedEntityIds` / `skippedEntityIds` not empty; the raster budget is 400,000 filled polygons, a vector render's `maxPolygons`). `scene.ts` now reports `polygonTotal` (polygons before the budget) in that case only, so an under-budget result is byte for byte what it was.
- **Routing** (`commands/render/renderViewRouting.ts`, `routeOverBudget`; `renderView.run` = the unchanged render `renderOnce`, then the router): a PLAIN request (no turntable, isolate, section, cut, overlay, viewpoint, review styling / colour profile / section box, `hide2D`, vector mode, `projection`, `fovDeg`, `title`, `showLabels`, `showDimensions` or explicit `renderer`; `renderer: 'reference'` keeps the reference picture and its digest with only the warning) goes to
  1. `ctx.viewportCapture` when present: the same `view` / `direction` / `target` / `zoom` / clamped size / `background`, `hideLayers: []`; the PNG is returned in the usual self-contained `data.svg` (an `<image>`), so `--save x.png` and every `data.svg` consumer keep working. Marked `routedTo: 'viewport'`, `renderer: 'viewport'`, `engine: 'desktop-viewport'`, `deterministic: false`, no `svgSha256` / `rendererVersion`, `drawnShare: 1`, empty simplified / skipped lists, the reference's `polygonCount / polygonBudget / polygonTotal` renamed `referencePolygon*` (typed `ViewportPictureData`; the routed fields are typed in `RenderViewData`);
     the summary names how it differs (perspective camera framing the visible scene, app lighting and materials, no crease outlines, no axes / grid / title / dimension overlays; `camera` / `bounds` are the reference framing). `VIEWPORT_PENDING` is returned as the refusal so the host's deferred run awaits the frame and runs the command again (M6a); any other refusal (stale, timeout, capture failed) falls through and is named in the summary; no app (`VIEWPORT_UNAVAILABLE`) falls through silently. The reference render is memoized in `ctx.resolveMemo` (document + params), so the pending run and the re-run render once.
  2. else `ctx.raster` (native), only when the scene has at most `NATIVE_ROUTE_BUDGET` = 1,000,000 polygons (`data.polygonTotal`; PROVISIONAL, no native raster was available to measure it: the scene buffers are about 150 bytes per polygon, so 1M is roughly 150 MB on the event loop; set it from a `server/tests/perf` measurement when one exists). Above it the raster is not asked and the summary says so. Below: the same render with `renderer: 'native'` and that budget (`routedTo: 'raster'`, `deterministic: false`), kept only if it is no longer over budget; a failure or a still-over-budget frame is named in the warning.
  3. else the reference best effort stays (digest included) with the summary sentence and `data.warnings: [{ code: 'RENDER_BUDGET_EXCEEDED', message }]` plus `data.drawnShare` = polygons drawn / `polygonTotal`. A request the GPU paths cannot honour gets this too, whatever ports exist.
- **Determinism.** The TypeScript raster stays the reference and the only digest source; nothing routed feeds a digest. Under budget the result is the same object `renderOnce` returned.
- **Tests.** `tests/unit/render/renderViewRouting.test.ts` (under budget unchanged; viewport branch with the request, doc and marks; pending; viewport refusal -> native raster with the reason; best effort with `drawnShare`; non-routable requests never ask a port; purity) and `server/tests/renderViewRouting.test.ts` (fake renderer through the deferred run: one request, re-run, picture; renderer failure -> warning). The `render_view` tool description and the schema snapshot are updated on purpose.
- **Left.** Not routed: vector mode and the enrichments above (they stay best effort with the warning). The viewport branch is untested against the real renderer (see 13.7 Left).

- **Review round.** Server test: a plan whose earlier step mutates, then `render_view` over budget: the viewport answers `VIEWPORT_STALE`, the renderer is never asked and the warning stands. Router tests on stub results: scene above the native limit never calls `raster.render`, native still over budget / failing code in the summary, non-plain keys, memo.

### 13.9 As built (M1a) native multi-tool boolean, progress and cancel (2026-11-21)

- **Recipe node.** `boolean` gains an optional `many: n` (union / subtract, n >= 2): `b` stays the balanced union of the `n` tools, so Manifold and every kernel without the op evaluate it unchanged and the fallback is `b` itself. The `boolean` command sets `many` when `b` is a list of two or more tools (never for intersect); `recipeKey` carries it (`union*n(...)`), the untrusted-recipe check wants an integer in 2..=1000 (`MAX_BOOLEAN_TOOLS`, also the tool-list cap; a larger `many` is a named refusal, so a loaded recipe cannot size a kernel allocation); the sidecar ignores a `many` outside 2..=1000 (plain tree) and never preallocates from it. The port stays L9: an opaque handle from a `ShapeRecipe`.
- **Facade** (`cpp/boolean_many.cxx`, `recipe/many.rs`): the sidecar reads the `n` tools back out of the balanced tree (split at ceil(n/2); a `b` that is not that tree runs as written) and runs ONE `BRepAlgoAPI_Fuse` / `Cut` with `SetArguments([a])`, `SetTools(all)`, `SetRunParallel`, `SetUseOBB`, `SetNonDestructive`; the inverted-solid check stays ON (OCCT default): `BRepCheck_Analyzer::IsValid` does not detect an inside-out solid, so it cannot gate the check off. `SetToFillHistory` stays ON: persistent face names (SC-N1) are carried through the history, so naming needs it. Result: `HasErrors` / null / `BRepCheck_Analyzer` invalid => `KRN_FUSE_FALLBACK`: the balanced tree `b` is evaluated, `booleanReport` (new op, capability `booleanMany`) answers `{ mode: 'balanced-tree', fallback: true, code: 'KRN_FUSE_FALLBACK', reason }` (else `{ mode: 'general-fuse', tools }`), and the `boolean` summary names it. Then `UnifySameDomain` as before (skipped for thread tools). Edge order: the General Fuse and the balanced tree give the same faces but another edge order (diverges at index 22 on 12 rotated overlapping boxes), so a node whose parameters are topology indices (`fillet`, `chamfer`, `blend`, `faceOp`, `faceBlend`, `fullRound`) evaluates the `many` nodes below it as the plain tree (`many` stripped, own cache key); a stored `edges: number[]` therefore always reads the tree's order, with or without the fast path.
- **Progress, deadline, cancel** (`cpp/progress.{hxx,cxx}`): every native boolean (two-operand and many) builds with `Build(OpProgress::Start())`; `UserBreak()` is true once the request deadline (request field `deadlineMs`, set by the host from `LLULL_OCC_TIMEOUT_MS`) has passed or the cancel line `{"cancel": <request id>}` named the running request (read by the stdin thread, so it lands while an op runs; another id, or none running, is ignored). The host session cancels its pending ids (`session.cancel()`); one deadline is taken when a router call starts and every sidecar request of it (blob replay, source meshing, the op) gets the remaining ms. The sidecar answers `KRN_TIMEOUT: stage=<scope> fraction=<0..1>`, stays alive, and does not cache the refusal. `isolatedKernel.ts` kills the worker only at deadline + `killGraceMs` (default 5 s); `IsolatedKernel.cancel()` was REMOVED in the review round: `transact` blocks the owning thread in `Atomics.wait`, so a message to the worker could not stop a running op, and nothing in server / desktop / src called it. Until a caller exists (it would need a `SharedArrayBuffer` cancel word watched in the worker with `Atomics.waitAsync`), the cancel line is exercised at the sidecar session level only. The `boolean` refusal summary quotes `KRN_TIMEOUT`.
- **Measured** (this machine, 4 cores shared, release): plate minus 400 cylinders: one general cut 1.46 s, balanced tree 1.96 s (leaf builds included); the 24-tool drilled plate matches the tree in volume (<= 1e-6) and face count.
- **Left.** Only booleans take the progress range; tessellation, fillets, deform and the other native ops still run to the call limit (the hard kill is the backstop). Not measured: disk + 36 lofted blades (the section 8 budget row; needs the turbofan fixture). Pattern fuse (M1b): prototyped and not merged, section 13.10.
- **Tests.** `solver/crates/llull-kernel-occt/src/many_tests.rs` (equality with the tree, fallback via a test hook, deadline, not-a-tree nodes), `solver/bins/llull-kernel/src/session.rs` (report, `KRN_TIMEOUT` then next request), `server/tests/nativeKernelBooleanMany.test.ts` (real sidecar: equality, 400 tools against the tree with slack, deadline keeps the worker alive, grace before the kill, cancel by id); review round: hostile `many` (1e15, 2\*\*53, 1e309, -0, intersect; Rust `u64::MAX`), a mirrored tool, index-bearing node over `many`, `tests/unit/booleanMany.test.ts` (routing with a fake kernel).

### 13.10 M1b pattern-sector fuse: prototyped, NOT merged (2026-11-21)

A prototype was built and measured; its code is not on the branch because it is slower and, for one tool shape, not equivalent to the general fuse.

- **Design tried.** TS routing (`detectPattern`): at least 4 `solid` tool recipes equal except position / rotation, forming one polar pattern (common axis,
  steps 2 pi k / n) or one linear pattern, mark a union `many` recipe with `pattern: { kind: 'polar', origin, axis, count } | { kind: 'linear', step, count }`.
  Native: the descriptor is never trusted (count, each tool = the seed moved to its step by volume and centroid, each copy inside its sector, the body
  invariant under the pattern by sector-volume sum, result volume = sector sum); one wedge (polar) or slab (linear) sector `S = body ∩ wedge ∪ seed`,
  rigid copies (Location change, shared TShape), one glued fuse (`BOPAlgo_GlueFull`) and UnifySameDomain; any failed check falls back to the M1a general fuse.
- **Periodic seam.** Copies of a sector holding a seam edge of the body keep that seam (+1..+2 faces); building every sector from the next, seam-free one fixed it.
- **Why not merged.** (1) Measured slower (release, 4 shared cores, disk r=10): 36 box blades 0.40 s general vs 0.51 s pattern, 120 blades 1.37 s vs 2.73 s;
  24 / 36 torus blades 0.93 / 1.47 s vs 1.38 / 1.79 s. The fixed overhead (mass properties of body, tools and result, ~8 small booleans, the glued fuse
  and unify over N sectors) exceeds the saving for cheap tools. (2) Torus tools straddling the rim give MORE faces than the full fuse (24: 51 vs 40,
  36: 75 vs 58) with equal volume, which none of the checks catch. Automatic routing must never change a result, so the path stays out.
- **Reopen when** a fixture with expensive tools exists (section 8: disk + 36 lofted blades) and shows a saving, and the face-count check (topology
  equal to the general fuse on a sample) is part of the acceptance. M1a's single general fuse remains the path for `many`.

### 13.11 As built (M5) exact bounds and ruled polygon loft (2026-11-21)

- **Exact bounds.** New optional port `GeometryKernel.shapeBounds(shape)` (sidecar op, `BRepBndLib::AddOptimal` with `useTriangulation=false`,
  `useShapeTolerance=false`, no mass integration). `kernelEntityBounds` (`geometry/kernelBounds.ts`) answers it for extrusion, revolution, sweep,
  loft, wedge, pyramid, cone, torus and a mesh with a `brep`; `measure_bounding_box` reports `data.bounds: 'exact' | 'conservative'`.
  Rule: `'exact'` for a kernel box and for box, cylinder and sphere, whose closed-form boxes are tight at any rotation (box from its 8 rotated
  corners, cylinder `h/2 |n| + r sqrt(1 - n^2)` per axis, sphere `r`); `'conservative'` for meshes without B-rep, instances, 2D shapes and kernel kinds
  measured without a kernel; a combined box is exact only when every entity is. The kernel wrapper memoizes boxes per recipe key (bounded LRU,
  4096; a refusal is not kept), so whole-document queries and the `.lld` anchor path (`frameOf` runs `measure_bounding_box`; exact boxes are kept
  there because flush placement of tilted parts needs the tight box, and the memo makes repeats free) do not round-trip twice.
- **Polygon loft.** `loft_sections {ruled:true}` with every section a polygon (inline `section`, rectangle / closed-polyline sketch) of EQUAL vertex
  count keeps the vertices (`LoftEntity.polygon: true`, `commands/solids/loftPolygon.ts`, counter-clockwise about the travel, cyclic seam alignment).
  Native: sections are `BRepBuilderAPI_MakePolygon` wires; side faces are built face by face (planar when the four vertices are coplanar, else
  bilinear), capped and sewn, because `BRepOffsetAPI_ThruSections(ruled)` gave B-spline sides on OCCT 7.9.2. Unequal counts: the old resampled ruled
  loft is kept (replay, L8) and the summary warns `LOFT_VERTEX_COUNT`; golden plan `ruled_loft_vertex_count_mismatch_replay` pins it. Loading a loft
  with `polygon: true` together with `faces`, `sections`, `closed: true` or `ruled !== true` is rejected (persistence guard, hostile-load suite).
- **Tests.** `tests/unit/kernelBounds.test.ts`, `tests/unit/sweep/loftPolygon.test.ts`, `tests/unit/measure.test.ts`, the guard cases in the hostile-load suite,
  `server/tests/nativeKernelFidelity.test.ts`, `server/tests/kernelLeavesSweeps.test.ts`, `solver/.../bounds_tests.rs`, `recipe/nodes_tests.rs`.
- **Left.** (1) Sewn-solid validity check and sewing-tolerance clamp (native, pending). (2) Code export (`export_code`) rebuilds ThruSections
  B-spline sides, so its face types differ from the native planar / bilinear ones. (3) `coupling: 'vertices'` is not on this path. (4) Only
  `measure_bounding_box` uses exact bounds (and `frameOf` through it); the other bounds consumers (§4.5 says "every") keep `entityBoundsInDoc`; widen later.
  (5) Whole-document cost at 2,450 parts is unmeasured (one `evaluate` + one `shapeBounds` per kernel-backed entity on a cold cache).
