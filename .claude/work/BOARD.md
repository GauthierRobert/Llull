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
- `[TODO]` **CFD-M2** `llull-compute flow` (LBM, wgpu), `cfd_solve` transport, records: same spec §10. _deps: — (CFD-M1 done 2026-10-20, f58bc668)_

## SolidCraft parity (spec: `docs/decisions/SC1-solidcraft-parity.md`)

- All SC tasks done (SC-NATIVE, SC-Q4b closed 2026-10-20: `docs/decisions/SC1-remaining.md`). Follow-up idea: exact helical thread
  groove in the native kernel (oracle 106 known failure).

## Freeform design (spec = `docs/design/README.md`, order = its "Recommended order")

- `[TODO]` **DES-2** 02 SWG M0–M3: sweep twist / scale / area laws, orientation modes, explicit station blend (VC-SWG-11 finding), exact
  helix: `docs/design/02-sweep-loft-guides/`. _Lane 1 (+ native `sheetSolid`)_ _deps: —_
- `[TODO]` **DES-6** 06 BLD M0: coded OCCT fillet diagnostics, native `edgeSamples` / `edgeContinuity`, `probe_fillet`, `check_blends`,
  oracle cases for variable laws: `docs/design/06-variable-blends/`. _Lane 1 + native_ _deps: —_
- `[TODO]` **DES-7** 07 MSH M0 + M2: STL / OBJ / PLY / 3MF import, `analyze_mesh` / `check_mesh`, Manifold hull / Minkowski / offset /
  hollow, boolean routing for triangle meshes: `docs/design/07-mesh-modeling/`. _Lane 1 + 4_ _deps: —_
- `[TODO]` **DES-1** 01 DEF M0–M1: deformation law library, `scale_nonuniform` (exact), twist / taper / stretch / bend on the mesh kernel,
  `analyze_deformation`, `check_deformation`: `docs/design/01-body-deformation/`. _Lane 1_ _deps: —_
- `[TODO]` **DES-3** 03 WRP M0–M3: face charts to core, fonts + 3D text, wrap / project / unwrap, emboss / deboss / scribe on developable
  faces, `check_wrap`: `docs/design/03-wrap-emboss/` (decision D-WRP-1 binary blobs first). _Lane 1_ _deps: —_
- `[TODO]` **DES-4** 04 DIR MVP: viewport picking, cage / control-net overlays, drag sessions, cage edit v2, creases, symmetry, extrude /
  inset / loop cut: `docs/design/04-direct-freeform-editing/`. _Lane 2 + 1_ _deps: DES-6 (`edgeContinuity` for checks)_
- `[TODO]` **DES-5** 05 IMP MVP: field program + engine port, shared `core/lib/isosurface`, SDF / TPMS / strut lattices,
  `create_implicit_body`, native `llull-field`: `docs/design/05-implicit-lattice/`. _Lane 1 + native_ _deps: DES-7 (mesh assets)_

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
- Plant packs `docs/plant/` (10 packs, specs only): first fix `pipeSizes.ts` ASME/EN mix (README D1), settle D2, then PSC + EQP M1.

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
