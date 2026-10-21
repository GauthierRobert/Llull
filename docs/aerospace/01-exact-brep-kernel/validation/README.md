# KRN validation pack — exact B-rep kernel

Proves a future implementation of [FUNCTIONAL_SPEC](../FUNCTIONAL_SPEC.md) / [TECHNICAL_SPEC](../TECHNICAL_SPEC.md):
OCC as the default desktop kernel, a tolerance policy that holds at aircraft scale, STEP imported as exact
B-rep with healing, persistent naming, accurate mass properties, validity gating, determinism and large
assemblies. Every expected value is (a) quoted from a cited source, (b) analytic with its derivation below, or
(c) **measured** by a script in this folder with plain OCCT 7.9.3 (the OCCT that the desktop's bundled CadQuery
2.8 uses, R13) and labelled as such. Sources: [sources.md](sources.md).

## 1. Files

| File | Kind | Content |
| ---- | ---- | ------- |
| `generate_analytic_solids.py` | generator (python3, stdlib) | 10 analytic solids: volume, area, centroid, inertia (rho = 1, about centroid). `--occt` adds the OCCT cross-check |
| `analytic_solids.json` / `.csv` | analytic (b) | output of the generator |
| `occt_crosscheck.json` | measured (c) | BRepGProp vs closed form for the 10 cases: worst relative error 2.2e-9 (inertia at x = 70 m), all others <= 1.1e-14; all shapes valid |
| `probe_occt_behaviour.py` → `occt_behaviour_probe.json` | measured (c) | inertia error vs coordinate offset, part-frame mitigation, fuzzy boolean, same-process determinism, fillet history counts |
| `measure_step_brep.py` → `nist_occt_reference.json` | measured (c) | 28 NIST STEP files read as exact B-rep: topology counts, validity before/after ShapeFix, max tolerance, volume/area/centroid/inertia, bbox, read time, signature x2 |
| `measure_step_brep.cxx` | port (C++) | line-for-line C++ port of `measure_step_brep.py` for hosts without the OCP wheel; adds the same measures for the first solid of the healed shape (`solid`) |
| `nist_occt_solid_reference.json` | measured (c) | solid-level companion of `nist_occt_reference.json` (what `import_step_exact` keeps): counts, validity, tolerance, volume / area / centroid / inertia, optimal bbox, signature; measured by the port on the OCCT 7.9.3 libraries of the cadquery-ocp 7.9.3.1 wheel, whose whole-file rows reproduce `nist_occt_reference.json` bit for bit |
| `nist_occt_solid_faces.json` | measured (c) | per-face area + centroid (6 decimals, MapShapes order) of each solid of the same run: the VC-KRN-10 cross-build comparison |
| `fetch_nist_step_files.py` | fetcher (python3, stdlib) | downloads R20, checks its sha256 and every file's sha256 against `nist_occt_reference.json`, copies the 28 files to `~/.cache/llull/nist-pmi-step-files` (or `LLULL_NIST_STEP_DIR`) for the VC-KRN-25 server suite |
| `nist_gvp_vs_occt.json` | measured vs quoted | OCCT values vs geometric validation properties written by the originating CAD systems (R20, R28); verdict per file |
| `expected_results.json` | expected | every VC case: value, tolerance, unit, source |
| `plans/krn-analytic-primitives.json` | draft `build_project` plan | primitives + plate-hole + far box, then `mass_properties` |
| `plans/krn-rib-pocket.json` | draft plan | machined rib from a billet (blank − pocket, 4 corner fillets via `edgesNear`), material, topology, check, mass |
| `plans/krn-rib-pocket-station-70m.json` | draft plan | the same rib at body station x = 70 000 mm |
| `plans/krn-rib-parametric-renaming.json` | draft plan | pocket width parameter 260 → 200: the fillet must follow its edges (persistent naming) |

Regenerate (desktop CPython or any env with `pip install cadquery`):

