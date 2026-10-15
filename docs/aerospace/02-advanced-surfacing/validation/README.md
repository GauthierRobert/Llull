# SRF — Validation pack

Proves a future implementation of [FUNCTIONAL_SPEC.md](../FUNCTIONAL_SPEC.md) / [TECHNICAL_SPEC.md](../TECHNICAL_SPEC.md).
"Validated" = every `VC-SRF-*` below passes in an automated gate on the **desktop OCC kernel** (and the core-only
cases also on Manifold/web), with reference data pinned here or by URL + sha256.

## 1. Contents

| File | What | How produced |
| --- | --- | --- |
| `generate_naca.py` | NACA 4-digit / 5-digit (230 mean line) generator + UIUC `.dat` parser (Selig/Lednicer) + max/RMS deviation, raw and after chord normalisation | hand-written from [S2] [S4] [S5] equations; `python3 -I generate_naca.py [--uiuc-dir DIR]` |
| `generate_analytic_refs.py` | Curvature (sphere/cylinder/torus) with finite-difference self-check, continuity joints G0–G3, Liming rho-conics, wing planforms (TR-1208, trapezoid + NACA 0012 volume), Sears–Haack body | `python3 -I generate_analytic_refs.py` (stdlib only) |
| `make_plans.py` | Draft `build_project` plans (one runnable today, four for proposed commands) | `python3 -I make_plans.py` |
| `data/naca_{0012,2412,23012}_selig_81.csv`, `data/naca_0012_closed_te_selig_81.csv` | 81 cosine stations per surface, Selig order, chord 1 | `generate_naca.py` |
| `data/naca_uiuc_comparison.json` | Generator vs pinned UIUC files (sha256, format, max/RMS deviation) | `generate_naca.py --uiuc-dir` |
| `data/curvature_analytic.json`, `continuity_cases.json`, `conic_cases.json`, `wing_planforms.json`, `sears_haack.json` | Analytic reference datasets | `generate_analytic_refs.py` |
| `plans/baseline_trap_wing_loft_sections.json` | **Runs on today's llull**: NACA 0012 trapezoidal wing via `loft_sections` (ruled) + `mass_properties` | `make_plans.py` |
| `plans/target_*.json` | Same intents with proposed commands (`airfoil_from_naca`, `create_wing`, `wing_properties`, `analyze_surface_curvature`, `analyze_draft`, `loft_fuselage`) | `make_plans.py` |
| `expected_results.json` | Every VC with value, tolerance, unit, derivation/source | hand-written from the datasets |
| `reference_files.json` | Pinned external files (URL at a commit, sha256, size, licence) | computed 2026-10-15 |
| `sources.md` | Every external source with access method and what was verified | — |

Regenerate everything: `cd docs/aerospace/02-advanced-surfacing/validation && python3 -I generate_naca.py && python3 -I generate_analytic_refs.py && python3 -I make_plans.py`.

## 2. Real use cases

| # | Use case | Public data | Benefit (sourced) | VCs |
| --- | --- | --- | --- | --- |
| UC1 | **NACA section families** for wings and tails of GA/UAV/transport aircraft | UIUC database [S6] (mirror [S7]), NASA generator programs [S3] [S4] | Sections reproduced to the reference ordinates instead of re-traced; NASA published generator programs precisely so ordinates are computed, not copied [S3] | 01–04, 09 |
| UC2 | **Conceptual wing in OpenVSP-style parameters** — NACA TR-1208 45° swept wing (Langley 1950s), used by the OpenVSP API tutorial | Planform table [S9]; `.vsp3` [S8] | OpenVSP was created to bridge full CAD and rebuild-from-scratch for every geometry change [S11]; llull adds exact B-rep + STEP | 10, 20, 28 |
| UC3 | **Transonic transport wing quality check** — NASA Common Research Model | IGES/STEP [S14]; reference values [S15] [S16] [S17] | The CRM exists to give the community a public modern supercritical wing with experimental data [S17]; checking curvature/continuity on it exercises a real OML | 12 |
| UC4 | **Fuselage lofting by stations / conics** — Liming conic method (NAA, P-51 heritage) | Liming book/paper [S18] [S19]; secondary [S20]; FS/BL/WL convention [S21] | Conics give a geometrically controlled fair curve instead of trial-and-error fairing [S19 abstract via search] | 07, 13, 14, 29 |
| UC5 | **Digital OML definition and surface QA** before release (Boeing 777 class of process) | Boeing 1997 release [S25] | "100-percent digitally designed and preassembled on a computer", eliminating a costly full-scale mock-up [S25] | 05, 06, 15–18, 21 |

