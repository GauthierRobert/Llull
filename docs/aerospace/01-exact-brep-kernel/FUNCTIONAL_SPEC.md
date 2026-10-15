# KRN — Exact B-rep kernel as the production basis — Functional specification

Gap id **KRN** · status: specification (no implementation) · written 2026-10-15 ·
technical counterpart: [TECHNICAL_SPEC.md](TECHNICAL_SPEC.md) · validation: [validation/README.md](validation/README.md)

## 1. Summary

Aerospace parts are defined, toleranced, machined, inspected and certified from an **exact boundary
representation** (B-rep): analytic and NURBS faces, exact edges, closed solids. llull already evaluates exact
OCC shapes behind its `GeometryKernel` (decision KI5), but the product still treats exact geometry as an
option: the default kernel everywhere is Manifold (a mesh kernel), the desktop app does not select OCC
(`desktop/src/backendEnv.ts` sets no `LLULL_KERNEL`), the in-browser OCC runs on the UI thread, the bundled
OCC is a 2020 build (opencascade.js 1.1.1 = OCCT 7.4.0p1, [R11]), **STEP import produces triangle meshes**
(`import_step` → `import_mesh`), edge references after a parametric edit rely on a nearest-point heuristic
(`edgesNear`), mass properties report volume and mass but not centroid or inertia, there is no documented
modelling-tolerance policy for aircraft-scale coordinates (> 70 m, [R24]), and nothing guarantees that a
model regenerates identically after a kernel upgrade. Each of these blocks aerospace use: a supplier cannot
modify an OEM STEP part, a weights engineer cannot trust the inertia tensor, a parametric rib loses its fillets
when a pocket moves, and a 70 m airframe positioned in body-station coordinates has no stated precision. This
gap makes the exact OCC B-rep the **production basis** of llull on the desktop.

## 2. Aerospace context & value

### 2.1 Where exact B-rep matters in aerospace work

| Activity | Who | Exact-B-rep dependency | Today in llull |
| -------- | --- | ---------------------- | -------------- |
| Machined structural parts (ribs, frames, spars, fittings, brackets) cut from plate / billet | design engineer at OEM or tier-1/2 supplier | pockets, corner radii, thin floors, drilled and countersunk holes must be exact faces for CAM, inspection and drawings | exact only with `?kernel=occt` / `LLULL_KERNEL=occt`; default Manifold gives faceted fillets = no fillets (KI5) |
| Receiving OEM data (STEP AP203 / AP214 / AP242) and modifying it | supplier / MRO engineering | imported solids must be editable B-rep: booleans, fillets, holes on imported faces | `import_step` returns meshes; "not parametric — rebuild it" |
| Weight & balance, inertia for loads and dynamics | weights engineer, loads engineer | volume, centroid and inertia tensor of each part in aircraft axes, accurately | `mass_properties` = volume + mass only |
| Assembly in aircraft coordinates (fuselage station / waterline / buttline) | integration / DMU | parts tens of metres from the datum keep micron-level geometry | no policy; display uses float32 (0.0078 mm resolution at 70 m, [R29]) |
| Digital mock-up of large assemblies | DMU, configuration | lightweight representations, instancing, LOD for millions of parts (a 747 has ~6 million parts, [R25]) | instancing only for box/cylinder/sphere primitives |
| Long-term reuse and regression | PLM / methods | same model, same result across software upgrades | no kernel provenance, no cross-version gate |

### 2.2 How the industry does it today

- Commercial CAD systems (CATIA V5/3DEXPERIENCE on CGM, Siemens NX and Solid Edge on Parasolid, Creo on
  Granite, SolidWorks on Parasolid, Fusion on ShapeManager) all use an exact B-rep kernel as the master
  geometry, with persistent topological identification so that features reference faces/edges through edits.
  Parasolid attaches persistent identifiers / attributes to entities (third-party documentation only, see
  sources "Not verified"), Onshape exposes hierarchical deterministic ids in FeatureScript [R18].
- Open source: FreeCAD 1.0 (Nov 2024) shipped topological-naming mitigation based on Realthunder's element
  map: names are derived from the operation history (op codes such as `FUS`, `CUT`, `FLT`; postfixes `;:M`
  modified and `;:G` generated) [R15][R16]; its maintainers state the problem is mitigated, not solved [R16].
  The underlying idea goes back to Kripac 1997 [R17]. OCCT itself provides the history primitives
  (Modified / Generated / Deleted, `BRepTools_History`) [R3].
