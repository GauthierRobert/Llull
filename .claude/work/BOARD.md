# llull build board — open work only (state for `continue-working`)

The `continue-working` skill reads this, reconciles it with the repo, launches lane agents and writes it back. Only the
orchestrator edits it; agents never do. Detail lives in the linked spec: one line per task. Done work and history: git
(`git log -p .claude/work/BOARD.md`) and each spec's TECHNICAL_SPEC §13+ "as built".

## Conventions

- Status tokens at line start: `[TODO]` · `[WIP]` (agent on it) · `[REVIEW]` (cad-reviewer + `npm run check`) · `[BLOCKED]` (see note).
  A task is deleted from the board when it reaches `[DONE]`.
- Deps name task ids; an id no longer on the board is done. A task is eligible when it is `[TODO]` and no dep is still listed.
- Lanes own disjoint write scopes (`.claude/rules/workflow.md` W5); one task per lane at a time, up to 4 lanes + Lane 5 review.

## NOW (auto-updated by the skill)
- 2026-10-23 — main: plant wave 1 merged (4 lanes): plugins `piping-catalog` (01 PSC M0–M1, 7 commands), `plant-equipment` (03 EQP M1,
  `vessel_volume`, toolset `plant_equipment`), `plantStructures` (06 STA M1, `list_access_rules`, `check_access`), core display slice +
  plugin property port + `plant-display` (09 VIS-M1, 7 commands, cad-reviewer fixes in). Gates: static + native:check green, unit 14678
  pass (2 load-timing flakes pass alone), server 750 pass (native skipped: no native build in the integration worktree).
- 2026-10-22 — main: freeform design track specified (owner: "design anything in any shape"): `docs/design/` packs 01 DEF … 07 MSH
  (266 FR, 111 TR, 278 VC, 50 plans; all 9 baseline plans run on main). Specs only; tasks DES-1 … DES-7 below, target plans in
  `blockedPlanCommands.json`. Owner decisions per pack: `docs/design/README.md`.
- 2026-10-22 — main: PR #106 (llull-mesh) + NG1 Netgen mesher merged. Done on main, one commit each: ENG-10 (one density convention:
  add_rigid_body takes densityUnit; unverified density printed once; AF-32 flags kept), ENG-6 (inertiaKgM2, add_spring pointFrame "body",
  thrust work in the energy balance, VC-RBD-40 stop time 1.3e-5), ENG-9 (L-stair well outline; add_hole stays in `manufacturing`, `llull
  list 3d` points to it, owner), FPR-MJ (MuJoCo 3.16.0, outputs bit-identical to 3.14.0). Full unit suite 13149 pass after ENG-6; full
  `npm run check` + server suite not re-run since (memory). Open: owner to confirm llull's licence allows LGPL §6 reverse engineering of llull-mesh (NG1).
- 2026-10-21 — main: KRN-MSVC merged unverified in full (owner): llull-kernel built with MSVC, dlltool stand-in removed (RS-MSVC), PMI
  tolerance pairing by faces. Pending: full native server suite + `npm run check` + TR-FEA-32 on MSVC.