```bash
cd docs/aerospace/01-exact-brep-kernel/validation
python3 generate_analytic_solids.py            # pure maths
python3 -I generate_analytic_solids.py --occt  # + OCCT cross-check
python3 -I probe_occt_behaviour.py
# NIST files: download R20, check sha256, unzip into a fresh directory, then
python3 -I measure_step_brep.py nist_occt_reference.json <dir>/NIST-PMI-STEP-Files/"AP203 geometry only"/*.stp <dir>/NIST-PMI-STEP-Files/nist_*ap242*.stp
# VC-KRN-25 (native kernel): the corpus for the server suite, then the suite itself (needs the llull-kernel release build)
python3 -I fetch_nist_step_files.py
(cd ../../../../server && LLULL_REQUIRE_NATIVE_KERNEL=1 LLULL_REQUIRE_NIST_CORPUS=1 npx vitest run tests/nativeKernelReference)
# solid-level reference without the OCP wheel: build the C++ port against any OCCT 7.9 (header of measure_step_brep.cxx),
# e.g. the TK*.so of the cadquery-ocp wheel (unzip cadquery_ocp.libs/; LD_LIBRARY_PATH to it), one JSON row per file
./measure_step_brep ~/.cache/llull/nist-pmi-step-files/*.stp | grep '^{'
```

## 2. Real use cases

| # | Use case | Why it needs this gap | Evidence |
| - | -------- | --------------------- | -------- |
| U1 | Airframe structural part machined from a billet (rib, frame, fitting): blank, pockets with corner radii, thin floors, drilled holes; mass and buy-to-fly reported to stress/weights | exact pockets/fillets (no facets), exact mass and inertia for weight & balance, STEP to the machine shop | analytic rib VC-KRN-03; NIST CTC/FTC parts are prismatic machined test parts (R19, R20) |
| U2 | Supplier receives OEM STEP (AP203/AP242) and must modify it (add a hole, cut a pocket, fillet) | import must give editable exact B-rep, healed, with names stable across edits | VC-KRN-04..07 on NIST files (R20) |
| U3 | Parts positioned in aircraft coordinates (body station / waterline / buttline) on a > 70 m airframe (A380 72.6 m per ICAO WP, R24) | no precision loss far from origin; centroid/inertia in aircraft axes for weight & balance | VC-KRN-02, VC-KRN-03b |
| U4 | Large assembly review: a 747 has ~6 million parts (NASA, R25) | instancing (one exact definition, many placements), LOD, lightweight display | VC-KRN-12 |
| U5 | Regression of the kernel across OCCT upgrades (OCCT moved 7.4 → 7.9 → 8.0, R11, R14) | determinism, golden signatures, tolerance-based cross-version comparison | VC-KRN-10 |

## 3. Validation cases

Tolerances are relative (`rel`) or absolute (`abs`). "Gate" names the automated harness of TECHNICAL_SPEC §9.

