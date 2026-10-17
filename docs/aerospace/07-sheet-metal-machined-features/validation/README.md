# Gap FTR — Validation plan

Validates `FUNCTIONAL_SPEC.md` (FR-FTR-01…42) and `TECHNICAL_SPEC.md` (TR sections, TR-FTR-01…10). Every case is also
expressed as CLI calls with JSON assertions in `expected_results.json` (§2b, AGENT_FIRST AF-23). Every expected value below falls
into one of three categories (TEMPLATE.md):

- **(a)** quoted from a cited source;
- **(b)** derived analytically, with the generator script in this folder;
- **(c)** measured from a pinned file with a named tool, or marked **TBD — measure with <tool>**.

Source verification levels (V-fetch / V-search / NOT VERIFIED) are defined in `sources.md`.

## 1. Real use cases

| UC | Context (sourced) | Scenario in llull | Benefit claimed | VC |
| -- | ----------------- | ----------------- | --------------- | -- |
| UC-1 MRO angle repair | AC 43.13-1B covers repairs of nonpressurized areas of civil aircraft when no manufacturer data exist [R1]. Its ch.4 lays out bends by bend radius table, K-chart setback and bend allowance [R2] | A mechanic computes setback and BA for 0.064 in sheet with R 0.25 in at 45° and 135°, builds the angle, checks R against the radius table, then exports a DXF | Same numbers as the AC chart (0.130 / 0.758 in) with no chart reading. The blank comes out as a file | VC-FTR-02, 09, 10 |
| UC-2 Homebuilt fitting | EAA article computes BA = (0.01743R + 0.0078T)·N for a 0.040 in, R 0.25 in, 60° fitting [R3] | `sheet_metal_calc mode=faa_empirical` | Parity with the builder-community formula | VC-FTR-03 |
| UC-3 OSS sheet-metal parity | FreeCAD SheetMetal unfolds parts, exports DXF/SVG and keeps K tables per material; its `calc-unfold.py` shows a 2 mm, K 0.38 example [R7] | llull reproduces calc-unfold outputs and FreeCAD's DIN→ANSI K convention | Results stay interchangeable with the reference OSS tool | VC-FTR-04, 05 |
| UC-4 MBD supplier intake | NIST MBE PMI CTC/FTC STEP AP242 parts are reference machined parts for CAD/STEP validation [R5][R6] | Import CTC-01…05 and recognise holes and drill points (with split faces) | Recognition is measured on public, government-published parts, not on toy cases | VC-FTR-20, 21 |
| UC-5 Flush-fastener plate | Machined plate with 100° countersunk holes, counterbores, a pocket and a blind drilled hole (authored part; the 100° value is a convention to confirm with gap 08) | Build with `add_hole`/`add_pocket`, check, recognise again after STEP round trip | One hole definition across modelling, recognition and DFM | VC-FTR-17, 22–27 |

Programme-level case studies (OEM monolithic machining, hydroforming) are **not sourced yet** (`sources.md` NOT
VERIFIED). They carry no quantitative claim.

## 2. Validation cases

Tolerance column: abs = absolute, rel = relative. FR/TR = what the case proves.

