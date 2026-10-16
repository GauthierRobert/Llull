# Research B — "Is this assembly physically buildable?" gate

Scope: interference / clearance, thickness, geometry validity, connectivity (floating parts), DFM rules & fits,
swept/dynamic interference. Target kernels: Manifold (`manifold-3d` 3.5.4 installed) and OCCT (`opencascade.js`
1.1.1 installed), plus `three-mesh-bvh` 0.9.16 (installed in root package.json).

Convention: **[Rn]** = source actually fetched (list at end). Lines marked **(inference)** are my design reasoning,
not a claim from a source. Where a source could not be fetched (JS-rendered help, login wall) it is said so and
no content is attributed to it.

---

## 1. Static interference detection — categories in mature CAD

### 1.1 SOLIDWORKS Interference Detection [R1]
Options (as documented by CATI, a SOLIDWORKS reseller; official help.solidworks.com pages are JS-rendered and
returned no body to the fetcher):
- **Treat coincidence as interference** — "Reports coincident entities as interferences."
- **Show ignored interferences** — ignored pairs shown greyed; hidden when cleared.
- **Treat subassemblies as components** — subassembly = one unit; internal interferences not reported.
- **Include multibody part interferences** — reports body-vs-body inside a multibody part.
- **Make interfering parts transparent**.
- **Create fasteners folder** — interferences involving fasteners (custom property `IsFastener` = 1; Toolbox
  fasteners have it by default) go into a separate folder.
- **Create matching cosmetic threads folder** — properly matched cosmetic threads segregated; mismatched threads
  still reported.
- **Ignore hidden bodies/components**.
- Results: each interference listed **with its volume**; selecting it highlights it in red.

### 1.2 SOLIDWORKS Clearance Verification
Official PropertyManager pages were not fetchable (JS shell). Search-result summaries say clearances
≤ "Minimum Acceptable Clearance" are reported, with an option to ignore clearances equal to the value — **not
verified by fetch; treat as unconfirmed.**

### 1.3 CATIA V5 DMU Space Analysis — Clash [R2][R3][R4]
- Glossary [R3]: **Clash** — "a conflict is detected if two elements occupy the same space zone."
  **Contact** — "a conflict is detected if two elements are in contact." **Clearance** — "a conflict is detected
  if two elements are separated by less than a pre-defined distance." **Sag** — "the fixed sag value for
  calculating tessellation on objects (3D fixed accuracy)." Penetration vector entry covers the case "when one
  product is completely included in another" (containment, no separate type).
- Interference types [R2]: *Contact + Clash*; *Clearance + Contact + Clash* (clearance value "must not be less
  than twice the sag"; contact check uses "the total sag"); *Authorized penetration* — a margin "within which two
  products can occupy the same space zone without generating a clash".
- Computation scopes [R2]: between all components; inside one selection; selection against all; between two
  selections.
- Results [R4]: clash = red intersection curves; contact = yellow triangles; clearance = green triangles. The
  Value field reports **penetration depth for a clash, minimal distance for a clearance, zero for a contact**.
  One penetration vector per pair, origin at the centroid of the clash curves.

### 1.4 Siemens NX Assembly Clearance [R5]
NX Open `Assemblies::ClearanceSet` [R5]: `InterferenceType` = `Soft`, `Touch`, `Hard`, `Cont1In2`, `Cont2In1`,
`NoInterference`; summary counters `NumHard`, `NumSoft`, `NumTouching`, `NumContainment`. Re-analysis methods:
`Lightweight`, `ExactIfLoaded`, `Exact`. (The NX help page with prose definitions was unreachable; the enum
itself establishes the five categories and that containment is directional.)
Working definitions **(inference, consistent with [R5] enum + [R3]/[R6])**: soft = min distance ≤ clearance zone
but no contact; touch = contact without volume overlap; hard = volumetric overlap; containment = one body
entirely inside the other.

### 1.5 PTC (Windchill Visualization / Creo) [R6]
Windchill interference detection: **Interference (Hard)** — "Parts physically interfere by penetration and
volume." **Contact (Touch)** — "Parts are in contact but do not interfere." **Clearance (Soft)** — "Components
with a given distance requirement." (Creo Global Interference GUI page not fetched; toolkit page fetched was the
wrong function — no Creo claim made.)