- Data-exchange quality is checked with **geometric validation properties** (GVP): the exporting system writes
  volume, area and centroid into the STEP file, the importer recomputes and compares (CAx-IF recommended
  practice [R21]). NIST's MBE PMI test models (CTC / FTC / STC) are the public reference parts for this, also
  used by the CAx-IF [R19][R20].

### 2.3 Value for llull

| Value | Statement | Basis |
| ----- | --------- | ----- |
| Unblocks every other aerospace gap | SRF, GDT, XCH, FEA, FTR, CMP all need exact faces/edges and stable names | dependency graph in `docs/aerospace/README.md` |
| Supplier workflow | "open the OEM STEP, add the hole, send back STEP" becomes possible offline on the desktop | FR-KRN-04/05/06 |
| Trustworthy numbers | volume, centroid, inertia exact to ~1e-9 relative or better, also at 70 m from the datum | measured with OCCT 7.9.3: closed-form agreement 1e-14 at origin; 1.2e-9 at 70 m without, 5e-16 with part-frame evaluation (validation §5) |
| Upgrade safety | kernel upgrades (7.4 → 7.9 → 8.0) do not silently change models | FR-KRN-10 |
| AI-native | every capability is a command, so an agent can import, heal, check, measure and modify exact parts through the CLI / MCP | architecture L1 |

## 3. Personas & user stories

| Persona | Description |
| ------- | ----------- |
| P1 Design engineer (structures) | models machined ribs, frames and fittings; needs exact pockets/fillets and correct mass |
| P2 Supplier / MRO engineer | receives OEM STEP, modifies it, returns STEP; cannot rebuild every part from scratch |
| P3 Weights & balance engineer | aggregates mass, CG and inertia of parts and assemblies in aircraft axes |
| P4 DMU / integration engineer | loads large assemblies positioned in body-station coordinates |
| P5 Methods / CAD admin | qualifies llull versions, owns regression and tolerance policy |
| P6 AI agent (Claude Code via `llull` CLI, or an MCP client) | drives the same commands headlessly |

User stories (each maps to FRs):

- US-01 (P1) As a design engineer I want the desktop app to model with the exact kernel by default so that
  fillets, holes and pockets are true faces without any switch. → FR-KRN-01, FR-KRN-16
- US-02 (P2) As a supplier I want to import an OEM STEP file as an exact, healed solid and then cut a pocket
  and fillet its edges. → FR-KRN-04, FR-KRN-05, FR-KRN-12
- US-03 (P2) As a supplier I want an import report (healing actions, maximum tolerance, GVP deltas) so that I
  know whether the received geometry is trustworthy. → FR-KRN-05
- US-04 (P1) As a design engineer I want a fillet I placed on a pocket corner to stay on that corner when I
  change the pocket width parameter. → FR-KRN-06
- US-05 (P3) As a weights engineer I want volume, mass, centroid, inertia tensor, principal moments and axes,
  for parts and assemblies, in document axes, at aircraft scale, with a stated accuracy. → FR-KRN-08, FR-KRN-03
- US-06 (P4) As an integration engineer I want to place parts at body stations beyond 70 m without losing
  geometric precision or getting display artefacts. → FR-KRN-03, FR-KRN-11
- US-07 (P1) As a design engineer I want booleans between near-coincident faces (imported data, misaligned by
  microns) to succeed, with the tolerance I chose shown in the history. → FR-KRN-07
- US-08 (P5) As a CAD admin I want every result validity-checked and every model stamped with the kernel
  version, and a regression gate that re-runs reference models on each kernel upgrade. → FR-KRN-09, FR-KRN-10, FR-KRN-14
- US-09 (P4) As an integration engineer I want 10 000 identical fasteners to cost one exact definition and one
  draw batch. → FR-KRN-11
- US-10 (P6) As an agent I want to run import, heal, validate, measure and modify from the CLI and receive
  structured data (not prose). → FR-KRN-17
- US-11 (P2) As a supplier I want to export the modified part as exact STEP with validation properties. → FR-KRN-13

## 4. Scope / out of scope

### 4.1 Phases