| VC | Proves | Input | Expected | Tol | Cat. | Data |
| -- | ------ | ----- | -------- | --- | ---- | ---- |
| VC-FTR-01 | FR-04, FR-14, FR-30, TR §5.1 | FP-01…12 (T, R, θ, K) | BA, OSSB, ISSB, BD, flat length per row | 1e-6 mm / 1e-7 in abs | b | `data/flat_pattern_cases.csv`, `data/expected_flat_pattern.json` |
| VC-FTR-02 | FR-14, FR-30 | T 0.064 in, R 0.25 in, θ 45° / 135° (FP-09/10) | OSSB 0.130 in / 0.758 in (computed 0.130063 / 0.758063); K-chart 0.41421 / 2.4142 | 0.0005 in | a (V-search) + b | same |
| VC-FTR-03 | FR-14 | T 0.040 in, R 0.250 in, 60°, FAA empirical (FP-11) | 0.28017 in exact; source text 0.2796 (rounded intermediates) | 0.0007 in vs source, 1e-7 vs exact | a (V-search) + b | same |
| VC-FTR-04 | FR-04 | FreeCAD calc-unfold inputs (FP-01, ML 50) | BA 3.769911, leg 48.115044, FD 1.755044, flange 51.755044 mm | 1e-6 mm | b (recomputed from [R7] script) | `expected_flat_pattern.json` `freecad_calc_unfold_FP01` |
| VC-FTR-05 | FR-01 | K_DIN = 0.88 → K_ANSI 0.44; table r/T [1:0.40, 3:0.44] at r/T 2 → 0.42; r/T 0.5 → 0.40 (clamp) | as stated | 1e-12 | b ([R7] convention) | inline |
| VC-FTR-06 | FR-02, FR-03 | Bracket T 1.6, R 4.8, A 40, B 30 OML, W 50 | volume 5279.716754 mm³ (OCC measured 5279.716754, rel err 1.6e-15) | 1e-6 rel | b + c | `data/expected_test_parts.json`, `data/ftr_bracket_L.step`, `plans/draft_sheet_metal_bracket.json` |
| VC-FTR-07 | FR-04 | Same bracket, K 0.33 / 0.44 / 0.50 | flat length 65.569203 / 65.845663 / 65.996459 mm, width 50 | 1e-6 (native) | b | `expected_test_parts.json` |
| VC-FTR-08 | FR-05 | Bracket, K = 0.5 | flat area × T = folded volume; refold recipe key equal to original | 1e-6 rel | b | same |
| VC-FTR-09 | FR-06 | DXF of the bracket flat pattern | only LINE/ARC/CIRCLE/TEXT; 1 entity on BEND_UP; extents 65.8457 × 50 mm; `$INSUNITS` = 4 (mm) | 1e-4 mm | b | — |
| VC-FTR-10 | FR-07, FR-34 | Rule R = 0 (FP-12); synthetic table row `TEST-ALLOY/T0, 0.8 mm → 2.0 mm`; R = 1.0 | R = 0: refusal `FTR_SHARP_BEND_FORBIDDEN`; R = 1.0: finding `FTR_BEND_RADIUS_BELOW_MIN` citing the row (limit 2.0); R = 2.4 → none | exact | b (synthetic row; real rows TBD after D6) | inline |
| VC-FTR-11 | FR-09 | JG-01…03 | allowance 0.197880 / 0.098095 / 0.287239 mm; run 5.242333 / 5.136723 / 6.143594 | 1e-6 | b | `expected_flat_pattern.json` |
| VC-FTR-11b | FR-09 | JG-04 (R 6, φ 45°, h 0.5) | rejected: s < 0 | — | b | same |
| VC-FTR-12 | FR-08 | Flange with rectangular relief, width ratio 0.5 (flange 33.6×50, T 1.6, R 4.8, widthStart 4) | relief width 0.8 = 0.5·T, depth 6.4 = R + T + 0 (extra = named default 0); volume removed 8.192 mm³ (0.8 × 6.4 × 1.6) | 1e-6 abs (OCC measured, 2026-10-17) | b + c | `server/tests/occtSheetMetalForms.test.ts` |
| VC-FTR-13 | FR-10 | Flanged lightening hole ∅40, flange 4, 90°, lip R 2, T 1.6 (on a 100×80 plate) | valid solid, volume 11381.155100 mm³; physical hole ∅47.2; flat cut ∅34.705133 flagged approximate + unverified | 1e-6 rel (OCC measured, 2026-10-17) | c | same |
| VC-FTR-14 | FR-11 | Bead R 3 (inside), depth 2, length 60 on a 1.0 mm 100×60 flat | valid solid: 6144.808987 mm³ round ends, 6128.053826 mm³ open ends; flat area stays 6000 with one forming note | 1e-6 rel (OCC measured, 2026-10-17) | c | same |
| VC-FTR-15 | FR-12, FR-13 | Hem on a 40×30 plate (leg 10); contour flange on a 40×30 base, T 1.6, R 4.8, K 0.5 | hem closed 2520.637158 / open (gap 3.2) 2761.911474 mm³; contour L 3475.030053, Z (mid) 3638.060105, Z-return (top) 4127.490158 mm³ = flat area × T | 1e-9 rel vs flat area × T (OCC measured, 2026-10-17); hem developed-length formula unverified | b + c | same |
| VC-FTR-16 | FR-16 | Hole at 2 mm from the bend tangent with threshold 3 mm (data) | violation `hole_to_bend` | exact | b | inline |
| VC-FTR-17 | FR-24 | `ftr_machined_plate.step` | 7 holes (4 csk 100° c 1.762109, 2 cbore, 1 blind 118° tip 1.802582) + 1 pocket rc 3; 0 false positives | 1e-4 mm, 1e-3° | b | `data/expected_feature_recognition.json` |
| VC-FTR-18 | FR-15, FR-24 | `ftr_bracket_L.step` → `convert_to_sheet_metal` → `flat_pattern` (K 0.44) | T 1.6, 1 bend R 4.8, 90°, flat 65.845663 × 50 | 0.01 mm | b | same |
| VC-FTR-19 | FR-15 | `ftr_joggle_strip.step` | 2 bends R 1.6, φ 20°, joggle offset 1.6, flat 45.440213 (K 0.44) | 0.01 mm | b | same |
| VC-FTR-20 | FR-24 | NIST CTC-01 (vendored, sha below) | 2 blind holes ∅20 with 118° point (4 half-cone faces → 2 apexes); further features TBD vs PMI | exact count | c | same + `data/step_feature_survey.json` |
| VC-FTR-21 | FR-24 | NIST CTC-02…05 (pinned) | per-file drill-point apex counts 74 / 0 / 22 / 10 (59° semi-angle), 45° cone seeds 0 / 0 / 42 / 3; no crash, < 5 s each | exact counts (seeds) | c | same |
| VC-FTR-22 | FR-17, FR-18 | CS-01…07 | countersink depth c, removed volume beyond bore (full cone and `removed_volume_in_sheet`, truncated at T for knife-edge cases), cone area | 1e-6 abs / 1e-6 rel | b | `data/expected_countersink.json` |
| VC-FTR-23 | FR-26, FR-34 | CS-02/03/06 (thin sheet) vs CS-01/07 | knife edge true for 02/03/06 (land −0.162 / −0.562 / −0.133 mm), false for 01/07 (land 8.238 / 0.651 mm) | exact flag | b | same |
| VC-FTR-24 | FR-17 | DP-01…03 | tip height 1.802582 / 1.242641 / 0.991420 mm | 1e-6 | b | same |
| VC-FTR-25 | FR-17, FR-21, TR §5.3 | `plans/draft_machined_plate.json` | volume 55978.529153 mm³ (OCC reference build rel err 1.2e-15); native vs lowered equal | 1e-6 rel | b + c | `expected_test_parts.json` |
| VC-FTR-26 | FR-17 (parity baseline) | `plans/baseline_countersunk_plate_today.json` (existing commands only; run in review under OCC: 59783.006 mm³) | `mass_properties` volume 59783.006014 mm³ | 1e-6 rel | b | inline (60000 − π·2.4²·10 − 36.038249) |
| VC-FTR-27 | FR-21, FR-26 | PK-01/02/03 | removed volume 3931.327412 / 3877.717302 mm³; PK-03 rejected (rf > rc); tool Ø > 2·rc → DFM violation | 1e-6 rel | b (OCC cross-check 6.8e-12) | `data/expected_pocket.json` |
| VC-FTR-28 | FR-19 | Hole + `set_thread` "MJ6x1-4H5H" (example string) | volume and `recipeKey` unchanged; designation persists through save/load and code export comment | exact | b | — |
| VC-FTR-29 | FR-23 | Mock catalogue entry (gap 08 test double) → hole; edit entry D | hole regenerates with new D; summary names the fastener | exact | b | — |
| VC-FTR-30 | FR-27 | Machined plate with thickness parameter t = 10 → 12 | holes stay through and on the same faces; volume = analytic at t = 12 (generator with lz = 12) | 1e-6 rel | b | — |
| VC-FTR-31 | FR-28 | All new commands | in `listCommands()`, `toToolSchemas()` snapshot, toolset `manufacturing`, CLI `describe`; happy + failure + `is pure` tests | — | — | — |
| VC-FTR-32 | FR-25 | Recognised CTC-01 holes converted to `add_hole` steps | volume equal to the imported solid | 1e-6 rel | c | — |
| VC-FTR-33 | FR-22 | Rib 3 mm × 20 mm × 80 mm on a plate | volume = plate + 3 × 80 × 20 (analytic prism); L-shaped mitred, one-sided and upToFace ribs match closed forms. OCP `BRepFeat_MakeLinearForm` cross-check not run (no OCP here) | 1e-6 rel (OCC measured, 2026-10-17) | b + c | `server/tests/occtFeatureOptions.test.ts` |
| VC-FTR-34 | FR-29 | `hole_table` on the machined plate | 7 rows, coordinates from the top-left corner datum, sorted | exact | b | `expected_feature_recognition.json` |
| VC-FTR-35 | FR-30 | FP-08…11 entered in an inch document | same values in inch; mm document gives ×25.4 exactly | 1e-9 rel | b | `flat_pattern_cases.csv` |
| VC-FTR-36 | FR-20 | Modelled thread (V2) | TBD | TBD | TBD | — |
| VC-FTR-37 | FR-33 (AF-11) | Wrong inputs: PK-03, missing K, θ = 0, radius row without `source`, D ≤ d, JG-04 | exit 1; `data.error.code` = `FTR_POCKET_FILLET_GT_CORNER` / `FTR_K_FACTOR_MISSING` / `FTR_BEND_ANGLE_OUT_OF_RANGE` / `FTR_TABLE_ROW_NO_SOURCE` / `FTR_HOLE_DIAMETERS_INCONSISTENT` / `FTR_JOGGLE_OFFSET_TOO_SMALL`; offending path + remediation present | exact | b | `expected_results.json` |
| VC-FTR-38 | FR-34 (AF-20, AF-30, AF-31) | `check_machining` on a countersunk plate with no `minLand` threshold | warn `FTR_RULE_THRESHOLD_MISSING`; `rulesSkipped` lists `minLand` | exact | b | same |
| VC-FTR-39 | FR-35 (AF-31) | `sheet_metal_calc` without K; blind hole without drill angle | refusal `FTR_K_FACTOR_MISSING`; `hole_table` row `drillPointAngle` = {118, defaulted true, source R8} | exact | b | same |
| VC-FTR-40 | FR-36 (AF-32) | Synthetic radius row marked `unverified` → calc, part, check, flat pattern | `data.unverified` true in calc and flat pattern; check warn `FTR_UNVERIFIED_DATA` | exact | b | same |
| VC-FTR-41 | FR-37 (AF-33, AF-36) | `flat_pattern` of the bracket; DXF of VC-FTR-09 | `data.reviewRequired` true + reason; summary contains "not approved"; DXF `NOTES` carries the note | exact | b | same |
| VC-FTR-42 | FR-38 (AF-34) | R 1.0 vs row 2.0 with a waiver whose `approvalRef` is not a human gap 09 approval | `status` fail; findings `FTR_BEND_RADIUS_BELOW_MIN` + `FTR_WAIVER_NOT_APPROVED` | exact | b | same |
| VC-FTR-43 | FR-39 (AF-35) | `sheet_metal_calc` FP-10 | `provenance.formulas.ossb` = "tan(theta/2)*(R+T)", inputs with units, sources contain R2 | exact | b | same |
| VC-FTR-44 | FR-31, FR-32 (AF-01/02/04/10) | `llull search`, `llull describe` of the FTR commands, calc result | commands found; every numeric param states a unit; `lengthUnit` / `angleUnit` echoed | exact | b | same |
| VC-FTR-45 | FR-40, FR-41 (AF-05/22/42) | bracket plan `--validate`; broken plan; `--dry-run`; `render_view --save` | validate ok; broken plan names `step 0` and `thickness`; doc file unchanged after dry run; PNG written | exact | b | same |
| VC-FTR-46 | FR-42 (AF-40/41) | CTC-02 import + recognition with `--progress --timeout` | exit 0; recognition < 5 s | exact / budget | c | same |