| VC | Proves | Data | Expected | Tolerance | Gate |
| -- | ------ | ---- | -------- | --------- | ---- |
| VC-KRN-01 | FR-KRN-08, TR-KRN-40 | 7 analytic solids (`plans/krn-analytic-primitives.json` + tube) | `analytic_solids.json` volume, area, centroid, inertia | vol/area/inertia rel 1e-9, centroid abs 1e-6 mm (plan results against `centroidInPlan` in `expected_results.json`: the plan places solids away from the analytic local frame) | unit (server OCC) + golden |
| VC-KRN-02 | FR-KRN-03, FR-KRN-08, TR-KRN-10, TR-KRN-41 | `box-station-70m`, `plate-hole-station-70m` | same volume/inertia as at origin, centroid shifted by 70 000 | vol rel 1e-9, centroid abs 1e-6 mm, **inertia rel 1e-12** (raw BRepGProp gives 1.2e-9: needs TR-KRN-41) | unit |
| VC-KRN-03 | FR-KRN-01, FR-KRN-08, FR-KRN-12 | `plans/krn-rib-pocket.json` | V = 485 716.8147 mm³; mass 1311.4354 g at 0.0027 g/mm³; buy-to-fly 1.85293; 1 valid solid; 4 cylindrical corner faces (r 10) | rel 1e-9 | golden + quality:kernel |
| VC-KRN-03b | FR-KRN-03, TR-KRN-10 | `plans/krn-rib-pocket-station-70m.json` | same V; centroid [70 150, 60, 10.367671] | vol rel 1e-9, centroid abs 1e-6 mm | golden |
| VC-KRN-04 | FR-KRN-04, FR-KRN-05, TR-KRN-20, TR-KRN-23 | 6 NIST files whose GVP agree with OCCT (ctc_01 e1, ctc_03 e2, ctc_04 e2, ftc_06 e2, stc_10 e2, ftc_09 rd) | GVP volume / area / centroid (R20/R28), 1 solid, valid after ShapeFix | vol rel 1e-4, area rel 1e-3, centroid abs 0.05 mm (CAD-to-CAD GVP comparison; OCCT itself achieves 9e-13 … 7.5e-5) | quality:step (exact mode) |
| VC-KRN-04x | FR-KRN-05 | 5 NIST files whose GVP disagree (ctc_02 e2 & rc, ftc_07 e2, stc_08 e3, ctc_05 rd — inch file: GVP in file units, still ≈ 1.1e-2 volume apart after ×25.4) | reported as GVP mismatch with both numbers (converted to mm) | — (knownIssue until triaged) | quality:step |
| VC-KRN-05 | FR-KRN-05, TR-KRN-22 | `nist_ftc_08_asme1_ap242-e4-tg.stp` (tessellated only) | import reports "no exact B-rep (tessellated)"; offers mesh import; never a silent empty result | exact | quality:step |
| VC-KRN-06 | FR-KRN-05, TR-KRN-24 | all NIST files | per-file max sub-shape tolerance reported (0.1 mm on ctc_02 rc, measured); warning when > 0.01 mm | exact | quality:step |
| VC-KRN-07 | FR-KRN-06, TR-KRN-30, TR-KRN-31 | `plans/krn-rib-parametric-renaming.json` | after pw 260 → 200: still 4 fillet faces on the pocket corners, V = 581 716.8147 mm³, 0 broken references | rel 1e-9 | golden (expected to FAIL with today's `edgesNear`: the two stored points at x = 280 are 60 mm from the moved corner edges at x = 220 but 22.4 mm from the blank's outer top edges, so the nearest-edge rule re-targets them silently) |
| VC-KRN-08 | FR-KRN-07, TR-KRN-12 | two 10 mm cubes, 1e-5 mm gap | `fuzzy` 0 → 2 solids; `fuzzy` 2e-5 → 1 valid solid (measured) | exact counts | unit |
| VC-KRN-09 | FR-KRN-09, TR-KRN-50 | every golden/quality result | no committed shape fails `validate_shape` | 0 | golden + quality |
| VC-KRN-10 | FR-KRN-10, TR-KRN-60, TR-KRN-61 | plate-minus-cylinder, rib, NIST set | identical topology signature on re-run (measured `1125f7464525c4f6`, 7 faces, OCCT 7.9.3); cross-version: counts equal, measures within VC-KRN-01 tolerances | hash equality same build; tolerance across builds | quality:kernel |
| VC-KRN-11 | FR-KRN-01, TR-KRN-01 | desktop launch (`npm --prefix desktop test`) | `kernel_info.active` = `occt`; Manifold fallback shows a warning | exact | desktop test |
| VC-KRN-12 | FR-KRN-11, TR-KRN-70, TR-KRN-71 | 10 000 instances of the rib (component + `insert_instance`) | 1 kernel evaluation, 1 tessellation per LOD, draw calls and frame time within §8 budgets | TBD — measure with the Playwright display gate | quality:display |
| VC-KRN-13 | FR-KRN-02, TR-KRN-03 | web app without backend, `?kernel=occt`, rib plan | no main-thread long task > 50 ms during kernel work; results identical to the server run | TBD — measure with Playwright Long Tasks API | quality:display |
| VC-KRN-14 | FR-KRN-13, TR-KRN-80 | rib (VC-KRN-03) and NIST CTC 01 modified part | `export_step_ap242` (04 XCH) writes GVP; re-import GVP delta ≤ 1e-6 relative (volume, area), ≤ 1e-6 mm centroid | as stated | production scenario |
| VC-KRN-15 | FR-KRN-14, FR-KRN-15, TR-KRN-61 | save/load a document; `set_modeling_tolerance` | saved file carries `kernelSettings.occtVersion` + build; load under another version → provenance warning; `linear: 1` (mm) rejected (range [1e-7, 1e-2]); import uses the document precision when the file has none | exact | unit + server |
| VC-KRN-16 | FR-KRN-16 | fillet recipe loaded under Manifold (capability gap) | entity flagged `faceted`; `check_model` reports `KRN_FACETED_RESULT`; `export_step_ap242` refuse unless a qualified reviewer accepts (human gate) | exact | unit |
| VC-KRN-18 | FR-KRN-18, TR-KRN-90..92 | analytic face fixtures: box 100×50×20 (min corner at origin), cylinder r 10 h 40, sphere r 25 at origin | box +Z face: normal (0,0,1), centroid (50,25,20); cylinder side: radius 10, \|k\| = 1/r = 0.1 and 0; sphere: \|k1\| = \|k2\| = 1/r = 0.04, K = 1/r² = 0.0016, \|H\| = 0.04; `projectOnFace`((0,0,50)) on the sphere → distance 25, point (0,0,25); Manifold: `faceQuery` absent | abs 1e-9 (rel 1e-9 curvature) | server OCC unit (`occtFaceQuery.test.ts`) |
| VC-KRN-17 | FR-KRN-17 | registry | every KRN command in `toToolSchemas()` snapshot, CLI help, happy + failure unit tests, `is pure` test | exact | contract tests |
| VC-KRN-19 | FR-KRN-19, FR-KRN-20, TR-KRN-100 | deliberately wrong calls (table in `expected_results.json`) | each exits 1 with the listed `KRN_*` code, offending id / path and remediation; document unchanged | exact (code strings) | CLI script (`--json`, exit codes) |
| VC-KRN-20 | FR-KRN-23, TR-KRN-103 | rib plan with the legacy `create_material` aluminium (no verified record) | `mass_properties` `.data.unverified == {value: true, reasons: ["density_unverified"]}`; volume still 485 716.8147 mm³; `check_model` warning `KRN_MASS_INPUT_UNVERIFIED` naming the rib | exact | CLI script |
| VC-KRN-21 | FR-KRN-24, TR-KRN-104 | rib with `purpose: "weight-and-balance"`; NIST ctc_02 e2 import (GVP mismatch) | `.data.reviewRequired.value == true` with reasons `weight-and-balance` (+ `density_unverified`) / `import_gvp_mismatch`; summary contains "needs a qualified engineer"; plain rib with default purpose and a verified density: `value == false` | exact | CLI script |
| VC-KRN-22 | FR-KRN-25, TR-KRN-105 | faceted rib (fillet recipe under Manifold), agent caller | `export_step_ap242 {acceptUnverified: true}` → exit 1, `XCH_HUMAN_GATE` (04 export gate; `KRN_HUMAN_GATE` for a baseline accept), nothing saved; same act from the desktop UI (human caller) proceeds | exact | server unit + desktop test |
| VC-KRN-23 | FR-KRN-21, FR-KRN-22, TR-KRN-101, TR-KRN-102 | rib; `kernel_info` | `mass_properties` `.data.volumeUnit == "mm³"`, `.data.eps == {value: 1e-9, unit: "relative", source: …, defaulted: true}`, `.data.densitySource` present, `.data.provenance.method == "BRepGProp"`; `kernel_info` `.data.modelingTolerance.linear == {value: 1e-4, unit: "mm", source: "OCCT read.precision.val default", defaulted: true}` | exact | CLI script |
| VC-KRN-24 | FR-KRN-26, TR-KRN-106 | `nist_ctc_02_asme1_rc.stp` (largest measured read, 0.84 s native) | `import_step_exact … --dry-run --json` → `.changed == false`, document file byte-identical; `--progress` prints the import stages; with `LLULL_OCC_TIMEOUT_MS=1` (or a `--timeout` shorter than the import) → exit 1, nothing saved | exact | CLI script |
| VC-KRN-25 (**passed** 2026-10-19, OCCT 7.9.2) | FR-KRN-10, TR-KRN-02, TR-KRN-05 | the 10 analytic solids (`occt_crosscheck.json`), the probe cases (`occt_behaviour_probe.json`), the 28 NIST files (`nist_occt_reference.json`, solid level `nist_occt_solid_reference.json` + `nist_occt_solid_faces.json`) | native `llull-kernel` (OCCT 7.9.x) reproduces the OCP 7.9.3.1 reference: per NIST file the census (solids / shells / faces of the whole file) and the imported solid's faces / edges / vertices, `validAsRead` / `validAfterShapeFix` and max tolerance equal, volume / area / centroid / inertia equal to the reference; probe: fuzzy fuse 2 → 1 solids (12 → 10 faces), plate-minus-cylinder signature `1125f7464525c4f6` (7 faces), fillet history 1 generated / 4 modified, inertia error at 70 m at most the tabulated one | counts and validity exact; measures rel 1e-9 / centroid abs 1e-6 mm (VC-KRN-01 tolerances); signature equal if the build is the same 7.9.3 patch, else VC-KRN-10 cross-build mode (per-face area / centroid); read time not compared. Results: §6 | `server/tests/nativeKernelReference*.test.ts` (with the binary; NIST files from `fetch_nist_step_files.py`) + `npm run native:check` |

