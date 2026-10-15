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
   CalculiX process solves it [R30]. Results come back as contours, deformed shapes and mode shapes, and margins of safety are computed.
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

| Persona | Role | Main need |
| ------- | ---- | --------- |
| P1 Design engineer (tier-1/2 supplier) | Designs machined fittings and sheet-metal brackets in llull | A quick check that a part has positive margins before release, and a clean deck for the customer's stress office |
| P2 Stress engineer (OEM or supplier) | Owns the certified analysis in Nastran | A BDF that is correct, with traceable materials, loads and BCs and stable ids, and results that can come back for review |
| P3 University / CubeSat team | Small budget, no commercial licences | A fully offline, open loop: model, mesh, solve, margins |
| P4 MRO repair engineer | Designs doublers and repairs | Fast linear static checks of local reinforcements, and modal checks of panels |
| P5 AI agent (Claude Code through the CLI, MCP in the cloud) | Automates trade studies | A deterministic command vocabulary: set up, mesh, solve and report margins as JSON |

User stories:

- **US-1 (P1).** As a design engineer, I assign "Al 7075-T7351 (allowables from MAT)" to a bracket, fix its bolt holes,
  apply a 2 kN limit load on the lug face, and get an MS table at FoS 1.5. When the MS is negative, it shows which
  region fails.
- **US-2 (P2).** As a stress engineer, I receive a BDF with one PSOLID/PSHELL per part, MAT1 cards that carry the material name in
  comments, SPC1 sets named after the llull constraint names, and FORCE/PLOAD4 cards per load case. It loads in my
  pre-processor without edits.
- **US-3 (P1/P4).** As a designer of a thin sheet-metal clip, I idealize it as a shell on its midsurface with its
  thickness, so the mesh has a few hundred quads instead of a 3D tet mesh through a 1 mm thickness.
- **US-4 (P3).** As a student, I run modal and buckling analyses of a panel offline and compare them with the analytic plate
  buckling formula shown next to the result.
- **US-5 (P5).** As an AI agent, I run `llull --app plan.json`, then `llull fea mesh`, `llull fea solve` and `llull fea margins --json`,
  and get back min MS, its location and the load case. When I change a parameter, I see the results marked stale.
- **US-6 (P2).** As a stress engineer, I import an OP2 or FRD from my own run and review von Mises and displacement contours
  on the llull model, with the design revision recorded.
- **US-7 (all).** As a user, I want defeaturing (small holes, fillets, chamfers) to apply only to the analysis
  geometry, never to the design.

## 4. Scope / out of scope

| Phase | In scope |
| ----- | -------- |
| **MVP (M1–M4)** | Elastic material data and allowables links. Analysis cases (linear static, modal, linear buckling). Solid and plane-stress idealization. Constraints and loads on exact faces/edges/points with `*Near` targeting. Gmsh tet4/tet10 and tri/quad (2D) meshing with size controls. Verdict quality report and gate. CalculiX INP export and bundled solve on desktop. FRD import. Contours of von Mises, displacement and components, deformed shape, mode shapes. MS table at FoS 1.5. Stale-result tracking. Validation: NAFEMS LE1/LE10, analytic beams, CalculiX test decks. |
| **V1 (M5–M6)** | Nastran BDF export (SOL 101/103/105). OP2 import through pyNastran. VTU export through meshio. Shell idealization with automatic midsurface for constant-thickness parts (face-pairs: planar plus coaxial cylindrical). Defeaturing of holes, fillets and chamfers by size. Distributed couplings (RBE3-style) for remote loads and moments. Analytic quick checks (beam, SS plate buckling, Kt). Netgen as an alternative mesher. |
| **V2** | Beam idealization of stringers and frames (CBAR/CBEAM, B31/B32). Composite shells (PCOMP from gap 06 CMP). Contact and bolted joints (linear, tied). Variable-thickness midsurface. Submodelling. Fatigue and damage tolerance hooks (stress spectra export). Running a user-installed Nastran or MYSTRAN. |
| **Out of scope** | Writing a new FE solver in TypeScript (llull hosts and drives solvers). Nonlinear plasticity or explicit dynamics workflows. CFD and aeroelasticity. Certification sign-off (llull computes, and humans approve). Thermal analysis (possible later through CalculiX `*HEAT TRANSFER`). |

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-FEA-01 | MUST | A document holds one or more **analysis cases**. Each has a type (`static`, `modal`, `buckling`), a solver (`calculix`, `nastran`), a unit system, a factor set, load cases, and mesh controls. All of it is created and edited by commands, replays, and saves with the document. | L1/L4/L8: analysis set-up is design data and must be traceable to the revision | L1 |
| FR-FEA-02 | MUST | Materials carry **elastic constants**: E and ν, with G derived or explicit. Density is reused, and ν ∈ (−1, 0.5) and E > 0 are validated. | MAT1 needs E, G, ν and ρ, and CalculiX `*ELASTIC` needs E and ν | [R14], [R30] |
| FR-FEA-03 | MUST | Materials can reference **allowables** (Ftu, Fty, Fsu, Fcy, plus a basis label such as A, B or S) from gap 08 MAT or entered explicitly with a source note. MS uses them. | MS needs allowables, and their provenance must be visible | [R3] |
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
| FR-FEA-17 | MUST | **Results visualization**: contours of von Mises, displacement magnitude and components, and principal stress (V1). Deformed shape with a scale factor, animated mode shapes, a legend with min/max and units, probes at points, and the location of the maximum. | Core of result review | — |
| FR-FEA-18 | MUST | A **margin-of-safety table**: MS = allowable / (applied_limit × FoS) − 1. FoS is 1.5 by default and configurable, with an optional extra-factor list and justifications. The table is per part, per region and per load case. MS < 0 is flagged FAIL, and the table exports as JSON, CSV or a sheet table. | 14 CFR 25.303 and NASA-STD-5001B | [R1], [R3] |
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

