# Gap 05: Structural analysis (CAE) hand-off — functional specification

Gap id **FEA** · status: specification · written 2026-10-15 · validation pack: [`validation/README.md`](validation/README.md)
· sources register: [`validation/sources.md`](validation/sources.md)

## 1. Summary

The only structural analysis in llull is AEC-specific. The `industrial` plugin runs 2D frame and steel-member checks
(direct-stiffness `@lib/frame2d`, EN 1993 load combinations) on beam-and-column models
(`packages/domain-aec/src/industrial/{frames,steelDesign,purlins}`). Nothing goes from a **solid or thin-walled part**
to a **finite-element model**. There is no idealization (midsurface, defeaturing), no mesher, no loads or boundary
conditions on exact faces, no materials with elastic constants, no solver deck (Nastran BDF, CalculiX/Abaqus INP),
no results import or contour display, and no margin-of-safety reporting.

Aerospace structure is certified by analysis supported by test. Every primary or secondary part needs a stress
justification at limit × 1.5 (14 CFR 25.303 [R1]; spaceflight NASA-STD-5001B [R3]). Today the designer has to
re-export STEP into a separate pre-processor and rebuild the loads, BCs and materials there. Nothing traces the result
back to the design revision. A design tool that cannot say whether a bracket has positive margins, or cannot hand a
clean deck to the stress office, does not fit an aerospace design office or its supply chain.

The gap closes in three steps:

1. **Analysis set-up as document data.** Materials with elastic constants and allowables, part idealization,
   loads and BCs on exact B-rep faces, load cases, and mesh controls are all pure llull commands, so they replay,
   get parametrised and stay traceable.
2. **An offline open toolchain on the desktop.** Gmsh in the bundled CPython meshes the part [R10] and a bundled
   CalculiX process solves it [R30]. Results come back as numbers first (max values, probes, frequencies, margins of safety with named factors), with contours, deformed shapes and mode shapes as an optional view.
3. **Standard hand-off.** The same model exports to a Nastran BDF and a CalculiX/Abaqus INP for an analysis
   department's own solver, and comes back as FRD/OP2/VTU results.

## 2. Aerospace context & value

| Context | Today (who / which tools) | What llull adds | Source |
| ------- | ------------------------- | --------------- | ------ |
| Certification by analysis (Part 25 / CS-25) | Stress engineers check limit loads × FoS 1.5. Ultimate loads must be carried 3 s without failure, and limit loads without detrimental permanent deformation. | Load cases tagged `limit` or `ultimate`, FoS 1.5 by default, and an MS table per part and load case. | [R1], [R2], [R4] |
| History of the 1.5 factor | The US Air Corps adopted the ultimate factor of 1.5 in 1930 and wrote it into design requirements in 1934. | The factor is configurable and its origin is documented. | [R5] |
| Spaceflight hardware | NASA programmes compute MS = allowable / (limit × FoS) − 1 for yield and ultimate, and both MS must be positive. | The same equation, with a yield factor and an ultimate factor per analysis. | [R3], [R6] |
| Nastran as lingua franca | NASTRAN, the NASA Structural Analysis System, was completed in the early 1970s, "the first of its kind" in FEA. BDF bulk data stays the exchange format between design and stress groups. | BDF export (GRID, CTETRA, CQUAD4/CTRIA3, PSHELL/PSOLID, MAT1, SPC1, FORCE, PLOAD4). | [R31], [R14] |
| Open-source FEA stack | FreeCAD FEM chains Gmsh/Netgen meshing, a CalculiX solver and FRD import. CalculiX uses ABAQUS-style input and ships 638 verification decks. | The same proven stack, driven by llull commands, the CLI and MCP, offline on the desktop. | [R15], [R30] |
| Solver verification | Commercial solvers publish NAFEMS LE1 and LE10 verification (Abaqus, OptiStruct, COMSOL), and FeenoX + Gmsh reproduces both. | NAFEMS LE1 and LE10 in llull's quality gate. | [R40]–[R45] |
| Thin-walled airframe parts | Skins, ribs, frames and sheet-metal clips are modelled as shells on midsurfaces in commercial pre-processors. | Midsurface extraction for constant-thickness parts and shell idealization (V1). | — (llull design; see §10) |

**Value statements** (sourced only; no invented ROI):

- The FoS and the margin equation are regulatory or agency definitions [R1][R3]. Computing them inside the design tool
  takes the manual transcription step out of each design iteration. The KPIs in §9 measure that.
- A BDF/INP written straight from the design model removes the STEP-to-pre-processor rebuild. This is the hand-off FreeCAD FEM already shows
  in open source [R15].
- llull's analysis output is checked against public benchmarks that vendors also publish [R40]–[R45]. This lets a user
  trust a quick check before handing off to the certified analysis.

## 3. Personas & user stories

Roles follow [`../AGENT_FIRST.md`](../AGENT_FIRST.md) §1. Nobody in the loop is assumed to have stress-analysis
judgement until the qualified reviewer signs. This gap is the **highest-risk area** of the aerospace set: a
non-engineer owner and an AI operator can produce a margin of safety. llull therefore names every factor and allowable it
uses (AF-31), marks every margin `reviewRequired` (AF-33), and leaves negative or marginal results to a human
disposition (AF-34). The numeric margin table and probes come first; plots are an optional view of the same data (AF-21).

