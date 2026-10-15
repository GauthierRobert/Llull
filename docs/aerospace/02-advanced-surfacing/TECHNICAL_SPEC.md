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
| Recipe | `ShapeRecipe` | `geometry/shapeRecipe.ts` | Leaves `solid` (entity) + `boolean`, `fillet`, `chamfer`, `blend`, `shell`, `place`, `scale` | No `sew`, `trim`, `fill`, `thicken`, `offset`; leaves must be closed solids |

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

"Bound" ≠ "works": every class used must get an integration test in `server/tests/` (TR-SRF-40).

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

### 4.2 Plugin `@aero` — `packages/domain-aero/src/<topic>/{catalog,plugin}.ts` (toolset `aero`)

| Command | Q/M | K | Params (sketch) | @affects | @invariant | @failure |
| --- | --- | --- | --- | --- | --- | --- |
| `airfoil_from_naca` | M | – | `designation` (4 digits or 5 digits 210..250 / reflexed COULD), `trailingEdge: 'open'\|'closed'`, `points` (default 161), `spacing: 'cosine'\|'uniform'`, `plane?` (origin, rotation), `chord?` | `aero.airfoils[id]` + derived planar `nurbs_curve` | thickness applied ⟂ mean line; LE at origin, chord along +x | unknown series, t = 0 → no-op |
| `import_airfoil` | M | – | `text` (file content) or `path` (CLI/desktop exchange), `format: 'auto'\|'selig'\|'lednicer'`, `normalize: 'none'\|'chord'`, `fit` | airfoil def + curve | raw points stored with sha256 | < 5 points, non-numeric data, self-intersection → no-op |
| `airfoil_properties` | Q | – | `airfoilId` | — | `data {tMax, xTMax, camberMax, xCamberMax, leRadius, teThickness, teAngleDeg, area, centroid, format, pointCount}` | |
| `create_wing` | M | K for solid | `sections[]` (airfoilId, span, chord, twistDeg, offsets?) and/or `planform {semiSpan, rootChord, tipChord|taper, area?, aspectRatio?, sweepDeg, sweepLocation, dihedralDeg}`, `twistLocation` (0.25), `loft`, `mirror`, `tip`, `origin` | `aero.wings[id]` + derived loft entity (sections exact; TE edge kept) | any 3 independent planform values resolve the rest; sections ordered by span | over/under-determined planform, non-increasing span → no-op |
| `edit_wing` | M | per op | `id`, partial WingDef | re-derives | | |
| `wing_properties` | Q | – (core math from def) / K for wetted area & volume | `id` | — | `data {span, projectedSpan, areaRef, areaPerSide, aspectRatio, taper, mac, yMac, xLeMac, sweepLeDeg, sweepC4Deg, sweepTeDeg, wettedArea?, volume?}` | |
| `set_aircraft_frame` | M | – | `datum`, axes, `units` | `aero.frame` | right-handed orthonormal | |
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
export interface SurfaceAnalysisPort {
  faceSamples(shape: ShapeHandle, face: number, uv: ReadonlyArray<readonly [number, number]> | { nu: number; nv: number }): SurfaceSample[] | null;
  edgeSamples(shape: ShapeHandle, edge: number, count: number): EdgeCurveSample[] | null;       // κ, τ, comb
  edgeContinuity(shape: ShapeHandle, edge: number, count: number): EdgeContinuitySample[] | null;
  distance(shape: ShapeHandle, points: ReadonlyArray<Vec3>): Array<{ distance: number; signed: number; face: number }> | null;
  bspline(shape: ShapeHandle, face: number): NurbsSurfaceData | null;                            // inspect_nurbs
}
export interface GeometryKernel { /* … existing … */ readonly analysis?: SurfaceAnalysisPort }  // optional: Manifold omits it
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

## 7. UI / CLI / MCP surfaces

- **UI** (`src/ui`): menus generated from `listCommands()`; param forms from zod. New overlays in
  `src/ui/viewport/3d/analysis/`: `CurvatureCombOverlay` (lines from `analyze_curve_curvature.data.samples[].comb`),
  `ZebraMaterial` (view-space normal → stripe function, direction & spacing uniforms; pure shading of the existing
  tessellation, no command needed — exact normals come from `tessellate`), `CurvatureMapMaterial` (per-vertex scalar
  from `analyze_surface_curvature` grid, legend + clamping), `DraftMapMaterial`. Continuity results table in an
  inspector panel. Airfoil/wing/fuselage dialogs with tables (sections, stations).
- **CLI**: `llull --app run plan.json`, `llull query <command> '<json>'`; `import_airfoil` accepts `path` through
  `/exchange` (KI6).
- **MCP**: toolsets `surface` and `aero` appended to `TOOLSET_NAMES`; `search_tools` finds them by keywords
  (airfoil, NACA, wing, curvature, zebra, G2). Prompts: an `aero_wing` prompt describing the canonical plan.

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
| Unit (aero data) | `tests/unit/aero/naca.test.ts` | generated sections vs `validation/data/naca_*_selig_81.csv` (exact to 1e-8) and vs pinned UIUC files (downloaded by a fixture script when network allows; skipped offline with a notice) | VC-SRF-01..04 |
| Golden | `tests/golden/plans.ts` add `aero_naca_trap_wing`, `aero_tr1208`, `surface_torus_analysis`, `aero_sears_haack_body` (plans in `validation/plans/target_*.json`) | id-normalised snapshot + replay equality | VC-SRF-10, 11, 13, 19 |
| Kernel integration | `server/tests/occtSurfacing.test.ts`, `occtAnalysis.test.ts` | every bound OCC class used (§1.2); cross-check curvature/continuity vs `LocalAnalysis_*`; sewing/fill tolerances | VC-SRF-05, 12, 15, 16, 17, 18 |
| Python oracle | `server/tests/*.integration.test.ts` with bundled CadQuery/OCP | same STEP evaluated with OCP `GeomLProp_SLProps` / `BRepGProp` to cross-check llull numbers | VC-SRF-11, 12 |
| Quality gate | `npm run quality` entry: CRM wing-body STEP (downloaded, sha256 pinned on first fetch) → import → curvature/continuity/area | VC-SRF-12 |
| Production gate | scenario "aero conceptual wing": NACA 23012 root / 0012 tip, 35° sweep, 5° dihedral, −3° washout; export STEP; reimport; volume equal ± 1e-6 rel | VC-SRF-21 |

## 10. Delivery plan

| Milestone | Content | Depends on | Effort (eng-weeks) |
| --- | --- | --- | --- |
| M0 | D1–D3 decisions; `isSheet`; entity kinds; render branches (`add-entity-kind` skill) | — | 2 |
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
