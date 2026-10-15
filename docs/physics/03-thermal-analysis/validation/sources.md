# PHY-03 Thermal analysis: external sources

All entries were accessed on **2026-10-15**. The **Access** column says how each one was checked:

- **git**: the repository was cloned through the session's git proxy, the files were read, and the commit is pinned.
- **pypi**: package metadata and the wheel came from pypi.org and the files inside were read.
- **search**: only the text a web search returned was seen. Direct fetches of these hosts failed (DNS failure in
  WebFetch, or `403` from the egress proxy for `curl`). A human must re-check the page before the value is frozen.

**Grade** follows `docs/physics/README.md` §6.3: **A** = quoted by ≥ 2 independent sources, or derived exactly in
`generate_thermal_reference.py`; **B** = one secondary source (reported, not a pass/fail gate); **C** = source exists,
value not confirmed (never a threshold).

| Id | Source | Publisher / licence | URL | Access | What was verified | Grade of what we use |
| -- | ------ | ------------------- | --- | ------ | ----------------- | -------------------- |
| S1 | Abaqus Benchmarks Guide, "T3: One-dimensional transient heat transfer" and "T4: Two-dimensional heat transfer with convection" | Dassault Systèmes (university mirrors) | https://docs.software.vt.edu/abaqusv2024/English/SIMACAEBMKRefMap/simabmk-c-t3.htm ; https://ceae-server.colorado.edu/v2016/books/bmk/ | search | T3 target 36.60 °C at x = 0.08 m, t = 32 s; k = 35.0 W/m°C, cp = 440.5 J/kg°C, ρ = 7200 kg/m³; end A 0 °C, end B 100 sin(πt/40) °C; 5-element mesh; DC1D2 34.54 / 35.51 °C (coarse / fine), DC1D3 35.88 / 36.09 °C. The T4 page was listed but not read. | A (with S2, S3, S4) |
| S2 | MOOSE heat transfer module, NAFEMS T3 verification page source and inputs (`modules/heat_transfer/doc/content/modules/heat_transfer/nafems_t3_verif.md`, `test/tests/NAFEMS/transient/T3/*.i`, gold CSVs) | Idaho National Laboratory; LGPL-2.1 | https://github.com/idaholab/moose (commit 1d086a353a1b04f6425f2fe51a114a99a081bc1d) | git | Bar length 0.1 m, cross-section 0.01 × 0.01 m; initial 0 °C; left 0 °C, right 100 sin(πt/40) °C; k 35.0, cp 440.5, ρ 7200; reference 36.6 °C at 0.08 m, t = 32 s; results table EDGE2/QUAD4/HEX8 coarse 40.3 (+10.1 %), fine 36.9 (+0.8 %); quadratic elements coarse 35.9 (−1.9 %), fine 36.1 (−1.4 %); `dt = 1` s. | A |
| S3 | FeenoX tests and docs (`tests/nafems-t1.fee/.geo`, `nafems-t2-1d.fee`, `nafems-t3-1d.fee`, `nafems-t4.fee/.geo`, `tests/nafems-t1-4.sh`, `tests/nafems-t2-3.sh`, `doc/nafems-le11.*`, `tests/nafems-le11.sh`) | J. Theler / Seamplex; GPL-3.0 | https://github.com/seamplex/feenox (commit 3759eb2426a9e9a77ab8a9ce97db93071a389776) | git | T3 test accepts 36.6 ± 0.05; T4: 0.6 × 1.0 m, k = 52, AB T = 100 °C, DA adiabatic, BC and CD h = 750 W/m²°C to 0 °C, test answer 18.3 at (0.6, 0.2); T2 statement: slab 0.1 m, k = 55.6 W/(m K), ε = 0.98, T0 = 1000 K, T∞ = 300 K, test compares with the analytic root; comment "sigma = 5.67e-8 as in the problem" and uses 5.670374419e-8. (T1 and LE11 are used by PHY-04.) | A (T3, T4 with S1/S4); B (T2 statement, single source, value derived) |
| S4 | FEATool Multiphysics examples `ex_heattransfer3.m` (T3), `ex_heattransfer4.m` (T4) | Precise Simulation; proprietary licence (values cited, no file copied) | https://github.com/precise-simulation/featool-multiphysics (commit 1fca801ad3c54cf7e2c90b0bf3c2e21255e4bcef) | git | T3 code: L = 0.1, ρ 7200, cp 440.5, k 35, `tmax` 32, sine at x = 0, `T_ref = 36.6` evaluated at x = 0.02 (= 0.08 from the cold end). The header text says "L = 0.02 m" and "t = 36": it contradicts the code and is ignored. T4: 0.6 × 1 m, ρ 7850, cp 460, k 52, h 750, `T_ref = 18.3` at (0.6, 0.2); reference cited as Cameron, Casey, Simpson, *Benchmark Tests for Thermal Analysis*, NAFEMS 1986. | A (with S1–S3) |
| S5 | Altair OptiStruct verification OS-V:0110 One Dimensional Transient Heat Transfer | Altair | https://help.altair.com/hwsolvers/os/topics/solvers/os/nafems_test_problem_t3_r.htm | search | Results normalised by 36.60 °C; coarse CBEAM / Quad4 33.6 °C, Quad8 coarse 35.1 °C. | B (supporting only) |
| S6 | COMSOL Application Library `heat_convection_2d` (NAFEMS T4) | COMSOL | https://doc.comsol.com/6.4/ | search (gap-list extract, not re-searched) | 18.25 °C quoted in `docs/physics/README.md` §2. Not re-seen in this session. | C (note only) |
| S7 | CalculiX CrunchiX source (`src/calinput.f`), User's Manual (`doc/CalculiX.tex`), test suite (`test/*.inp`, `*.ref`) | G. Dhondt; GPL-2.0 | https://github.com/Dhondtguido/CalculiX (commit fd588701edd6a92fde06e99b1bdf01f3b0f80f2c) | git | Keywords and parameters: `*HEAT TRANSFER` (SOLVER, DIRECT, STEADY STATE, FREQUENCY, MODAL DYNAMIC, STORAGE, DELTMX, TIME RESET, TOTAL TIME AT START; transient needs specific heat; DELTMX default 1e30), `*FILM` (q = h(T − T0), label Fx, sink then h; FxFC forced convection; FxNUy user), `*RADIATE` (q = εσ(θ⁴ − θ0⁴), diffuse grey; Rx sink, ε; RxCR cavity radiation, negative absolute environment temperature closes the cavity and scales view factors to 1; CAVITY parameter ≤ 3 characters; requires `*PHYSICAL CONSTANTS`), `*DFLUX` (Sx surface flux, BF body flux, flux entering positive), `*CFLUX` (DOF 11), `*GAP CONDUCTANCE` (table of conductance vs contact pressure and temperature; heat flows only at contact spring elements), `*VIEWFACTOR` (READ/WRITE/WRITE ONLY/NO CHANGE/INPUT/OUTPUT; file `jobname.vwf`), `*PHYSICAL CONSTANTS, ABSOLUTE ZERO=…, STEFAN BOLTZMANN=…` (manual example 5.669E-8 in SI), `*CONDUCTIVITY` / `*SPECIFIC HEAT` (temperature tables, TYPE=ISO/ORTHO/ANISO), `*INITIAL CONDITIONS, TYPE=TEMPERATURE`, `*BOUNDARY` DOF 11 for prescribed temperature, output keys NT, RFL (nodal), HFL (integration point). Units table: cp 1 J/(kg K) = 1e6 mm²/(s² K); conductivity 1 W/(m K) = 1 N/(s K); film 1 W/(m² K) = 1e-3 N/(mm s K); density 1 kg/m³ = 1e-12 N s²/mm⁴. **No `*LATENT HEAT` keyword** exists: `calinput.f` dispatches no such card and the manual has no section; "latent" does not occur in the manual. Thermal test decks exist: `oneel8ra` (`*RADIATE`), `axrad`, `axrad2`, `furnace`, `beamhtcr` (cavity radiation), `contact7/8/9` (`*GAP CONDUCTANCE`), `thermomech`, `beamhtfc` (forced convection). | A (syntax) |
| S8 | J. R. Howell, *A Catalog of Radiation Configuration Factors* (web edition), entries C-11 (identical parallel directly opposed rectangles, X = a/c, Y = b/c; Hottel 1931; Hamilton and Morgan), C-14, C-41 | J. R. Howell (UT Austin) | https://thermalradiation.net/calc/sectionc/C-11.html | search | Catalogue entry and its parameters. The formula itself sits in a Word download that could not be reached. The closed forms in the generator are the classical Hottel expressions (S9) and are proven by an independent quadrature of the defining integral (agreement 1e-12) and by the cube summation rule. | A (by derivation) |
| S9 | J. H. Lienhard IV, J. H. Lienhard V, *A Heat Transfer Textbook*, 6th ed., v6.00 (2024), free PDF | Phlogiston Press / MIT (download allowed for personal use) | https://ahtt.mit.edu/ | search (PDF fetch refused by the proxy) | Book exists and is free. Formulas used (plane wall resistances, generation, erf solution, lumped capacitance, fin efficiency, grey-body exchange, view-factor algebra, Stefan problem) are standard textbook results; each is implemented and checked in the generator. Equation numbers are **not** cited because the PDF was not read. | A (by derivation) |
| S10 | NAFEMS, *The Standard NAFEMS Benchmarks*, TNSB Rev. 3 (1990); A. D. Cameron, J. A. Casey, G. B. Simpson, *Benchmark Tests for Thermal Analysis*, NAFEMS (1986) | NAFEMS (paid) | https://www.nafems.org/publications/resource_center/ | search (catalogue) | Titles only, as cited by S2 and S4. No clause or figure content used. | catalogue |
| S11 | SI defining constants (9th SI Brochure): h = 6.626 070 15 × 10⁻³⁴ J s, c = 299 792 458 m/s, k_B = 1.380 649 × 10⁻²³ J/K | BIPM | https://www.bipm.org/en/publications/si-brochure | search | h confirmed in a BIPM report extract. k_B was not re-seen in this session (the search returned only the 2017 draft value); the generator's σ = 5.670 374 419 × 10⁻⁸ equals the value FeenoX (S3) quotes, an independent check. | A (derived + S3) |
| S12 | pyViewFactor 1.1.0 | AREP; MIT | https://pypi.org/project/pyviewfactor/ ; https://gitlab.com/arep-dev/pyViewFactor/ | pypi | Wheel read: polygon-to-polygon view factors with a semi-analytic contour kernel, BVH obstruction, optional Numba. Candidate cross-check for TR-THM-20 (not bundled). | — (tool) |
| S13 | Abaqus Benchmarks Guide 1.6.5 "Two-dimensional elemental cavity radiation view factor calculations" | Dassault Systèmes | https://ceae-server.colorado.edu/v2016/books/bmk/ch01s06ach57.html | search | Title only. | — |

