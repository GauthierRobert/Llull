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
- 2026-10-19 — branch `ccr-d5e76715-intlyp`: LC1 done (steps 1–6: native kernel default everywhere, opencascade.js retired, no outbox),
  RS-1 done (macOS bundle deferred by the owner), RS-2 done (native SIMP topology optimisation + plugin `topology` + `topology_solve` + UI panel).
  Next: CFD-M1, then RS-3.

## Priority
- `[REVIEW]` **RS** wave RS-3, RS-4, RS-5, RS-7, RS-8 (a/b/c) on branch `feat/rs-native-wave` (worktree `.claude/worktrees/rs-integration`): `docs/decisions/RS1-native-compute.md`. _deps: —_
- `[TODO]` **RS-MSVC** Temporary `solver/scripts/dlltool-shim` (owner 2026-10-20): delete it and its notes (plant 09 §12, plant 10 §13.6, physics 19 §13) once MSVC Build Tools are installed; then run `npm run native:check` in full. _deps: owner installs MSVC_
- `[TODO]` **RS-6** clearance / thickness / view factors on `llull-geomq`. _deps: —_
- `[TODO]` **RS follow-ups** plant 10 M3 viewport, plant 02 V1 (route_pipe, fittings, check_piping), PHY-09 M4/M5, GDT M1–M4, AER 3D panel, PHY-19 hand-off (OpenCourant); RS-8 leftovers: contact / shell kernels in WGSL (today the host part of the GPU cycle), BWC fiber coupling + transverse shear, rounded shell edges, shell thickness change, symmetry supports + prescribed motion, cp(T) during the run (physics 19 §13.9). _deps: RS wave_
- `[TODO]` **TOP-V1** Topology V1 (PHY-17 §10 M4): MMA, projection, extrusion / min member size, `min_volume`, pressure / gravity loads in the
  mapping and the compliance ratio, a timeout checkpoint (`deadlineS`) so a killed run resumes, VC-TOP-34 on a hardware GPU (GPU cap): `docs/physics/17-topology-optimization/TECHNICAL_SPEC.md` §13–§14. _deps: —_
- `[TODO]` **CFD-M1** `cfd` slice, case commands, `cfd_prepare`, `check_cfd`: `docs/aerospace/12-cfd-gpu/TECHNICAL_SPEC.md` §10. _deps: —_
- `[TODO]` **CFD-M2** `llull-compute flow` (LBM, wgpu), `cfd_solve` transport, records: same spec §10. _deps: CFD-M1_

## SolidCraft parity (spec: `docs/decisions/SC1-solidcraft-parity.md`)
- `[TODO]` **SC-Q1** Reference parts `tests/oracle/` (analytic + FreeCAD expected values, STEP round-trip), `npm run oracle` → `docs/ORACLE.md`. _deps: —_
- `[TODO]` **SC-Q3** `llull fuzz` / `fuzz-one --minimise`: seeded designs, solidity + volume-direction checks, boolean identities. _deps: —_
- `[TODO]` **SC-Q2** Action matrix with baseline ratchet, PR sample + nightly shards + determinism. _deps: SC-Q1_
- `[TODO]` **SC-Q5** `docs/FEATURES.md` generated from the registry, staleness checked. _deps: —_
- `[TODO]` **SC-Q4** Mutation testing (Stryker) judged by oracle + golden + fuzz only, nightly. _deps: SC-Q1, SC-Q3_
- `[TODO]` **SC-S1** Sketch solver: constructive + Levenberg–Marquardt, DOF, over-constraint refusal. _deps: —_
- `[TODO]` **SC-S2** Constraint/dimension breadth (horizontal…G2; radius, diameter, arc length…). _deps: SC-S1_
- `[TODO]` **SC-N1** Persistent face/edge naming from native OCCT history. _deps: LC1 step 1_
- `[TODO]` **SC-N2** Lost/split reference reporting + re-pick. _deps: SC-N1_
- `[TODO]` **SC-S3** Sketch on offset planes / faces, linked projection. _deps: SC-S2, SC-N1_
- `[TODO]` **SC-F1…F4** Feature depth: draft/split/replace face/push-pull (absorbs NF7), threads/holes on points, thin extrude/variable fillets, joints check. _deps: SC-N1, SC-Q1_
- `[TODO]` **SC-D1** `.bak` on save + kill-mid-save test. **SC-D2** old-document corpus + damaged variants. **SC-D3** local crash reports with reproducer. _deps: —_
- `[TODO]` **SC-D4** STEP AP242 names/colours/assemblies export, 3MF, URDF, IGES check, mesh → solid. _deps: —_
- `[TODO]` **SC-A1** User-facing agent skills shipped with the desktop app (`llull skills install`). _deps: —_
- `[TODO]` **SC-A2…A4** Live previews + drag manipulators, 3D mouse, issue draft from feature errors. _deps: SC-D3 (A4)_