### 3.1 CLI form of the validation cases (AF-23)

Every VC runs unattended as a script: build with a plan, query with `--json`, compare with `expected_results.json`
(value, tolerance, unit) using exit codes only. Pattern (VC-KRN-03):

```bash
llull run docs/aerospace/01-exact-brep-kernel/validation/plans/krn-rib-pocket.json --validate --doc t.llull
llull run docs/aerospace/01-exact-brep-kernel/validation/plans/krn-rib-pocket.json --kernel occt --json --doc t.llull > run.json
RIB=$(jq -r '.data.steps[] | select(.command=="fillet_edge") | .affected[0]' run.json)
llull mass_properties entityId=$RIB --kernel occt --json --doc t.llull \
  | jq -e --slurpfile er docs/aerospace/01-exact-brep-kernel/validation/expected_results.json \
      '($er[0].cases[] | select(.vc=="VC-KRN-03") | .value.volume) as $v | ((.data.volume - $v) | fabs) <= 1e-9 * $v'
llull validate_shape "{\"entityIds\":[\"$RIB\"]}" --kernel occt --json --doc t.llull | jq -e '.data.results[0].valid'
llull check_model --json --doc t.llull | jq -e '[.data.issues[] | select(.severity=="fail")] | length == 0'
```

The other VCs follow the same shape: VC-KRN-01/02/03b (`mass_properties` per alias), VC-KRN-04..06
(`import_step_exact file=… --json`, assertions on `.data.report`), VC-KRN-07 (`run` renaming plan, then volume or
`KRN_BROKEN_REFERENCE`), VC-KRN-08 (`boolean … fuzzy`), VC-KRN-09/19 (`validate_shape`, `check_model`, codes),
VC-KRN-10 (`npm run quality:kernel`), VC-KRN-11 (`kernel_info --app`), VC-KRN-15/23 (`kernel_info`,
`set_modeling_tolerance`), VC-KRN-20..22/24 (rows above). VC-KRN-12/13 are display gates (Playwright), VC-KRN-18 a
server unit test of the kernel port.