| Role | Who | Uses | Main need |
| ---- | --- | ---- | --------- |
| **Operator (primary)** | AI agent (Claude Code via the `llull` CLI; a cloud agent via MCP) | `llull run`, `llull fea_mesh`, `llull fea_solve`, `llull check_analysis`, `llull compute_margins --json` | A deterministic command vocabulary with units in every param, stable error codes, and JSON results it can compare and explain |
| **Owner** | The person who asks for the result (supplier designer, student, MRO planner). **Not assumed to be an engineer** | Natural language to the agent; may watch the desktop app | A plain answer: what was checked, what passed, what needs a qualified engineer |
| **Qualified reviewer** | Stress engineer or design-organisation signatory (Part 21 DOA, DER/CVE, company authority) | Desktop app review surfaces (margins table, contours, disposition dialog), exported BDF/INP decks | Audits inputs and method, dispositions negative or marginal margins, signs. Owns the engineering judgement |

User stories:

- **US-1 (owner → operator).** "Check whether this bracket is strong enough for a 2 kN limit load on the lug." The agent assigns a
  gap 08 material record, fixes the bolt holes, adds the load as `limit`, runs mesh, `check_analysis` and `compute_margins`,
  and reports min MS with its location, the factors and allowables used (each with its source and `defaulted` flag), and
  "computed by llull, not approved — needs a qualified engineer".
- **US-2 (operator).** When the MS is negative or below the configured marginal band, the agent cannot accept it. It reports the
  failing region and the code `FEA_MS_NEGATIVE` / `FEA_MS_MARGINAL`, proposes design changes, and re-runs. Only the qualified
  reviewer can record an acceptance (`dispose_margin`, human gate).
- **US-3 (operator → reviewer).** The agent exports a BDF/INP with `--save` (one PSOLID/PSHELL per part, MAT1 with the material
  name in comments, SPC1 sets named after the llull constraints, FORCE/PLOAD4 per load case) for the stress office.
- **US-4 (operator).** For a thin sheet-metal clip the agent idealizes it as a shell on its midsurface, checks the coverage number
  returned by `extract_midsurface`, and refuses shell export below 98 % coverage unless a human accepts it.
- **US-5 (operator).** The agent runs modal and buckling analyses and compares them with `hand_check` in the same JSON report
  (FE value, analytic value, ratio).
- **US-6 (operator).** After a parameter change the agent sees `state: "stale"` in `analysis_report` and `FEA_RESULTS_STALE` from
  `compute_margins`, and loops back to `fea_mesh`.
- **US-7 (reviewer).** The reviewer imports an OP2 or FRD from the stress office's own run and reviews it in the desktop app as
  review-only results, with the design revision recorded.
- **US-8 (all).** Defeaturing applies only to the analysis geometry, never to the design.

## 4. Scope / out of scope

