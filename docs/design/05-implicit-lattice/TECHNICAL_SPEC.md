# IMP — Implicit / field modelling and lattices — Technical specification

Gap id: **IMP** · Companion: [FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md) · Validation: [validation/README.md](validation/README.md) ·
Laws: `.claude/rules/architecture.md` L1–L10 · Decisions: KI5 (shape boundary), LC1 (local only), RS1 (native compute), LIM-1 (scale).

---

## 1. Current state in llull

### 1.1 Code nearest to this gap

| Capability | Command / module | Files | What it does today | What it does NOT do |
| --- | --- | --- | --- | --- |
| Joint blend of solids | `blend_union` | `packages/core/src/commands/brep/blend.ts` (≈ 75 lines) | Union of 2..200 solids on the exact kernel with every new intersection edge filleted by ONE `radius` (`ShapeRecipe` op `blend`); refuses on the mesh kernel; kernel refusals when the radius does not fit a crotch | No blend between arbitrary bodies without a B-rep intersection, no variable / field-driven blend, no smooth union of meshes; can fail (kernel refusal) |
| Hollowing | `shell_solid` | `commands/brep/modify3d.ts` | Exact-kernel shell with `thickness`, optional open faces | No infill, mesh kernel refuses |
| Iso-surface | (internal) `deriveTopologyMesh` | `packages/domain-cae/src/topology/derive.ts` (231 lines) | Marching tetrahedra (6 Kuhn tets per cube) on node values averaged from a voxel density field, padded with 0 so the surface closes; marching squares + extrusion for 2D studies; welded, oriented | Only for topology artifacts; voxel-averaged values (not an SDF); not reusable from core (plugin internal) |
| Topology optimisation | `create_topology_study` … `record_topology_result` (transport `topology_solve`) | `packages/domain-cae/src/topology/*`, `solver/crates/llull-topopt` | SIMP on `llull-voxfe`; density field stored as an artifact; iso-surface read-only (derivation guard `TOP_DERIVED_READ_ONLY`), mesh omitted from saved files | No lattice grading from the density (listed as V2 in `docs/physics/17-topology-optimization/FUNCTIONAL_SPEC.md`) |
| Mesh kernel | `GeometryKernel` (Manifold) | `packages/kernel-manifold/src/manifoldKernel.ts` (310 lines); dependency `manifold-3d` 3.5.4 (Apache-2.0) | Booleans, tessellation, distance on meshes | **`Manifold.levelSet(sdf, bounds, edgeLength, level, tolerance)` exists in the installed package (`node_modules/manifold-3d/manifold-encapsulated-types.d.ts`) but llull never calls it**; its convention is positive inside |
| Mesh distance queries | `GeometryQueryEngine` port | `packages/core/src/geometry/geometryQueries.ts`, `meshBvh.ts`; native `server/src/native/geometryQueryEngine.ts` → `llull-compute geomq` (spawnSync, bit-exact twin) | Batched closest-point / ray queries on meshes, TS default + native engine installed by the host | No signed distance / winding number, no field evaluation |
| Exchange | `export_3mf`, `export_stl`, `export_obj`, `export_gltf`, `export_step_ap242` | `commands/exchange/threeMf.ts` (3MF core 2015/02, millimetres, one object per body), `exportStl.ts`, `gltf*.ts`, `brep/topology.ts` | Triangle meshes; STEP of exact B-rep and of NURBS sheets | No 3MF beam lattice, no 3MF volumetric / implicit, no field export |
| Mesh import / rebuild | `import_mesh`, `mesh_to_solid` | `commands/exchange/importMesh.ts`, `meshToSolid.ts` | STL / OBJ into a mesh entity; prism recognition | — (inputs for `field_from_solid`) |
| Native compute | crates `llull-bvh`, `llull-gpu`, `llull-voxfe`, `llull-geomq`, `llull-topopt`, … | `solver/crates/*`, `solver/bins/llull-compute`, `docs/decisions/RS1-native-compute.md` | Deterministic AABB tree and triangle closest point (bvh), wgpu plumbing with fixed-order reductions (gpu), matrix-free voxel FE + multigrid (voxfe) | No field evaluation, no iso-surfacing crate |
| Context ports | `ExecutionContext` | `packages/core/src/commands/types.ts` (`kernel`, `physics`, `geometryQueries`, `surfaceAnalysis`, `raster`, `ids`, `registry`) | Injected engines with TS defaults | No field engine |
| Toolsets | `TOOLSET_NAMES` | `packages/protocol/src/toolsets.ts` | `core 2d 3d measure parametric assembly materials material-lab analysis review manufacturing fasteners aerodynamics fluids flow exchange building piping civil design pmi plm scan` | No `implicit` |

`git grep` over `packages/ solver/ server/ src/` for `gyroid|tpms|sdf|levelSet|lattice infill|smooth.?min` finds nothing relevant (the
hits for "lattice" are the vortex lattice of `@aero` and the piping auto-router grid). None of the command names proposed in §4 exists
(`git grep -n "name: '<name>'" -- packages` checked for each, 2026-10-22).

### 1.2 Findings that shape the design

| # | Finding | Consequence |
| --- | --- | --- |
| F1 | Every vendor (nTop, Fusion, Creo, NX, CATIA, Carbon, Dendro, Blender) works in a field / volume representation and meshes last [FUNCTIONAL R1–R15] | The document holds a field recipe; the mesh is derived |
| F2 | LIM-1 measured 11 MB documents from six boolean meshes and 17.5 B/triangle GLBs (`docs/decisions/LIM1-scale.md`) | Lattice meshes (10⁶–10⁷ triangles) must NOT be stored in the document (D3) |
| F3 | Manifold `levelSet` is positive inside and evaluates one JS callback per sample in the WASM build [R16] | Not the primary path (LC1: WASM legacy, per-sample callback cost); kept as a test oracle through an adapter that negates |
| F4 | The 3MF Consortium published the **Volumetric & Implicit Extensions 1.0.0** on 2025-11-13 [R18], with native nodes (`sin`, `min`, `max`, `length`, `mesh`, `beamlattice`, `functionCall` …), `<levelset>` objects bounded by a mesh, acyclic graphs | A field recipe can be exported **as a field** (V2), so the node set is chosen to map onto it |
| F5 | Raw TPMS sheets `{|F| ≤ t}` have walls varying by max/min `|∇F|` on the surface: **1.2247 (gyroid, diamond), 1.7321 (Schwarz P)** (`data/tpms_surface.json`; equal to √(3/2) and √3 to 7 digits) | Normalise by the gradient by default (nTop sells this as "Exact thickness" [R2]) |
| F6 | The reference mesher written for this pack hit two classic defects: grid-edge keys `lo·2³² + hi` exceed 2⁵³ above ≈ 2 × 10⁶ nodes (key collisions → non-manifold output at 182³), and triangle orientation decided on degenerate triangles flips them | TR-IMP-08 mandates 64-bit / `nodes²`-bounded keys and orientation on grid-edge midpoints, both regression-tested |
| F7 | Axis-aligned midpoint quadrature aliases with axis-aligned struts (1 % error on the simple-cubic closed form at 160³); low-discrepancy (R3) points give 1.5 × 10⁻⁴ | Field quadrature for strut lattices uses rotated / low-discrepancy points or the mesh volume, never an aligned midpoint grid |

## 2. Target architecture

### 2.1 Layer placement

| Piece | Layer | Why (law) |
| --- | --- | --- |
| `FieldProgram` (instruction tape), TS interpreter (point, interval, forward-mode gradient), `FieldEngine` port, TS default engine `tsFieldEngine`, quadrature and voxel measures | `packages/core/src/geometry/field/` (`program.ts`, `interpret.ts`, `interval.ts`, `engine.ts`, `measure.ts`) | Domain-neutral numerics with a TS default, like `geometryQueries.ts`; pure, no native import (L2, L9) |
| Iso-surface extraction (marching tetrahedra, octree pruning, refinement, weld) | `packages/core/src/lib/isosurface/` | Pure leaf reused by IMP and by the topology plugin (whose `derive.ts` mesher moves here, keeping its node averaging) — one mesher, one test suite (C6) |
| `ExecutionContext.fieldEngine?: FieldEngine \| null` | `packages/core/src/commands/types.ts` + `context.ts` | Narrow injected port (C6), resolved like `geometryQueries` |
| Field model (`doc.implicit`), node graph → `FieldProgram` compiler, TPMS / strut / map modules, all IMP commands, derivation guard, document extension | new plugin package `packages/domain-implicit/src/` (`@implicit`), plugin `implicit`, installed in `src/app/plugins.ts` | A capability with its own document slice and derived geometry, removable, same pattern as `topology` (L10); core never imports it |
| Native engine (tape evaluation, interval-pruned octree, meshing, measures, strut-set distance, winding number) | `solver/crates/llull-field` + job `llull-compute field` | Heavy, uniform, data-parallel numerics (C7, RS1): Rust CPU (rayon) reference, wgpu optional |
| Host installer of the native engine | `server/src/native/fieldEngine.ts` (spawnSync job, TS fallback on failure, provenance), installed by the CLI and the backend when the binary exists | RS1 rule 1: native code only behind a host transport / injected port |
| 3MF beam-lattice and implicit writers | core `commands/exchange/threeMfBeamLattice.ts`, `threeMfImplicit.ts` (used by `export_3mf`) | Exchange is a core catalog (Lane 1); the plugin hands the strut graph / program through a narrow exported type |
| UI | nothing new required; the derived mesh renders as a mesh entity; section / clip views exist | UI = review surface |

