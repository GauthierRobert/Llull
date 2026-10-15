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

Operator model: [`../AGENT_FIRST.md`](../AGENT_FIRST.md) (authoritative).

| Persona | Who | Surface | In this gap |
| ------- | --- | ------- | ----------- |
| **P1 Operator (primary)** | AI agent (Claude Code or similar) | `llull` CLI (`--doc FILE` headless or `--app` on the open desktop window); MCP `/mcp` for cloud agents | builds and imports exact parts, heals, validates, measures, exports; ends every job with `validate_shape` + `check_model` |
| **P2 Owner** | the person who asked the agent (supplier owner, small design office, MRO planner) — **not assumed to be an engineer** | natural language to the agent; may watch the desktop app | states the goal ("add a Ø10 hole to this OEM part and send it back"), receives a plain-language result, sees what needs a human |
| **P3 Qualified reviewer** (only where results feed certification, weight & balance or release) | mass-properties / stress engineer, design-organisation signatory, CAD admin owning the kernel baseline | desktop app review surfaces, the agent's JSON report | approves mass / inertia used for weight & balance, accepts faceted or GVP-mismatched deliveries, accepts kernel-baseline changes |

User stories (each maps to FRs):

- US-01 (P1) As the operator I want the desktop backend to run the exact kernel by default and `kernel_info` to tell
  me which kernel is active, so I never deliver faceted fillets without knowing. → FR-KRN-01, FR-KRN-16
- US-02 (P1) As the operator I want `import_step_exact` to turn an OEM STEP file into healed exact solids I can cut,
  fillet and measure with ordinary commands. → FR-KRN-04, FR-KRN-05, FR-KRN-12
- US-03 (P1) As the operator I want the import report in `data` (healing actions, max tolerance in mm, GVP deltas,
  stable codes, `reviewRequired`) so I can decide without engineering judgement whether to continue or stop and ask.
  → FR-KRN-05, FR-KRN-19, FR-KRN-24
- US-04 (P1) As the operator I want a fillet placed on a pocket corner to stay on that corner after I change the
  pocket width parameter, or to fail with `KRN_BROKEN_REFERENCE`, never to move silently. → FR-KRN-06
- US-05 (P1 for P3) As the operator I want volume, mass, centroid and inertia with units, method, inputs and an
  accuracy statement in `data`, so a qualified mass-properties engineer can audit them. → FR-KRN-08, FR-KRN-22, FR-KRN-24
- US-06 (P1) As the operator I want parts placed 70 m from the datum to keep their precision, and a warning code
  when a model leaves the guaranteed envelope. → FR-KRN-03
- US-07 (P1) As the operator I want booleans on near-coincident imported faces to succeed with an explicit `fuzzy`
  tolerance in mm that is recorded in the history. → FR-KRN-07
- US-08 (P1) As the operator I want every result validity-checked, the kernel version stamped in the document, and
  `validate_shape` / `check_model` to give me pass / warn / fail with codes. → FR-KRN-09, FR-KRN-14, FR-KRN-20
- US-09 (P1) As the operator I want 10 000 identical fasteners to cost one exact definition, and instancing counts
  in `data` so I can check it without looking at the screen. → FR-KRN-11
- US-10 (P1) As the operator I want every capability as a registry command with units in every numeric param and
  every `data` field. → FR-KRN-17, FR-KRN-21
- US-11 (P2) As the owner I want a one-sentence summary that says what was done, what passed, and what needs a
  qualified engineer, in that order. → FR-KRN-24
- US-12 (P1) As the operator I want mass results built from an unverified density to say so (`unverified`), so I do
  not present them to the owner as certified numbers. → FR-KRN-23
- US-13 (P3) As a qualified reviewer I want to be the only one who can accept a faceted body into an exact export or
  a kernel-baseline change; the agent prepares, I decide. → FR-KRN-25
- US-14 (P1) As the operator I want large imports to show progress, honour `--timeout`, and be tried with
  `--dry-run` first. → FR-KRN-26
- US-15 (P1) As the operator I want to export the modified part as exact STEP with validation properties
  (`export_step_ap242`, 04 XCH). → FR-KRN-13

## 4. Scope / out of scope

### 4.1 Phases