| Phase | In scope |
| ----- | -------- |
| **MVP (M1–M4)** | Elastic material data and allowables links. Analysis cases (linear static, modal, linear buckling). Solid and plane-stress idealization. Constraints and loads on exact faces/edges/points with `*Near` targeting. Gmsh tet4/tet10 and tri/quad (2D) meshing with size controls. Verdict quality report and gate. CalculiX INP export and bundled solve on desktop. FRD import. Results as data (max values with location, probes, frequencies); UI contours, deformed shape and mode shapes for review. MS table at FoS 1.5 (named default), `reviewRequired`, human disposition of negative/marginal rows, `check_analysis`. Stale-result tracking. Validation: NAFEMS LE1/LE10, analytic beams, CalculiX test decks. |
| **V1 (M5–M6)** | Nastran BDF export (SOL 101/103/105). OP2 import through pyNastran. VTU export through meshio. Shell idealization with automatic midsurface for constant-thickness parts (face-pairs: planar plus coaxial cylindrical). Defeaturing of holes, fillets and chamfers by size. Distributed couplings (RBE3-style) for remote loads and moments. Analytic quick checks (beam, SS plate buckling, Kt). Netgen as an alternative mesher. |
| **V2** | Beam idealization of stringers and frames (CBAR/CBEAM, B31/B32). Composite shells (PCOMP from gap 06 CMP). Contact and bolted joints (linear, tied). Variable-thickness midsurface. Submodelling. Fatigue and damage tolerance hooks (stress spectra export). Running a user-installed Nastran or MYSTRAN. |
| **Out of scope** | Writing a new FE solver in TypeScript (llull hosts and drives solvers). Nonlinear plasticity or explicit dynamics workflows. CFD and aeroelasticity. Certification sign-off (llull computes, and humans approve). Thermal analysis (possible later through CalculiX `*HEAT TRANSFER`). |

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-FEA-01 | MUST | A document holds one or more **analysis cases**. Each has a type (`static`, `modal`, `buckling`), a solver (`calculix`, `nastran`), a unit system, a factor set, load cases, and mesh controls. All of it is created and edited by commands, replays, and saves with the document. | L1/L4/L8: analysis set-up is design data and must be traceable to the revision | L1 |
| FR-FEA-02 | MUST | Analysed parts use a **gap 08 MAT material record** carrying elastic constants as properties: E and ν, with G explicit or derived as E / (2(1 + ν)), and density. FEA reads these values and never stores its own copy. E > 0, G > 0 and ν ∈ (−1, 0.5) are validated when the property is set. | MAT1 needs E, G, ν and ρ, and CalculiX `*ELASTIC` needs E and ν. One material model for the whole document (gap 08 FR-MAT-01…04) | [R14], [R30], gap 08 |
| FR-FEA-03 | MUST | MS uses **allowables** (Ftu, Fty, optionally Fsu, Fcy) read from the gap 08 record, with their basis (A, B, S, …) and provenance carried unchanged into the MS report. No basis substitution (gap 08 FR-MAT-06). | MS needs allowables, and their provenance must be visible | [R3], gap 08 |
| FR-FEA-04 | MUST | **Part idealization** per part: `solid` (3D), `plane_stress` (2D region plus thickness), and `shell` (surface plus thickness and offset). `beam` is V2. | Thin parts are analysed as shells, and LE1 is plane stress | [R40], [R30] |
| FR-FEA-05 | SHOULD | **Midsurface extraction** for constant-thickness thin-walled solids. It reports coverage (the share of face area that was paired) and lists unpaired faces, and it is derived geometry that never edits the design. | Airframe sheet-metal and machined thin walls are meshed as shells | — |
| FR-FEA-06 | SHOULD | **Defeaturing** of the analysis geometry: remove holes, fillets and chamfers below a size or picked by point, using derived geometry only. | Small features drive the mesh size without changing the global stiffness | [R10] (`occ.defeature`) |
| FR-FEA-07 | MUST | **Constraints** (`fixed`, `pinned`, `symmetry`, `displacement` per DOF) on faces, edges or points. Targets are given as `facesNear` / `edgesNear` / `pointsNear` and are re-resolved after parametric edits, as `fillet_edge` already does. | Topological naming (KI5): indices are not stable | L1 (KI5) |
| FR-FEA-08 | MUST | **Loads**: force (as a total distributed over the target, or per node), pressure (positive is compressive), gravity/acceleration and moment. Each load belongs to a named **load case** tagged `limit` or `ultimate`. | 25.301/25.303 distinguish limit from ultimate loads | [R2], [R1] |
| FR-FEA-09 | MUST | **Meshing** with Gmsh: tet4/tet10, and tri3/tri6/quad4/quad8 for plane stress and shells. Controls: global size, order, local size at targets. The mesh is deterministic and reproducible from geometry plus controls plus mesher version. Adequacy warnings flag fewer than 2 elements through the thickness or span. | Gmsh exposes these through its Python API. CalculiX simplebeam shows a single element is 10 % stiff | [R10], [R30] |
| FR-FEA-10 | MUST | A **mesh quality report** with Verdict metrics: aspect ratio, scaled Jacobian, skew, warpage and min angle, as histograms against the acceptable ranges. Export is blocked when any element is inverted (scaled Jacobian ≤ 0). | Bad elements give wrong stresses | [R12] |
| FR-FEA-11 | MUST | Export a **CalculiX/Abaqus INP** deck: `*NODE`, `*ELEMENT`, `*NSET`/`*ELSET`, `*MATERIAL` + `*ELASTIC` + `*DENSITY`, `*SOLID SECTION`/`*SHELL SECTION`, `*BOUNDARY`, `*CLOAD`/`*DLOAD`, `*STEP` with `*STATIC`/`*FREQUENCY`/`*BUCKLE`, and `*NODE FILE`/`*EL FILE`. | The CalculiX input follows ABAQUS conventions | [R30] |
| FR-FEA-12 | MUST (V1) | Export a **Nastran BDF**: executive and case control for SOL 101/103/105, and bulk cards GRID, CTETRA, CQUAD4, CTRIA3, CQUAD8, CTRIA6, PSOLID, PSHELL, MAT1, SPC1, FORCE, MOMENT, PLOAD4, GRAV and RBE3, plus the eigen-method cards EIGRL (SOL 103) and EIGRL or EIGB (SOL 105). | The stress-office hand-off format | [R14], [R31] |
| FR-FEA-13 | MUST | Import **CalculiX FRD** results: nodal displacements, nodal (extrapolated) stresses, eigenmodes and frequencies, and buckling factors (from DAT). | The bundled-solver loop and review of external CalculiX runs | [R15], [R30] |
| FR-FEA-14 | SHOULD | Import **Nastran OP2** results (displacement, stress, eigenvectors) through pyNastran in the bundled Python. | Review of results from the stress office | [R14] |
| FR-FEA-15 | SHOULD | Export the mesh and results to **VTU** (ParaView) through meshio. | An open post-processing hand-off | [R13] |
| FR-FEA-16 | MUST | **Solve locally** on desktop with the bundled CalculiX as a separate process. Fully offline, with cancel, a timeout, a log and the exit status. On the server or cloud it is disabled unless configured. | KI6: offline desktop first | [R30], L1 (KI6) |
| FR-FEA-17 | MUST | **Results as data first** (AF-21): `analysis_report` and `fea_result_field` return max von Mises, displacement magnitude and components with their location and unit, probe values at named points, mode frequencies and buckling factors in `data`. `render_view … --save` can draw the field for multimodal agents (AF-22). | The operator and owner read numbers, not plots | AF-21, AF-22 |
| FR-FEA-17b | SHOULD | **UI result overlays** for the qualified reviewer: contours, deformed shape with a scale factor, animated mode shapes, legend with min/max and units, built on the FR-FEA-17 data. | Review surface only | — |
| FR-FEA-18 | MUST | A **margin-of-safety table** returned in `data`: MS = allowable / (applied_limit × FoS) − 1. Each row gives part, region, load case, criterion, applied value and allowable with units, the factors used, MS, status (`PASS`, `MARGINAL`, `FAIL`), location, provenance (formula, inputs, sources), `unverified`, `reviewRequired` and `disposition`. Exports as JSON, CSV or a sheet table. | 14 CFR 25.303 and NASA-STD-5001B | [R1], [R3], AF-10, AF-35 |
| FR-FEA-19 | MUST | **Modal analysis**: the n lowest frequencies, mode shapes, and mass participation where the solver gives it. | Panel and equipment-bracket frequencies | [R30] |
| FR-FEA-20 | MUST | **Linear buckling**: eigenvalue buckling load factors and mode shapes. | Thin panels in compression | [R30], [R22] |
| FR-FEA-21 | SHOULD | **Analytic quick checks** as read-only commands: cantilever and simply supported beams, the SS plate buckling coefficient k(a/b), and Kirsch Kt. The result view shows them next to the FE result for sanity. | Engineering practice is to check FE against hand calculations | [R20]–[R22] |
| FR-FEA-22 | MUST | **Traceability and staleness**: results record the recipe hash of the geometry, the hashes of the analysis set-up and the mesh, and the solver version. Any upstream change marks them `stale`, and margins refuse stale results. | Results must match the design revision | L1 (L8) |
| FR-FEA-23 | MUST | Every capability is available from the UI, the CLI (`llull`) and MCP, through the same registry. | L1/L5 | L1 |
| FR-FEA-24 | MUST | The **validation suite** (NAFEMS LE1/LE10, analytic cases, CalculiX reference decks) runs in CI and gates releases. | Credibility of the results | [R40]–[R45], [R30] |
| FR-FEA-25 | MUST | **Units**: decks use a consistent system derived from the document unit (mm gives N-mm-t-s, m gives N-m-kg-s, in gives lbf-in-(lbf·s²/in)-s). The deck header names the system, and every conversion is tested. | FE codes have no units, so the user must keep them consistent | [R30] |
| FR-FEA-26 | COULD | **Netgen** as an alternative tet mesher (LGPL). | Licence flexibility and robustness on some geometries | [R11] |
| FR-FEA-27 | COULD | **Structured / hex-dominant meshing** for simple prismatic parts (Gmsh transfinite plus recombine). | Better accuracy per DOF on beams and plates | [R10] |
| FR-FEA-28 | SHOULD | **Licence compliance** for the GPL tools (Gmsh, CalculiX). They are shipped as separate programs, with their licence texts and the corresponding source or a written offer, and listed in the About box. llull code does not link them. | GPL obligations | [R10], [R30] |
| FR-FEA-29 | COULD | Run a **user-installed Nastran or MYSTRAN** through a configured external command, then OP2 import. | Lets the stress office's solver close the loop | [R14] |
| FR-FEA-30 | COULD (V2) | **Composite shell properties** (PCOMP / `*SHELL SECTION, COMPOSITE`) from gap 06 laminates. | Composite airframe structure | — |
| FR-FEA-31 | MUST | **Named safety defaults** (AF-31): every factor of safety, allowable and threshold used by `compute_margins` is either given explicitly or taken from a sourced default that the result names, e.g. `"factors": {"ultimate": {"value": 1.5, "source": "14 CFR 25.303", "defaulted": true}}`. There is no default marginal band: if `marginalBand` is unset, `check_analysis` warns `FEA_MARGINAL_BAND_UNSET`. | No silent safety value | AF-31, [R1] |
| FR-FEA-32 | MUST | **Review flag** (AF-33): every margin row and every `compute_margins` / `check_analysis` result carries `reviewRequired: true` with a reason, and the summary says "computed by llull, not approved — needs a qualified engineer". It is never cleared by an agent. | Margins feed certification decisions | AF-33 |
| FR-FEA-33 | MUST | **Human disposition** (AF-34): a `FAIL` row (MS < 0) or a `MARGINAL` row (0 ≤ MS < `marginalBand`) stays `disposition: "pending_human"`. Only `dispose_margin` with a human-held signature (gap 09 `humanSignatureRequired`) records an acceptance or rejection; an agent caller gets `FEA_HUMAN_GATE` and the document is unchanged. | Accepting a negative or marginal result is an approval act | AF-34 |
| FR-FEA-34 | MUST | **Unverified propagation** (AF-32): if any gap 08 property used (E, ν, G, density, allowable) is `unverified`, every mesh summary, result summary and margin row computed from it carries `unverified: true` and `unverifiedReasons[]`; `check_analysis` reports `FEA_MATERIAL_UNVERIFIED` as a warning that cannot be suppressed. | Typical values are not allowables | AF-32 |
| FR-FEA-35 | MUST | **Readiness check** (AF-20): read-only `check_analysis` returns pass / warn / fail items with stable codes for set-up (targets, materials, constraints, units), mesh (inverted, adequacy, stale), results (stale, missing, foreign) and margins (negative, marginal, pending disposition, unverified). | The agent proves its own work | AF-20 |
| FR-FEA-36 | MUST | **Stable error codes** (AF-11): every refusal and check item has a code from TECHNICAL_SPEC §7.1, the offending ids or paths, and a one-line remediation. | Agents act on codes, not prose | AF-11 |
| FR-FEA-37 | MUST | **Units in params and results** (AF-04, AF-10): every physical param states its unit in the schema (analysis unit system, or `{ value, unit }`), and every number in `data` carries a unit suffix or `unit` field. | No inferred units | AF-04, AF-10 |