### 2.2 Data flow

```
CLI / UI ──execute──> add_tpms_lattice (plugin) ──> doc.implicit.fields[id] = { op:'tpms', … }        (design intent only)
                  └─> combine_fields / shell_field / … ──> more nodes (DAG, ids step-scoped)
                  └─> create_implicit_body (plugin) ──compile──> FieldProgram (tape, bounds, quality)
                         ──ctx.fieldEngine.mesh(program, grid, budgets)──> MeshData + measures + provenance
                         ──> derived mesh entity (read-only), doc.implicit.bodies[id] = { field, voxel, contentHash, entityId }
                  └─> implicit_properties / lattice_properties / check_implicit (queries) ──ctx.fieldEngine.measure(…)──> data
host (server / CLI): installs native FieldEngine (llull-compute field) or leaves tsFieldEngine; caches meshes by contentHash
```

### 2.3 Laws check

- **L1 / L5**: every operation is a `defineCommand`; queries return `data`; `infill_solid` composes other commands via `execute`.
- **L3**: commands return new documents; programs and meshes are frozen copies.
- **L8**: field nodes are design intent (radii, cell sizes, laws, blend radius, entity references), never sample values; ids are
  step-scoped (`fld-<step>.<k>`, `imp-<step>.<k>`); replay re-mints identical ids; editing a node re-derives every body that depends on
  it (dependency walk on the DAG).
- **L9**: the field engine is NOT a B-rep kernel. IMP commands do not declare `requiresKernel`; they read `ctx.fieldEngine` and fall
  back to `tsFieldEngine` (kernel-optional pattern, `@invariant field-engine-optional`). `field_from_solid` reads `ctx.kernel` only to
  tessellate an exact solid at a stated deflection and falls back to the entity's own triangles.
- **L10**: the plugin sees core through its public API and the new `geometry/field` module; hosts use it only through
  `packages/domain-implicit/src/index.ts`.
- **L2**: the plugin never touches files; `export_3mf` returns base64 `data` as today; the CLI writes with `--save`.
- **Tension (decision D3, §11):** a derived mesh that is not stored must be re-derived on load. `DocumentExtension.restore` is a
  pure function of the raw document; running the engine there is deterministic (pure) but costs time on load. Proposal: the saved
  file stores the recipe and `contentHash`; restore re-derives through the resolved engine and the host's content-hash cache.

## 3. Data model

```ts
// packages/core/src/geometry/field/program.ts — the ABI between the plugin, the TS engine and llull-field (domain-free)
export type FieldOp =
  | 'const' | 'x' | 'y' | 'z' | 'add' | 'sub' | 'mul' | 'div' | 'neg' | 'abs' | 'min' | 'max' | 'sqrt' | 'square'
  | 'sin' | 'cos' | 'atan2' | 'floor' | 'fract' | 'clamp' | 'select' | 'smin_quad' | 'smin_exp' | 'chamfer_min'
  | 'mesh_sdf' | 'strut_set' | 'call';
export interface FieldInstruction { readonly op: FieldOp; readonly args: readonly number[]; readonly k?: number }
export interface FieldProgram {
  readonly version: 1;
  readonly instructions: readonly FieldInstruction[];      // SSA tape: instruction i writes register i
  readonly output: number;                                  // register holding the signed distance (negative inside)
  readonly constants: readonly number[];
  readonly meshes: readonly { readonly key: string; readonly mesh: MeshData }[];   // operands of mesh_sdf (field_from_solid)
  readonly strutSets: readonly StrutSet[];                  // operands of strut_set
  readonly bounds: { readonly min: Vec3; readonly max: Vec3 } | null;               // conservative support of {f ≤ 0}
  readonly lipschitz: number;                               // global bound of |∇f| (1 for distance-like programs)
  readonly quality: 'exact' | 'bound' | 'approximate';
  readonly unit: string;                                    // document length unit
}
export interface StrutSet {                                 // periodic or explicit beams, evaluated with O(1) cell lookup
  readonly periodic: { readonly cell: Vec3; readonly origin: Vec3 } | null;
  readonly nodes: readonly Vec3[];                          // cell-local (periodic) or world (explicit)
  readonly beams: readonly { readonly a: number; readonly b: number; readonly ra: number; readonly rb: number; readonly cap: 'sphere' | 'butt' }[];
  readonly radiusField?: number;                            // register of a scalar program driving the radius (graded)
}

// packages/core/src/geometry/field/engine.ts — injected port (ctx.fieldEngine), TS default tsFieldEngine
export interface FieldEngine {
  readonly name: string;                                    // 'ts' | 'llull-field'
  readonly limits: { readonly maxSamples: number; readonly maxTriangles: number };
  evaluate(program: FieldProgram, points: ReadonlyArray<Vec3>, withGradient: boolean): FieldSamples;
  mesh(program: FieldProgram, grid: FieldGrid, options: MeshOptions): FieldMeshResult | FieldRefusal;
  measure(program: FieldProgram, grid: FieldGrid, region: FieldProgram | null, what: MeasureRequest): FieldMeasures | FieldRefusal;
}
export interface FieldGrid { readonly min: Vec3; readonly max: Vec3; readonly voxel: number }
export interface MeshOptions { readonly mesher: 'tetra' | 'dual_contouring'; readonly refineTolerance: number | null; readonly maxTriangles: number }
export interface FieldMeshResult { readonly mesh: MeshData; readonly closedManifold: boolean; readonly samples: number;
  readonly prunedFraction: number; readonly maxVertexResidual: number; readonly provenance: FieldProvenance }
export interface FieldProvenance { readonly engine: string; readonly device: string; readonly deterministic: boolean; readonly voxel: number }
```

```ts
// packages/domain-implicit/src/model.ts — plugin slice (module augmentation of DocumentExtensions)
declare module '@core/model/documentExtensions' { interface DocumentExtensions { implicit?: ImplicitModel } }
export interface ImplicitModel {
  readonly version: 1;
  readonly fields: Readonly<Record<string, FieldNode>>;      // DAG keyed by field id
  readonly bodies: Readonly<Record<string, ImplicitBody>>;
}
export type FieldRef = string;                               // id of another field node
export type Law = number | FieldRef;                         // a number or a scalar field (graded)
export type FieldNode = { readonly id: string; readonly name?: string; readonly provenance?: InputProvenance } & (
  | { readonly op: 'primitive'; readonly shape: 'sphere' | 'box' | 'cylinder' | 'capsule' | 'torus' | 'cone' | 'plane';
      readonly dims: Readonly<Record<string, number | Vec3>>; readonly position: Vec3; readonly rotation: Vec3; readonly rounding?: number }
  | { readonly op: 'solid'; readonly entityId: string; readonly deflection: number }          // field_from_solid (entity referenced, not copied)
  | { readonly op: 'boolean'; readonly kind: 'union' | 'intersect' | 'subtract'; readonly operands: readonly FieldRef[];
      readonly blend?: { readonly kind: 'quadratic' | 'exponential' | 'chamfer'; readonly radius: Law } }
  | { readonly op: 'offset'; readonly source: FieldRef; readonly distance: Law }
  | { readonly op: 'shell'; readonly source: FieldRef; readonly thickness: Law; readonly side: 'inside' | 'outside' | 'centred'; readonly openBy?: FieldRef }
  | { readonly op: 'transform'; readonly source: FieldRef; readonly position: Vec3; readonly rotation: Vec3; readonly scale: number }
  | { readonly op: 'tpms'; readonly kind: TpmsKind; readonly cellSize: Vec3; readonly origin: Vec3; readonly rotation: Vec3;
      readonly form: 'sheet' | 'network'; readonly control: { readonly thickness: Law } | { readonly level: Law } | { readonly relativeDensity: number };
      readonly normalize: 'gradient' | 'none'; readonly map?: CellMap; readonly region?: FieldRef }
  | { readonly op: 'struts'; readonly cell: StrutCell; readonly cellSize: Vec3; readonly origin: Vec3; readonly rotation: Vec3;
      readonly radius: Law; readonly nodeRadius?: number; readonly map?: CellMap; readonly region?: FieldRef }
  | { readonly op: 'graph'; readonly sourceIds: readonly string[]; readonly radiusStart: Law; readonly radiusEnd: Law; readonly cap: 'sphere' | 'butt'; readonly region?: FieldRef }
  | { readonly op: 'scalar'; readonly kind: ScalarKind; readonly params: Readonly<Record<string, number | string | Vec3 | boolean>> }
);
export type TpmsKind = 'gyroid' | 'schwarz_p' | 'diamond' | 'neovius' | 'iwp' | 'lidinoid' | 'fischer_koch_s' | 'split_p';
export type StrutCell = 'cubic' | 'bcc' | 'fcc' | 'octet' | 'kelvin' | 'diamond' | 'bccz' | 'fccz' | 'reentrant';
export type ScalarKind = 'coordinate' | 'distance' | 'ramp' | 'mix' | 'arith' | 'noise' | 'topology_density' | 'fea_result';
export type CellMap =
  | { readonly kind: 'rectangular' }
  | { readonly kind: 'cylindrical'; readonly origin: Vec3; readonly axis: Vec3; readonly cellsAround: number; readonly radialCellSize: number }
  | { readonly kind: 'spherical'; readonly origin: Vec3; readonly cellsAround: number; readonly cellsPolar: number; readonly radialCellSize: number }
  | { readonly kind: 'surface_uv'; readonly sheetId: string; readonly cellsU: number; readonly cellsV: number; readonly depth: number; readonly layers: number };
export interface ImplicitBody {
  readonly id: string; readonly field: FieldRef; readonly voxel: number; readonly bounds: { readonly min: Vec3; readonly max: Vec3 } | 'auto';
  readonly mesher: 'tetra' | 'dual_contouring'; readonly refineTolerance: number | null;
  readonly entityId: string;                                  // derived mesh entity (read-only)
  readonly contentHash: string;                               // sha256 of (compiled program, grid, mesher, engine major version)
  readonly hiddenSources: readonly string[];                  // solids consumed visually (kept, hidden) by field_from_solid
}
```