| Phase | Content |
| ----- | ------- |
| **MVP** | OCC default on desktop (server worker) with visible fallback; current OCCT build (7.9.x line) in the server/worker; tolerance policy + document `modelingTolerance`; `import_step_exact` (exact solids, ShapeFix, sewing of shells, import report, tessellated-only detection); `validate_shape`; result validity gating; exact `mass_properties` with centroid + inertia + part-frame evaluation; kernel provenance in documents; determinism golden set; boolean `fuzzy` option |
| **V1** | Persistent topological naming (history-based element names) for fillet / chamfer / shell / hole selections and for imported faces; GVP attributes returned by the importer (comparison bands and GVP writing on export are 04 XCH);
face-query kernel port for 02/03/05/06/07 (FR-KRN-18); assembly mass properties with instances; browser OCC in a Web Worker (web-only use); instancing of arbitrary exact parts in the viewport; cross-version regression gate |
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
| FR-KRN-01 | MUST (MVP) | The desktop app SHALL use the exact OCC kernel by default for every document operation; Manifold is used only as an explicit fallback when OCC cannot start; `kernel_info` (CLI / MCP) SHALL report the active kernel and the fallback reason with code `KRN_KERNEL_FALLBACK` (a UI badge is a review aid only). | Product direction (OCC on desktop); KI5 exactness is lost under Manifold | KI6; `desktop/src/backendEnv.ts`; `server/src/geometryKernel.ts` |
| FR-KRN-02 | SHOULD (V1) | When the web app executes commands locally with OCC, kernel work SHALL NOT block the UI thread (worker), with the same cancellation/timeout behaviour as the server worker. | 63 MB WASM, 0.8-1 s init, 150-180 ms per op measured in KI4 | KI4; `src/main.tsx` |
| FR-KRN-03 | MUST (MVP) | llull SHALL document and enforce a modelling-precision policy: internal length unit mm; OCC confusion tolerance 1e-7 mm; a guaranteed coordinate envelope that covers a > 70 m airframe positioned in aircraft coordinates; models outside the envelope import/build with a warning. Geometry, mass properties and display SHALL show no precision artefact inside the envelope. | OCC tolerances are tuned for mm [R1]; A380 72.6 m [R24]; float32 display resolution 0.0078 mm at 70 m [R29] | R1, R24, R29 |
| FR-KRN-04 | MUST (MVP) | STEP AP203 / AP214 / AP242 geometry SHALL import as exact B-rep solids (one llull solid per STEP solid, assembly placements, names and colours kept), editable by every exact command (boolean, fillet, chamfer, shell, measure, export). | Supplier workflow; today import gives meshes | R5, R6; `packages/mcp/src/exchangeTools.ts` |
| FR-KRN-05 | MUST (MVP) | Import SHALL heal (ShapeFix, sewing of open shells into solids when closed) and return a report: per body validity before/after, healing actions, max sub-shape tolerance, open shells / free faces, tessellated-only content, and GVP deltas when the file carries GVP. No silent empty or silently faceted result. | Real STEP files carry tolerance gaps (0.1 mm measured on a NIST file) and stale GVP (5/11 disagree) | R4, R5, R21; validation §5 |
| FR-KRN-06 | MUST (V1) | References from features to faces/edges (fillet, chamfer, shell openings, holes, sketch-on-face, PMI anchors) SHALL be persistent: after an upstream parametric edit the same logical entity is re-selected, or the feature reports a broken reference by name — it never silently selects a different entity. | `edgesNear` picks the nearest edge, which can be a different edge after a move | KI5; R3, R15, R16, R17 |
| FR-KRN-07 | SHOULD (MVP) | Booleans SHALL accept an optional fuzzy tolerance (default = OCC confusion), recorded in the feature history; on failure the command SHALL report the argument analysis (self-interference, small edges). | Near-coincident imported faces; OCC fuzzy option | R2 |
| FR-KRN-08 | MUST (MVP) | `mass_properties` SHALL return, from the exact B-rep: volume, surface area, mass, centroid, inertia tensor about the centroid (document axes) and about the origin, principal moments and axes, radii of gyration, with the method and an accuracy estimate. Relative accuracy on analytic solids ≤ 1e-9 (volume, area, inertia) also when the part is 70 m from the origin. | Weight & balance; current command returns volume/mass only | R8; validation VC-KRN-01/02 |
| FR-KRN-09 | MUST (MVP) | Every kernel result committed to the document SHALL pass a B-rep validity check; an explicit `validate_shape` query SHALL report validity, self-intersection, small edges/faces and tolerance excess per entity. | Invalid OCC results make later booleans hang (comment in `occtKernel.ts`) | R9, R2 |
| FR-KRN-10 | MUST (MVP) | Regeneration SHALL be deterministic for a given kernel build (same plan → same topology signature); a regression gate SHALL re-run a reference corpus on every kernel change and report topology/measure drift with tolerance-based comparison across versions. | Upgrade safety; OCCT moves quarterly [R14] | R11, R12, R14 |
| FR-KRN-11 | SHOULD (V1/V2) | Large assemblies: repeated parts SHALL share one exact definition and one display mesh (instancing); numeric equivalent for the operator: `describe_scene` returns `data.instancing` (definitions, instances, kernel evaluations, tessellations). Viewport levels of detail and lightweight proxies for 10⁴-10⁵ instances are a review-surface concern: COULD (V2), budgets in TECHNICAL_SPEC §8. | 747 ≈ 6 M parts [R25]; three.js InstancedMesh/BatchedMesh/LOD [R26] | R25, R26 |
| FR-KRN-12 | MUST (MVP) | The machined-part feature chain (blank, pocket by boolean, corner/floor fillets, through holes, chamfers) SHALL produce exact, valid solids whose mass matches analytic values. | Use case U1 | validation VC-KRN-03 |
| FR-KRN-13 | SHOULD (V1) | Exact STEP export SHALL carry product structure, names, colours and geometric validation properties (volume, area, centroid). Delivered by 04 XCH `export_step_ap242` (FR-XCH-01/03/04) using KRN's `massProperties`; KRN keeps only the round-trip check VC-KRN-14. | CAx-IF GVP practice | R21; 04 XCH |
| FR-KRN-14 | MUST (MVP) | Each document SHALL record the kernel and version that produced it (and per-step kernel when mixed), returned by `kernel_info` and checked on load (warning code `KRN_KERNEL_MISMATCH`); UI display optional. | Traceability (feeds gap 09 PLM) | R11, R13 |
| FR-KRN-15 | SHOULD (MVP) | The operator SHALL be able to read (`kernel_info`) and set (`set_modeling_tolerance`, values in mm / rad) the document modelling tolerance (linear, angular) within policy limits; import SHALL map STEP uncertainty to it. | STEP `read.precision.mode` / uncertainty | R5 |
| FR-KRN-16 | MUST (MVP) | No silent faceting: when an exact operation falls back to triangles (capability gap) the result SHALL be flagged `faceted`, listed by `check_model` (`KRN_FACETED_RESULT`), and blocked from exact export unless a qualified reviewer accepts it (human gate, FR-KRN-25). | KI5 fallback exists today | KI5 |
| FR-KRN-17 | MUST (MVP) | Every capability above SHALL be a registered command reachable from UI, `llull` CLI and MCP, returning structured `data`. | Architecture L1/L5 | `.claude/rules/architecture.md` |
| FR-KRN-18 | SHOULD (V1) | The exact kernel SHALL expose one optional face-query port (located faces, containment, face graph, surface parameters, projection / evaluation, curvature and distance analysis) that every other gap uses instead of its own kernel extension; Manifold reports it unavailable. | 02 / 03 / 05 / 06 / 07 each need face-level queries; one port avoids five divergent kernel APIs | TECHNICAL_SPEC §5.9 |
| FR-KRN-19 | MUST (MVP) | Every refusal and every check finding of a KRN command SHALL carry a stable code (`KRN_*`, TECHNICAL_SPEC §7.1), the offending entity ids / sub-shape names / param paths and a one-line remediation naming the next command; exit code 1 on refusal. | AF-11: the operator cannot interpret prose reliably | AGENT_FIRST AF-11 |
| FR-KRN-20 | MUST (MVP) | `validate_shape` (per-shape B-rep check) and `check_model` (document check: faceted results, kernel mismatch, invalid B-rep, unverified mass inputs, broken references) SHALL be the read-only check commands of this gap, returning pass / warn / fail lists with codes; every KRN workflow ends with them. | AF-20 | AGENT_FIRST AF-20 |
| FR-KRN-21 | MUST (MVP) | Every numeric param of a KRN command SHALL state its unit in the schema description (lengths in the document length unit unless named `…Mm`; tolerances in mm; angles in rad), and every number in `data` SHALL carry its unit (suffix or `unit` field). | AF-04, AF-10 | AGENT_FIRST AF-04/AF-10 |
| FR-KRN-22 | MUST (MVP) | Defaults that change results (modelling tolerance, fuzzy value, `eps` of mass integration, density source, healing precision) SHALL be named in `data` with their source (`{ value, unit, source, defaulted }`); every computed value carries `provenance` (method, OCCT class, kernel version, inputs). | AF-31, AF-35 | AGENT_FIRST AF-31/AF-35; R1, R5, R8 |
| FR-KRN-23 | MUST (MVP) | A result computed from unverified inputs (density from a material without a verified record per 08 MAT, a faceted / mesh-method body, an imported body whose GVP check is red or not checkable) SHALL carry `unverified: true` with reasons, propagated into every derived value (mass, centroid, inertia, assembly totals); `check_model` reports it as a warning that cannot be suppressed (`KRN_MASS_INPUT_UNVERIFIED`). | AF-32 | AGENT_FIRST AF-32; 08 MAT |
| FR-KRN-24 | MUST (MVP) | Mass / centroid / inertia results and import reports SHALL carry `reviewRequired: { value, reasons }`; `value` is true when the result is unverified, approximate (mesh method, outside the precision envelope), from an import with GVP mismatch or tolerance growth above `maxImportTolerance`, or explicitly requested for weight & balance (`purpose: 'weight-and-balance'`); the summary then says "computed by llull, not approved — needs a qualified engineer". | AF-33, AF-36 | AGENT_FIRST AF-33/AF-36 |
| FR-KRN-25 | MUST (V1) | Accepting a faceted (non-exact) body into an exact STEP delivery, and accepting a new kernel-regression baseline after an OCCT upgrade, SHALL be human gates: an agent caller (`ctx.caller.kind === 'agent'`, 09 TR-PLM-16) gets `XCH_HUMAN_GATE` (export, 04) / `KRN_HUMAN_GATE` (baseline) and a prepared request the reviewer completes in the desktop app. | AF-34 | AGENT_FIRST AF-34; 09 PLM |
| FR-KRN-26 | SHOULD (MVP) | `import_step_exact` and the kernel regression run SHALL report progress (`--progress`), respect `--timeout`, re-use content-hash caches (blob sha256, `recipeKey`) when re-run, and `import_step_exact` / `heal_shape` / `set_modeling_tolerance` SHALL work under `--dry-run`. | AF-40, AF-42 | AGENT_FIRST AF-40/AF-42 |