### FR → VC coverage

FR-01→05 · FR-02→06 · FR-03→06 · FR-04→01,04,07 · FR-05→08 · FR-06→09 · FR-07→10 · FR-08→12 · FR-09→11,11b ·
FR-10→13 · FR-11→14 · FR-12→15 · FR-13→15 · FR-14→01,02,03 · FR-15→18,19 · FR-16→16 · FR-17→22,24,25,26 ·
FR-18→22 · FR-19→28 · FR-20→36 · FR-21→25,27 · FR-22→33 · FR-23→29 · FR-24→17,18,20,21 · FR-25→32 · FR-26→23,27 ·
FR-27→30 · FR-28→31 · FR-29→34 · FR-30→01,02,35 · FR-31→44 · FR-32→44 · FR-33→37 · FR-34→10,16,23,27,38 · FR-35→39 ·
FR-36→40 · FR-37→41 · FR-38→42 · FR-39→43 · FR-40→45 · FR-41→45 · FR-42→46.

### 2b. CLI form of every case (AF-23)

`expected_results.json` (generated by `build_expected_results.py` from `data/*.json`, never edited by hand) lists each VC
as an optional inline plan or plan file, CLI calls with `--json`, and assertions (`path`, `op`, `value`, `tol`, `unit`).
The consumer is a small script used by the production-gate agent driver: fresh `--doc` per case, `llull run … --json`,
then the calls, then the assertions; exit codes only, no UI. Since AERO-3 (lane K) every case runs against the built commands:
`server/tests/packReplay07.test.ts` replays this file through `runCli --json` (a failing single command reports `error.code` /
`error.paths` / `error.remediation` beside `data`; a failing plan reports `data.steps[i].error`; `<first:PATH>` reads a value of the
previous call, e.g. `data.matches[0].id` of `find_entities`). VC-FTR-46 needs the pinned CTC-02 (`npm run quality:fetch`) and runs in
`server/tests/quality/ftrRecognition.gate.ts`. Results: `RESULTS.json` / `RESULTS.md`.