### 1.6 Fusion and Onshape [R7][R8]
- Fusion Inspect > Interference [R7]: optional **Include Coincident Faces**; results list groups with
  "positive, non-zero interference Volume"; with coincident faces enabled and no overlap, the dialog may list
  "only zero-volume Groups" (touching shows as zero volume).
- Onshape [R8]: interference shown in red, parts listed; options "Include standard content" and "Show top level
  only" (hides interferences internal to selected subassemblies); hover shows the interference bounding box
  L×W×H. No volume reporting stated.

### 1.7 Consolidated taxonomy for llull **(inference)**
| Class | Test | Severity default |
|---|---|---|
| `hard` | overlap volume > ε_vol | error |
| `containment_a_in_b` / `b_in_a` | overlap volume ≈ volume of smaller body | error |
| `touch` (coincident) | overlap volume ≤ ε_vol and min distance ≤ ε_len | info (error if `treat_coincidence_as_interference`) |
| `soft` (clearance) | ε_len < min distance < clearance | warning |
| `clear` | min distance ≥ clearance | — |
Options mirrored from SW/CATIA/NX: scope (all / within selection / selection vs all / two selections), ignore
hidden, treat subassemblies as components, fastener folder (by tag), authorized penetration (press fits), report
volume + penetration depth + min distance.

---

## 2. Thickness analysis

### 2.1 Tools
- SOLIDWORKS Thickness Analysis [R9]: target thickness; **Show thin regions** (thinner than target) / **Show
  thick regions** with a **thick region limit**; **Treat corners as zero thickness**; **Resolution** slider (higher
  = more precise, slower); continuous vs discrete colour scale.
- NX: molded-part validation includes "wall thickness checks" and "draft angle analysis" [R10]; Check-Mate
  "automates design rule checks" with a standard library and custom rules [R10]. NX Mold Connect DFM KB is behind
  a login (not fetched).

### 2.2 Algorithms [R11]
Baltadouros & Duflou, "Process-Aware Thickness Analysis in CAD Models using Hybrid Geometric Methods",
arXiv:2609.15245 (preprint, not peer-reviewed):
- **Ray-based**: "casting a ray inward along the surface normal and recording the distance to the first opposing
  surface intersection." Fails: "ambiguous results when opposing surfaces are not parallel"; "spuriously large
  values" where no opposing surface.
- **Sphere-based** (maximal inscribed sphere / rolling ball): "the diameter of the largest inscribed sphere that
  fits within the solid"; approximated by sampling candidate centres along the inward ray. Fails: "tends to
  underestimate thickness near convex edges and corners" (not fixed by mesh refinement).
- Mapping: sphere method for molding (max-thickness, non-uniformity); ray method for milling (min-thickness, thin
  features).
- (Analysis Situs thickness page was unreachable — ECONNREFUSED.)

### 2.3 Thresholds by process (vendor design guides; general guidance, not standards)
| Process | Value | Source |
|---|---|---|
| Injection moulding, ABS | 1.143–3.556 mm | Protolabs [R12] |
| Injection moulding, nylon | 0.762–2.921 mm | [R12] |
| Injection moulding, polycarbonate | 1.016–3.81 mm | [R12] |
| Injection moulding, PP / PS | 0.889–3.81 mm | [R12] |
| Injection moulding, acetal / LCP | 0.762–3.048 mm | [R12] |
| Injection moulding, PE | 0.762–5.08 mm | [R12] |
| Injection moulding, adjacent-wall rule | "no less than 40 to 60 percent that of adjacent walls"; ribs/boss walls ≈ 40–60 % of adjacent wall | Protolabs [R13] |
| Injection moulding draft | 0.5° vertical faces min, 2° most situations, 3° shut-off/light texture, 5°+ heavy texture | [R12] |
| CNC machining | min wall 1/32" (0.794 mm); height:thickness ≤ 10:1 | Xometry [R14] |
| DMLS (non-Al metals) | x-y walls ≥ 0.1524 mm (HR) / 0.3048 mm (NR); horizontal/angled 0.015" (HR) / 0.030" (NR) | Protolabs [R15] |
| DMLS aluminium | 0.762–1.016 mm | [R15] |
| SLS / MJF nylon | 0.762 mm / 0.508 mm | [R15] |
| SLA | 0.4064 mm (NR/HR), 0.2032 mm (MR) in build direction | [R15] |
| Sand casting | min web/wall 0.10" Al, 0.13" Mg, 0.13" steel | Engineers Edge [R16] (secondary source; foundry-dependent) |
| Die casting | Xometry guide has a "Wall Thicknesses" section but values are inside a gated download — **no value recorded** | [R17] |

