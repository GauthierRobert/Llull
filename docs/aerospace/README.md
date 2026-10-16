# Aerospace / aeronautics gap analysis — specifications

Status: **specifications only** (no implementation). Written 2026-10-15.
Product direction (user decision): **Electron desktop + offline first**, OpenCascade (OCC) as the desktop
kernel, bundled CPython + CadQuery (see [`../decisions/KI6-desktop-app-cli-first.md`](../decisions/KI6-desktop-app-cli-first.md)).

## Why this exists

llull today is production-grade for AEC (civil, building, industrial steel — see
[`../PRODUCTION_GATE.md`](../PRODUCTION_GATE.md)) and an entry-level parametric solid modeler for mechanical
parts. Aerospace design offices and their supply chain need capabilities that llull does not have. Each gap
below has a **functional spec** (what / why / for whom), a **technical spec** (how it fits llull's
architecture laws, data model, commands, algorithms, tests) and a **validation pack** (real use cases,
public reference files, analytic expected results with sources) to prove a future implementation.

Authoring rules and section layout: [`TEMPLATE.md`](TEMPLATE.md).

**Operator model:** llull's primary user is an **AI agent driving the `llull` CLI**, not an engineer at
the UI; the person who asks for the work is not assumed to be an engineer either. The cross-cutting
requirements for that — discoverable commands, machine-readable results with stable error codes,
self-verification, built-in engineering guardrails, `reviewRequired` flags and human approval gates — are
in [`AGENT_FIRST.md`](AGENT_FIRST.md) and override any UI-first wording in the packs.

## Gaps

| # | Gap | Id | Functional | Technical | Validation |
| - | --- | -- | ---------- | --------- | ---------- |
| 01 | Exact B-rep kernel as production basis (OCC default, STEP→B-rep, naming, large assemblies) | KRN | [spec](01-exact-brep-kernel/FUNCTIONAL_SPEC.md) | [spec](01-exact-brep-kernel/TECHNICAL_SPEC.md) | [pack](01-exact-brep-kernel/validation/README.md) |
| 02 | Advanced freeform surfacing (NURBS, G2/G3, surface analysis, airfoils, wings, fuselage lofts) | SRF | [spec](02-advanced-surfacing/FUNCTIONAL_SPEC.md) | [spec](02-advanced-surfacing/TECHNICAL_SPEC.md) | [pack](02-advanced-surfacing/validation/README.md) |
| 03 | GD&T, Model-Based Definition, semantic PMI, tolerance stack-up | GDT | [spec](03-gdt-mbd-pmi/FUNCTIONAL_SPEC.md) | [spec](03-gdt-mbd-pmi/TECHNICAL_SPEC.md) | [pack](03-gdt-mbd-pmi/validation/README.md) |
| 04 | Data exchange: STEP AP242 (PMI), JT, IGES, QIF, LOTAR | XCH | [spec](04-interop-ap242-jt-iges/FUNCTIONAL_SPEC.md) | [spec](04-interop-ap242-jt-iges/TECHNICAL_SPEC.md) | [pack](04-interop-ap242-jt-iges/validation/README.md) |
| 05 | Structural analysis hand-off (idealization, meshing, Nastran / CalculiX, margins of safety) | FEA | [spec](05-fea-cae-handoff/FUNCTIONAL_SPEC.md) | [spec](05-fea-cae-handoff/TECHNICAL_SPEC.md) | [pack](05-fea-cae-handoff/validation/README.md) |
| 06 | Composite structures (plies, laminates, drape, flat patterns, CLT) | CMP | [spec](06-composites/FUNCTIONAL_SPEC.md) | [spec](06-composites/TECHNICAL_SPEC.md) | [pack](06-composites/validation/README.md) |
| 07 | Manufacturing features (aerospace sheet metal, holes, threads, pockets, feature recognition) | FTR | [spec](07-sheet-metal-machined-features/FUNCTIONAL_SPEC.md) | [spec](07-sheet-metal-machined-features/TECHNICAL_SPEC.md) | [pack](07-sheet-metal-machined-features/validation/README.md) |
| 08 | Aerospace materials (allowables, basis) & standard parts (NAS / MS / AN / EN fasteners) | MAT | [spec](08-materials-standards-libraries/FUNCTIONAL_SPEC.md) | [spec](08-materials-standards-libraries/TECHNICAL_SPEC.md) | [pack](08-materials-standards-libraries/validation/README.md) |
| 09 | Configuration management, revisions, effectivity, FAI, traceability, export control | PLM | [spec](09-plm-configuration-traceability/FUNCTIONAL_SPEC.md) | [spec](09-plm-configuration-traceability/TECHNICAL_SPEC.md) | [pack](09-plm-configuration-traceability/validation/README.md) |