## 3. Validation cases

Tolerances and values are in `expected_results.json` (authoritative); summary here.

| VC | Proves | Setup | Expected | Tol | Source / derivation | Gate |
| --- | --- | --- | --- | --- | --- | --- |
| VC-SRF-01 | FR-10, FR-11 | `airfoil_from_naca 0012` open TE vs pinned `naca0012.dat`, `n0012.dat` | max dev 0 (script measured 1e-7 / 0) | 1e-6 c | generator [S2]; files [S7] | unit (fixture download) |
| VC-SRF-02 | FR-11 | `23012` vs `naca23012.dat` | measured 9.2e-6 c | 2e-5 c | [S5] constants | unit |
| VC-SRF-03 | FR-10, FR-12 | `import_airfoil naca2412.dat normalize:'chord'` vs `airfoil_from_naca 2412` | raw 1.29e-3 c (reported, not a failure); normalised 1.58e-4 c | 2e-4 c | measured; convention difference | unit |
| VC-SRF-04 | FR-10 | parse `e205_Selig.dat`, `clarky_Lednicer.dat`, OpenVSP `n0012.dat`, UIUC files | format, counts, first point | exact | file contents [S8] [S7] | unit |
| VC-SRF-05 | FR-21 | sphere R 10, cylinder R 5, torus R 5 / r 2 at listed (u,v) | K, \|H\| closed form | 1e-6 rel | [S26]; FD check in data | unit (core) + server (OCC SLProps) |
| VC-SRF-06 | FR-20, FR-22 | 6 analytic joints (`continuity_cases.json`) built as NURBS curves | G0, G1, G2, G3, G3, G1; gaps 0.2, 6.0, 0.1 | exact / 1e-6 | analytic | unit |
| VC-SRF-07 | FR-01, FR-18 | `create_conic` rho ∈ {√2−1, 0.3, 0.5, 0.7} | weights, shoulders; quarter-circle radius error 0 | 1e-12 | w = rho/(1−rho) | unit |
| VC-SRF-08 | FR-01..03 | random NURBS: knot insertion, degree elevation, interpolation | shape change 0; residual 0 | 1e-12 | B-spline properties [S1] | unit |
| VC-SRF-09 | FR-13 | `airfoil_properties` NACA 0012 | tmax 0.120035 @ 0.2998, TE 0.00252, r_LE 0.015867, area 0.08221 | see JSON | generator | unit |
| VC-SRF-10 | FR-14, FR-15 | `plans/target_tr1208_wing.json` | area 2024.3535 in², MAC 16.6701 in, AR 8.000 (published 2024.35 / 16.672 / 8.02) | 0.01 / 0.005 / 0.03 | trapezoid formulas; [S9] | golden |
| VC-SRF-11 | FR-05, FR-14, FR-15 | `plans/target_naca0012_trap_wing.json` | V = 0.959117 m³ (half wing, open TE) | 1e-4 rel | V = A·b(cr²+cr·ct+ct²)/3 | golden (OCC) |
| VC-SRF-12 | FR-21, FR-22, FR-25, FR-27 | CRM STEP import → curvature grid on wing upper skin, continuity of internal edges | golden recorded on first run; span 58.76 m ± 0.1 % (full scale) | TBD | [S14] [S16] | `npm run quality` |
| VC-SRF-13 | FR-17 | `plans/target_sears_haack_conic_fuselage.json` (19 stations + apexes) | V = 4.626377 | 0.5 % (confirm) | 3π²R²L/16 | golden (OCC) |
| VC-SRF-14 | FR-17, FR-18 | same body, conic halves rho = √2−1 vs circular stations | identical sections and volume | 1e-9 | conic identity | unit + golden |
| VC-SRF-15 | FR-06 | fill 3/4/5-sided holes on a filleted box corner, G1 | G0 ≤ 1e-4, G1 ≤ 0.01 rad | bounds | OCC defaults [S12] | server |
| VC-SRF-16 | FR-08 | sew two lofted wing segments | 0 free edges, 1 solid, V = ΣV | 1e-6 rel | — | server |
| VC-SRF-17 | FR-24 | cone r1 5, r2 3, h 10; pull +Z | lateral draft 11.309932° | 0.01° | atan(0.2) | server |
| VC-SRF-18 | FR-25 | sphere R 10 vs points on R 10.5 | max = mean = rms = 0.5 | 1e-6 | — | server |
| VC-SRF-19 | FR-16, FR-26 | all SRF commands via UI dispatch, CLI, MCP; `is pure`; schema snapshot | identical replay | exact | W3 contract | unit/integration |
| VC-SRF-20 | FR-30 | `import_openvsp_wing` on pinned `TR1208.vsp3` | semi-span 63.63, root 16.672, tip 7.5024, total area 1538.2171 in² | 1e-4 | file values [S8] | unit |
| VC-SRF-21 | FR-27, FR-28 | conceptual wing (23012 root / 0012 tip, 35° sweep, 5° dihedral, −3° washout) → STEP → reimport | B-spline faces kept; volume change 0 | 1e-6 rel | — | production gate |
| VC-SRF-22 | FR-05 | loft v3 through NACA sections; sample input sections vs result | max dev 0 | 1e-5 c | TR §5.5 | server |
| VC-SRF-23 | FR-07 | trim 10×10 planar sheet by circle r 3 | area 28.274334 | 1e-6 | πr² | server |
| VC-SRF-24 | FR-09 | thicken hemisphere sheet R 10 by 1 outward | V = 693.244779 | 1e-5 rel | ⅔π(11³−10³) | server |
| VC-SRF-25 | FR-04 | `surface_from_points` 21×21 torus grid | grid residual 0; mid-cell dev recorded | 1e-9 | interpolation | unit |
| VC-SRF-26 | FR-29 | Manifold kernel | core queries work; kernel ops refuse | exact | KI5 | unit |
| VC-SRF-27 | FR-23 | overlays on/off | document unchanged; legend = data range | exact | — | component |
| VC-SRF-28 | FR-14, FR-16 | edit sweep 0 → 30° on a constant-chord wing (taper 1; with taper ≠ 1 give the sweep at `sweepLocation` 0) | area unchanged; LE sweep 30° | 1e-9 | shear | golden |
| VC-SRF-29 | FR-19 | conic master-line loft | TBD (needs public loftsman example) | TBD | [S18] [S19] paywalled | — |
| VC-SRF-30 | FR-28 | `plans/target_naca0012_trap_wing.json`, then `export_code language=cadquery`; run the script with bundled CadQuery/OCP | script runs; V = 0.959117 m³ | 1e-4 rel | same derivation as VC-SRF-11 | server (Python oracle) |

