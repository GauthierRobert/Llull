# GDT — validation plan

Validation for gap GDT (GD&T, MBD, semantic PMI, stack-up, drawing integration). Every expected value
is (a) quoted from a cited source, (b) derived by a script in this folder, or (c) `TBD — measure with <tool>`.
Machine-readable expectations: `expected_results.json` (one entry per VC id).

## 1. Files

| File | What | How produced |
| --- | --- | --- |
| `nist_pmi_files.json` | pins of the NIST MBE PMI test files: the NIST zip (sha256 + size) and each of the 17 AP242 members, 11 AP203 geometry-only files and 11 PDF drawings; superseded 2024 hashes | downloaded 2026-10-15 from `usnistgov/SFA` Release (NIST), hashed locally |
| `generate_nist_pmi_census.py` | stdlib Part 21 parser: counts semantic + graphical PMI entity instances per file, verifies sha256 | `python3 -I generate_nist_pmi_census.py <NIST-PMI-STEP-Files.zip>` |
| `nist_pmi_census.json` | **which PMI each NIST file contains** (oracle for VC-GDT-20/23/24) | output of the script above |
| `generate_stackup_reference.py` | analytic WC / RSS / σ / exact-corner / exact probabilities + seeded Monte Carlo (seed 20261015, N = 200 000) for 5 stacks; fastener formulas | `python3 -I generate_stackup_reference.py` (≈ 2 s) |
| `stackup_reference.json` | its output (VC-GDT-30..36) | — |
| `generate_surface_texture_reference.py` | closed-form Ra, Rq, Rsk, Rku, Rz for sine / triangle / square profiles, numerically cross-checked | `python3 -I generate_surface_texture_reference.py` |
| `surface_texture_reference.json` | its output (VC-GDT-40) | — |
| `draft_plan_gdt_plate.json` | draft `build_project` plan: plate 120×80×12 with 4 × Ø6.6 holes and a Ø20 bore, datums A/B/C, sizes, 4 FCFs, surface texture, saved view, sheet with PMI, AP242 export | hand-written; geometry commands exist today, PMI commands are **proposed** (TECHNICAL_SPEC §4) |
| `draft_plan_gdt_rejections.json` | same part + 6 PMI actions of which 5 must be rejected (VC-GDT-03) | hand-written |
| `draft_plan_stackup_su01.json` | `analyze_stackup` call reproducing SU-01 | hand-written |
| `expected_results.json` | expected values + tolerance + unit + source per VC | assembled from the files above |
| `sources.md` | every external source, access mode and what was verified | — |

No NIST STEP file is committed (0.4–6.1 MB each; licence text not fetched): they are pinned by hash and
fetched by the future quality gate (`quality/corpus.json`, gate `step-pmi`), exactly like the existing
corpus entries.

## 2. Real use cases the validation mirrors

| Use case | Real-world basis | Validated by |
| --- | --- | --- |
| UC-1 Supplier MBD intake: receive an AP242 model with semantic PMI, list every requirement with its face, check it, put it on a drawing | Boeing D6-51991 §7.5 requires suppliers to extract manufacturing/inspection information from MBD datasets [R23] | VC-GDT-20, 23, 24 on NIST FTC 06 |
| UC-2 Author a toleranced machined part (datums, hole pattern position at MMC, flatness, profile) and release it as model + drawing | Y14.41 / ISO 16792 model + drawing method [R2][R4]; F-35 digital thread uses solids directly for NC/CMM [R24] | VC-GDT-01, 02, 05, 06, 10, 11 |
| UC-3 Exchange semantic PMI with other CAD/CAx through STEP AP242 and verify with NIST SFA | CAx-IF uses the NIST cases to test AP242 implementations [R12]; SFA checks PMI vs CAx-IF practices [R18][R11] | VC-GDT-20, 21, 22 |
| UC-4 Tolerance allocation of an assembly gap (bearing stack, spacer stack, pin/hole) | standard engineering practice; formulas derived in `generate_stackup_reference.py` | VC-GDT-30..36 |
| UC-5 AI agent tolerancing / auditing a part through MCP or the CLI | llull MCP/CLI surfaces (KI6) | VC-GDT-52 + golden agent transcript |