## 6. Workflows

### 6.1 CLI (`llull`, the operator's primary path; KI6)

Proposed commands are those of TECHNICAL_SPEC §4. FEA transports (`fea_mesh`, `fea_solve`, `fea_import_results`,
`fea_export`) are called like the existing exchange tools (`llull import_step file=…`): no CLI special case (AF-01).
The analysis id comes from the `run --json` report (`affected`), or from `analysis_report`.

```bash
llull search fea margin                                  # discover (AF-01)
llull describe create_analysis add_fea_load compute_margins
llull guide                                              # aerospace section: units, FoS, minimal FEA plan (AF-03)

# 1. one plan: geometry + gap 08 material record + analysis set-up (build_project, aliases $name)
llull run bracket.plan.json --validate --doc bracket.llull.json            # errors name step path + param (AF-05)
llull run bracket.plan.json --doc bracket.llull.json --kernel occt --json  # data.steps[*].affected -> analysis id

# 2. mesh, check, solve (long ops: --progress, --timeout; cached by content hash, AF-40)
llull fea_mesh analysisId=an-5.1 --doc bracket.llull.json --kernel occt --progress --timeout 300 --json
llull check_analysis analysisId=an-5.1 --doc bracket.llull.json --json     # pass/warn/fail with codes (AF-20)
llull fea_solve analysisId=an-5.1 --doc bracket.llull.json --progress --timeout 900 --json

# 3. numbers first (AF-21): margins, probes, analytic sanity check
llull compute_margins analysisId=an-5.1 --doc bracket.llull.json --json    # rows[] with units, factors, provenance,
                                                                           # reviewRequired, disposition
llull analysis_report analysisId=an-5.1 --doc bracket.llull.json --json         # state, max values + locations, probes
llull hand_check check=cantilever 'inputs={"P_N":9,"L_mm":8,"E_MPa":210000,"b_mm":1,"h_mm":1}' --json

# 4. look (multimodal agents, AF-22) and hand off (AF-12: heavy artefacts only via --save)
llull render_view view=iso analysisId=an-5.1 field=von_mises --save out/vm.png --doc bracket.llull.json
llull fea_export analysisId=an-5.1 format=nastran_bdf --save out/bracket.bdf --doc bracket.llull.json
llull fea_export analysisId=an-5.1 format=calculix_inp --save out/bracket.inp --doc bracket.llull.json

# 5. external results for review (review-only, never used for margins)
llull fea_import_results analysisId=an-5.1 format=frd file=run.frd --doc bracket.llull.json --json
```