- 2026-10-21 — merge of origin/main (SC parity, RS native wave) into `feat/eng-depth`: one implementation per capability (stack-up engine = main's Philox
  bit-exact TS/native sampler with our PMI-linked contributors; IGES = our XDE import_iges / export_iges, main's import_step_exact format iges kept).
- 2026-10-21 — branch `feat/eng-depth`: DONE (reviewed, fixes merged) FEA-REST, AERO-5 (02 SRF M0–M7, 06 CMP M0–M6 incl. drape + AP242 CAx-IF set),
  MATL-M7, TMC-M4b, FPR-E, FPR-D (VC-FPR-24 passes), SOLVER-VERIFY, and AERO-4 (owner 2026-10-20): 03 GDT M1–M7 + M5n, 04 XCH M0–M5, 09 PLM M0–M6
  (signed human gate; shared server vault declined: local-only directive). Gate: 11351 unit pass, 23 env failures = main baseline, coverage
  97.1/88.6/98.8/98.8; server 656 pass (symlink EPERM only). Next: KRN-MSVC, then CFD-M1, RS-3.
- 2026-10-20 — branch `feat/sc-remaining`: SC1 closed — SC-NATIVE verified on Windows/MSVC (native oracle 114/115 + 1 known failure,
  native action-matrix baseline), SC-Q4b judges (mutation history 36.7 %, parametric 55.9 %), extrude_profile follows the sketch rotation (owner): `docs/decisions/SC1-remaining.md`.
- 2026-10-19 — branch `ccr-d5e76715-intlyp`: LC1 done (steps 1–6: native kernel default everywhere, opencascade.js retired, no outbox),
  RS-1 done (macOS bundle deferred by the owner), RS-2 done (native SIMP topology optimisation + plugin `topology` + `topology_solve` + UI panel).
  Next: CFD-M2, RS-3.

## Priority

- `[TODO]` **LIM-1 follow-ups** (LIM-1 merged, PRs #101/#102): per-face colour on parametric primitives; plan time dominated by one OCCT
  sweep boolean (13–15 s); native follow-ups in `docs/decisions/LIM1-scale.md` (JSON depth, relative display tolerance, multi-tool cut). _deps: —_
- `[TODO]` **RS follow-ups** (RS wave PR #98 and RS-6 llull-geomq done) RS-6 options (wgpu BVH traversal for geomq, plant 09 instance BVH / VC-VIS-60 (a), physics 13 broad phase VC-COR-17); plant 10 M3 viewport, plant 02 V1 (route*pipe, fittings, check_piping), PHY-09 M4/M5, AER 3D panel, PHY-19 hand-off (OpenCourant); physics 19 options outside RS-8 (rounded shell edges in contact §29.8.3, shell thickness change §29.8.2; §13.10). _deps: —_
- `[TODO]` **TOP-V1b** Topology V1 left after TOP-V1 (MMA, projection, extrusion / min member size, `min_volume`, pressure / gravity loads +
  compliance ratio, `deadlineS` checkpoint: built 2026-10-22, §15): VC-TOP-34 on a desktop GPU (GPU cap), PHY-18 shape optimisation (needs
  PHY-18 M2), unstructured SIMP on the tet mesh, displacement constraints for `min_volume`, `massG`: `docs/physics/17-topology-optimization/TECHNICAL_SPEC.md` §15.7. _deps: —_
- `[REVIEW]` **CFD-M2** (PR `feat/cfd-m2`, 2026-10-22) `llull-compute flow` (D3Q19 BGK + LES, CPU f64 reference + wgpu f32), `cfd_solve`
  transport, `record_cfd_results` / `cfd_report`: spec §13 M2. Left for **CFD-M3+**: nested grid boxes, `cfd_streamlines` / `cfd_slice` /
  `cfd_probe` / `cfd_stop`, `gridStudy`, overlay + Flow panel, AA-pattern storage, VC-CFD-21 at 32 cells per diameter on a GPU (ignored test),
  VC-CFD-13 / 23–25 / 54. _deps: —_

## SolidCraft parity (spec: `docs/decisions/SC1-solidcraft-parity.md`)

- All SC tasks done (SC-NATIVE, SC-Q4b closed 2026-10-20: `docs/decisions/SC1-remaining.md`). Follow-up idea: exact helical thread
  groove in the native kernel (oracle 106 known failure).

## Freeform design (spec = `docs/design/README.md`, order = its "Recommended order")

- `[TODO]` **DES-2c** 02 SWG left after M0–M8 (done 2026-10-23, §13–§14): CadQuery / build123d / FreeCAD lowering of sweeps + lofts,
  frames overlay (UI), `ShapeRecipe` node `sheetSolid` (faces still in the leaf payload), `volumeConsistencyRel`, hollow round sections with laws,
  exact-curve `inspect_sweep` curvature, closed-loft drift distribution (single re-seam today), VC-SWG-32 table. _Lane 1 + 2_ _deps: —_
- `[TODO]` **DES-6c** 06 BLD left after M0–M1 + restricted M2 / M4 (done 2026-10-23, TECHNICAL_SPEC §13.5–13.9): M3 `corners` / setback
  + `BLD_SETBACK_TOO_SHORT`, 4+-edge vertices, vertex names, VC-12/13; M2 G1 corner refill, profiles on curved faces / edges, variable-size
  profiles; M4 curved / multi-face sets, `radiusEnd` / `law` / `width` on `fillet_faces`, cliff edges; M5; `llull guide` Blends; VC-26 run on
  CPython/OCP; true straight laws (OCCT 7.9.2 `Add(Law_Function)` crashes → graded nodes). _Lane 1 + native_ _deps: —_
- `[TODO]` **DES-7c** 07 MSH left after M0–M5 (done 2026-10-23, TECHNICAL_SPEC §13.5): M6 `quad_remesh` (QuadriFlow), `fit_subdivision_to_mesh`,
  `fit_surface_to_mesh`, VC-22; native analyze / remesh / cut / fill / repair / sculpt + `--progress` events, async mesh engine port (backend blocks
  today, capped by `LLULL_MESH_OP_TIMEOUT_S`), native decimate speed (16.6 s vs 10 s target on 1.3M tris); `sculpt_mesh` `along`; asset full-res reads
  through groups / selection (`readsMeshTriangles` sees named ids only); `shrinkwrap_mesh` / `displace_mesh`. _Lane 1 + 4 + native_ _deps: —_
- `[TODO]` **DES-1b** 01 DEF left after M0–M1 (done 2026-10-22, §13): M2 exact OCCT warp (`deform.cxx`, capability `deform`; closes
  VC-06/08/11 and the 360° ring), M3 lattice / point / flow, M4 flow on surface + overlays, M5 curve-to-curve + morph; native B-spline
  Gauss-integration accuracy (VC-11 −4.4e-4). _Lane 1 + native_ _deps: —_
- `[TODO]` **DES-3b** 03 WRP left after M0–M3 (done 2026-10-22, §13): M4 geodesic / parametric charts, emboss on doubly curved faces,
  `split_face_by_curves`, `create_curve_on_face`, CFF fonts, kerning, multi-line, decal + knurl; M5 single-line fonts, text on curve,
  `pattern_on_face`, modeled knurl; WRP golden plan (native). _Lane 1 + native_ _deps: —_
- `[TODO]` **DES-4b** 04 DIR left after MVP (done 2026-10-23, §13: M0, M2, M3 commands + M1 cage UI and M3 UI tools): M1 B-rep drag
  handles (`push_pull_face` / `replace_face` / `draft_faces`), control-net overlays, loop-cut factor drag, desktop-app pass on cage editing
  (pointer capture, gizmo + floating origin); M4 `edit_nurbs` ops + `subdivision_to_nurbs`; M5 open cages, bridge / bevel / delete / fill /
  weld / slide; M6 `/preview`, `move_faces`, `delete_faces`; `squash_steps`; `freeform` toolset view. _Lane 2 + 1 + native_ _deps: —_
- `[TODO]` **DES-5b** 05 IMP left after M0–M3 (done 2026-10-23, §13): M4 native `llull-field` (Rust, tape format §13.3, parity §13.6) +
  `llull-compute field` + `server/src/native/fieldEngine.ts` installer (closes pack plans refused at their written voxel by the TS 2^21 grid
  budget); M5 scalar fields + graded laws, `infill_solid`, `edit_field` / `delete_field` / `regenerate_implicit_bodies`, `add_graph_lattice`,
  `section_field`, more cells / maps, 3MF beam lattice, overhang + EDT wall checks, lattice mechanics; M6 3MF implicit export, dual contouring
  (closes VC-15 mesh −1.1 %), Voronoi. _Lane 1 + native_ _deps: — (mesh asset store = DES-7b M3, adopt when built)_

## Aerospace + physics (spec = the linked pack)
- `[TODO]` **AERO-6** Left after AERO-4/5 (each in its spec §13): CAx-IF composite conformance with a second CAD system / CAx-IF test files, JT (deferred by
  spec), QIF beyond MeasurementResults, EN 9300 LOTAR conformance (paid standard not read), PMI on
  edge/vertex-referenced dimensions (217/260), composite frames + datum targets in the AP242 transport, Windows Hello/TPM key for the PLM trust root; AP242 writer (OCC): same datum
  label on two products resolves to the first product, frame B|A written in datum order A|B, SFA ST-Developer warnings (attribute count, select type,
  external mapping) unexamined (03 §13.5). _deps: —_
- `[REVIEW]` **KRN-MSVC** (needs verification) llull-kernel builds with MSVC (VS Build Tools 17.14; merged 2026-10-21, commits 40353cf6 + 200bd473; dlltool stand-in removed = RS-MSVC done).
  Verified on MSVC: `native:check`, NIST PMI suites 41/41, CMP live-OCC cone pick (06 §13.4, new native test), GPU raster 3/3. Fixed: STEP-side PMI
  tolerances now pair with XCAF ones on the same faces first (stc_07 gave 23 instead of 22 on MSVC). _Still to verify (runs killed by low memory):
  full `LLULL_REQUIRE_NATIVE_KERNEL=1 npm --prefix server test`, `npm run check`, FE face map TR-FEA-32 (05 §13)._ _deps: —_
- `[TODO]` **VNV-M3** Convergence studies + `check_verification`: `docs/physics/00-vv-harness/`. _deps: FEA artifact store, AERO-4 (09 PLM signing) — both built_
- `[TODO]` **VNV-M4** Time-step/order refinement, least-squares order, UI: `docs/physics/00-vv-harness/`. _deps: VNV-M3_
- `[BLOCKED]` **PROP-M6** Seed NIST property library: `docs/physics/01-property-models/` (OQ-PROP-03, needs trc.nist.gov access). _deps: —_
- Plant packs `docs/plant/` (order = README "Dependencies and recommended order"; D1 fixed, D2 decided 2026-10-23). Wave 1 done 2026-10-23 (PSC M0–M1, EQP M1, STA M1, VIS-M1; as built = each pack's TECHNICAL_SPEC §13 / 09 §12.6).
- Decisions 2026-10-23 (owner delegated): README D3, D4, D6; 01 §11; 03 §11.1 (Q1 extend `EquipmentElement`, Q2 both conventions `north_cw` default, Q3 exact ellipse segment, Q7 PSC flanges).
- `[WIP]` **PSC-M2** 01 PSC spec model, `*_pipe_spec`, `resolve_spec_component`, `resolve_branch`, `check_pipe_spec` + D4 licence flag `open-data`. Worktree `llull-psc`, branch `feat/plant-psc-m2`. _deps: —_
- `[WIP]` **EQP-M2** 03 EQP vessels + nozzles (`add_vessel`, `add_column`, `add_nozzle` angle + free forms, ports, `equipment_ports`, `update_equipment_parameters`, `vessel_volume` by equipment). Worktree `llull-eqp`, branch `feat/plant-eqp-m2`. _deps: —_
- `[WIP]` **EQP-Q3** exact `ellipse` `CurveSegment` (core model, Manifold, closed-form volume, native OCC). Worktree `llull-ell`, branch `feat/core-ellipse-segment`. _deps: —_
- `[TODO]` **STA-M2/M3** 06 STA gratings, then `add_railing` (edge coverage by railings). _deps: —_
- `[TODO]` **VIS-M2** 09 review model rest (section boxes, markups, comments, `check_review`). _deps: —_
- `[TODO]` Wave 2: **RTE M1–M3 then V1** 02 `route_pipe`, fittings, flanges, branches, `check_piping`, stretch on nozzle edits. _deps: PSC-M2, EQP-M2_ · Wave 3: 05 ISO, 08 DAT, 04 PID · Wave 4: 07 PST, 10 SCN.

## Engineering-audit follow-ups (detail in each line; lists kept here because they have no spec of their own)

- `[TODO]` **ENG-4** Blocked validation plans in `tests/unit/contract/blockedPlanCommands.json`; next: pack 09 frequency response, 11 creep, 19 impact, 17 topology, aero 06/03/09/02.
- `[TODO]` **ENG-5** Fatigue/fracture: FE hot-spot stress (`FAT_RESULTS_MISSING`), `fe_seam` cracks + interaction integral, `compute_k_from_fe`, retardation, surface cracks.
- `[TODO]` **ENG-10b** Natural-frequency search finds few candidates (no modal-specific command): make modal analysis discoverable.

## Product backlog (no spec yet — write one before starting)

- `[TODO]` **S3** `hatch_region` + `region` entity. _Lane 1+3_
- `[TODO]` **X3** 2D export DXF + SVG from 2D entities. _Lane 1/3_
- `[TODO]` **X4** Import SVG path → 2D profile, STL → `mesh`. _deps: X3_
- `[TODO]` **EN5** Associative dimensions + dimension styles. _Lane 1+3_
- `[TODO]` **EN6** Polyline/spline vertex editing, multi-pick offset/trim/extend. _Lane 1+3_
- `[TODO]` **EN7** Continuous measure mode + measurement report. _Lane 1+2/3_
- `[TODO]` **EN11** Layer colour/linetype/lineweight, filters, per-view overrides. _Lane 1+2_
- `[TODO]` **EN12** Export selection only, batch export, glTF/OBJ materials, DXF layers. _deps: X3_
- `[TODO]` **KI7** Typed command bindings generated from the registry (low priority). _Lane 1/4_
- `[TODO]` **P5** WebGPU renderer opt-in (only on a measured GPU bottleneck). _Lane 2_
- Lane 5, continuous: hold the coverage gate; `cad-reviewer` on every `[REVIEW]` diff.

## Open decisions

- CFD-D3 one artifact store for FEA + CFD.
- Lock policy is UI-only (core edit commands ignore locked layers) — decide for the CLI.
- 2D rotation semantics, AutoCAD mouse mapping — owner to decide.
- Beam elevation defaults differ by domain on purpose (summaries state it): keep or unify? (from ENG-9) — owner to decide.