| Phase | Content |
| ----- | ------- |
| **MVP** | OCC default on desktop (server worker) with visible fallback; current OCCT build (7.9.x line) in the server/worker; tolerance policy + document `modelingTolerance`; `import_step_exact` (exact solids, ShapeFix, sewing of shells, import report, tessellated-only detection); `validate_shape`; result validity gating; exact `mass_properties` with centroid + inertia + part-frame evaluation; kernel provenance in documents; determinism golden set; boolean `fuzzy` option |
| **V1** | Persistent topological naming (history-based element names) for fillet / chamfer / shell / hole selections and for imported faces; GVP comparison on import and GVP writing on export; assembly mass properties with instances; browser OCC in a Web Worker (web-only use); instancing of arbitrary exact parts in the viewport; cross-version regression gate |
| **V2** | LOD tessellation ladder and lightweight proxies; streaming / lazy loading of large assemblies; ABC-sample stress tier; JT/glTF lightweight hand-off (with gap XCH); kernel-level parallelism (BOP parallel mode) |

### 4.2 Out of scope (owned elsewhere)

- Freeform surfacing (NURBS authoring, G2 continuity, wing lofts) → gap 02 SRF.
- Semantic PMI / GD&T import and authoring → 03 GDT and 04 XCH (KRN only keeps face identities PMI can attach to).
- JT, IGES, AP242 PMI exchange and LOTAR → 04 XCH (KRN provides the exact shapes and GVP machinery).
- Manufacturing features (hole tables, threads, feature recognition) → 07 FTR (KRN provides exact faces/naming).
- FEA meshing / midsurfaces → 05 FEA.
- Replacing OCC by a commercial kernel; non-manifold / cellular modelling for analysis.

## 5. Functional requirements

| Id | Priority | Requirement | Rationale | Source |
| -- | -------- | ----------- | --------- | ------ |
| FR-KRN-01 | MUST (MVP) | The desktop app SHALL use the exact OCC kernel by default for every document operation; Manifold is used only as an explicit fallback when OCC cannot start, and the UI, CLI and MCP SHALL report the active kernel. | Product direction (OCC on desktop); KI5 exactness is lost under Manifold | KI6; `desktop/src/backendEnv.ts`; `server/src/geometryKernel.ts` |
| FR-KRN-02 | SHOULD (V1) | When the web app executes commands locally with OCC, kernel work SHALL NOT block the UI thread (worker), with the same cancellation/timeout behaviour as the server worker. | 63 MB WASM, 0.8-1 s init, 150-180 ms per op measured in KI4 | KI4; `src/main.tsx` |
| FR-KRN-03 | MUST (MVP) | llull SHALL document and enforce a modelling-precision policy: internal length unit mm; OCC confusion tolerance 1e-7 mm; a guaranteed coordinate envelope that covers a > 70 m airframe positioned in aircraft coordinates; models outside the envelope import/build with a warning. Geometry, mass properties and display SHALL show no precision artefact inside the envelope. | OCC tolerances are tuned for mm [R1]; A380 72.6 m [R24]; float32 display resolution 0.0078 mm at 70 m [R29] | R1, R24, R29 |
| FR-KRN-04 | MUST (MVP) | STEP AP203 / AP214 / AP242 geometry SHALL import as exact B-rep solids (one llull solid per STEP solid, assembly placements, names and colours kept), editable by every exact command (boolean, fillet, chamfer, shell, measure, export). | Supplier workflow; today import gives meshes | R5, R6; `packages/mcp/src/exchangeTools.ts` |
| FR-KRN-05 | MUST (MVP) | Import SHALL heal (ShapeFix, sewing of open shells into solids when closed) and return a report: per body validity before/after, healing actions, max sub-shape tolerance, open shells / free faces, tessellated-only content, and GVP deltas when the file carries GVP. No silent empty or silently faceted result. | Real STEP files carry tolerance gaps (0.1 mm measured on a NIST file) and stale GVP (5/11 disagree) | R4, R5, R21; validation §5 |
| FR-KRN-06 | MUST (V1) | References from features to faces/edges (fillet, chamfer, shell openings, holes, sketch-on-face, PMI anchors) SHALL be persistent: after an upstream parametric edit the same logical entity is re-selected, or the feature reports a broken reference by name — it never silently selects a different entity. | `edgesNear` picks the nearest edge, which can be a different edge after a move | KI5; R3, R15, R16, R17 |
| FR-KRN-07 | SHOULD (MVP) | Booleans SHALL accept an optional fuzzy tolerance (default = OCC confusion), recorded in the feature history; on failure the command SHALL report the argument analysis (self-interference, small edges). | Near-coincident imported faces; OCC fuzzy option | R2 |
| FR-KRN-08 | MUST (MVP) | `mass_properties` SHALL return, from the exact B-rep: volume, surface area, mass, centroid, inertia tensor about the centroid (document axes) and about the origin, principal moments and axes, radii of gyration, with the method and an accuracy estimate. Relative accuracy on analytic solids ≤ 1e-9 (volume, area, inertia) also when the part is 70 m from the origin. | Weight & balance; current command returns volume/mass only | R8; validation VC-KRN-01/02 |
| FR-KRN-09 | MUST (MVP) | Every kernel result committed to the document SHALL pass a B-rep validity check; an explicit `validate_shape` query SHALL report validity, self-intersection, small edges/faces and tolerance excess per entity. | Invalid OCC results make later booleans hang (comment in `occtKernel.ts`) | R9, R2 |
| FR-KRN-10 | MUST (MVP) | Regeneration SHALL be deterministic for a given kernel build (same plan → same topology signature); a regression gate SHALL re-run a reference corpus on every kernel change and report topology/measure drift with tolerance-based comparison across versions. | Upgrade safety; OCCT moves quarterly [R14] | R11, R12, R14 |
| FR-KRN-11 | SHOULD (V1/V2) | Large assemblies: repeated parts SHALL share one exact definition and one display mesh (instancing); the viewport SHALL support levels of detail and lightweight proxies so that assemblies of 10⁴-10⁵ instances stay interactive (budgets in TECHNICAL_SPEC §8). | 747 ≈ 6 M parts [R25]; three.js InstancedMesh/BatchedMesh/LOD [R26] | R25, R26 |
| FR-KRN-12 | MUST (MVP) | The machined-part feature chain (blank, pocket by boolean, corner/floor fillets, through holes, chamfers) SHALL produce exact, valid solids whose mass matches analytic values. | Use case U1 | validation VC-KRN-03 |
| FR-KRN-13 | SHOULD (V1) | Exact STEP export SHALL carry product structure, names, colours and geometric validation properties (volume, area, centroid). | CAx-IF GVP practice | R21 |
| FR-KRN-14 | MUST (MVP) | Each document SHALL record the kernel and version that produced it (and per-step kernel when mixed), shown in document info and checked on load (warning on mismatch). | Traceability (feeds gap 09 PLM) | R11, R13 |
| FR-KRN-15 | SHOULD (MVP) | Users SHALL be able to read and set the document modelling tolerance (linear, angular) within policy limits; import SHALL map STEP uncertainty to it. | STEP `read.precision.mode` / uncertainty | R5 |
| FR-KRN-16 | MUST (MVP) | No silent faceting: when an exact operation falls back to triangles (capability gap) the result SHALL be flagged `faceted`, listed by `check_model`, and blocked from exact export unless the user accepts. | KI5 fallback exists today | KI5 |
| FR-KRN-17 | MUST (MVP) | Every capability above SHALL be a registered command reachable from UI, `llull` CLI and MCP, returning structured `data`. | Architecture L1/L5 | `.claude/rules/architecture.md` |