## 6. Workflows

### 6.1 UI (desktop)

1. Model or open the part. **Analysis ▸ New analysis** (type, solver, units) runs `create_analysis`.
2. Pick or create a material with elastic constants and allowables (`create_material` with `elastic`; gap 08 libraries). Assign it.
3. **Idealize**: solid by default. Choose shell to get `extract_midsurface` with a thickness preview and coverage
   heatmap, or plane stress to pick the source face.
4. **Constraints / Loads** panels: pick faces in the viewport. The panel records click points as `facesNear`
   and dispatches `add_fea_constraint` or `add_fea_load` with a load case and its limit/ultimate tag.
5. **Mesh**: set the size, order and local refinements (`set_mesh_controls`), then press **Mesh**. The desktop runs Gmsh in the bundled
   Python. A progress bar is shown, the result is stored through `record_fe_mesh`, and the quality panel shows histograms and
   offending elements, highlighted.
6. **Solve**: CalculiX runs as a child process with a live log, then the results are imported (`record_fea_results`).
7. **Results**: choose the field, deformation scale and mode number (`set_result_view`). Probes and max markers are shown. Analytic check
   cards appear when the model matches a template.
8. **Margins**: a table per part and load case with FoS 1.5, and FAIL rows highlighted. Export to CSV/JSON or place on a sheet.
9. **Export deck**: INP or BDF (`export_solver_deck`) for the stress office.

### 6.2 CLI (`llull`, local agent: KI6)

```bash
llull --app build plan.json                 # geometry + analysis set-up (build_project)
llull --app fea mesh --analysis an-1        # Gmsh in bundled Python -> record_fe_mesh
llull --app fea quality --analysis an-1 --json
llull --app fea solve --analysis an-1       # bundled ccx -> record_fea_results
llull --app fea margins --analysis an-1 --json   # {minMS, part, region, loadCase, rows[]}
llull --app fea export --analysis an-1 --format bdf --out bracket.bdf
llull --doc part.llull fea import --analysis an-1 --frd run.frd
```

### 6.3 MCP agent (cloud)

1. `build_project` with the plan (geometry plus `create_analysis` … `set_mesh_controls`).
2. `fea_mesh` and `fea_solve` are transport tools on the server, available only when the deployment provides Gmsh/ccx
   (otherwise they answer how to enable them, as `import_step` does today).
3. `compute_margins` (read-only) returns JSON, and `export_solver_deck` returns the deck text or writes it into the exchange
   directory.
4. The agent edits a parameter (`set_parameter`). The results become `stale`, and the agent loops back to `fea_mesh`.

### 6.4 Surface matrix (FR-FEA-23)

