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
- 2026-10-20 — branch `feat/eng-depth`: DONE (reviewed, fixes merged) FEA-REST parts 1–3, AERO-5 (02 SRF M0–M6, 06 CMP M0–M2 + M4 data + M6), MATL-M7,
  TMC-M4b, FPR-E, FPR-D. Full suite = main baseline (23 env failures), coverage 97.2/88.6/98.8/98.8. Solver/kernel numbers unmeasured here
  (no ccx/gmsh/cargo/python). Next: SOLVER-VERIFY, then CFD-M1, RS-3.
- 2026-10-19 — branch `ccr-d5e76715-intlyp`: LC1 done (steps 1–6: native kernel default everywhere, opencascade.js retired, no outbox),
  RS-1 done (macOS bundle deferred by the owner), RS-2 done (native SIMP topology optimisation + plugin `topology` + `topology_solve` + UI panel).
  Next: CFD-M1, then RS-3.

## Priority
- `[TODO]` **RS** Native compute RS-3 → RS-8 (RS-1, RS-2 done): `docs/decisions/RS1-native-compute.md`. Next RS-3 point clouds. _deps: —_
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
- `[TODO]` **SOLVER-VERIFY** On a machine with ccx 2.21 + Gmsh 4.15.2 + Python/pyNastran + the native llull-kernel, run every server FE / kernel test that skips here
  (FEA-REST 1–3, TMC-M4b, SRF VC-SRF-11/15/16/22–24, CMP live-OCC cones, BDF read_bdf, a real OP2); fix deck defects, never widen tolerances. Unverified items are
  listed in 05 §13, 04 §16, 02 §13.4–13.6, 06 §13. _deps: —_
- `[TODO]` **AERO-5b** Deferred depth: 02 SRF M7 (G3, blend, .vsp3, CRM), B-spline section payload in the sidecar, curvature/zebra/draft overlays, trim by curve,
  fill >4 / G1–G2, sew to shells/solids, exact OCC thicken; 06 CMP M3 drape (live OCC), M4 laser projection / ply solids / STEP, M5 AP242, ply-failure margins on
  composite shells; 05 beams, *DISTRIBUTING COUPLING, Netgen, large-field BDF, re-entrant edge screening. _deps: SOLVER-VERIFY (kernel parts), AERO-4 (CMP M5)_
- `[TODO]` **FPR-V24** VC-FPR-24 reference engine: per-check profiling (~30 min run), gear couplings in the rank DOF, joint realisation on the native kernel, the
  unidentified dynamics not_run item, RS-6 geomq wiring of check_motion_clearance (21 §12). _deps: —_
- `[TODO]` **AERO-4** Supply chain: 03 GDT, 04 XCH (AP242), 09 PLM (`HumanSignaturePort`, `dispose_*`): `docs/aerospace/README.md`. _deps: —_
- `[BLOCKED]` **VNV-M3** Convergence studies + `check_verification`: `docs/physics/00-vv-harness/`. _deps: FEA artifact store, AERO-4 (09 PLM signing)_
- `[TODO]` **VNV-M4** Time-step/order refinement, least-squares order, UI: `docs/physics/00-vv-harness/`. _deps: VNV-M3_
- `[BLOCKED]` **PROP-M6** Seed NIST property library: `docs/physics/01-property-models/` (OQ-PROP-03, needs trc.nist.gov access). _deps: —_
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