## 6. Workflows

### 6.1 W1 — Machined rib from a billet (desktop UI)

1. User opens llull desktop; the status bar shows `Kernel: OCC 7.9.x` (FR-KRN-01, FR-KRN-14).
2. Sets units mm; creates the blank 300 × 120 × 25 (`add_box`).
3. Creates the pocket tool and subtracts it (`boolean` subtract) → one exact solid.
4. Selects the 4 vertical pocket corner edges in the viewport (exact edges, highlighted) and applies a 10 mm
   fillet (`fillet_edge`); the history stores persistent edge names (FR-KRN-06).
5. Assigns aluminium; runs Measure → Mass properties: volume 485 716.8147 mm³, centroid, inertia tensor
   (FR-KRN-08); buy-to-fly shown by the FTR gap from blank/part volume.
6. Changes the pocket width parameter 260 → 200: the fillets stay on the pocket corners; volume becomes
   581 716.8147 mm³ (FR-KRN-06).
7. `validate_shape` reports valid (FR-KRN-09); exports exact STEP with GVP (FR-KRN-13).

### 6.2 W2 — Supplier modifies an OEM STEP part (CLI, local agent)

```bash
llull --app import_step_exact file=in/nist_ctc_01_asme1_ap242-e1.stp heal=true   # file= → stepBase64 (CLI FILE_PARAMS)
# → data: { bodies:[{id, name, valid:true, healed:[...], maxTolerance:0.00335, gvp:{volumeRelDiff:4.6e-8, ...}}] }
llull --app validate_shape '{"ids":["<imported id>"]}'
llull --app add_cylinder '{"radius":5,"height":200,"position":[0,0,-150]}'
llull --app boolean '{"op":"subtract","a":"<imported id>","b":"<cylinder id>"}'
llull --app mass_properties '{"entityId":"<result id>"}'
llull --app export_step_exact '{"entityIds":["<result id>"],"validationProperties":true}' --save out/part.step
```