Also reused, not duplicated: **the existing quality corpus** (`quality/corpus.json`, R27). In exact mode
(`import_step_exact`) every `step-import` entry must additionally pass: `validAfterHeal`, exact volume vs
`quality/step_reference.py` (rel 1e-6), and save/load round trip of the B-rep. Of special value to KRN:
`as1-pe-203` (large coordinates), `syn-far-from-origin` (1000 km offset — beyond the TR-KRN-10 envelope:
must import with a warning, not silently lose precision), `syn-inch-units`, `syn-hollow-cavity`,
`syn-bolt-grid` (400 instances → instancing), `syn-perforated-plate` (genus 100), `linkrods` (many fillets),
`kuka-kr600` / `rc-buggy-suspension` / `fc-raspberry-pi-4b` (stress tier: assembly performance).

**ABC dataset** (R22): optional `stress` tier — a pinned random sample of 1 000 STEP models from one chunk
(chunk URL + per-file sha256 to be recorded when the archive is reachable; TBD). Pass criterion: import rate
and validity rate reported per OCCT version (no absolute threshold until the first baseline is measured).

## 4. Derivations (analytic cases)

Notation: V volume, A area, inertia per unit density about the centroid (second moment of volume, mm⁵).
All formulas are standard closed forms for homogeneous solids.