## 3. NIST MBE PMI test models — what each contains (census)

Source files: NIST zip "February 2026 Update" [R13]. Counts are AP242 instance counts produced by
`generate_nist_pmi_census.py` (rules in its docstring). Abbreviations: pos position, pSurf/pLine profile
of a surface/line, flat flatness, perp perpendicularity, par parallelism, ang angularity, cyl
cylindricity, str straightness, round roundness, conc concentricity, sym symmetry, cRun/tRun
circular/total runout. Modifier tokens are raw occurrences of the AP242 enumeration literal in the file
(tolerance **and** datum-reference modifiers): MMR maximum material requirement, LMR least material
requirement, F free state, T tangent plane, ST statistical tolerance, SEP REQT separate requirement.

| File id | AP242 ed. | GT total | Geometric tolerances by characteristic | Size / location dims | DATUM / DATUM_SYSTEM / placed datum targets | Modifier tokens | Saved views (CAMERA_MODEL_D3) | Annotation planes | ± / limits&fits | All-around |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ctc_01 | e1 | 6 | flat 1, perp 1, pos 2, pSurf 2 | 9 / 3 | 3 / 2 / 0 | — | 1 | 23 | 6 / 0 | 1 |
| ctc_02 | e2 | 22 | flat 1, pLine 1, perp 3, pos 4, pSurf 13 | 7 / 0 | 10 / 14 / 9 | LMR 7, MMR 5 | 3 | 46 | 7 / 0 | 0 |
| ctc_03 | e2 | 13 | ang 1, flat 1, perp 2, pos 6, pSurf 3 | 9 / 1 | 6 / 6 / 0 | MMR 4 | 1 | 29 | 8 / 0 | 0 |
| ctc_04 | e2 | 7 | pos 4, pSurf 3 | 7 / 3 | 8 / 5 / 0 | — | 1 | 27 | 7 / 0 | 0 |
| ctc_05 | e1 | 10 | cRun 3, conc 1, perp 2, round 1, str 1, tRun 2 | 1 / 5 | 4 / 5 / 2 | — | 2 | 7 | 2 / 0 | 0 |
| ftc_06 | e2 | 28 | flat 3, perp 2, pos 11, pSurf 12 | 14 / 10 | 10 / 12 / 6 | MMR 4 | 3 | 67 | 19 / 0 | 0 |
| ftc_07 | e2 | 27 | flat 1, par 1, perp 1, pos 12, pSurf 12 | 12 / 5 | 5 / 5 / 0 | MMR 4, ST 1 | 16 | 53 | 16 / 0 | 0 |
| ftc_08 | e2 | 33 | flat 3, par 5, perp 1, pos 13, pSurf 11 | 9 / 1 | 11 / 9 / 0 | F 5, MMR 18, T 3 | 12 | 52 | 9 / 0 | 6 |
| ftc_08-tg | e4-tg | 0 | — (tessellated geometry, graphic PMI only) | 0 / 0 | 0 / 0 / 0 | — | 4 | 8 | 0 / 0 | 0 |
| ftc_09 | e1 | 31 | flat 1, perp 4, pos 23, pSurf 3 | 14 / 8 | 8 / 8 / 0 | MMR 9, SEP REQT 2 | 23 | 7 | 21 / 0 | 3 |
| ftc_10 | e2 | 40 | cyl 2, flat 1, perp 6, pos 19, str 1, pSurf 10, sym 1 | 19 / 7 | 11 / 12 / 0 | LMR 1, MMR 5 | 18 | 91 | 23 / 3 | 2 |
| ftc_11 | e3 | 4 | cRun 1, flat 1, round 1, pSurf 1 | 5 / 1 | 2 / 1 / 0 | F 4 | 9 | 14 | 4 / 0 | 0 |
| stc_06 | e3 | 25 | flat 3, perp 2, pos 9, pSurf 11 | 14 / 3 | 6 / 9 / 0 | MMR 3 | 12 | 82 | 16 / 0 | 0 |
| stc_07 | e3 | 22 | flat 1, par 1, perp 1, pos 9, pSurf 10 | 41 / 4 | 5 / 5 / 0 | MMR 3, ST 1 | 4 | 17 | 13 / 0 | 0 |
| stc_08 | e3 | 30 | flat 3, par 5, perp 1, pos 9, pSurf 12 | 7 / 0 | 8 / 9 / 0 | F 5, MMR 12, T 3 | 4 | 44 | 7 / 0 | 5 |
| stc_09 | e4 | 27 | flat 1, perp 4, pos 19, pSurf 3 | 13 / 7 | 8 / 8 / 0 | MMR 8 | 4 | 58 | 20 / 0 | 3 |
| stc_10 | e2 | 37 | cyl 2, flat 1, perp 6, pos 17, str 1, pSurf 9, sym 1 | 25 / 2 | 9 / 12 / 0 | LMR 1, MMR 5 | 13 | 68 | 21 / 3 | 2 |

