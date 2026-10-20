# SRF — Advanced freeform surfacing & aerodynamic geometry — Technical specification

Gap id: **SRF** · Companion: [FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md) · Validation: [validation/README.md](validation/README.md) ·
Laws: `.claude/rules/architecture.md` L1–L10 · Decisions: KI5 (shape boundary), KI6 (desktop + CLI first).

---

## 1. Current state in llull

### 1.1 Relevant commands and code

| Capability | Command | Files | What it really does | Limits for aerospace |
| --- | --- | --- | --- | --- |
| Loft through sections | `loft_sections` | `packages/core/src/commands/solids/loft.ts` (126 lines), `geometry/sectionRing.ts`, `geometry/skin.ts`, OCC: `packages/kernel-occt/src/occtCurves.ts` `skinnedSolid` | Every section is **resampled to `SECTION_RING_POINTS` = 24** arc-length points starting at the +x crossing, aligned (no twist), stored as `LoftEntity.rings` (Catmull-Rom closed curves); OCC builds one cubic Bézier edge per ring point and `BRepOffsetAPI_ThruSections(true, ruled, 1e-6)` with `CheckCompatibility(false)` | Section shape not preserved (NACA 0012: −2.0 % area, 1.1 % c deviation for the linear 24-gon, §validation 4); sharp TE rounded; no guides, no end conditions, solids only; max 200 sections |
| Sweep | `sweep_profile` | `commands/solids/sweep.ts` (259), `geometry/sweep.ts`, OCC `sweptSolid` | Constant section: `BRepOffsetAPI_MakePipe_2` with corrected-Frenet trihedron; variable section (`stations`): ThruSections through 8 skin sections per path segment because **`BRepOffsetAPI_MakePipeShell.Build` is unusable in this opencascade.js build** (comment in `occtCurves.ts`) | No guide curve, no auxiliary spine/binormal mode, no scaling law; path must be G1 |
| Boundary patch | `surface_from_curves` | `commands/solids/surfaceFromCurves.ts` (96), `geometry/boundaryPatch.ts` | 2 or 4 boundary curves → Coons-like **subdivision cage** thickened into a closed solid; curves only followed "within the smoothing of a cells grid" | Not interpolating, not an open sheet, no continuity to neighbours |
| Subdivision solids | `add_subdivision_solid`, `edit_subdivision_cage` | `commands/solids/subdivision*.ts`, `geometry/subdivision*.ts`, OCC `occtPatches.ts` | Catmull-Clark cage; OCC converts each bicubic patch to a B-spline face via a `GeomFill_BSplineCurves` Coons placeholder whose 16 poles are overwritten (no 2D pole array binding), sewn with `BRepBuilderAPI_Sewing` | Good for organic shapes; not dimension-driven, not for airfoils |
| 2D spline | `draw_spline` | `commands/draw2d/curves.ts`, `model/types.ts` `SplineEntity` | Centripetal Catmull-Rom through points; no control polygon/degree/weights | Not NURBS; cannot carry conics or imported B-splines |
| Curve pieces | — | `model/curve.ts` `CurveSegment<P>` | `line`, `arc` (3 points), cubic `bezier` | No rational/B-spline segment |
| Topology query | `inspect_topology` | `commands/brep/topology.ts`, OCC `occtTopology.ts` | Faces/edges with `FaceSurface` (`plane`…`bspline`) and `EdgeCurve` types, areas, lengths | No curvature, normals, continuity, poles/knots |
| Measurement | `measure_*`, `mass_properties`, `check_model` | `commands/inspect/*` | Volume/area/bbox | No surface analysis |
| Kernel port | `GeometryKernel` | `packages/core/src/geometry/kernel.ts` | `supports`, `evaluate(recipe)`, `tessellate`, `topology`, `exportStep` (sync, no async) | No surface/curve evaluation or analysis methods |
| Recipe | `ShapeRecipe` | `model/types.ts` (type), `geometry/shapeRecipe.ts` (`recipeKey`, validation) | Leaves `solid` (entity) + `boolean`, `fillet`, `chamfer`, `blend`, `shell`, `place`, `scale` | No `sew`, `trim`, `fill`, `thicken`, `offset`; leaves must be closed solids |

Toolsets (`packages/mcp/src/toolsets.ts`): the 3D toolset lists `sweep_profile loft_sections … add_subdivision_solid
edit_subdivision_cage surface_from_curves`; `TOOLSET_NAMES` = `core, 2d, 3d, measure, parametric, assembly, exchange,
building, civil` (no `surface`, no `aero`). No code mentions NACA, airfoil, curvature analysis or zebra
(`grep -ri "naca\|airfoil\|zebra"` over `packages/` returns nothing relevant).

### 1.2 Kernel binding facts (opencascade.js 1.1.1 = OCCT V7_4_0p1 [R13])

From `dist/Supported APIs.md` of the pinned tag (green = bound):

| OCCT class | Bound in 1.1.1 | Use in this gap |
| --- | --- | --- |
| `GeomAPI_Interpolate` | **no** | curve interpolation → do it in core (Piegl & Tiller A9.1) and build `Geom_BSplineCurve` from poles/knots |
| `GeomFill_NSections` | **no** | — (use ThruSections) |
| `Geom_BSplineCurve`, `Geom_BSplineSurface`, `GeomAPI_PointsToBSpline(Surface)`, `GeomConvert_CompCurveToBSplineCurve` | yes | exact entities, surface fit |
| `BRepOffsetAPI_ThruSections`, `BRepOffsetAPI_MakePipeShell` (Build unusable per llull), `GeomFill_Pipe`, `GeomFill_Generator`, `GeomFill_BSplineCurves`, `GeomFill_ConstrainedFilling` | yes | loft, sweep, 2–4-sided fill |
| `BRepOffsetAPI_MakeFilling`, `BRepFill_Filling`, `GeomPlate_BuildPlateSurface` | yes | N-sided fill |
| `GeomLProp_SLProps`, `BRepLProp_SLProps`, `BRepAdaptor_Surface`, `LocalAnalysis_SurfaceContinuity`, `LocalAnalysis_CurveContinuity` | yes | curvature, continuity |
| `BRepBuilderAPI_Sewing`, `BRepOffsetAPI_MakeOffsetShape`, `BRepOffsetAPI_DraftAngle`, `BRepExtrema_DistShapeShape`, `GeomAPI_ProjectPointOnSurf`, `BRepAlgoAPI_Section`, `ShapeFix_Shape`, `BRepCheck_Analyzer`, `BRepGProp` | yes | sew, thicken, draft, deviation, trim, validity |
| `TColgp_Array2OfPnt` | not listed (typedef) | llull already works around 2D pole arrays (`occtPatches.ts`) — keep that technique or custom build |

"Bound" ≠ "works": every class used must get an integration test in `server/tests/` (TR-SRF-11; §9 "Kernel integration").

## 2. Target architecture

### 2.1 Layer placement

| Piece | Layer | Why (law) |
| --- | --- | --- |
| NURBS math (basis functions, evaluation, derivatives, knot insertion, degree elevation, interpolation, approximation, conic ⇄ rational quadratic, curvature formulas, continuity measures) | `packages/core/src/lib/nurbs/*` (pure leaf) + `packages/core/src/geometry/nurbs*.ts` | Pure math, reused by core commands and plugins; no kernel needed (L2, L9) |
| Entity kinds `nurbs_curve`, `nurbs_surface` | `packages/core/src/model/types.ts` + render branches | General geometry (marine, automotive, product design also need it) — core, not aero (L7, L10) |
| Surface commands (create/interpolate/loft/fill/trim/sew/thicken/edit) and analysis queries | new core feature catalog `packages/core/src/commands/surface/catalog.ts` | Domain-neutral (L5) |
| Aerodynamic commands (airfoil import/generate/normalise/metrics, wing, fuselage by stations, conic master lines, `.vsp3` import) | new plugin package `packages/domain-aero/src/` (`@aero`), toolset `aero`, installed in `src/app/plugins.ts` | Domain capability ⇒ plugin (L10); core never imports it |
| Aero definition data (`AeroModel`: airfoils, wings, bodies) | `packages/core/src/model/aero.ts`, `CadDocument.aero?` (same pattern as `building` / `civil`) + plugin `DocumentExtension` (validate / derivedEntityIds / restore) | Recipe-as-document (L8); derived surfaces are read-only and re-derived (derivation guards) |
| Exact operations (loft with guides, fill, trim, sew, thicken, curvature on B-rep faces, continuity on B-rep edges, deviation, draft) | `GeometryKernel` additions + `packages/kernel-occt/src/occtSurfacing.ts`, `occtAnalysis.ts` | Kernel only via `ctx.kernel`, `requiresKernel: true` (L9) |
| Visual analysis (comb, zebra, curvature map, draft map) | `src/ui/viewport/3d/analysis/*` shaders/overlays fed by query `data` | Presentation only; never mutates (L1, L4) |
| CLI/MCP | nothing special: registry → toolsets `surface`, `aero` | L5, L6, KI6 |

### 2.2 Data flow

```
UI / CLI / MCP ──execute──> airfoil_from_naca (plugin) ──> doc.aero.airfoils[id] + derived nurbs_curve entity
                         └─> create_wing (plugin) ──> doc.aero.wings[id]; derive: per-section nurbs_curve (placed),
                                                     loft recipe → kernel ThruSections → mesh entity { brep: recipe }
                         └─> check_continuity (core query) ──> ctx.kernel.analysis.edgeContinuity(handle, edge, samples)
                                                              (or core NURBS math for nurbs_* entities)
```

### 2.3 Laws check

- L1/L5: every operation is a `defineCommand`; analysis are query commands (`data`, no document change).
- L3: commands return a new document; NURBS arrays are frozen copies.
- L8: ids step-scoped; wing/fuselage definitions are document data, derived entities re-derived on load.
- L9: core NURBS math is **not** a kernel (it does not create B-rep); exact B-rep ops go through `ctx.kernel`.
  Manifold (mesh kernel) gets `supports('sew'|'trim'|'fill'|'thicken') = false` and the commands no-op with
  the standard kernel refusal (like `fillet_edge`).
- L10: aero plugin uses only the public core API (`model`, `lib`, `geometry`, `plugins/plugin`,
  `commands/{schema,types,noop,derivation,registry}`) and composes core commands via `execute`.
- **Tension to surface (decision D1, §11):** open sheets (`nurbs_surface`) are 3D entities that are not closed
  solids. `is3D` today means "solid"; mass properties, booleans and `ShapeRecipe` leaves assume closed solids.
  Proposed: a third predicate `isSheet(kind)` (and `isCurve3D`) with explicit refusals in solid-only commands.

## 3. Data model