## Dependencies and recommended order

```
01 KRN (exact B-rep, OCC default on desktop) ─┬─> 02 SRF ──> 06 CMP
                                              ├─> 07 FTR ──> 08 MAT (fasteners attach to holes)
                                              ├─> 03 GDT ──> 04 XCH (AP242 semantic PMI) ──> 09 PLM (LOTAR, FAI)
                                              └─> 05 FEA (needs exact faces for loads / BCs, midsurfaces)
08 MAT feeds 05 FEA (allowables) and 06 CMP (lamina properties).
```

1. **01 KRN** — everything else needs exact faces/edges, stable naming and B-rep STEP import.
2. **07 FTR + 08 MAT** — first sellable aerospace value: machined fittings and sheet-metal brackets with
   real holes, fasteners and materials (supplier / tier-2 / MRO work).
3. **03 GDT + 04 XCH** — MBD and AP242 make llull usable inside an OEM supply chain.
4. **09 PLM** — release discipline for AS9100 / EN 9100 suppliers.
5. **05 FEA, 02 SRF, 06 CMP** — engineering depth (analysis hand-off, aerodynamic surfaces, composites).

Each gap's `TECHNICAL_SPEC.md` § Delivery plan gives milestones and effort.

## Alignment with in-flight work: rigid-body dynamics (2026-10-16)

The motion / rigid-body dynamics work (merged to `main` 2026-10-16, PR #73, plus `dbb0e491` for mesh placement;
[`docs/DYNAMICS.md`](../DYNAMICS.md)) built pieces several packs had planned to build themselves. The packs **reuse**
them; nothing below is built twice.