ISO/ASTM 52910 (AM design requirements, guidelines and recommendations): BSI lists BS EN ISO 52910 as current,
published 2022-08-24 [R18]. Its text/scope was not accessible (preview 403); **no clause content or numeric
values are claimed** — do not cite it for thresholds.

Recommendation **(inference)**: ship thresholds as a data table keyed by `process` + `material`, each row
carrying its source URL; default gate = "min wall < process minimum ⇒ warning", "thickness ≈ 0 ⇒ error".

---

## 3. Geometry validity checks

### 3.1 OCCT (exact B-rep)
- **`BRepCheck_Analyzer(S, GeomControls=true, isParallel=false, isExact=false)`** [R19] — "A framework to check
  the overall validity of a shape." `IsValid()` covers: edges with ≥2 vertices in range, edge/face
  representations within tolerance, wires closed & non-self-intersecting, one outer wire per face, orientation,
  **shells bounding a solid are closed, one enclosing shell per solid**, SameParameter/SameRange. `isExact` uses
  `BRepLib_CheckCurveOnSurface` (slower, precise). Already used in `packages/kernel-occt/src/occtKernel.ts:127`.
- **`BRepAlgoAPI_Check(S[, S2, op], bTestSE, bTestSI)`** [R20] — validity of one shape or a pair for a given
  Boolean op; checks small edges and self-interference; `IsValid()`, `Result()` (list of `BOPAlgo_CheckResult`).
- **`BOPAlgo_ArgumentAnalyzer`** [R21] — modes: ArgumentType, SelfInter, SmallEdge, RebuildFace, Tangent,
  MergeVertex, MergeEdge, Continuity, CurveOnSurface; `HasFaulty()`, `GetCheckResult()`; fuzzy value via
  `BOPAlgo_Options`. **Marked unsupported in opencascade.js 1.1.1** (`dist/Supported APIs.md` line 468, red
  badge) — use `BRepAlgoAPI_Check` instead (supported).
- **`BRepExtrema_DistShapeShape`** [R22] — min distance; `Value()`, `NbSolution()`, `SupportTypeShape1/2()`
  (vertex/edge/face), **`InnerSolution()`** — "True if one of the shapes is a solid and the other shape is
  completely or partially inside the solid"; `SetMultiThread()`; Extrema flag/algo args "are not used in
  computation and are obsolete"; default deflection `Precision::Confusion()`.
- **`BRepExtrema_ShapeProximity(S1, S2, tol)`** [R23] — triangulation-based; tol = 0 ⇒ "detect only intersecting
  faces (containing triangles with common points)"; tol > 0 also faces within tol; `OverlapSubShapes1/2()` face
  ids. Fast broad phase for "which faces touch/clash".
- **Interference volume**: `BRepAlgoAPI_Common` + `BRepGProp::VolumeProperties` **(inference; standard pattern)**.
  OCCT spec [R24]: COMMON of solids touching by a face gives **an empty compound** because the common part's
  dimension (2) is lower than the arguments' — so touching ⇒ empty Common ⇒ use DistShapeShape ≈ 0 to classify
  `touch`. **Fuzzy option** handles "touching and near-coincident, misaligned entities"; **Gluing**
  (`GlueOff/GlueShift/GlueFull`) for partial/full coincidence; Safe mode keeps inputs untouched; OBB speeds
  intersection [R24].