## Citation id mapping (specs [Rn] ↔ register [Sn])

| Spec | Register | | Spec | Register |
| ---- | -------- | - | ---- | -------- |
| R1 | S1 | | R8 | S8 |
| R2 | S2 | | R9 | S9 |
| R3 | S3 | | R10 | S10 |
| R4 | S4 | | R11 | S11 |
| R5 | S5 | | R12 | S12 |
| R6 | S6 | | R13 | S13 |
| R7 | S7 | | | |

## Findings that change the gap list

- **NAFEMS T4 rounding is settled analytically.** The separation-of-variables series gives 18.2538 °C at (0.6, 0.2) m;
  NAFEMS / FeenoX / FEATool round it to 18.3 and COMSOL to 18.25. VC-THM-04 uses the analytic value with a 1 % band.
- **NAFEMS T3 is reproduced analytically**: 36.6031 °C, so the quoted 36.60 is confirmed to four digits.
- **NAFEMS T1 and T2 were found** (FeenoX, S3), which the gap list listed as "not found". T2 (radiation slab) is used here
  (grade B statement, value derived); T1 (thermal stress, hot disc) belongs to PHY-04.
- **CalculiX has no `*LATENT HEAT` card.** Phase change must be written as an apparent specific heat (enthalpy smearing)
  in the `*SPECIFIC HEAT` temperature table (TECHNICAL_SPEC §5.6). The gap list's engine column is corrected by this pack.

## Not verified (follow-up needed)

- The NAFEMS originals (S10) and the Abaqus / Altair / COMSOL pages (S1, S5, S6) were only seen as search extracts.
- The Howell formula files (S8) and the Lienhard PDF (S9): blocked. All formulas are proven numerically in the generator,
  so no value depends on them, but equation numbers must be added after a human reads them.
- CalculiX's own view-factor accuracy (its manual calls the calculation "approximate"): no quantified source found;
  VC-THM-30 measures it.
- Space-environment thermal standards (ECSS-E-ST-31C thermal control, NASA thermal design handbooks) were not searched; they
  are out of the MVP scope and listed as V2 references only.