## 6. Workflows

The CLI is the product surface (AGENT_FIRST §1). Every workflow is one plan file, validated, run, checked, rendered
and exported with real `llull` syntax; MCP calls the same commands; the desktop UI is where the owner watches and the
qualified reviewer approves.

### 6.1 W1 — Machined rib from a billet (CLI, operator)

```bash
llull status                                                    # --app if the desktop app is open, else --doc
llull kernel_info --json --app                                  # data.active == "occt" (else stop: KRN_KERNEL_FALLBACK)
llull run validation/plans/krn-rib-pocket.json --validate --app # structure, aliases, required params; no kernel work
llull run validation/plans/krn-rib-pocket.json --progress --app # blank − pocket, 4 corner fillets (edgesNear), material
llull validate_shape '{"entityIds":["<rib id>"]}' --json --app  # data.results[0].valid == true, issues == []
llull check_model --json --app                                  # no KRN_* fail; warnings listed with codes
llull mass_properties entityId=<rib id> --json --app            # data.volume ≈ 485716.8147, data.volumeUnit "mm³" (VC-KRN-03), provenance
llull render_view view=iso --save out/rib.png --app             # look at the result (multimodal check, AF-22)
llull export_step_ap242 '{"entityIds":["<rib id>"],"includeValidationProperties":true}' --save out/rib.stp --app  # 04 XCH
```

