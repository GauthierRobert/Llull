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

---

## 13. As built (DES-5: M0–M3, 2026-10-23)

Delivered: M0 workspace, M1 core field numerics + shared mesher, M2 plugin MVP, M3 lattice MVP. Not delivered (next): M4 native `llull-field`, M5/M6 (§13.7).
Decisions D1–D8 were taken as recommended: D1 plugin `@implicit` (`packages/domain-implicit`), numerics in core `geometry/field`; D2 one tape shared by TS and Rust; D3 derived meshes are
not stored (recipe + `contentHash`; `DocumentExtension.restore` re-derives bodies in creation order against the entities restored so far, so bodies may be built on bodies; a mesh that realises with another hash, e.g. another engine, is kept and the record is rewritten; a body the engine refuses is dropped from `order`/`selection` and `afterLoad` reports `IMP_BODY_STALE`); D4 no Manifold `levelSet` mesher; D5 toolset `implicit` with `packages/design-lang/examples/implicit.lld`; D6 no printer table; D7 open (M6); D8 only gyroid / Schwarz P /
diamond are enabled (no other TPMS equation is transcribed). D9 as proposed (blocking engine call).

### 13.1 Files

| Area | Files |
| ---- | ----- |
| Workspace (M0) | `packages/domain-implicit/{package.json,src/index.ts}`; `@implicit/*` in `tsconfig.base.json` (Vite/Vitest read it through `workspaceAliases.ts`) and `server/tsconfig.json`; coverage gate `packages/domain-implicit/src/**` and a chunk group in `vite.config.ts`; `.dependency-cruiser.cjs` layer comment (the `domain-[^/]+` rules already cover the package, including `hosts-use-plugins-through-their-index`); `package-lock.json` workspace entry; toolset `implicit` in `packages/protocol/src/toolsets.ts` (+ the palette label in `src/ui/components/commandPalette/paletteItems.ts`, required by its `satisfies Record<ToolsetName, string>`); `installPlugin(implicitPlugin)` in `src/app/plugins.ts`; `tests/setup.ts` resets the field engine |
| Core numerics (M1) | `packages/core/src/geometry/field/{program,build,interpret,gradient,interval,strutSet,meshSdf,components,engineTypes,engine,tsEngine}.ts`; `ExecutionContext.fieldEngine` (`commands/types.ts`, `context.ts`) |
| Mesher (M1) | `packages/core/src/lib/isosurface/{tetra,measures}.ts`; `packages/domain-cae/src/topology/derive.ts` now calls `marchingTetrahedra` (the private mesher is gone) |
| Plugin (M2/M3) | `packages/domain-implicit/src/*.ts`: `model, codes, frame, primitives, tpms, tpmsControl, struts, solidMesh, compile, realise, nodeResult, measure, document` + commands `primitiveCommand, opCommands, solidCommand, latticeCommands, bodyCommand, evaluateCommand, propertiesQuery, latticeProperties, checkImplicit`, `catalog.ts`, `plugin.ts` |

### 13.2 Commands (13, all pure `defineCommand`, none `requiresKernel`)

`add_field_primitive`, `field_from_solid`, `combine_fields`, `offset_field`, `shell_field`, `transform_field`, `add_tpms_lattice`, `add_strut_lattice`, `create_implicit_body`, `evaluate_field`
(Q), `implicit_properties` (Q), `lattice_properties` (Q), `check_implicit` (Q). All return `data` with `unit`, `distanceQuality`, `unverified`, `provenance`; refusals use the §7.1 codes
(`IMP_PARAM_RANGE`, `IMP_PARAM_CONFLICT`, `IMP_FIELD_NOT_FOUND`, `IMP_ENTITY_NOT_FOUND`, `IMP_SOLID_NOT_CLOSED`, `IMP_TPMS_CONTROL_RANGE`, `IMP_STRUT_RADIUS_RANGE`, `IMP_MAP_SEAM`,
`IMP_FIELD_UNBOUNDED`, `IMP_GRID_BUDGET`, `IMP_TRIANGLE_BUDGET`, `IMP_BODY_EMPTY`, `IMP_ENGINE_FAILED`, `IMP_DERIVED_READ_ONLY`); findings of `check_implicit` use
`IMP_CHECK_MESH_NOT_MANIFOLD`, `IMP_CHECK_RESOLUTION_COARSE`, `IMP_CHECK_NO_PROCESS_LIMITS`, `IMP_CHECK_MIN_WALL`, `IMP_CHECK_MIN_STRUT`, `IMP_TRAPPED_VOID`, `IMP_DISCONNECTED`,
`IMP_CHECK_INPUT_UNVERIFIED`; warnings `IMP_OFFSET_NOT_EXACT`, `IMP_BLEND_EXCEEDS_FEATURE`, `IMP_MECHANICS_UNVERIFIED`.

### 13.3 Tape format (reference for the native crate `llull-field`)

JSON shape (`FieldProgram`, `geometry/field/program.ts`), all numbers IEEE-754 binary64, little-endian when sent as binary:

```
{ version: 1, instructions: [{op, args:number[]}], output: number, constants: number[],
  meshes: [{key, mesh:{positions:number[], indices:number[]}}],            // operands of mesh_sdf (closed, outward oriented)
  strutSets: [{periodic:{cell:[3],origin:[3]}|null, nodes:[[3]], beams:[{a,b,ra,rb,cap:'sphere'|'butt'}]}],
  bounds:{min:[3],max:[3]}|null, lipschitz:number, quality:'exact'|'bound'|'approximate', unit:string }
```

SSA: instruction `i` writes register `i` and reads only registers `< i`. `output` is the register holding f (negative inside). `args` are listed per op, `r` = register index, `c` = index
into `constants`, `m` = index into `meshes`, `s` = index into `strutSets`, `r?` = register or `-1` (none). A conforming evaluator reproduces the TS values to 1e-12 relative.

| op | args | value |
| -- | ---- | ----- |
| `const` | `c` | `constants[c]` |
| `x` `y` `z` | none | the point coordinate |
| `add` `sub` `mul` `div` | `r r` | IEEE `a+b`, `a-b`, `a*b`, `a/b` |
| `neg` `abs` `sqrt` `square` `sin` `cos` `floor` | `r` | `-a`, `abs a`, `sqrt a` (NaN for a<0), `a*a`, `sin a`, `cos a`, `floor a` |
| `fract` | `r` | `a - floor(a)` |
| `min` `max` | `r r` | `Math.min`, `Math.max` |
| `atan2` | `r r` | `atan2(args[0], args[1])` (y first) |
| `clamp` | `r r r` | `min(max(v, lo), hi)` |
| `select` | `r r r` | `a if c < 0 else b` (args `[c, a, b]`) |
| `smin_quad` | `r r r` | `k <= 0 ? min(a,b) : min(a,b) - h*h*k/4`, `h = max(k - abs(a-b), 0)/k` |
| `smin_exp` | `r r r` | `k <= 0 ? min(a,b) : m - k*ln(1 + exp(-abs(a-b)/k))`, `m = min(a,b)` |
| `chamfer_min` | `r r r` | `min(min(a,b), (a + b - k) * sqrt(1/2))` |
| `mesh_sdf` | `r r r m` | signed distance of `(x,y,z)` to mesh `m`: unsigned distance to the nearest triangle (closest point on triangle), negative iff the generalised winding number `w > 1/2` (Van Oosterom–Strackee per triangle; BVH nodes whose centroid is farther than `2 * half-diagonal` of their box use the dipole `N.(C-p)/dist^3`, `N` = sum of area-weighted normals, `C` = area-weighted centroid; `w = sum / (4 pi)`). BVH = `buildMeshBvh` (median split on the longest centroid axis, leaf size 8) |
| `strut_set` | `r r r s r?` | signed distance to the beams of set `s` (below); with a radius register `>= 0`, every beam radius is replaced by it and caps are spherical |

Beam distance (document units): local frame `(s, rho)` = (axial coordinate, radial distance) from the axis through nodes `a`,`b` (length `L`). `butt`: signed distance to the trapezoid
`(0,0)-(0,ra)-(L,rb)-(L,0)` in the half plane (negative inside; magnitude = min of the distances to its three non-axis edges); `sphere`: `min(butt, |p-a|-ra, |p-b|-rb)`. A zero-length beam is a ball
of radius `max(ra,rb)`. Periodic sets: `q = p - origin - floor((p-origin)/cell)*cell`; candidate beams = beams of the 27 neighbouring cells whose bounding box meets the cell box grown by
the largest radius; the cell is cut into 4x4x4 buckets and a bucket keeps the beams whose box gap is `<= U + radius spread`, `U` = min over beams of the largest bucket-corner distance (this prefilter only
removes beams that cannot be nearest). Result = min over the bucket's beams. Explicit sets (`periodic: null`) test all beams.

Interval evaluation (`interval.ts`, sound enclosure over an axis-aligned box): `add/sub/mul` standard (`0*inf = 0`), `div` by an interval containing 0 gives `[-inf, inf]`, `sqrt` of a negative
interval gives `[+inf,+inf]`, `sin/cos` exact by critical points (`[-1,1]` when the width is `>= 2 pi`), `atan2` `[-pi, pi]`, `fract` exact inside one integer cell else `[0,1]`, `select` picks a
branch when the condition interval has one sign else the hull, `smin_quad`/`smin_exp` `[min(lo) - kmax/4 (or kmax ln 2), min(hi)]`, `chamfer_min` the interval `min` of `min(a,b)` and
`(a+b-k)/sqrt 2`, `mesh_sdf`/`strut_set` = value at the box centre +- half the box diagonal (1-Lipschitz; with a radius register also widened by its interval).

Gradient (`gradient.ts`): forward-mode duals; `smin_*`/`chamfer_min` also differentiate in `k`; `mesh_sdf`/`strut_set` use central differences of the operand with step `1e-6`.

Compiler conventions (`domain-implicit/src/compile.ts`): frames are registers `(x,y,z)`; a placed shape uses `local = R^T (p - position) / scale` (R from the Euler XYZ image of the unit axes) and `f = scale * f_local`;
primitive SDFs are the closed forms of §5.2 (cone: min distance to base edge and slanted edge, sign from `max(-z, side)`); TPMS use `F` and `|grad F|` in physical units (cell coordinates + per-axis scales
as registers, a `1e-9` floor on `|grad F|`): normalised network `(F - level)/g`, normalised sheet `|F|/g - w/2`, raw sheet `|F| - t`, raw network `F - level`; strut lattices emit one
`strut_set` on the lattice-local frame; clipping to a region is `max(f, f_region)`. Distance quality: primitive / solid / transform `exact`; any `min`/`max`/blend `bound`; offset/shell keep
the source quality (warning `IMP_OFFSET_NOT_EXACT` when it is not `exact`); strut sets `bound` (L = 1); TPMS `approximate` (L = 2 normalised, `2 pi gradBound / a_min` raw).