Propagation rules (computed on read, never stored, so they cannot be cleared): a body is `unverified` iff any node in its DAG has
`provenance.verified = false` (imported meshes without a pinned hash, noise fields used as load proxies, FE / topology inputs that are
themselves unverified). Its distance quality is the worst quality on the path from the output (§5.1 algebra).

Document version / migration: `doc.implicit` is optional (absent until the first IMP command); entity kinds are unchanged (a derived
body is a `mesh` entity, `MeshSolidEntity`, without `brep`). The slice carries its own `version: 1`. Saved files omit derived meshes
(D3); `restore` re-derives them.

## 4. Commands

Notation: Q = query (no document change, returns `data`), M = mutating (appends a FeatureStep). No IMP command declares
`requiresKernel`. All names snake_case, params one inline `z.object`, units in every description (AF-04). Plugin `implicit`,
toolset `implicit` (D5).

### 4.1 Fields

| Command | Q/M | Params (sketch) | @affects | @invariant | @failure (code) |
| --- | --- | --- | --- | --- | --- |
| `add_field_primitive` | M | `shape`, dims (`radius`, `size`, `height`, `ringRadius`, `tubeRadius`, `a`, `b`, `normal`, `offset`), `rounding?`, `position?`, `rotation?`, `name?` | 1 field node | exact SDF for every shape (§5.2) | dims ≤ 0, rounding ≥ half the smallest size → `IMP_PARAM_RANGE` |
| `field_from_solid` | M | `entityId`, `deflection?` (mm, default model tolerance), `hideSource?` (default true) | 1 `solid` node; source hidden, not deleted | sign by winding number, distance exact to the tessellation | unknown id `IMP_ENTITY_NOT_FOUND`; 2D / curve / sheet `IMP_SOLID_NOT_CLOSED`; open or non-manifold mesh `IMP_SOLID_NOT_CLOSED` (lists free-edge count) |
| `combine_fields` | M | `op: union\|intersect\|subtract`, `a`, `b` (id or list ≤ 256), `blend?: {kind, radius}` (mm or scalar field id) | 1 boolean node | quality algebra §5.1; blend metrics in `data` (setback, maxDeviation) | unknown field `IMP_FIELD_NOT_FOUND`; cycle `IMP_FIELD_CYCLE`; radius ≤ 0 `IMP_PARAM_RANGE` |
| `offset_field` | M | `field`, `distance` (mm, + grows) | 1 node | exact on exact fields | non-exact source → applied + warning `IMP_OFFSET_NOT_EXACT` |
| `shell_field` | M | `field`, `thickness` (mm or field), `side`, `openBy?` (field id) | 1 node | inside: `max(f, −f − t)`; outside: `max(−f, f − t)`; centred: `|f| − t/2` | t ≤ 0 `IMP_PARAM_RANGE`; non-exact → warning |
| `transform_field` | M | `field`, `position?`, `rotation?` (rad), `scale?` (uniform > 0) | 1 node | distance scaled by `scale` | scale ≤ 0 `IMP_PARAM_RANGE` |
| `create_scalar_field` (V1) | M | `kind` + kind params: coordinate `axis`; distance `to: {entityId \| point \| plane}`; ramp `input, inMin, inMax, outMin, outMax, clamp, easing`; mix `a, b, factor`; arith `op, a, b`; noise `seed, frequency, octaves`; topology_density `studyId`; fea_result `caseId, quantity` | 1 scalar node | deterministic (noise: counter-based hash of seed) | inMin = inMax `IMP_PARAM_RANGE`; missing study/case `IMP_INPUT_NOT_FOUND` |
| `edit_field` | M | `id`, partial params of that node's op | modifies 1 node; re-derives dependent bodies | same validation as the creating command | as creator; `IMP_FIELD_NOT_FOUND` |
| `delete_field` | M | `id`, `cascade?` | removes node (and bodies with cascade) | refuses while referenced unless `cascade` | `IMP_FIELD_IN_USE` (lists referrers) |

### 4.2 Lattices

| Command | Q/M | Params (sketch) | @affects | @invariant | @failure (code) |
| --- | --- | --- | --- | --- | --- |
| `add_tpms_lattice` | M | `kind`, `cellSize` (mm, number or [3]), `form: sheet\|network`, exactly one of `thickness` (mm or field id, sheet), `level` (field units or field id, network), `relativeDensity` (0..1); `normalize` (default `gradient`), `origin?`, `rotation?`, `map?`, `region?` | 1 tpms node; `data.control` gives the resolved thickness / level | `relativeDensity` resolved once by bisection on the engine's fraction (§5.4), stored as the resolved value + target | thickness ≥ cell/2 or ≤ 0, level outside the field range, density ∉ (0,1) or unreachable → `IMP_TPMS_CONTROL_RANGE`; two controls `IMP_PARAM_CONFLICT`; non-integer `cellsAround` → `IMP_MAP_SEAM` |
| `add_strut_lattice` | M | `cell`, `cellSize` (mm), `radius` (mm or field id), `nodeRadius?` (mm), `origin?`, `rotation?`, `map?`, `region?` | 1 struts node | struts are cylinders (+ node balls); strut graph available to `lattice_properties` / `export_3mf` | 2·radius ≥ shortest strut spacing (cubic: cell) → `IMP_STRUT_RADIUS_RANGE`; seam `IMP_MAP_SEAM` |
| `add_graph_lattice` (V1) | M | `sourceIds` (lines, polylines, arcs, `nurbs_curve`s; curves sampled to beams by `chord` mm), `radiusStart`, `radiusEnd` (mm), `cap: sphere\|butt`, `mergeTolerance` (mm) | 1 graph node | nodes merged within tolerance; beams = 3MF frusta (§5.5) | no line source `IMP_GRAPH_EMPTY`; zero-length beams dropped and counted |
| `add_voronoi_lattice` (V2) | M | `region`, `seed`, `density` (points / mm³ or field), `radius` | 1 graph node | deterministic for a seed | — |

### 4.3 Bodies and composites

| Command | Q/M | Params (sketch) | @affects | @invariant | @failure (code) |
| --- | --- | --- | --- | --- | --- |
| `create_implicit_body` | M | `field`, `voxel` (mm) or `maxTriangles`, `bounds?` (default: program bounds + 2 voxels), `mesher?` (`tetra`), `refineTolerance?` (mm), `name?`, `color?` | 1 derived `mesh` entity + `doc.implicit.bodies[id]` | closed, oriented, manifold mesh; budgets checked before sampling | samples > engine limit `IMP_GRID_BUDGET` (states the native hint or a coarser voxel); triangle estimate > budget `IMP_TRIANGLE_BUDGET`; unbounded field without `bounds` `IMP_FIELD_UNBOUNDED`; empty `IMP_BODY_EMPTY` |
| `infill_solid` (V1) | M | `entityId`, `wall` (mm), `lattice: {type:'tpms', …} \| {type:'struts', …}`, `openBy?`, `drainHoles?: {diameter, count}`, `voxel` | composes `field_from_solid`, `shell_field`, `add_field_primitive`/`offset_field`, `add_tpms_lattice`/`add_strut_lattice`, `combine_fields`, `create_implicit_body` via `execute` | one FeatureStep per composed command (replayable) | any composed refusal is returned with its own code and the step path |
| `regenerate_implicit_bodies` | M | `ids?` (default all stale) | re-derives meshes whose `contentHash` changed | identical mesh for identical hash | — |

### 4.4 Queries

