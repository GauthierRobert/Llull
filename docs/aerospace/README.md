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
  part frame fixes it (01 KRN).

### Cross-gap decisions needed before implementation

1. **Package layout.** The packs propose new plugin packages independently: `@aero` / `packages/domain-aero`
   (02, 06, 08), `packages/domain-mfg` (07), `domain-cae` (05), `packages/plm` (09). Recommendation: one
   `packages/domain-aero` workspace with one `CadPlugin` per discipline, plus PLM as its own package. Needs
   approval (CLAUDE.md layer map, `.dependency-cruiser.cjs`, `tsconfig.base.json` aliases).
2. **OCC build.** A custom OCCT 7.9.x WASM build with C++ exceptions, aligned with the bundled OCP, exposing
   every class the packs list (01 TR-KRN-01/02 owns the list).
3. **One kernel face-query port** — *settled in review*: `FaceQueryPort`, exposed as the optional
   `GeometryKernel.faceQuery?` (01 TECHNICAL_SPEC §5.9, TR-KRN-90..92; Manifold omits it). It merges the
   requests of 02 (curvature, continuity, distance, B-spline), 03 / 05 (face centroid, normal, axis, radius),
   06 (face geometry, projection, evaluation) and 07 (face graph); the other packs reference it.
4. **Document v3** — *settled in review*: one envelope and one `migrate2to3` owned by 01 (TECHNICAL_SPEC §3.1),
   listing every pack's slice; plugin slices survive replay through a new `DocumentExtension.carry?` hook and
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