Each line is one command (same registry as the UI); the user sees each change live in the window and can undo.

### 6.3 W3 — Weights engineer, assembly in aircraft axes (UI or MCP)

1. Loads an assembly of parts placed at body stations (component instances with placements, FR-KRN-11).
2. Runs `mass_properties` on the assembly instance: per-part and total mass, CG in aircraft axes, inertia about
   CG and about the aircraft datum, with method `exact` and accuracy estimate (FR-KRN-08, FR-KRN-03).
3. Exports the table (CSV via the result data).

### 6.4 W4 — MCP agent heals and checks a received file (cloud)

1. Agent calls `import_step_exact` with `stepBase64`.
2. Reads the import report; if `maxTolerance > policy`, calls `heal_shape` with stricter options, then
   `validate_shape`.
3. Calls `inspect_topology` to list named faces; reports GVP deltas to the user.

### 6.5 W5 — CAD admin qualifies a kernel upgrade

1. Bumps the OCCT build; runs `npm run quality:kernel` (TECHNICAL_SPEC §9).
2. The gate replays the golden plans and the KRN corpus with the new build, compares topology counts and
   measures within tolerance, and lists drift per model (FR-KRN-10).
3. Documents saved with the old version open with a provenance notice (FR-KRN-14).

## 7. Acceptance criteria

| # | Given | When | Then | VC |
| - | ----- | ---- | ---- | -- |
| AC-01 | a fresh desktop install | the app starts | `kernel_info` reports `occt` and its OCCT version; a forced OCC start failure shows a visible Manifold-fallback warning | VC-KRN-11 |
| AC-02 | the analytic solids of `analytic_solids.json` | `mass_properties` runs on each | volume, area, inertia within 1e-9 relative and centroid within 1e-6 mm of the closed form | VC-KRN-01 |
| AC-03 | the same solids translated to x = 70 000 mm | `mass_properties` runs | volume and centroidal inertia equal the origin values within 1e-9 / 1e-12 relative; centroid shifted by exactly 70 000 mm (± 1e-6) | VC-KRN-02, VC-KRN-03b |
| AC-04 | the rib plan | it is built | one valid solid, V = 485 716.8147 mm³ (1e-9 rel) | VC-KRN-03 |
| AC-05 | a NIST STEP file whose GVP agree with OCCT | `import_step_exact` runs | exact solid(s), valid after healing, GVP deltas within 1e-4 (vol) / 1e-3 (area) / 0.05 mm (centroid) | VC-KRN-04 |
| AC-06 | a NIST file whose GVP disagree | it is imported | the report lists the GVP mismatch with both values and imports the geometry | VC-KRN-04x |
| AC-07 | the tessellated-only FTC 08 file | it is imported in exact mode | the command reports "no exact B-rep (tessellated)" and suggests mesh import; nothing is silently empty | VC-KRN-05 |
| AC-08 | any imported file | it is imported | the report gives the max sub-shape tolerance and warns above the policy threshold | VC-KRN-06 |
| AC-09 | the parametric rib with 4 corner fillets | pocket width changes 260 → 200 | 4 fillet faces remain on the pocket corners, V = 581 716.8147 mm³; or a named broken-reference error, never a wrong edge | VC-KRN-07 |
| AC-10 | two cubes with a 1e-5 mm gap | `boolean union` with `fuzzy: 2e-5` | one valid solid; without fuzzy, two solids | VC-KRN-08 |
| AC-11 | any golden / quality model | it is built | no committed shape fails `validate_shape` | VC-KRN-09 |
| AC-12 | the KRN reference set | it is rebuilt twice with the same build | identical topology signatures; across builds, equal counts and measures within tolerance | VC-KRN-10 |
| AC-13 | 10 000 instances of the rib | the assembly is displayed | one kernel evaluation and one tessellation per LOD; frame-time budget met | VC-KRN-12 |
| AC-14 | the web app without backend on OCC | a kernel-heavy command runs | the UI thread shows no long task > 50 ms | VC-KRN-13 |
| AC-15 | a modified part | it is exported exact and re-imported | GVP written on export agree with the re-import within 1e-6 | VC-KRN-14 |
| AC-16 | a saved document | it is reopened with a different OCCT build | a provenance warning names both versions; tolerance settings are kept and validated | VC-KRN-15 |
| AC-17 | an exact recipe the active kernel cannot rebuild | it is loaded | the entity is flagged faceted, listed by `check_model`, blocked from exact export | VC-KRN-16 |
| AC-18 | the command registry | the contract tests run | every KRN command is an MCP tool and CLI verb with happy/failure tests | VC-KRN-17 |