Parametric follow-up: `llull set_parameter name=pw expression=200 --app` (renaming plan
`krn-rib-parametric-renaming.json`); the fillets stay on the pocket corners (V = 581 716.8147 mm³) or the step
fails with `KRN_BROKEN_REFERENCE` naming the lost edge — never a silent re-target (FR-KRN-06).

### 6.2 W2 — Supplier modifies an OEM STEP part (CLI, operator; owner not an engineer)

```bash
llull import_step_exact file=in/nist_ctc_01_asme1_ap242-e1.stp heal=true --dry-run --json --doc part.llull  # try first (AF-42)
llull import_step_exact file=in/nist_ctc_01_asme1_ap242-e1.stp heal=true --progress --json --doc part.llull
# → data.report.bodies[0]: { id, valid: true, healed: [...], maxToleranceMm: 0.00335, gvp: { volumeRelDiff: 4.6e-8, band: "green" },
#                            reviewRequired: { value: false, reasons: [] } }
llull validate_shape '{"entityIds":["<imported id>"]}' --json --doc part.llull
llull add_cylinder '{"radius":5,"height":200,"position":[0,0,-150]}' --doc part.llull
llull boolean '{"op":"subtract","a":"<imported id>","b":"<cylinder id>"}' --doc part.llull
llull check_model --json --doc part.llull
llull mass_properties entityId=<result id> --json --doc part.llull
llull render_view view=iso --save out/part.png --doc part.llull
llull export_step_ap242 '{"entityIds":["<result id>"],"includeValidationProperties":true}' --save out/part.stp --doc part.llull  # 04 XCH
```