Observations used by the specs:
- Coverage: across the 17 files all 15 characteristics of FR-GDT-05 except coaxiality occur
  (`COAXIALITY_TOLERANCE` count 0) → coaxiality needs a llull-made test part (VC-GDT-21 round trip).
- Placed datum targets only in ctc_02, ctc_05, ftc_06; none in STC files — consistent with NIST's statement
  that STC drop datum targets [R12].
- `ftc_08-tg` has graphic PMI but no semantic PMI — consistent with the NIST README [R13]; a llull import
  must report 0 semantic items and not fail.
- Cross-check: ctc_01 counts (3 DATUM, 9 DIMENSIONAL_SIZE, 6 tolerances) equal an independent count by
  another project [R30].
- These files are explicitly "NOT reference STEP files without any errors" [R13]: a reader must be tolerant.
- NIST's own expected-PMI coverage table used by SFA (`SFA-PMI-NIST-coverage.csv`) is not in the public SFA
  release [R36]; the census above is the substitute oracle. The NIST PDFs in the zip (2017 drawings,
  hashed in `nist_pmi_files.json`) are the human reference for values.

## 4. Validation cases

Tolerances: lengths 1e-9 mm for analytic quantities, 1e-6 mm for B-rep measurements (OCC tessellation-free
analytic surfaces), counts exact; Monte Carlo per the 5σ statistical bounds listed in `stackup_reference.json`.