```ts
// packages/core/src/model/nurbs.ts  (core model; pure data)
export interface NurbsCurveData {
  readonly degree: number;                       // 1..25 (OCC Geom_BSplineCurve::MaxDegree = 25)
  readonly poles: ReadonlyArray<Vec3>;           // n+1 control points (local to entity position/rotation)
  readonly weights?: ReadonlyArray<number>;      // absent ⇒ non-rational; all > 0; length = poles.length
  readonly knots: ReadonlyArray<number>;         // distinct, strictly increasing
  readonly multiplicities: ReadonlyArray<number>;// Σ mult = poles + degree + 1 (non-periodic)
  readonly periodic: boolean;
}
export interface NurbsSurfaceData {
  readonly degreeU: number; readonly degreeV: number;
  readonly poles: ReadonlyArray<ReadonlyArray<Vec3>>;   // [u][v]
  readonly weights?: ReadonlyArray<ReadonlyArray<number>>;
  readonly knotsU: ReadonlyArray<number>; readonly multsU: ReadonlyArray<number>;
  readonly knotsV: ReadonlyArray<number>; readonly multsV: ReadonlyArray<number>;
  readonly periodicU: boolean; readonly periodicV: boolean;
}
/** Trim loop in (u,v) space, outer CCW, holes CW; curves as 2D NURBS. */
export interface UvTrimLoop { readonly curves: ReadonlyArray<NurbsCurve2Data>; readonly outer: boolean }

// packages/core/src/model/types.ts — new entity kinds
export interface NurbsCurveEntity extends BaseEntity { readonly kind: 'nurbs_curve'; curve: NurbsCurveData; planar?: boolean }
export interface NurbsSurfaceEntity extends BaseEntity {
  readonly kind: 'nurbs_surface';
  surface: NurbsSurfaceData;
  trims?: ReadonlyArray<UvTrimLoop>;     // absent ⇒ natural boundary
}
// LoftEntity v3 (backward compatible): exact sections replace resampled rings when present
export interface LoftEntity extends BaseEntity {
  readonly kind: 'loft';
  rings: ReadonlyArray<ReadonlyArray<Vec3>>;          // legacy (kept for v2 documents and Manifold display)
  ruled: boolean;
  sections?: ReadonlyArray<NurbsCurveData>;           // exact, local frame; when present the kernel uses these
  guides?: ReadonlyArray<NurbsCurveData>;
  startCondition?: LoftEndCondition; endCondition?: LoftEndCondition;
  solid?: boolean;                                    // default true (legacy); false ⇒ open sheet
}
export type LoftEndCondition = { readonly type: 'free' } | { readonly type: 'tangent'; readonly direction: Vec3; readonly weight: number }
  | { readonly type: 'point'; readonly point: Vec3 };   // apex (nose/tail of a body)

// packages/core/src/model/aero.ts — domain definition (pattern of building.ts / civil.ts)
export interface AeroModel {
  readonly frame: AircraftFrame;
  readonly airfoils: Readonly<Record<string, AirfoilDef>>;
  readonly wings: Readonly<Record<string, WingDef>>;
  readonly bodies: Readonly<Record<string, BodyDef>>;
}
export interface AircraftFrame {               // FS/BL/WL lofting coordinates (FUNCTIONAL §8)
  readonly datum: Vec3;                        // world position of FS 0 / BL 0 / WL 0
  readonly fsAxis: Vec3; readonly blAxis: Vec3; readonly wlAxis: Vec3;  // orthonormal, right-handed; default +X aft, +Y right, +Z up
  readonly units: 'in' | 'mm' | 'm';
}
export type AirfoilSource =
  | { readonly type: 'naca4'; readonly designation: string; readonly closedTe: boolean }
  | { readonly type: 'naca5'; readonly designation: string; readonly closedTe: boolean }
  | { readonly type: 'points'; readonly format: 'selig' | 'lednicer' | 'xy'; readonly name: string; readonly sha256: string;
      readonly points: ReadonlyArray<Vec2> };          // raw coordinates kept (document = recipe)
export interface AirfoilDef {
  readonly id: string; readonly source: AirfoilSource;
  readonly normalize: 'none' | 'chord';
  readonly fit: { readonly kind: 'interpolate' | 'approximate'; readonly tolerance: number; readonly splitAtTe: boolean };
  readonly entityId: string;                          // derived nurbs_curve (planar, chord 1, LE at origin)
}
export interface WingSection { readonly airfoilId: string; readonly span: number; readonly chord: number; readonly twistDeg: number;
  readonly xOffset?: number; readonly zOffset?: number }          // explicit LE offsets override sweep/dihedral
export interface WingDef {
  readonly id: string; readonly origin: Vec3; readonly sections: ReadonlyArray<WingSection>;
  readonly segments: ReadonlyArray<{ readonly sweepDeg: number; readonly sweepLocation: number; readonly dihedralDeg: number }>;
  readonly twistLocation: number;                     // chord fraction, default 0.25 (OpenVSP Twist_Location default)
  readonly loft: 'linear' | 'smooth'; readonly mirror: boolean; readonly tip: 'flat' | 'round' | 'open';
  readonly entityIds: ReadonlyArray<string>;          // derived solids / sheets
}
export interface BodyStation { readonly fs: number; readonly section: BodySection }
export type BodySection =
  | { readonly type: 'circle'; readonly r: number; readonly wlCenter: number }
  | { readonly type: 'ellipse'; readonly halfBreadth: number; readonly halfHeight: number; readonly wlCenter: number }
  | { readonly type: 'superellipse'; readonly halfBreadth: number; readonly halfHeight: number; readonly exponent: number; readonly wlCenter: number }
  | { readonly type: 'conic'; readonly upper: ConicHalf; readonly lower: ConicHalf; readonly wlMaxBreadth: number; readonly halfBreadth: number }
  | { readonly type: 'point'; readonly wl: number }  // nose / tail apex
  | { readonly type: 'curve'; readonly entityId: string };
export interface ConicHalf { readonly wlExtreme: number; readonly rho: number }  // crown or keel WL; shoulder rho in (0,1)
export interface BodyDef { readonly id: string; readonly stations: ReadonlyArray<BodyStation>;
  readonly controlCurves?: ReadonlyArray<{ readonly role: 'crown' | 'keel' | 'max_breadth' | 'shoulder_upper' | 'shoulder_lower'; readonly entityId: string }>;
  readonly continuity: 'G1' | 'G2'; readonly entityIds: ReadonlyArray<string> }
```

```ts
// Agent-first fields (AGENT_FIRST.md AF-31..35), core model/surfaceQuality.ts
export interface InputProvenance {                       // on AirfoilSource 'points', imported point sets, reference shapes
  readonly verified: boolean;                            // true only with a pinned source (URL + sha256) or a generator formula
  readonly source?: string;                              // e.g. "UIUC naca23012.dat via AeroSandbox edad83dd, sha256 …"
}
export interface NamedTolerance { readonly value: number; readonly unit: string; readonly source: string; readonly defaulted: boolean }
export interface SurfaceWaiver {                         // FR-SRF-43; CadDocument.surfaceQuality?.waivers
  readonly id: string; readonly code: string;            // finding code being waived, e.g. SRF_CHECK_G2_CURVATURE
  readonly target: { readonly entityId: string; readonly edgeIndex?: number; readonly edgesNear?: Vec3 };
  readonly reason: string; readonly requestedBy: 'agent' | 'human';
  readonly approvalRef?: string;                         // 09 PLM approval id; set only when record_approval succeeded for a human caller
}
// Propagation rule: a derived entity or query result is `unverified` iff any input in its recipe / definition chain has
// provenance.verified = false. Computed on read from the recipe (not stored), so it cannot be lost or cleared.
```

Document version / migration:

- `CadDocument.aero?` is optional (absent until the first aero command) — no migration for existing files.
- New entity kinds and optional `LoftEntity` fields are additive; persistence schema version stays **2**
  unless the persistence guard (`commands/persistence/guards.ts`) needs a version bump to reject unknown kinds in
  older readers — decision D3. Old `loft` entities keep `rings`; new ones also write `rings` (display fallback for
  Manifold) computed from the exact sections.
- `recipeKey` (`shapeRecipe.ts`) already hashes all non-presentation fields, so the new fields are cached correctly.

## 4. Commands

Notation: Q = query (no document change, returns `data`), M = mutating. K = `annotations.requiresKernel: true`.
All names snake_case; all params one inline `z.object`. Tags follow `rules/commands.md`.

### 4.1 Core — `commands/surface/catalog.ts` (toolset `surface`)

| Command | Q/M | K | Params (sketch) | @affects | @invariant | @failure |
| --- | --- | --- | --- | --- | --- | --- |
| `create_nurbs_curve` | M | – | `degree`, `poles: vec3[]`, `weights?`, `knots?` (default clamped uniform), `multiplicities?`, `periodic?`, style | 1 `nurbs_curve` | knot/multiplicity/weight consistency (§5.1) | bad degree, inconsistent knots, weight ≤ 0 → no-op |
| `interpolate_curve` | M | – | `points: vec3[]` (2..10 000), `parameterization: 'chord'\|'centripetal'\|'uniform'`, `degree` (default 3), `startTangent?`, `endTangent?`, `periodic?`, `planeOf?` (2D sketch id) | 1 `nurbs_curve` through all points | passes through every point within 1e-9 | < degree+1 points, coincident consecutive points → no-op |
| `approximate_curve` | M | – | `points`, `tolerance`, `degreeMin/Max`, `smoothing?` | 1 `nurbs_curve` | max point distance ≤ tolerance (reported) | tolerance unreachable with ≤ 10 000 poles → no-op |
| `create_conic` | M | – | `start`, `end`, `apex` (tangent intersection) or `startTangent`+`endTangent`, `rho` (0,1) or `shoulder` point | 1 rational quadratic `nurbs_curve` | weight w = rho/(1−rho) (§5.4) | rho ∉ (0,1), collinear points → no-op |
| `create_nurbs_surface` | M | – | degrees, pole grid, weights?, knots? | 1 `nurbs_surface` | grid rectangular | inconsistent → no-op |
| `surface_from_points` | M | – | `grid: vec3[][]`, `mode: 'interpolate'\|'approximate'`, `degreeMin/Max`, `tolerance` | 1 `nurbs_surface` | max grid deviation ≤ tolerance | ragged grid → no-op |
| `edit_nurbs` | M | – | `id`, one of `movePole{i,j?,to}`, `setWeight`, `insertKnot{u,times}`, `elevateDegree{by}`, `reverse` | modifies 1 entity | shape unchanged for insertKnot/elevateDegree (≤ 1e-12) | index out of range → no-op |
| `loft_surface` | M | K for exact | `sectionIds` (curves/2D sketches, ordered) **or** inline `sections`, `guideIds?`, `ruled?`, `solid?`, `startCondition?`, `endCondition?`, `parameterization?`, `maxDegree?` | 1 `loft` (v3) | each section reproduced within 1e-6 × section size; sections not resampled | < 2 sections, incompatible guide (does not meet every section within tol) → no-op |
| `sweep_surface` (V1) | M | K | `sectionId`, `pathId`, `mode: 'corrected_frenet'\|'fixed'\|'binormal'\|'auxiliary'`, `auxiliaryId?`, `scaleLaw?`, `twistLaw?`, `solid?` | 1 sweep / mesh-with-brep | path G1 | MakePipeShell unavailable → fall back to station skinning (existing) with summary |
| `fill_surface` | M | K | `boundary: {entityId, edgeIndex?\|edgesNear?, continuity:'G0'\|'G1'\|'G2'}[]` (3..12), `points?`, `tolerances?` | 1 sheet (mesh+brep) | achieved G0/G1 reported in `data` | open loop, kernel refusal → no-op |
| `trim_surface` | M | K | `id`, `by: {curveIds?, planes?, projectAlong?}`, `keep: 'inside'\|'outside'\|point` | replaces 1 entity | result inside original | trimming curve misses surface → no-op |
| `sew_surfaces` | M | K | `ids`, `tolerance` (default 1e-6 × model size), `makeSolid` | removes N, creates 1 | 0 free edges when `makeSolid` | free edges remain (listed) → no-op |
| `thicken_surface` | M | K | `id`, `thickness`, `side: 'normal'\|'reverse'\|'both'` | 1 solid | | offset self-intersects → no-op |
| `blend_surfaces` (V2) | M | K | `faceA`, `faceB`, `edgeA`, `edgeB`, `continuity: 'G1'\|'G2'` | 1 sheet | | |
| `inspect_nurbs` | Q | K for faces | `id` (+ `faceIndex?` / `edgeIndex?`) | — | returns degree, knots, mults, weights, poles count, rational/periodic, continuity class | non-B-spline face → `data.type` |
| `analyze_curve_curvature` | Q | K for edges | `id`, `edgeIndex?`, `samples` (count) or `parameters[]`, `combScale?` | — | `data.samples[] {t, s, point, tangent, curvature, radius, dCurvatureDs, torsion, comb}` | |
| `analyze_surface_curvature` | Q | K for B-rep faces | `id`, `faceIndex?`, `samples: [u,v][]` or `grid: [nu,nv]` (≤ 200×200) | — | `data {samples[] {u,v,point,normal,k1,k2,dir1,dir2,K,H}, min/max K,H}` | singular point → sample flagged `degenerate` |
| `check_continuity` | Q | K for B-rep | `pairs: {a:{id,edge?|end?}, b:{…}}[]` **or** `id` + `edges: 'internal'\|number[]`, `samples` (default 21), tolerances `g0`, `g1AngleRad`, `g2Rel`, `g2Abs`, `g3Rel` | — | `data.joints[] {g0Gap, g1Angle, g2Gap, g2Rel, g3Gap, order:'G0'..'G3', pass, worst:{t,point}}` | |
| `analyze_draft` | Q | K | `id`, `pullDirection`, `minDraftDeg`, `grid` | — | `data {samples[] {point, draftDeg}, areaBelowMin, undercut}` | |
| `measure_deviation` | Q | K | `id` (target) + one of `points: vec3[]`, `pointsCsv` (exchange), `referenceId` ; `tolerance?` | — | `data {max, mean, rms, signed, histogram, pass}` | |
| `check_surface_quality` | Q | K for B-rep | `ids?` (default all surfaces / lofts / wings / bodies), `purpose: 'design' \| 'release'` (default design), tolerances `g0`, `g1AngleRad`, `g2Rel`, `g3Rel`, `sectionDeviation`, `sewing` (each optional; omitted ⇒ named default), `pullDirection?` + `minDraftDeg?` | — | `data {status: 'pass'\|'warn'\|'fail', findings[] {code, severity, entityId, edgeIndex?, value, limit, unit, worst {point}, remediation, waiverStatus?}, tolerances: Record<string, NamedTolerance>, unverified, reviewRequired, reviewReason?, provenance}` (FR-SRF-39..44) | invalid ids → `SRF_ENTITY_NOT_FOUND` |
| `request_surface_waiver` | M | – | `code`, `entityId`, `edgeIndex?` / `edgesNear?`, `reason` (text) | 1 pending `SurfaceWaiver` | `approvalRef` never settable by params; only the 09 PLM approval link sets it | unknown code / no matching finding → `SRF_WAIVER_NO_FINDING` |

