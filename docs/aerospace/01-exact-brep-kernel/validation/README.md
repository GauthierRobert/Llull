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
| VC-KRN-14 | FR-KRN-13, TR-KRN-80 | rib (VC-KRN-03) and NIST CTC 01 modified part | `export_step_exact` writes GVP; re-import GVP delta ≤ 1e-6 relative (volume, area), ≤ 1e-6 mm centroid | as stated | production scenario |
| VC-KRN-15 | FR-KRN-14, FR-KRN-15, TR-KRN-61 | save/load a document; `set_modeling_tolerance` | saved file carries `kernelSettings.occtVersion` + build; load under another version → provenance warning; `linear: 1` (mm) rejected (range [1e-7, 1e-2]); import uses the document precision when the file has none | exact | unit + server |
| VC-KRN-16 | FR-KRN-16 | fillet recipe loaded under Manifold (capability gap) | entity flagged `faceted`; `check_model` reports `faceted_result`; `export_step_exact` refuses without explicit acceptance | exact | unit |
| VC-KRN-17 | FR-KRN-17 | registry | every KRN command in `toToolSchemas()` snapshot, CLI help, happy + failure unit tests, `is pure` test | exact | contract tests |

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
   bundled CadQuery uses OCCT 7.9.3 (R13) → TR-KRN-02 / TR-KRN-61.