### 7.1 Traceability (FR → VC → TR)

| FR | Validation cases | Technical requirements |
| -- | ---------------- | ---------------------- |
| FR-KRN-01 | VC-KRN-11, VC-KRN-03 | TR-KRN-01, TR-KRN-04 |
| FR-KRN-02 | VC-KRN-13 | TR-KRN-03 |
| FR-KRN-03 | VC-KRN-02, VC-KRN-03b | TR-KRN-10, TR-KRN-41, TR-KRN-72, TR-KRN-73 |
| FR-KRN-04 | VC-KRN-04 | TR-KRN-20, TR-KRN-21 |
| FR-KRN-05 | VC-KRN-04, VC-KRN-04x, VC-KRN-05, VC-KRN-06 | TR-KRN-22, TR-KRN-23, TR-KRN-24 |
| FR-KRN-06 | VC-KRN-07 | TR-KRN-30, TR-KRN-31, TR-KRN-32 |
| FR-KRN-07 | VC-KRN-08 | TR-KRN-12, TR-KRN-13 |
| FR-KRN-08 | VC-KRN-01, VC-KRN-02, VC-KRN-03 | TR-KRN-40, TR-KRN-41, TR-KRN-42 |
| FR-KRN-09 | VC-KRN-09 | TR-KRN-50, TR-KRN-51 |
| FR-KRN-10 | VC-KRN-10 | TR-KRN-60, TR-KRN-61, TR-KRN-62 |
| FR-KRN-11 | VC-KRN-12 | TR-KRN-70, TR-KRN-71, TR-KRN-74 |
| FR-KRN-12 | VC-KRN-03 | TR-KRN-02, TR-KRN-50 |
| FR-KRN-13 | VC-KRN-14 | TR-KRN-80 |
| FR-KRN-14 | VC-KRN-15 | TR-KRN-61 |
| FR-KRN-15 | VC-KRN-15 | TR-KRN-11 |
| FR-KRN-16 | VC-KRN-16 | (KI5 fallback rule; `faceted` flag, §3 of TECHNICAL_SPEC) |
| FR-KRN-17 | VC-KRN-17 | all commands of TECHNICAL_SPEC §4 |

Known-failing today (ratcheted like `quality/corpus.json` knownIssues): VC-KRN-07 (heuristic `edgesNear`),
VC-KRN-04x (GVP disagreements in the source files), every VC that needs the OCC kernel while the desktop default
is Manifold (VC-KRN-01..03 can only pass with `LLULL_KERNEL=occt` — not yet run; VC-KRN-02's inertia tolerance needs
TR-KRN-41; inertia is not reported at all today).

## 8. Standards & regulatory alignment

| Standard / practice | Relevance | What KRN does |
| ------------------- | --------- | ------------- |
| ISO 10303 (STEP) AP203 / AP214 / AP242 | exchange of exact B-rep | exact read/write via OCCT translators (AP214 CC2, AP203, parts of AP242 per [R5]); full AP242 PMI is gap XCH |
| CAx-IF Recommended Practices — Geometric and Assembly Validation Properties (v4.6) | exchange quality check | compare GVP on import, write GVP on export [R21] |
| NIST MBE PMI test models (CTC/FTC/STC) | public reference parts | geometry-only validation corpus [R19][R20] |
| ISO 14306 (JT) | lightweight visualization in aerospace DMU | out of KRN scope; LOD/lightweight architecture compatible [R23] |
| AS9100 / EN 9100 configuration and traceability | quality-system context | kernel provenance and determinism feed gap 09 PLM (no claim of compliance) |

Paywalled standards are cited by title only; no clause content is asserted.

## 9. KPIs / success metrics