### 4.2 Plugin `@aero` — `packages/domain-aero/src/<topic>/{catalog,plugin}.ts` (toolset `aero`)

| Command | Q/M | K | Params (sketch) | @affects | @invariant | @failure |
| --- | --- | --- | --- | --- | --- | --- |
| `airfoil_from_naca` | M | – | `designation` (4 digits or 5 digits 210..250 / reflexed COULD), `trailingEdge: 'open'\|'closed'`, `points` (default 161), `spacing: 'cosine'\|'uniform'`, `plane?` (origin, rotation), `chord?` | `aero.airfoils[id]` + derived planar `nurbs_curve` | thickness applied ⟂ mean line; LE at origin, chord along +x | unknown series, t = 0 → no-op |
| `import_airfoil` | M | – | `text` (file content) or `path` (CLI/desktop exchange), `format: 'auto'\|'selig'\|'lednicer'`, `normalize: 'none'\|'chord'`, `fit` | airfoil def + curve | raw points stored with sha256 | < 5 points, non-numeric data, self-intersection → no-op |
| `airfoil_properties` | Q | – | `airfoilId` | — | `data {tMax, xTMax, camberMax, xCamberMax, leRadius, teThickness, teAngleDeg, area, centroid, format, pointCount}` | |
| `create_wing` | M | K for solid | `sections[]` (airfoilId, span, chord — omitted when `planform` resolves it, twistDeg, offsets?), `segments[]?` (`{sweepDeg, sweepLocation, dihedralDeg}` per span segment, as `WingDef.segments`) and/or `planform {semiSpan, rootChord, tipChord|taper, area?, aspectRatio?, sweepDeg, sweepLocation, dihedralDeg}`, `twistLocation` (0.25), `loft`, `mirror`, `tip`, `origin` | `aero.wings[id]` + derived loft entity (sections exact; TE edge kept) | any 3 independent planform values resolve the rest; sections ordered by span | over/under-determined planform, non-increasing span → no-op |
| `edit_wing` | M | per op | `id`, partial WingDef | re-derives | | |
| `wing_properties` | Q | – (core math from def) / K for wetted area & volume | `id` | — | `data {span, projectedSpan, areaRef, areaPerSide, aspectRatio, taper, mac, yMac, xLeMac, sweepLeDeg, sweepC4Deg, sweepTeDeg, wettedArea?, volume?}` | |
| `set_aircraft_frame` | M | – | `datum`, `fsAxis`, `blAxis`, `wlAxis`, `units` | `aero.frame` | right-handed orthonormal | |
| `loft_fuselage` | M | K | `stations[] {fs, section}`, `controlCurves?`, `continuity`, `frame?` | `aero.bodies[id]` + derived solid | FS strictly increasing; apex allowed first/last | < 2 stations, conic rho ∉ (0,1) → no-op |
| `fuselage_section_at` | Q | K | `bodyId`, `fs` | — | `data {curve poles, halfBreadth, crownWl, keelWl, area, perimeter}` | |
| `import_openvsp_wing` (COULD) | M | – | `text` (.vsp3 XML), `geomName?` | wing def | NACA 4-series / AF-file XSecs only | unsupported XSec type → no-op with list |

### 4.3 Exchange

`import_airfoil` with `path` and `import_openvsp_wing` read files only in `server/` / CLI (`POST /exchange`,
KI6); in core the command takes `text` (no fs/fetch in packages, L2). `measure_deviation.pointsCsv` likewise.

## 5. Kernel / algorithms

### 5.1 NURBS validity (core, `lib/nurbs/validate.ts`)

- `1 ≤ p ≤ 25`; `poles.length ≥ p + 1`; non-periodic: `Σ mult = n + p + 2` with `n + 1` poles; end
  multiplicities ≤ p + 1, interior ≤ p; knots strictly increasing; weights finite > 0. Periodic: first/last
  multiplicities equal, `Σ mult(excluding last) = poles`. Same rules as OCC `Geom_BSplineCurve` constructors [R12].
- Evaluation: Cox–de Boor basis (A2.2), derivatives (A2.3), rational derivatives via quotient rule (A4.2) [R1].

### 5.2 Interpolation & approximation

- `interpolate_curve`: global interpolation (Piegl & Tiller A9.1) with chord-length (default) or centripetal
  parameters, knot averaging (eq. 9.8), optional end derivatives (§9.2.2), periodic variant; banded LU solve.
  Rationale: `GeomAPI_Interpolate` is not bound in opencascade.js 1.1.1 (§1.2) and core math keeps Manifold/web
  usable (FR-SRF-29). Result handed to OCC as poles/knots (`Geom_BSplineCurve_1`, already used in `occtPatches.ts`).
- Airfoils: split at the LE (min-x / farthest-from-TE point) or keep one periodic-free curve from TE upper to TE
  lower with the LE as an interior interpolated point; sharp TE = curve ends (open TE: a TE line segment closes
  the profile; closed TE: ends coincide, two tangents ⇒ C0 corner kept as an edge). Default fit: interpolate all
  points, cubic, centripetal; for generated NACA, densify (e.g. 401 cosine points) then approximate to 1e-7 c.
- `surface_from_points`: tensor-product global interpolation (A9.4) in core for ≤ 200×200; kernel
  `GeomAPI_PointsToBSplineSurface` (DegMin 3, DegMax 8, C2, Tol3D 1e-3 defaults [R12]) for approximation.

### 5.3 NACA equations (plugin, `naca.ts`)

| Item | Formula | Source |
| --- | --- | --- |
| Thickness | `yt = 5t(0.2969√x − 0.1260x − 0.3516x² + 0.2843x³ − 0.1015x⁴)`; closed TE `−0.1036` | [R2] [R4] |
| 4-digit camber `MPXX` | `m = M/100`, `p = P/10`; `x<p: yc = m/p²(2px − x²)`; `x≥p: yc = m/(1−p)²((1−2p) + 2px − x²)` | [R2] |
| 5-digit standard camber `LPQXX` (Q = 0) | `x<r: yc = k1/6 (x³ − 3rx² + r²(3−r)x)`; `x≥r: yc = k1 r³/6 (1−x)`; mean line 230: `r = 0.2025, k1 = 15.957` (p = 0.15, design cl 0.3) | [R5]; other mean lines (210, 220, 240, 250) and reflexed (Q = 1, k2/k1) constants from TM 4741 [R4] — **to be transcribed and verified from the PDF before implementation (TBD)** |
| Surface | `θ = atan(dyc/dx)`; upper `(x − yt sinθ, yc + yt cosθ)`, lower `(x + yt sinθ, yc − yt cosθ)` | [R2] |
| Spacing | cosine `x_i = ½(1 − cos(π i/(n−1)))` | common practice |
| LE radius (4-digit) | `r_LE = 1.1019 t²` (from `yt ≈ 5t·0.2969√x` ⇒ `r = (5t·0.2969)²/2 = 1.10193 t²`) | derived from [R2] |
| Section area | `A = 10t(0.2969·2/3 − 0.126/2 − 0.3516/3 + 0.2843/4 + a4/5)` (symmetric) = 0.68508 t (open TE) | derived |

### 5.4 Conics (core `lib/nurbs/conic.ts`)

Rational quadratic Bézier `P(t) = ((1−t)²A + 2t(1−t)wT + t²B) / ((1−t)² + 2t(1−t)w + t²)`. Liming's shoulder
point `S = M + rho (T − M)`, `M = (A + B)/2`, equals `P(½)` iff `rho = w/(1 + w)` ⇒ `w = rho/(1 − rho)`;
`rho < ½` ellipse, `= ½` parabola, `> ½` hyperbola; `rho = √2 − 1` (w = cos 45°) with A = (1,0), T = (1,1),
B = (0,1) is the exact unit quarter circle [R1] [R19]. Conic body halves: A = max-breadth point, B = crown (or
keel) point, T = intersection of the vertical tangent at A and the horizontal tangent at B.

### 5.5 Lofts with exact sections (kernel)

- Sections: each `NurbsCurveData` → `Geom_BSplineCurve` edge(s) → wire. **No resampling.** Compatibility:
  ThruSections requires the same number of edges per wire (or `CheckCompatibility(true)` to let OCC split);
  for airfoils use exactly 2 edges (upper, lower) + optional TE segment, so the TE corner stays a B-rep edge
  along the span (it is the wing TE line).
- Smooth: `BRepOffsetAPI_ThruSections(isSolid, ruled=false, pres3d=1e-6)`, `SetSmoothing(false)`,
  `SetParType(Approx_ChordLength)`, `SetContinuity(GeomAbs_C2)`, `SetMaxDegree(8)` (API listed in [R12]);
  linear wing segments: `ruled=true` per segment then `sew_surfaces`, or one ThruSections with `ruled=true`.
- Apex (nose/tail): `AddVertex` (bound) for `endCondition.type = 'point'`.
- Guides: ThruSections has no guide API. Approach: (a) build section-compatible curves, (b) skin via
  `GeomFill_Generator`/ThruSections, (c) for guides, use `BRepOffsetAPI_MakePipeShell` with an auxiliary
  spine/law **if** a custom opencascade.js build fixes `Build` (gap 01 KRN), else (d) core Gordon surface
  (network of sections × guides; boolean sum of two skinnings minus tensor product — Piegl & Tiller §10.5) then
  hand poles to `Geom_BSplineSurface`. (d) is the MVP-safe path because it only needs bound classes.
- Fidelity check after every loft: sample each input section (≥ 64 points) and compute distance to the result
  face set (`BRepExtrema_DistShapeShape`); report `data.sectionDeviation[]`; fail if > `pres3d × 10`.

### 5.6 Curvature & continuity measures (core math for NURBS entities; kernel for B-rep)

- Curve: `κ = |C' × C''| / |C'|³`, `τ = (C' × C'')·C''' / |C' × C''|²`, and (needs C''')
  `dκ/ds = (1/|C'|)·[ ((C'×C'')·(C'×C''')/|C'×C''|)·|C'|³ − 3|C'×C''|·|C'|·(C'·C'') ] / |C'|⁶`
  (quotient rule on κ(t), chain rule ds = |C'| dt). Planar signed form:
  `κ = (x'y'' − y'x'')/|C'|³`, `dκ/ds = [ (x'y''' − y'x''')|C'|² − 3(x'y'' − y'x'')(C'·C'') ] / |C'|⁶`
  — e.g. y = x³ at x = 0 gives dκ/ds = 6 (VC-SRF-06 `line_cubic`). Where |C'×C''| = 0 (inflection) use the
  planar signed form in the osculating plane of the neighbouring samples.
- Surface: first/second fundamental forms `E,F,G,e,f,g` with unit normal `n = Su×Sv/|Su×Sv|`;
  `K = (eg − f²)/(EG − F²)`, `H = (eG − 2fF + gE)/(2(EG − F²))`, `k1,2 = H ± √(H² − K)`. Kernel path:
  `BRepLProp_SLProps(BRepAdaptor_Surface(face), u, v, 2, tol)` → `GaussianCurvature()`, `MeanCurvature()`,
  `MaxCurvature()`, `MinCurvature()`, `CurvatureDirections()` [R12]. Sign convention is OCC's (normal follows face
  orientation); `data` reports both signed H and |H|. Analytic checks: sphere K = 1/R², |H| = 1/R; cylinder K = 0,
  |H| = 1/(2R); torus K = cos v / (r(R + r cos v)) [R26].