## Aerospace + physics (spec = the linked pack)
- `[TODO]` **AERO-4** Supply chain: 03 GDT, 04 XCH (AP242), 09 PLM (`HumanSignaturePort`, `dispose_*`): `docs/aerospace/README.md`. _deps: —_
- `[TODO]` **AERO-5** Engineering depth: 05 FEA-REST, 02 SRF, 06 CMP: `docs/aerospace/README.md`. _deps: —_
- `[TODO]` **FEA-REST** Modal/buckling/shell/margins rest, BDF/OP2, face map, UI: `docs/aerospace/05-fea-cae-handoff/` §10. _deps: —_
- `[BLOCKED]` **VNV-M3** Convergence studies + `check_verification`: `docs/physics/00-vv-harness/`. _deps: FEA artifact store, AERO-4 (09 PLM signing)_
- `[TODO]` **VNV-M4** Time-step/order refinement, least-squares order, UI: `docs/physics/00-vv-harness/`. _deps: VNV-M3_
- `[BLOCKED]` **PROP-M6** Seed NIST property library: `docs/physics/01-property-models/` (OQ-PROP-03, needs trc.nist.gov access). _deps: —_
- `[TODO]` **MATL-M7** LM fits, compressible hyperelastic, Hill-48, MFront (OQ-MATL-05): `docs/physics/02-constitutive-models/`. _deps: —_
- `[TODO]` **TMC-M4b** Transient coupled step, orthotropic CTE, fit stack-ups, bimetal FE: `docs/physics/04-thermo-mechanical/`. _deps: —_
- `[TODO]` **FPR-E** Realism: accuracy envelope, losses, brake calibration, gear efficiency, propeller table: `docs/physics/21-functional-prototype/`. _deps: —_
- `[TODO]` **FPR-D** Review tab wiring + `check_prototype` + dispositions: same spec. _deps: FPR-E_
- `[TODO]` **FPR-MJ** MuJoCo 3.14.0 → 3.16.0, re-run VC-FPR-10…17: same spec §11 Q7. _deps: —_
- Plant packs `docs/plant/` (10 packs, specs only): first fix `pipeSizes.ts` ASME/EN mix (README D1), settle D2, then PSC + EQP M1.

## Engineering-audit follow-ups (detail in each line; lists kept here because they have no spec of their own)
- `[TODO]` **ENG-4** Blocked validation plans in `tests/unit/contract/blockedPlanCommands.json`; next: pack 09 frequency response, 11 creep, 19 impact, 17 topology, aero 06/03/09/02.
- `[TODO]` **ENG-5** Fatigue/fracture: FE hot-spot stress (`FAT_RESULTS_MISSING`), `fe_seam` cracks + interaction integral, `compute_k_from_fe`, retardation, surface cracks.
- `[TODO]` **ENG-6** Dynamics: body inertia override, spring end offsets, propeller thrust energy on translating bodies, Coulomb stop time.
- `[TODO]` **ENG-9** AEC: L-stair opening uses bounding rectangle; `add_hole` toolset; beam elevation defaults per domain (confirm with owner).
- `[TODO]` **ENG-10** Density unit convention (`create_material` vs `add_rigid_body`); "unverified" noise on user densities; modal search.

## Product backlog (no spec yet — write one before starting)
- `[TODO]` **S3** `hatch_region` + `region` entity. _Lane 1+3_
- `[TODO]` **X3** 2D export DXF + SVG from 2D entities. _Lane 1/3_
- `[TODO]` **X4** Import SVG path → 2D profile, STL → `mesh`. _deps: X3_
- `[TODO]` **NF7** Push-pull planar faces (native kernel face topology) — now part of SC-F1. _Lane 1+2_
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
