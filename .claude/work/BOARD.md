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

- 2026-10-30 — branch `feat/des-7d` (not yet on main): DES-7c slice 2 native `repair` + `fill_holes` (bit-identical, 4-8x at 327k / 1.3M, §13.13) and DES-7d (deforming a
  327k scan: >580 s to 1.1-2.3 s; the scan never reaches the kernel, 01 DEF §15), both after cad-reviewer round 1. Gates: check:fast, static, native:check, server 2034
  (before review fixes; slice suites re-run after), deform + golden. Also: readiness 08 XCH plans allowlisted (`export_pdf`, `load_plot_style`, `print_sheet` unbuilt:
  board note for the rot gate). Coverage not run (stopped for memory). Next: slice 3 (WIP), DES-7e.

- 2026-10-26 — main: 04 PID-M1 merged (cad-reviewer APPROVE after 3 rounds, hostile-input fuzzing of `xmlRead`): P&ID slice +
  load validation, safe XML reader. Gates: `check:fast` 17603 (all files), deadcode, format, server 1706. Coverage not run.
  Wave 3 first milestones done (ISO-M1, DAT-M1, PID-M1). Next: PID-M2 (DEXPI import).

- 2026-10-26 — main: 08 DAT-M1 merged (cad-reviewer APPROVE after 3 rounds): plant data core (hierarchy, classes, tags +
  registry, providers, properties, table, 12-rule check), tag write-back through `rename_equipment_tag` / `set_pipe_line_number`.
  Gates on the merge with DES-2c step 3: `check:fast` 17363 (all files), server 1706. Coverage not run. Next: PID-M1 (WIP).