- Edge continuity between faces F1, F2 sharing edge E (kernel): sample E at N parameters; for each, find (u,v)
  on both faces (pcurves); compute
  `g0 = |P1 − P2|`; `g1 = angle(n1, ±n2)`; G2 via normal curvature in the direction ⟂ E on both sides:
  `κn_i = II_i(d,d)/I_i(d,d)`, `g2 = |κn1 − κn2|`, `g2Rel = g2 / max(|κn1|,|κn2|, κ_floor)`; G3 via central
  difference of κn across 3 parameter offsets on each side (OCC has no G3: `GeomAbs_Shape` lists C0, G1, C1, G2, C2,
  C3, CN only [R12]). Cross-check G0/G1/G2 against `LocalAnalysis_SurfaceContinuity` (`C0Value`, `G1Angle`,
  `G2CurvatureGap`, `IsG1`, `IsG2`) in tests.
- Curve joints: G1 angle between tangents; G2 curvature-vector difference; G3 `dκ/ds` difference. Classification
  = highest order whose gap is within tolerance at **all** samples. Defaults: `g0 = 1e-6 × model size`,
  `g1AngleRad = 0.01` (OCC filling `TolAng` default), `g2Rel = 0.1` (OCC `TolCurv` default), `g3Rel = 0.1`.
- Degenerate samples (zero first derivative, poles of a sphere, LE apex) are excluded and counted.

### 5.7 Fill, trim, sew, thicken, deviation, draft (kernel)