- Box a×b×c: V = abc; A = 2(ab+bc+ca); Ixx = V(b²+c²)/12 (cyclic).
- Cylinder r, h (axis z): V = πr²h; A = 2πr² + 2πrh; Izz = Vr²/2; Ixx = Iyy = V(3r²+h²)/12.
- Tube rₒ, rᵢ, h: V = π(rₒ²−rᵢ²)h; A = 2π(rₒ²−rᵢ²) + 2π(rₒ+rᵢ)h; Izz = V(rₒ²+rᵢ²)/2; Ixx = V(3(rₒ²+rᵢ²)+h²)/12.
- Sphere r: V = 4πr³/3; A = 4πr²; I = 2Vr²/5.
- Cone r, h (base on z = 0): V = πr²h/3; A = πr² + πr√(r²+h²); centroid z = h/4; Izz = 3Vr²/10;
  Ixx (centroidal) = V(3r²/20 + 3h²/80).
- Torus R, r: V = 2π²Rr²; A = 4π²Rr; Izz = V(R² + 3r²/4); Ixx = V(R²/2 + 5r²/8).
- Plate with centred through hole (superposition, hole axis through the plate centroid, so no parallel-axis
  term): V = abt − πr²t; A = 2(ab+bt+ta) − 2πr² + 2πrt; I = I_plate − I_cyl(r, t).
- Rib pocket (vertical corner radius r_c, flat floor): pocket plan area S = p_w p_l − (4−π)r_c²; perimeter
  P = 2(p_w+p_l) − 8r_c + 2πr_c; V = abt − S·d; A = A_blank + P·d; centroid z = (V_blank t/2 − S d (t − d/2))/V;
  buy-to-fly = V_blank / V (definition: blank volume over finished volume).
  Numbers: 300×120×25 blank, 260×80 pocket, d = 20, r_c = 10 → S = 20 714.159265 mm², V = 485 716.814693 mm³,
  buy-to-fly = 1.852932; with p_w = 200 (pocket min corner fixed at x = 20) → S = 15 914.159265 mm², V = 581 716.814693 mm³.
  Renaming discriminator: stored point (280, 20, 15) → moved corner edge x = 220: 60 mm; outer top edges (y = 0 or x = 300,
  z = 25): √(20² + 10²) = 22.36 mm; so `edgesNear` picks a wrong edge (a pw 260 → 240 change would not discriminate:
  20 mm to the moved corner vs 22.36 mm).
- Large-coordinate cases: translation leaves V, A and centroidal inertia unchanged and shifts the centroid.

## 5. Measured findings that drive requirements