- **ShapeAnalysis**: `ShapeAnalysis_FreeBounds` — free bounds are "wires consisting of edges referenced by the
  faces of the shape only once" (⇒ open shell / not watertight) [R25]; `ShapeAnalysis_CheckSmallFace` — spot
  faces, strip faces (width < tol), splitting vertices, pins, twisted faces [R26]; `ShapeAnalysis_ShapeContents`
  — counters `NbSolids`, `NbShells`, `NbFreeFaces`, `NbFreeWires`, `NbFreeEdges`, … (no per-counter docs) [R27].
  Free faces/shells outside a solid = **zero-thickness sheet** signal **(inference)**.
- opencascade.js 1.1.1 support (local `node_modules/opencascade.js/dist/Supported APIs.md`, green badge):
  `BRepCheck_Analyzer`, `BRepAlgoAPI_Check`, `BRepAlgoAPI_Common`, `BRepExtrema_DistShapeShape`,
  `BRepExtrema_ShapeProximity`, `BRepExtrema_SelfIntersection`, `BRepGProp`, `BRepClass3d_SolidClassifier`,
  `IntCurvesFace_ShapeIntersector`, `ShapeAnalysis_FreeBounds`, `ShapeAnalysis_ShapeContents`,
  `ShapeAnalysis_CheckSmallFace`, `BRepOffsetAPI_MakeThickSolid`. Unsupported: `BOPAlgo_ArgumentAnalyzer`.

### 3.2 NX Examine Geometry / Check-Mate
NX Open `ExamineGeometry` check list (ObjectTiny, ObjectMisaligned, BodyDataStructures, BodyConsistency,
BodyFaceIntersections, BodySheetBoundaries, FaceSmoothness, FaceSelfIntersection, FaceSpikesCuts, EdgeSmoothness,
EdgeTolerances) appeared only in search snippets — the Siemens doc page redirects to a login; **unconfirmed**.
nxjournaling [R28] confirms body structure, body consistency, face–face intersection, face self-intersection tests
and recommends that a model "pass the face and body checks before releasing the file for production."
CATIA "examine geometry" equivalent: not researched to a fetched source.

### 3.3 Manifold (mesh) [R29][R30][R31]
JS API (`manifold-encapsulated-types.d.ts`, installed 3.5.4 and upstream master):
- `status(): ErrorStatus` — "Returns the reason for an input Mesh producing an empty Manifold"; propagates like
  NaN; "Empty meshes may still show NoError, for instance the intersection of non-overlapping meshes."
- `ErrorStatus` = `NoError | NonFiniteVertex | NotManifold | VertexOutOfBounds | PropertiesWrongLength |
  MissingPositionProperties | MergeVectorsDifferentLengths | MergeIndexOutOfBounds | TransformWrongLength |
  RunIndexWrongLength | FaceIDWrongLength | InvalidConstruction | ResultTooLarge | InvalidTangents | Cancelled`.
- `isEmpty()` — "Does the Manifold have any triangles?"
- `decompose(): Manifold[]` — "returns a vector of Manifolds that are topologically disconnected." (There is no
  `numComponents()`; use `decompose().length`.)
- `genus()` — number of "handles"; "only meaningful for a single mesh, so it is best to call Decompose() first."
- `minGap(other, searchLength): number` — "Returns the minimum gap between two manifolds. Returns a float between
  0 and searchLength." C++ impl [R31]: computes `*this ^ other`; **if the intersection is non-empty returns 0**,
  else delegates to `Impl::MinGap` with `searchLength`.
- `intersect(other)`, `volume()`, `surfaceArea()`, `boundingBox()`, `numVert()`, `numTri()`, `split(cutter)`,
  `minkowskiSum/minkowskiDifference`, `tolerance()/setTolerance()`, and in 3.5.4 **`rayCast(origin, endpoint):
  RayHit[]`** ("Cast a ray segment, returning all hits sorted by distance") — usable for ray-based thickness.