## 3. Generators and how to run them

| Script | Needs | Output |
| ------ | ----- | ------ |
| `generate_flat_pattern.py` | Python ≥ 3.9 standard library | `data/flat_pattern_cases.csv`, `data/expected_flat_pattern.json` |
| `generate_countersink.py` | standard library | `data/expected_countersink.json` |
| `generate_test_parts.py` | `pip install cadquery-ocp` (used: 8.0.1.1.0, OCCT 8.0) | `data/ftr_*.step`, `data/expected_test_parts.json` (analytic vs OCC volume) |
| `build_expected_results.py` | standard library; run after the two generators above | `expected_results.json` (CLI cases + assertions, AF-23) |
| `survey_step_features.py` | `cadquery-ocp` | `data/step_feature_survey.json` (face types, radii, cone semi-angles, cone adjacency, distinct apexes) |

```bash
cd docs/aerospace/07-sheet-metal-machined-features/validation
python3 -I generate_flat_pattern.py && python3 -I generate_countersink.py && python3 -I build_expected_results.py
python3 -I generate_test_parts.py
python3 -I survey_step_features.py <ctc-dir>/nist_ctc_0*_asme1_ap242.stp data/ftr_*.step > data/step_feature_survey.json
```

`expected_pocket.json` was derived by hand from the formula in TECHNICAL_SPEC §5.5 and cross-checked once with OCC. The
check script is not kept, because the formula and the numbers are in the file.