| Command | Q/M | Params (sketch) | `data` (all with `unit`, `provenance`, `unverified`) |
| --- | --- | --- | --- |
| `evaluate_field` | Q | `field`, `points` (≤ 10 000) or `grid {plane, size, n ≤ 200²}`, `gradient?` | `values[]`, `gradients[]?`, `distanceQuality`, `lipschitz` |
| `implicit_properties` | Q | `id` (body or field), `region?`, `voxel?` (measure resolution) | `volume`, `volumeMesh`, `errorEstimate`, `area`, `relativeDensity`, `bounds`, `components`, `enclosedVoids[] {volume, point}` |
| `lattice_properties` | Q | `id` (lattice field), `region?`, `estimateMechanics?` | struts: `cells, nodes, beams, totalLength, radiusMin/Max, slendernessMax, valence{min,max}, rho1, rhoMeasured, maxwell{b, j, M, class}`; TPMS: `thicknessMin/Max, poreDiameterMax, specificSurface, rho`; mechanics (opt-in): `{law, exponent, coefficient, source, unverified:true, reviewRequired:true}` |
| `section_field` (V1) | Q | `field`, `plane {origin, normal}`, `size`, `resolution` | `loops[] {points (bounded), area, perimeter}`, `solidArea`, `solidFraction`; `--save svg` for review |
| `check_implicit` | Q | `id`, `process?: {minWallMm, minPoreMm, minStrutMm, buildDirection?, criticalAngleDeg?, source}`, `purpose?: design\|release` | `status`, `findings[] {code, severity, ids, value, limit, unit, location, remediation}`, `limits` (named, with source / defaulted), `reviewRequired`, `reviewReason` |

### 4.5 Exchange (extensions of existing core commands)

| Command | Change | Notes |
| --- | --- | --- |
| `export_3mf` | new optional `beamLattice: boolean` (V1), `implicit: 'mesh' \| 'levelset'` (V2) | beam lattice §6.1; levelset §6.2; default behaviour unchanged |
| `export_stl`, `export_obj`, `export_gltf` | none | derived bodies are mesh entities; `data` already reports triangles |
| `export_step_ap242` | implicit bodies → `skipped[] {id, code: 'IMP_STEP_NOT_EXACT'}` | never a silent faceted solid (KI5) |
| `export_code` | IMP nodes listed as not lowered | CadQuery / OpenSCAD have no field model |

## 5. Algorithms

### 5.1 Sign, distance quality, Lipschitz algebra

- Convention: `f(p) < 0` inside, `> 0` outside, `= 0` on the surface, document length units. Matches the 3MF implicit beam-lattice
  node ("positive if the point is outside … negative if inside") [R18]; Manifold `levelSet` is the opposite and is wrapped (`−f`).
- Quality per node: **exact** (|f| = Euclidean distance to the surface), **bound** (1-Lipschitz, |f| ≤ distance: safe for sphere
  tracing, pruning, wall estimation as a lower bound), **approximate** (Lipschitz L > 1 or unknown scale).
  Algebra: primitive → exact; transform (rigid / uniform scale) → same; `min`/`max` of exact → bound (exact outside the overlap
  region for union, inside for intersection); smooth blends of bounds → bound (proof below); offset / shell of exact → exact, of bound
  → bound (|f| − c is still 1-Lipschitz but the iso-surface is not the true offset: warning `IMP_OFFSET_NOT_EXACT`); raw TPMS →
  approximate with L = (2π / a)·max|∇F|; gradient-normalised TPMS → approximate near the surface (first-order distance), L reported.
- Every program carries a global `lipschitz` bound used by interval pruning and by `evaluate_field`.

### 5.2 Primitives (exact SDFs; verified in `data/sdf_primitives.json`)

| Shape (local frame) | f(p) |
| --- | --- |
| sphere R | `|p| − R` |
| box half-size h, rounding ρ | `q = |p| − (h − ρ)`; `f = |max(q, 0)| + min(max(qx, qy, qz), 0) − ρ` |
| torus (ring R in XY, tube r) | `|( |p_xy| − R, p_z )| − r` |
| capsule a–b, r | `|p − a − (b − a)·clamp(((p − a)·(b − a))/|b − a|², 0, 1)| − r` |
| cylinder r, height h (axis Z, centred) | `d = (|p_xy| − r, |p_z| − h/2)`; `f = min(max(dx, dy), 0) + |max(d, 0)|` |
| cone (base r at z = 0, apex h) | exact 2D distance in (ρ = |p_xy|, z) to the triangle (0,0)–(r,0)–(0,h), signed by inside test |
| plane n, offset c | `n·p − c` (half-space n·p < c inside) |

Brute-force cross-check (sampled surface, independent of the formula): max deviation 5.2e-4 (sphere, spacing 0.079), 7.3e-4 (torus,
spacing 0.031), 2.0e-4 (box, 0.01), 5.2e-4 (capsule) — all below the sampling bound; |∇f| − 1 ≤ 7e-9 by central differences.

### 5.3 Booleans and blends

| Operation | Formula (f, g fields; k = blend radius) | Metrics returned in `data` |
| --- | --- | --- |
| union / intersect / subtract (sharp) | `min(f, g)` / `max(f, g)` / `max(f, −g)` | — |
| quadratic smooth union | `h = max(k − |f − g|, 0)/k`; `min(f, g) − h²·k/4` | `setback = k`, `maxDeviation = k/4` |
| exponential smooth union | `−k·ln(e^{−f/k} + e^{−g/k})` | `maxDeviation = k·ln 2`; no finite setback: the deviation falls below 1 % of k at `|f − g| = k·ln(1/(e^{0.01} − 1)) ≈ 4.60 k` (reported as `setback99`) |
| chamfer union | `min(min(f, g), (f + g − k)·√½)` | `setback = k` (orthogonal faces), flat 45° face |
| smooth intersect / subtract | `−smin(−f, −g, k)` / `−smin(−f, g, k)` | same metrics |

- **Bounds (derived, `data/smooth_min.json`)**: `0 ≤ min − smin_quad = h²k/4 ≤ k/4`, equality at f = g; `min − smin_exp ≤ k ln 2`.
  ∂smin/∂f = 1 − w, ∂smin/∂g = w with w ∈ [0, 1] ⇒ |∇smin| ≤ (1 − w)|∇f| + w|∇g| ≤ 1: smooth unions of distance bounds remain bounds.
- **Orthogonal half-spaces** x < 0, y < 0 with the quadratic union: the blend boundary is `min(x, y) = (k − |x − y|)²/(4k)` for
  |x − y| < k — a parabolic arc that leaves each face tangentially at distance **k** from the edge, crosses the bisector at
  **d = k/4** (a circular fillet with the same setback would cross at k(1 − 1/√2) = 0.2929 k) and adds area **k²/6** per unit length
  (A = 2∫₀^k (k − u)²/(4k) du; quadrature 0.666677 vs 0.666667 for k = 2). This defines what "blend radius" means in llull (FR-IMP-05).
- **Field-driven blend radius** (k = scalar field): evaluated at the point; the bound proof holds pointwise only if k varies slowly
  (|∇k| < 1); otherwise quality → approximate and `IMP_BLEND_LAW_STEEP` warning.