- 2026-10-25 — main: 05 ISO-M1 merged (cad-reviewer APPROVE after 3 rounds): PCF reader / writer, network port, `import_pcf`,
  `export_pcf` (moved from 02), `delete_pcf_line`. Gates: static, unit ~16900 (10 sequential shards), server 1695 (with this tree's
  own `llull-kernel`: the main checkout's binary, rebuilt from uncommitted solver edits, fails 13 sweep tests). Coverage not run.
  Next: DAT-M1 (WIP).

- 2026-10-25 — main: 09 VIS-M2 merged (cad-reviewer APPROVE after 4 rounds, human gate hardened twice): review model, section
  boxes, markups, comments, signed issue workflow, saved views as document viewpoints. Gates on the merge with DES-2c: static, unit
  16850 (10 sequential shards), server 1694 (branch, `llull-compute` rebuilt for the DES-5b field job). Coverage not run. Next: Wave 3,
  ISO-M1 + DAT-M1 (one at a time, RAM).

- 2026-10-25 — main: 06 STA-M2/M3 merged (cad-reviewer APPROVE after 2 rounds): gratings (catalogue, support lines, NAAMM
  load / deflection check), railings (paths or host edges, gates, OSHA / ISO 14122-3 checks, edge coverage), IFC + takeoff. Gates on
  the merge with DES-5b: static, unit 16720 (10 sequential shards), server 1672 (branch). Coverage not run. Next: VIS-M2 (WIP).

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

- `[DONE]` **DES-2c** 02 SWG left after M0–M8 (done 2026-10-23, §13–§14), the code export of sweeps / lofts (done 2026-10-25, §15) and step 2 (done 2026-10-25, §16: `ShapeRecipe` node `sheetSolid`,
  `volumeConsistencyRel`, hollow round sections with laws, exact-curve `inspect_sweep` curvature, closed-loft drift distribution, VC-SWG-32 table):
  frames overlay (UI, step 3, done 2026-10-25, TECHNICAL*SPEC §17). The overlapping-solid native test is done (§16.4: the volume check cannot see an overlap; a global overlap search was added). \_Lane 1 + 2* _deps: —_
- `[TODO]` **DES-6c** 06 BLD left after M0–M1 + M2 + restricted M4 + M3 (done 2026-10-23 / 25 / 26, TECHNICAL*SPEC §13.5–13.11; solids with voids DONE 2026-10-30, §13.17; mixed convex/concave vertices DONE 2026-10-31, reflex-face corner, §13.18): M3 remainder
  (done in step 3, 2026-10-26, §13.12: concave setback corners, linear `sizeEnd` at setback corners, corner acceptance 68 ms/corner cheaper; done 2026-10-31 (13.21): the exact-boundary corner patch, a star of Hermite-Coons sub-patches named blend(v:...)#k, default, plate fallback; was: the exact-boundary corner patch that meets the default 1e-6 x diagonal G0 instead of the 5x `g0Corner` (investigated, needs n Coons/Hermite faces per corner; deferred by coordinator decision: 5e-6 x diagonal is below OCCT / STEP edge tolerances, revisit when a consumer needs 1e-6 or G2 corners are scheduled, §13.12.3), setback corners with a rolling-ball neighbour or on curved / non-straight edges, mixed convex/concave vertices, smooth / multi-station radius laws, G2 patches); M2 leftovers (§13.11.5: corners of
  curved edges / faces and of vertices with an unrounded third edge, `size2` on curved edges or with a varying size, oblique / curved ends,
  solids with voids, (chain junctions that kink above 0.0095 rad: conic fades to the circle at the junction, DONE 2026-10-31, §13.19), (corner speed: parallel fills DONE 2026-10-31, §13.20, 8-corner cube 2.1 s → 0.95 s, bit-identical on any thread count; was about 205 ms/corner on the native build after step 3, patch tessellation still adds ~60 ms/corner in the step; a failing profile corner is retried at the next setback factor, the in-loop gap limit now equals the accepted one so that is rarer)); pre-existing: two circular `fillet_edge` steps on a box read a 0.029 rad
  `BLD_CHECK_G1_ANGLE` where OCCT's step-2 B-spline blend meets the first blend (not from the profile code); M4 (step 4, 2026-10-26, §13.13: face sets of several planar / curved faces, `radiusEnd` / `law` / `width` / `startNear` on `fillet_faces` through the shared edges and their tangent chain, which must stay inside the sets; every adjacent pair uses the edge path; left: faces that do not meet other than one planar face per set with constant r, varying size over a multi-edge chain, cliff edges (undefined in the spec, refused by name)); step 5 (2026-10-26, §13.14: `check_blends` chain profiles from the kernel (`LawRecord.chain`, no angle rule), M5 built: variable chamfer (`chamfer_edge` `distanceEnd`, native ruled-loft tool) and per-joint `blend_union` radii (`joints`, `check_blends` reads blend_union joints), `llull guide` Blends section; M5 not built, with reasons: partial fillets, cliff / trim modes, G3, review overlays (UI lane), joints by name and per-joint laws; left: variable chamfer on curved edges / corners / asymmetric legs; the mitre ends of a creased chain were done in step 7, §13.14.6); step 6 (2026-10-26, §13.15: VC-BLD-26 run on CPython 3.12 + cadquery/OCP (linear law 989.985247 vs oracle 989.985248; found and fixed a codegen bug that kept the source solid next to the mesh of an inexpressible blend); true straight laws: `interpolation: "linear"` is exact Law_Linear pieces in the fillet spine (`LawFillet`/`LawSpine`, no OCCT patch; contact line 6e-15 mm, r(0.1)/r(0.25) 1e-15, was 1e-7; a kinked law is a C0 knot the fixed Gauss rule misreads, so those shapes use the adaptive mass / face-area rule (`refined_mass`); the OCP export keeps graded nodes, 3e-10 relative, with a program note, no exact route there); left: mixed straight / smooth contours are exact on the straight edges and OCCT's own spline elsewhere (slope jump at the junction), and the rest of the list above); step 7 (2026-10-26, §13.16: mitre ends in the rail builder: a conic / curvature profile on a creased tangent chain (N-gon prism rim, polyline outline; OCCT chains creases below about 0.1 rad) builds, convex and concave, 1 to 1000 mm: both end sections are taken in the bisector plane of the two section planes, faded in by a quintic so the faces stay exactly on the swept profile, and the planar support is re-trimmed to the new end points; 64-gon rim gap 4e-14 to 3e-11 mm, volume within 1.4e-7 (conic) / 3.0e-7 (curvature) of the swept-section oracle, 1.5 to 4.2 s through the server; the junction kink of a creased chain is the crease itself (0.0982 rad on a 64-gon), so the builder (planned turn, mitred junctions only) and `check_blends` (crease of the support faces, capped at 0.11 rad) judge a junction by what it adds beyond its crease (`creaseRad`); VC-BLD-48, `target_profiles_curved_variable` 33/33 became 37/37; left, refused by name: a crease of 0.1 rad or more (OCCT does not chain it), a varying size on a creased chain (OCCT cannot round it), a curved support or an asymmetric crease (not reachable natively: OCCT's own circular blend fails), and the speed of `mass_properties` / `check_blends` on a 64-sided chain (3 to 9 s: a smaller first station set for straight blends is the lever)). \_Lane 1 + native* _deps: —_
- `[TODO]` **CHK1** Speed of the exact queries on long B-spline chains: on a 64-gon rim with a conic profile (step 7, TECHNICAL*SPEC 13.16) `check_blends` takes about 9 s (about 140 ms per blend face; 6.7 s without the adaptive mass rule), `mass_properties` 3 to 4 s (1.8 to 2.8 s without it), and the curvature profile build + mass + check about 21 s (the conic 14 s); the build itself is 23 to 56 ms per blend face. The cost is per knot span and per face: every blend face has 41 stations after refinement, 24 of them the uniform first set. The lever: a smaller first station set for straight blends (the deviation test then finds a narrow feature between stations only through the refinement, so it needs a test per profile and a kink case); also `BRepBndLib::AddOptimal` in `mass_properties` bounds (sampled boxes for blend faces, as `result_diagonal` does). \_Lane 1 + native* _deps: —_
- `[TODO]` **SHP1** Subdivision edge sharpness above 3: every capped path (`settleLevels`, MAX_SETTLE_LEVELS = 3) treats the sharpness left after 3 levels as an infinite crease, while `refineOnce` (the level mesh) smooths it out: limit patches / B-spline export (`subdivisionPatches.ts`, `subd/toNurbs.ts`), `cageVertexLimits` + the surface evaluator (`evaluate_subdivision`), code export (`codegen/featureProgram.ts`). Only `fit_subdivision_to_mesh` uses the uncapped `fullSettleLevels` (07 TECHNICAL_SPEC 13.7.6). Fix: one surface definition for every path (uncapped settle within a budget, or cap the sharpness itself at 3 in the schema).
- `[TODO]` **DISP1** Scale the native display deflection with the model size: `tessellate` uses an absolute 0.1 (`mesh.rs:9`, `facade.cxx:328`, `relative=false`), so one 1000 mm blend face meshes to 260 k triangles in 7.6 s (a 100 mm one 214 ms); e.g. `max(0.1, 1e-4 x bbox diagonal)`, with the display tests re-baselined. Found in DES-6c step 6 (TECHNICAL*SPEC 13.15.3). \_Lane 1 + native* _deps: —_
- `[NEXT]` **Resume here (updated 2026-10-30)**, in this order; brief checklist in memory `brief-checklists`:
  1. DONE 2026-10-30: DES-7c slice 2 (deed3c31, §13.13, review round 1 fixed) and DES-7d (fd8e4a4b + 1ff7577e, 01 DEF §15, review round 1 fixed) on branch `feat/des-7d`; `check:coverage` was stopped for low memory (orphaned workers), not yet green.
  2. DONE 2026-10-30: DES-7c slice 4 (native self-intersection search, `cut_mesh` TS cap 4M; §13.15, review fixed) and slice 3 native `sculpt` (bit-identical, 12-23x at 327k / 1.3M, refinement cap 4M, oracle boundary-edge refine defect fixed in both engines; §13.14, cad-reviewer APPROVE + round-1 items). Slice 4: `cut_mesh` (or lift its TS cap) + a native self-intersection search (then drop the "selfIntersections stays with TS" routing rule).
  3. DES-7c left (DONE 2026-10-30: `sculpt_mesh` `along`, `shrinkwrap_mesh` / `displace_mesh` §13.18-13.19, decimate maxDeviation caches §13.16 (13-17 s, not < 10 s), `quad_remesh` open + symmetry §13.17); also native shrinkwrap, full-res FEA / STEP / release host paths, production native routing §13.20-13.22). Still: (UI progress over `/live` and the native harmonic solve to 200k DONE 2026-10-30, §13.25-13.26; harmonic-map + `faceGroups` regions DONE 2026-10-30, §13.23-13.24); (decimate maxDeviation-only 7.8-9.9 s at 1.3M DONE 2026-10-30, §13.27, needs >= 4 cores for < 10 s); (quad_remesh boundary-row realignment DONE 2026-10-30, §13.28). DES-7c engineering items all done; UI hands-on verification left to the owner.
  4. DES-7e DONE 2026-10-30 (01 DEF §16, kernel mesh-leaf guard). `[WIP]` 2026-10-30: lane 1 DES-7c slice 4 (`feat/des-7c-slice4`), lane 2 DES-1c `baseCurve` + `compareTo` (`feat/des-1c-infinite`), lane 3 DES-5c native gradient + dual contouring (`feat/des-5c-native-dc`), all from `feat/des-7d`. Then the rest of DES-1c, DES-3c / 4c / 5c, DES-6c. Optional perf: DISP1, CHK1, SHP1.
  5. Fix the desktop `backend.e2e` "falls through to Manifold" test, which fails on any machine with a built `llull-kernel`.
- `[TODO]` **DES-7c** 07 MSH left after M0–M5 (done 2026-10-23, TECHNICAL*SPEC §13.5): M6 DONE 2026-10-27 (`fit_subdivision_to_mesh` + `fit_surface_to_mesh`, VC-22 complete: deviation 0.0078 on l4, TECHNICAL_SPEC 13.7; left: harmonic-map region parameterisation, `faceGroups` region; earlier: `quad_remesh` + its half of VC-22 done 2026-10-27: QuadriFlow vendored in `llull-quadflow`, TECHNICAL_SPEC 13.6, review round 1 fixed 2026-10-27: crease rule, `MAX_REFINED_QUADS`, pcg32 determinism; open-mesh input and symmetry left); async native mesh jobs + `--progress` + Ctrl-C cancel DONE 2026-10-27 (deferred answer, then run again; TECHNICAL_SPEC 13.8; repeated work per run CUT 2026-10-27, TECHNICAL_SPEC 13.9: plan steps and the command's mesh preparation memoized inside one resolve, the deviation measured by the same native job (a 327k-triangle quad_remesh: 3 runs and 2 jobs to 2 runs and 1 job, longest stall 5.8 s to 1.5 s); left: UI progress over `/live`; review round 1 fixed 2026-10-27); native `remesh` + `analyze` (`analyze_mesh`, `check_mesh`) DONE 2026-10-28 (slice 1 of the measured plan, TECHNICAL_SPEC 13.12: remesh 20-27x faster, 327k 63.6 s to 2.3 s and 1.3M 301 s to 12 s, analyze 1.8 s to 0.15 s at 327k and 7.8 s to 0.43 s at 1.3M, both now answer above the 200k TypeScript cap; bit-identical, pinned, V8 acos twin; left by slice: 2 `repair_mesh` + `fill_mesh_holes`, 3 `sculpt_mesh`, 4 `cut_mesh` (or lift its TS cap) + the self-intersection search of `analyze_mesh`), native decimate speed DONE 2026-10-27 (TECHNICAL_SPEC 13.10: 1.3M to 100k 24.5 s to 4.8 s job wall incl. in-job deviation, same bytes; indexed one-entry-per-edge queue, parallel exact closest-point tree; left: maxDeviation-only path 17.9 s, loop is memory bound); `sculpt_mesh` `along`; asset full-res reads through every indirection DONE 2026-10-27 (TECHNICAL_SPEC 13.11: one reach resolver in `execute` over entities, groups, layers, components, instances, records, default scope; component assets; bounds from `asset.bounds`; `readsMeshTriangles: 'document'`; `MESH_ASSET_TOO_LARGE` cap 16M; annotation audit + contract test `meshReaders`; instance exports at full resolution; review round 2 DONE 2026-10-27: stored meshes never kept inline in kernel result trees (leaf swap + restore), replay goes through `runCommand` (it bypassed the view), `scale_entity` writes a new asset, CFD flow / topology builders refuse display-only bodies and the server hands them full resolution, asset-ref check at load, runtime tripwire + command-by-command guard; left (by name): the native STEP / IGES paths in `server/src/native/` still take the document as is (Lane 4), compound ids `<id>:face3` not split);
  `shrinkwrap_mesh` / `displace_mesh`. \_Lane 1 + 4 + native* _deps: —_
- `[TODO]` **DES-1c** 01 DEF left after M0–M3 + M5 + `flow_on_surface` (done 2026-10-24, TECHNICAL\*SPEC §14): M4 UI
  overlays (`infinite` regions, `allowMeshFallback`, `baseCurve`, `compareTo` shapes, B-spline lattices / oriented boxes, curved-sheet base for `flow_on_surface` DONE 2026-10-30, §17-§17.6),
  (`preserveAnalytic` VC-23, native `faceQuery.bspline`, VC-22 STEP re-import at 2e-6 DONE 2026-10-30, §17.11-17.15; non-uniform fit grid, mesh-warp time bound, `refined_mass` through `blend_union` DONE 2026-10-30, §17.7-17.10; mass rule by face type measured and not kept, §17.9; per-knot-span mass rule DONE 2026-10-31, §17.16.1-17.16.2). DES-1c engineering items all done; M4 UI overlays left.
  _Lane 1 + 2 + native_ _deps: —_
- `[TODO]` **DES-3c** 03 WRP left after M0–M5 (done 2026-10-24, TECHNICAL*SPEC §14; pull walls + draft VC-25/26 and modeled diagonal / diamond knurl DONE 2026-10-30, §14.8-14.9): (freeform (B-spline) face charts + emboss DONE 2026-10-30, §14.10),
  knurl as AP242 PMI (BLOCKED 2026-10-30: OCCT 7.9.2 STEPCAFControl writes no notes and no CAx-IF PMI recommended practice is available offline; needs the RP or a reference STEP with a knurl callout, §14.8) (CFF `seac` / arithmetic / CFF2 variable fonts DONE 2026-10-30, §14.5; left: `gvar`, avar 2, MVAR, a pinned real CFF2), (multi-face wraps VC-36 and `split_at_silhouette` DONE 2026-10-30, §14.6-14.7; chains over cones / spheres / tori and torus silhouettes DONE 2026-10-31, §14.12-14.13; left: mitred walls, freeform silhouettes), pull walls
  UI render overlays
  for the new entities. \_Lane 1 + native* _deps: —_
- `[TODO]` **DES-4c** 04 DIR left after M0–M6 core + UI (done 2026-10-24, TECHNICAL\*SPEC §14): desktop-app hands-on pass on face handles / pole
  drags / loop-cut drag / gizmo (draft sign and faceNear vs the native kernel), handles for curved faces and feature moves (hole / boss), multi-pole
  selection + falloff drag, chip layout, (exact G1 patches DONE 2026-10-31: linear tangent-plane conditions with free inner edge poles, `g1Solve` auto / exact / fit, exact on cubes / boxes / cylinders; left: valence-5 stars like the pentagonal cap, a limit-surface objective above 900 unknowns), (bench VC-18 + 200-face preview at 500 ms / 5 Hz idle, bevel across vertex chains DONE 2026-10-30),
  M7 (OCC reason in `DIR_FACE_MOVE_FAILED`, `render_view overlay=cage|net` DONE 2026-10-30). _Lane 2 + 1 + native_ _deps: —_
- `[TODO]` **DES-5c** 05 IMP left after M0–M6 (M4–M6 done 2026-10-25, §14.7): (surface-UV cell maps + strut-lattice maps and an exact-predicate Delaunay DONE 2026-10-30, §14.13-14.14);
  (scalar kinds `topology_density` / `fea_result` VC-IMP-29 DONE 2026-10-30, §14.11); (numerical homogenisation on `llull-voxfe` DONE 2026-10-30, §14.15); (BVH for explicit strut sets DONE 2026-10-30, §14.9: caps 100k beams / 6000 seeds;
  left: a faster Delaunay for Voronoi; native `gradient`, native dual contouring and per-cell DC repair DONE 2026-10-30, §14.10); (3MF file sink DONE 2026-10-30, §14.12;
  left: desktop export dialog uses toFile); GPU preview. _Lane 1 + native_ _deps: —_

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
- `[DONE]` **STA-M2/M3** 06 STA FL / RD bars, grating catalogue + `add_grating` / `update_grating` / `check_grating` (support lines cover the panel width), `add_railing` / `update_railing`, railing checks + edge coverage in `check_access`, IFC railing / grating, takeoff (TECHNICAL_SPEC §13). Merged 2026-10-25. Open: coverage against the panel chord at each support (tapered panels refused conservatively), knee-rail offset wording, cast in `validateAccess.ts`; clashes, floor loads, openings, plan symbols, metric gratings per §13. Next STA: M4 `add_ladder`.
- `[DONE]` **VIS-M2** 09 review model (TECHNICAL_SPEC §12.7): section boxes, viewpoint state (box / profile / visibility / selection), `apply_viewpoint`, markups, comments, issue workflow with the human gate (signature bound to the issue hash, proofs re-verified by `check_review`, gated deletion, `VIS_SIGNER_REVOKED` only for a revoked record of the signer), `namedViewStore` retired (saved views = document viewpoints). Merged 2026-10-25. Open: an exact copy of a signed issue still verifies in another document (no document identity; bind cited-entity hashes or add a document UUID, same limit as PLM `stateHash`); Review panel, redline tools, section-box gizmo, viewport / `render_view` clipping, UI signing flow; Views overlay not yet tried in the desktop app.
- `[DONE]` **ISO-M1** 05 plugin `piping-fabrication`: PCF lexer / reader / canonical writer (declared units kept, inch bore = NPS), network port over routed, imported (`pcf_line`, read-only) and legacy lines, `import_pcf` (+ CLI `file=`), `export_pcf` (moved from 02, byte-identical for routed lines; one file per PIPELINE-REFERENCE), `delete_pcf_line` (TECHNICAL_SPEC §13.1). Merged 2026-10-25. Open: ISOGEN conformance (OQ-ISO-01), SKEYs beyond the five confirmed, connectivity `openEnds` for imported / legacy lines (M3), `as: route` + supports (M5), `create_pipeline` / `add_pipe_run` don't check imported line numbers (caught at export). Next ISO: M2 welds + spools.
- `[DONE]` **DAT-M1** 08 plugin `plant-data` (toolset `plant_data`, slice `doc.plant.data`): hierarchy, classes + default library, typed properties, tag formats + registry, object providers (equipment, legacy pipes, routed lines, inline components, tie-ins), `assign_plant_object`, `set_plant_properties`, `set_tag_format`, `plant_data_table`, `check_plant_data` (12 rules); tags written back through the new `rename_equipment_tag` (03 EQP) and `set_pipe_line_number` (02) (TECHNICAL_SPEC §13). Merged 2026-10-25. Open (§13.8): `affected` misses plant objects whose from / to a rename rewrote; `renamedReference` should move to a pure module; direct renames of classified equipment are reported, not blocked; trays / supports / members not classifiable (no rename command); display colour rules on `mark` drift on rename.
- `[TODO]` **DAT-M1b** bulk `assign_plant_object` (10 000 sequential assigns take 15.4 s; §8 wants < 1 s); needed before DAT-M2 `import_plant_data`. _deps: —_
- `[TODO]` **EQP-R1** `update_equipment` renames `mark` without the EQP tag grammar or the reference rewrite: route its mark change through `rename_equipment_tag`. _deps: —_
- `[DONE]` **PID-M1** 04 plugin `pid` (toolset `pid`, slice `doc.plant.pid` per README D2, no stored tag index) with full load validation, and `@lib/xmlRead`: pure, never-throwing, namespace-aware XML reader for untrusted input (no DTD / entities, size / depth / element / attribute / namespace limits, linear time and memory, exact positions) (TECHNICAL_SPEC §13). Merged 2026-10-26. Open: tag patterns from a file pass a nested-quantifier scan but overlapping alternation (`(a|a)+`) is still exponential: M4 must use the bounded tag grammar (§5.1) or refuse it before matching; `pid.lld` is a stand-in until M2 / M3 commands.
- `[TODO]` **PID-M2** 04 DEXPI import (Proteus 1.3 mapper, census-equal import of the 11 files, `pid_report kind=counts / connectivity`, DEXPI codes; map `XML_*` errors to `DEXPI_PARSE_ERROR` with line / column). _deps: —_
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
- `[TODO]` **ENG-11** `execute` validates params with zod but `checkedRun` (`packages/core/src/commands/guard.ts` ~130) passes the RAW params to `run`, so no `.default()` / `.trim()` / coercion ever reaches a command (found in the 05 ISO-M1 review). Pass `checked.data`, then re-run the golden corpus + tool-schema snapshot and drop the hand-written trims / defaults it makes redundant. _Lane 1_

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