## 4. Test files (inventory)

| File | Stored? | sha256 | Size (B) | Licence | Tests |
| ---- | ------- | ------ | -------- | ------- | ----- |
| `data/ftr_bracket_L.step` | yes | `dd564eeb5a9fcd1f400c4de963e969a20c33bd73eb04c88c1eccaf70b7c742c2` | 30978 | CC0 (authored) | VC-FTR-06/07/18 |
| `data/ftr_joggle_strip.step` | yes | `1aa4898bf2f3325d4119048c71233d86e212b0e1eb6b5fc7534865270b0d222b` | 47186 | CC0 | VC-FTR-19 |
| `data/ftr_machined_plate.step` | yes | `c811b3a08ede92ceb17904130d97f48ddf78b309a0fe085b3d5b1dba144188bc` | 129827 | CC0 | VC-FTR-17/25 |
| `data/nist_ctc_01_asme1_ap242.stp` | yes (< 1 MB, U.S. government work) | `85a5752da05f53c456ca3a9e038c90358e1d5a3141d1f0d6e5f0970f2356e821` | 396445 | Public domain in the U.S. [R11] | VC-FTR-20 |
| `nist_ctc_02_asme1_ap242.stp` | pinned only | `99a0a2079ddeb64d05c2432cbe931fa17c89da60d8b0bcb0b11bd0ed94fa2e68` | 1981342 | same | VC-FTR-21 |
| `nist_ctc_03_asme1_ap242.stp` | pinned only | `196b665776e759282f80fc8fb27d7bceb995df77cf78b7ce48347535a4d6cb5f` | 673846 | same | VC-FTR-21 |
| `nist_ctc_04_asme1_ap242.stp` | pinned only | `20b43b54ce25d4ed17cff794084c406e831c687f5b62471d3371eef33669e355` | 1287291 | same | VC-FTR-21 |
| `nist_ctc_05_asme1_ap242.stp` | pinned only | `59bbc09a34621c03106e4c1b2a5bc909fdb67463117c16c4965ee7a6fe5c1521` | 878030 | same | VC-FTR-21 |