| Delivered by dynamics | Where | Pack that planned it | Decision |
| --------------------- | ----- | -------------------- | -------- |
| Polyhedral mass properties (Eberly divergence integrals): mass, volume, centre of mass, full inertia tensor `[Ixx,Iyy,Izz,Ixy,Ixz,Iyz]` about the CoM; `combineMassProperties` (parallel-axis) | `packages/core/src/geometry/massProperties.ts` | 01 TR-KRN-40/42 (inertia, assemblies), 04 TR-XCH-02 mesh fallback, 08 VC-MAT-04 | **The one non-kernel mass engine.** 01 M3 adds only the exact kernel path, area, bbox, principal axes and the part frame on top of it; `mass_properties` and `simulate_motion` read the same resolver (01 §5.4). |
| Per-entity mass properties in world pose: closed forms for box / cylinder / sphere, triangles otherwise, instances combined, density per solid through a `densityOf` callback | `packages/core/src/geometry/entityMassProperties.ts` | 01 TR-KRN-42; today's `inspect/solidVolume.ts` (sweep / loft / revolution closed forms, exact OCC volume) | **Merge, don't fork**: one `resolveMassProperties(doc, entity, densityOf, ctx)` with the order exact kernel → closed form (all of `solidVolume.ts`'s cases) → mesh. Both callers switch to it (01 M3). |
| Density per entity: material `density` (g/(doc unit)³) else `add_rigid_body.density` (kg/m³) else steel 7850 kg/m³ | `packages/core/src/dynamics/simulationModel.ts` | 08 TR-MAT-10 (resolution order), AF-31 (named defaults), AF-32 (`unverified`) | A second copy of the resolution order with a different param unit and a silent default. 08 M1 owns **one** resolver; dynamics consumes it after merge (08 TR-MAT-10). |
| `doc.dynamics` core root field + `persistence/dynamicsValidation.ts` | `model/dynamics.ts` | 01 §3.1 (v3 envelope) | Added as a row of the v3 table. It lands on v2 (absent until used, no bump); v3 carries it unchanged. |
| Injected engine pattern: `PhysicsEngine` contract in core, `ctx.physics` (optional, `null` when absent), impl package `packages/physics-mujoco`, composition-root install, dep-cruiser rules `physics-*`, core sub-layer `dynamics/` | `.dependency-cruiser.cjs`, `architecture.md` L9 | 05 `ctx.feaArtifacts`, 08 `ctx.libraries`, 09 `ctx.caller`, 03 `ctx.pmiRules` | **The template for every new port** (below). |
| Mesh entities honour `position` / `rotation` (viewport, kernel, triangles, bounds, mass) | `geometry/{bounds,tessellation,solidTriangles}.ts`, `model/types.ts` | 01 TR-KRN-41 (part authored at origin, placed by location: 3.3e-14), 04 import world placement | Imports place bodies by `position` / `rotation` instead of baking world coordinates; the `brep` invariant stays "before position/rotation". |

Rules this sets for every pack:

1. **Ports follow the `ctx.physics` shape**: a narrow interface in core (`commands/types.ts` or the owning core
   sub-layer), an optional `ExecutionContext` field that is `null`/absent when not installed, installed only by the
   composition root (`src/app/`, `server/`, `desktop/`), a contract test, and a command that refuses with a stable
   code when it is missing (AF-11, AF-41). Engines that run a third-party solver live in `packages/<role>-<impl>`
   (`physics-mujoco`; a future in-process FE solver would be `packages/solver-*`), never in a domain plugin.
   External processes (Gmsh, CalculiX, CadQuery) stay host transports (05 §4).
2. **L9 text is generalised once** — "injected engines: `ctx.kernel`, `ctx.physics`, …" — not one sentence per
   port; packs that add a port add one list item.
3. **Mass properties are computed in one place** (01 §5.4); anything needing mass, CoG or inertia (08 BOM / weight
   and balance, 05 modal mass checks, 06 `laminate_mass` when it delegates, dynamics bodies) calls it.
4. **Density is resolved in one place** (08 TR-MAT-10); any safety-relevant default is reported as named
   (`densitySource`, `defaulted: true`), never silent.
5. **Dynamics follows AGENT_FIRST**: now that AF-14 exists, `simulate_motion` / `inspect_dynamics` warnings and
   refusals get stable `DYN_*` codes (`CommandResult.error`) and `provenance` (engine, timestep, densities).
   Tracked as a dynamics follow-up.

### Start order (updated 2026-10-16, after the dynamics merge)

| Task | Pack / milestone | State |
| ---- | ---------------- | ----- |
| Plan reports with per-step error codes, query `data`, alias map | AGENT_FIRST AF-14 (shared prerequisite) | **implemented** (see AGENT_FIRST §2.2 status) |
| OCC default on desktop, `kernel_info`, provenance fields | 01 M1 | ready |
| Custom OCCT 7.9.x WASM build with exceptions | 01 M2 (long pole, 4–6 eng-weeks) | ready; unblocks 01 M3–M10, 02, 04, 07 native |
| `lib/quantity.ts`, `resolveDensity` (wired into `mass_properties` **and** dynamics), unit-correct mass | 08 M1 | ready |
| Pure maths: NURBS / NACA generator / `SECTION_RING_POINTS` loft fix | 02 core maths | ready |
| CLT (ABD, first-ply failure) | 06 pure core | ready |
| Flat pattern / setback / countersink maths, hole table | 07 pure parts | ready; native BRepFeat waits for 01 M2 |
| Canonical JSON + Ed25519 verify helpers | 09 pure parts | ready; `packages/plm` waits for decision 1 |
| `doc.pmi` data model + note commands (no face resolution yet) | 03 MVP data | ready |
| `resolveMassProperties` over the dynamics mass engine (merge `solidVolume.ts` closed forms; part-frame shift on the mesh path) | 01 M3, non-kernel half | ready; the exact-kernel half waits for 01 M1 (M2 for exception-safe GProp) |
| New `ExecutionContext` ports (`ctx.caller`, `ctx.libraries`, `ctx.feaArtifacts`) | 09 / 08 / 05 | ready; copy the `ctx.physics` shape |
| New packages + dep-cruiser / alias entries (`domain-aero`, `plm`) | 02 / 06 / 07 / 08 / 09 | blocked on decision 1 (package layout) |
| v3 envelope + `migrate2to3`, import placement by `position` / `rotation` | 01 M4, 04 M3 | waits for 01 M2 |
| Deck writers, closed-form checks | 05 `@cae` pure | blocked on decision 1; materials need 08 M2 |

## Status (2026-10-15)

All nine packs are written: 18 specs (≈ 7 000 lines), 9 validation plans, 87 JSON reference files,
generator scripts and draft `build_project` plans. Every pure-Python generator re-runs to byte-identical
output (`python3 -I <script>` from its `validation/` folder). Four scripts need OCC's Python binding
(`pip install cadquery-ocp`) and are optional: `01/…/measure_step_brep.py`, `01/…/probe_occt_behaviour.py`,
`07/…/generate_test_parts.py`, `07/…/survey_step_features.py`.

| Gap | Effort (from its TECHNICAL_SPEC § Delivery plan) | Key validation assets |
| --- | --- | --- |
| 01 KRN | ≈ 35.5–46.5 eng-weeks | 10 closed-form solids (incl. at 70 m), OCCT 7.9.3 cross-check, all 27 NIST B-rep files measured |
| 02 SRF | ≈ 33 eng-weeks | NACA 4/5-digit generator vs pinned UIUC files (≤ 1e-7 c), analytic curvature, OpenVSP TR-1208 wing, Sears–Haack |
| 03 GDT | MVP ≈ 11 eng-weeks, V1 + 6.5 | NIST PMI census (17 AP242 files), stack-ups (WC / RSS / seeded Monte Carlo), surface texture |
| 04 XCH | MVP ≈ 11 eng-weeks (shares 01 M3/M4) | NIST PMI zip pinned (sha256), validation properties of 28 files (17 AP242 + 11 AP203), OCCT IGES samples |
| 05 FEA | see spec (M1–M6) | Cantilever / modal / Kirsch / plate buckling closed forms, NAFEMS LE1 & LE10, CalculiX reference decks |
| 06 CMP | ≈ 18 eng-weeks to V1 | CLT ABD + first-ply failure (T300/5208, AS4/3501-6), hemisphere fishnet drape, layup rules |
| 07 FTR | see spec | Flat pattern / setback (FAA AC 43.13-1B example), countersink, 3 synthetic STEP parts, NIST CTC-01 |
| 08 MAT | MVP ≈ 28 d, V1 + 16 d | Sourced material dataset (partial), NAS6203–6206 / MS20470 / Hi-Lok / MS21042 catalogue sample, grip selection |
| 09 PLM | see spec | RFC 8032 Ed25519 vectors (verified locally, Python + Node), canonical-JSON hashes, release → ECO → rev B scenarios |

### Defects in today's llull found while writing the packs

- `loft_sections` / `sweep_profile` resample every section to 24 points (`SECTION_RING_POINTS`): an airfoil
  loses ≈ 2 % section area and its sharp trailing edge (02 SRF).
- `mass_properties` always labels mass in grams, whatever the document units and density unit (08 MAT);
  it returns no surface area or centroid, so STEP validation properties cannot be checked (04 XCH).
- The bundled `opencascade.js@1.1.1` is OCCT 7.4.0p1 (2020) while the bundled CadQuery uses OCP 7.9.3; it
  does not bind `GeomAPI_Interpolate` / `GeomFill_NSections`, and `STEPCAFControl` / `XCAFDoc` / `BRepFeat_*`
  availability is unconfirmed (01, 02, 04, 07).
- Inertia computed far from the origin loses precision (1.2e-9 relative at 70 m, 1.2e-7 at 1 km); a local
  part frame fixes it (01 KRN). The dynamics branch's triangle integration also runs in world coordinates, so
  the same part-frame shift applies to it (01 TR-KRN-41).
- Two mass paths with two density conventions once dynamics merges: `mass_properties` (g/(doc unit)³ param,
  exact OCC volume, sweep/loft closed forms, no inertia) and `add_rigid_body` (kg/m³ param, silent steel default,
  inertia from display triangles for every non-primitive). Unified by 01 §5.4 and 08 TR-MAT-10.

### Cross-gap decisions needed before implementation

1. **Package layout.** The packs propose new plugin packages independently: `@aero` / `packages/domain-aero`
   (02, 06, 08), `packages/domain-mfg` (07), `domain-cae` (05), `packages/plm` (09). Recommendation: one
   `packages/domain-aero` workspace with one `CadPlugin` per discipline, plus PLM as its own package. Needs
   approval (CLAUDE.md layer map, `.dependency-cruiser.cjs`, `tsconfig.base.json` aliases). Precedent from
   dynamics: solver/engine adapters are `packages/<role>-<impl>` (`physics-mujoco`), not domain plugins, so `domain-cae`
   holds only commands + pure `@cae` writers; edit the dep-cruiser/alias files after the dynamics merge.
2. **OCC build.** A custom OCCT 7.9.x WASM build with C++ exceptions, aligned with the bundled OCP, exposing
   every class the packs list (01 TR-KRN-01/02 owns the list).
3. **One kernel face-query port** — *settled in review*: `FaceQueryPort`, exposed as the optional
   `GeometryKernel.faceQuery?` (01 TECHNICAL_SPEC §5.9, TR-KRN-90..92; Manifold omits it). It merges the
   requests of 02 (curvature, continuity, distance, B-spline), 03 / 05 (face centroid, normal, axis, radius),
   06 (face geometry, projection, evaluation) and 07 (face graph); the other packs reference it.
4. **Document v3** — *settled in review*: one envelope and one `migrate2to3` owned by 01 (TECHNICAL_SPEC §3.1),
   listing every pack's slice (plus the core `dynamics` slice from the motion work); plugin slices survive replay through a new `DocumentExtension.carry?` hook and
   report load problems through `afterLoad` (09 TR-PLM-32/33, core changes to review with `cad-reviewer`).
4b. **Exact STEP import** — *settled in review*: one command, `import_step_exact`, owned by 01 (B-rep blob
   leaf, healing, import report); 04 extends it with validation properties, assembly tree and AP242 PMI, and
   owns `export_step_ap242` and the single GVP band policy.
5. **Licensing**: shipping GPL Gmsh and CalculiX with the desktop installer (05); licensed MMPDS / NAS /
   CMH-17 data must stay in private libraries that never land in saved files (08).
5b. **Agent-first plumbing (shared prerequisite, do first)**: plan reports with per-step error codes,
   query `data` and an alias→ids map (AGENT_FIRST AF-14); human gates bound to a human-held signing key
   (AF-34a). Every pack's CLI validation cases assume these.
6. **Open surfaces** as 3D entities that are not closed solids (02 D1); `DerivationGuard.check` receiving the
   command name (09); the DXF writer moving from domain-aec to core `lib` (07 D4).

### Verification limits

The session's network policy refused direct fetches from most standards and agency hosts (nist.gov, iso.org,
faa.gov, nasa.gov, cax-if / mbx-if, opencascade.org, UIUC, wikipedia…). GitHub, PyPI and npm were reachable,
so OCCT, FreeCAD, OpenVSP, CalculiX, Verdict, pyNastran, Gmsh and the NIST files (from `usnistgov/SFA`) were
read or downloaded and hashed directly. Everything else was checked through search-engine extracts of the
named official page. Each `validation/sources.md` grades every source (fetched / downloaded / search
extract) and lists what could not be verified; values not confirmed are marked `TBD` or
`secondary_unconfirmed` and are not used as pass/fail thresholds. Re-run the open checks once those hosts
are allowed. The largest open item: no MIL-HDBK-5J / MMPDS design allowable is verified yet (08 MAT).