`--app` replaces `--doc FILE` to act on the open desktop window (the owner sees each step). `--dry-run` works for every
mutating set-up command (AF-42). Exit code 1 plus `data.code` on any refusal (AF-11).

The agent ends every job with `check_analysis` and reports in this order (AF-36): what was analysed, min MS per load case,
every `unverified` input, every row that needs a human, and the sentence "computed by llull, not approved — needs a qualified engineer".

### 6.2 MCP agent (cloud)

1. `build_project` with the same plan.
2. `fea_mesh` and `fea_solve` are transport tools, available only when the deployment provides Gmsh/ccx. Otherwise they return
   `FEA_TOOL_MISSING` with an install hint (AF-41).
3. `check_analysis` and `compute_margins` (read-only) return the same JSON as the CLI. `fea_export` returns the deck text or writes it
   into the exchange directory.
4. After `set_parameter`, results are `stale`, and the agent loops back to `fea_mesh`.

### 6.3 Desktop UI (review and approval surface only)

The UI shows what the commands produced; it adds no capability of its own.

1. **Analysis tree and glyphs**: cases, parts, constraints and loads drawn on the model, so the owner or reviewer can see what the
   agent set up.
2. **Margins table** with the factor and allowable provenance, `unverified` and `reviewRequired` badges, and FAIL/marginal rows highlighted.
3. **Contours, deformed shape, mode shapes** over the same `fea_result_field` data (optional view, AF-21).
4. **Disposition dialog** (human gate, AF-34): the qualified reviewer accepts a negative or marginal margin with a justification and a
   human-held signature (gap 09 `humanSignatureRequired`), or rejects it. Agents can prepare the request, never complete it.

### 6.4 Surface matrix (FR-FEA-23)

| Capability | CLI (primary) | MCP (cloud) | UI (review) | Notes |
| ---------- | ------------- | ----------- | ----------- | ----- |
| Analysis set-up | `llull run plan.json`, `llull <command> …` | registry tools (toolset `analysis`) | tree + glyphs | pure commands, replayable |
| Midsurface preview / defeature | `llull extract_midsurface … --json` | same | translucent overlay | OCC kernel needed, else `FEA_KERNEL_OCC_REQUIRED` |
| Mesh (Gmsh) | `llull fea_mesh` | `fea_mesh` when the host has Python + gmsh | progress | external process |
| Quality / readiness check | `llull check_analysis --json`, `llull analysis_report --json` | same | histogram panel | read-only, codes |
| Solve (CalculiX) | `llull fea_solve` | `fea_solve` when the host has `ccx` | progress, log | desktop default. Server needs opt-in |
| Results | `llull analysis_report`, `llull fea_result_field`, probes | same | contours (optional) | numbers first |
| Margins | `llull compute_margins --json` | same | table | refuses stale results; every row `reviewRequired` |
| Disposition of negative / marginal MS | prepare only (`FEA_HUMAN_GATE` on completion) | prepare only | **complete** (signature) | human gate |
| Deck export INP / BDF / VTU | `llull fea_export … --save` | `fea_export` (exchange dir) | Export menu | byte-identical across surfaces |
| External results import FRD / OP2 | `llull fea_import_results file=…` | same | File ▸ Import results | review-only |