Engine contract (`engineTypes.ts`): grid `cells_i = max(1, ceil((max_i - min_i)/voxel - 1e-9))`, nodes `cells_i + 1`, node `(i,j,k)` at `min + (i,j,k)*voxel`, index `i + nx*(j + ny*k)`.

- `mesh`: refuses when `nodes > limits.maxSamples` (`IMP_GRID_BUDGET`, before any sample), when the program is malformed (`IMP_ENGINE_FAILED`), when `triangles > maxTriangles`
  (`IMP_TRIANGLE_BUDGET`, after extraction). Tiles of 8 cells are interval-evaluated; a tile whose interval is `< 0` (resp. `> 0`) fills its nodes with `-1e30` (resp. `+1e30`) unsampled; every node of a
  tile that is not proved is evaluated; non-finite values become `+1e30` and are counted; a sampled value with `abs(v) < 1e-3 * voxel` is replaced by `+1e-3 * voxel` (no vertex lands exactly on a node: zero-area triangles and 3MF/STL welds that pinch the shell are avoided; the surface moves by < 1e-3 voxel). Extraction (`lib/isosurface/tetra.ts`): inside iff `value < 0`; cube corner bit0 = +x, bit1 = +y, bit2 = +z;
  the six Kuhn tetrahedra are the corner lists `[0,1,3,7] [0,1,5,7] [0,2,3,7] [0,2,6,7] [0,4,5,7] [0,4,6,7]`; cubes in x-fastest order; a vertex on grid edge `(lo,hi)` (node ids, `lo<hi`) sits at
  `t = (0 - v_lo)/(v_hi - v_lo)` (the two nodes always differ in sign class, so the denominator is non-zero) along it, is welded by the key `lo*nodeCount + hi` (exact below 94e6 nodes) and numbered in order of first use. A tetrahedron with two inside
  nodes `a,b` and two outside nodes `c,d` (each pair in tetrahedron order) emits the triangles `[ac, ad, bd]` then `[ac, bd, bc]`; with one inside (or one outside) node it emits the three edges of
  that apex in order. Winding: a triangle is flipped unless the normal computed from the **edge midpoints** (node units) has a non-negative dot product with `centroid(outside nodes) - centroid(inside nodes)`;
  triangles with two equal vertex indices are dropped. `maxVertexResidual` = max `|f|` at the vertices; `closedManifold` = every directed edge once and its reverse once.
- `measure` `volume`: the box is tiled exactly by `n_i` cells (centre `min_i + (c + 1/2) (max_i - min_i)/n_i`); `lowdiscrepancy` replaces the centres by `u_n,i = frac(1/2 + (n+1) alpha_i)`,
  `alpha_i = phi3^-(i+1)`, `phi3 = 1.2207440846057596`, `n = 0..N-1` (`N` = cell count) scaled to the box; a sample counts whole when `f <= 0` (and `region <= 0` when given); volume =
  count x box volume / N. `quantile`: sorted samples of `f` (or `|f|`) on the midpoint grid, the value at index `min(N-1, floor(p N))`. `components`: node is solid iff `f < 2e-3 * voxel` (closed set: bodies that only touch are one solid; the sampled values are already snapped as above); solids and voids both 14-connected (the edges of the Kuhn tetrahedra: neighbour offsets whose non-zero components share one sign), scan order x fastest; `volume = nodes * voxel^3`; `enclosed` = a void with no node on the grid boundary; the reported `point` is the member node nearest the member centroid.
- Budgets of the TS engine: 2^21 grid nodes (measures: cells), 5 x 10^6 triangles.
- `contentHash` of a body = `sha256(canonicalJson({program, grid: {min, max, voxel}, mesher: 'tetra', engineMajor: 1, engine: engine.name}))` where `grid` is the bounds padded by 2 voxels.

### 13.4 Deviations from §3–§5 (and why)

- `FieldInstruction` has no `k` member and `call` is not an op: smooth minima take the blend radius as a third register operand (a constant today, a field later without a format change).
- `FieldEngine` answers carry `ok: true|false`; a refusal is `{ ok: false, code, message, samples?, limit? }`. `MeshOptions` is `{ mesher: 'tetra', maxTriangles }` (no `refineTolerance`, no dual contouring: V1/V2). The measure requests are `volume | quantile | components` (§5.8 area, EDT wall / pore and overhang are not engine measures yet).
- The id of a body and of its mesh entity are the same (`imp-<step>.<k>`); `ImplicitBody` stores `name`/`color` (needed to rebuild the entity on load) and always the resolved `bounds`; `mesher` is the literal `'tetra'`.
- `field_from_solid` reads the entity's stored triangles (a B-rep result already holds its kernel tessellation) instead of calling `ctx.kernel`, so it needs no kernel and has no `deflection`; `hideSource` lives on `create_implicit_body` (as the pack's plans use it) and moves the sources to the hidden layer `layer-implicit-hidden`.
- Lattice laws are numbers (no field-valued `thickness` / `radius` / blend radius, no scalar fields): graded lattices wait for M5 `create_scalar_field`. TPMS `control` is `{kind:'thickness'|'level', value}` plus `relativeDensityTarget`; `relativeDensity` is inverted by the sample **quantile** of `F`, `|F|` or `|F|/|grad F|` over one cell (64^3 midpoint samples; the exact inverse of the sampled fraction) instead of a bisection. With `normalize: 'none'` the sheet `thickness` is the raw half-width `t` of `{|F| <= t}` in F units.
- Cell maps: only `cylindrical` for TPMS (`cellsAround` integer else `IMP_MAP_SEAM`; replaces `origin`/`rotation`; radial size `radialCellSize`, axial size `cellSize[2]`); strut lattices have no map (they do since 14.13). Relative-density inversion with a map solves on the rectangular cell.
- Strut radius rule: `2 * radius < shortest strut length of the cell` (cubic: the cell edge; bcc 0.866 a; octet 0.707 a), else `IMP_STRUT_RADIUS_RANGE`.
- `implicit_properties.volume` = mesh volume for a body without `region`, else the field quadrature; `volumeQuadrature` is always given. `errorEstimate = |q(h) - q(1.25 h)| + 0.6 (h/rho_min)^2 V` (0.6 is the gate coefficient of §5.11, measured 0.50). Hard-threshold midpoint quadrature has an O(h) error for planar faces that cut cells (e.g. the shell/infill interface of the pack plan at a voxel that does not divide 18 mm, about 2 % at 0.6): the two-resolution estimate exposes it, and the value is exact when faces fall on cell boundaries.
- `check_implicit` MVP: closedness, trapped voids, components (voxel >= the body voxel, ~2^20 nodes), `IMP_CHECK_RESOLUTION_COARSE` (recipe wall / strut < 2 voxels), `IMP_CHECK_MIN_WALL` / `MIN_STRUT` against caller limits using the **declared** sizes (shell thickness, sheet thickness, strut diameter; converted to mm), the non-suppressible `IMP_CHECK_NO_PROCESS_LIMITS` / `IMP_CHECK_INPUT_UNVERIFIED`, `purpose: release` -> `reviewRequired`. Not evaluated (listed in `data.notEvaluated` when asked): pore size, overhang, measured (EDT) wall thickness.
- `lattice_properties` adds `resolution` (16..128 quadrature cells along the smallest cell axis, default 64); `poreDiameterMax` is not computed; `estimateMechanics` is a scaling-law stub: exponent 1 (octet) or 2 (other cells), `coefficient: null`, always `unverified` + `reviewRequired`.
- Meshing error of a sharp, grid-aligned clip (box regions) is larger than the smooth-surface law: the SC cell r = 1 at voxel 0.1 is -1.1 % by mesh (second order: -4.4 % at 0.2) while its field quadrature is -0.07 %; the pack's 0.5 % gate for the mesh needs vertex refinement / dual contouring (V1/V2) or finer native voxels.

- Guards: the mesh of a body is `IMP_DERIVED_READ_ONLY`; the source solids of a body (the `solid` nodes its field depends on) cannot be moved, modified or deleted while the body exists (`IMP_SOURCE_IN_USE`; a layer change is allowed). `check_implicit` reports every requested check it could not evaluate (limit without a declared size, pore size, refused components) in `data.notEvaluated` with the warning `IMP_CHECK_NOT_EVALUATED`, so the status is never `pass` for them.
- `field_from_solid`: distance quality `exact` for planar solids (box, wedge, pyramid, B-rep-less mesh), `bound` for curved / B-rep sources (tessellation deflection is not recorded: `data.deflection` null with a note). `relativeDensity` with a cylindrical `map` is refused (`IMP_PARAM_CONFLICT`: it is solved on a rectangular cell); `lattice_properties` measures the unrotated, unmapped cell. The Lipschitz constant of approximate fields is an estimate (`data.lipschitzIsEstimate`).
- Topology plugin: node values within 1e-3 of the threshold are moved to threshold - 1e-3 before meshing (node values are multiples of 1/8, so 0.5 is common); without it a block gave 120 of 144 zero-area triangles.
- **Closed by §14 (dual contouring, -0.017 % at voxel 0.1). Was: open gap (VC-15 / VC-49, tied to M6 dual contouring):** the 0.5 % mesh gate of the SC cell (-1.1 % at voxel 0.1) is not met by Kuhn marching tetrahedra at sharp box clips; sharp-feature meshing needs dual contouring (V2) or the native engine's finer voxel. The field quadrature meets it (-0.07 %).

### 13.5 Validation results (TS engine)