Pinned URL pattern for the NIST files:
`https://raw.githubusercontent.com/pzfreo/dw-examples/12fa031f02a9d279c1e13dc1aa51662c63a640f4/steps/nist/<file>`. This
is an unmodified mirror. The header reads "CTC-0n geometry with PMI representation and/or presentation from the NIST MBE
PMI Validation and Conformance Testing Project", schema `AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF`. The canonical
download page is [R5] on nist.gov.

The synthetic STEP files carry a timestamp in their header. Re-running `generate_test_parts.py` changes the sha256 but not
the geometry, so tests must assert on geometry, never on hashes, for these files.

### Draft `build_project` plans (`plans/`)

| Plan | Runs today? | Purpose |
| ---- | ----------- | ------- |
| `baseline_countersunk_plate_today.json` | yes, existing commands only. Run in review (2026-10-15, `build_project`, opencascade.js 1.1.1 kernel): 7/7 steps ok, `mass_properties` 59783.006 mm³ (exact B-rep, display precision); Manifold gives 59787.578 mm³ (mesh) | What a countersunk hole costs today: 2 primitives, 2 booleans, no semantics. Volume reference VC-FTR-26 |
| `draft_machined_plate.json` | yes (AERO-3 lane K: `{ status, expected, actions }`, pocket as `rectangle` + `cornerRadius`) | Authoring of the machined plate with `add_hole`, `add_pocket`, `recognize_features`; 55978.529153 mm³ (VC-FTR-25) and the 7 + 1 recognised features |
| `draft_sheet_metal_bracket.json` | yes (AERO-3 lane K: `actions`) | Authoring of the bracket with the sheet-metal plugin; 65.845663 × 50 flat, 5279.716754 mm³ (VC-FTR-06 / 07 / 41) |
| `draft_recognize_ctc01.json` | yes (AERO-3 lane K: a CLI script, `cli` lines) | CLI import of CTC-01 with `import_step_exact` (`file=` is read by the CLI), then `recognize_features` |

The `draft_` names are historical. All four plans are run by `server/tests/packReplay07.test.ts`, which also replays every case of
`expected_results.json` through the real `llull` CLI entry (`runCli --json`).

## 5. Gates

- **Unit / contract** (`npm run check`): VC-FTR-01…05, 07, 10, 11, 16, 22–24, 27, 28, 31, 35, 37–44.
- **CLI scripts** (`expected_results.json`, production-gate agent driver): all cases listed there, plus VC-FTR-45, 46.
- **Server OCC** (`npm --prefix server test`): VC-FTR-06, 08, 17–21, 25, 26, 30, 32.
- **Golden**: bracket and machined-plate plans (id-normalised snapshot + replay equality).
- **Quality gate** (`npm run quality`): NIST CTC set in `quality/corpus.json` (timing, no crash).
- **Production-gate scenario**: UC-1 end to end via `llull --app` on desktop.

## 6. Re-checks required before freezing V-search values

1. AC 43.13-1B ch.4 from the FAA PDF [R2]: confirm par. 4-56 wording, Table 4-7 values (0.41421, 1.0, 2.4142), and the
   worked example (0.064 in, R 0.25 in → 0.130 in and 0.758 in). Transcribe Table 4-6 (decision D6).
2. EAA article [R3]: confirm the formula constants and the 0.2796 in result.
3. NIST download page [R5]: confirm that the CTC AP242 files match the mirror hashes, or replace the pins with the
   nist.gov originals.
4. 100° countersink and the UNJ/MJ references: verify with gap 08 sources (NASM/NAS/AS8879/ISO 5855 catalogue pages)
   before the 100° preset becomes a default.