### 6.5 Error and edge behaviour

| Situation | Behaviour | FR |
| --------- | --------- | -- |
| A target point matches no face or two faces equally | The command is rejected (no-op) with a summary naming the target and the candidate faces | FR-FEA-07 |
| A target face disappears after a parametric edit | The constraint or load is kept but flagged `unresolved`. Mesh and solve are refused until the user fixes it | FR-FEA-07, 22 |
| Material record has no E or ν | Mesh is allowed. Solve and export are refused, naming the part and material | FR-FEA-02 |
| A part is not constrained enough (rigid-body modes) | Pre-solve check: fewer than 6 independent restrained DOFs per connected part gives a warning, and a singular solver matrix gives a readable error from the log | FR-FEA-16 |
| A point force on a single node | Warning about the stress singularity. Margins exclude the singular zone by default and list it separately | FR-FEA-18 |
| Mixed units (document in inches) | The deck is written in the lbf-in system. The header says so and the report shows the units | FR-FEA-25 |
| Gmsh or CalculiX is missing (web, cloud, or misconfigured desktop) | The tool explains how to enable it. The document is never left half-updated | FR-FEA-16 |
| The solver times out or is cancelled | The child process is killed and no results are recorded. The log tail is shown | FR-FEA-16 |
| The results artifact is missing on another machine | State `missing`. The UI offers a re-solve. Margins are refused | FR-FEA-22 |
| Midsurface coverage < 98 % | Shell export is blocked unless the user accepts. Unpaired faces are highlighted | FR-FEA-05 |

### 6.6 Glossary

| Term | Meaning in this spec |
| ---- | -------------------- |
| Limit load | Maximum load expected in service. Loads prescribed by Part 25 are limit loads unless stated otherwise [R2] |
| Ultimate load | Limit load × factor of safety (1.5 unless otherwise specified) [R1][R2] |
| MS (margin of safety) | allowable / (limit × FoS) − 1. Must be ≥ 0 [R3] |
| Idealization | Choice of FE representation for a part (solid, plane stress, shell, beam) |
| Midsurface | Surface halfway through a thin wall, carrying thickness as a property |
| Deck | Solver input file (CalculiX/Abaqus `.inp`, Nastran `.bdf`) |
| FRD / OP2 | CalculiX ASCII results file / Nastran binary results file |
| Scaled Jacobian, aspect ratio | Element shape metrics as defined by Verdict [R12] |

## 7. Acceptance criteria

Each criterion is a CLI invocation with a JSON assertion against `validation/fea_analytic_expected.json` (VC id in the last
column; tolerances there). `D` = `--doc case.llull.json --kernel occt --json`.

| # | Given | When (CLI) | Then (JSON) | VC |
| - | ----- | ---------- | ----------- | -- |
| AC-1 | `plans/fea_cantilever_static_beamp.plan.json` | `llull run <plan> D` (`$an` = analysis id from `affected`); `llull fea_mesh analysisId=$an D`; `llull fea_solve analysisId=$an D`; `llull analysis_report analysisId=$an D` | probe `tip` `u_y` (mm) within 2 % of VC-FEA-10.a = 0.0877714 mm | VC-FEA-10, 40 |
| AC-2 | `plans/fea_cantilever_modal_beamf.plan.json` | same with `modes=4`, then `llull analysis_report D` | `data.results.frequenciesHz[0]` within 1 % of VC-FEA-11.a = 13096.7 and of the CalculiX ref 13096.03 | VC-FEA-11, 41 |
| AC-3 | `plans/fea_nafems_le1.plan.json` | run, mesh, solve, `analysis_report` | probe `D` `s_yy` (MPa) within 2 % of 92.7 | VC-FEA-30 |
| AC-4 | `plans/fea_nafems_le10.plan.json` | run, mesh, solve, `analysis_report` | probe `D` `s_yy` (MPa) within 3 % of −5.38 | VC-FEA-31 |
| AC-5 | the four allowable/limit pairs of VC-FEA-20, no factors given | `llull compute_margins analysisId=$an D` | `rows[*].ms` = 0, 0.5, 0, −0.0666667; row 4 `status: "FAIL"`, `code: "FEA_MS_NEGATIVE"`; `data.factors.ultimate` = `{value: 1.5, source: "14 CFR 25.303", defaulted: true}` | VC-FEA-20, 60 |
| AC-6 | a mesh artifact with one inverted element | `llull fea_export analysisId=$an format=calculix_inp --save x.inp D` | exit 1, `data.code: "FEA_MESH_INVERTED"`, `data.elementIds` non-empty, no file written | VC-FEA-08, 65 |
| AC-7 | an exported BDF | `fea_export … --save` then pyNastran `read_bdf(xref=True)` | no error, card counts match the mesh, Σ FORCE = applied total | VC-FEA-15 |
| AC-8 | solved results | `llull set_parameter name=L expression=10 D`; `llull compute_margins analysisId=$an D` | exit 1, `data.code: "FEA_RESULTS_STALE"` | VC-FEA-50 |
| AC-9 | a 100×60×40 box shelled to 2 mm | `llull extract_midsurface entityId=$box maxThickness=3 D` | `data.areaMm2` = 23 224 ±0.1 %, `data.coverage` = 1 | VC-FEA-03 |
| AC-10 | the same plan | run from CLI, MCP `build_project` and UI dispatch | same document hash and deck sha256 | VC-FEA-51 |
| AC-11 | `plans/fea_plate_hole_kirsch.plan.json` | run, mesh, solve, `analysis_report` | peak `s_xx` at the hole within 5 % of 300 MPa | VC-FEA-14 |
| AC-12 | the desktop installer | `npm --prefix desktop test` | GPL texts and source offers for Gmsh and CalculiX present | VC-FEA-52 |
| AC-13 | any solved analysis | `llull compute_margins … D` | every row has `reviewRequired: true` and a `reviewReason`; `summary` contains "not approved" | VC-FEA-61 |
| AC-14 | a negative-MS row | agent calls `llull dispose_margin analysisId=$an rowId=r4 decision=accepted justification="…" D` | exit 1, `data.code: "FEA_HUMAN_GATE"`, document unchanged; `check_analysis` still `fail` | VC-FEA-62, 63 |
| AC-15 | a material whose E or allowable is gap 08 `unverified` (basis `typical`) | `compute_margins` and `check_analysis` | every affected row `unverified: true` with `unverifiedReasons[]`; `check_analysis` warning `FEA_MATERIAL_UNVERIFIED` | VC-FEA-64 |
| AC-16 | the deliberately wrong plans of VC-FEA-65 | `llull run <plan> --validate`, then the failing command | each returns the documented code and remediation of TECHNICAL_SPEC §7.1 | VC-FEA-65 |

