# 08 ASC — Validation plan

Reference model: the CFM56-5B4 turbofan built on 2026-10-28 (15 `.lld` modules, 2,450 parts at full detail,
`~/Documents/llull-models/a320-cfm56-5b/`, outside the repo). Its interference-free state is the acceptance oracle
for M3: 0 overlaps, 0 floating parts, no rotating-to-static contact outside bearings #1–#5, found by the
representative 175-part check.

Machine: the owner's Windows 11 workstation (reference for every timing). Kernel: native `llull-kernel`
(OCCT 7.9.2). Grades follow [`../../../plant/TEMPLATE.md`](../../../plant/TEMPLATE.md): **A** measured in llull or
read in a primary source, **B** one secondary extract, **C** located, not confirmed. "Target" values are budgets of this
spec, not measurements.

## Use cases

1. **UC-1 Bladed rows.** Fuse or pattern 36–120 blades on a disk, regenerate in seconds (M1, M2).
2. **UC-2 Prove a large assembly.** Check 2,450–10,000 parts with declared joints (M3).
3. **UC-3 Modular design.** One `.lld` per module, `use`d with parameters, no external script (M4).
4. **UC-4 See and ship.** Capture the GPU viewport; export STEP / glTF with instances (M2, M6).
5. **UC-5 Install.** Build the installer from a clean checkout on Windows (M0).

## Validation cases