| Capability | UI | CLI | MCP (cloud) | Notes |
| ---------- | -- | --- | ----------- | ----- |
| Analysis set-up (cases, materials, idealization, BCs, loads, mesh controls) | panels | `build` plans / `llull cmd` | registry tools (toolset `analysis`) | pure commands, replayable |
| Midsurface preview / defeature | yes | yes | yes | OCC kernel needed. Manifold gives an explanatory no-op |
| Mesh (Gmsh) | Mesh button | `fea mesh` | `fea_mesh` when the host has Python + gmsh | external process |
| Quality report | histogram panel | `fea quality --json` | `fea_report` | read-only |
| Solve (CalculiX) | Solve button | `fea solve` | `fea_solve` when the host has `ccx` | desktop default. Server needs opt-in |
| Results field / probes | overlay | `fea report`, `fea field` | `fea_result_field`, `fea_report` | display state through `set_result_view` |
| Margins | table plus sheet placement | `fea margins --json` | `compute_margins` | refuses stale results |
| Deck export INP / BDF / VTU | Export menu | `fea export` | `fea_export` (exchange dir) | byte-identical across surfaces |
| External results import FRD / OP2 | File ▸ Import results | `fea import` | `fea_import_results` | needs a mesh match, otherwise review-only |

### 6.5 Error and edge behaviour

| Situation | Behaviour | FR |
| --------- | --------- | -- |
| A target point matches no face or two faces equally | The command is rejected (no-op) with a summary naming the target and the candidate faces | FR-FEA-07 |
| A target face disappears after a parametric edit | The constraint or load is kept but flagged `unresolved`. Mesh and solve are refused until the user fixes it | FR-FEA-07, 22 |
| Material has no `elastic` | Mesh is allowed. Solve and export are refused, naming the part and material | FR-FEA-02 |
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

| # | Given | When | Then | VC |
| - | ----- | ---- | ---- | -- |
| AC-1 | the beamp plan (1×1×8 mm steel cantilever, 9 N tip load) | it is meshed with tet10 and solved | the tip deflection is within 2 % of PL³/3EI = 0.0877714 mm | VC-FEA-10, 40 |
| AC-2 | the beamf plan | a 4-mode modal analysis runs | f1 is within 1 % of 13096.7 Hz (Euler-Bernoulli) and of the CalculiX reference 13096.03 Hz | VC-FEA-11, 41 |
| AC-3 | NAFEMS LE1 set up in llull | it is solved with quadratic plane-stress elements | σyy(D) is within 2 % of 92.7 MPa | VC-FEA-30 |
| AC-4 | NAFEMS LE10 set up in llull | it is solved with tet10 refined at D | σyy(D) is within 3 % of −5.38 MPa | VC-FEA-31 |
| AC-5 | allowable/limit pairs (450/300, 450/200, 300/200, 280/200 MPa) at FoS 1.5 | `compute_margins` runs | MS = 0, 0.5, 0, −0.0667, and the last row is FAIL | VC-FEA-20 |
| AC-6 | a mesh containing an inverted element | the user exports a deck | the export is refused with a reason | VC-FEA-08 |
| AC-7 | an exported BDF | pyNastran reads it with cross-referencing | no error, the card counts match the mesh, and the loads sum to the applied total | VC-FEA-15 |
| AC-8 | solved results | the user changes a driving parameter | the results show stale and margins refuse to compute | VC-FEA-50 |
| AC-9 | a thin 100×60×40 box shelled to 2 mm | `extract_midsurface` runs | the midsurface area is 23 224 mm² ±0.1 % and coverage is 100 % | VC-FEA-03 |
| AC-10 | the same plan | it runs from the UI, the CLI and MCP | the decks are byte-identical | VC-FEA-51 |
| AC-11 | the quarter plate with a hole (W/d = 10) | it is solved | the peak σxx at the hole is within 5 % of 3 × the remote stress | VC-FEA-14 |
| AC-12 | the desktop installer | it is inspected | the GPL texts and source offers for Gmsh and CalculiX are present | VC-FEA-52 |

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
| Time from a finished part to the first MS table (bracket, about 20k-node tet10) | ≤ 5 min of user time, ≤ 60 s of compute | Usability test script plus the VC-FEA-53 timer |
| Deck acceptance | 0 manual edits needed to load the BDF/INP in pyNastran / CalculiX | VC-FEA-15 |
| Reproducibility | Same plan gives the same mesh hash and the same deck sha256 on the same platform and versions | VC-FEA-06, 51 |
| Agent usability | An MCP/CLI agent finishes US-5 with no human input in ≥ 9 of 10 scripted runs | Agent eval harness (`server/tests`) |
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