| Op | OCC path | Tolerances |
| --- | --- | --- |
| N-sided fill | `BRepOffsetAPI_MakeFilling(Degree 3, NbPtsOnCur 15, NbIter 2, Anisotropie false, Tol2d 1e-5, Tol3d 1e-4, TolAng 0.01, TolCurv 0.1, MaxDeg 8, MaxSegments 9)`; `Add(edge, support face, GeomAbs_G1)`; 2–4 sides with B-spline boundaries may use `GeomFill_BSplineCurves` (Stretch/Coons/Curved) or `GeomFill_ConstrainedFilling` | defaults from header [R12] |
| Trim | `BRepAlgoAPI_Section`/split by planes or by curves projected (`BRepProj_Projection`) → `BRepBuilderAPI_MakeFace(surface, wire)`; `ShapeFix_Shape` | model tol |
| Sew | `BRepBuilderAPI_Sewing(tol, true, true, true, false)` (llull's existing options), `NbFreeEdges`, `BRepBuilderAPI_MakeSolid`, `BRepCheck_Analyzer` | `tol` param |
| Thicken | `BRepOffsetAPI_MakeOffsetShape` (thick solid) | |
| Deviation | `BRepExtrema_DistShapeShape` (point vertex vs face set) or `GeomAPI_ProjectPointOnSurf`; signed by normal | |
| Draft | per sample: `draft = 90° − angle(n, pull)` (degrees), < minDraft flagged; undercut where `n·pull < 0` on a pull-facing region | |

### 5.8 GeometryKernel additions (`packages/core/src/geometry/kernel.ts`)

```ts
export interface SurfaceSample { readonly u: number; readonly v: number; readonly point: Vec3; readonly normal: Vec3;
  readonly k1: number; readonly k2: number; readonly dir1: Vec3; readonly dir2: Vec3; readonly gaussian: number; readonly mean: number;
  readonly degenerate: boolean }
export interface EdgeContinuitySample { readonly t: number; readonly point: Vec3; readonly g0: number; readonly g1: number;
  readonly normalCurvature: readonly [number, number]; readonly g3?: number }
export interface EdgeCurveSample { readonly t: number; readonly s: number; readonly point: Vec3; readonly tangent: Vec3;
  readonly curvature: number; readonly dCurvatureDs: number; readonly torsion: number; readonly normal: Vec3 }
// Merged into the single optional kernel face-query port owned by gap 01 (`FaceQueryPort`, `GeometryKernel.faceQuery?`,
// TR-KRN-90..92, docs/aerospace/01-exact-brep-kernel/TECHNICAL_SPEC.md §5.9). The methods below keep these names there; this block states what SRF needs from it.
export interface SurfaceAnalysisPort /* = subset of FaceQueryPort */ {
  faceSamples(shape: ShapeHandle, face: number, uv: ReadonlyArray<readonly [number, number]> | { nu: number; nv: number }): SurfaceSample[] | null;
  edgeSamples(shape: ShapeHandle, edge: number, count: number): EdgeCurveSample[] | null;       // κ, τ, comb
  edgeContinuity(shape: ShapeHandle, edge: number, count: number): EdgeContinuitySample[] | null;
  distance(shape: ShapeHandle, points: ReadonlyArray<Vec3>): Array<{ distance: number; signed: number; face: number }> | null;
  bspline(shape: ShapeHandle, face: number): NurbsSurfaceData | null;                            // inspect_nurbs
}
export interface GeometryKernel { /* … existing … */ readonly faceQuery?: FaceQueryPort }  // gap 01; optional: Manifold omits it
```

`ShapeRecipe` additions (`model/types.ts`): `{ op: 'sew'; sources; tolerance; solid }`, `{ op: 'fill'; boundary:
EdgeRef[]; points; tolerances }`, `{ op: 'trim'; source; tools; keep }`, `{ op: 'thicken'; source; thickness; side }`,
and leaves for `nurbs_surface`/`nurbs_curve`/`loft` v3 entities. `recipeKey` gets matching cases;
`GeometryKernel.supports` reports them; `kernelFromOps` caches as today (KI5). Edge references use index +
`edgesNear` points like `fillet_edge` (KI5 naming rule) until gap 01 delivers persistent naming.

### 5.9 Numerical tolerances (summary)

| Quantity | Default | Note |
| --- | --- | --- |
| Interpolation residual | 1e-9 × size | core solve |
| NACA dense fit | 1e-7 c | VC-SRF-01 needs ≤ 1e-6 c |
| Loft section fidelity | ≤ 1e-5 × section size (pres3d 1e-6 ×10) | reported |
| G0 / G1 / G2 / G3 | 1e-6 × size / 0.01 rad / 10 % rel / 10 % rel | configurable per call |
| Sewing | 1e-6 × size | `sew_surfaces.tolerance` |
| Curvature analytic tests | 1e-6 rel | VC-SRF-05 |

## 6. Interop & persistence

| Item | Format | Notes |
| --- | --- | --- |
| Airfoil import | UIUC `.dat` Selig / Lednicer (text) | auto-detect: second non-empty line has two numbers > 1 ⇒ Lednicer counts [R6]; Latin-1 tolerant; raw points + sha256 stored in `AirfoilSource` |
| Airfoil export | Selig `.dat` (COULD), CSV | from the exact curve at requested spacing |
| OpenVSP | `.vsp3` XML (COULD read: WingGeom `Span`, `Root_Chord`, `Tip_Chord`, `Sweep`, `Sweep_Location`, `Dihedral`, `Twist`, `Twist_Location`, XSec NACA/AF) [R8]; `.af` airfoil (header `Sym Flag`, `Num Pnts Upper/Lower`) | note: the pinned `TR1208.vsp3` stores root chord 16.672 in (the MAC) and tip 7.5024 in, total area 1538.217 in², i.e. **not** the README table values — use the file's own values in import tests (VC-SRF-20) |
| STEP | AP214 now (KI5 `export_step_exact`), AP242 (gap 04) | `B_SPLINE_CURVE_WITH_KNOTS`, `B_SPLINE_SURFACE_WITH_KNOTS`, rational complex entities; trimmed faces as `ADVANCED_FACE` |
| IGES 128 (rational B-spline surface) | gap 04 | many lofting shops still use IGES |
| Code export | CadQuery: `Workplane.spline(...)`, `.loft(ruled=...)`, `cq.Solid.makeLoft`; raw `Geom_BSplineSurface` via OCP for others (`codegen/recipeLowering.ts` pattern) | FR-SRF-28 |
| Document | `CadDocument.aero`, entity kinds `nurbs_curve`, `nurbs_surface`, `loft` v3 fields | §3 |

## 7. CLI / MCP / UI surfaces

- **CLI (primary, AF-01..05)**: nothing gap-specific in the CLI; the registry makes every command callable:
  `llull search airfoil wing curvature continuity` · `llull describe create_wing` · `llull list aero` ·
  `llull run plan.json --validate` then `llull run plan.json --json --progress` · `llull <query> … --json` ·
  `llull check_surface_quality … --json` · `llull render_view isolate=<id> --save view.png` ·
  `llull export_step_exact --save out.step` / `export_code language=cadquery --save out/`. `import_airfoil` and
  `measure_deviation pointsCsv` read files with `file=PATH` through the exchange path (`/exchange`, KI6); in core
  they take `text`. Long kernel steps (`create_wing` with many sections, CRM analysis) honour `--progress` and
  `--timeout` (AF-40); every mutating SRF command works with `--dry-run` (AF-42). `llull guide` gains the aero /
  surface section of FR-SRF-38.
- **MCP**: toolsets `surface` and `aero` appended to `TOOLSET_NAMES`; `search_tools` finds them by keywords
  (airfoil, NACA, wing, curvature, continuity, zebra, G2). Prompt `aero_wing` describes the canonical plan and
  ends with `check_surface_quality`. Query commands declare `annotations: { readOnly: true }`.
- **UI (review surface)**: menus and forms generated from `listCommands()` and zod. Review overlays in
  `src/ui/viewport/3d/analysis/` built only from query `data`: `CurvatureCombOverlay`
  (`analyze_curve_curvature.data.samples[].comb`), `ZebraMaterial` (view-space normal stripes on the existing
  tessellation), `CurvatureMapMaterial` (`analyze_surface_curvature` grid, legend + clamping), `DraftMapMaterial`;
  a `check_surface_quality` report panel; waiver approval through 09 PLM. Nothing here is required by an agent.

### 7.1 Stable error and finding codes (AF-11)

Every refusal returns the unchanged document, exit code 1 on the CLI, and `data.errors[] {code, path, ids,
remediation}`; `--validate` reports the same codes with the plan step path. Check findings use the same shape
inside `check_surface_quality` `data.findings[]` (exit 0; the agent reads `status`).

| Code | Raised by | When | Offending ids / path | Remediation |
| --- | --- | --- | --- | --- |
| `SRF_NURBS_INVALID` | `create_nurbs_curve`, `create_nurbs_surface`, `edit_nurbs` | degree ∉ 1..25, Σ multiplicities ≠ poles + degree + 1, knots not increasing, weight ≤ 0 | `params.degree` / `params.knots` / `params.weights[i]` | fix the named array; omit `knots` for clamped uniform |
| `SRF_POINTS_INSUFFICIENT` | `interpolate_curve`, `approximate_curve`, `surface_from_points` | fewer than degree + 1 points, or a ragged grid | `params.points` / `params.grid[i]` | add points or lower `degree`; make every grid row the same length |
| `SRF_POINTS_COINCIDENT` | `interpolate_curve` | two consecutive points closer than 1e-9 × size | `params.points[i]` | remove the duplicate point |
| `SRF_TOLERANCE_UNREACHABLE` | `approximate_curve`, `surface_from_points` | tolerance not met with ≤ 10 000 poles | `params.tolerance` | raise the tolerance or use `interpolate_curve` |
| `SRF_CONIC_RHO_RANGE` | `create_conic`, `loft_fuselage` | rho ∉ (0, 1) | `params.rho` / `stations[i].section.upper.rho` | use 0 < rho < 1 (0.4142 = circle, 0.5 = parabola) |
| `SRF_CONIC_COLLINEAR` | `create_conic` | start, apex and end collinear | `params.start/apex/end` | move the apex off the chord |
| `SRF_LOFT_SECTIONS_TOO_FEW` | `loft_surface`, `create_wing`, `loft_fuselage` | fewer than 2 sections / stations | `params.sectionIds` | give at least 2 sections |
| `SRF_LOFT_GUIDE_MISSES_SECTION` | `loft_surface` | a guide does not meet every section within tolerance | `params.guideIds[i]`, section index | snap the guide to the section curves (`interpolate_curve` through section points) |
| `SRF_LOFT_SECTION_DEVIATION` | `loft_surface`, `create_wing` | post-loft fidelity check > pres3d × 10 | entity id, section index, `deviation` | reduce sections' complexity or raise `maxDegree`; report to the owner |
| `SRF_FILL_LOOP_OPEN` | `fill_surface` | boundary edges do not form a closed loop | `params.boundary[i]` | add the missing edge or fix `edgesNear` points |
| `SRF_TRIM_MISS` | `trim_surface` | trimming curve/plane does not cut the surface | `params.by` | project the curve onto the face (`projectAlong`) or move the plane |
| `SRF_SEW_FREE_EDGES` | `sew_surfaces` (`makeSolid`) | free edges remain after sewing | edge list with points | raise `tolerance` within the model accuracy, or fill the gap first |
| `SRF_THICKEN_SELF_INTERSECT` | `thicken_surface` | offset self-intersects (thickness > min radius of curvature) | entity id, min radius | reduce `thickness` below the reported min radius |
| `SRF_FACE_NOT_FOUND` / `SRF_EDGE_AMBIGUOUS` | face/edge-referencing commands | `faceIndex` / `edgesNear` resolves to none or to two candidates | `params.faceIndex` / `params.edgesNear` | pick a point closer to the intended face/edge |
| `SRF_ENTITY_NOT_FOUND` | all | unknown id | `params.id` | `llull describe_scene` to list ids |
| `SRF_KERNEL_REQUIRED` | kernel commands under Manifold | `requiresKernel` and no OCC | — | re-run with `--kernel occt` (desktop default) |
| `SRF_WAIVER_NO_FINDING` | `request_surface_waiver` | no current finding with that code on that target | `params.code`, `params.entityId` | run `check_surface_quality` and copy the finding code |
| `AERO_NACA_DESIGNATION_UNKNOWN` | `airfoil_from_naca` | not 4 digits / not a supported 5-digit mean line (210..250) / t = 0 | `params.designation` | use e.g. `0012`, `2412`, `23012`; import other series as `.dat` |
| `AERO_AIRFOIL_PARSE` | `import_airfoil` | non-numeric line, < 5 points, Lednicer counts inconsistent | `line n` | check the file is Selig or Lednicer; pass `format` explicitly |
| `AERO_AIRFOIL_TE_GAP` | `import_airfoil`, `create_wing` | closed TE requested but gap > tolerance | section index, gap (chord units) | use `trailingEdge: open` or normalise |
| `AERO_AIRFOIL_SELF_INTERSECT` | `import_airfoil` | upper and lower surfaces cross | point indices | fix the file or pass `normalize: chord` if it is a rotation artefact |
| `AERO_PLANFORM_UNDERDETERMINED` / `AERO_PLANFORM_OVERDETERMINED` | `create_wing` | not exactly 3 independent planform values | `params.planform` | give exactly 3 of span, area, AR, taper, root/tip chord |
| `AERO_SPAN_NOT_INCREASING` | `create_wing` | section spans not strictly increasing | `params.sections[i].span` | sort sections by span |
| `AERO_FS_NOT_INCREASING` | `loft_fuselage` | station FS not strictly increasing (apex allowed first/last) | `params.stations[i].fs` | sort stations by FS |
| `AERO_FRAME_NOT_ORTHONORMAL` | `set_aircraft_frame` | axes not orthonormal right-handed | `params.fsAxis/blAxis/wlAxis` | use unit, mutually perpendicular axes (default +X aft, +Y right, +Z up) |
| `SRF_CHECK_G0_GAP` · `SRF_CHECK_G1_ANGLE` · `SRF_CHECK_G2_CURVATURE` · `SRF_CHECK_G3` | `check_surface_quality` (fail) | continuity gap above the tolerance at some sample of an internal edge | entity id, edge index, worst point, value, limit, unit | refit sections, add a guide curve, raise loft continuity, or request a waiver (human gate) |
| `SRF_CHECK_SECTION_DEVIATION` | `check_surface_quality` (fail) | loft departs from an input section beyond tolerance | entity id, section index | as `SRF_LOFT_SECTION_DEVIATION` |
| `SRF_CHECK_FREE_EDGES` | `check_surface_quality` (fail when a solid is expected) | open shell | edge list | `sew_surfaces` or `fill_surface` |
| `SRF_CHECK_DRAFT_BELOW_MIN` | `check_surface_quality` (fail, only with `pullDirection`) | draft < `minDraftDeg` or undercut | sample points, area | change the pull direction or the surface |
| `SRF_CHECK_DEGENERATE_SAMPLES` | `check_surface_quality` (warn) | samples skipped (zero derivative, poles, LE apex) | count, locations | none; reported so the result is not over-read |
| `SRF_CHECK_TOLERANCE_DEFAULTED` | `check_surface_quality` (warn) | a tolerance was taken from a named default | tolerance name, value, source | give the programme's tolerance explicitly when known |
| `SRF_CHECK_INPUT_UNVERIFIED` | `check_surface_quality` (warn, not suppressible) | an input has `provenance.verified = false` | input ids, sources | pin the source (URL + sha256) or confirm with the owner |
| `SRF_CHECK_WAIVER_PENDING` | `check_surface_quality` (attached to a fail) | a waiver exists without a human approval | waiver id | ask the qualified reviewer to approve in 09 PLM |

### 7.2 Result conventions (AF-10, AF-31..35)

- Lengths in `data` are in document units and every query result has a top-level `unit` (length unit) and
  `angleUnit`; curvature fields are `1/<unit>`; field names carry the unit when it differs (`g1AngleRad`,
  `draftDeg`, `areaRef` + `areaUnit`). Airfoil results are chord-normalised and say so (`unit: "chord"`).
- Every query result carries `unverified: boolean` (propagation rule, §3) and `provenance {method, reference,
  inputs}` (e.g. `{method: "Gaussian curvature from fundamental forms", reference: "OCC BRepLProp_SLProps",
  inputs: {id, faceIndex, grid}}`).
- Defaulted tolerances are reported as `NamedTolerance` with `defaulted: true` and their source (OCC filling
  defaults, TECHNICAL_SPEC §5.9).
- `reviewRequired: true` + `reviewReason` on `check_surface_quality` with `purpose: "release"` (FR-SRF-42); the
  summary ends with "computed by llull, not approved: needs a qualified engineer".
- Bounded output: grids ≤ 200×200, sample arrays summarised (min/max/worst + counts) unless `output: "samples"`.

### 7.3 Agent-first compliance

| AF | Where satisfied |
| --- | --- |
| AF-01, AF-02 | FR-SRF-26; every command is a registry command with an agent-written description (§4) |
| AF-03 | FR-SRF-38 (`llull guide` aero/surface section, MCP prompt `aero_wing`) |
| AF-04 | FR-SRF-36; param names carry units (`sweepDeg`, `g1AngleRad`), lengths in document units |
| AF-05 | FR-SRF-37; plans in `validation/plans/` validate with `--validate` |
| AF-10, AF-12 | FR-SRF-35, §7.2 |
| AF-11 | FR-SRF-33, §7.1 |
| AF-13 | FR-SRF-31, TR-SRF-10 |
| AF-20, AF-30 | FR-SRF-39 `check_surface_quality` |
| AF-21 | FR-SRF-20..22, 24, 25 numeric `data`; overlays FR-SRF-23 are COULD |
| AF-22 | `render_view isolate=<id> --save view.png` in the CLI workflow (FUNCTIONAL §6.1) |
| AF-23 | `expected_results.json` `cli` field per case; VC-SRF-35 audit |
| AF-31 | FR-SRF-40, `NamedTolerance` |
| AF-32 | FR-SRF-41, `InputProvenance`, propagation rule (§3) |
| AF-33, AF-36 | FR-SRF-42 |
| AF-34 | FR-SRF-43, `request_surface_waiver` + 09 PLM `record_approval` (TR-PLM-16) |
| AF-35 | FR-SRF-44, `provenance` in every result |
| AF-40, AF-42 | §7 CLI bullet (`--progress`, `--timeout`, `--dry-run`), §8 budgets |
| AF-41 | all SRF computation is core or bundled OCC; no network |

## 8. Performance & robustness budgets (desktop, OCC worker)

| Operation | Budget | Notes |
| --- | --- | --- |
| `airfoil_from_naca` (161 pts) | ≤ 20 ms | core only |
| `interpolate_curve` 10 000 points | ≤ 200 ms | banded solve O(n p²) |
| `create_wing` 2 sections | ≤ 1 s | ThruSections |
| `create_wing` 10 sections, mirror | ≤ 4 s | |
| `analyze_surface_curvature` 100×100 | ≤ 500 ms | |
| `check_continuity` all internal edges, CRM wing-body STEP | ≤ 10 s | VC-SRF-12 |
| `loft_fuselage` 40 stations | ≤ 3 s | |
| Memory | handles cached/evicted as KI5 | |
| Robustness | every kernel op returns null on failure → no-op with summary; no crash on degenerate input (zero-thickness TE, coincident stations, rho = 0/1, self-intersecting `.dat`) | fuzz tests with malformed `.dat` |

## 9. Test strategy

| Level | Location | Content | VC |
| --- | --- | --- | --- |
| Unit (core math) | `tests/unit/surface/nurbs*.test.ts` | basis partition of unity, knot insertion/degree elevation shape invariance, interpolation passes through points, conic weights/shoulder, curvature formulas vs analytic | VC-SRF-05, 06, 07 |
| Unit (commands) | `tests/unit/surface/*.test.ts`, `tests/unit/aero/*.test.ts` | happy + failure per command; `is pure`; schema snapshot (`toToolSchemas()`) | VC-SRF-19 |
| Agent-first | `tests/unit/surface/agentFirst.test.ts`, `tests/unit/contract/` | error codes per §7.1 (one failing plan per code family), `unverified` propagation, named defaults + `reviewRequired` in `check_surface_quality`, waiver human gate (with 09 PLM), units audit of `describe` and results | VC-SRF-31..35 |
| Agent driver | production-gate agent driver (`docs/PRODUCTION_GATE.md`) | runs every case's `cli.run` from `expected_results.json` with `--json` and exit codes only | all |
| Unit (aero data) | `tests/unit/aero/naca.test.ts` | generated sections vs `validation/data/naca_*_selig_81.csv` (exact to 1e-8) and vs pinned UIUC files (downloaded by a fixture script when network allows; skipped offline with a notice) | VC-SRF-01..04 |
| Golden | `tests/golden/plans.ts` add `aero_naca_trap_wing`, `aero_tr1208`, `surface_torus_analysis`, `aero_sears_haack_body` (plans in `validation/plans/target_*.json`) | id-normalised snapshot + replay equality | VC-SRF-10, 11, 13, 19 |
| Kernel integration | `server/tests/occtSurfacing.test.ts`, `occtAnalysis.test.ts` | every bound OCC class used (§1.2); cross-check curvature/continuity vs `LocalAnalysis_*`; sewing/fill tolerances | VC-SRF-05, 12, 15, 16, 17, 18 |
| Python oracle | `server/tests/*.integration.test.ts` with bundled CadQuery/OCP | same STEP evaluated with OCP `GeomLProp_SLProps` / `BRepGProp` to cross-check llull numbers | VC-SRF-11, 12 |
| Quality gate | `npm run quality` entry: CRM wing-body STEP (downloaded, sha256 pinned on first fetch) → import → curvature/continuity/area | VC-SRF-12 |
| Production gate | scenario "aero conceptual wing": NACA 23012 root / 0012 tip, 35° sweep, 5° dihedral, −3° washout; export STEP; reimport; volume equal ± 1e-6 rel | VC-SRF-21 |
| Code export | `export_code language=cadquery` on the NACA 0012 wing plan; run the script with bundled CadQuery/OCP; volume within 1e-4 rel of 0.959117 | VC-SRF-30 |

### 9.1 Technical requirements

Each TR points to the section that specifies it; `validation/expected_results.json` cites them in `proves`.

| Id | Requirement | Spec | VCs |
| --- | --- | --- | --- |
| TR-SRF-01 | Pure NURBS library in `lib/nurbs` (validity, evaluation, derivatives, interpolation/approximation, conics, edit ops); no kernel | §2.1, §5.1, §5.2, §5.4 | 06, 07, 08, 14, 25 |
| TR-SRF-02 | Entity kinds `nurbs_curve` / `nurbs_surface`, `isSheet` / `isCurve3D` predicates, render branches; solid-only commands refuse sheets | §2.3 D1, §3 | 27 |
| TR-SRF-03 | Loft v3: exact sections (no resampling), TE kept as an edge, apex conditions, post-loft section-fidelity check | §3, §5.5 | 11, 22 |
| TR-SRF-04 | NACA 4/5-digit equations and airfoil fitting in the plugin (`naca.ts`) | §5.2, §5.3 | 01, 02, 03, 04, 09 |
| TR-SRF-05 | `@aero` plugin (wing, fuselage, airfoil commands); `AeroModel` type in core `model/aero.ts`; `DocumentExtension`; derived entities read-only and re-derived | §2.1, §3, §4.2 | 10, 11, 13, 14, 28, 29 |
| TR-SRF-06 | Curve/surface curvature and G0–G3 continuity measures, classification and degenerate-sample handling | §5.6 | 05, 06 |
| TR-SRF-07 | Optional `GeometryKernel.analysis` port and new `ShapeRecipe` ops, read only via `ctx.kernel` with `requiresKernel`; Manifold refuses | §2.3, §5.8 | 05, 12, 26 |
| TR-SRF-08 | OCC paths for fill, trim, sew, thicken, deviation and draft with the stated tolerances | §5.7 | 15, 16, 17, 18, 23, 24 |
| TR-SRF-09 | Interop: `.dat` import (`text` in core, files via `/exchange`), exact STEP B-spline export, `export_code` lowering | §4.3, §6 | 03, 04, 12, 20, 21, 30 |
| TR-SRF-10 | Purity, deterministic replay, numerical tolerances and performance budgets | §2.3, §5.9, §8 | 12, 19 |
| TR-SRF-11 | Every OCC class used (§1.2) has a `server/tests/` integration test ("bound" ≠ "works") | §1.2, §9 | 15, 16, 23, 24 |
| TR-SRF-12 | Stable error and finding codes with path, ids and remediation for every SRF command | §7.1 | 31 |
| TR-SRF-13 | `check_surface_quality` read-only check: findings, named tolerances, `unverified`, `reviewRequired`, waivers | §4.1, §7.2 | 33, 34 |
| TR-SRF-14 | `InputProvenance` + recipe-walk propagation of `unverified`; `provenance` block in every query result | §3, §7.2 | 32 |
| TR-SRF-15 | Units in every param description and every result field; bounded output | §7.2 | 35 |

## 10. Delivery plan

| Milestone | Content | Depends on | Effort (eng-weeks) |
| --- | --- | --- | --- |
| M0 | D1–D3 decisions; `isSheet`; entity kinds; render branches (`add-entity-kind` skill); new `packages/domain-aero` workspace: `@aero/*` alias in `tsconfig.base.json`, layer rules in `.dependency-cruiser.cjs` (aero → core public API only), `packages/domain-aero/src/**` added to the 90/85/90/90 coverage gate | — | 2 |
| M1 | Core NURBS lib (eval, derivatives, interpolate, conic, edit ops) + `create_nurbs_curve`, `interpolate_curve`, `create_conic`, `inspect_nurbs`, `analyze_curve_curvature` (core path) | M0 | 4 |
| M2 | `@aero` plugin skeleton + `AeroModel` + `airfoil_from_naca`, `import_airfoil`, `airfoil_properties` | M1 | 3 |
| M3 | Exact loft v3 (no resampling, TE edge, apex) + `create_wing`, `wing_properties` | M2, KRN-M1 (OCC default on desktop) | 4 |
| M4 | Kernel `analysis` port: `analyze_surface_curvature`, `check_continuity`, `measure_deviation`, `analyze_draft` + UI overlays | M3 | 5 |
| M5 | Surface toolkit V1: `surface_from_points`, `fill_surface`, `trim_surface`, `sew_surfaces`, `thicken_surface`, Gordon-surface guides in `loft_surface` | M4 | 6 |
| M6 | `loft_fuselage` (FS/BL/WL, conic halves, control curves) | M5 | 3 |
| M7 | V2: G3, `blend_surfaces`, conic master-line workflow, `.vsp3` import, CRM performance | M6, gap 01 persistent naming, custom opencascade.js build | 6 |

Total ≈ 33 eng-weeks. Cross-gap: **01 KRN** (OCC default on desktop, custom opencascade.js build exposing
`GeomAPI_Interpolate`/fixed `MakePipeShell`, persistent naming), **04 XCH** (AP242/IGES B-spline export),
**06 CMP** (consumes `nurbs_surface` for ply layup).

## 11. Open questions / decisions needed

| # | Question | Proposal |
| --- | --- | --- |
| D1 | Open sheets as entities: extend `is3D` or add `isSheet`/`isCurve3D`? | Add predicates; solid-only commands refuse sheets with a clear summary |
| D2 | Where does NURBS math live: `lib/nurbs` (pure) vs `geometry/`? | Algorithms in `lib/nurbs`, entity-aware wrappers in `geometry/nurbs*.ts` |
| D3 | Persistence version bump for new kinds? | Keep v2 if old readers already reject unknown kinds gracefully; else v3 with reader for v2 |
| D4 | Custom opencascade.js build (OCCT ≥ 7.7) vs core fallbacks | Core fallbacks for MVP (interpolation, Gordon); custom build in gap 01 |
| D5 | Default continuity tolerances for aero OML | OCC filling defaults (0.01 rad, 10 %) until a programme supplies values |
| D6 | Store airfoil raw points in the document (size) | Yes (recipe = document, L8); cap at 10 000 points |
| D7 | Redistribution of UIUC `.dat` files | Licence not confirmed (UIUC pages unreachable during research): pin URL + sha256, never vendor |
| D8 | NACA 5-digit constants other than 230 | Transcribe from NASA TM 4741 with a verification test before enabling |

## 12. References

Same numbering as FUNCTIONAL_SPEC §11 ([R1]–[R27]); additionally:

- [R12] OCCT headers read at commit 3d097a0328e71b826377d4814ab05ec3c3d23871 — paths
  `src/ModelingAlgorithms/TKOffset/BRepOffsetAPI/BRepOffsetAPI_ThruSections.hxx`,
  `…/BRepOffsetAPI_MakePipeShell.hxx`, `…/BRepOffsetAPI_MakeFilling.hxx`,
  `src/ModelingAlgorithms/TKBool/BRepFill/BRepFill_Filling.hxx`,
  `src/ModelingAlgorithms/TKGeomAlgo/GeomAPI/GeomAPI_Interpolate.hxx`, `…/GeomAPI_PointsToBSplineSurface.hxx`,
  `src/ModelingAlgorithms/TKGeomAlgo/GeomFill/GeomFill_BSplineCurves.hxx`,
  `src/ModelingAlgorithms/TKGeomAlgo/LocalAnalysis/LocalAnalysis_SurfaceContinuity.hxx`,
  `src/ModelingData/TKGeomBase/GeomLProp/GeomLProp_SLProps.hxx`, `src/ModelingData/TKG3d/Geom/Geom_BSplineSurface.hxx`,
  `src/FoundationClasses/TKMath/GeomAbs/GeomAbs_Shape.hxx`,
  `src/ModelingAlgorithms/TKTopAlgo/BRepBuilderAPI/BRepBuilderAPI_Sewing.hxx` — https://github.com/Open-Cascade-SAS/OCCT (accessed 2026-10)
- [R13] opencascade.js v1.1.1 — README "Current OCCT version: V7_4_0p1"; `dist/Supported APIs.md` (binding status per class) — https://github.com/donalffons/opencascade.js/tree/v1.1.1 ; npm metadata (latest 1.1.1, published 2020-09-27, LGPL-2.1-only) — https://registry.npmjs.org/opencascade.js (accessed 2026-10)
- llull internal: `docs/decisions/KI5-shape-kernel-boundary.md`, `docs/decisions/KI6-desktop-app-cli-first.md`, `.claude/rules/architecture.md`.

## 13. Implementation status (AERO-5, 2026-10-19)

Built: **M0, M1, M2, M3** (AERO-5), in SRF-2 **M4, M5 (without kernel trimming) and M6** (§13.5) and, in SRF-3, the M5 gaps and **M7** as far as TypeScript goes (§13.7). Everything below is automated (`tests/unit/surface/`, `tests/unit/aero/surfacing/`,
`tests/golden/` plans `surface_nurbs_curves`, `aero_naca_trap_wing`, `aero_tr1208`).

### 13.1 What exists

| Piece | Where | Notes |
| --- | --- | --- |
| NURBS math (TR-SRF-01) | `packages/core/src/lib/nurbs/` (`basis`, `knotVector`, `evaluate`, `edit`, `interpolate`, `conic`, `curvature`, `integrate`, `bandSolve`) | A2.1–A2.3, A4.2 rational derivatives, A5.1 knot insertion, degree elevation (collocation at the Greville points of the raised knot vector, exact to about 1e-13), global interpolation A9.1 with optional end tangents (banded LU with pivoting; 10 000 points in about a second), conics, curvature / torsion / dκ/ds, Gauss–Legendre arc length and area integrals |
| Entity kind `nurbs_curve` (TR-SRF-02) | `model/types.ts` (`NurbsCurveEntity`), `model/curveKinds.ts` (`CURVE_KINDS`, `isCurve3D`), `geometry/nurbsCurve.ts`, `commands/persistence/nurbsGuard.ts`; render branches `src/ui/viewport/3d/entities/NurbsCurveLine.tsx` (3D and 2D views) and the `render_view` stroke | bounds, scale, `find_entities`, save / load validation; codegen and the Manifold kernel treat it as "no solid" |
| Core commands (`commands/surface/`) | `create_nurbs_curve`, `interpolate_curve`, `create_conic`, `edit_nurbs` (move_pole, set_weight, insert_knot, elevate_degree, reverse), `inspect_nurbs`, `analyze_curve_curvature` | stable `SRF_*` refusal codes with param paths; listed in toolset `3d` |
| Loft v3 (TR-SRF-03) | `LoftEntity.sections`; `geometry/sectionChain.ts` (Bézier extraction + closing edge, dense ring fallback); `loft_sections` accepts `nurbs_curve` ids; `server/src/native/kernelLeaves.ts` `loftChains` sends the exact chains to the native kernel instead of the 24-point Catmull-Rom rings | the `SECTION_RING_POINTS` resampling no longer applies to NURBS sections (it still applies to sketches and inline sections) |
| `AeroModel` + plugin `surfacing` (TR-SRF-05) | `model/aero.ts`, `CadDocument.aero`, `packages/domain-aero/src/surfacing/` (toolset `aerodynamics`) | `doc.aero.{airfoils,wings}` validated on load (`aeroDocument`) |
| Airfoils (TR-SRF-04) | `airfoil_from_naca`, `import_airfoil` (Selig / Lednicer text, sha256, normalisation, self-intersection and TE-gap checks), `airfoil_properties` | NACA 4-digit and the 230 5-digit mean line; cubic centripetal interpolation through every ordinate |
| Wings | `create_wing` (sections or planform, sweep at a chord fraction, dihedral, twist about the twist axis, mirror), `wing_properties` | wing id = id of the right-half loft solid |

### 13.2 Validation cases automated

| VC | Result |
| --- | --- |
| VC-SRF-01, 02 | `airfoil_from_naca` curves pass through all 161 ordinates of `data/naca_{0012,0012_closed_te,2412,23012}_selig_81.csv` within 1e-7 chord (the pinned UIUC files are not vendored, D7; the pack's own CSVs are the reference); the 0012 curve stays within 2e-6 chord of the analytic section between the ordinates |
| VC-SRF-03, 04 | Selig and Lednicer parsing, chord normalisation of a rotated / scaled / translated file, raw points + sha256 kept; the UIUC files themselves are not fetched (no fixture script) |
| VC-SRF-05 (curve part), 06 | circle κ = 1/R, y = x³ inflection dκ/ds = 6 (planar and generic form), helix κ and τ closed forms |
| VC-SRF-07 | conic weights and shoulder points vs `data/conic_cases.json`, exact unit quarter circle |
| VC-SRF-08 | knot insertion, degree elevation, interpolation: shape change < 1e-12 (insertion) / 1e-11 (elevation), interpolation residual < 1e-12 |
| VC-SRF-09 | NACA 0012: tMax 0.1200345 at 0.2998, TE 0.00252, r_LE 0.015653 (limit 0.015867 ± 5e-4), area 0.08221 |
| VC-SRF-10 | `plans/target_tr1208_wing.json` runs unchanged: area 2024.35 in², MAC 16.670 in, AR 8.000, yMAC 27.792 |
| VC-SRF-11 | `plans/target_naca0012_trap_wing.json` runs unchanged: half-wing volume 0.959117 m³ (formula path of `wing_properties`, 1e-4 rel) and the plan's `mass_properties` step (mesh fallback of the exact loft) within 0.5 % |
| VC-SRF-28 | sweep 0 → 30° of a constant-chord wing: area unchanged, LE / c/4 / TE sweep 30° |
| VC-SRF-31 (partly) | `AERO_NACA_DESIGNATION_UNKNOWN`, `AERO_SPAN_NOT_INCREASING`, `AERO_AIRFOIL_TE_GAP`, plus the other codes of §7.1 that belong to built commands |
| VC-SRF-32 (partly) | `unverified` / UNVERIFIED on imported airfoils without a pinned hash, propagated to `airfoil_properties` and `wing_properties` |
| VC-SRF-19 | `is pure` per command, tool-schema snapshot updated, golden plans with replay equality |

### 13.3 Decisions and deviations from this spec

| Item | Decision |
| --- | --- |
| D1 | `isCurve3D` built; **`isSheet` is not**: no sheet kind exists yet (`nurbs_surface` and open lofts are M5), a predicate without a user would be dead code. Solid-only commands already ignore curves (no triangles, no volume) |
| D2 | as proposed: algorithms in `lib/nurbs`, entity-aware wrappers in `geometry/nurbsCurve.ts` and `geometry/sectionChain.ts`. `NurbsCurveData` lives in `lib/nurbs/types.ts` (lib may not import model); there is no `model/nurbs.ts` |
| D3 | persistence stays at v3, no bump: the new kind is registered in the persistence kind set and older readers already reject unknown kinds |
| D6 | raw airfoil points are stored, capped at 2000 points (the spec said 10 000) |
| D8 | only the 230 mean line is enabled (transcription of the other constants from TM 4741 is still TBD) |
| `periodic` | curves are clamped and non-periodic (`NurbsCurveData` has no `periodic` flag); a closed curve repeats its end pole |
| toolsets | no new `surface` / `aero` toolset: every new toolset needs a design-language example (`tests/unit/design/examples.test.ts`), so the surface commands are listed in `3d` and the plugin in `aerodynamics` |
| derived entities | the airfoil curve and the wing lofts are ordinary saved entities referenced by `doc.aero` (the pattern of the `fasteners` plugin), not read-only re-derived geometry: there is no derivation guard and no `edit_wing` yet, so editing a loft by hand leaves `doc.aero` stale |
| `airfoil_from_naca` | `trailingEdge` defaults to `open`; `points` is the total odd count (161 = 81 stations per surface); no `chord` / `plane` params (the curve is chord 1 at `position`, the wing scales it); the fit is the cubic centripetal interpolation of the generated ordinates, not the "densify to 401 then approximate to 1e-7" scheme (`approximate_curve` is not built) |
| `create_wing` | `tip` accepts only `flat` (open / round tips need the kernel sheet ops of M5); `mirror` creates the left half as a second solid, not fused; every airfoil of a wing needs the same `points` count and trailing-edge type (`AERO_SECTIONS_INCOMPATIBLE`), because the exact skin needs equal edge counts; no guides or end conditions; `wing_properties` has no `wettedArea` (needs the kernel) |
| wing id | `create_wing` returns the right-half solid id as the wing id, so the same `$wing` alias works for `mass_properties` and `wing_properties` in the pack plans |
| `loft_sections` | exact sections need degree 1..3 non-rational curves with equal span counts; sections are not re-aligned (the start of each curve is its seam) |
| camber | `airfoil_properties.camberMax` is measured against the section frame's x axis (the NACA definition: 0.0200 for 2412), not against the LE–TE chord line |

### 13.4 Not built, and why

- **Rust side and kernel tests.** `kernelLeaves.ts` sends `chains` built from the exact sections (cubic Bézier spans + a line for an open trailing edge) through the existing `loft` payload, so the sidecar needs no change; but nothing was run against the real `llull-kernel` (no `cargo` and no binary in the agent's worktree). The `server/tests/` integration tests for VC-SRF-11 (OCC volume 0.959117) and VC-SRF-22 (section fidelity) are therefore **not written**; they are the first thing to add when the binary is available (done: �13.8). The legacy WASM `kernel-occt` path still skins `rings`.
- **Single B-spline section per loft section (SRF-2 item 10): host side and Rust / C++ written in SRF-3 (§13.7), NOT COMPILED.** The exact loft still sends each airfoil as a chain of about 158 cubic Bézier edges. Sending one `Geom_BSplineCurve` per section (poles, knots, multiplicities, weights; also exact rational sections) needs a new wire builder in the C++ bridge of `solver/crates/llull-kernel-occt` as well as the Rust recipe parser, and there is no `cargo` / OCCT toolchain on the agent machine, so it could be neither compiled nor tested. Writing uncompiled FFI code into the native sidecar was judged riskier than the current, working chain payload; the TS side (`sectionChain`) is the single place to add a `bspline` payload behind a capability flag once the Rust side exists.

### 13.5 SRF-2 status: review fixes and M4 - M6 (2026-10-20)

**Review fixes** (each with a test): `is3D` excludes `nurbs_curve` and the new sheet kind (`stepTargets`, mesh export, booleans, blends, faces, decals, drawings, dynamics bodies skip them); a wing / airfoil / body whose curve or surface was deleted stays as a stale record: the file loads unchanged and the commands refuse to use it (`AERO_AIRFOIL_NOT_FOUND`); see §13.6; `create_wing` refuses a degree > 3 or rational airfoil in section 0 as well; loft `sections` are checked on load with the same rules as `loft_sections`; `import_airfoil trailingEdge "closed"` snaps the last point to the first; `create_wing` normalises every airfoil to unit chord with the leading edge at the origin (exact affine map) before placing it; `nacaOrdinates` takes `spacing` and `airfoil_from_naca` reuses it.

**New entity kind `nurbs_surface`** (`NurbsSurfaceEntity`, `SHEET_KINDS`, `isSheet`, excluded from `is3D`): persistence guard, bounds, scale, `render_view` polygons and the 3D viewport branch `NurbsSurfaceMesh` (double-sided). D1 is now settled: sheets are refused by solid-only commands (they are not `is3D`); there is no 2D-view branch.

**M4 - analysis port.** `geometry/surfaceAnalysis/` holds the `SurfaceAnalysisEngine` port (`ExecutionContext.surfaceAnalysis`, default `tsSurfaceAnalysis`, resolved by `resolveSurfaceAnalysis`) with `curvature`, `continuity`, `deviation` and `draft`, implemented on the exact NURBS (A3.6 / A4.4 quotient-rule derivatives, Newton foot points, banded collocation) and, for solids, on their tessellation. A native kernel can later install a B-rep-aware engine through the same port. Commands: `analyze_surface_curvature` (K, H, k1, k2), `check_continuity` (curves G0..G3, patch edges G0..G2, side detection, tolerances reported with the defaulted names), `measure_deviation` (points or entity against surface / curve / solid), `analyze_draft` (sheet or solid), and `inspect_nurbs` now reads surfaces. Not done in SRF-2 (the UI overlays and `check_surface_quality` came in SRF-3, §13.7): `faceIndex` / `edgeIndex` on B-rep faces (needs the exact kernel).

**M5 - surface toolkit.** `create_nurbs_surface`, `surface_from_points` (global bicubic interpolation A9.4, or the points as control net), `loft_surface` (exact skinning A10.3 of rational sections; with `guideIds` a Gordon surface built by sampling the transfinite union and fitting it, deviation reported), `fill_surface` (3 or 4 curves, Coons patch as an exact NURBS, G0 only), `trim_surface` (exact iso-parametric rectangle), `sew_surfaces` (two patches sharing a whole edge become one patch with a C0 crease), `thicken_surface` (closed tessellated mesh solid, refuses an offset past the centre of curvature). Deferred in SRF-2 and built in SRF-3 (§13.7): trimming by curves (not planes), `fill_surface` with more than 4 curves and G1 / G2 fills, sewing into a closed mesh shell with free-edge reports, G3 for surfaces. Still deferred: exact (B-rep) thickening and sewing (VC-SRF-24 is checked on the mesh to 2 %), `approximate` mode of `surface_from_points`.

**M6 - `loft_fuselage`.** Stations in FS / BL / WL with `point`, `circle`, `conic`, `circle` (exact) and `superellipse` sections (nine-pole closed rational quadratics; the superellipse is an APPROXIMATION by four conics through the axis and 45 degree points, exact only for n = 2, error about 0.4 % of the radius at n = 2.5 and 1 % at n = 6, reported as `superellipseDeviation`), optional `controlCurveIds` as Gordon guides, definition stored in `doc.aero.bodies`. Result: one closed `nurbs_surface`; the summary reports the enclosed volume from the tessellation. Not done in SRF-2 (`set_aircraft_frame`, `fuselage_section_at`, G3 and the conic master-line workflow came in SRF-3, §13.7): a solid (mesh or B-rep) version of the body.

**Validation cases automated**: VC-SRF-05 (sphere, cylinder, torus curvature on exact rational patches), VC-SRF-06 (six analytic joints reach exactly G0, G1, G2, G3, G3, G1, with the angle 45 degrees, curvature jump 0.2 and d(kappa)/ds jump 6), VC-SRF-13 (Sears-Haack body from the 19 conic stations within 0.5 % of 3 pi^2 R^2 L / 16), VC-SRF-14 (conic rho sqrt(2) - 1 equals circular stations), VC-SRF-17 (draft of a cone and of a vertical wall; the cone is tessellated, so the figure is within the facet error), VC-SRF-18 (sphere R 10 against points on R 10.5: max = mean = rms = 0.5), VC-SRF-24 (hemisphere shell volume to 2 % on the mesh), VC-SRF-25 (grid interpolation passes through every point, residual at round-off). Golden plan `surface_sheets`.

**Unverified without the native kernel**: nothing in M4 - M6 calls the kernel; the sheets are not sent to OCC, so STEP export of a `nurbs_surface` (skipped with a note; mesh formats / `frontal_area` use its tessellation), B-rep booleans with sheets and the server integration tests (VC-SRF-15, 16, 22 - 24 on OCC) are not covered.

### 13.6 Review follow-up (SRF-2)

- **Gordon on closed sections** blends periodically (the nodes repeated one period either side, cardinals summed), so the first and last u isolines coincide; guides are sorted by where they cross the sections; collapsed (point) sections take the mean crossing. `loft_surface` / `loft_fuselage` measure the distance from the guides to the fitted surface (`controlCurveDeviation`, in the summary and `data`) and refuse above max(10 x tolerance, 1e-3 x size) with `SRF_LOFT_GUIDE_NOT_CONTAINED`. The guide containment is a fit tolerance, not an exact property.
- **Patch continuity** compares the normal curvature of both patches along one common direction (the in-plane perpendicular to the edge, Pegna-Wolter) and measures G1 between the outward direction of A and the inward direction of B, so a sheared parametrisation of the same surface is G2 and a fold-back is not G1.
- **Superellipse stations** are the four-conic approximation stated in §13.5; the maximum radial error is returned as `superellipseDeviation`.
- **Aero definitions** are validated structurally only; `restore` is the identity. A definition whose curve, loft or surface was deleted is a stale record that commands refuse at use, so `doc` and `load(save(doc))` are equal.
- **Sheets in consumers**: mesh exports (STL / OBJ / glTF), `frontal_area` and `aero_drag` use the sheet tessellation; STEP export lists a skipped sheet as "surface sheet"; code export notes the curves and sheets it cannot lower. `thicken_surface` welds seams of u- or v-closed sheets and collapsed edges and builds no wall there (a kernel boolean on a thickened hemisphere is tested).


### 13.7 SRF-3 status: M5 gaps and M7 (2026-10-20, branch `feat/srf-3`)

Everything below that is not marked "NOT COMPILED" is automated and green (`tests/unit/surface/`, `tests/unit/aero/surfacing/`, `tests/component/SurfaceOverlayControl.test.tsx`, `server/tests/nativeKernel*.test.ts`). Spec deviations are named; nothing here calls the native kernel.

**G3 for patches (`check_continuity`).** A patch joint now reports `order` up to G3 and `g3Gap`. G3 is the agreement of the cross-edge rate of normal curvature: the normal curvature along the common direction w (re-projected on each tangent plane), differentiated along +w one-sided into each patch (second-order stencil of 1 % of the parameter domain along the cross direction, central / one-sided along the edge, combined with the coefficients of w so the stencil never leaves the patch). It is intrinsic (a sheared parametrisation of the same surface is still G3: tested on the parabolic cylinder), a sphere cut in halves is G3, a cubic continuation with equal z, z', z'' and a different z''' is G2 with `g3Gap` > 0.1. The definition is ours (OCC `LocalAnalysis` stops at G2); `g3Rel` (default 0.1) is relative, `g2Abs` the floor. The earlier surface tests that expected G2 for same-surface joins now expect G3.

**New commands (core, toolset `3d`).**

| Command | What it does | Limits |
| --- | --- | --- |
| `approximate_curve` | least-squares B-spline through ordered points, ends interpolated, fewest poles (doubling then bisection per degree in `degreeMin..degreeMax`), reports max / rms point-to-curve distance (`SRF_TOLERANCE_UNREACHABLE` when `maxPoles` is not enough) | `smoothing` of the spec is not built; above 2000 points the reported deviation is the parametric bound, not the foot-point distance |
| `trim_surface` by `curveIds` | closed curve: keep `inside` / `outside` (hole); open curve edge to edge with `keepPoint`; closest-point or `projectAlong` projection; exact trimmed `area`; `measure_area` and `inspect_nurbs` read sheets | see 13.7.1 |
| `fill_surface` | 3 to 12 curves as ONE Coons patch (composite sides for more than 4); `neighbours` give G1 / G2 to existing sheets | see 13.7.2 |
| `blend_surfaces` | G1 (cubic) / G2 (quintic) Bezier bridge between an edge of A and an edge of B, interpolated along the edge, measured joints reported | edges matched by foot point; sheets must face each other (`SRF_BLEND_FOLD`) |
| `sew_surfaces` shell | 1..64 sheets, `makeSolid` or 3+: equal arc-length boundary samples + zipper strips, weld, free / non-manifold edge report, orientation propagation, volume | closed triangle-MESH solid, no B-rep; `resolution` trades volume accuracy (sphere: 1.6 % low at 24, 0.4 % at 48, 0.1 % at 96) |
| `check_surface_quality` | one report: continuity across interior knot lines down to `require`, free edges, draft, singular samples, named tolerances, `reviewRequired` for `release` | sheets only; lofts / wings (section deviation), B-rep faces and waivers (`request_surface_waiver`) are NOT covered |

*13.7.1 Trimmed sheets.* The sheet keeps its patch and stores `trims?: UvTrimLoop[]` (`model/types.ts`, `lib/nurbs/surfaceTypes.ts`): closed polygons in the (u, v) plane through exact samples of the projected curve (about 512 vertices, even count; the spec's 2D NURBS curves are NOT used, a documented deviation), region = even-odd union. Render / export meshes cut the grid cells along the loop (marching squares on the signed uv distance), area is Green's theorem with Gauss quadrature and Richardson extrapolation over the loop sampling: VC-SRF-23 (10 x 10 plane, circle r = 3, keep inside) gives 28.274334 within 1e-6, outside 100 - pi r^2. Limits: `by.planes` is not built; a trimmed sheet accepts further trims only as holes inside the kept region (`SRF_TRIM_UNSUPPORTED` otherwise), a rectangle trim, `sew_surfaces` and `thicken_surface` of a trimmed sheet are refused, and the analysis queries (curvature, draft, deviation, continuity) still use the whole underlying patch; STEP export still skips sheets. Codes added: `SRF_TRIM_MISS`, `SRF_TRIM_LOOP_INVALID`, `SRF_TRIM_AMBIGUOUS`, `SRF_TRIM_UNSUPPORTED`.

*13.7.2 Fill with conditions.* Grouping the loop into four composite C0 sides makes the many-sided fill a single patch; for strongly non-convex or 12-sided loops the Coons map can overlap itself slightly (regular 12-gon: area 12.013 against 12), so read `boundaryDeviation` and the area. With `neighbours` the poles of the second (G1: perpendicular departure in the neighbour tangent plane) and third (G2: normal curvature of the neighbour along the cross direction, Pegna-Wolter) row are re-placed after 16 knot insertions per span along the side; the corner poles are never moved, so every boundary curve stays exact and the headline `g1AngleRad` / `g2Gap` / `order` are those of the middle 80 % of the edge (`cornerG1AngleRad` is the worst angle at the edge ends, where the adjacent boundary curves fix the surface and G1 is generally impossible). VC-SRF-15 is covered with analytic sheets (G1 < 0.01 rad, g0 gap < 1e-4, G2 on a parabolic cylinder); the filleted-box corner of the VC needs B-rep fillet faces and is not tested.

**Aircraft frame and fuselage (plugin `surfacing`, toolset `aerodynamics`).** `set_aircraft_frame` (datum + orthonormal right-handed axes, `AERO_FRAME_NOT_ORTHONORMAL`; `units` must equal the document units) is stored in `doc.aero.frame`; `loft_fuselage` maps its stations through it (control curves stay in document coordinates). `fuselage_section_at` cuts the exact skin at FS = fs (bisection per ring point) and returns half breadth, crown / keel WL, WL of max breadth, area and perimeter (Richardson-extrapolated polygon sums, circle of radius 2: 4 pi to 1e-3 at least) and a closed cubic through 128 section points. `loft_fuselage_from_master_lines` (FR-SRF-19, COULD) derives conic sections at any FS from crown, keel and max-breadth lines with rho laws; the 41-station Sears-Haack body is within 0.5 % of its volume. The plan `target_sears_haack_conic_fuselage.json` now runs (its entry left `tests/unit/contract/blockedPlanCommands.json`); its closing `mass_properties` on the sheet is refused by design (a sheet has no volume), the test runs the plan without it.

**`import_openvsp_wing` (plugin).** XML read by a small tolerant reader (`vspXml.ts`); per `XSec_n` group Span, Root_Chord, Tip_Chord, Sweep, Sweep_Location, Dihedral, Twist, plus Sym_Planar_Flag, X / Y / Z_Rel_Location and Twist_Location; NACA 4-series section curves (Camber, CamberLoc, ThickChord) become `airfoil_from_naca`, then `create_wing`. Any other section type is refused with the list unless `fallbackNaca` substitutes one (then `unverified` and the summary say so). **Honest status of VC-SRF-20:** the pinned `TR1208.vsp3` could not be fetched (offline), so the XML layout is the documented one and the test uses a synthetic file with the TR1208 values (area per side 769.1085, total 1538.2171, sweep 45 at c/4). Until the real file is run, the element layout of a real `.vsp3` is an assumption.

**UI overlays (`src/ui/viewport` render only).** `geometry/surfaceAnalysis/overlay.ts` (pure: comb teeth + envelope, per-vertex colours for Gaussian / mean curvature, zebra isophote stripes, draft), store `surfaceOverlayStore` (not persisted), `NurbsSurfaceMesh` (vertex colours through `SolidMeshShell vertexColors`), `NurbsCurveLine` (comb), a `Surface map` select and a `Comb` toggle in `ViewportControls`. The zebra stripes are isophotes of the normal against a fixed light (+Z), not a camera reflection; the draft map uses the sheet's local frame and a pull along +Z unless the store direction is changed (no UI field for it yet). Not verified in the running app (no GPU session here): the geometry / colour functions and the controls are unit / component tested.

**Performance (spec §8, TS path, `tests/unit/surface/perfBudget.test.ts`; VC-SRF-12 stand-in).** Measured on the development machine: `airfoil_from_naca` 15 ms (budget 20), `interpolate_curve` 10 000 points 68 ms (200), `analyze_surface_curvature` 100 x 100 123 ms (500), `loft_fuselage` 40 stations 33 ms (3 s), `check_continuity` on every internal edge of a 108-patch shell (195 pairs, 21 samples, G0 to G3) 0.9 s (10 s). The tests allow 4 x the budget for CI noise. The real CRM wing-body STEP (VC-SRF-12 proper) needs STEP import of B-spline faces and was not run.

**Exact kernel: what was done and what was not.** Done on the host and tested (`server/tests/nativeKernelLeaves.test.ts`, `nativeKernelRouter.test.ts`): `encodeBspline` and `native.bsplines` on exact lofts, sent only when the sidecar reports the capability `bsplineSections` (threaded as `WireOptions` through `nativeRecipe` / `nativeArgs`); the Bezier chains stay in the payload as the fallback, so an older sidecar ignores the new field. **NOT COMPILED at the time (no `cargo`, no OCCT here; compiled and run since, �13.8):** `solver/crates/llull-kernel-occt/cpp/features.cxx` (`bspline_wire`, `skinned_solid_bsplines`: one `Geom_BSplineCurve` edge per section plus the straight closing edge, multiplicity / length validation, ThruSections with compatibility check off like the chain path), `features.hxx`, `src/features.rs` (ffi + wrapper), `src/recipe/nodes.rs` (loft tries `bsplines` first and falls back to `chains` on a refusal or malformed data; unit test with degree-1 B-spline squares, volume 8, and the fallback), `solver/bins/llull-kernel/src/session.rs` (capability `bsplineSections` in `info`, test assertion). First actions when the toolchain exists: `cargo test -p llull-kernel-occt -p llull-kernel`, then VC-SRF-22 (section fidelity) on a NACA wing with the capability on and off, and VC-SRF-11 on OCC. **Not built, deliberately:** OCC thicken / sew to B-rep and STEP of sheets. They need a new recipe leaf for a B-spline face (with its trim wire), new nodes in `shapeRecipe.ts`, `kernelLeaves.ts`, `recipe/nodes.rs` and C++ (`Geom_BSplineSurface` + `BRepBuilderAPI_MakeFace`, `BRepBuilderAPI_Sewing`, `BRepOffsetAPI_MakeThickSolid`) with no way to compile or run any of it here; TS hooks alone would be dead code (knip) and unverifiable, so they were not written. VC-SRF-24 stays on the mesh (2 %).

**Still deferred (all kernel-bound or data-bound):** B-rep sewing / thickening / STEP of sheets and CRM (above), `faceIndex` / `edgeIndex` on B-rep faces, `request_surface_waiver` and waiver / PLM linkage, `check_surface_quality` section deviation of lofts and wings, `by.planes` trims, G1 / G2 across a fill of a filleted B-rep corner, `smoothing` of `approximate_curve`, `.af` / Selig file airfoils inside `import_openvsp_wing`, the real `TR1208.vsp3` and CRM files.

### 13.8 SOLVER-VERIFY: the native kernel run (2026-10-20)

First compile of the SRF-3 sidecar code (OCCT 7.9.2 built from the pinned source with MinGW GCC 16.2 on Windows 11; no MSVC on the machine,
`docs/decisions/SV1-solver-toolchain-windows.md`). `features.cxx` / `features.hxx` / `src/features.rs` / `recipe/nodes.rs` / `session.rs` compiled
unchanged (only `cargo fmt` changes); clippy `-D warnings` clean; `cargo test -p llull-kernel-occt -p llull-kernel` pass.

**Defect found by the first run:** the loft from ONE multi-span B-spline edge per section was a valid, exact solid (its fine tessellation gave
the exact volume), but OCC's Gauss rule (mass properties, `analyze`) integrated faces bounded by such an edge span-blind: the degree-1
square loft of `nodes.rs` gave 6.963 instead of 8 and the NACA 0012 half wing 0.8459 m^3 instead of 0.959117 (cap areas +0.85 %).
**Fix:** `bspline_wire` builds one edge per knot span (`Geom_BSplineCurve::Segment`, still exact, rational sections included), so the skin has
one face per span as with the Bezier chains. Splitting at integration time instead was tried and reverted: it also moved the NIST
reference volumes (VC-KRN-25, pinned to OCP's Gauss values) by up to 1.3e-4. Regression: `features.rs`
`b_spline_sections_integrate_to_the_exact_volume` (square 8, rational circle 2 pi).

**Measured** (`server/tests/nativeKernelSurfacing.test.ts`, sidecar capability `bsplineSections` on):

| VC | Result |
| --- | --- |
| VC-SRF-11 on OCC | exact B-rep volume 0.9591167 m^3 (closed form 0.959117, 3e-7); `mass_properties` (mesh method for lofts) 0.959110 |
| VC-SRF-22 | root (c = 2 m) and tip (c = 1 m) airfoil curves, 400 samples each, project on the skin faces within 1e-5 chord |

Not run: VC-SRF-15 / 16 / 23 / 24 on OCC (no kernel sheet ops exist, §13.7), the face-query `distance` paths (crash of the MinGW-built
sidecar in `BRepExtrema_DistShapeShape`, see the record).