In practice the steps after the import go into one plan file (`llull run plan.json --validate`, then `llull run plan.json`).
If the report says `reviewRequired.value: true` (GVP red, tolerance growth, faceted body), the operator stops, tells the
owner in one sentence what was found, and hands the decision to a qualified reviewer.

### 6.3 W3 — Mass properties for weight & balance (CLI; result for a qualified reviewer)

1. `llull run assembly-plan.json --validate` then `llull run assembly-plan.json` (components placed at body stations).
2. `llull mass_properties '{"entityId":"<assembly instance>","purpose":"weight-and-balance"}' --json` → per-part and
   total mass in g, CG in mm (document axes), inertia about CG and origin in g·mm², `method`, `relErrorEstimate`,
   `provenance`, `unverified` (with reasons) and `reviewRequired: { value: true, reasons: ["weight-and-balance"] }`.
3. `llull check_model --json` → `KRN_MASS_INPUT_UNVERIFIED` warnings for every part whose density is not from a
   verified material record (08 MAT).
4. The operator hands the JSON (`jq` to CSV) to the mass-properties engineer; llull never marks it approved.

### 6.4 W4 — MCP agent heals and checks a received file (cloud)

1. `import_step_exact { stepBase64 }` → read `data.report`; on `KRN_IMPORT_TOLERANCE_HIGH` call `heal_shape` with a
   stricter `precisionMm`, then `validate_shape`.
2. `inspect_topology { id, withNames: true }` lists named faces; the agent reports GVP deltas and codes.

### 6.5 W5 — Kernel upgrade qualification (CLI + human gate)

1. `npm run quality:kernel --progress` replays the golden plans and the KRN corpus with the new OCCT build and writes a
   drift report (JSON: per model, counts and measures vs baseline, codes `KRN_DRIFT_TOPOLOGY` / `KRN_DRIFT_MEASURE`).
2. Accepting the new baseline is a **human gate** (FR-KRN-25): the agent prepares the baseline diff; the CAD admin /
   qualified reviewer accepts it. Documents saved with the old version reopen with `KRN_KERNEL_MISMATCH` (FR-KRN-14).

### 6.6 UI — review and approval surface only

The desktop app shows what the operator did (live with `--app`): kernel badge, import report table, validation
results, mass-property table, broken-reference badges. Reviewer-only actions: accept a faceted body into an exact
delivery, accept a kernel baseline (FR-KRN-25), re-pick a broken reference interactively (the CLI equivalent is
`edit_step_params` with new `edgeNames`). No KRN capability exists only in the UI.

## 7. Acceptance criteria