FR ↔ VC coverage: FR-01 (07, 08) · FR-02 (08) · FR-03 (08) · FR-04 (25) · FR-05 (11, 22) · FR-06 (15) · FR-07 (23)
· FR-08 (16) · FR-09 (24) · FR-10 (01, 03, 04) · FR-11 (01, 02) · FR-12 (03) · FR-13 (09) · FR-14 (10, 11, 28) ·
FR-15 (10, 11) · FR-16 (19, 28) · FR-17 (13, 14) · FR-18 (07, 14) · FR-19 (29) · FR-20 (06) · FR-21 (05, 12) ·
FR-22 (06, 12) · FR-23 (27) · FR-24 (17) · FR-25 (12, 18) · FR-26 (19) · FR-27 (12, 21) · FR-28 (21, 30) · FR-29 (26) ·
FR-30 (20) · FR-31 (19) · FR-32 (11, `set_units` unit tests) · FR-33 (19, failure tests) · FR-34 (12, perf budgets TECHNICAL §8) · FR-35 (19, schema snapshot).

TR ↔ VC coverage: see TECHNICAL_SPEC §9.1 (TR-SRF-01..11); `expected_results.json` lists the TR ids per case in `proves`.

## 4. Findings from the reference scripts (already measured)

1. **NACA generator vs UIUC** (`data/naca_uiuc_comparison.json`): `naca0012.dat` 1e-7 c (7-decimal rounding),
   `n0012.dat` 0, `naca23012.dat` 9.2e-6 c (5 decimals) — the equations in TECHNICAL_SPEC §5.3 are right.