| VC | Result |
| -- | ------ |
| 01, 02 | sphere / torus / box / capsule at 12 points each: max abs error < 1e-9 (tests compare to `data/sdf_primitives.json`); `abs(grad f) - 1 < 1e-6`; quality `exact` |
| 03, 04 | `data.blend.maxDeviation` 0.25 / 0.693147; numeric `min - smin` = 0.25 / ln 2 to 1e-12; gradient norm <= 1 |
| 05 | smooth corner: tangent points and bisector point abs(f) < 1e-9; V = 1446.667 within 0.1 % (mesh at voxel 0.15; the plan's voxel 0.05 exceeds the TS budget) |
| 06, 07, 09 | shells 2521.65 / 2044.13 mm3 within 0.2 % (voxel 0.2); offset +1.5 exact, `IMP_OFFSET_NOT_EXACT` on blends; scale 2 of R5 = R10 to 1e-12 |
| 08 | `field_from_solid` of a 40 mm box equals the box SDF at 1000 points to 1e-9; open mesh / 2D shape refused |
| 10, 11 | level-0 networks 0.5 +- 1e-4; network / raw sheet / normalised sheet fractions vs the 240^3 tables within 2e-3 (96-128 cells) |
| 12 | `relativeDensity: 0.3`: measured 0.300 +- 0.005 (three forms); the mesh of a 2x2x2 block confirms |
| 13 | normalised walls 1.00 +- 0.08 over 200 surface points; raw gradient ratio = 1.2247 (G), 1.7321 (P), 1.2247 (D) +- 0.02 over 1500 points |
| 14 | specific surface reported = `data/tpms_surface.json` extrapolated values (G 3.0916, P 2.3526, D 3.8380); a mesh block agrees within 1.5 % |
| 15, 49 | SC cell 82.934 mm3: quadrature -0.07 %, mesh -1.1 % at voxel 0.1 (see 13.4) |
| 16, 17 | rho1 = 0.0942478 / 0.2176559 / 0.2665730 / 0.5331460; periodic rho within 0.5 % of the QMC reference; octet 2x2x2 block r 0.5: 911.84 within 0.5 % |
| 19 | Maxwell: octet stretch, others bending (literature class; `M = b - 3j + 6` reported) |
| 20, 21 | sphere R10 closed manifold, error <= 0.6 (h/R)^2 at h = 1, 0.5, 0.25; torus 5/2 <= 0.2 (h/r)^2 at h = 1, 0.5; F6 regressions (141^3 = 2.8e6 nodes, node-exact zero values) pass; topology tests unchanged |
| 22 | shell + gyroid infill: V = 40672 within 0.2 % by quadrature at voxel 0.5 (aligned); mesh within 2 % |
| 25, 40 | cylindrical seam continuous for 6 and 8 cells, `IMP_MAP_SEAM` for 6.5; `target_errors` returns the six expected outcomes in order |
| 30 (counts) | octet 14/63/172 nodes and 36/240/756 beams, cubic 8/27/64 and 12/54/144 (exact for aligned blocks); the 3MF writer itself is M5 |
| 33-36, 42, 43, 47 | trapped void 4/3 pi 8^3 within 1 %; two spheres -> `IMP_DISCONNECTED` (2); wall 0.3 at voxel 0.2 -> `IMP_CHECK_RESOLUTION_COARSE`; limits echoed, never defaulted; release -> `reviewRequired`; unpinned mesh -> `IMP_CHECK_INPUT_UNVERIFIED` + `unverified`; mechanics flagged |
| 39, 46, 48 | `evaluate_field` caps 10 000 points and reports unit / quality; R1000 voxel 0.001 refused in < 100 ms; save/load keeps the mesh (hash equal) and the recipe adds < 20 kB |

Not run on this engine: 18, 24, 26-29 (M5), 31, 32 (M6 / exporter changes), 37, 38 (V1), 41 (the schema snapshot covers the audit), 44, 45 (need the native engine).

### 13.6 Contract for M4 (native `llull-field`)

Implement §13.3 exactly; the TS engine is the oracle (`tests/unit/field/engine.test.ts`, `tests/unit/implicit/*`). Parity targets: program values 1e-12 relative, identical mesh (same vertex and
triangle order) for the same program and grid, identical `contentHash`, same refusals and codes. Job folder = `job.json` (grid, request, program without meshes / strutSets) + little-endian f64 / u32
binary files for `constants`, mesh positions / indices and strut nodes / beams, as `llull-geomq`.

### 13.7 Left for later milestones (all but the items of 14.7 were delivered by DES-5b, see §14)

M4 native crate + host installer + a field-engine line in `kernel_info`; M5 `create_scalar_field`, field-valued laws, `edit_field` / `delete_field` / `regenerate_implicit_bodies`, `infill_solid`, `add_graph_lattice`,
`section_field`, more TPMS / cells, spherical and surface maps, refinement, 3MF beam lattice, `IMP_STEP_NOT_EXACT` in `export_step_ap242`, overhang and EDT wall / pore checks, the `llull guide` implicit
section; M6 3MF implicit export, dual contouring, Voronoi, homogenisation, GPU preview. The pack plans `target_graded_gyroid_column.json` and `target_infill_solid_box.json` stop at their first M5 command and are
the only entries of this pack left in `tests/unit/contract/blockedPlanCommands.json`.

### 13.8 CLI runs of the pack plans (TS engine, `llull run <plan> --doc <scratch> --continue`, 2026-10-23)

| Plan | As written | Voxel coarsened for the 2^21-node TS budget |
| ---- | ---------- | ------------------------------------------- |
| `baseline_sc_unit_cell_cylinders` | 6/6 ok, exact B-rep union 82.934 mm3 | n/a |
| `target_errors` | 1/6 ok by design: `IMP_TPMS_CONTROL_RANGE`, `IMP_STRUT_RADIUS_RANGE`, `IMP_MAP_SEAM`, ok, `IMP_GRID_BUDGET`, `IMP_FIELD_NOT_FOUND` | n/a |
| `target_smooth_union_corner` | 7/9: `create_implicit_body` voxel 0.05 = 33.6e6 nodes -> `IMP_GRID_BUDGET`, then the alias-dependent step fails | voxel 0.15: 9/9, mesh 1445.97 mm3, tangent points 0 |
| `target_sc_strut_lattice_cell` | 7/7 (1.16e6 nodes at voxel 0.1): mesh 82.03, quadrature 82.92 mm3, 8 nodes / 12 beams, `check_implicit` WARN (`IMP_CHECK_NO_PROCESS_LIMITS`) | n/a |
| `target_shell_gyroid_infill` | 7/11: voxel 0.2 = 8.6e6 nodes -> `IMP_GRID_BUDGET` | voxel 0.5: 11/11, 1.09e6 triangles closed manifold, mesh 40610.1 mm3 (-0.15 %), 1 solid, 1 enclosed void, `IMP_TRAPPED_VOID` (the sealed gyroid channels), `export_3mf` ok |
| `target_cylindrical_gyroid_sleeve` | 5/8: voxel 0.2 = 19e6 nodes -> `IMP_GRID_BUDGET` | voxel 0.5: 8/8, closed manifold, density 0.297 of the sleeve region |
| `target_octet_beam_lattice_3mf` | 4/7: voxel 0.05 = 66e6 nodes -> `IMP_GRID_BUDGET` | voxel 0.25: 6/7, 911.5 mm3 (VC-17: 911.84); `export_3mf beamLattice` is refused (`unknown param`, M5) |
| `target_graded_gyroid_column` | 2/9: `create_scalar_field` unknown (M5) | n/a |
| `target_infill_solid_box` | 2/5: `infill_solid` unknown (M5) | n/a |

The pack's voxels need the native engine (M4): the TS engine refuses them before sampling, with the native hint in the remediation.


---

## 14. As built (DES-5b: M4–M6, 2026-10-24)

Delivered: M4 native `llull-field`, M5 (scalar fields, graded laws, lifecycle, infill, graph lattices, sections, more cells and maps, 3MF beam lattice, measured checks, mechanics), M6 (3MF implicit export,
dual contouring, Voronoi lattices). Not delivered: §14.7. D1–D9 stand; the decisions taken here are in §14.6.

### 14.1 Files

| Area | Files |
| ---- | ----- |
| Native crate (M4) | `solver/crates/llull-field/src/{lib,files,tape,eval,interval,meshsdf,struts,sampling,tetra,measure,components,job,jsnum,testkit}.rs` + `tests/job.rs`; `llull-jsmath` gained `trig.rs` (V8-exact `sin`, `cos`, `atan2`; 36 node-generated reference bit patterns in `tests/trig_reference.rs`); `llull-geomq` `MeshTree` fields are public; `llull-compute field <job-folder>` |
| Host (M4) | `server/src/native/fieldEngine.ts` (`createNativeFieldEngine`, `installFieldEngine`, `NATIVE_FIELD_LIMITS`), installed by `server/src/lifecycle.ts` and `server/src/cli/cliProcess.ts` together with the mesh asset store; `kernel_info` reports `data.fieldEngine {name, limits}` |
| Core | `geometry/field/{dualContour,levelSetExport}.ts`, `engineTypes.ts` (`Mesher`, `maxStoredTriangles`, `nodes` measure), `geometry/mesh/assets.ts` (`setMeshAssetPort`), `geometry/{entityCurves,entityPolyline}.ts`, `model/beamLattice.ts`, `commands/exchange/{threeMf,threeMfBeamLattice,threeMfImplicit,export3mf}.ts`, `plugins/{plugin,host}.ts` (hooks `beamLattice`, `levelSet`, `stepSkip`), `lib/isosurface/measures.ts` (sorted-key manifold test) |
| Plugin | `packages/domain-implicit/src/`: `scalar`, `scalarCommand`, `lawRange`, `lawCheck`, `compileTypes`, `compileLattice`, `tpmsHigher`, `graph`, `graphCommand`, `voronoi`, `voronoiCommand`, `editCommand`, `lifecycleCommands`, `rederive`, `infillCommand`, `sectionCommand`, `contour`, `edt`, `wallChecks`, `overhang`, `mechanics`, `latticeFacts`, `beamLattice`, `levelSet`, `bodyMesh` |
| Schemas and data | `validation/data/3mf/{implicit.xsd,volumetric.xsd,Validate.java,README.md}` (pinned, sha256 `e88ce8d5...`); `server/tests/threeMfImplicit.test.ts` validates with the JDK, `server/tests/fieldNative.test.ts` is the parity suite |

### 14.2 Commands (21 in the plugin; 8 new, 8 changed)

New: `create_scalar_field`, `edit_field`, `delete_field`, `regenerate_implicit_bodies`, `add_graph_lattice`, `add_voronoi_lattice`, `infill_solid`, `section_field`. Changed: `add_tpms_lattice` (8 families, laws, spherical map),
`add_strut_lattice` (9 cells, laws), `combine_fields` / `offset_field` / `shell_field` (laws), `create_implicit_body` (`mesher`, mesh asset store), `lattice_properties` (measured wall / pore, dangling struts, mechanics),
`check_implicit` (measured walls, pores, overhang with `buildDirection` / `criticalAngleDeg`), `export_3mf` (`beamLattice`, `beamRepresentation`, `implicit: 'levelset'`), `export_step_ap242` (lists implicit bodies as skipped with
`IMP_STEP_NOT_EXACT`), `kernel_info` (field engine line). New codes: `IMP_FIELD_CYCLE`, `IMP_GRAPH_EMPTY`, `IMP_GRAPH_TOO_LARGE`, `IMP_CHECK_OVERHANG`, `IMP_CHECK_MIN_PORE`, `IMP_STEP_NOT_EXACT`,
`EXPORT_MESH_TOO_LARGE` (core).

### 14.3 Native engine (M4) and parity

The crate evaluates the §13.3 tape on a voxel grid (plane by plane, interval-pruned 8-cell tiles), contours it with marching tetrahedra in the same scan order as the TS engine, and answers `evaluate`, `mesh` and `measure`
(volume, quantile, components, nodes). Bit-exact parity holds because the Rust side reproduces V8's `sin`, `cos`, `atan2`, `exp`, `log`, `hypot`, `pow` and the NaN-propagating JS `min` / `max`
(`llull-jsmath`, checked against 4000 random values and 36 node-generated bit patterns). `server/tests/fieldNative.test.ts` (the parity suite): on seven fields (smooth blends, clipped gyroid, diamond, octet, solid-sourced, shell)
the native mesh equals the TS mesh vertex for vertex and triangle for triangle, `contentHash` inputs, volumes, quadratures and quantiles are equal, `lattice_properties` / `check_implicit` agree, and refusals carry the same codes. Budgets:
2^30 samples, 5 000 000 triangles inline, 20 000 000 when the host holds a mesh asset store (`maxStoredTriangles`); a failed native job falls back to the TS engine when the grid is below its cap, else is refused with
`IMP_ENGINE_FAILED` and the named cause. Malformed programs are delegated to the TS engine (gradients and dual contouring run natively since 14.10). Rust: `cargo fmt --check`, `clippy -D warnings`, 24 unit + 6 job tests + the trig reference.

Measured (CLI, this machine): smooth union corner 33.6e6 samples -> 3.45e6 triangles 2.3 s; octet block 66.4e6 samples -> 13.6e6 triangles 15.8 s; shell + gyroid 8.6e6 samples -> 6.87e6 triangles 6.3 s; sleeve 19.1e6 samples -> 9.14e6
triangles 7.2 s; graded column 4.5e6 samples -> 2.47e6 triangles 1.7 s. The TS engine refuses all of them before sampling (`IMP_GRID_BUDGET`).

### 14.4 Validation results (M4-M6)

| VC | Result against tolerance |
| -- | ------------------------ |
| 05 | smooth corner at the written voxel 0.05 (native): 1446.49 mm3 vs 1446.667, -0.012 % (tol 0.1 %); the `evaluate_field` step of the plan runs |
| 15, 49 | SC cell 82.934 mm3: tetrahedra -1.12 % at voxel 0.1 (-4.45 % at 0.2); **dual contouring -0.017 % at 0.1 and -0.175 % at 0.2** (tol 0.5 % mesh, met; the gap noted in §13.4 is closed); quadrature -0.07 % |
| 17 | octet 2x2x2 block r 0.5 at voxel 0.05 (13.6e6 triangles, native): mesh 910.15 mm3, region quadrature 911.48 vs 911.84 (-0.04 %, tol 0.5 %) |
| 22 | shell + gyroid infill at the written voxel 0.2: mesh 40659.9 mm3 vs 40672, -0.03 % (tol 0.2 %); 1 solid, 1 enclosed void (`IMP_TRAPPED_VOID`) |
| 23 | `infill_solid` 40 mm box, wall 2, gyroid network: 40659.9 mm3 at voxel 0.2 (-0.03 %, tol 0.2 %); 6.87e6 triangles stored as an asset; 36.5 % lighter |
| 24 | graded gyroid column: relative density 0.404266 vs 0.4043801 (|d| 1.1e-4, tol 5e-3); wall min / max 0.5 / 2.5 (tol 0.02) |
| 26 | graph lattice, 10 mm beam r 1 -> 0.5, butt: quadrature 18.3229 vs 18.32596 mm3, -0.016 % (tol 0.2 %) |
| 27 | Neovius 0.5000, Fischer-Koch S 0.5000, IWP 0.4708 (table 0.4693), Lidinoid 0.3848 (0.3842), Split P 0.5110 (0.51) at resolution 64 (tol 2e-3 symmetric / 5e-3 measured) |
| 28 | noise nodes with equal seeds are equal (hash without sine; bitwise equal on both engines) |
| 30 | octet 2x2x2: 63 nodes, 240 beams, beam-lattice + balls namespaces; the file of the pack plan is 856 kB (clipping mesh cut by dual contouring on 32 cells) |
| 31 | five generated implicit functions (quadratic, exponential and chamfer blends, gyroid sheet, shell of a solid with a `mesh` operand) validate against the pinned `implicit.xsd` (Xerces via the JDK) |
| 32 | `export_step_ap242` lists implicit bodies as skipped with `IMP_STEP_NOT_EXACT` |
| 37 | overhang of a sphere R10, +Z, 45 deg: 184.99 vs 184.03 mm2 (+0.52 %, tol 1 %) at voxel 0.25 |
| 38 | sphere section area 314.157 vs 314.159 mm2 (-0.001 %, tol 0.2 %); gyroid section solid fraction 0.5000000 |
| 47 | mechanics: octet affine E/Es = rho/9 to 1e-9; always `unverified` + `reviewRequired`; Gibson-Ashby coefficient only from the caller |
| 50 | Voronoi lattice: same (box, density, seed) gives identical nodes and beams; another seed differs; every node inside the box |

Thickness (EDT) accuracy: the feature transform is exact, the medial-axis read-out is within +-2.5 voxels (plate 1.75 exact, tube wall +-2 voxels, spherical shell +-2.5 voxels, solid cube +-2 voxels); `check_implicit` compares a limit with the
measured wall plus that band and says so in the finding.

### 14.5 CLI runs of the pack plans (`llull --doc <file> run <plan> --continue` from the pack folder, native engine, 2026-10-24)

| Plan | Result |
| ---- | ------ |
| `baseline_sc_unit_cell_cylinders` | 6/6, exact B-rep union 82.934 mm3 |
| `target_errors` | 1/6 ok by design; the five refusals are `IMP_TPMS_CONTROL_RANGE`, `IMP_STRUT_RADIUS_RANGE`, `IMP_MAP_SEAM`, `IMP_GRID_BUDGET`, `IMP_FIELD_NOT_FOUND` |
| `target_smooth_union_corner` | 9/9 at the written voxel 0.05, 1446.49 mm3, 3.45e6 triangles |
| `target_sc_strut_lattice_cell` | 7/7 at voxel 0.1: mesh 82.008, quadrature 82.922 mm3, native engine |
| `target_shell_gyroid_infill` | 11/11 at the written voxel 0.2; the last step `export_3mf` of a 6.87e6-triangle mesh streams into a 111 MB deflated package in 12.7 s (see 14.6) |
| `target_cylindrical_gyroid_sleeve` | 8/8 at voxel 0.2, 9.14e6 triangles, density 0.2972 of the sleeve region |
| `target_octet_beam_lattice_3mf` | 7/7 at the written voxel 0.05 (13.6e6 triangles), `export_3mf beamLattice` writes 63 nodes / 240 beams (856 kB) |
| `target_graded_gyroid_column` | 9/9, density 0.4043, `check_implicit` FAIL `IMP_DISCONNECTED` (3 components: the clipped sheet leaves two thin fragments at the column corners; reported, not a plan assertion) |
| `target_infill_solid_box` | 5/5, 40659.9 mm3, `check_implicit` FAIL `IMP_TRAPPED_VOID` (sealed gyroid channels; add `drainHoles`) |

### 14.6 Decisions and deviations

- **Interior sign of a 3MF level set (D7).** Neither the 3MF volumetric text (pinned sha256 `e88ce8d5...`) nor the XSD states it. llull writes the function negative inside, as the specification's own `mesh` and `beamlattice` distance nodes
  are; recorded in the writer's `@invariant` and in `export_3mf` `implicit`.
- **`<i:sqrt>` is written as `<i:pow A 0.5>`**: the pinned XSD declares two inputs on `sqrt` against its own documentation, so a conforming `sqrt` would not validate.
- **Level-set export covers field programs without strut sets.** Strut and graph lattices stay beam lattices or meshes (`data.implicit.skipped` names the reason); a body built on solids needs a millimetre document (the operand meshes are written in millimetres).
- **Dual contouring** (`mesher: 'dual_contouring'`): one QEF vertex per crossed cell (pseudo-inverse, singular values below 0.1 of the largest dropped, mass-point regularisation, vertex clamped to its cell), edge crossings refined by 8 bisections on the exact
  field, normals from the exact gradient, one quad per crossed edge split on the shorter diagonal. The result is checked closed and edge-manifold; otherwise the tetrahedra are used and `data.mesherFallback` says so. The native engine meshes it too (14.10),
  bit-identical to the TS mesher, up to 2^29 grid nodes (the TS engine: 2^21). The mesher is part of the content hash.
- **Mesh asset store (D3 host cache)** adopted for bodies above 100 000 triangles: the entity keeps a 50 000-triangle level of detail, the body record keeps the asset key; load reads the store, else re-derives. `fullBodyMesh` serves the properties and checks.
- **Beam-lattice clipping meshes** are cut from the region by dual contouring on at most 32 cells along the longest side, independent of the body voxel (a 0.05 voxel over 20 mm wrote 8.3 MB of coplanar triangles and ran out of memory).
- **`export_3mf` of large meshes** (review fix): an indexed mesh above 250 000 triangles is written straight from its arrays in batches into a streaming DEFLATE encoder (`lib/deflateStream.ts`, fixed Huffman + one-candidate LZ77, verified against zlib) and a chunked ZIP (`zipChunked`); smaller meshes are stored byte for byte as before. The in-memory package still travels as one base64 string (a host file sink lifts this, 14.12), which caps the deflated model part at 375 000 000 bytes (V8 strings stop near 536 million characters): about 8 million triangles of a gyroid-like mesh. Above that, and for a non-indexed body over 2 000 000 triangles, the command answers `EXPORT_MESH_TOO_LARGE`. The 6.87M-triangle body of the shell + gyroid plan therefore exports. The triangle lists of asset-backed parts are built lazily, so beam-lattice and level-set exports never materialise them.
- **Content hash and engines.** The hash covers the program, grid, mesher, engine major version and a determinism class (`FieldEngine.determinism`, default `js-ieee754-v8`), not the engine name: the TS and native engines are bit-identical, so a document made by the CLI is current in the renderer and a load does not rewrite the hash. `ImplicitBody.engine` records the engine that really produced the mesh (a native job that fell back to TS is recorded as `ts`).
- **Trigonometry bound.** `llull-jsmath` reproduces V8 `sin`/`cos` for |x| < 2^19 pi / 2; beyond it the platform libm answers and a flag is raised. A native job that raised it ends with `NATIVE_UNSUPPORTED_ARGUMENT` and the host answers with the TS engine (or refuses above its cap), so the native engine never returns a value without V8 parity. Parity is checked on a checked-in corpus of 4000 node-generated points (`tests/data/trig_corpus.txt`) and on 3000 random points per field in `server/tests/fieldNative.test.ts`.
- **Engine failure is not NaN.** A native `evaluate` that fails above the TS cap returns `FieldSamples.failure`; `evaluate_field`, `section_field` and the lattice code answer `IMP_ENGINE_FAILED`.
- **Host without the mesh asset store.** A stored body this host cannot hold or realise at its voxel keeps a coarse display mesh (the field at 2 to 16 times the voxel) with its asset reference, and `afterLoad` reports `IMP_ASSET_MISSING`; measurements and exports refuse until the store is loaded. Only a body that cannot be realised at all is dropped (`IMP_BODY_STALE`). A body that reads a coarsely shown body through a solid, distance or graph node is not realised from the proxy either: it stays unrealised with its record and hash untouched, `afterLoad` reports `IMP_BODY_STALE`, and `implicit_properties` / `check_implicit` refuse it with the same code; loading with the store restores both. Streamed 3MF meshes are written unwelded (manifold is computed on the written triangles), an index outside the vertices is refused with `EXPORT_MESH_INVALID`, and `export_3mf` takes `maxBytes` to lower the 375 MB cap.
- **Beam Lattice schemas** (`beamlattice.xsd`, `beamlattice-balls.xsd`, Appendix B of the extension document, only the network import removed) are pinned beside `implicit.xsd`; the JDK-gated test validates the `b:beamlattice` of a strut export with and without a representation mesh.
- **Manifold test** (`isClosedManifold`) sorts packed edge keys in a typed array instead of a `Map` (a 6.9e6-triangle body has 20e6 edges, above the 2^24 entries of a `Map`).
- **Voronoi** (`add_voronoi_lattice`): seeds from a mulberry32 generator over the region box grown by 1.2 mean spacings, Bowyer-Watson Delaunay tetrahedralisation, one beam per shared face, cut to the box; at most 6000 seeds (about 9 beams per seed, 55000 beams; it was 700 seeds and 5000 beams, see 14.9).
  Constant radius only. The explicit-set distance goes through a BVH (14.9), so a 20 mm cube at 0.04 seeds/mm3 (787 seeds, 4769 beams) realises in 0.7 s natively; the Delaunay pass, quadratic in the seeds, is now the limit.
- **Reentrant cell** is llull's own definition (the eight corners and six face nodes pushed a quarter cell inward, each face node bonded to the 4 corners of its face: 24 struts), not a catalogue lattice; **mechanics** are the affine stretch-only stiffness (exact for the octet) plus a Gibson-Ashby law whose coefficient the caller supplies.
- Tolerance changes: none. VC-IMP-15's mesh gate (0.5 %) is met by dual contouring and not by the default tetrahedra; `create_implicit_body` keeps `tetra` as the default because it is always manifold.

### 14.7 Not built

numerical homogenisation on `llull-voxfe`; shipped Gibson-Ashby coefficients;
GPU preview.

### 14.8 A plain field over a coarsely shown body (DES-5c, 2026-10-30)

The open item "a plain field reading a body restored as a coarse proxy still evaluates the proxy" was closed by the reach of 07 MSH 13.11: every command
that reads mesh triangles reaches the bodies a field reads, so `evaluate_field`, `section_field` and `implicit_properties` on such a field answer with the
warning `MESH_ASSET_LOD_ONLY` naming the body (the rule of every read-only query in llull), and `create_implicit_body` from it refuses with that code. Decision:
keep the one cross-command rule rather than an implicit-only refusal. Locked by `tests/unit/implicit/lifecycle.test.ts` ("a stored body this host can only show coarsely").

### 14.9 BVH for explicit strut sets (DES-5c, 2026-10-30)

**Code.** `packages/core/src/geometry/field/strutBvh.ts` (TS) and `solver/crates/llull-field/src/strut_bvh.rs` (Rust twin) build a bounding-volume hierarchy once per explicit (non periodic) strut set in
`prepareStrutSet` / `StrutEval::new` (sets of 32 beams or more; periodic sets keep their bucket prefilter). `distanceToSegments` / `distance_to_segments` is unchanged and stays the reference.
Median split by centroid on the widest axis (sort key a total order: NaN after every number and equal to itself, then beam index, because Rust `sort_by` panics otherwise on a NaN node), leaves of 4 beams, nearer child first. Graph lattices and Voronoi lattices are the users.

**Decision.** The engines are bit-identical (`Math.hypot` twin, operation order), so the BVH only decides which beams are NOT evaluated; every evaluated beam runs the unchanged arithmetic.

- Skip rule: a node is skipped only when `bound > best` (strict), `bound = dist(p, AABB of the axis segments) - r - slack`, `r = max(|ra|, |rb|)` over the node (the override `radius` when it is >= 0).
- Proof that the bound is below the signed distance of every beam: in the beam frame the point is (s, rho) and the axis is [0, L] x {0}. Inside the frustum the value is `-edge >= rho - r(s) >= rho - r` (the slant edge is at most r(s) - rho away); outside, every point of the three tested edges lies within |rho| <= r of the axis, so by the triangle inequality `edge >= dist(p, axis) - r`; the sphere caps and the zero-length ball are `hypot - r` to a point of the axis; the override branch is `dist(p, axis) - radius`. The AABB contains the axis, so its distance is at most `dist(p, axis)`. (The signed distance is negative inside a beam, so the AABB distance alone would NOT be a bound: the radius term is what makes it one.)
- Rounding: the brute loop computes `rho = sqrt(|p|^2 - s^2)`, which cancels to an error of about 3e-8 |p| near an axis. The slack is `1e-6 (max|p_i| + max|coordinate of the set| + r)`, thirty times that; the radius term covers the butt edge error (about eps r) when r is much larger than the coordinates. A node holding a non finite coordinate or a beam shorter than 1e-100 (where `s = dot / length` loses precision) is never skipped; a NaN or overflowing bound never skips (`NaN > best` is false), so a NaN point still returns what the brute loop returns.
- Order independence: the result is a minimum of exact per-beam values; every skipped beam is strictly greater than the final best, so it can neither be the minimum nor tie with it. Ties among evaluated beams go to the lowest beam index (`d < best || (d === best && index < bestIndex)`), which reproduces the brute loop, whose first beam wins under `<`; this matters only for 0 against -0 (a point on the boundary of a butt beam gives -0, on a sphere cap +0). NaN values are never taken, as in the brute loop.
- Caps (named): `MAX_GRAPH_BEAMS` 5000 -> 100000 (`graph.ts`); Voronoi `MAX_SEEDS` 700 -> 6000 (10000 since 14.14; `voronoi.ts`; its beam check only guards `MAX_GRAPH_BEAMS`, which 6000 seeds (55000 beams) do not reach). Both refuse with `IMP_GRAPH_TOO_LARGE`. The Voronoi limit is the Bowyer-Watson pass (TS only, quadratic: 6000 seeds 9-12 s, 10000 seeds 32-43 s), not the field.
- Side fix: `compileLattice` spread all beam radii into `Math.min(...)` and overflowed the stack above about 60000 beams; it reduces now.

**Measured** (voxel 0.3 unless noted; body = `create_implicit_body`, add = building the beams, always on the TS side; Windows, release native, two other lanes running so times are indicative). Graph: serpentine polylines in a plane, radius 0.25, chord 0.3, pitch 0.9. Voronoi: cubes at 0.04 seeds/mm3, radius 0.3.

| case | beams | native BVH | native brute | TS BVH | TS brute |
| --- | --- | --- | --- | --- | --- |
| graph 37 mm | 5166 | 0.40 s | 6.66 s (16x) | 1.22 s | 169 s (138x) |
| Voronoi 20 mm cube | 4769 | 0.72 s | 23.7 s (33x) | 3.63 s | 448 s (123x) |
| Voronoi 28 mm | 12825 | 1.52 s | 155.6 s (102x) | 11.3 s | - |
| graph 75 mm | 21000 | 0.80 s | 100 s (125x) | 4.3 s | - |
| Voronoi 40 mm | 36547 | 5.3 s (add 2.7 s) | - | over the TS grid budget (2.7e6 nodes) | - |
| graph 120 mm | 53600 | 1.8 s (add 1.1 s) | - | 9.2 s | - |
| Voronoi 46 mm, voxel 0.4 | 55029 | 10.4 s (add 12.2 s) | - | 37 s (add 9.0 s) | - |
| graph 170 mm | 107163 | 4.0 s (add 2.9 s) | - | over the TS grid budget | - |
| Voronoi 56 mm, voxel 0.4 | 98187 | add 32-43 s, then `IMP_TRIANGLE_BUDGET` | - | add 43 s, then `IMP_GRID_BUDGET` | - |

The old 5000 beam case is 16x (graph) and 33x (Voronoi) faster natively and two orders of magnitude faster on the TS engine. The caps sit where realise stays under about 10 s natively at the default voxel: graph 107000 beams in 4 s (the cap is a safety limit), Voronoi limited by the Delaunay pass.

**Tests.** `tests/unit/field/strutBvh.test.ts`: bit-identical to the brute loop on a random 300 beam set (about 1700 points inside beams, on caps, far away, with the radius override), NaN points, NaN / infinite / 1e-120 beams, 0 against -0 in both beam orders, the bound never above the true value (single beam sets, with and without override). `strut_bvh.rs` repeats the first three on the Rust twin and the empty set. Red without the fix: removing the tie rule fails the 0 / -0 tests (TS and Rust); shifting the bound by +0.5 fails the bit-identity and bound tests (TS and Rust). `tests/unit/implicit/gaps6.test.ts` (the 20 mm cube builds; a box above 6000 seeds is refused by name) and `lattices5.test.ts` (a 12566 beam ring builds and evaluates; 251000 beams are refused). TS to Rust parity: the existing `server/tests/fieldNative.test.ts`; the content hashes of existing bodies are unchanged (implicit lifecycle and golden suites).

**Left.** (The Delaunay pass is near-linear since 14.14.) A BVH inside the buckets of periodic sets with many beams per cell; a native Voronoi builder.

### 14.10 Native gradient, native dual contouring, per-cell fallback (DES-5c, 2026-10-30)

**Native gradient.** `solver/crates/llull-field/src/gradient.rs` is the twin of `gradient.ts` (forward-mode value + d/dx, d/dy, d/dz per register, same formulas, same operation order, V8-exact `sin` / `cos` / `atan2` / `exp`, central differences of 1e-6 for `mesh_sdf` / `strut_set`). The job `evaluate` takes `gradient: true` and writes `gradients.f64` beside `values.f64`; the host (`fieldEngine.ts`) no longer sends `withGradient` requests to the TS engine. `evaluate_field gradient: true` and the dual-contouring normals therefore run natively. Tests: `server/tests/fieldNative.test.ts` compares value and gradient with `Object.is` for every field of the pack scene and a Voronoi set (strut BVH), and for each of the 20 arithmetic ops over a 729 point grid with degenerate points (`sqrt` at 0, `abs` and `clamp` on both sides, `smin` with k <= 0 and wide blends); `gradient.rs` has two unit tests. Red: swapping two components of the `fract` gradient in Rust fails the op sweep.

**Native dual contouring.** `dual_contour.rs` is the twin of `dualContour.ts`: sign grid (one byte per node, from the interval-pruned planes after the zero snap), the three edge scans in the TS order, 8 bisections on the exact field, the exact gradient normal, the 3x3 Jacobi eigen-decomposition and pseudo-inverse (eigenvalues below 0.1 of the largest dropped), mass-point regularisation, clamp to the cell, quads split on the shorter diagonal. The order of every floating-point operation is the TS one, so the mesh is identical vertex for vertex and triangle for triangle, and the content hash (which covers the mesher, the dual-contouring revision for that mesher, and not the engine) is the same on both engines. Rayon parallelises only pure per-edge and per-cell work (Hermite datum, QEF vertex); vertex numbering follows the sequential scan of the quads. A mesh that is not a closed edge-manifold falls back to the whole-body tetrahedra (replaced by the per-cell repair below); the job answers `mesher` and `mesherFallback`.
- Cap: `NATIVE_DUAL_CONTOURING_MAX_SAMPLES` = 2^29 grid nodes (`fieldEngine.ts`; the sign grid is 512 MB at the cap; above it the job refuses with `IMP_GRID_BUDGET` before sampling and names the limit). The TS engine keeps 2^21. The triangle budget is checked before anything is stored: a parallel pass over the sign grid counts the crossed edges (two triangles each, exactly the number the TS mesher refuses with), so a body over budget is refused without allocating its quads (a dense lattice near the cap would otherwise need tens of GB at 40 bytes a quad); the quads are then stored as their 8 byte edge key only, and the sign grid is dropped before a tetrahedra fallback. The refusal at the cap names dual contouring and the remedy (mesher tetra or a coarser voxel). The sign-grid pass reports progress per layer.
- Tests: `fieldNative.test.ts` runs `create_implicit_body mesher: dual_contouring` on both engines for the 7 scene fields, a sharp box minus sphere and a Voronoi set and compares positions (`Object.is`), indices, content hash, `mesher`, `mesherFallback`, figures; the set contains a body that stays dual contouring and one that falls back, and the cap refusal. Red: 7 instead of 8 bisections, or a singular ratio of 0.3, fails the parity test. `dual_contour.rs`: sphere closed and on the surface, cube corners kept, budget count, tiny grid.

**Measured** (sphere r = 10 and a gyroid sheet in a 20 mm cube, `create_implicit_body`, maxTriangles 20e6, release build, shared machine):

| grid nodes | body | TS dual contouring | native dual contouring | native tetra |
| --- | --- | --- | --- | --- |
| 1.0e6 | sphere | 965 ms | 236 ms | 233 ms |
| 2.0e6 (TS cap) | sphere | 1494 ms | 172 ms | 296 ms |
| 1.0e6 | gyroid, 1.8M triangles | 11.9 s | 1.17 s | not run |
| 2.0e6 | gyroid, 3.0M triangles | 20.3 s | 1.81 s | not run |
| 9.9e6 | sphere | over the TS cap | 375 ms | 681 ms |
| 9.9e6 | gyroid, 9.1M triangles | over the TS cap | 6.5 s | not run |
| 1.0e8 | sphere, 2.0M triangles | over the TS cap | 1.6 s | 3.7 s |
| 5.1e8 | sphere, 6.0M triangles | over the TS cap | 5.7 s | 16.4 s |

Native dual contouring is 4x to 17x faster than the TS mesher and 2.5x to 3x faster than the native tetrahedra (it makes a third of the triangles).

**Per-cell repair instead of the whole-body fallback (a change of results).** A dual-contouring mesh is not an edge-manifold when a cell face is ambiguous (its four edges are crossed: two diagonal corners inside): the mesh edge between the two cells that share the face is used by four quads. Before, any such face sent the whole body to the tetrahedra (a lattice of struts at an octet node, two bodies touching along an edge). Now the cells at ambiguous faces get one vertex per surface sheet (manifold dual contouring, Schaefer, Ju and Warren 2007, applied only to those cells), in both engines:
- A cell is split only if one of its six faces is ambiguous. Its crossed edges are grouped by the faces: a face with two crossings joins them, an ambiguous face cuts off its outside corners (a rule of the four signs of the face, so the two cells that share it agree and the four quads of the face pair up). Each group (sheet) gets its own QEF vertex from its own Hermite data; the quad of a crossed edge uses, in each of its four cells, the vertex of the sheet that holds the edge. Vertices are numbered by first use in the same scan.
- A body that dual contouring meshed cleanly has no ambiguous face (an ambiguous face makes four quads share an edge, so it was never a closed manifold), hence no split cell and a mesh byte for byte as before. Locked by pinned FNV hashes of three bodies made before the change (a sharp box minus a sphere, a sphere, a gyroid sheet) and by every existing dual-contouring figure (SC cell -0.017 %).
- The result is still checked: when it is not a closed edge-manifold even after the repair (a Voronoi set with beams thinner than the voxel does this) the whole body falls back to the tetrahedra as before, `mesherFallback` true. `data.dualContouringSplitCells` of `create_implicit_body` (`FieldMeshResult.splitCells`) counts the split cells.
- The bodies that used to fall back change from tetra to dual_contouring (their mesh and volume change, and their hash with the revision above; stored bodies re-derive on load, no compatibility is kept). The octet lattice of the pack scene (cell 6, radius 0.4, 12 mm cube) at voxel 0.25: 2400 split cells, 72 852 triangles, closed manifold, volume 332.9 mm3 against 330.3 from quadrature (+0.8 %); the whole-body tetrahedra gave 302.0 mm3 (-8.5 %) with 200 376 triangles. At voxel 0.2: 1536 split cells, 336.1 (+1.7 %) against 312.4 (-5.4 %). The vertices of a repaired mesh sit off the surface by a fraction of a voxel (mean |f| 0.018 mm at voxel 0.25, the tetrahedra 0.0075 mm, whose vertices lie on edge crossings): "closer to the field" is the volume and the sharp features, not the vertex residual.
- **Content hash decision (owner policy: quality first, no backward compatibility).** The hash of a body covers the requested mesher, so the bodies that used to fall back would have changed their mesh under an unchanged hash (`isStale` would say fresh, and a PLM-released document would re-derive different geometry silently). The hash input of the mesher `dual_contouring` now carries `dualContouringRevision: 2` (`realise.ts`); the `tetra` hash is byte-identical (pinned). Every dual-contouring body therefore re-derives once on load, a clean one to the same mesh and a repaired one to its new mesh, and a released document sees the change through its hash instead of silently. Locked by `tests/unit/implicit/bodies.test.ts` (tetra hash pinned, dual-contouring hash changed, a body stored with the old dual-contouring hash is re-derived on load). Bump the revision whenever the dual-contouring mesh of an unchanged field changes.
- A marching-tetrahedra patch of only the offending cells was considered and rejected: the tetrahedra put vertices on grid edges and dual contouring puts them inside cells, so the two meshes have no common boundary to stitch without a transition layer.
- Tests: `tests/unit/field/dualContourRepair.test.ts` (pinned clean bodies; octet closed, 5x closer in volume than the tetrahedra; two boxes sharing an edge; a Voronoi body that still falls back as a whole), `server/tests/fieldNative.test.ts` (TS and native bit-identical on the repaired octet and on the fallback), `dual_contour.rs` (two boxes sharing an edge). Red: forcing `cellSheets` / `cell_sheets` to answer "no ambiguous face" fails the repair tests in TS, the Rust unit test and the TS to native parity (the native engine then falls back where the TS engine repairs). The direction of the face rule is pinned without the native binary: `dual_contour.rs` runs all 256 corner sign patterns (sheets exist exactly when a face has four crossings; the mirror cell across an ambiguous face pairs the same physical edges) and checks that two inside corners on a face diagonal are one sheet, and `dualContourRepair.test.ts` pins 5 split cells, 384 triangles, 194 vertices for two boxes sharing an edge (the opposite rule gives 196 vertices); flipping the rule fails both. Clean dual-contouring bodies assert `splitCells` 0 (`dualContour.test.ts`, `m6.test.ts`). `llull-field/tests/job.rs` covers the gradient job, the dual-contouring report fields, the whole-body fallback, the cap refusal and the triangle refusal.

**Left.** Dual-contouring vertices for cells with several sheets but no ambiguous face (a pinched vertex that is still edge-manifold) are kept as before; a native Voronoi builder and a faster Delaunay pass stay as in 14.9.

### 14.11 Scalar fields from analysis results: `topology_density` and `fea_result` (DES-5c, 2026-10-30; VC-IMP-29)

**What.** `create_scalar_field` takes two more kinds: `topology_density` (`studyId`) reads the recorded density of a topology study (plugin `topology`, `record_topology_result`), `fea_result` (`caseId`, `quantity` von_mises | u_mag, `step?`) reads a result of an analysis case (plugin `cae`) on its recorded tetrahedral mesh. The scalar grades a lattice (radius, thickness, level) like any other law: `ramp` it from density 0..1 to a radius range, then pass the id as `radius` of `add_strut_lattice`.

**Architecture (L10).** A field node never imports a plugin. The node holds only the reference (`studyId`, `caseId`). `sampledInputs.ts` reads the document data contract of `@core/model` (`doc.analysis.cases[..].topology[..].result.fieldHash`, `results.resultsHash`, `meshSummary.meshHash`) and the artifacts through the injected core port `ExecutionContext.feaArtifacts`; the three recorded types it needs (`FeTopologyArtifact`, `FeMeshArtifact`, `FeResultsArtifact`) are core types. The compiler has no context, so the port is resolved like the field engine and the mesh asset port: the port of the running command or hook (`catalog.ts` wraps every command, `plugin.ts` the `beamLattice` and `levelSet` hooks, in `withArtifacts(ctx.feaArtifacts, ...)`: the port of one synchronous run), else the store the host installed (`installArtifactPort`, called by the server and the CLI at start-up next to `setMeshAssetPort`; read by the load-time re-derivation, which has no context). Explicit threading of the port through the 22 compile call sites was not done: the two-level resolution is the existing pattern, and `export_3mf` beam lattices and level sets of a density-graded body are tested. Without a store (or with a study / case that has no verified result, or an artifact the store does not hold) the compile fails by name, `IMP_INPUT_NOT_FOUND`; a mesh above 500 000 tetrahedra is `IMP_INPUT_TOO_LARGE`.

**Tape.** One new op, `sample_field(x, y, z, f)`, with the operand table `FieldProgram.sampled` (absent when empty, so every existing program and hash is unchanged):
- grid (`topology_density`): the density is the recorded `xPhys` mirror-averaged across the symmetry planes of the study (`symmetrise`, moved to `@core/model/topologyGrid` and shared with the topology plugin, as it derives its geometry and rebuilds), cell-centred (value i at origin + (i + 1/2) voxel, the layout of the topology artifact), read by trilinear interpolation, edge voxels held outside (nearest). A 2D study on XZ or YZ is permuted to world axes (`axesOfGrid`); its single out-of-plane layer is held.
- tets (`fea_result`): node values on the corner nodes of C3D4 / C3D10 elements, in document units of length; barycentric blend in the first tetrahedron (lowest index, bucket grid of at most 64^3 cells) that contains the point with a tolerance of 1e-9, the value of the nearest node outside (lowest index on a tie). The stress / displacement stay in the analysis unit system (`fea_result` is a raw field, the description says so); von Mises and |u| are computed at the nodes.
- Interval: the data range; every sample is clamped to it in both engines (the 1e-9 tolerance of the point location and rounding could leave it by an ulp, and the pruner relies on the interval); gradient: central differences of the sample (step 1e-6) like `mesh_sdf`. A non finite coordinate gives NaN.
- Both engines are bit-identical: only + - * / floor and comparisons, `cbrt` through `llull-jsmath`. Native: `solver/crates/llull-field/src/sampled.rs`, job files `sampled<i>_values.f64` (+ `_points.f64`, `_tets.u32`).

**Staleness and identity.** The data travels in the program, but the content hash takes its identity (`SampledField.source`: the artifact hashes, the symmetry, quantity, step and unit factor; the artifacts are content-addressed) and not its numbers, so hashing a body costs nothing in the size of the result: re-recording a study or re-solving a case changes the identity and the bodies built on the field are re-derived by `regenerate_implicit_bodies` (tested). On load the omitted meshes are re-derived with the installed artifact store (a body on a density-graded lattice round-trips with its record intact, tested); without a store the body stays unrealised and `afterLoad` reports `IMP_INPUT_NOT_FOUND` by name (not the generic `IMP_BODY_STALE`), and `regenerate_implicit_bodies` realises it in place once a store is available.

**Tests.** `tests/unit/field/sampled.test.ts` (interpolation, ranges, validation, gradient); `tests/unit/implicit/sampledInputs.test.ts`: VC-IMP-29 on the MBB 60 x 20 golden of 17 TOP (the scalar equals an independent trilinear of the recorded density at 80 points, and the signed distance on the axes of a cubic strut lattice graded by it is minus the radius the density gives there, to 1e-9), staleness, the refusal names, an FE fixture in metres on a mm document; `server/tests/fieldNative.test.ts` (grid and tets: 1500 probes, values, gradients and interval-pruned meshes bit for bit; red with one lerp weight changed or the tolerance changed); `sampled.rs` unit tests. Red: a swapped lerp weight in TS fails 4 tests, dropping the unit conversion fails the FE test.

**Left.** Hex / shell elements of an FE mesh; point location outside a mesh scans all nodes (O(nodes) per outside sample, interval pruning by a region keeps it off the hot path); explicit threading of the port through the compile call sites (decision above).

### 14.12 A file sink for `export_3mf` above the base64 ceiling (DES-5c, 2026-10-30)

**Problem.** The package of `export_3mf` came back as one base64 string (`data.base64`); V8 strings stop near 536 million characters, so the deflated model part was capped at 375 MB (14.6: about 8 million triangles of a gyroid-like mesh).

**Decision.** A host port, not a command side effect: `ExecutionContext.exportFiles` (`ExportFilePort.open(fileName)` gives an `ExportFileWriter` with `write`, `patch`, `close`, `abort`; core, `commands/types.ts`). `export_3mf` takes `toFile` (true: write to the host file and return `data.file = { path, bytes }` with no `base64`; false: in memory; absent: in memory unless the host has a sink and the package streams over 4 000 000 triangles). The command stays pure and read-only (the document is returned unchanged; the host owns the file). The in-memory path, its ceilings and its refusal names are unchanged for hosts without a sink; its `EXPORT_MESH_TOO_LARGE` remediation now mentions `toFile`. New refusals: `EXPORT_SINK_UNAVAILABLE` (`toFile: true` and no sink, or none could be opened) and `EXPORT_SINK_FAILED` (an I/O error while writing: the partial file is discarded, the document unchanged).

**Code.** `commands/exchange/threeMfFile.ts` writes the archive to the sink: the two stored parts, the model part deflated as the XML is produced (its local header written with zero CRC and sizes and patched at the end; the central directory last), so no whole-package string or buffer and no compressed model held (`DeflateStream(onChunk)` hands each 64 KiB block over). `threeMf.ts`: `assembleThreeMf` (the model and the per-object report) is shared by `buildThreeMf` (memory) and `writeThreeMf` (sink). Limits: the archive under 4 000 000 000 bytes (ZIP without ZIP64) and the XML under `MAX_DEFLATE_INPUT` 2 000 000 000 bytes, both `EXPORT_MESH_TOO_LARGE` (`maxBytes` lowers the archive limit; a refusal discards the partial file). Server: `server/src/exportFiles.ts` (the port in `serverContext`, so the CLI, the backend and the desktop app; files in `LLULL_EXPORT_DIR`, default `<tmp>/llull-exports`, positioned writes); `llull ... --save PATH.3mf` moves the hosted file to the target instead of decoding a payload (`cli/saveFiles.ts`, only for files inside the export folder). Opening a new file removes the files of that folder untouched for a day (`reapExportFiles`).

**Measured** (`server/tests/export3mfFile.test.ts` with `LLULL_SLOW_TESTS=1`; a jittered grid mesh behind a mesh asset port, Windows, shared machine, process RSS sampled every 200 ms):

| body | path | result | time | RSS before -> peak |
| --- | --- | --- | --- | --- |
| 12 500 000 triangles, 1.04 GB of XML | file sink | 255 MB archive | 25.0 s | 770 -> 1250 MB (+480 MB) |
| the same | in memory | 255 MB package (+ its base64 string) | 26.9 s | 1087 -> 2005 MB (+918 MB) |
| 21 991 712 triangles, 1.84 GB of XML | file sink | 450 MB archive, the model part inflates (streamed) to the CRC and size of the central directory | 36.2 s | 980 -> 1911 MB (+931 MB) |
| the same | in memory | `EXPORT_MESH_TOO_LARGE` (375 MB ceiling) | 36.1 s | 1677 -> 2321 MB |

The sink halves the memory of a package that still fits in memory and exports the one that does not; the ceiling moves from 375 MB of deflated model to 2 GB of XML (about 24 million triangles of that mesh class; a mesh that compresses worse reaches the 4 GB archive limit first).

**Tests.** `tests/unit/exchange/threeMfFile.test.ts`: the sink archive equals the in-memory archive byte for byte (312 000 triangles), written in chunks of at most 64 KiB, limit refusal, no chunk held by `DeflateStream(onChunk)`, `toFile` at command level (path instead of base64, `close` once; `EXPORT_SINK_UNAVAILABLE`; `abort` on a refusal; below the automatic threshold the export stays in memory). `server/tests/export3mfFile.test.ts`: the real port writes the same bytes as memory, `--save` moves the file, a limit leaves nothing behind, and the slow test above. Red: `writeThreeMf` without the header patch fails the byte equality; an unlimited archive fails the limit test.

**Left.** The document load and the desktop UI export dialog do not use `toFile` yet (the UI still takes the in-memory package); ZIP64 for archives above 4 GB; `export_3mf` of a level-set or beam-lattice body has no size problem and is unchanged.

### 14.13 Surface-UV cell maps and maps for strut lattices (DES-5c, 2026-10-30; FR-IMP-17, TR-IMP-07)

**What a cell map is (today's code).** A map replaces the origin and rotation of a lattice by a coordinate system whose integer coordinates are the cells: `cylindrical` (cells around an axis, axial = `cellSize[2]`, radial = `radialCellSize`) and `spherical` (longitude x colatitude x radius), for TPMS. The compiler turns the map into three phase registers (2 pi per cell) and their physical scales (`CellCoordinates`), the TPMS equations read them, the normalised wall divides by the physical gradient. 14.13 adds the third kind of 5.6 and carries the maps to the strut lattices.

**`surface_uv`.** `map: { kind: 'surface_uv', sheetId, cellsU, cellsV, depth, layers }` (TPMS and struts): the cells follow the (u, v) of a `nurbs_surface` sheet (trims honoured) scaled to `cellsU` x `cellsV` cells over the patch, and the normal distance in cells of `depth`. The lattice is the support of the map: the slab 0 <= w <= `layers` (the +normal side of the sheet, `layers` cells of depth), over the footprint of the sheet (a lateral distance grid, negative over the sheet, the in-plane distance beyond its open edge), in the box of the sheet grown by `layers * depth` (`part.box`, so a body needs no region). The field is positive below the sheet, above the layers, beyond the edge and far away (a mapped lattice that is intersected with this support is never solid outside it); the normal coordinate is the normal component of the offset to the closest point, so it stays the normal distance across the extended plane. Implementation (`surfaceMap.ts`): the sheet is tessellated (`tessellateSheet`, 8 per knot span); every node of a grid of spacing `depth / 4` around it takes the (u, v) interpolated at the closest point of the triangles and the signed distance to that point (side of the triangle normal); the three grids (u, v, w) travel in the program as `sample_field` operands of 14.11 (trilinear, bit-identical on both engines): no new op, the native engine needs nothing. Their identity in the content hash is the version of the construction (`surface_uv/v2`), a digest of the sheet (poles, knots, trims, placement) and the four numbers. The sheet is a source of the bodies built on it (`entitySources`): moving, editing or deleting it under a body is refused with `IMP_SOURCE_IN_USE`, and a stored map is validated on load (finite positive sizes, whole `layers`, cell counts and string sheet id; a bad one refuses the file). The map is memoised per sheet entity.
- Distance quality: a mapped field is NOT an SDF. `distanceQuality` of a mapped TPMS or strut lattice is `approximate` (stated in `evaluate_field` and in the program). The Lipschitz bound of a surface map is twice the larger of the cell aspect (longest to shortest edge) and the ratio of a local cell edge to the mean one, both measured over the sheet (cylindrical and spherical keep their bound). The gradient normalisation of a surface map uses the mean phase scale of the sheet (2 pi / mean cell length along u and v, 2 pi / depth), so the normalised wall is exact where the stretch is 1 and uniform to the stretch elsewhere.
- Stretch report: the longest to shortest edge of the cells over the triangles of the sheet (edges along u, along v and the depth) is returned by `lattice_properties` (`cellStretchMin / Max`, as for the other maps) and, when that ratio or the local-to-mean cell size passes 2, the compile warns `IMP_MAP_STRETCH` (a wedge sheet of 20 x 2 mm under 4 x 4 cells does).
- Refusals by name: unknown sheet `IMP_ENTITY_NOT_FOUND`; not a `nurbs_surface` `IMP_PARAM_RANGE`; `cellsU`, `cellsV`, `depth` <= 0 or `layers` not a whole number >= 1 `IMP_PARAM_RANGE`; origin / rotation with a map `IMP_PARAM_CONFLICT`; a collapsed patch (zero-area triangles or no extent in (u, v)) `IMP_MAP_SINGULAR`; a grid above 600 000 nodes or a build of more than 20 000 000 closest-point tests (each triangle tests the nodes within `depth (layers + 1)` of it) `IMP_MAP_TOO_LARGE` (raise `depth`, or use a smaller or coarser sheet); fractional cells over a direction in which the sheet closes on itself `IMP_MAP_SEAM`. Nodes farther than `depth (layers + 1)` from the sheet hold a constant beyond the layers.

**Maps for strut lattices (`StrutsNode.map`, `add_strut_lattice map`).** The periodic cell of `cellSize` is laid on the map: the mapped length along axis i is the cell coordinate i times `cellSize[i]`, the strut set is evaluated at those lengths with the radius as an override register (the strut distance of 5.5 in mapped space), and the distance is divided by the mean local stretch (phase scale / 2 pi times cell size, averaged over the axes); the radius register is multiplied by the same stretch and capped below half the shortest strut (the periodic prefilter of the set is built for that radius). Cylindrical, spherical and surface_uv work; the result is approximate (`lipschitz` 2); the interval of the pruner stays sound because it propagates through the coordinate registers. Relative-density inversion and `bareCell` use the rectangular cell.

**Closed sheets.** A sheet whose first pole row equals its last (u) or whose rows close (v) is detected; its cell count there must be whole and the coordinate travels as (cos, sin) of its phase, the phase being rebuilt by `atan2` (the equations are periodic in it), so the trilinear grids stay continuous across the seam instead of blending 0 with `cells`. Tested on a rational circle patch (the lattice values straddling the seam agree to 0.05, the fraction is refused).

**Tests.** `tests/unit/implicit/surfaceMap.test.ts`: VC on a planar sheet (points inside the slab), where the parameterisation is linear and the map exact: a mapped gyroid equals the rectangular gyroid to 1e-9 at 120 points on both sides of the sheet; a mapped octet strut lattice equals the rectangular one outside the struts (inside, the capsule of the mapped set and the cylinder-and-ball of the rectangular one differ near the nodes); radial struts of a cylindrical strut map have signed distance minus the radius on their axis; the support (negative side, above the layers, far, beyond the edge, positive; a body is closed and bounded by the sheet box); the closed sheet; the sheet as a source; the load validation; the stretch warning; the quality; every refusal above; the work bound refuses a finely tessellated sheet in under 5 s. `tests/helpers/pluginSliceSeeds.ts` seeds the implicit slice fuzz with a surface_uv gyroid and strut lattice. \`server/tests/fieldNative.test.ts\`: mapped TPMS and strut lattices on a curved biquadratic sheet and a cylindrical strut map: values and gradients bit for bit against the TS engine. Red: dropping the sign of the normal distance fails the gyroid VC, the half voxel of the grid origin fails three, dropping the stretch division fails the cylindrical test, no support fails the support and source tests, a linear (not periodic) closed direction fails the seam test, no source fails the guard test, no map validation fails the load test.

**Left.** The (u, v) of a closest point on a tessellation is piecewise linear (the map is a sampled approximation, finer with a smaller `depth`); a sheet that folds back on itself inside the layers has several closest points (the nearest wins, which jumps); pole cells of a sheet with a collapsed edge are reported as singular rather than handled; the footprint edge is placed to within half the grid spacing; a sheet tessellated finer than the grid needs (96 samples per direction) is refused by the work bound instead of coarsened; spherical and cylindrical maps for the strut lattices use the same phase scales as the TPMS (mean over the three axes, not the Jacobian singular values).

### 14.14 An exact, near-linear Delaunay for Voronoi lattices (DES-5c, 2026-10-30)

**Problem.** The Bowyer-Watson pass of `add_voronoi_lattice` scanned every tetrahedron for every seed: 6000 seeds took 9-12 s and 10000 seeds 32-43 s (14.9), which set the seed cap.

**First attempt and why it was wrong.** A walk + flood that kept the old predicate (`d2 < r2 (1 - 1e-12)` on rounded circumspheres) and the old insertion order claimed to return the same tetrahedra in the same order. A randomised differential against the old scan found it false: 2 of 60 sets of 1500 seeds (seeds 9 and 36) differed, and on jittered lattices, points on a sphere, duplicates and coplanar layers most sets did. Cause: the circumsphere of a sliver is computed in doubles, so it may hold seeds it should not; the old scan removed such a sliver as a disconnected part of the conflict set, the flood never reaches it. Neither output was a Delaunay triangulation (non-empty spheres, faces shared by more than two tetrahedra, in both). Identity with the old scan is therefore not a goal: a defect that was shared is not a contract.

**Decision (quality first, no backward compatibility).** Exact predicates and a provable cavity:
- `voronoiPredicates.ts`: `orient3d` and `inSphere` (Shewchuk's determinants). A double determinant with a conservative relative bound (1e-13, about 100 times Shewchuk's) decides almost every call; inside the bound the determinant is recomputed exactly with BigInt on the exact binary values of the doubles. The sign is the sign of the real determinant, never a tolerance.
- `voronoiDelaunay.ts`: a seed removes a tetrahedron only when it is STRICTLY inside its circumsphere, so a cospherical seed is outside. With exact predicates and that single tie rule the conflict set of a seed is connected and star-shaped (a face coplanar with the seed has the same answer on both tetrahedra that share it, so no flat tetrahedron is made), a visibility walk finds the tetrahedron that contains the seed and a flood over the face adjacency collects the cavity: the result is a Delaunay triangulation for any input, in any search order (the flood and a scan of every tetrahedron give the same tetrahedra, tested). Exact duplicate seeds are skipped by name (`skipped`, counted in `dropped` of the graph): they make no cell. The circumcentre of a tetrahedron (the Voronoi vertex) is still rounded to doubles; it is a position, never a decision.
- The insertion order stays the seed order and tetrahedra are listed in creation order, so a diagram without a near-degenerate sliver is the same as before: the two seeded pins and the content hash of the pinned Voronoi body of `voronoi.test.ts` did not change (3046 beams / 1949 nodes, 13266 / 7812, hash `9c0effbb...`). A set with a sliver changes once (the 41.2 mm cube at 0.1 seeds/mm3 went from 98423 to 98420 beams): the one-time hash change the decision accepts.

**Proof by test.** `tests/unit/implicit/voronoiDelaunay.test.ts`: the predicates on cospherical and on 1e-300 off points; for uniform sets of 60, 150 (seeds 9 and 36 included), 300 and 1500 seeds (the seed 9 set the old rule broke on), 5 x 5 x 5 lattices jittered by 1e-9, 1e-11, 1e-13 and exactly cospherical, 70 points on a sphere to 1e-12, a set with three duplicates and layers of exactly coplanar seeds: every circumsphere is empty (no seed strictly inside, exact), no face is shared by more than two tetrahedra, no tetrahedron is flat, the volumes tile the enclosing tetrahedron to 1e-6, and the array equals a slow reference that scans every tetrahedron for the exact conflict set. Red: answering with the double determinant only (no exact fallback) fails the predicate test and two jittered lattices.

**Measured** (TS, the Delaunay pass alone with exact predicates; seeds uniform at 0.04 per mm3; the whole command at 0.1 seeds per mm3):

| seeds | quadratic (14.9) | walk + flood, exact | tetrahedra |
| --- | --- | --- | --- |
| 1000 | - | 0.16 s | 6319 |
| 6000 | 9-12 s | 1.1 s | 39674 |
| 10000 | 32-43 s | 2.1 s | 66421 |
| 30000 | - | 8.3 s | 200926 |

The filter costs nothing measurable (the exact path runs on slivers only). The cost grows as about n^1.25 (the walk). `add_voronoi_lattice` over a 41.2 mm cube at 0.1 seeds/mm3 (about 10000 seeds, 98420 beams, 54085 nodes) takes 5.0 s in all.

**Cap.** `MAX_SEEDS` 6000 -> 10000 (`voronoi.ts`): a seed adds about 9.2 beams, so 10000 seeds sit close to the 100000 beams of a graph lattice (`MAX_GRAPH_BEAMS`); `IMP_GRAPH_TOO_LARGE` either way. The refusal test (a 60 mm cube at 0.04: 12000 seeds) follows.

**Left.** A native Delaunay (the TS builder is the only one); symbolic perturbation instead of the "cospherical is outside" rule (the rule is consistent and gives a valid triangulation, but the tetrahedra of a cospherical set depend on the seed order).