## 8. Standards & regulatory alignment

| Reference | Use in llull | Status of what is claimed |
| --------- | ------------ | ------------------------- |
| 14 CFR 25.303 Factor of safety [R1] | Default FoS 1.5 on limit loads. No extra factor on loads given as ultimate. | Text checked through search results that quote eCFR/LII. A direct eCFR fetch was blocked. |
| 14 CFR 25.301 / 25.305 [R2] | Load case categories (`limit` / `ultimate`). Report wording: limit means no detrimental permanent deformation (yield MS), and ultimate means no failure for 3 s (ultimate MS). | Search-verified (GPO CFR 2010 PDFs). |
| EASA CS 25.303 / 25.305 [R4] | The same factor, cited for EASA users. The paragraph text was not seen, so llull cites the CS paragraph numbers only. | Catalogue only. |
| NASA-STD-5001B [R3], NASA-HDBK-5026 [R6] | MS equation, separate yield and ultimate factors, positive MS required. | Search-verified (standards.nasa.gov PDFs). |
| NAFEMS Standard Benchmarks TNSB Rev. 3 (1990) | LE1 and LE10 verification targets. | Paid document. Values come from vendor manuals and FeenoX [R40]–[R45]. |
| Nastran bulk data (MSC/Simcenter QRG) | BDF field layouts. | Layouts taken from pyNastran [R14] and Altair [R14a]. Checking against an official QRG is an open item. |
| CalculiX / ABAQUS input conventions [R30] | INP writer and FRD reader. | Verified in the manual and test suite at a pinned commit. |
| Verdict quality metrics [R12] | Quality metrics and acceptable ranges. | Verified (Sandia sources). |

llull does **not** claim certification credit. Reports carry "for design / pre-sizing; not a certified stress
report" until a customer qualifies the toolchain, and that includes tool qualification of the solver and mesher versions.

## 9. KPIs / success metrics

| KPI | Target | How measured |
| --- | ------ | ------------ |
| Benchmarks passing | 100 % of VC-FEA-10…14, 30, 31, 40–43 within tolerance on the desktop OCC build | `npm run quality:fea` |
| Time from a finished part to the first MS table (bracket, about 20k-node tet10) | ≤ 5 min of agent wall time from plan to `compute_margins --json`, ≤ 60 s of compute | Agent driver script plus the VC-FEA-53 timer |
| Deck acceptance | 0 manual edits needed to load the BDF/INP in pyNastran / CalculiX | VC-FEA-15 |
| Reproducibility | Same plan gives the same mesh hash and the same deck sha256 on the same platform and versions | VC-FEA-06, 51 |
| Agent usability | A CLI/MCP agent finishes US-1 and US-6 with no human input except the human gates in ≥ 9 of 10 scripted runs | Agent driver (`docs/PRODUCTION_GATE.md`, AF-23) |
| Silent safety values | 0 factors, allowables or thresholds used without a named source or explicit value | VC-FEA-60 |
| Unflagged margins | 0 margin rows without `reviewRequired`; 0 agent-completed dispositions | VC-FEA-61, 63 |
| Stale-result leaks | 0 margins computed on stale results | VC-FEA-50 plus a production-gate scenario |

## 10. Risks & assumptions

