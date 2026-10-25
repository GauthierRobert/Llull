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

- 2026-10-25 — main: 02 RTE-V2 merged (cad-reviewer APPROVE after 3 rounds): `route_problem` obstacles from the V1 clash bodies
  (geometry-only problem hash), first-move candidate searches in parallel (rayon) in `llull-route` with a total expansion ceiling,
  `auto_route_lines` + `route_lines_order` (ordering + retry, all-or-nothing, ids by request position) and `llull auto_route lines=`,
  hand edits drop the auto-route record (TECHNICAL_SPEC §13.12). Gates: static, unit 16486 (10 sequential shards: one worker runs out
  of RAM here), server 1672; coverage skipped on owner's call. Next: Wave 3 (05 ISO, 08 DAT, 04 PID).

- 2026-10-24 — main: 02 RTE-V1c merged (cad-reviewer APPROVE after 2 rounds): run level from elevation, orphan supports reported
  and regenerated (live = load), `export_pipe_step` elbows as true tori (native OCCT server test), `convert_pipe_run replace` moves
  supports (TECHNICAL_SPEC §13.11). Gates green: static, unit 16443, server 1605, coverage 97.3 / 89.3 / 98.9 / 98.9 (1 worker).
  Next: RTE-V2.

- 2026-10-24 — main: 02 RTE-V1 part 2 merged (cad-reviewer APPROVE, 1 round): supports on runs through one carrier lookup
  (`pipeCarrier.ts`, every support consumer), re-snap + re-attach after plant edits, `set_heat_tracing`, `line_heat_loss`,
  `export_pcf`, `export_ifc` with plant runs + ports, `export_pipe_step` (kernel) (TECHNICAL_SPEC §13.10, SC-RTE-16..21). Gates green
  on the merge with DES-3b / DES-4b: static, unit 16365, server 1604, coverage 97.3 / 89.2 / 99.0 / 98.9 (1 worker). Next: RTE-V1c.
- 2026-10-24 — main: 02 RTE-V1 part 1 merged (cad-reviewer APPROVE, 1 round + 2 non-blocking fixes): socket-weld / threaded
  engagement, eccentric reducers (flat side, centreline offset), trimmed elbows + pipe bends, valve operators + `RTE_VALVE_OPERATOR_CLASH`,
  clash bodies for valves / flanges / tees / olets / reducers, slope-preserving stretch (TECHNICAL_SPEC §13.9, SC-RTE-10..15).
  Gates green: static, unit 15963, server 1571, coverage 97.3 / 89.2 / 99.0 / 99.0 (1 worker). Next: RTE-V1 part 2.
- 2026-10-24 — main: 02 RTE-M3 merged (cad-reviewer APPROVE after 3 rounds): orthogonal stretch on nozzle / equipment moves,
  `edit_route` (move / stretch / insert / delete PI, remaps inline + branch + slope legs), sloped legs + adverse / pocket / flat checks,
  insulation from the spec (`edit_pipe_spec` insulation rows) + envelope in `check_clashes` (new clash-source registry, core
  `CadPlugin.onInstall`), `set_piping_settings` line-number template. Gates green: static, unit 15847, server 1571, coverage
  97.3 / 89.2 / 99.0 / 99.0 (1 worker). Next: 02 RTE-V1.
- 2026-10-24 — main: 02 RTE-M2 merged (cad-reviewer APPROVE after 4 rounds): inline valves + reducers, branches (tee / reducing tee /
  weldolet / stub-in), `check_piping`, `piping_connectivity`, `convert_pipe_run`, `update_pipeline`, `delete_pipe_run` cascade; frozen
  derivation memo keyed on the slices it reads (200-branch header ≈ 0.1 s). Gates green: static, unit 15715, server 1571 (1 worker).
  Next: 02 RTE-M3.
- 2026-10-24 — main: 02 RTE-M1 merged (cad-reviewer APPROVE after 3 rounds): `route_pipe` (legs, spec elbows, cut lengths, flange sets),
  `piping_takeoff`, broken runs, core `DocumentExtension.reconcile` (live, nested, replay); fix: derived-model restore keeps the saved
  entity key order. Gates green: static, unit 15499, server 1571 (1 worker). Next: 02 RTE-M2.
