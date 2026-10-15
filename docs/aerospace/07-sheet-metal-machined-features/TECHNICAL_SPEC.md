# Gap FTR — Sheet-metal and machined manufacturing features — Technical specification

Gap id: **FTR** · Companion: `FUNCTIONAL_SPEC.md` (FR-FTR-nn) · Validation: `validation/README.md` (VC-FTR-nn).
Laws respected: L1 (one command layer), L3 (purity), L4 (document = single source of truth), L5 (registry), L8
(feature history), L9 (kernel via `ctx.kernel`, shape boundary per KI5), L10 (domain = plugin). The product direction is
desktop-first, with OCC as the desktop kernel (KI6).

---

## 1. Current state in llull

| Area | Where | What exists | Limit for this gap |
| ---- | ----- | ----------- | ------------------ |
| Kernel interface | `packages/core/src/geometry/kernel.ts` | `GeometryKernel { supports, evaluate(recipe), tessellate, topology, exportStep }`. `ShapeTopology` lists faces as `{index, surface, area}` and edges as `{index, curve, length, start, end, mid, samples, seam, degenerate}` | Faces carry **no surface parameters** (no plane normal, cylinder axis/radius or cone apex/semi-angle) and no adjacency, so no recognition or unfold is possible |
| Shape recipe | `packages/core/src/model/types.ts` `ShapeRecipe` (l. 710+) and `geometry/shapeRecipe.ts` | ops `solid`, `boolean`, `fillet`, `chamfer`, `blend`, `shell`, `place`, `scale`; `recipeKey` content hash | No feature nodes (hole, pocket, rib), no sheet node |
| Solid kinds | `SOLID_KINDS` (`box … subdivision`) | `extrusion` (profile solid), `revolution`, `sweep`, `loft`, `mesh` (kernel result with `brep`) | — |
| B-rep commands | `packages/core/src/commands/brep/` | `boolean`, `blend_union`, `fillet_edge`, `chamfer_edge`, `shell_solid`, `inspect_topology`, `export_step_exact` | A hole today is one `add_cylinder` + `add_cone` + 2 `boolean` (see `validation/plans/baseline_countersunk_plate_today.json`) with no semantics kept |
| Profile solids | `commands/solids/profile.ts` (`extrude_profile`, `revolve_profile`), `sweep.ts`, `loft.ts` | 2D → 3D bridge (L7) | No thickness-side semantics, no bends |
| Patterns | `commands/edit/` `array_linear`, `array_polar`, `pattern_along_path` | Entity copies | Not feature patterns (no hole pattern on a face) |
| Queries | `commands/inspect/` `mass_properties`, `measure_*`, `find_entities`, `check_model` | Volume and mass from kernel or mesh | — |
| OCC kernel | `packages/kernel-occt/src/` (`occtKernel.ts`, `occtShapes.ts`, `occtTopology.ts`, `occtStep.ts`); `opencascade.js@^1.1.1` | Booleans, fillet, chamfer, offset (shell), pipe, thru-sections, prism, revol, STEP write | The package ships no `.d.ts` (llull declares its own ambient module, `opencascade.d.ts`). Review probe of the installed 1.1.1 wasm (2026-10-15, Node): `BRepFeat_MakePrism`, `MakeRevol`, `MakePipe`, `MakeRevolutionForm`, `Gluer`, `SplitShape`, `LocOpe_Prism`, `BRepAdaptor_Surface` construct; `BRepFeat_MakeCylindricalHole` is exported but **cannot be constructed** ("unbound types: BOPAlgo_BOP"); `BRepFeat_MakeLinearForm` is **not exported** (listed in the package's `Supported APIs.md`, absent from the binary); `TopTools_IndexedDataMapOfShapeListOfShape` is not exported, so `TopExp.MapShapesAndAncestors` is unusable (adjacency must be built like `occtTopology.ts` does, by `HashCode`/`IsSame`). `Perform*` calls were not exercised; see D3 |
| Python bridge | `server/python/llull_bridge.py`, `packages/mcp/src/exchangeTools.ts` | `import_step` / `export_step` via CadQuery (bundled CPython on desktop, KI6) | `import_step` is an exchange tool, not a registry command. It tessellates in Python (`op_import_step` → `_bodies_from` triangles) and replays `import_mesh`: imported parts arrive as `mesh` entities **without** `brep`, so no exact face graph exists for them today (see §2.2, M0, D9) |
| DXF | `packages/domain-aec/src/building/exchange/dxfWriter.ts`, `dxfExport.ts` (`export_dxf`), core `import_dxf` | R12 (`$ACADVER` AC1009) writer inside the AEC plugin; entities LINE, CIRCLE, ARC, TEXT, POLYLINE/VERTEX, 3DFACE (no LWPOLYLINE) | A plugin cannot import another plugin (L10), so a generic writer must move to core (D4). The current file also imports `@core/model/types`, `@core/geometry/*`, `@core/model/drawing` and AEC-only `planModel`/`shared/numeric`, so it cannot move to `lib` as is (`lib-is-a-leaf` rule in `.dependency-cruiser.cjs`) |
| Code export | `packages/core/src/codegen/` (`python.ts`, `recipeLowering.ts`, `freecad.ts`, `openscad.ts`) | CadQuery / build123d / FreeCAD / OpenSCAD emitters | No hole or sheet-metal lowering; CadQuery has `hole`, `cboreHole`, `cskHole` (`cadquery/cq.py` @5f5bc62 [R16]) |
| Toolsets | `packages/mcp/src/toolsets.ts` | `core, 2d, 3d, measure, parametric, assembly, exchange`, plugin toolsets `building`, `civil` | No `manufacturing` toolset |

There is no sheet-metal, hole, thread, pocket or recognition code anywhere in `packages/` (grep for `countersink`,
`counterbore`, `sheet_metal`, `k_factor` finds nothing relevant).

## 2. Target architecture

### 2.1 Layer placement

```
packages/core/src/
  lib/dxfWriter.ts                    (generic R12 LINE/ARC/CIRCLE/TEXT/POLYLINE writer split out of domain-aec)        D4
  lib/sheetMath.ts                    pure bend math: bendAllowance, outsideSetback, bendDeduction, kChart, joggle, kTable
  lib/holeMath.ts                     countersink depth/diameter, drill tip, frustum volumes
  model/types.ts                      + ShapeRecipe ops 'feature' (hole | pocket | rib); + FaceInfo surface params
  geometry/kernel.ts                  + GeometryKernel.faceGraph(shape) (optional; null on Manifold)
  geometry/featureLowering.ts         'feature' node -> boolean/primitive sub-tree (fallback for kernels without BRepFeat)
  geometry/recognition/               pure recognition over FaceGraph (holes, pockets, fillets, chamfers, bends)
  commands/features/catalog.ts        add_hole, add_pocket, add_rib, set_thread, recognize_features, check_machining
packages/domain-mfg/src/              NEW plugin package (@mfg)                                                       D1
  sheetmetal/{catalog,plugin}.ts      CadPlugin 'sheetmetal' (toolset 'manufacturing'), document extension `sheetMetal`
  sheetmetal/model.ts                 SheetMetalPart graph (flats + bends), rules, tables
  sheetmetal/fold.ts                  graph -> folded ShapeRecipe (profile solids + revolution sectors, union)
  sheetmetal/unfold.ts                graph -> flat 2D outline (analytic); imported B-rep -> graph (via FaceGraph)
  sheetmetal/checks.ts, tables/       min bend radius table schema (+ empty seed), K tables
packages/kernel-occt/src/occtFeatures.ts   'feature' node (pocket, revolved hole tool) via BRepFeat_MakePrism / BRepFeat_MakeRevol; holes and ribs otherwise lowered
packages/kernel-occt/src/occtFaceGraph.ts  faceGraph(): BRepAdaptor_Surface params + edge→faces adjacency
src/app/plugins.ts                    installDefaultPlugins() += sheetMetalPlugin
src/ui/panels/{HolePanel,PocketPanel,SheetMetalPanel,FeatureTablePanel}.tsx   param gathering only
```

Rationale:

- **Holes, pockets, ribs, threads and recognition go in core.** They are generic part-modelling operations at the same
  level as `fillet_edge`, and they need new `ShapeRecipe` nodes. Recipes are core's contract with the kernel (KI5).
- **Sheet metal is a plugin** (L10). It owns a domain model: a flats-and-bends graph, rules and material tables. Derived
  geometry (folded solid, flat pattern) is read-only and re-derived on load, exactly the `building` plugin pattern
  (`DocumentExtension.derivedEntityIds/restore`, derivation guards). Aerospace-specific tables (alloy/temper radii,
  fastener-hole mapping presets) live in plugin data, never in core.
- **The kernel stays a shape boundary.** Sheet-metal folding is built from existing profile solids (`extrusion` for
  flats, `revolution` sectors for bends) unioned in a recipe. The native flat pattern is computed analytically from the
  graph, so no B-rep unfolding is needed for parts authored in llull. B-rep unfolding is needed only for imported parts,
  through `faceGraph`.

### 2.2 Dependencies on other gaps

| Gap | Need |
| --- | ---- |
| 08 Fastener catalogue | `FastenerRef` → hole spec (clearance/fit, countersink D and angle, thread designation). Until 08 lands, `add_hole` takes explicit dimensions and `fastener` is rejected with a clear summary. |
| Drawings (hole/bend tables, thread callouts) | `data` tables of `recognize_features`, `flat_pattern` and hole features; drawing views of flat patterns |
| STEP exchange / PMI | **Prerequisite (not true today):** an exact STEP import that keeps a `brep` on the imported entity, i.e. gap 01 `import_step_brep` (`docs/aerospace/01-exact-brep-kernel/`). Gap 01 owns its design; this gap only consumes the resulting exact solid. Today `import_step` returns triangles only (§1). Needed by `recognize_features` on imported parts, `convert_to_sheet_metal` and VC-FTR-18…21, 32 (milestone M0, D9). AP242 PMI association is out of scope here |
| Parametric / persistent naming | Face `near` references (KI5 approach) now; BRepTools_History naming later |

## 3. Data model

Type sketches (TS strict, `exactOptionalPropertyTypes`). Document format change: additive, with no breaking migration.
New fields are optional and absent until the first command uses them. Bump the persisted document minor version and
record `sheetMetal` in the plugin's `DocumentExtension.validate`.

### 3.1 Core: feature recipe node and face references

```ts
/** A face picked by a world point on (or near) it; re-resolved on every replay (KI5-style naming). */
export interface FaceRef { readonly near: Vec3; readonly index?: number }

export type HoleKind = 'simple' | 'counterbore' | 'countersink' | 'counterdrill';
export type HoleExtent =
  | { readonly kind: 'blind'; readonly depth: number; readonly drillPointAngle?: number /* deg, absent = flat */ }
  | { readonly kind: 'through_all' }
  | { readonly kind: 'up_to_next' }
  | { readonly kind: 'up_to_face'; readonly face: FaceRef };

export interface HoleSpec {
  readonly kind: HoleKind;
  readonly diameter: number;
  readonly cboreDiameter?: number; readonly cboreDepth?: number;           // counterbore / counterdrill
  readonly cskDiameter?: number; readonly cskAngle?: number;               // countersink / counterdrill (deg, included)
  readonly cskDepth?: number;                                               // alternative to cskDiameter
  readonly thread?: ThreadSpec;                                             // cosmetic attribute (FR-FTR-19)
  readonly fastener?: FastenerRef;                                          // gap 08 (V1)
}

export interface ThreadSpec {
  readonly designation: string;           // e.g. "MJ6x1-4H5H", ".1900-32 UNJF-3B" — free text, validated by a grammar per family
  readonly family: 'UNJ' | 'MJ' | 'UN' | 'M' | 'other';
  readonly depth?: number;                // absent = full hole depth
  readonly handedness?: 'right' | 'left';
  readonly modelled?: boolean;            // COULD (FR-FTR-20); default false = cosmetic
}

export interface FastenerRef { readonly catalogId: string; readonly partNumber: string; readonly fit?: string }

export interface PocketSpec {
  readonly outline: Profile2D;            // closed, on the face plane, local 2D (same Vec2 conventions as draw2d)
  readonly islands?: readonly Profile2D[];
  readonly depth: number | { readonly upToFace: FaceRef } | 'through';
  readonly cornerRadius: number;          // applied to convex+concave vertical corners of the outline (>= toolRadius)
  readonly floorFillet: number;           // 0 = sharp; must be <= cornerRadius
  readonly toolDiameter?: number;         // for DFM
}

/** New ShapeRecipe member (types.ts). The kernel evaluates it natively or via featureLowering. */
| {
    readonly op: 'feature';
    readonly feature: 'hole' | 'pocket' | 'rib';
    readonly source: ShapeRecipe;
    readonly frame: { readonly origin: Vec3; readonly normal: Vec3; readonly xDir: Vec3 }; // resolved face plane
    readonly points: readonly Vec2[];                                                         // hole positions (frame-local)
    readonly hole?: HoleSpec; readonly extent?: HoleExtent;
    readonly pocket?: PocketSpec;
    readonly rib?: { readonly path: Profile2D; readonly thickness: number; readonly height: number | { readonly upToFace: FaceRef } };
  }
```

`recipeKey` gains `feature(...)` text covering every geometric field. `thread` is **excluded** from the key (cosmetic,
FR-FTR-19). Display metadata lives on the result entity: the result stays a `mesh` entity with `brep` (KI5), plus
`features?: FeatureMeta[]` for queries, drawings and code export.

### 3.2 Core: face graph (kernel output)

```ts
export type SurfaceParams =
  | { readonly type: 'plane'; readonly origin: Vec3; readonly normal: Vec3 }
  | { readonly type: 'cylinder'; readonly axisOrigin: Vec3; readonly axisDir: Vec3; readonly radius: number }
  | { readonly type: 'cone'; readonly apex: Vec3; readonly axisDir: Vec3; readonly semiAngle: number /* rad */ }
  | { readonly type: 'torus'; readonly center: Vec3; readonly axisDir: Vec3; readonly major: number; readonly minor: number }
  | { readonly type: 'sphere'; readonly center: Vec3; readonly radius: number }
  | { readonly type: 'other'; readonly kind: FaceSurface };

export interface FaceGraphFace {
  readonly index: number;                 // same index as ShapeTopology.faces
  readonly surface: SurfaceParams;
  readonly reversed: boolean;             // face orientation vs surface normal (material side)
  readonly area: number;
  readonly loops: readonly (readonly number[])[]; // edge indices, outer loop first
  readonly uvBounds: readonly [number, number, number, number]; // for cylinder: angular span = u range
}
export interface FaceGraph {
  readonly faces: readonly FaceGraphFace[];
  readonly edgeFaces: readonly (readonly number[])[];           // edge index -> adjacent face indices
  readonly edgeConvexity: readonly ('convex' | 'concave' | 'smooth' | 'unknown')[];
}
// GeometryKernel += faceGraph?(shape: ShapeHandle): FaceGraph | null   (optional member: Manifold omits it)
```

### 3.3 Plugin `sheetmetal`: document extension

```ts
export interface SheetMetalRule {
  readonly name: string;
  readonly material: string;              // free label, e.g. "2024-T3" (links to a radius-table row by material+temper)
  readonly thickness: number;
  readonly insideRadius: number;
  readonly k: { readonly standard: 'ansi' | 'din'; readonly value: number } |
               { readonly standard: 'ansi' | 'din'; readonly table: readonly { readonly rOverT: number; readonly k: number }[] };
  readonly relief?: { readonly type: 'rectangular' | 'obround' | 'none'; readonly widthRatio: number; readonly depthExtra: number };
  readonly allowSharpBends?: boolean;     // default false -> R = 0 rejected by check
}

export type SheetNode =
  | { readonly id: string; readonly type: 'flat'; readonly outline: Profile2D; readonly frame: Frame3; readonly cutouts: readonly Profile2D[] }
  | { readonly id: string; readonly type: 'bend'; readonly from: string; readonly to: string; readonly lineInFrom: Seg2;
      readonly angle: number /* rad, signed: + = up */; readonly insideRadius: number; readonly kOverride?: number }
  | { readonly id: string; readonly type: 'joggle'; readonly on: string; readonly line: Seg2; readonly offset: number;
      readonly angle: number; readonly insideRadius: number }
  | { readonly id: string; readonly type: 'form'; readonly on: string; readonly form: FormSpec }; // bead, flanged hole, louver

export interface SheetMetalPart {
  readonly id: string;                    // also id of the derived folded solid entity
  readonly rule: string;
  readonly root: string;                  // fixed flat (stationary face for unfolding)
  readonly nodes: Readonly<Record<string, SheetNode>>;
  readonly order: readonly string[];
}
export interface SheetMetalModel {
  readonly rules: Readonly<Record<string, SheetMetalRule>>;
  readonly parts: Readonly<Record<string, SheetMetalPart>>;
  readonly radiusTable: readonly BendRadiusRow[];
}
export interface BendRadiusRow {
  readonly material: string; readonly temper: string; readonly thickness: number; readonly minInsideRadius: number;
  readonly units: 'mm' | 'in'; readonly bendAngle: number; /* deg the row applies to, AC Table 4-6 = 90 */
  readonly source: string;                // mandatory provenance, e.g. "AC 43.13-1B Table 4-6 (verified 2026-xx)"
}
// CadDocument += sheetMetal?: SheetMetalModel   (absent until the first sheet-metal command)
```

The derived entities are the folded solid (`mesh` entity whose `brep` is a union recipe of `extrusion` and `revolution`
entities) and, on request, the flat pattern as 2D entities (`polyline`/`arc` on a layer `FLAT-<part>`). Both are listed
in `derivedEntityIds` and protected by derivation guards. Only sheet-metal commands edit them.

## 4. Commands

All are `defineCommand({ name, description, params: z.object(...), run })`, pure and snake_case. M = mutating (a feature
step is appended), Q = query (returns `data`, document unchanged). K = `requiresKernel`.

### 4.1 Core `commands/features/` (toolset `manufacturing`)

| Command | Type | Params sketch | @affects | @invariant | @failure |
| ------- | ---- | ------------- | -------- | ---------- | -------- |
| `add_hole` | M, K | `target`, `face: {near}`, `points: Vec2[] \| Vec3[]`, `pointsFrame: 'face' \| 'world_xy'`, `hole: HoleSpec`, `extent: HoleExtent`, `direction?` | replaces target with result `mesh` (+`features` meta) | volume decreases; result recipe = `feature(hole)` over target recipe; `thread` never changes geometry | face not planar or not found; point outside face; diameters inconsistent (D ≤ d, cbore ≤ d); angle ∉ (0,180); blind depth ≤ 0; `fastener` without catalogue (pre-gap-08) → no-op, summary names the field |
| `add_pocket` | M, K | `target`, `face`, `outline`, `islands?`, `depth \| upToFace \| 'through'`, `cornerRadius`, `floorFillet`, `toolDiameter?` | same | rf ≤ rc; pocket stays inside face outline (else `open: true` must be set) | rf > rc (PK-03); self-intersecting outline; depth ≥ thickness without `'through'` |
| `add_rib` | M, K (SHOULD) | `target`, `plane: {origin, normal}`, `path: Profile2D (open)`, `thickness`, `height \| upToFace`, `symmetric` | same | rib fused (Fuse = 1) | path not on a supporting face |
| `set_thread` | M | `id`, `featureIndex` or `face`, `thread: ThreadSpec \| null` | entity `features[].thread` only | geometry and `recipeKey` unchanged | designation fails family grammar; face not cylindrical |
| `recognize_features` | Q, K | `id`, `kinds?`, `mergeSplitFaces = true`, `angularTolerance = 1e-6`, `lengthTolerance = 1e-6` | — | read-only; deterministic order (by type, then axis point lexicographic) | no B-rep (`faceGraph` null) → summary "needs an exact kernel (OCC)" |
| `check_machining` | Q, K | `id`, `rules?: { minLand, maxDepthRatio, toolDiameter, … }`, `thickness?` (local material thickness override) | — | read-only; T_local from a kernel ray cast (§5.3) unless `thickness` is given | no exact B-rep and no `thickness` → summary "needs an exact kernel (OCC) or `thickness`" |
| `hole_table` | Q (SHOULD) | `id`, `origin?` | — | read-only | — |

### 4.2 Plugin `sheetmetal` (toolset `manufacturing`)

| Command | Type | Params sketch | Notes |
| ------- | ---- | ------------- | ----- |
| `sheet_metal_calc` | Q | `thickness`, `insideRadius`, `angle` (deg), `kFactor?`, `kStandard = 'ansi'`, `mode: 'k_factor' \| 'faa_empirical'`, `units?`, `material?`, `temper?` | returns `{ BA, OSSB, ISSB, BD, kChart, rOverT, minRadius?, minRadiusSource? }`; needs no part (FR-FTR-14) |
| `create_sheet_metal_rule` | M | `name`, `material`, `thickness`, `insideRadius`, `kFactor \| kTable`, `kFactorStandard`, `relief?`, `allowSharpBends?` | `sheetMetal.rules[name]` |
| `import_bend_radius_table` | M | `rows: BendRadiusRow[]` (or CSV text) | each row needs `source`; replaces rows with the same key |
| `add_sheet_metal_base` | M, K | `profileId` (closed 2D entity), `rule`, `side: 'up' \| 'down' \| 'mid'` | creates part + folded solid |
| `add_flange` | M, K | `id`, `edge: {near}`, `angle`, `length`, `lengthReference: 'outside_mold_line' \| 'inside_mold_line' \| 'tangent'`, `position: 'material_inside' \| 'material_outside' \| 'bend_outside'`, `insideRadius?`, `widthStart?`, `widthEnd?` | relief auto per rule (V1) |
| `add_joggle` | M, K (V1) | `id`, `face: {near}`, `line: Seg2`, `offset`, `angle \| run`, `insideRadius?`, `side` | rejects when s < 0 (JG-04) |
| `add_sheet_cutout` | M, K | `id`, `face`, `profileId`, `normalCut = true` | cutout stored in flat-local coords → appears in flat pattern |
| `add_flanged_hole` | M, K (V1) | `id`, `face`, `center`, `holeDiameter`, `flangeHeight`, `flangeAngle`, `lipRadius` | flat cut diameter approximate (flagged) |
| `add_bead` | M, K (V1) | `id`, `face`, `path`, `radius`, `depth`, `endShape` | forming note in flat pattern |
| `add_relief` / `add_corner_relief` | M, K (V1) | `id`, `bend` or `corner`, `type`, `size` | |
| `convert_to_sheet_metal` | M, K (V1) | `id`, `stationaryFace: {near}`, `rule?` (inferred T, R) | builds `SheetMetalPart` from `faceGraph`; fails with reason (non-constant thickness, non-cylindrical bend) |
| `flat_pattern` | Q (+ M with `materialize: true`) | `id`, `materialize?`, `layer?` | `data: { outline, cutouts, bendLines, bends[], extents, area }`; with `materialize` adds derived 2D entities |
| `check_sheet_metal` | Q | `id` | violations list `{ code, nodeId, value, limit, source }` |
| `export_flat_pattern_dxf` | Q (file content) | `id`, `units?`, `bendLines = true`, `bendNotes = true`, `splineTolerance = 0.01` | returns DXF text (CLI `--save`) |

Feature-step semantics: every M command records its params, including the `near` points. Replay re-resolves faces and
edges by nearest face or edge midpoint on the regenerated B-rep (KI5). Plugin commands compose core ones through
`ctx.registry`/`execute` where needed (L10).

## 5. Kernel / algorithms

### 5.1 Bend mathematics (`lib/sheetMath.ts`, pure)

With θ the bend angle (angle bent through, rad), R the inside radius, T the thickness and K the ANSI K-factor
(K_DIN = 2·K_ANSI, converted on input [R7]):

| Quantity | Formula | Source |
| -------- | ------- | ------ |
| Neutral radius | ρ = R + K·T | [R7][R14] |
| Bend allowance | BA = θ·(R + K·T) | [R7] |
| K-chart value | k = tan(θ/2) | AC Table 4-7 values 0.41421 (45°), 1 (90°), 2.4142 (135°) [R2] |
| Outside setback | OSSB = k·(R + T) (AC: SB = K(BR + MT)) | [R2] |
| Inside setback | ISSB = k·R | geometry |
| Bend deduction | BD = 2·OSSB − BA | geometry |
| Flat length, legs to OML | L = A + B − BD | geometry |
| FAA empirical | BA = (0.01743·R + 0.0078·T)·θ_deg ⇒ K_eq = 0.0078/0.01743 ≈ 0.4475 | [R3] |
| K table lookup | linear interpolation in r/T, clamped at both ends (FreeCAD behaviour) | [R7] |

Bends over 90° use the same formulas. Setback grows as tan(θ/2), and the test grid covers 135° (FP-06, FP-10). θ ≥ 180°
(hem) uses the hem model in V2. The setback is undefined at 180°, so the hem uses its own formula.

### 5.2 Native sheet-metal fold and unfold (plugin)

- **Fold.** Each flat node becomes an `extrusion` entity: its outline minus cutouts, thickness T, on its frame, offset by
  the side. Each bend becomes a `revolution` sector: the rectangle [R, R+T] × width, revolved by θ about the bend axis.
  The recipe is a `boolean union` of all of them, evaluated by the kernel (exact under OCC; Manifold gives a mesh).
  Frames chain from the root: the child flat frame = parent frame · translate(bend line) · rotate(θ about the bend axis
  at distance R or R+T, depending on side).
- **Unfold (analytic).** Walk the tree from the root. Each child flat is placed in the plane, rotated back, and shifted
  by BA along the parent's in-plane normal to the bend line. The bend zone becomes a rectangle of width BA bounded by
  bend lines (up/down from sign θ). Cutouts on bends are developed by mapping arc length s on the neutral surface:
  s = φ·ρ. Result: a 2D region of lines and arcs. Splines are approximated as arcs/lines within `splineTolerance`,
  following the FreeCAD `Edge2DCleanup` motivation [R7].
- **Invariants.** Unfolded area × T equals the folded volume exactly when K = 0.5 (VC-FTR-08). Refolding the flat
  outline gives the same recipe (round trip). Unfolding never edits the part.

### 5.3 Hole geometry (`lib/holeMath.ts`, `geometry/featureLowering.ts`, `occtFeatures.ts`)

- Countersink depth c = (D − d)/(2·tan(α/2)). Depth to the sharp apex c₀ = D/(2·tan(α/2)). Inverse D = d + 2c·tan(α/2).
  Removed volume beyond the bore V = πc/3·(R₁² + R₁R₂ + R₂²) − πR₂²c. Inside a sheet of thickness T the cone is truncated at h = min(c, T): R₃ = R₁ − h·tan(α/2), V_T = πh/3·(R₁² + R₁R₃ + R₃²) − πR₂²h (= V when c ≤ T; differs for knife-edge cases). Drill tip height h = (d/2)/tan(β/2).
  (`validation/data/expected_countersink.json`.)
- **Lowering (always available).** The tool solid is a revolve of a half-section polyline about the hole axis: bore
  radius, counterbore step, countersink cone, drill tip. It is extended by ε = max(1e-3·d, 10·tolerance) above the face
  so the faces are not coplanar, and the plan's `boolean subtract` runs once per position, or once against a compound of
  all positions (preferred for speed). Through-all depth = the extent of the target's bbox along the axis, plus ε.
- **OCC native (optional optimisation, scoped to the bindings that exist).** In the opencascade.js 1.1.1 build only
  `BRepFeat_MakePrism` and `BRepFeat_MakeRevol` are constructible (§1). Pockets may use `BRepFeat_MakePrism` with
  Fuse = 0 and `Perform(Until)` for up-to-face; the revolved hole tool may use `BRepFeat_MakeRevol`. **Holes and ribs are
  built by recipe lowering** (revolved tool + boolean; rib = prism of the thickened open profile fused to the target),
  because `BRepFeat_MakeCylindricalHole` cannot be constructed and `BRepFeat_MakeLinearForm` is absent [R10 for the OCCT
  API only]. Native and lowered results must match in volume to 1e-6 relative (VC-FTR-25).
- **Countersink knife edge.** Land = T_local − c, where T_local is the material thickness along the axis at the hole
  (kernel ray cast through the solid, hence `check_machining` is `requiresKernel`; a `thickness` param overrides it). Land ≤ 0 means a knife edge; land < `minLand` gives a warning (threshold is data).

### 5.4 Joggle (`lib/sheetMath.ts`)

Two reverse bends of angle φ and inside radius R. The mid-surface radius is r_m = R + T/2. The flats are offset by h.

- inclined straight s = (h − 2r_m(1 − cos φ))/sin φ, which must be ≥ 0, otherwise reject (JG-04);
- run Lrun = 2r_m·sin φ + s·cos φ;
- developed length Ldev = 2·BA(φ) + s;
- joggle allowance ΔL = Ldev − Lrun.

The straight between the two tangent lines has the same length on every layer, because both tangent lines are normal to
it. That makes the formula exact for the K-factor model. Verified against an exact OCC solid (`ftr_joggle_strip.step`,
volume error 2e-16).

### 5.5 Pocket (`featureLowering.ts`)

The tool is the outline (offset-safe, corners rounded to `cornerRadius`) extruded by the depth. A floor fillet is
applied to the floor edges of the result (kernel fillet, OCC) or built into the tool by sweeping a quarter-round along
the outline (lowering). Analytic check for a rounded rectangle:

V = D·(W·L − (4 − π)·rc²) − a·(2(W + L) − 8rc + 2π(rc − x̄)), with a = rf²(1 − π/4) and x̄ = rf(10 − 3π)/(3(4 − π)).

Cross-checked against OCC `BRepFilletAPI_MakeFillet` with relative error 6.8e-12 (`expected_pocket.json`).

### 5.6 Feature recognition (`geometry/recognition/`, pure over `FaceGraph`)

1. **Merge split faces.** Union-find over faces that share an edge and have identical surface parameters within
   tolerance (same plane, same cylinder axis and radius, same cone apex, axis and angle). This is measured as necessary:
   in NIST CTC-01 every drill-point cone arrives as 2 half-faces (4 cone faces, 2 apexes;
   `validation/data/step_feature_survey.json`).
2. **Hole chains.** Seed with concave cylindrical groups whose merged angular span is 2π (full bore). Partial spans are
   fillet or slot candidates. Walk coaxial neighbours along the axis: a planar annulus gives a counterbore step, a cone
   between a plane and a bore gives a countersink (included angle 2·semiAngle) or a chamfer. The rule: countersink when
   cone height ≥ `chamferMaxRatio`·d or when D/d matches the fastener table; otherwise report `ambiguous`. A cone with an
   apex on the axis closing the bore gives a drill point (118° = semi 59°). A planar disc gives a flat bottom. An exit on
   the opposite outer face gives a through hole.
3. **Pockets.** Concave planar floor faces whose outward normal points to the opening, bounded by walls (planes or
   cylinders) that are perpendicular to the floor and concave to the material. Corner radius = min radius of the
   vertical cylindrical walls. The floor fillet comes from the torus/cylinder faces between floor and walls. Open pockets
   (a wall missing) are flagged `open`.
4. **Fillets and chamfers.** Smooth-tangent cylinder, torus or sphere faces between two faces, and planar strips at
   about 45°, are classified by convexity (`edgeConvexity`).
5. **Sheet-metal bends.** Pairs of coaxial cylinders with radii R and R + T (T constant over all flats), whose angular
   spans are equal. The flats are opposite parallel planes at distance T.
6. **Output.** Typed list with face indices (for highlighting), axis, dimensions, confidence (`exact` | `ambiguous`)
   and a deterministic sort.

### 5.7 Imported solid → sheet metal (V1)

From `FaceGraph`: estimate T as the mode of parallel opposite-plane distances; bends as in 5.6 step 5. Build the
`SheetNode` graph with the stationary face as root and the bend angles from the planes' normals. Unfold with 5.2.
Non-developable faces (B-spline, torus not at a corner) abort with a reason list. This mirrors FreeCAD's unfolder
approach of comparing adjacent planes, cylinders, cones and tori [R7].

### 5.8 Tolerances

| Item | Value |
| ---- | ----- |
| Linear (recognition, coaxiality) | 1e-6·(model bbox diagonal), min 1e-7 mm |
| Angular | 1e-6 rad (semi-angle match), 1e-3° reported |
| Flat pattern vs analytic | 1e-6 mm (calc), 0.01 mm (kernel unfold of imported) |
| Spline → arc approximation | `splineTolerance` default 0.01 mm |
| Volume native vs lowered | 1e-6 relative |

## 6. Interop & persistence

| Format | Direction | Content |
| ------ | --------- | ------- |
| `.llull.json` | R/W | `sheetMetal` extension, `feature` recipe nodes, `features` meta (thread designations). Validation rejects unknown hole kinds, rf > rc, rows without `source`. |
| DXF (R12/AC1009 subset) | W | Flat pattern: layers `OUTLINE`, `CUTOUT`, `BEND_UP`, `BEND_DOWN`, `NOTES`; LINE/ARC/CIRCLE/TEXT; `$INSUNITS` from document units. Generic writer split into core `lib` (D4). |
| STEP AP214 / AP242 | W | `export_step_exact` writes feature results as plain B-rep (feature semantics not encoded). STEP is read via `import_step` (CadQuery), which today yields a tessellated `mesh` without `brep`; recognition on imported parts needs the exact import path of §2.2 (D9). |
| CadQuery / build123d code | W | `feature(hole)` lowered to `.hole()`, `.cboreHole()`, `.cskHole()` [R16]. The 100° angle passes through `cskAngle`. Drill points are emitted as an extra cone cut. Thread designations are emitted as comments. The sheet-metal fold is emitted as its union recipe. |
| CSV | R | Bend-radius table import and K tables (`rOverT,k`) similar to FreeCAD MDS CSV [R7]. |
| JSON `data` | W | `recognize_features`, `flat_pattern`, `hole_table`, check reports. These are the agent and drawing contract, described by a zod output schema in docs. |

## 7. UI / CLI / MCP surfaces

- **Toolset `manufacturing`** (MCP view): `add_hole add_pocket add_rib set_thread recognize_features check_machining
  hole_table` + plugin `sheet_metal_calc create_sheet_metal_rule import_bend_radius_table add_sheet_metal_base add_flange
  add_joggle add_sheet_cutout add_flanged_hole add_bead add_relief add_corner_relief convert_to_sheet_metal flat_pattern
  check_sheet_metal export_flat_pattern_dxf`. The toolset **mixes core and plugin commands**, so it cannot be a purely
  plugin-contributed toolset like `building`: `packages/mcp/src/toolsets.ts` needs `'manufacturing'` added to the fixed
  `TOOLSET_NAMES` tuple, a core word list for the `commands/features` names, and a getter that appends
  `pluginToolNames('manufacturing')` for the sheet-metal plugin (keeping the "each tool in exactly one toolset"
  invariant). The `toToolSchemas()`/toolset contract snapshots change accordingly (VC-FTR-31).
- **CLI**: no new verbs. `llull <command> …`, `llull run plan.json`, and `--save` for `export_flat_pattern_dxf`. Add one
  `guide` paragraph: the K-factor is explicit, and lengths reference mold lines.
- **UI**: a Hole panel (type picker with section preview, presets 82/90/100°, fastener picker after gap 08), a Pocket
  panel, a Sheet-metal panel (rule, flange, joggle), a Flat-pattern toggle (2D ortho view of the derived flat entities),
  and a Feature table panel (sortable; selecting a row highlights its face indices). All of them gather params and
  `dispatch`. They never build entities (L4).
- **MCP prompt** (optional): `design_sheet_bracket`, a short workflow that ends with check, flat pattern and DXF.

## 8. Performance & robustness budgets

| Operation | Budget (desktop OCC, warm) |
| --------- | -------------------------- |
| `add_hole` with 100 positions (lowered, compound tool, one boolean) | < 1.5 s |
| `add_pocket` rounded rectangle + floor fillet | < 400 ms |
| `flat_pattern` native part with ≤ 50 bends | < 50 ms (pure TS) |
| `faceGraph` + `recognize_features` on NIST CTC-02 (637 faces in the file) | < 5 s; the scratch survey (Python/OCP, O(n²) adjacency) took 5.7 s for all 8 files, so production must use the edge→faces map |
| Memory | `faceGraph` results cached by `recipeKey` (same LRU as shapes) |

Robustness: every kernel null → no-op with summary (existing pattern). Recognition never throws: unknown topology goes
to `unclassified[]`. `add_hole` validates all positions first, so it is all-or-nothing.

## 9. Test strategy (mapped to VC ids)

| Layer | Tests | VC |
| ----- | ----- | -- |
| `tests/unit/lib/sheetMath.test.ts` | table-driven from `validation/data/expected_flat_pattern.json` (FP-01…12, JG-01…04), DIN↔ANSI, K-table interpolation and clamping | VC-FTR-01…05, 11, 35 |
| `tests/unit/lib/holeMath.test.ts` | `expected_countersink.json` (CS-01…07, DP-01…03), `expected_pocket.json` | VC-FTR-22…24, 27 |
| `tests/unit/commands/features/*.test.ts` | happy + failure per command, `is pure`, feature step appended, thread does not change `recipeKey` | VC-FTR-28, 31 |
| `tests/unit/plugins/sheetmetal/*.test.ts` | rule/base/flange/joggle/unfold with no kernel (analytic flat pattern), checks with a 2-row synthetic radius table | VC-FTR-07, 10, 11, 16 |
| `server/tests/occtFeatures.test.ts` (OCC, Node) | native vs lowered hole/pocket volumes; machined plate plan volume 55978.529153; bracket volume 5279.716754; baseline plan 59783.006014 | VC-FTR-06, 08, 25, 26 |
| `server/tests/recognition.test.ts` | import `validation/data/*.step` + NIST CTC-01 (vendored) → `expected_feature_recognition.json`; CTC-02…05 fetched by `quality/fetchCorpus.mjs` with sha256 pin | VC-FTR-17…21 |
| `tests/golden/plans.ts` | `sheet_metal_bracket`, `machined_plate` plans (id-normalised snapshots + replay equality); parametric thickness change | VC-FTR-30 |
| Contract | `toToolSchemas()` snapshot gains the new tools; toolset membership | VC-FTR-31 |
| DXF | parse output with a strict reader (ezdxf in the Python test env, or the existing core `import_dxf`); only allowed entity types; extents | VC-FTR-09 |
| Quality gate (`npm run quality`) | add the NIST CTC set to `quality/corpus.json` for recognition timing and crash-free runs | VC-FTR-21 |
| Production gate scenario | "MRO angle repair": calc → rule → part → check → DXF, all via CLI on desktop | VC-FTR-02, 09, 10 |

## 10. Delivery plan

| Milestone | Content | Depends on | Effort (eng-days) |
| --------- | ------- | ---------- | ----------------- |
| M0 Exact STEP import (prerequisite) | Consume gap 01 `import_step_brep` (`docs/aerospace/01-exact-brep-kernel/`): imported STEP solids keep a `brep`. Not designed here | gap 01 | 0 here (effort owned by gap 01); ~1 day integration tests in M4 |
| M1 Math + calc | `lib/sheetMath.ts`, `lib/holeMath.ts`, `sheet_metal_calc` (plugin skeleton, toolset) | D1 decided | 4 |
| M2 Holes & pockets (lowered) | `feature` recipe node, `featureLowering.ts`, `add_hole`, `add_pocket`, `set_thread`, `check_machining`, codegen `cskHole`/`cboreHole` | M1 | 8 |
| M3 Native sheet metal | model, rule, base, flange, fold, analytic unfold, `flat_pattern`, `check_sheet_metal`, radius table import; DXF writer moved to core + `export_flat_pattern_dxf` | M1, D4 | 12 |
| M4 Face graph + recognition | `faceGraph` (OCC), recognition holes/pockets/fillets/chamfers, split-face merge, NIST tests | M2, M0 | 10 |
| M5 V1 sheet features | relief, corner relief, joggle, flanged hole, bead, `convert_to_sheet_metal` | M3, M4 (M0 for imported parts) | 12 |
| M6 Fastener link + tables | `FastenerRef`, hole/bend tables for drawings | gap 08, drawings | 5 |
| M7 OCC native features | `occtFeatures.ts` with `BRepFeat_MakePrism` (pockets) and `BRepFeat_MakeRevol` (revolved hole tool) behind `supports('feature')`, parity tests vs lowering; holes/ribs stay lowered | D3 spike | 3 |
| M8 V2 | hem, contour flange, recognised→parametric, modelled thread, isogrid | M5 | 15 |

## 11. Open questions / decisions needed

| Id | Question | Proposal |
| -- | -------- | -------- |
| D1 | New package `packages/domain-mfg` (sheet-metal plugin) vs adding sheet metal to core | New plugin package (L10: a domain with its own model and tables). Needs user approval because it changes the layer map in CLAUDE.md. Wiring it needs: an `@mfg/*` alias in `tsconfig.base.json` (read by Vite/Vitest through `workspaceAliases.ts`); `packages/domain-mfg/package.json` (picked up by the existing `packages/*` workspace glob); `.dependency-cruiser.cjs` rules extended so `domain-mfg` gets the same L2/L10 constraints as `domain-aec` (core public surface only, no other plugin, no DOM); `.claude/hooks/enforce-architecture.mjs` path rules; CLAUDE.md LAYER MAP + `.claude/rules/architecture.md` L2 line + W5 lane table (Lane 1 owns `packages/domain-mfg/src/**`); coverage gate scope (`packages/domain-mfg/src/**` alongside domain-aec); `installDefaultPlugins()` registration. |
| D2 | Should `feature` be a recipe node, or should commands emit lowered boolean trees directly? | A recipe node: it keeps semantics for code export, drawings, recognition round trip and native OCC. Lowering stays the fallback. |
| D3 | Does opencascade.js@1.1.1 expose `BRepFeat_MakePrism` / `MakeCylindricalHole` / `MakeLinearForm`? | Partly answered by the review probe (§1): `MakePrism`/`MakeRevol` construct; `MakeCylindricalHole` is not constructible and `MakeLinearForm` is absent. Remaining 1-day spike (as KI4): exercise `MakePrism`/`MakeRevol` `Perform*` end to end. Holes and ribs stay on lowering in the in-process kernel. On desktop, OCP/CadQuery could be used, but the in-process OCC worker is preferred. |
| D4 | Move `dxfWriter.ts` from domain-aec to core `lib` | Yes for the generic part only: the low-level R12 writer (`DxfWriter` entity methods, `INSUNITS`, `dxfLayerName`, `dxfText`) moves to `lib` with only `model/vectors` types; `writePrimitive`, layer colours, hatch and dimension handling stay in domain-aec (they import `geometry`/AEC modules, which `lib-is-a-leaf` forbids). domain-aec then imports the writer from core (direction allowed by L2). |
| D9 | Exact STEP import (keep `brep` on imported parts) | Use gap 01 `import_step_brep` (`docs/aerospace/01-exact-brep-kernel/`) (milestone M0). Its internals are owned by gap 01; this gap only requires that the imported entity carries a `brep` the kernel can evaluate for `faceGraph`. |
| D5 | Default countersink preset for aerospace (100°) | Confirm from gap 08 catalogue data / NASM documents before it becomes a default. Until then it is a named preset with the "unverified" note in the UI tooltip. |
| D6 | Minimum bend radius seed data | Transcribe AC 43.13-1B Table 4-6 from the FAA PDF with dual review. Store `source` and edition per row. |
| D7 | Thread designation grammar (UNJ, MJ) | Accept free text with a light per-family regex. Full validation only with licensed AS8879 / ISO 5855 data via gap 08. |
| D8 | Flat pattern as a query only or as materialised 2D entities | Both. A query by default, and `materialize: true` for drawings and DXF via the existing 2D pipeline. |

## 12. References

- [R1]–[R15] as listed in `validation/sources.md` (FAA AC 43.13-1B, EAA, FAA-H-8083-31B, NIST MBE PMI, usnistgov/CAD-PMI-Testing, FreeCAD SheetMetal, FreeCAD PartDesign Hole, FreeCAD Fasteners, OCCT headers, NIST CTC mirror, cadquery-ocp, Web3D, The Fabricator, NIST AMS 100-10).
- [R16] CadQuery `cadquery/cq.py` @5f5bc62b255f62e3512105740025361b6c31eddd (`hole`, `cboreHole(diameter, cboreDiameter, cboreDepth, depth)`, `cskHole(diameter, cskDiameter, cskAngle, depth)`) — CadQuery / GitHub — https://github.com/CadQuery/cadquery/blob/master/cadquery/cq.py (accessed 2026-10, fetched)
- llull: `docs/decisions/KI5-shape-kernel-boundary.md`, `KI6-desktop-app-cli-first.md`, `KI4-occt-spike.md`, `.claude/rules/architecture.md`.