---

## 4. Connectivity — floating / unattached parts

- SOLIDWORKS FeatureManager prefixes (from search summaries of the help; official page JS-rendered): `(-)` under
  defined, `(+)` over defined, `(f)` fixed, `(?)` not solved; no prefix = fully defined. GoEngineer [R32]
  (fetched) confirms: fixed = "locked down in all six degrees of freedom", shown with `(f)`; float = "can be moved
  in all degrees of freedom again."
- Liaison graph (assembly planning) [R33]: "A liaison is said to exist between a pair of parts if one part
  constrains the freedom of motion of the other by a direct contact"; graph G = (N, E) with parts as nodes.
  Auto-Assembly (Zobov et al., arXiv:2301.02643) [R34] builds assembly sequences from CAD-derived liaison graphs.
- Recommended llull check **(inference)**:
  1. **Intra-part continuity**: for each solid, `decompose().length > 1` (Manifold) or `NbSolids > 1` /
     multiple lumps (OCCT `ShapeAnalysis_ShapeContents`) ⇒ "part has N disconnected lumps".
  2. **Contact/liaison graph**: edge (A,B) if class ∈ {touch, hard(authorised), containment} or a joint/mate/
     fastener connects A and B (llull motion joints are document data). Broad phase AABB, narrow phase
     `minGap(B, ε)` ≤ ε (Manifold) or `BRepExtrema_DistShapeShape.Value()` ≤ ε (OCCT).
  3. **Grounding**: connected components from grounded/fixed parts (base plate, `fixed` flag). Any component with
     no grounded node ⇒ `floating` error; parts in a grounded component connected only by `touch` (no joint,
     no fastener) ⇒ `resting_only` warning (contact without constraint).

---

## 5. DFM rules and fits