### Review (2026-10-15)

All nine packs were reviewed by independent agents that recomputed every headline number with their own
scripts, re-ran every generator (pure-Python ones byte-identical; OCP ones with `cadquery-ocp`), validated
the draft plans against the real zod schemas / `build_project validate`, and checked every repo claim
(paths, commands, constants, toolsets, CLI syntax). Defects found and fixed include:

- 09: the sample document was not a loadable llull document (replaced by one llull produced; hashes and
  signatures recomputed); replay silently dropped the PLM slice (new carry hook); negative signature vectors
  are now really verified in Node (22/22 pass).
- 03: one stack-up probability was off by 1.1e-7 against a 1e-12 tolerance (exact sensitivities now).
- 05 / 08: stored values rounded to 6 digits failed their own 1e-9 tolerances (now 12 significant digits);
  FEA now consumes 08's material record instead of defining its own fields.
- 06: the composites model type was placed in a plugin while core referenced it (moved to core model, L2/L10).
- 04: the `imported` recipe leaf stored no file bytes, so imports could not be rebuilt after reload (replaced
  by 01's blob leaf); 2 of the NIST files' embedded validation properties disagree with their own geometry
  (now expected red, still imported).
- 01: the persistent-naming test would have passed with today's heuristic (geometry changed so it fails).
- 07: the BRepFeat bindings were probed in opencascade.js 1.1.1 (`MakeCylindricalHole` cannot be
  constructed, `MakeLinearForm` is absent); native feature path narrowed to prism / revolve.
- 02 / 06: missing technical-requirement index and expected values added; plans aligned with type sketches.

Verdicts after the fixes: all packs **ready with notes** — the notes are the open questions in each
TECHNICAL_SPEC and the unverified sources listed in each `validation/sources.md`.

## What "validated" means here

A gap is done only when every `VC-*` case in its `validation/README.md` passes in an automated gate
(unit / golden / `npm run quality` / `npm run production` style), on the **desktop OCC kernel**, with the
reference data pinned in the validation folder (or pinned by URL + sha256 when the licence forbids
redistribution).