- Blend wider than a feature (k > the operand's local thickness, estimated by −f at the medial axis) → warning
  `IMP_BLEND_EXCEEDS_FEATURE`.

### 5.4 TPMS

| Kind | F(X, Y, Z), X = 2π(x − x₀)/a_x … | Range | Network fraction at level 0 | max/min |∇F| on F = 0 |
| --- | --- | --- | --- | --- |
| gyroid | `sin X cos Y + sin Y cos Z + sin Z cos X` | ±1.5 | 1/2 (F(−p) = −F(p)) | 1.2247 (2π√2 … 2π√3 per a) |
| schwarz_p | `cos X + cos Y + cos Z` | ±3 | 1/2 (shift by a/2·(1,1,1) flips the sign) | 1.7321 (2π … 2π√3) |
| diamond | `cos X cos Y cos Z − sin X sin Y sin Z` | ±1 | 1/2 (shift x by a/2 flips the sign) | 1.2247 (2π … 2π√1.5) |
| neovius (V1) | `3(cos X + cos Y + cos Z) + 4 cos X cos Y cos Z` | ±13 | 1/2 (shift by a/2·(1,1,1)) | TBD — measure with `generate_tpms_refs.mjs` extension |
| iwp, lidinoid, fischer_koch_s, split_p (V1) | equations transcribed from a pinned source before implementation (TBD, D8) | — | not 1/2 in general | TBD |

Equations of gyroid, P and D as given in [R22] [R23] (diamond also in the equivalent four-term form, shifted by π/4); gyroid by
Schoen [R21].

- **Network**: solid = {F ≤ level}. **Sheet**: solid = {|F| ≤ t}. Fractions vs level / t: `data/tpms_volume_fraction.json` (240³
  midpoint quadrature, |240³ − 120³| ≤ 1.1e-3, mostly ≤ 3e-4). Small-t slope of the raw sheet fraction: gyroid 0.645 t, P 0.572 t,
  D 1.159 t.
- **Distance normalisation** (default): `F̃ = F / |∇F|` with ∇ in physical units, sheet solid = {|F̃| ≤ w/2}, so the wall is w to first
  order (F5). Fractions of the normalised sheet vs w/a are tabulated (gyroid w/a = 0.1 → 0.2943, P → 0.2303, D → 0.3581). The
  singular points of ∇F (|∇F| = 0, away from the surface) are guarded: F̃ = sign(F)·∞ there (outside the sheet).
  "Exact thickness" refinement (COULD): one Newton step towards the surface along ∇F before the division.
- **Specific surface** (area per cell volume, a = 1, nodal surfaces, Richardson extrapolated from 96³ / 192³ meshes): gyroid
  3.0916/a, P 2.3526/a, D 3.8380/a.
- **relativeDensity control**: bisection on t (or level) of the fraction measured by the engine on one cell (quadrature 128³,
  tolerance 1e-4 in density), done once at command time; the resolved value is stored next to the target (the stored node is
  reproducible without re-solving). Monotonic in t for every listed kind (from the tables).
- **Graded control** (thickness / level as a field): evaluated pointwise; walls stay locally w(p) if |∇w| ≪ 1 (warning above 0.5).
- **Validity**: sheet thickness w < a_min/2, level inside the open range of F; otherwise `IMP_TPMS_CONTROL_RANGE` with the valid
  interval in the remediation.

### 5.5 Strut lattices

- **Cells** (unit cell, node coordinates in a; struts listed once per cell; `data/strut_lattices.json`):

| Cell | Struts / cell | Strut length per cell L | ρ1 = π x² L/a (x = r/a) | ρ measured (x = 0.05 / 0.1) | Maxwell class (informative) |
| --- | --- | --- | --- | --- | --- |
| cubic | 3 edges | 3a | 3π x² | 0.022145 / 0.082921 (closed form 0.022148 / 0.082934) | bending (not rigid without bracing) |
| bcc | 8 half body diagonals | 4√3 a | 4√3 π x² | 0.049518 / 0.178468 | bending |
| fcc (face crosses) | 6 face diagonals | 6√2 a | 6√2 π x² | 0.059810 / 0.211939 | bending |
| octet | 6 face diagonals + 12 octahedron edges (24 bonds of a/√2) | 12√2 a | 12√2 π x² | 0.113981 / 0.378627 | stretch |

- **Simple-cubic closed form** with node overlap: ρ = 3π x² − 8√2 x³ (x < 1/2), from inclusion–exclusion with the bicylinder
  16r³/3 and tricylinder 8(2 − √2) r³ [R24]; the R3 quadrature reproduces it to 1.3e-5.
- **Evaluation** (periodic): p → cell coordinates `c = floor((p − o)/a)`, local `q = p − o − c·a`; distance to the cell's struts and
  the struts of the 26 neighbours that come within `r_max` (pre-filtered per cell type at compile time) — O(1) per sample. Explicit
  graphs (graph lattice, clipped boundary) use a BVH over beams (`llull-bvh` natively, `meshBvh`-style tree in TS).
- **Beam geometry** = 3MF semantics [R17]: a conical frustum between nodes with radii interpolated linearly, plus end caps
  (`sphere`: ball of the end radius, `butt`: flat). Frustum distance: 2D distance in the (axial, radial) half-plane to the trapezoid
  (0, 0)–(0, ra)–(L, rb)–(L, 0); the union with balls gives the capped beam. (The "round cone" convex hull of two balls is a different
  shape and is not used.)
- **Graded radius**: r(p) = radius field evaluated at the closest point on the strut axis (so the strut stays a solid of revolution
  locally); quality → approximate when |∇r| > 0.
- **Node balls**: in a periodic lattice every node lies on a strut that continues through it, so balls with r_node ≤ r add nothing;
  `nodeRadius > radius` adds node spheres.
- **Maxwell count** (informative, grade C): M = b − 3j + 6 for a pin-jointed frame with b bars and j joints (rule used by Deshpande,
  Ashby & Fleck to separate stretching- from bending-dominated lattices; only the classification is reported, never a property).
- **Bookkeeping** for export: an n×n×n simple-cubic block has (n + 1)³ nodes and 3n(n + 1)² beams; octet blocks have 14 / 63 / 172
  nodes and 36 / 240 / 756 beams for n = 1 / 2 / 3 (face diagonals split at the face-centre node; `data/beam_block_counts.json`).

### 5.6 Cell maps (conformal)

| Map | Cell coordinates (u, v, w) | Validity |
| --- | --- | --- |
| rectangular | (p − o)·R / a | — |
| cylindrical | u = cellsAround·θ/2π, v = (z − z₀)/a_z, w = (ρ − ρ₀)/a_ρ | `cellsAround` integer, else `IMP_MAP_SEAM` (a 6.5-cell map jumps by 2.0 in F at the seam; integer counts by < 2e-15, `data/composites.json`) |
| spherical | u = cellsAround·φ/2π, v = cellsPolar·θ/π, w = (r − r₀)/a_r | integer counts; pole cells degenerate → warning `IMP_MAP_POLE` |
| surface_uv | (u, v) of a `nurbs_surface` scaled by cellsU / cellsV, w = signed distance along the normal / depth·layers | sheet must be regular (no zero normal in the region), else `IMP_MAP_SINGULAR` |

Distance quality after a non-rigid map is approximate; the map's local stretch (Jacobian singular values) is reported in
`lattice_properties` (`cellStretchMin/Max`) so the agent sees distorted cells. Space deformations of fields beyond these maps are
01 DEF's.

### 5.7 Field → mesh

1. **Grid**: bounds = program bounds (interval propagation) ∪ requested bounds, padded by 2 voxels; voxel h from the param or from
   `maxTriangles` (triangles ≈ c·A/h², c from the reference: sphere R 10, h 0.5 → 44 640 triangles for A = 1256.6: c ≈ 8.9).
   Samples = Π(n_i + 1) checked against `limits.maxSamples` **before** evaluation (`IMP_GRID_BUDGET`).
2. **Pruning** (native, and TS above 64³): octree of tiles (16³); interval evaluation of the tape on each tile; a tile whose
   interval excludes 0 is filled with its sign without sampling; tiles near the surface are sampled. With a Lipschitz bound L, a
   sample with |f| > L·h·√3 also proves its cube surface-free.
3. **Extraction**: marching tetrahedra, 6 Kuhn tetrahedra per cube (the scheme of `topology/derive.ts`, moved to
   `lib/isosurface`), vertices by linear interpolation on grid edges, **welded by an exact edge key** (`lo·nodes + hi`, < 2⁵³ up to
   9.4 × 10⁷ nodes in TS; u64 in Rust), **orientation decided on grid-edge midpoints** (never on the possibly degenerate interpolated
   triangle) (F6). Padding guarantees closure; every output is checked edge-manifold (each directed edge once, its reverse once).
4. **Refinement** (`refineTolerance`): per vertex, ITP / bisection along its grid edge until |f| ≤ tol·L, bounded to the edge
   (Manifold uses the same idea with a cap of 0.25 spacing [R16]).
5. **Error statement** (reference mesher, `data/mesh_convergence.json`): volume and area converge at order 2.00 ± 0.04; sphere R 10:
   volume error −0.48 %, −0.13 %, −0.032 %, −0.0078 % at h ≈ 1, 0.5, 0.25, 0.125 (≈ −0.50 (h/R)²); torus 5/2: −4.3 %, −1.1 %,
   −0.26 %, −0.065 % (≈ −0.17 (h/r)² with r the tube radius); max vertex distance ≈ 0.35 h²/ρ (ρ = R or r). The command reports
   `errorEstimate = 0.5·(h/ρ_min)²·volume` with ρ_min the smallest feature radius known to the compiler (strut radius, wall/2, blend
   radius, primitive radius), labelled `estimated`.
6. **Dual contouring** (V2, sharp features of `field_from_solid` / boxes): QEF per cell from Hermite data, pseudo-inverse with
   singular values below 0.1 (relative) truncated, minimiser biased to the mass point [R19]; DC is not manifold in general
   (multiple features in one cell), so the output is checked and, on failure, the cell falls back to tetrahedra
   (`data.mesherFallbackCells`).

### 5.8 Measures

| Measure | Method | Error statement |
| --- | --- | --- |
| volume | (a) mesh volume (divergence theorem); (b) field quadrature: low-discrepancy points (R3) for strut programs, midpoint grid otherwise (F7), two resolutions | `errorEstimate` = |(b₂ − b₁)| + mesher estimate |
| area | mesh area; Richardson from two voxels on request | stated |
| relative density | volume / region volume (region = its own program measured the same way) | stated |
| components / voids | flood fill on the sign grid: solid 6-connected, void 26-connected (dual connectivity, consistent with the tetrahedral surface); a void component not touching the grid boundary = enclosed void | exact on the grid; components smaller than 8 voxels reported as `belowResolution` |
| wall thickness / pore size | Euclidean distance transform of the sign grid (inside for walls, outside for pores); thickness = 2 × local maximum of the inside distance on the medial set; for exact programs −f is used directly | ± h |
| overhang (V1) | mesh normals vs build direction; area with angle to the build plate below the critical angle | exact on the mesh |

### 5.9 `field_from_solid`

Triangles of the entity (exact kernel tessellation at `deflection`, else the mesh) → BVH → unsigned distance (closest point,
`llull-bvh` natively, `meshBvh` in TS); sign by the **generalised winding number** w(p) = Σ Ω_t(p)/4π over triangles (solid angle of
each triangle by the Van Oosterom–Strackee formula), inside iff w > ½ — robust on closed, consistently oriented meshes and degrades
gracefully on small defects (|w − ½| < 0.1 → sample flagged). Hierarchical evaluation (dipole approximation per BVH node beyond 2×
the node size) keeps it O(log n). Distance quality exact to the tessellation, so the field of a B-rep solid differs from the true
B-rep distance by at most the tessellation deflection (reported). Open meshes (free edges) are refused (`IMP_SOLID_NOT_CLOSED`) — repair
belongs to 07 MSH.

### 5.10 Native crate `llull-field` (C7 decision record)

| Option | Licence (crates.io, 2026-10) | Fit | Decision |
| --- | --- | --- | --- |
| Own crate `solver/crates/llull-field` (tape interpreter, interval arithmetic, octree, marching tetrahedra, winding number on `llull-bvh`, rayon) | workspace (UNLICENSED, proprietary) | Exact control of determinism (AF-13), same tape as TS, bit-exact CPU twin, no new dependency risk | **Chosen** |
| `fidget` 0.5.1 | MPL-2.0 | JIT tape evaluation with interval simplification and Manifold Dual Contouring; README: "personal-scale experimental project … expect to fork it" [R27] | Reference for the tape / interval design; not a dependency (file-level copyleft + stability) |
| `manifold3d` 0.4.1 (bindings) | Apache-2.0 OR MIT | LevelSet with a per-point callback | Oracle only (same as F3) |
| `fast-surface-nets` 0.2.1 | MIT OR Apache-2.0 | Naive surface nets on chunks | COULD for preview meshes |
| `isosurface` 0.0.4 | Apache-2.0 | Unmaintained since 2021 | No |
| `implicit3d` 0.16.0, `sdfu` 0.3.0 | Apache-2.0 OR MIT / MIT OR Apache-2.0 | SDF combinators without meshing / budgets | No |
| OpenVDB (C++) | Apache-2.0 [R28] | Sparse volumes, level-set tools (Dendro's base) | Not now: a large C++ dependency for what the tape + octree cover; reconsider for V2 sparse narrow-band storage |

Crate layout: `tape.rs` (SSA tape, constant folding, dead-register elimination), `eval.rs` (f64 point evaluation in batches of 256,
gradient by forward-mode duals), `interval.rs`, `octree.rs`, `tetra.rs` (extraction, u64 edge keys, midpoint orientation), `measure.rs`
(quadrature, flood fill, EDT), `winding.rs`, `struts.rs`, `job.rs` (`llull-compute field <job-folder>`: `job.json` + little-endian f64 /
u32 files, the contract of `llull-geomq`), `gpu.rs` (COULD: wgpu tape evaluation for previews, `deterministic: false`). Determinism:
tiles processed in parallel, results merged in tile index order; vertex numbering by (tile, local edge key); reductions in fixed order
(`llull-gpu` reduce helpers). The TS engine is the oracle for small grids (RS1 rule 4: kept because it is the runtime path without the
binary and below the TS caps).

### 5.11 Numerical tolerances (summary)

| Quantity | Default | Note |
| --- | --- | --- |
| Program evaluation TS vs Rust | 1e-12 relative (same tape, f64) | VC-IMP-44 |
| Mesh volume vs closed form | 0.6 (h/ρ_min)² relative bound (≥ the 0.50 measured coefficient) | §5.7 |
| Field quadrature volume | difference of two resolutions, reported | §5.8 |
| relativeDensity inversion | 1e-4 | §5.4 |
| Vertex refinement | `refineTolerance` (mm) | §5.7 |
| Winding-number sign margin | 0.1 | §5.9 |

## 6. Interop & persistence

### 6.1 3MF Beam Lattice 1.2.0 (V1, `export_3mf beamLattice: true`) [R17]

| llull | 3MF element / attribute |
| --- | --- |
| strut lattice / graph node, clipped to its region | `<object type="model"><mesh>` whose `<vertices>` are the lattice nodes (mm) and whose `<triangles>` may be empty, with child `<b:beamlattice>` (`xmlns:b="http://schemas.microsoft.com/3dmanufacturing/beamlattice/2017/02"`) |
| beam a–b, radii ra / rb | `<b:beam v1 v2 r1 r2 cap1 cap2>` (two distinct vertex indices) |
| default strut radius, shortest beam | `radius` (required), `minlength` (required; beams shorter are ignored by consumers — llull never writes them and reports dropped beams) |
| node balls (`nodeRadius`) | balls extension `b2` (`http://schemas.microsoft.com/3dmanufacturing/beamlattice/balls/2020/07`), `ballmode`, `ballradius` |
| region (skin / body) | `clippingmode="inside"` + `clippingmesh` = the region's realised mesh object (defined earlier in the file) |
| realised mesh of the lattice | `representationmesh` (consumers that cannot build beams use it) |
| TPMS lattices | not beams: exported as meshes (or as levelset, §6.2) |

### 6.2 3MF Volumetric & Implicit 1.0.0 (V2, `export_3mf implicit: 'levelset'`) [R18]

`<v:levelset functionid channel meshid meshbboxonly minfeaturesize>` with `<i:implicitfunction>` built from the program
(`xmlns:v="http://schemas.3mf.io/3dmanufacturing/volumetric/2022/01"`, `xmlns:i="http://schemas.3mf.io/3dmanufacturing/implicit/2023/12"`):
tape ops map to native nodes (`addition`, `subtraction`, `multiplication`, `division`, `min`, `max`, `abs`, `sqrt`, `sin`, `cos`,
`atan2`, `fract`, `floor`, `clamp`, `select`, `length`, `mesh` for `mesh_sdf`, `beamlattice` for `strut_set` of explicit beams);
smooth minima are expanded into those nodes; `meshid` = the program bounds box; `minfeaturesize` = the smallest feature radius of §5.7.
Graphs are acyclic by construction (the tape is SSA). Validation against the pinned `implicit.xsd` (sha256
e88ce8d50612dc740ca2fdc877f137d2eccc9595d02870974df32356f8963a2e). **Open point (D7):** the passages read state the beam-lattice node's
sign (negative inside) but not the interior sign of `<levelset>` itself; confirm against the spec examples / lib3mf before writing.

### 6.3 Other formats and the document

| Item | Behaviour |
| --- | --- |
| STL / OBJ / glTF / 3MF mesh | the derived mesh, unchanged exporters |
| STEP AP242 | skipped, `IMP_STEP_NOT_EXACT` with remediation "export_stl / export_3mf; mesh → B-rep is 07 MSH" |
| Code export | IMP nodes listed as not lowered |
| `.llull.json` | `doc.implicit` (fields, bodies with `contentHash`); derived mesh entities written without `mesh` triangles (D3), restored by re-derivation; a document opened by a build without the plugin keeps the slice untouched (plugin slices are opaque to core) |
| Host cache | `<user cache>/llull/field/<contentHash>.bin` (indexed f32 vertices + u32 triangles); a hit skips evaluation; never authoritative (hash re-checked) |

## 7. CLI / UI surfaces

- **CLI (primary)**: nothing special — registry commands: `llull search lattice gyroid infill blend` · `llull describe add_tpms_lattice` ·
  `llull list implicit` · `llull run plan.json --validate` then `--json --progress` · `llull implicit_properties id=… --json` ·
  `llull check_implicit … --json` · `llull render_view isolate=<id> --save view.png` · `llull export_3mf … --save part.3mf`.
  `create_implicit_body`, `infill_solid` and `regenerate_implicit_bodies` honour `--progress` / `--timeout` (AF-40) through the engine's
  tile progress; every mutating command works with `--dry-run` (AF-42). `llull guide` gains an implicit section (sign convention,
  distance quality, minimal infill plan, how to read `check_implicit`) (AF-03).
- **UI**: forms from `listCommands()`; the body renders as a mesh; the reviewer uses section / clip views and the check report.

### 7.1 Stable error and finding codes (AF-11)

Refusals return the unchanged document, exit 1, `error {code, ids, paths, remediation}`; findings live in `check_implicit`
`data.findings[]` (exit 0, read `status`).

| Code | Raised by | When | Ids / path | Remediation |
| --- | --- | --- | --- | --- |
| `IMP_PARAM_RANGE` | all creators | a size / radius / thickness ≤ 0 or rounding too large | `params.<name>` | give a positive value in mm (rounding < half the smallest size) |
| `IMP_PARAM_CONFLICT` | `add_tpms_lattice` | more than one of thickness / level / relativeDensity | `params` | give exactly one control |
| `IMP_FIELD_NOT_FOUND` | all field consumers | unknown field id | `params.a` … | `llull describe_scene` / `implicit_properties` to list fields |
| `IMP_FIELD_CYCLE` | `combine_fields`, `edit_field` | the edit would make the graph cyclic | ids on the cycle | reference an earlier field |
| `IMP_FIELD_IN_USE` | `delete_field` | referenced by other nodes / bodies | referrer ids | delete them first or pass `cascade: true` |
| `IMP_ENTITY_NOT_FOUND` | `field_from_solid`, maps, graph | unknown entity | `params.entityId` | list entities with `describe_scene` |
| `IMP_SOLID_NOT_CLOSED` | `field_from_solid` | 2D / curve / sheet entity, or mesh with free / non-manifold edges | entity id, free-edge count | close it (`sew_surfaces`, 07 MSH repair) or pick the solid |
| `IMP_INPUT_NOT_FOUND` | `create_scalar_field` | topology study / FE case missing or without result | `params.studyId` | run the study / analysis first |
| `IMP_TPMS_CONTROL_RANGE` | `add_tpms_lattice` | thickness ∉ (0, a/2), level outside F's range, density unreachable | `params.thickness` … | the valid interval is in the message |
| `IMP_STRUT_RADIUS_RANGE` | `add_strut_lattice`, `add_graph_lattice` | radius ≤ 0 or struts would merge (2r ≥ strut spacing) | `params.radius` | reduce the radius or enlarge the cell |
| `IMP_MAP_SEAM` | lattice creators | non-integer cells around / polar | `params.map.cellsAround` | use a whole number of cells |
| `IMP_MAP_SINGULAR` | `surface_uv` maps | zero normal / degenerate patch in the region | sheet id, (u, v) | trim the region or pick another sheet |
| `IMP_GRAPH_EMPTY` | `add_graph_lattice` | no line-like source | `params.sourceIds` | pass lines / polylines / curves |
| `IMP_FIELD_UNBOUNDED` | `create_implicit_body` | program has no bounds (e.g. a bare TPMS or plane) and no `bounds` param | `params.bounds` | give `region` or `bounds` |
| `IMP_GRID_BUDGET` | `create_implicit_body`, queries | samples > engine limit | `params.voxel`, samples, limit, engine | coarser voxel, smaller bounds, or install / use the native engine (`kernel_info`) |
| `IMP_TRIANGLE_BUDGET` | `create_implicit_body` | estimated triangles > budget (default 5 × 10⁶: ≈ 87 MB GLB at LIM-1's 17.5 B/triangle) | estimate | coarser voxel, export a 3MF beam lattice, or raise `maxTriangles` |
| `IMP_BODY_EMPTY` | `create_implicit_body` | no sample inside | field id | check the sign / region |
| `IMP_ENGINE_FAILED` | engine | native job crashed / timed out; TS fallback not possible above its cap | job id, reason | retry, or coarser voxel (TS engine) |
| `IMP_DERIVED_READ_ONLY` | guard | edit of a derived body mesh | entity id | edit the field (`edit_field`) |
| `IMP_STEP_NOT_EXACT` | `export_step_ap242` (skipped list) | implicit body has no exact B-rep | entity id | export STL / 3MF |
| `IMP_OFFSET_NOT_EXACT` | warn (command `data`, `check_implicit`) | offset / shell of a bound / approximate field | field id | expect non-uniform walls; measure with `lattice_properties` |
| `IMP_BLEND_EXCEEDS_FEATURE` · `IMP_BLEND_LAW_STEEP` | warn | blend radius > feature thickness; |∇k| ≥ 1 | field id, values | reduce the radius / smooth the law |
| `IMP_CHECK_MESH_NOT_MANIFOLD` | `check_implicit` fail | realised mesh not closed manifold | entity id, edge count | report a bug; re-realise with `mesher: tetra` |
| `IMP_CHECK_RESOLUTION_COARSE` | warn | smallest wall / strut / pore < 2 voxels | value, voxel | halve the voxel |
| `IMP_CHECK_MIN_WALL` · `IMP_CHECK_MIN_PORE` · `IMP_CHECK_MIN_STRUT` | fail | below the process limit | location, value, limit, source | thicken / enlarge cells |
| `IMP_CHECK_NO_PROCESS_LIMITS` | warn (not suppressible) | no process limits given | — | pass `process {minWallMm, minPoreMm, minStrutMm, source}` |
| `IMP_TRAPPED_VOID` | fail | enclosed void (powder / resin cannot drain) | void volume, a point inside | add drain holes (`infill_solid drainHoles`, subtract a cylinder field) |
| `IMP_DISCONNECTED` | fail | > 1 solid component | component count, volumes, points | connect or delete islands |
| `IMP_CHECK_OVERHANG` | warn (with `buildDirection`) | area below the critical angle | area, angle | reorient or use self-supporting cells |
| `IMP_CHECK_INPUT_UNVERIFIED` | warn (not suppressible) | an input is `unverified` | input ids | pin the source |
| `IMP_MECHANICS_UNVERIFIED` | warn | mechanical estimate requested | — | test coupons / qualified engineer |

### 7.2 Result conventions (AF-10, AF-31..35)

- Every `data` has `unit` (length), volumes `volume` + `volumeUnit` (`mm³` for a mm document), densities dimensionless with the
  region named; angles in degrees with `Deg` suffix.
- `provenance {method, engine, device, deterministic, voxel, quadrature}` on every result (AF-35); `distanceQuality` on every field
  result.
- Process limits are `NamedTolerance`-like `{value, unit, source, defaulted}`; llull ships **no** default printer table in the MVP
  (FR-IMP-41; D6).
- `reviewRequired` + `reviewReason` on `check_implicit purpose=release` and on any mechanical estimate; summary ends with "computed by
  llull, not approved: needs a qualified engineer" in those cases (AF-33, AF-36).
- Bounded output: `evaluate_field` ≤ 10 000 points, `section_field` loops decimated to ≤ 2 000 points each unless `--save`.

### 7.3 Agent-first compliance

| AF | Where |
| --- | --- |
| AF-01, 02, 04 | FR-IMP-60; §4 params with units; descriptions name the next command (e.g. `add_tpms_lattice` → `create_implicit_body`) |
| AF-03 | `llull guide` implicit section (§7) |
| AF-05 | plans in `validation/plans/` validate with `--validate` |
| AF-10, 12 | §7.2 |
| AF-11 | FR-IMP-61, §7.1 |
| AF-13 | FR-IMP-64, §5.10 |
| AF-20, 30 | `check_implicit` (FR-IMP-40..45) |
| AF-21 | `implicit_properties`, `lattice_properties`, `section_field` numbers instead of looking inside |
| AF-22 | `render_view isolate … --save` in the CLI workflow |
| AF-31, 32, 33, 34 | FR-IMP-41, 63, 45 |
| AF-35, 36 | §7.2 provenance, FR-IMP-62 |
| AF-40, 41, 42 | §7 CLI bullet, FR-IMP-65, 66 |

## 8. Performance & robustness budgets

| Operation | Budget | Notes |
| --- | --- | --- |
| TS engine sample cap | 2²¹ samples (≈ 128³) | the reference mesher measured ≈ 6 × 10⁶ samples + extraction in ≈ 5 s in Node (sphere, 182³) — the cap keeps a TS job ≤ 2 s; above it `IMP_GRID_BUDGET` names the native engine |
| Native engine sample cap | 2³⁰ samples (sparse: only tiles near the surface are sampled) | target, TBD — measure with `cargo bench -p llull-field` |
| 40 mm gyroid-infill cube, voxel 0.2 (≈ 8 × 10⁶ grid samples, pruned) | ≤ 5 s native, CPU 8 threads | target (KPI); TBD — measure |
| `evaluate_field` 10 000 points | ≤ 50 ms TS | — |
| `implicit_properties` (two quadratures 128³ / 256³ pruned) | ≤ 3 s native | — |
| `relativeDensity` inversion | ≤ 0.5 s (one cell, 128³ TS) | — |
| Triangle budget | 5 × 10⁶ default (`IMP_TRIANGLE_BUDGET`) | LIM-1 GLB ratio |
| Robustness | NaN / ∞ from user laws → sample treated as outside and counted (`data.nonFiniteSamples`); never a crash; every engine failure → TS fallback or `IMP_ENGINE_FAILED` | fuzz the compiler with random DAGs |

## 9. Test strategy

| Level | Location | Content | VC |
| --- | --- | --- | --- |
| Unit (core field math) | `tests/unit/field/*.test.ts` | primitives vs `data/sdf_primitives.json`, smooth-min bounds, quality algebra, interval soundness (random programs: point value ∈ interval), gradient vs finite differences | 01–09 |
| Unit (mesher) | `tests/unit/isosurface/*.test.ts` | convergence table (`data/mesh_convergence.json`), closed-manifold on all shapes, **regressions for F6** (edge keys above 2 × 10⁶ nodes; node-exact zero values), topology plugin's iso-surface unchanged after the move | 20, 21 |
| Unit (plugin commands) | `tests/unit/implicit/*.test.ts` | happy + failure per command, `is pure`, schema snapshot, codes of §7.1, DAG edit re-derivation, guard | 10–19, 22–28, 40 |
| Agent-first | `tests/unit/implicit/agentFirst.test.ts` | units in `describe`, `unverified` propagation, `reviewRequired`, process limits never defaulted | 41–43, 47 |
| Golden | `tests/golden/plans.ts` + `validation/plans/target_*.json` | id-normalised snapshots, replay equality, mesh content hash stability | 05, 15, 22–25, 30, 44, 48 |
| Native | `solver/crates/llull-field` `cargo test` (in `npm run native:check`) + `server/tests/nativeFieldEngine.test.ts` | TS vs Rust tape parity (1e-12), mesh identity per engine, fallback on a crashing job, budgets | 44–46 |
| Oracle | `tests/unit/field/manifoldOracle.test.ts` | Manifold `levelSet` (negated) volume vs ours within the mesh error bound on sphere / torus / gyroid cube | 20 |
| Exchange | `tests/unit/exchange/threeMfBeamLattice.test.ts` (+ XSD check in `server/tests`) | beam / node counts, namespaces, `minlength`, clipping mesh order; levelset XSD validation (V2) | 30–32 |
| Production gate | scenario "lightweight bracket": STEP bracket → `infill_solid` gyroid 0.6 mm walls, 1.5 mm skin → check → 3MF | all `check_implicit` pass, volume within error estimate of the field quadrature | 22, 23, 33–36 |

### 9.1 Technical requirements

| Id | Requirement | Spec | VCs |
| --- | --- | --- | --- |
| TR-IMP-01 | `FieldProgram` SSA tape, TS interpreter (point, interval, forward gradient), constant folding; in `geometry/field` | §3, §5.1 | 01–04, 44 |
| TR-IMP-02 | `FieldEngine` port on `ExecutionContext`, `tsFieldEngine` default, `resolveFieldEngine`; limits declared per engine | §3, §2.1 | 44–46 |
| TR-IMP-03 | Plugin `@implicit`: slice via module augmentation, DAG compiler, commands, derivation guard, document extension (validate, derivedEntityIds, restore with re-derivation) | §2, §3, §4 | 22, 23, 40, 48 |
| TR-IMP-04 | Primitive SDFs, sharp / smooth / chamfer booleans, offset, shell, transforms, distance-quality algebra and blend metrics | §5.1–5.3 | 01–09 |
| TR-IMP-05 | TPMS module: equations, network / sheet, gradient normalisation, fraction tables, density inversion, validity ranges | §5.4 | 10–14, 24, 27 |
| TR-IMP-06 | Strut module: cells, periodic O(1) evaluation, frustum + cap geometry, graded radius, graph lattices, bookkeeping, Maxwell count | §5.5 | 15–19, 26, 30 |
| TR-IMP-07 | Cell maps with seam / pole / singularity checks and stretch report | §5.6 | 25 |
| TR-IMP-08 | Mesher in `lib/isosurface`: Kuhn MT, padding, exact edge keys, midpoint orientation, manifold check, refinement, pruning; topology plugin migrated | §5.7 | 20, 21 |
| TR-IMP-09 | Measures: dual quadrature with error, components / voids, EDT wall / pore, overhang | §5.8 | 30–38 |
| TR-IMP-10 | `field_from_solid`: BVH distance + generalised winding number, closedness refusal | §5.9 | 08 |
| TR-IMP-11 | Native `llull-field` crate + `llull-compute field` job + `server/src/native/fieldEngine.ts` installer, deterministic merge order, TS fallback, provenance | §5.10 | 44, 45 |
| TR-IMP-12 | 3MF beam-lattice writer (V1) and volumetric / implicit writer (V2) | §6.1, §6.2 | 30, 31 |
| TR-IMP-13 | STEP skip code, mesh exporters on derived bodies, persistence without meshes + content-hash cache | §6.3 | 32, 48, 49 |
| TR-IMP-14 | Stable codes of §7.1 with paths and remediation | §7.1 | 40 |
| TR-IMP-15 | `check_implicit` with named process limits, non-suppressible warnings, `reviewRequired`; mechanical estimates flagged | §4.4, §7.2 | 33–37, 43, 47 |
| TR-IMP-16 | Budgets checked before work, progress / timeout, non-finite sample policy | §5.7, §8 | 46 |
| TR-IMP-17 | Units, provenance and bounded output in every result | §7.2 | 39, 41, 42 |

## 10. Delivery plan

| Milestone | Content | Depends on | Effort (eng-weeks) |
| --- | --- | --- | --- |
| M0 | Decisions D1–D8; `packages/domain-implicit` workspace (`@implicit` alias in `tsconfig.base.json`, layer rules in `.dependency-cruiser.cjs`, coverage gate entry), toolset + design-language example (D5) | — | 1 |
| M1 | Core `geometry/field` (tape, TS interpreter, interval, engine port) + `lib/isosurface` (mesher moved from topology, F6 regressions) | M0 | 3 |
| M2 | Plugin MVP: primitives, booleans + blends, offset / shell / transform, `create_implicit_body`, `implicit_properties`, `evaluate_field`, guard + persistence (D3) | M1 | 3 |
| M3 | Lattices MVP: TPMS gyroid / P / D (normalised, density inversion), struts cubic / BCC / FCC / octet, regions, `lattice_properties`, `field_from_solid`, `check_implicit` (MVP findings) | M2 | 4 |
| M4 | Native `llull-field` + `llull-compute field` + host installer, parity tests, budgets | M1 (parallel to M2–M3) | 5 |
| M5 | V1: scalar fields + graded laws, `infill_solid`, cell maps, more cells, graph lattices, `section_field`, refinement, 3MF beam lattice, topology / FEA inputs, overhang, trapped-void drain hints | M3, M4; 17 TOP / 05 FEA result access | 6 |
| M6 | V2: 3MF implicit export, dual contouring, Voronoi, homogenisation on `llull-voxfe` (transport + record command), GPU preview | M5 | 6 |

Total ≈ 28 eng-weeks. Cross-gap: **01 DEF** (coordinate maps of fields), **07 MSH** (decimation / repair / mesh → NURBS of IMP meshes),
**17 TOP** (density input), **05 FEA** (result fields, and analysis of lattice parts via homogenised properties).

## 11. Open questions / decisions needed

| # | Question | Proposal |
| --- | --- | --- |
| D1 | Plugin package vs core feature catalog for the commands | Plugin `@implicit` (own slice, derived geometry, removable); field numerics in core `geometry/field` because the engine port must be typed in core |
| D2 | One FieldProgram tape shared by TS and Rust vs a node-graph ABI | Tape (stable, small, maps 1:1 to 3MF implicit nodes; the node graph stays a plugin concern) |
| D3 | Store derived meshes in the document? | No: store recipe + `contentHash`, omit triangles, re-derive in `restore` with the resolved engine and a host cache (LIM-1 sizes). Needs owner approval because load time becomes engine time |
| D4 | Manifold `levelSet` as a TS-side mesher? | No (LC1, F3); oracle in tests only |
| D5 | New toolset `implicit` (needs a design-language example per the SRF finding) vs listing in `3d` + `manufacturing` | New toolset `implicit` |
| D6 | Ship a printer process-limit table? | Not in MVP (no verified source); V1 only from pinned manufacturer data sheets cited per entry |
| D7 | Interior sign of 3MF `<levelset>` | Confirm from the spec examples / lib3mf before M6 |
| D8 | Equations for I-WP, Lidinoid, Fischer–Koch S, split P | Transcribe from a pinned primary source with a symmetry / fraction test before enabling (V1) |
| D9 | Blocking spawnSync for long realisations (desktop UI freeze) | Same as geomq for the MVP; a job transport with progress for > 10 s jobs in M5 |

## 12. References

Same numbering as FUNCTIONAL_SPEC §11 ([R1]–[R26]); additionally:

- [R27] fidget — https://github.com/mkeeter/fidget (README, MPL-2.0); crates.io API records (name, max stable version, licence) for
  `fidget`, `isosurface`, `fast-surface-nets`, `implicit3d`, `sdfu`, `manifold3d`, `meshopt` — https://crates.io/api/v1/crates/<name> (accessed 2026-10)
- [R28] OpenVDB — LICENSE (Apache-2.0) — https://github.com/AcademySoftwareFoundation/openvdb (accessed 2026-10)
- llull internal: `docs/decisions/RS1-native-compute.md`, `docs/decisions/LIM1-scale.md`, `docs/decisions/LC1-local-only.md`,
  `docs/decisions/KI5-shape-kernel-boundary.md`, `.claude/rules/architecture.md`, `packages/domain-cae/src/topology/derive.ts`,
  `node_modules/manifold-3d/manifold-encapsulated-types.d.ts` (3.5.4).