| VC | Proves | Input | Expected | Tolerance | Source / grade |
| -- | ------ | ----- | -------- | --------- | -------------- |
| VC-ASC-01 | FR-ASC-01, TR-ASC-01 | clean checkout, `npm --prefix desktop run dist` (Windows) | installer built; `resources` holds no `node_modules/llull`, no `solver/target` | exact | baseline A: 16 GB unpacked, 7-Zip exit 8 (2026-10-28) |
| VC-ASC-02 | FR-ASC-02 | `prepare-python` with Git `usr/bin` first on `PATH` | extraction succeeds; bridge probe reports CadQuery | exact | baseline A: `gzip: unexpected end of file` from Git tar; archive itself valid (`gzip -t` OK) |
| VC-ASC-03 | FR-ASC-03, TR-ASC-02 | `plans/bladed_disk.lld`, n = 4, 12, 36 | time(36) ≤ 10 s; time(n) / n non-increasing from 12 to 36 | timing ± 10 % | baseline A: 1.7 / 4.3 / 26.4 s |
| VC-ASC-04 | FR-ASC-03 | same, n = 36 | volume(rotor) = V(disk) + 36 V(blade) − 36 V(disk ∩ blade) | 1e-6 rel. | closed form from `mass_properties` of the operands (A once measured) |
| VC-ASC-05 | FR-ASC-04, TR-ASC-04 | a fuse forced over a 2 s deadline (`LLULL_OCC_TIMEOUT_MS=2000`, n = 36) | refusal `KRN_TIMEOUT` with `stage`; next kernel call succeeds without restart | exact | baseline A: worker killed, `kernel returned null` |
| VC-ASC-06 | FR-ASC-05, TR-ASC-05 | `bladed_disk.lld` with n = 80 as instances | pattern fuse; volume and face count equal to the full fuse | 1e-6 rel. / exact | target |
| VC-ASC-07 | FR-ASC-06 | `array_polar … count=80 as="instances"`, then `set_parameter` on the seed | 1 component + 80 instances; replay re-mints the same ids; seed edit updates all | exact | target |
| VC-ASC-08 | FR-ASC-07, TR-ASC-06 | turbofan at full detail in the desktop app | ≤ 200 draw calls (`renderer.info.render.calls`); picking an instance returns its id | exact | target |
| VC-ASC-09 | FR-ASC-07 | `export_step_ap242` and `export_gltf` of an 80-instance row | STEP: 80 NAUO of 1 product; glTF: `EXT_mesh_gpu_instancing` with count 80 | exact | target; [R20][R21] |
| VC-ASC-10 | FR-ASC-08, TR-ASC-07..10 | the 2,450-part turbofan, all parts | completes ≤ 60 s; findings equal to the representative check (0 hard, 0 floating) | exact findings | baseline A: refused (> 500); 175 parts in 269–283 s |
| VC-ASC-11 | FR-ASC-09 | one blade row of 80 instances on a disk | concrete pairs evaluated ≤ 3 per row; results reported for all 80 neighbours | exact | target |
| VC-ASC-12 | FR-ASC-10, FR-ASC-11 | blade units + disk + `add_connection_group kind=bolted members={patternOf: blade}` | 0 `FPR_PART_RESTING_ONLY` for those parts; group listed in `data.connections` | exact | baseline A: 174 `RESTING_ONLY` of 175 |
| VC-ASC-13 | FR-ASC-12 | a bolt tagged `set_fastener`, thread overlapping its host | `FPR_FASTENER_THREAD` (info), not `FPR_PAIR_HARD` | exact | target; [R9] |
| VC-ASC-14 | FR-ASC-14, TR-ASC-11 | `plans/alias_arity.lld` | 4 holes, `check volume` passes (270175.376 mm³); a group alias on a one-id param → `DESIGN_ALIAS_ARITY` | 0.01 % | baseline A: 1 hole (first id only), 274888.872 mm³ |
| VC-ASC-15 | FR-ASC-15, FR-ASC-16 | `create_wing sections=[for k in 0..<3: {airfoilId: af[k], span: k*290, chord: 170+20*k}]` | wing built from 3 resolved sections; a wrong field → `DESIGN_VALUE_SCHEMA` at `sections[k].…` | exact | baseline A: `AERO_AIRFOIL_NOT_FOUND` (alias not resolved inside JSON) |
| VC-ASC-16 | FR-ASC-21 | `loft_sections sectionIds=[af0.entity, af1.entity]` (nurbs airfoils) | exact NURBS loft (sharp trailing edge kept) | exact | baseline A: `no entity "airfoil-1.2"` |
| VC-ASC-17 | FR-ASC-17, FR-ASC-18 | booster casing profile as a comprehension over `fn tip(x)` | profile equals the literal one point for point; stator platforms touch with 0 overlap | 0 (bit-identical expressions) | baseline A: rounded literals gave 0.001–0.005 mm overlaps / gaps |
| VC-ASC-18 | FR-ASC-19 | `plans/target_v2_modules/engine.lld` | modules `fan`, `hpc1`, `hpc2` with own layers and groups; aliases `fan.blades` resolve | exact | target |
| VC-ASC-19 | FR-ASC-19 | same, then delete the module files and `replay_history` | identical document (embedded sources); editing a file then `apply_design` → `DESIGN_MODULE_HASH_CHANGED` | exact | target; [R28] |
| VC-ASC-20 | FR-ASC-22, TR-ASC-15 | `plans/fidelity.lld` `rotated_ring` | y/z half-extent ≤ 1060 | 1e-6 × size | baseline A: 1240.438 (×1.17) on this plan; 1445.255 (×1.366) on the engine inlet |
| VC-ASC-21 | FR-ASC-23, TR-ASC-16 | `plans/fidelity.lld` `pylon_loft` + `mount` | side faces planar; `check_assembly` pylon × mount = `FPR_PAIR_TOUCH` | exact | baseline A: `FPR_PAIR_HARD`, penetration 0.206 mm, 6587 mm³ |
| VC-ASC-22 | FR-ASC-24, TR-ASC-17 | app open with the turbofan; `capture_viewport view=iso width=1600 height=1000 --save x.png --app` | PNG 1600×1000 in ≤ 3 s; the app camera is unchanged afterwards | exact | target; [R30] |
| VC-ASC-23 | FR-ASC-25 | `render_view` on the full turbofan (> 1 M triangles) | GPU route used, or warning `RENDER_BUDGET_EXCEEDED` with `drawnShare` | exact | baseline A: fragmented image, no warning |

Each FR maps to at least one VC: FR-01→01, 02→02, 03→03/04, 04→05, 05→06, 06→07, 07→08/09, 08→10, 09→11, 10/11→12,
12→13, 13→10 (warm-cache budget, §8), 14→14, 15/16→15, 17/18→17, 19→18/19, 20→18 (`expand_design` output compared),
21→16, 22→20, 23→21, 24→22, 25→23, 26→all (codes asserted in each VC).

## Plans

| File | Runs today | Purpose |
| ---- | ---------- | ------- |
| [`plans/bladed_disk.lld`](plans/bladed_disk.lld) | yes | timing baseline for M1 |
| [`plans/alias_arity.lld`](plans/alias_arity.lld) | yes (check fails today, as designed) | arity bug reproducer |
| [`plans/fidelity.lld`](plans/fidelity.lld) | yes | bounding box and ruled loft reproducers |
| [`plans/target_v2_modules/`](plans/target_v2_modules/) | no (M4b / M4c syntax) | target syntax for modules, functions, comprehensions, `.entity`, connection groups |

Expected values are indexed in [`expected_results.json`](expected_results.json); sources in [`sources.md`](sources.md).