1. **Inertia far from origin** (`occt_behaviour_probe.json`): raw BRepGProp Iyy relative error grows with
   offset — 5e-16 at 0, 2.9e-13 at 1 m, 3.8e-11 at 10 m, **1.2e-9 at 70 m**, 1.2e-7 at 1 km. Moving the shape
   back by a `TopLoc_Location` does *not* help; copying the geometry to a local frame does (5e-16), and a part
   authored at the origin and placed by location gives 3.3e-14 → TR-KRN-41 (part-frame evaluation) and
   TR-KRN-70 (assemblies as located instances of origin-authored parts).
2. **Fuzzy booleans** close 1e-5 mm gaps that the plain BOP leaves as 2 solids → TR-KRN-12.
3. **Imported tolerances**: NIST files reach 0.1 mm sub-shape tolerance after reading (ctc_02 rc) → TR-KRN-24
   reporting; all 27 B-rep files are BRepCheck-valid with OCCT 7.9.3 and one (tessellated) has no B-rep.
4. **GVP disagreements**: 5 of 11 NIST files with GVP disagree with OCCT beyond 1e-4 — exact import must
   report GVP deltas instead of trusting either side (TR-KRN-23).
5. **Version skew**: llull's in-process OCC is opencascade.js 1.1.1 = OCCT 7.4.0p1 (2020, R11/R12) while the
   bundled CadQuery uses OCCT 7.9.3 (R13) → TR-KRN-02 / TR-KRN-61. RS1 ([../../../decisions/RS1-native-compute.md](../../../decisions/RS1-native-compute.md),
   2026-10-18) resolves it with a native OCCT 7.9 kernel process (`llull-kernel`) on desktop; the committed OCP
   7.9.3 measurements become its reference (VC-KRN-25).
6. **Whole file vs imported solid** (VC-KRN-25, `nist_occt_solid_reference.json`): `measure_step_brep.py` measures the whole
   transferred shape, which in 11 of the 27 B-rep files also holds loose shells / faces (1 to 18 faces) and in most files loose
   wires and points (PMI geometry): e.g. ctc_01 rd counts 468 edges / 433 vertices for the file, 390 / 256 for its solid, and the
   file's optimal bbox is 190 mm wider. `import_step_exact` keeps solids only, so VC-KRN-25 compares the census with the whole file
   and the imported solid with the solid-level reference. Measured at solid level, 4 of the 5 VC-KRN-04x "GVP disagreements" vanish:
   ctc_02 e2 3.5e-2 → 4.9e-9, stc_08 e3 2.3e-1 → 5.4e-9, ctc_05 rd 1.1e-2 → 5.6e-7, ctc_02 rc 1.6e-2 → 2.1e-5 (ctc_04 e2 7.5e-5 →
   9.4e-11); only ftc_07 e2 stays apart (factor 1.6e4, a GVP unit or scope issue). The loose faces of the file, not the solid, were
   what disagreed with the CAD system → VC-KRN-04x should be re-triaged at solid level (TR-KRN-23).
7. **Adaptive mass integration drifts** (VC-KRN-25): `BRepGProp::VolumeProperties` with an `Eps` (adaptive rule, 1e-12 in both
   llull kernels until 2026-10-19) is wrong on toroidal and some freeform faces while its error estimate stays near 1e-15: an
   arc-profile ring revolved about Z gets Ixx = 55.616 / Iyy = 55.586 instead of 55.6012 (2.7e-4, closed form by quadrature), the
   torus R40 r8 3e-11, the NIST files up to 1.6e-6 in volume (ctc_02 rc / e2) and 5e-7 in inertia with Ixx ≠ Iyy on the symmetric
   FTC-11 ring; tightening `Eps` makes it worse (1e-9: 2.3e-4, 1e-6: 2e-3 on FTC-11). The default (Gauss) rule of the reference
   gives the closed forms to 1e-14 and the CAD GVP of ctc_02 e2 to 4.9e-9 (adaptive: 1.2e-6) → the native kernel integrates with the
   default rule; the WASM kernel (`occtMass.ts`) still uses the adaptive one (follow-up).