Phrased as CLI invocations with JSON assertions (AF-23). `ER(VC)` = the case in `validation/expected_results.json`;
`≈` = within that case's tolerance. `--doc t.llull` stands for a fresh scratch document; `$KRN` = `--kernel occt`
for local runs.

| # | Given | When (CLI) | Then (JSON assertion) | VC |
| - | ----- | ---------- | --------------------- | -- |
| AC-01 | fresh desktop install | `llull kernel_info --json --app` | `.data.active == "occt"`, `.data.occtVersion` matches `7.9.*`; with OCC forced to fail: `.data.active == "manifold"` and `.data.fallbackReason` set, code `KRN_KERNEL_FALLBACK` | VC-KRN-11 |
| AC-02 | `plans/krn-analytic-primitives.json` | `llull run … --json $KRN --doc t.llull` then `llull mass_properties entityId=<id> --json` per solid | `.data.volume`, `.data.area`, `.data.inertia.atCentroid` ≈ `ER(VC-KRN-01).value`; `.data.centroid` ≈ `centroidInPlan` | VC-KRN-01 |
| AC-03 | the solids at x = 70 000 mm | as AC-02 on `box-station-70m`, `plate-hole-station-70m` | volume ≈ (1e-9), centroidal inertia ≈ (1e-12), centroid shifted by 70 000 mm (± 1e-6) — `ER(VC-KRN-02)`, `ER(VC-KRN-03b)` | VC-KRN-02, VC-KRN-03b |
| AC-04 | the rib plan | `llull run plans/krn-rib-pocket.json --json $KRN --doc t.llull`; `mass_properties` | exit 0; `.data.volume ≈ 485716.8147` (1e-9 rel), `.data.mass ≈ 1311.4354` g; `validate_shape` `.data.results[0].valid == true` | VC-KRN-03 |
| AC-05 | NIST file whose GVP agree with OCCT | `llull import_step_exact file=<f> --json $KRN --doc t.llull` | `.data.report.bodies[*].validAfterHeal == true`; GVP deltas ≤ `ER(VC-KRN-04).tolerance`; band `green` (04 policy) | VC-KRN-04 |
| AC-06 | NIST file whose GVP disagree | same | exit 0 (geometry imported); `.data.report.bodies[0].gvp` lists sender and recomputed values; code `KRN_GVP_MISMATCH`; `.reviewRequired.value == true` | VC-KRN-04x, VC-KRN-21 |
| AC-07 | tessellated-only FTC 08 file | same | exit 1, `.data` code `KRN_STEP_TESSELLATED_ONLY`, remediation names `import_step` (mesh); document unchanged | VC-KRN-05 |
| AC-08 | any imported file | same | `.data.report.bodies[*].maxToleranceMm` present; code `KRN_IMPORT_TOLERANCE_HIGH` when > `maxImportToleranceMm` (default 0.01, `defaulted: true`) | VC-KRN-06 |
| AC-09 | renaming plan | `llull run plans/krn-rib-parametric-renaming.json --json $KRN --doc t.llull` | after pw 260 → 200: 4 fillet faces on the pocket corners, `.data.volume ≈ 581716.8147`; or exit 1 with `KRN_BROKEN_REFERENCE` naming the edge — never a different edge | VC-KRN-07 |
| AC-10 | two cubes, 1e-5 mm gap | `llull boolean '{"op":"union","a":…,"b":…,"fuzzy":2e-5}' --json` | one valid solid; without `fuzzy`: two solids | VC-KRN-08 |
| AC-11 | any golden / quality model | build, then `llull validate_shape --json` | no committed shape with `.valid == false` | VC-KRN-09 |
| AC-12 | KRN reference set | `npm run quality:kernel` twice | identical signatures (same build); across builds equal counts, measures within tolerance; drift codes otherwise | VC-KRN-10 |
| AC-13 | 10 000 rib instances | `llull run …` then `llull describe_scene --json` | `.data.instancing` reports 1 definition, 10 000 instances, 1 kernel evaluation; display frame time is a review-surface budget (TBD) | VC-KRN-12 |
| AC-14 | web app without backend on OCC | Playwright long-task probe | no main-thread long task > 50 ms | VC-KRN-13 |
| AC-15 | a modified part | `llull export_step_ap242 … --save p.stp`, then `llull import_step_exact file=p.stp --json` | GVP deltas ≤ 1e-6 | VC-KRN-14 |
| AC-16 | a saved document | reopen with another OCCT build: `llull kernel_info --json --doc old.llull` | code `KRN_KERNEL_MISMATCH` naming both versions; `set_modeling_tolerance '{"linear":1}'` → exit 1, `KRN_TOLERANCE_OUT_OF_RANGE` | VC-KRN-15 |
| AC-17 | an exact recipe the kernel cannot rebuild | `llull check_model --json` | issue `KRN_FACETED_RESULT` with the entity id; exact export refused with the same code | VC-KRN-16 |
| AC-18 | the registry | contract tests; `llull describe <cmd>` for every KRN command | every KRN command listed by `llull search`, every numeric param states its unit | VC-KRN-17 |
| AC-19 | analytic face fixtures under OCC | server unit test of `faceQuery` | values ≈ `ER(VC-KRN-18)`; Manifold: port absent | VC-KRN-18 |
| AC-20 | deliberately wrong calls (missing entity, 2D operand, unreadable STEP, tolerance out of range) | each via `llull … --json` | exit 1; `.data.code` and remediation = `ER(VC-KRN-19)` | VC-KRN-19 |
| AC-21 | rib with a material created by legacy `create_material` (no verified record) | `llull mass_properties entityId=<rib> --json`; `llull check_model --json` | `.data.unverified.value == true` with reason `density_unverified`; `check_model` warning `KRN_MASS_INPUT_UNVERIFIED` | VC-KRN-20 |
| AC-22 | the rib, `purpose: "weight-and-balance"` | `llull mass_properties '{"entityId":"<rib>","purpose":"weight-and-balance"}' --json` | `.data.reviewRequired == {value: true, reasons: ["weight-and-balance", …]}`; summary contains "needs a qualified engineer" | VC-KRN-21 |
| AC-23 | an agent caller | `llull export_step_ap242 '{"acceptUnverified":true}' --json` on a faceted body | exit 1, `XCH_HUMAN_GATE` (04 export gate); nothing written | VC-KRN-22 |
| AC-24 | the rib | `llull mass_properties … --json`; `llull kernel_info --json` | `.data.provenance.method == "BRepGProp"`, `.data.eps == {value: 1e-9, source: …, defaulted: true}`, `.data.densitySource` named; `.data.modelingTolerance.linear.defaulted == true` | VC-KRN-23 |
| AC-25 | a large STEP import | `llull import_step_exact file=<f> --dry-run --json`; then with `LLULL_OCC_TIMEOUT_MS=1` | dry run: `.changed == false`, document file untouched; timeout: exit 1, nothing saved | VC-KRN-24 |

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
| FR-KRN-18 | VC-KRN-18 | TR-KRN-90, TR-KRN-91, TR-KRN-92 |
| FR-KRN-19 | VC-KRN-19 | TR-KRN-100 |
| FR-KRN-20 | VC-KRN-09, VC-KRN-19 | TR-KRN-51, TR-KRN-100 |
| FR-KRN-21 | VC-KRN-17, VC-KRN-23 | TR-KRN-101 |
| FR-KRN-22 | VC-KRN-23 | TR-KRN-102 |
| FR-KRN-23 | VC-KRN-20 | TR-KRN-103 |
| FR-KRN-24 | VC-KRN-21 | TR-KRN-104 |
| FR-KRN-25 | VC-KRN-22 | TR-KRN-105 |
| FR-KRN-26 | VC-KRN-24 | TR-KRN-106 |

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
| Agent operability | 100 % of KRN VCs run unattended as CLI scripts (`--json`, exit codes, no UI); every refusal carries a `KRN_*` code | VC-KRN-17, VC-KRN-19, production-gate agent driver |

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
| K9 | The operator (agent) and the owner have no engineering judgement (AGENT_FIRST §1) | a faceted, unverified or GVP-mismatched result could be delivered as if exact and approved | codes + `unverified` + `reviewRequired` in `data` (FR-KRN-19..24), human gates for acceptance (FR-KRN-25), check commands at the end of every workflow (FR-KRN-20) |
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