| VC | Proves | Input | Expected (summary) | Tolerance | Source |
| --- | --- | --- | --- | --- | --- |
| VC-GDT-01 | FR-01/02/04/05/06/07/09/14, TR-02/04/05 | `draft_plan_gdt_plate.json` (OCC) | 3 datums, 2 sizes (4X Ø6.6, Ø20), 4 FCFs, 1 texture, 1 saved view, `check_pmi` 0 errors; hole Ø 6.6 | counts exact; Ø 1e-6 mm | derived from plan geometry |
| VC-GDT-02 | FR-02, TR-06 | plate with thickness parameter t: 12 → 16 | all 10 PMI items + saved view resolve; Ø 6.6; 0 errors | exact / 1e-6 | derived |
| VC-GDT-03 | FR-04/06/11, TR-05/10 | `draft_plan_gdt_rejections.json` | 1 accepted, 5 rejected with codes DUPLICATE_DATUM, UNDEFINED_DATUM, MC_ON_NON_FOS, NON_POSITIVE_ZONE, point not on face | exact | TECHNICAL_SPEC §5.5 |
| VC-GDT-04 | FR-01/28 | each PMI command | input deep-equal before/after | exact | arch L3 |
| VC-GDT-05 | FR-03/10 | standard switch + note | stored, printed, idempotent | exact | — |
| VC-GDT-06 | FR-08, TR-04 | location dims on plate | 20.0 (plane→hole axis), 80.0 (plane→plane) | 1e-9 mm | derived |
| VC-GDT-07 | FR-22 (V1) | composite FCF + all-around | link stored, 0 errors, 1 ALL_AROUND_SHAPE_ASPECT on export | exact | §6.1 mapping |
| VC-GDT-08 | FR-23 (V1) | ISO 14405 Ⓔ | stored + rendered | exact | — |
| VC-GDT-09 | FR-24 | inch plate | Ø 0.259842519685 in | 1e-9 in | 6.6/25.4 |
| VC-GDT-10 | FR-15, TR-14 | plate sheet `pmiMode:'auto'` | TOP view holds the 4 hole/bore PMI; FRONT holds flatness, datum A, texture, datum C; RIGHT holds datum B + perpendicularity; fits | set equality | §5.3/5.8 |
| VC-GDT-11 | FR-15 | same | placed + skipped covers every PMI of shown solids | exact | KPI |
| VC-GDT-20 | FR-20/22, TR-15 (V1) | import of the 16 semantic NIST files | per category: imported + unattached + unmapped = census; CTC: unattached = 0 for tolerances | exact | `nist_pmi_census.json` |
| VC-GDT-21 | FR-21, TR-16 (V1) | export → re-import plate (+ a coaxiality part) | identical semantics | 1e-9 rel / exact | self-consistency |
| VC-GDT-22 | FR-21 (V1) | NIST SFA `sfa-cl` on export | 4 GT, 2 dims, 3 datums, 0 errors | TBD — measure with NIST SFA 5.51 | [R18] |
| VC-GDT-23 | FR-14/20 | saved views on import | = census CAMERA_MODEL_D3 | exact | census |
| VC-GDT-24 | FR-12/15/20 | production scenario on FTC 06 | 28 GT listed (census rule), no throw | census rule | census |
| VC-GDT-25 | FR-25 (V2) | graphic PMI export | visible in SFA viewer | TBD — measure with NIST SFA viewer | [R18] |
| VC-GDT-26 | FR-26 (V2) | TDP bundle | manifest with hashes | TBD | [R22] |
| VC-GDT-27 | FR-27 (V2) | zone visualisation | slab 0.05 mm | 1e-9 mm | FCF value |
| VC-GDT-30 | FR-16, TR-11 | SU-01 (normal, linear) | mean 0.15; WC [−0.09, 0.39]; RSS ±0.124096736; σ 0.041365579; P(gap<0) 1.43809451e-4 | 1e-9 mm; p 1e-12 | derived |
| VC-GDT-31 | FR-16 | SU-02 (uniform) | WC/RSS as SU-01; σ 0.071647284; exact P(gap<0) 1.2083333333e-2 (= 29/2400) (normal approx would say 1.8148e-2) | 1e-9; p 1e-12 | derived (Irwin–Hall) |
| VC-GDT-32 | FR-16 | SU-03 (unequal limits) | mean 0.024; WC [0.007, 0.041]; RSS ±0.012349089; P ≈ 2.765e-9 | 1e-9 | derived |
| VC-GDT-33 | FR-16/17 | SU-04 (sensitivity ½; test vector — radial errors modelled as symmetric normals, not a physical radial-error model) | mean 0.05; WC [−0.035, 0.135]; RSS ±0.044440972; P 3.68724955e-4; MC deterministic per seed | 1e-9; MC 5σ | derived |
| VC-GDT-34 | FR-16 | SU-05 (non-linear h = L sinθ) | linear WC [49.194250265, 50.805749735]; exact corners [49.193113654, 50.804590132]; RSS ±0.757401916; σ 0.252467305 | 1e-9 | derived |
| VC-GDT-35 | FR-19, TR-12 | FF-01..03 | floating T = 0.6; fixed T = 0.3; hole 6.6–6.9 pos Ø0.3 Ⓜ: 0.3 @MMC, 0.6 @LMC, 0.45 @6.75, VC 6.3 | 1e-12 | derived |
| VC-GDT-36 | FR-18 | stack with contributor `pmiId: boreSize` | = SU-03; after bore upper 0.025: WC max 0.045 | 1e-9 | derived |
| VC-GDT-40 | FR-09 | ideal profiles | e.g. sine A=0.8 µm: Ra 0.509295818, Rq 0.565685425, Rku 1.5, Rz 1.6 | 1e-4 µm | closed forms |
| VC-GDT-50 | FR-29, TR-17 | save/load, undo, golden replay | identical | exact | — |
| VC-GDT-51 | FR-30 | Manifold kernel | no-op "requires the OCC kernel" | exact | KI5 |
| VC-GDT-52 | FR-28, TR-17 | tool schemas, MCP toolset `pmi`, CLI `describe` | all PMI commands present on all surfaces | exact | arch L5 |
| VC-GDT-53 | FR-13/14 | `PmiPanel` component test | dispatch with `facesNear` from picked point | exact | rules/react.md |