- 2026-10-24 — main: plant M2 merged (3 lanes, cad-reviewer fixes in): 01 PSC-M2 specs + resolution, 03 EQP-M2 vessels / nozzles / ports,
  core exact `ellipse` curve segment (native OCC + exact Pappus volumes). Gates green: static, unit 15222, coverage, server 1558 (with an
  ellipse-capable `llull-kernel`). Test workers now sized from free memory. Next: wave 2, 02 RTE-M1.
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
- `[TODO]` **RS follow-ups** (RS wave PR #98 and RS-6 llull-geomq done) RS-6 options (wgpu BVH traversal for geomq, plant 09 instance BVH / VC-VIS-60 (a), physics 13 broad phase VC-COR-17); plant 10 M3 viewport, plant 02 V1 (route\*pipe, fittings, check*piping), PHY-09 M4/M5, AER 3D panel, PHY-19 hand-off (OpenCourant); physics 19 options outside RS-8 (rounded shell edges in contact §29.8.3, shell thickness change §29.8.2; §13.10). \_deps: —*
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

- `[TODO]` **DES-2c** 02 SWG left after M0–M8 (done 2026-10-23, §13–§14) + code export of sweeps / lofts (done 2026-10-25, §15):
  frames overlay (UI), `ShapeRecipe` node `sheetSolid` (faces still in the leaf payload), `volumeConsistencyRel`, hollow round sections with laws,
  exact-curve `inspect_sweep` curvature, closed-loft drift distribution (single re-seam today), VC-SWG-32 table. _Lane 1 + 2_ _deps: —_
- `[TODO]` **DES-6c** 06 BLD left after M0–M1 + restricted M2 / M4 (done 2026-10-23, TECHNICAL_SPEC §13.5–13.9): M3 `corners` / setback
  - `BLD_SETBACK_TOO_SHORT`, 4+-edge vertices, vertex names, VC-12/13; M2 G1 corner refill, profiles on curved faces / edges, variable-size
    profiles; M4 curved / multi-face sets, `radiusEnd` / `law` / `width` on `fillet_faces`, cliff edges; M5; `llull guide` Blends; VC-26 run on
    CPython/OCP; true straight laws (OCCT 7.9.2 `Add(Law_Function)` crashes → graded nodes). _Lane 1 + native_ _deps: —_
- `[TODO]` **DES-7c** 07 MSH left after M0–M5 (done 2026-10-23, TECHNICAL*SPEC §13.5): M6 `quad_remesh` (QuadriFlow), `fit_subdivision_to_mesh`,
  `fit_surface_to_mesh`, VC-22; native analyze / remesh / cut / fill / repair / sculpt + `--progress` events, async mesh engine port (backend blocks
  today, capped by `LLULL_MESH_OP_TIMEOUT_S`), native decimate speed (16.6 s vs 10 s target on 1.3M tris); `sculpt_mesh` `along`; asset full-res reads
  through groups / selection (`readsMeshTriangles` sees named ids only); `shrinkwrap_mesh` / `displace_mesh`. \_Lane 1 + 4 + native* _deps: —_
- `[TODO]` **DES-1c** 01 DEF left after M0–M3 + M5 + `flow_on_surface` (done 2026-10-24, TECHNICAL*SPEC §14): `preserveAnalytic` (VC-23), M4 UI
  overlays + curved-sheet base for `flow_on_surface`, B-spline lattices / oriented boxes, `baseCurve`, `infinite` regions, `allowMeshFallback`,
  `compareTo` shapes, non-uniform fit grid (point push 5–8 s), native `faceQuery.bspline`, VC-22 STEP re-import, mass rule by face type
  (`refined_mass` is provenance today, not through `blend_union`). \_Lane 1 + 2 + native* _deps: —_
- `[TODO]` **DES-3c** 03 WRP left after M0–M5 (done 2026-10-24, TECHNICAL_SPEC §14): freeform (B-spline) face charts + emboss, helical
  (diagonal / diamond) modeled knurl, knurl as AP242 PMI, CFF `seac` / arithmetic / CFF2 variable fonts, multi-face wraps (VC-36), pull walls
  - draft (VC-25/26), silhouette split, STEP round trip of an embossed solid (VC-32), llull guide WRP section (AF-03), UI render overlays
    for the new entities. _Lane 1 + native_ _deps: —_
- `[TODO]` **DES-4c** 04 DIR left after M0–M6 core + UI (done 2026-10-24, TECHNICAL\*SPEC §14): desktop-app hands-on pass on face handles / pole
  drags / loop-cut drag / gizmo (draft sign and faceNear vs the native kernel), handles for curved faces and feature moves (hole / boss), multi-pole
  selection + falloff drag, chip layout, bench (VC-18) + 200-face preview timing, true G1 patches, bevel across vertex chains, OCC reason in
  `DIR_FACE_MOVE_FAILED`, `render_view overlay=cage|net`, M7. _Lane 2 + 1 + native_ _deps: —_
- `[TODO]` **DES-5c** 05 IMP left after M0–M6 (M4–M6 done 2026-10-25, §14.7): surface-UV cell maps + maps for strut lattices;
  scalar kinds `topology_density` / `fea_result` (VC-IMP-29); numerical homogenisation on `llull-voxfe`; BVH for explicit strut sets (lift the
  5000-beam cap, faster Voronoi realise); native `gradient` + native dual contouring + per-cell DC fallback; 3MF file sink (export above the
  ~8M-triangle base64 ceiling); GPU preview; `llull guide` implicit section; a plain field reading a body restored as a coarse proxy (no asset store) still evaluates the proxy. _Lane 1 + native_ _deps: —_

## Aerospace + physics (spec = the linked pack)

- `[TODO]` **AERO-6** Left after AERO-4/5 (each in its spec §13): CAx-IF composite conformance with a second CAD system / CAx-IF test files, JT (deferred by
  spec), QIF beyond MeasurementResults, EN 9300 LOTAR conformance (paid standard not read), PMI on
  edge/vertex-referenced dimensions (217/260), composite frames + datum targets in the AP242 transport, Windows Hello/TPM key for the PLM trust root; AP242 writer (OCC): same datum
  label on two products resolves to the first product, frame B|A written in datum order A|B, SFA ST-Developer warnings (attribute count, select type,
  external mapping) unexamined (03 §13.5). _deps: —_
- `[REVIEW]` **KRN-MSVC** (needs verification) llull-kernel builds with MSVC (VS Build Tools 17.14; merged 2026-10-21, commits 40353cf6 + 200bd473; dlltool stand-in removed = RS-MSVC done).
  Verified on MSVC: `native:check`, NIST PMI suites 41/41, CMP live-OCC cone pick (06 §13.4, new native test), GPU raster 3/3. Fixed: STEP-side PMI
  tolerances now pair with XCAF ones on the same faces first (stc*07 gave 23 instead of 22 on MSVC). \_Still to verify (runs killed by low memory):
  full `LLULL_REQUIRE_NATIVE_KERNEL=1 npm --prefix server test`, `npm run check`, FE face map TR-FEA-32 (05 §13).* _deps: —_
- `[TODO]` **VNV-M3** Convergence studies + `check_verification`: `docs/physics/00-vv-harness/`. _deps: FEA artifact store, AERO-4 (09 PLM signing) — both built_
- `[TODO]` **VNV-M4** Time-step/order refinement, least-squares order, UI: `docs/physics/00-vv-harness/`. _deps: VNV-M3_
- `[BLOCKED]` **PROP-M6** Seed NIST property library: `docs/physics/01-property-models/` (OQ-PROP-03, needs trc.nist.gov access). _deps: —_
- Plant packs `docs/plant/` (order = README "Dependencies and recommended order"; D1 fixed, D2 decided 2026-10-23). Wave 1 done 2026-10-23 (PSC M0–M1, EQP M1, STA M1, VIS-M1; as built = each pack's TECHNICAL_SPEC §13 / 09 §12.6).
- Decisions 2026-10-23 (owner delegated): README D3, D4, D6; 01 §11; 03 §11.1 (Q1 extend `EquipmentElement`, Q2 both conventions `north_cw` default, Q3 exact ellipse segment, Q7 PSC flanges).
- `[DONE]` **PSC-M2** 01 PSC spec model, `*_pipe_spec`, `resolve_spec_component`, `resolve_branch`, `check_pipe_spec` + D4 licence flag `open-data` (resolution API `resolveComponent` / `resolveBranch`). Approval, assign and the stud rule stay M3/M4. Merged 2026-10-24.
- `[DONE]` **EQP-M2** 03 EQP vessels + nozzles (`add_vessel`, `add_process_column` (`add_column` was taken), `add_nozzle` angle + free forms, ports `equipmentPorts`, `equipment_ports`, `update_equipment_parameters`, `vessel_volume` by equipment). Merged 2026-10-24. Open: 03 Q4, Q6.
- `[DONE]` **EQP-Q3** exact `ellipse` `CurveSegment` (core model, Manifold, closed-form volume exact for arcs / Béziers too, native OCC chain code 3). Merged 2026-10-24. _Rebuild `llull-kernel` (`solver/`) in each checkout: older binaries answer `NATIVE_OCC_FAILURE: chain: unknown segment`._
- Test memory (2026-10-24): vitest workers sized from free memory in both suites (`testWorkers.ts`, `LLULL_TEST_WORKERS` override); gates green on the merge: static, unit 15222, coverage, server 1558.
- `[TODO]` **STA-M2/M3** 06 STA gratings, then `add_railing` (edge coverage by railings). _deps: —_
- `[TODO]` **VIS-M2** 09 review model rest (section boxes, markups, comments, `check_review`). _deps: —_
- `[DONE]` Wave 2: **RTE-M1** 02 `route_pipe` (legs, closing leg), `SpecLookup` over PSC, `PortSource` (tie-ins, nozzles, run ends), elbows, BW + flanged ends, cut-back, `piping_takeoff`, display geometry, broken runs + `reconcile`; sc-rte plans to the D3 `add_nozzle` form.
- `[DONE]` **RTE-M2** 02 flange sets + connection rules, inline components, reducers, branches (tee / olet / stub-in), `check_piping`, `piping_connectivity`, `convert_pipe_run`, `update_pipeline` (TECHNICAL_SPEC §13.7; weldolet dimension A still a declared stub input).
- `[DONE]` **RTE-M3** 02 stretch on equipment / nozzle edits, `edit_route`, slope + adverse slope + pockets, insulation envelope in `check_clashes`, line-number template (TECHNICAL_SPEC §13.8). Supports on runs moved to V1 (one carrier lookup across the ~10 building-pipe consumers).
- `[DONE]` **RTE-V1a** 02 V1 part 1: socket / threaded engagement, eccentric reducers, trimmed elbows / bends, valve operators (+ operator clash), clash bodies for valves / flanges / tees, slope-preserving stretch (§13.9). Merged 2026-10-24. Open (§13.9): connection rules + socket gap in the PSC format, sourced SW / threaded / eccentric / operator rows in the bundled catalogue, couplings / unions / caps / swages, a move across a sloped leg's heading.
- `[DONE]` **RTE-V1b** 02 V1 part 2: supports on runs (one carrier lookup), heat tracing, `line_heat_loss`, `export_pcf` (05 extends it), IFC runs + ports (IFC4), `export_pipe_step` (§13.10). Merged 2026-10-24.
- `[DONE]` **RTE-V1c** 02 V1 review follow-ups (§13.11): a run's level from its elevation, orphan supports (live = load, `RTE_SUPPORT_ORPHAN`), native OCCT `export_pipe_step` test (true torus elbows), `convert_pipe_run replace` retargets supports. Merged 2026-10-24. Open: UI support tool picks a run (`runId`, viewport lane).
- `[DONE]` **RTE-V2** 02 V2 finish (§13.12): obstacles from clash bodies, rayon candidates, `auto_route_lines`, edits drop `autoRoute`. Merged 2026-10-25. Open (§13.12): orthogonal visibility graphs [S33], a second-move candidate split, branch off a header in one transaction, 100 m reference-machine time; coverage gate not run on V2. _deps: PSC-M2, EQP-M2 (done)_ · Wave 3: 05 ISO, 08 DAT, 04 PID · Wave 4: 07 PST, 10 SCN.

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