| KPI | Target | Measured by |
| --- | ------ | ----------- |
| Share of desktop sessions on OCC | 100 % (fallback events logged) | `kernel_info` telemetry-free local log / desktop test |
| Analytic mass-property error | ≤ 1e-9 relative (≤ 1e-12 inertia at 70 m) | VC-KRN-01/02 |
| NIST geometry import (exact, valid) | 27/27 B-rep files valid after heal; 1/1 tessellated file reported | VC-KRN-04..06 |
| Quality corpus in exact mode | every `step-import` entry passes its non-knownIssue checks | `npm run quality:step` exact mode |
| Parametric reference survival | 0 silently re-targeted references in the golden set | VC-KRN-07 + golden |
| Validity of committed results | 100 % | VC-KRN-09 |
| Cross-version drift | 0 topology-count changes on the KRN set without a reviewed baseline update | VC-KRN-10 |
| Large assembly | 10 000 instances interactive (budget TBD-measured) | VC-KRN-12 |

## 10. Risks & assumptions

| # | Risk / assumption | Impact | Mitigation |
| - | ----------------- | ------ | ---------- |
| K1 | A current OCCT WASM build (7.9.x with C++ exceptions) is larger/slower than opencascade.js 1.1.1 | startup time, memory | desktop runs OCC in the server worker (native-speed WASM in Node) or, later, native OCCT via the bundled CPython's OCP; measure (TR-KRN-02) |
| K2 | Two OCCT versions in one product (WASM kernel vs CadQuery OCP 7.9.3) produce different edge orders | code export/import mismatch | align versions (TR-KRN-61); selection by name/geometry, never by index (KI5 already does mid-point matching) |
| K3 | Persistent naming is an open research problem; FreeCAD's mitigation is partial [R16] | some edits still break references | explicit broken-reference errors + repair UI; never silent retargeting (FR-KRN-06) |
| K4 | Document size grows with embedded B-rep blobs for imported parts | large files | content-addressed blobs, compression, external blob store (TECHNICAL_SPEC §6) |
| K5 | OCC licence LGPL-2.1 with exception [R10] | distribution obligations for a modified build | keep OCCT unmodified or publish patches; dynamic loading of the WASM / shared library |
| K6 | GVP in public files can be wrong (5/11 NIST files disagree) | false alarms | report, never auto-correct; knownIssue ratchet like the quality corpus |
| K7 | Assumption: desktop UI commands execute on the backend (POST /command), so the browser kernel is a fallback only | if offline local execution is used on desktop, OCC must also be available in the renderer | FR-KRN-02 worker; desktop always has its backend (KI6) |
| K8 | Display precision (float32, depth range near 0.01 / far 1e8 in `Viewport3D.tsx`) | z-fighting and jitter at 70 m | camera-relative rendering and logarithmic / reversed depth (TR-KRN-73) |

## 11. References