## 5. FR → VC traceability

| FR | VC | FR | VC | FR | VC |
| --- | --- | --- | --- | --- | --- |
| FR-GDT-01 | 01, 04, 50 | FR-GDT-11 | 03 | FR-GDT-21 | 21, 22 |
| FR-GDT-02 | 01, 02 | FR-GDT-12 | 24 | FR-GDT-22 | 07, 20 |
| FR-GDT-03 | 05 | FR-GDT-13 | 10, 53 | FR-GDT-23 | 08 |
| FR-GDT-04 | 01, 03 | FR-GDT-14 | 01, 23, 53 | FR-GDT-24 | 09 |
| FR-GDT-05 | 01, 20 | FR-GDT-15 | 10, 11, 24 | FR-GDT-25 | 25 |
| FR-GDT-06 | 01, 03, 20 | FR-GDT-16 | 30–34 | FR-GDT-26 | 26 |
| FR-GDT-07 | 01 | FR-GDT-17 | 33 | FR-GDT-27 | 27 |
| FR-GDT-08 | 06 | FR-GDT-18 | 36 | FR-GDT-28 | 04, 52 |
| FR-GDT-09 | 01, 40 | FR-GDT-19 | 35 | FR-GDT-29 | 50 |
| FR-GDT-10 | 05 | FR-GDT-20 | 20, 23, 24 | FR-GDT-30 | 51 |

## 6. Verification tools

- **NIST STEP File Analyzer and Viewer (SFA) 5.51** [R18]: Windows build; command-line `sfa-cl.exe`
  generates the spreadsheet with semantic PMI, graphic PMI and validation property reports; used in a
  Windows CI job on llull's AP242 exports (VC-GDT-22) and manually on imports. Not redistributed by llull.
- **Census script** (this folder): cross-platform, stdlib-only pre-check; run it on llull's own AP242
  exports too (the counts of the plate are then 4 GT, 2 DIMENSIONAL_SIZE, 3 DATUM).
- **OCC XCAF via OCP** (desktop Python): reader behind the PMI stage of `import_step_exact` (gap 01 command, AP242 PMI transport by gap 04); the same reader re-imports
  exports for VC-GDT-21.

## 7. How to regenerate

```bash
cd docs/aerospace/03-gdt-mbd-pmi/validation
python3 -I generate_stackup_reference.py
python3 -I generate_surface_texture_reference.py
mkdir -p /tmp/nist && curl -sSL -o /tmp/nist/NIST-PMI-STEP-Files.zip \
  "$(python3 -c 'import json;print(json.load(open("nist_pmi_files.json"))["zip"]["url"])')"
python3 -I generate_nist_pmi_census.py /tmp/nist/NIST-PMI-STEP-Files.zip
```
If NIST publishes a new zip, the script reports the zip hash mismatch and checks members one by one;
update `nist_pmi_files.json` deliberately (keep the old hashes under `supersededMirror2024` or a new
`superseded` list) and re-run.

References [Rn]: see `../FUNCTIONAL_SPEC.md` §11 and `sources.md`.