### 5.1 SOLIDWORKS DFMXpress rule set [R35]
Drill: hole diameters, flat-bottom holes, hole entry/exit surfaces, holes intersecting cavities, partial holes,
linear and angular tolerances, standard drill/punch size. Mill: deep pockets and slots, inaccessible features,
sharp internal corners, fillets on outside edges. Turn: minimum corner radii, bore relief. Sheet metal: hole
diameter to thickness ratio, hole to edge distance, hole spacing, bend radii ("bend radius should be at least
equal to the material thickness" for most materials). Injection molding: minimum and maximum wall thickness.
(Default numeric parameters: not on the fetched page; the drill "< 3.0 mm diameter / depth:diameter > 2.75"
figures appear only in search snippets of the JS-rendered help — unconfirmed.)

### 5.2 NX Check-Mate / DFM
Check-Mate automates design rule checks with a standard library and custom rules; NX molded-part validation
includes wall thickness and draft analysis [R10]. A product named "DFM Advisor" could not be confirmed.

### 5.3 Fits — ISO 286 (public catalogue info)
- Preferred hole-basis fits (ISO 286-1 / ANSI B4.2 symbols) [R36]: H11/c11 loose running; H9/d9 free running;
  H8/f7 close running; **H7/g6 "Sliding fit not intended to run freely, but to move and turn freely and locate
  accurately"**; H7/h6 locational clearance; H7/k6, H7/n6 locational transition; H7/p6 locational interference;
  H7/s6 medium drive; H7/u6 force fit.
- IT grades (ISO 286 Table 1, µm) [R37]: IT6 / IT7 = 6/10 (≤3 mm), 8/12 (3–6), 9/15 (6–10), 11/18 (10–18),
  13/21 (18–30), 16/25 (30–50).
- Use in gate **(inference)**: a revolute joint pin/hole pair declared with fit `H7/g6` ⇒ expected nominal
  clearance > 0 ⇒ model must show `soft`/`touch` (coaxial, equal nominal diameters is acceptable as "nominal
  zero, fit-toleranced") but never `hard`; declared interference fits (`p6`, `s6`, `u6`) are *authorised
  penetration* (CATIA concept [R2]) and must not fail the gate. Fundamental deviations (e.g. g) not fetched —
  do not hardcode them.

---

## 6. Swept / dynamic interference during motion

- CATIA DMU Kinematics Simulator [R38]: "analyzes mechanism motion by checking interferences and computing minimal
  distances"; "'stop on collision' option freezes the motion"; generates "the swept volume of a moving part …
  through its entire range of motion", reusable in clash analysis "to check … that the mechanism can still be
  operated."
- NX Motion: NX Open `Motion.PostProcess` exposes interference/measure/trace toggles and `CreateEnvelope` per
  search snippets; the doc page redirects to login — **unconfirmed**.
- SOLIDWORKS Move Component collision detection (stop at collision) and **Physical Dynamics** ("let the parts
  continue moving and push other parts out of the way") [R39].
- FCL [R40]: collision (optionally all overlapping triangles), distance, **tolerance verification** ("closer or
  farther than a tolerance distance"), **continuous collision detection** ("whether the two moving models overlap
  during the movement"); shapes incl. mesh, convex, primitives, octree. C++ — no JS binding verified.
- three-mesh-bvh [R41]: `intersectsGeometry(geom, geometryToBvh): boolean`; `closestPointToGeometry(geom,
  geometryToBvh, target1, target2, minThreshold=0, maxThreshold=Infinity): HitPointInfo|null` ("can be very slow
  without a geometry.boundsTree"); `closestPointToPoint`; `bvhcast(otherBvh, matrixToLocal, {intersectsTriangles})`
  for dual-tree triangle-pair traversal; `shapecast`; `intersectsBox`, `intersectsSphere`; build strategies
  `CENTER` (default, fastest), `AVERAGE`, `SAH` (slowest build, best bounds); `targetLeafSize` default 10; BVH is
  static — `refit` after vertex edits; transforms passed as matrices so rigid motion needs no rebuild.
- Recommended **(inference)**: discrete sampling over the motion cycle — per frame, compute each moving pair's
  relative matrix, run `intersectsGeometry` (hard yes/no) and `closestPointToGeometry(maxThreshold=clearance)`
  for min distance; record min clearance and the frame/param where it occurs; on a hit, refine by bisection of
  the joint parameter, then compute volume with Manifold `intersect` at that pose. Choose step so per-frame
  max vertex displacement < clearance to avoid tunnelling (conservative-advancement idea). Swept-volume union
  (CATIA-style) via Manifold `hull`/union of sampled poses only as an optional visual/"envelope" artefact.

---

## 7. Recommended algorithms per check

| Check | Manifold path (default kernel) | OCCT path (`?kernel=occt`) |
|---|---|---|
| Body validity | `status() !== 'NoError'`, `isEmpty()` | `BRepCheck_Analyzer.IsValid()`; `BRepAlgoAPI_Check` (small edges, self-inter) |
| Watertight / sheet (zero thickness) | NotManifold status on input; `volume() ≈ 0` with `surfaceArea() > 0`; mean thickness proxy 2V/A | `ShapeAnalysis_FreeBounds` open wires; `ShapeContents.NbFreeFaces/NbShells` outside solids; `CheckSmallFace` strip faces |
| Disconnected lumps | `decompose().length > 1` | `NbSolids > 1` / explore `TopAbs_SOLID` |
| Hard interference + volume | `a.intersect(b).volume() > ε_vol` | `BRepAlgoAPI_Common` + `BRepGProp.VolumeProperties` |
| Containment | intersection volume ≈ min(volA, volB) | same, or `DistShapeShape.InnerSolution()` |
| Touch | intersect empty/≈0 vol and `minGap(b, ε) ≤ ε` | Common = empty compound and `DistShapeShape.Value() ≤ ε` |
| Clearance (soft) | `minGap(b, clearance) < clearance` | `DistShapeShape.Value()`; broad phase `BRepExtrema_ShapeProximity(tol=clearance)` |
| Thickness | `rayCast` along inward normals (ray method) + inscribed-sphere sampling | `IntCurvesFace_ShapeIntersector` rays; `BRepExtrema_DistShapeShape` point→shape for sphere radius |
| Floating parts | contact graph from the above + joints + grounded flag → connected components | same |
| Motion sweep | three-mesh-bvh per-frame `intersectsGeometry` / `closestPointToGeometry` on tessellation | same (mesh out of kernel) |

---

## References (all accessed 2026-10)
- [R1] SOLIDWORKS: Assembly Validation Tools – Part 2 – Interference Detection — CATI — https://www.cati.com/?p=120210
- [R2] Detecting Interferences Using the Clash Command (CATIA V5 DMU Space Analysis) — Dassault Systèmes doc mirror — https://catia-v5-help.anarkia333data.center/online/spaug_C2/spaugbt0302.htm
- [R3] DMU Space Analysis Glossary — Dassault Systèmes doc mirror — https://catia-v5-help.anarkia333data.center/online/spaug_C2/spauggl.htm
- [R4] Reading Clash Command Results — Dassault Systèmes doc mirror — https://catia-v5-help.anarkia333data.center/online/spaug_C2/spaugbt0303.htm
- [R5] NXOpen::Assemblies::ClearanceSet Class / Summary Struct — NX Open C++ reference (ugapi mirror) — https://www.ugapi.com/doc/NXOpen/a00559.html ; https://www.ugapi.com/doc/NXOpen/a00560.html
- [R6] Introduction to Interference Detection — PTC Windchill Help Center 12.1 — https://support.ptc.com/help/wnc/r12.1.0.0/en/Windchill_Help_Center/WVSInterferenceDetection/WVSInterferenceDetectOver.html
- [R7] Detect interferences and coincident faces — Autodesk Fusion Help — https://help.autodesk.com/cloudhelp/ENU/Fusion-Model/files/SLD-INTERFERENCE.htm
- [R8] Interference detection — Onshape Help — https://cad.onshape.com/help/Content/View/interference_detection.htm
- [R9] Thickness Analysis Tool – SOLIDWORKS Utilities — GoEngineer — https://www.goengineer.com/blog/thickness-analysis-tool-solidworks-utilities
- [R10] How to avoid rework with NX's validation and simulation tools — CLEVR — https://www.clevr.com/blog/how-to-avoid-rework-with-nxs-validation-and-simulation-tools
- [R11] Baltadouros, Duflou — Process-Aware Thickness Analysis in CAD Models using Hybrid Geometric Methods — arXiv — https://arxiv.org/html/2609.15245v1
- [R12] Design Guidelines: Plastic Injection Molding — Protolabs — https://protolabs.com/services/injection-molding/plastic-injection-molding/design-guidelines
- [R13] Improving Part Design with Uniform Wall Thickness — Protolabs — https://www.protolabs.com/resources/design-tips/improving-part-design-with-uniform-wall-thickness/
- [R14] CNC Machining Thin Walls — Xometry — https://www.xometry.com/resources/machining/cnc-machining-thin-walls/
- [R15] 7 Mistakes to Avoid When Designing 3D-Printed Parts — Protolabs — https://protolabs.com/resources/design-tips/7-mistakes-to-avoid-when-designing-3d-printed-parts
- [R16] Design for Sand Casting — Engineers Edge — https://www.engineersedge.com/sand_cast.htm
- [R17] Die Casting Design Guide — Xometry — https://www.xometry.com/resources/design-guides/die-casting-design-guide/
- [R18] BS EN ISO 52910 Additive manufacturing. Design. Requirements, guidelines and recommendations — BSI Knowledge — https://knowledge.bsigroup.com/products/bs-en-iso-52910-additive-manufacturing-design-requirements-guidelines-and-recommendations
- [R19] BRepCheck_Analyzer Class Reference — OCCT 8.0.1 — https://occt3d.com/dev/doc/refman/html/class_b_rep_check___analyzer.html
- [R20] BRepAlgoAPI_Check Class Reference — OCCT — https://occt3d.com/dev/doc/refman/html/class_b_rep_algo_a_p_i___check.html
- [R21] BOPAlgo_ArgumentAnalyzer Class Reference — OCCT — https://occt3d.com/dev/doc/refman/html/class_b_o_p_algo___argument_analyzer.html
- [R22] BRepExtrema_DistShapeShape Class Reference — OCCT — https://occt3d.com/dev/doc/refman/html/class_b_rep_extrema___dist_shape_shape.html
- [R23] BRepExtrema_ShapeProximity Class Reference — OCCT — https://occt3d.com/dev/doc/refman/html/class_b_rep_extrema___shape_proximity.html
- [R24] Boolean Operations (specification) — OCCT — https://occt3d.com/dev/doc/overview/html/specification__boolean_operations.html
- [R25] ShapeAnalysis_FreeBounds Class Reference — OCCT — https://occt3d.com/dev/doc/refman/html/class_shape_analysis___free_bounds.html
- [R26] ShapeAnalysis_CheckSmallFace Class Reference — OCCT — https://occt3d.com/dev/doc/refman/html/class_shape_analysis___check_small_face.html
- [R27] ShapeAnalysis_ShapeContents Class Reference — OCCT — https://occt3d.com/dev/doc/refman/html/class_shape_analysis___shape_contents.html
- [R28] Examine Geometry (journal) — NXJournaling — https://nxjournaling.com/node/29
- [R29] manifold.h — elalish/manifold (GitHub) — https://raw.githubusercontent.com/elalish/manifold/master/include/manifold/manifold.h
- [R30] manifold-encapsulated-types.d.ts / manifold-global-types.d.ts — elalish/manifold (GitHub) — https://raw.githubusercontent.com/elalish/manifold/master/bindings/wasm/manifold-encapsulated-types.d.ts ; https://raw.githubusercontent.com/elalish/manifold/master/bindings/wasm/manifold-global-types.d.ts (also local `node_modules/manifold-3d` 3.5.4)
- [R31] manifold.cpp (MinGap, Genus, Status) — elalish/manifold (GitHub) — https://raw.githubusercontent.com/elalish/manifold/master/src/manifold.cpp
- [R32] SOLIDWORKS Fixed vs Floating Components — GoEngineer — https://www.goengineer.com/blog/solidworks-fixed-vs-floating-components
- [R33] US5442563A Backward assembly planning with DFA analysis — Google Patents — https://patents.google.com/patent/US5442563A/en
- [R34] Zobov et al., Auto-Assembly: a framework for automated robotic assembly directly from CAD — arXiv — https://arxiv.org/abs/2301.02643
- [R35] SOLIDWORKS Tech Tip – Using DFMXpress — SOLIDWORKS Blog — https://blogs.solidworks.com/products/solidworks/solidworks-tech-tip-using-dfmxpress
- [R36] Preferred fits and tolerance table (ISO 286-1 / ANSI) — AmesWeb — https://amesweb.info/fits-tolerances/preferred-tolerances-table.aspx
- [R37] IT Grade — Wikipedia — https://en.wikipedia.org/wiki/IT_Grade
- [R38] DMU Kinematics Simulator 2 (KIN) — Dassault Systèmes 3DSwym CATIA community wiki — https://3dswym.3dexperience.3ds.com/wiki/catia-user-community/dmu-kinematics-simulator-2-kin_5TFJgAkXQbuBy3zwMAj1dg
- [R39] SOLIDWORKS: Physical Dynamics — CATI — https://cati.com/?p=130327
- [R40] FCL README — flexible-collision-library (GitHub) — https://raw.githubusercontent.com/flexible-collision-library/fcl/master/README.md
- [R41] three-mesh-bvh API.md — gkjohnson (GitHub) — https://raw.githubusercontent.com/gkjohnson/three-mesh-bvh/master/API.md
- Local: `node_modules/opencascade.js/dist/Supported APIs.md` (opencascade.js 1.1.1 binding coverage); `packages/kernel-occt/src/occtKernel.ts`.

Not fetchable (no content attributed): help.solidworks.com (JS shell), Siemens docs/support (login redirect),
NX help mirror (DNS fail), analysissitus.org and catiadoc.free.fr (connection refused), ISO/ANSI previews (403).