- [R1] OCCT `Precision.hxx` (V7_8_0) — Open Cascade SAS — https://raw.githubusercontent.com/Open-Cascade-SAS/OCCT/V7_8_0/src/Precision/Precision.hxx (accessed 2026-10)
- [R2] OCCT Boolean Operations specification — Open Cascade SAS — https://raw.githubusercontent.com/Open-Cascade-SAS/OCCT/V7_8_0/dox/specification/boolean_operations/boolean_operations.md (accessed 2026-10)
- [R3] OCCT Modeling Algorithms user guide — Open Cascade SAS — https://raw.githubusercontent.com/Open-Cascade-SAS/OCCT/V7_8_0/dox/user_guides/modeling_algos/modeling_algos.md (accessed 2026-10)
- [R4] OCCT Shape Healing user guide — Open Cascade SAS — https://raw.githubusercontent.com/Open-Cascade-SAS/OCCT/V7_8_0/dox/user_guides/shape_healing/shape_healing.md (accessed 2026-10)
- [R5] OCCT STEP translator user guide — Open Cascade SAS — https://raw.githubusercontent.com/Open-Cascade-SAS/OCCT/V7_8_0/dox/user_guides/step/step.md (accessed 2026-10)
- [R6] OCCT XDE user guide — Open Cascade SAS — https://raw.githubusercontent.com/Open-Cascade-SAS/OCCT/V7_8_0/dox/user_guides/xde/xde.md (accessed 2026-10)
- [R8] OCCT `BRepGProp.hxx` — Open Cascade SAS — https://raw.githubusercontent.com/Open-Cascade-SAS/OCCT/V7_8_0/src/BRepGProp/BRepGProp.hxx (accessed 2026-10)
- [R9] OCCT `BRepCheck_Analyzer.hxx` — Open Cascade SAS — https://raw.githubusercontent.com/Open-Cascade-SAS/OCCT/V7_8_0/src/BRepCheck/BRepCheck_Analyzer.hxx (accessed 2026-10)
- [R10] OCCT README (licence) — Open Cascade SAS — https://raw.githubusercontent.com/Open-Cascade-SAS/OCCT/master/README.md (accessed 2026-10)
- [R11] opencascade.js README v1.1.1 (OCCT V7_4_0p1) — donalffons — https://raw.githubusercontent.com/donalffons/opencascade.js/v1.1.1/README.md (accessed 2026-10)
- [R12] npm registry metadata, opencascade.js — npm — https://registry.npmjs.org/opencascade.js (accessed 2026-10)
- [R13] PyPI metadata, cadquery 2.8.0 / cadquery-ocp — PyPI — https://pypi.org/pypi/cadquery/json (accessed 2026-10)
- [R14] Open CASCADE Technology 7.9.0 released — Open Cascade SAS — https://dev.opencascade.org/content/open-cascade-technology-790-released (search summary only, accessed 2026-10)
- [R15] FreeCAD 1.0.0 source: ElementMap.h, ElementNamingUtils.h, TopoShapeOpCode.h — FreeCAD project — https://raw.githubusercontent.com/FreeCAD/FreeCAD/1.0.0/src/App/ElementMap.h (accessed 2026-10)
- [R16] FreeCAD 1.0 release / "Toponaming problem is history" — FreeCAD wiki, Ondsel — https://wiki.freecad.org/Release_notes_1.0 ; https://ondsel.com/blog/toponaming-problem-is-history/ (search summary only, accessed 2026-10)
- [R17] J. Kripac, A mechanism for persistently naming topological entities in history-based parametric solid models, Computer-Aided Design 29(2):113-122, 1997 — cited via https://patents.justia.com/patent/6445388 (search summary only, accessed 2026-10)
- [R18] Onshape forum, deterministic ids — Onshape — https://forum.onshape.com/discussion/26062/please-help-me-deterministicids-do-not-in-all-ids-returned-by-qeverything (search summary only, accessed 2026-10)
- [R19] NIST MBE PMI Validation and Conformance Testing project — NIST — https://www.nist.gov/el/systems-integration-division-73400/mbe-pmi-validation-and-conformance-testing-project (search summary only, accessed 2026-10)
- [R20] NIST-PMI-STEP-Files.zip (usnistgov/SFA, commit 72375d17) — NIST — https://raw.githubusercontent.com/usnistgov/SFA/72375d17c09cf7072c30d9393b5c08b7aa272285/Release/NIST-PMI-STEP-Files.zip (accessed 2026-10)
- [R21] CAx-IF Recommended Practices for Geometric and Assembly Validation Properties v4.6 — CAx-IF / MBx-IF — https://www.mbx-if.org/documents/rec_prac_gvp_v46.pdf (search summary only, accessed 2026-10)
- [R22] Koch et al., ABC: A Big CAD Model Dataset for Geometric Deep Learning, CVPR 2019 — CVF — https://openaccess.thecvf.com/content_CVPR_2019/html/Koch_ABC_A_Big_CAD_Model_Dataset_for_Geometric_Deep_Learning_CVPR_2019_paper.html (search summary only, accessed 2026-10)
- [R23] ISO 14306 (JT) catalogue — ISO — https://www.iso.org/standard/89233.html (search summary only, accessed 2026-10)
- [R24] Airbus A380 Aircraft Characteristics (download page) and ICAO APANPIRG/15 WP12 — Airbus, ICAO — https://aircraft.airbus.com/en/customer-care/fleet-wide-care/airport-operations-and-aircraft-characteristics/aircraft-characteristics ; https://www.icao.int/sites/default/files/Meetings/AMC/MA/2004/APANPIRG15/wp12.pdf (search summary only, accessed 2026-10)
- [R25] Boeing 747 — NASA Glenn Research Center — https://www.grc.nasa.gov/WWW/K-12/aerosim/LessonHS97/Boeing747.html (search summary only, accessed 2026-10)
- [R26] three.js documentation r170: InstancedMesh, BatchedMesh, LOD — three.js — https://raw.githubusercontent.com/mrdoob/three.js/r170/docs/api/en/objects/InstancedMesh.html (accessed 2026-10)
- [R29] IEEE-754 spacing computed with Python `math.ulp` — measured (validation/sources.md)
- llull: `docs/decisions/KI4-occt-spike.md`, `KI5-shape-kernel-boundary.md`, `KI6-desktop-app-cli-first.md`, `quality/corpus.json`, `docs/QUALITY_GATES.md`