| Risk / assumption | Impact | Mitigation |
| ----------------- | ------ | ---------- |
| GPL licensing of Gmsh [R10] and CalculiX [R30] inside a desktop installer | Legal | Separate executables or processes with no linking. Ship the licences and source. Netgen (LGPL) [R11] as the alternative mesher. Needs a legal decision (TECHNICAL_SPEC §11). |
| A general midsurface is unsolved for arbitrary solids. Junctions and variable thickness are hard | Users trust bad shells | MVP limits it to constant-thickness face-pairs with a coverage report and visual check. Unpaired regions block shell export unless the user accepts them. |
| Face mapping between the llull B-rep and Gmsh after the STEP round-trip | Loads land on the wrong faces | Match by centroid, area and normal with a tolerance. Ambiguity is an error and nothing is guessed (TR-FEA-32). |
| Users read nodal-averaged FRD stresses at singularities (re-entrant corners, point loads) as real | Non-conservative or over-conservative MS | Report singularity warnings (point loads, sharp re-entrant edges). Element (integration point) stresses are available. Documentation. |
| Nastran field formats differ across vendors | Rejected decks | Small-field fixed format, the conservative card subset, a pyNastran check, and an optional run in MYSTRAN. |
| Large meshes bloat the document | Slow save and sync | The mesh and full results live in a content-addressed sidecar cache. The document stores the controls, hashes and summaries (TR-FEA-05). |
| Assumption: the bundled CPython can carry the `gmsh` wheel (about 40 MB) [R10] | Installer size | Accepted, as for CadQuery (KI6). |
| Assumption: CalculiX can be built or obtained for Windows, macOS and Linux | Desktop availability | `desktop/scripts/prepare-ccx.mjs`. Open question on build provenance (§11 TS). |

## 11. References

- [R1] 14 CFR §25.303 Factor of safety — US eCFR / FAA — https://www.ecfr.gov/current/title-14/chapter-I/subchapter-C/part-25/subpart-C/subject-group-ECFR6dd5e5c4b86d1bc/section-25.303 (accessed 2026-10; text via search, fetch blocked)
- [R2] 14 CFR §25.301 Loads; §25.305 Strength and deformation — GPO CFR 2010 — https://www.gpo.gov/fdsys/pkg/CFR-2010-title14-vol1/pdf/CFR-2010-title14-vol1-sec25-301.pdf ; https://www.govinfo.gov/content/pkg/CFR-2010-title14-vol1/pdf/CFR-2010-title14-vol1-sec25-305.pdf (accessed 2026-10, search)
- [R3] NASA-STD-5001B Structural Design and Test Factors of Safety for Spaceflight Hardware — NASA — https://standards.nasa.gov/sites/default/files/standards/NASA/B-w/CHANGE-3/3/2022-10-24-NASA-STD-5001B-w-Change-3-Approved.pdf (accessed 2026-10, search)
- [R4] EASA Easy Access Rules for Large Aeroplanes (CS-25) — EASA — https://www.easa.europa.eu/en/document-library/easy-access-rules/online-publications/easy-access-rules-large-aeroplanes-cs-25 (accessed 2026-10; catalogue only)
- [R5] NASA NTRS 20150003482 (history of the 1.5 factor of safety) — NASA — https://ntrs.nasa.gov/api/citations/20150003482/downloads/20150003482.pdf (accessed 2026-10, search)
- [R6] NASA-HDBK-5026 — NASA — https://standards.nasa.gov/sites/default/files/standards/NASA/Baseline/0/NASA-HDBK-5026-Final-8-12-2024.pdf (accessed 2026-10, search)
- [R10] Gmsh 4.15.2 (PyPI wheel, LICENSE, API) — Geuzaine & Remacle — https://pypi.org/project/gmsh/4.15.2/ (accessed 2026-10)
- [R11] Netgen — NGSolve — https://github.com/NGSolve/netgen (accessed 2026-10)
- [R12] The Verdict Library Reference Manual SAND2007-2853 — Sandia — https://github.com/sandialabs/verdict (accessed 2026-10)
- [R13] meshio — https://github.com/nschloe/meshio (accessed 2026-10)
- [R14] pyNastran — https://github.com/SteveDoyle2/pyNastran (accessed 2026-10); [R14a] Altair OptiStruct CQUAD4 reference — https://help.altair.com/hwsolvers/os/topics/solvers/os/cquad4_bulk_r.htm (search)
- [R15] FreeCAD FEM workbench sources — https://github.com/FreeCAD/FreeCAD/tree/4a1904f8db57d4a31e44cdb1dd984d4c98447c10/src/Mod/Fem (accessed 2026-10)
- [R20] Clamped-free beam characteristic equation — arXiv 2010.04037, 2303.18126 — https://arxiv.org/pdf/2010.04037 (accessed 2026-10, search)
- [R21] Kirsch solution, Kt = 3 — Brown Univ. EN0175 notes — https://www.brown.edu/Departments/Engineering/Courses/En175/Lecture%20Notes%202006/EN0175-20.pdf (accessed 2026-10, search)
- [R22] NACA TN 3781 Handbook of Structural Stability Part I: Buckling of Flat Plates — NTRS — https://ntrs.nasa.gov/citations/19930084505 (accessed 2026-10, record)
- [R30] CalculiX (source, manual, test suite) — G. Dhondt — https://github.com/Dhondtguido/CalculiX/tree/fd588701edd6a92fde06e99b1bdf01f3b0f80f2c (accessed 2026-10)
- [R31] NASTRAN-95 — NASA — https://github.com/nasa/NASTRAN-95 (accessed 2026-10)
- [R40]–[R45] NAFEMS LE1/LE10 reproductions: Abaqus Benchmarks 4.2.1 / 4.2.10, COMSOL, Altair OS-V:0010 / 0060, FeenoX — URLs in [`validation/sources.md`](validation/sources.md) (accessed 2026-10)
- L1 llull architecture laws and decisions — `.claude/rules/architecture.md`, `docs/decisions/KI5-shape-kernel-boundary.md`, `docs/decisions/KI6-desktop-app-cli-first.md`