8. **OCCT 7.9 reads AP242 tessellated geometry** (`read.step.tessellated` on by default): `nist_ftc_08_asme1_ap242-e4-tg.stp`
   transfers as a solid of 272 triangulated faces without surfaces (the reference's `Bnd_Box is void`). The native import now skips
   pieces whose faces have no surface and answers `tessellated_only` when nothing else is left (VC-KRN-05), as the 7.4 WASM reader.
9. **B-rep text blobs can lose validity**: stc_07 e3's healed solid is BRepCheck-valid, its `BRepTools::Write` text (V1 and V3)
   reads back invalid, on OCCT 7.4 (WASM) and 7.9.2 alike. Documents store that text (`occt-brep-v1`) → a TR-KRN-21 follow-up
   (full-precision or binary blobs, or re-heal after read).

## 6. VC-KRN-25 results (native `llull-kernel`, OCCT 7.9.2, 2026-10-19)

Suite: `server/tests/nativeKernelReference.test.ts` (analytic + probe) and `nativeKernelReferenceNist.test.ts` (NIST), run with
the release binary; the NIST files come from `fetch_nist_step_files.py` (R20 reachable from the build host; sha256 checked).
Import options are `import_step_exact`'s defaults (precision 1e-4 mm, max tolerance 0.1 mm, heal, sew). Worst deviations:

| Set | Cases | Counts / validity | Volume | Area | Centroid | Inertia |
| --- | ----- | ----------------- | ------ | ---- | -------- | ------- |
| analytic (`occt_crosscheck.json`) | 10 | 1 valid solid each | 7.5e-15 | 1.4e-16 | 1.5e-11 mm (at 70 m) | 1.6e-15; at 70 m 1.7e-16 vs closed form (the reference's own raw error there: 2.2e-9) |
| arc-profile revolution (closed form) | 1 | — | < 1e-12 | — | — | < 1e-12, Ixx = Iyy |
| NIST B-rep files | 27 | census, faces / edges / vertices, validity, max tolerance equal on all 27 | 1.6e-12 | 2.0e-12 | 4.0e-10 mm | 7.6e-13 (relative to the largest moment) |
| NIST tessellated file | 1 | `tessellated_only` | — | — | — | — |
| probe | 5 | fuzzy 0: 2 solids / 12 faces; plate − cylinder 7 faces, signature `1125f7464525c4f6` = reference, same in a second process; fillet: 1 generated (r 1) + 4 modified of 6 | — | — | — | Iyy at 0 … 1000 m: 1.7e-16 (reference raw 5e-16 … 1.2e-7) |

- **7.9.2 vs 7.9.3**: no deviation found. The C++ port of `measure_step_brep.py` linked against plain OCCT 7.9.2 reproduces every
  whole-file field of `nist_occt_reference.json` (OCP 7.9.3.1) bit for bit on all 27 files, signatures included, and the plate −
  cylinder signature is identical. The remaining differences come from llull's own pipeline: the healed solid is written to a
  B-rep text blob and read back (worst 1.6e-12 volume, stc_07 e3), and the per-face %.6f signature differs on 19 of 27 files
  only through values within 1e-15 of zero printed as -0.000000 vs 0.000000 and two areas at a 6th-decimal rounding boundary
  (ftc_08 e2): in cross-build mode every face's area and centroid are within tolerance on all 27 files.
- **Not runnable**: the fuzzy 2e-5 run (2 → 1 solids): the boolean `ShapeRecipe` has no fuzzy value on any kernel yet (TR-KRN-12);
  the test is a `todo`. Fillet history is read off the result faces (1 new cylindrical face r 1, 4 of 6 input faces changed),
  since `Generated` / `Modified` are not exposed by `KernelOps`.
- **Bounds**: the kernel's `bounds` (BRepBndLib::Add) enclose the reference's optimal box but are up to 2.6 mm larger (ftc_11 e3);
  VC-KRN-25 does not compare them.
- **Defects fixed on the way** (native, each with a Rust and a server test): mass properties now use the default Gauss rule
  (finding 7; `relError` is no longer reported by the native kernel), and tessellated-only STEP is refused as `tessellated_only`
  (finding 8).