2. **`naca2412.dat` (Lednicer naca.exe) is not the raw analytic section**: 1.29e-3 c raw deviation; the offset
   is nearly linear from TE (≈ 0) to LE (≈ −1.5e-3), i.e. the file is consistent with the section rotated ≈ 0.0014 rad
   about the TE (best-fit residual 8.2e-5 c). After normalising both to "LE = farthest point from TE" the deviation
   is 1.58e-4 c. Conversely, normalising `naca23012.dat` *worsens* its match (4.1e-3 c), so normalisation must be
   **optional and explicit** (FR-SRF-12). This is a real import pitfall, now a test (VC-SRF-03).
3. **Today's 24-point resampling** (`SECTION_RING_POINTS`): an arc-length 24-gon of NACA 0012 has −2.02 % section
   area and 0.0109 c max deviation (linear estimate; llull's Catmull-Rom rings reduce but do not remove this and
   round the TE). Measure the real baseline with `plans/baseline_trap_wing_loft_sections.json`
   (`llull run plans/baseline_trap_wing_loft_sections.json --doc /tmp/w.llull.json --kernel occt --json`, then compare the `mass_properties` volume with 0.959117 m³; repeat with `--kernel manifold`) — **TBD, not run here: the
   CLI needs `npm install` (esbuild missing in this sandbox)**.
4. **`TR1208.vsp3` ≠ its README table**: the file stores root chord 16.672 in (= the README MAC) and tip 7.5024 in;
   total area 1538.217 in² vs 2024.35 in² in the table. Import tests use the file's own values (VC-SRF-20), planform
   tests use the table (VC-SRF-10).
5. Torus/sphere/cylinder closed forms agree with a finite-difference evaluation of the parametric surface to
   < 5e-9 (see `fd_check` fields), so the datasets are self-consistent.

## 5. How a future implementation runs this pack

- `tests/unit/aero/naca.test.ts` reads `data/naca_*_selig_81.csv` (exact), and — when the fixture script
  `scripts/fetch-srf-fixtures.mjs` (to be written) has downloaded `reference_files.json` entries into
  `tests/fixtures/srf/` with sha256 verified — the UIUC/OpenVSP files.
- `tests/unit/surface/curvature.test.ts` iterates `data/curvature_analytic.json`; `continuity.test.ts` iterates
  `continuity_cases.json`; `conic.test.ts` iterates `conic_cases.json`.
- `tests/golden/plans.ts` imports `plans/target_*.json` once the commands exist; snapshots + replay equality.
- `server/tests/occtSurfacing.test.ts` checks OCC-side values with the same JSON, plus a CadQuery/OCP oracle.
- `npm run quality` adds the CRM case once its STEP sha256 is pinned (first CI download).
