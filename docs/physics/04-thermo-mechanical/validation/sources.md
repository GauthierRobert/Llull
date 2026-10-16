# PHY-04 Thermo-mechanical coupling & thermal fits: external sources

All entries were accessed on **2026-10-15**. Access modes as in `../../03-thermal-analysis/validation/sources.md`:
**git** (cloned, commit pinned), **search** (only the search-result text was seen; direct fetch failed with DNS errors or a
`403` from the egress proxy). Grades follow `docs/physics/README.md` §6.3.

| Id | Source | Publisher / licence | URL | Access | What was verified | Grade of what we use |
| -- | ------ | ------------------- | --- | ------ | ----------------- | -------------------- |
| S1 | Abaqus Benchmarks Guide "LE11: Solid cylinder/taper/sphere—temperature loading" | Dassault Systèmes (university mirrors) | https://abaqus-docs.mit.edu/2017/English/SIMACAEBMKRefMap/simabmk-c-le11.htm ; https://ceae-server.colorado.edu/v2016/books/bmk/ch04s02anf11.html | search | E = 210 GPa, ν = 0.3, α = 2.3e-4 /°C; temperature applied by user subroutine; target σzz = −105 MPa at A; C3D20 −96.7 (coarse) / −103.3 MPa (fine), C3D20R −93.0 / −99.6 MPa; origin NAFEMS TNSB Rev. 3 (1990) | A (with S2, S3) |
| S2 | Altair OptiStruct OS-V:0070 Solid Cylinder/Taper/Sphere – Temperature | Altair | https://help.altair.com/hwsolvers/os/topics/solvers/os/nafems_test_problem_le11_r.htm | search | Normalised by the −105 MPa target: hex20 ≈ 1.13 (coarse) / 1.06 (fine), wedge15 1.05 / 1.01, tet10 coarse 1.14. The page text says σyy at A on the y axis while normalising by σzz — a wording inconsistency, not used | B (supporting) |
| S3 | FeenoX: `examples/nafems-le11.geo`, `doc/nafems-le11.fee`/`.md`, `tests/nafems-le11.sh`, `tests/nafems-t1.fee`/`.geo`, `tests/nafems-t1-4.sh` | J. Theler / Seamplex; GPL-3.0 | https://github.com/seamplex/feenox (commit 3759eb2426a9e9a77ab8a9ce97db93071a389776) | git | LE11 geometry (inner sphere r = 1.0 m from A (1, 0, 0) to 45°, outer r = 1.4 m from B (1.4, 0, 0), taper and cylinder heights 0.345 + 0.345 + 0.400 m, revolved 90°), BCs (symmetry on xz and yz, w = 0 on the xy face and on face HIH'I'), T = √(x² + y²) + z °C, E = 210 GPa, ν = 0.3, α = 2.3e-4; documented result −105.041 MPa; test answers tet4 −108.2, tet10 −105.9, hex8 −99.3, hex20 −102.4, hex27 −104.8 MPa. T1: plane stress, quarter plate 10 × 10 mm (l = 20), hot disc r = 1 mm with α = 1e-3 and T = 1 inside, α = 0 outside, E = 100 GPa, ν = 0.3, σy printed at (1.005, 0), test `answerfloat … 50 0.1` | A (LE11); B (T1 statement, value derived) |
| S4 | S. Timoshenko, "Analysis of bi-metal thermostats", J. Opt. Soc. Am. 11, 233–255 (1925) | Optica (paywalled) | https://doi.org/10.1364/JOSA.11.000233 | search (secondary quotes: patents, arXiv 1702.03243) | Citation (volume 11, pp. 233–255; issue number differs between sources); curvature proportional to the expansion mismatch and inversely to thickness; general form in m = t1/t2, n = E1/E2. The generator implements the classical closed form and proves it by an independent equilibrium solve (agreement 1e-12) | A (by derivation) |
| S5 | ISO 286 fit values for 18–30 mm: H7 = +21/0 µm; H7/p6 shaft +22/+35 µm, interference 1–35 µm; H7/g6 clearance 7–41 µm | wevolver, Roymech, Firgelli calculators (secondary) | https://www.wevolver.com/article/h7-tolerance-explained-iso-286-hole-tolerance-charts ; https://www.roymech.co.uk/Useful_Tables/ISO_Tolerances/how-to-use-iso-tolerances/ | search | H7 +21/0 and H7/p6 +22/+35 quoted; g6 for 18–30 mm (−7/−20 µm) **not** quoted directly (a 30–40 mm band was). All fit limits are used as **explicit test inputs**, exactly as 03 GDT stores fits (code text + explicit limits) | B |
| S6 | ISO 286-1:2010 / ISO 286-2:2010 (limits and fits) | ISO (paid) | https://www.iso.org/search.html?q=ISO%20286 (catalogue page id not confirmed) | none | Titles only. llull ships no ISO 286 table (03 GDT FUNCTIONAL §4.2) | catalogue |
| S7 | CalculiX source, manual and tests | G. Dhondt; GPL-2.0 | https://github.com/Dhondtguido/CalculiX (commit fd588701edd6a92fde06e99b1bdf01f3b0f80f2c) | git | `*EXPANSION`: total (secant) coefficients with respect to `ZERO` = T_ref, ε_th = α(T)(T − T_ref) − α(T0)(T0 − T_ref), TYPE=ISO/ORTHO/ANISO, temperature dependent (example ZERO=273, 12e-6 at 373, 20e-6 at 573). `*TEMPERATURE` (mechanical steps only; OP, AMPLITUDE, FILE + BSTEP to read an `.frd`, file values take precedence). `*COUPLED TEMPERATURE-DISPLACEMENT`: displacements and temperatures solved simultaneously, coupling by boundary-condition update after each iteration (no matrix coupling), effect of displacement on temperature limited to radiation, parameters SOLVER, DIRECT, ALPHA, STEADY STATE, DELTMX, TIME RESET, TOTAL TIME AT START, COMPRESSIBLE. `*UNCOUPLED TEMPERATURE-DISPLACEMENT`: thermal then mechanical per increment. Test decks `beamt` (heated beam between walls, `*EXPANSION, ZERO=293.`, `*EL FILE THE`), `thermomech` (coupled then heat transfer and static steps) | A (syntax) |
| S8 | Cast3M test sheet LE11 | CEA | http://www-cast3m.cea.fr/html/CasTestsCastem/node9.html | gap-list extract only | Listed in `docs/physics/README.md`; not re-searched | C |
| S9 | Classical thermoelasticity (Timoshenko & Goodier, *Theory of Elasticity*; any strength-of-materials text): restrained stresses, circular inclusion, thick cylinder with log temperature, gradient curvature, Lamé shrink fit | textbooks (not fetched) | — | none | Not read in this session. Every formula is implemented in `generate_thermomech_reference.py` and checked against an independent form (integral vs log closed form vs Simpson quadrature; Timoshenko vs equilibrium) | A (by derivation) |
| S10 | code_aster validation test SSNL111 (`astest/ssnl111a.comm`, `ssnl111b.comm`): three bars in thermo-plasticity, 2D plane stress, perfect von Mises plasticity, 3 QUAD4 | EDF; GPL-3.0 | https://gitlab.com/codeaster/src (commit 94bf28a308de5a77587675a598aacdddb722f84e) | git | Test exists with that title; reference values not extracted (needs the V-document). Deferred to PHY-05 (plasticity) | B (existence) |
| S11 | ISO 1:2022 *GPS — Standard reference temperature for the specification of geometrical and dimensional properties* | ISO (paid) | https://iteh.es/catalog/standards/iso/2b58e35d-b8a2-43ab-a3d2-0d321e6abe99/iso-1-2022 ; https://www.evs.ee/en/iso-1-2022 | search (catalogue mirrors) | Scope: defines reference-temperature concepts and the standard reference temperature value for geometrical properties. The **value** was not seen in this session, so llull does not default it (TECHNICAL_SPEC §7.1 `TMC_SPEC_TEMPERATURE_MISSING`) | catalogue |
| L1 | 03 GDT pack: `SizeDimensionPmi.tolerance` `{ type: 'fit', code, upper, lower }` (code text only), `add_size_dimension`, no ISO 286 tables shipped | this repo | `docs/aerospace/03-gdt-mbd-pmi/TECHNICAL_SPEC.md` §3, §4; FUNCTIONAL §4.2 | local | Fit limits come from PMI, never decoded from the code | — |
| L2 | 06 CMP pack: hygrothermal CTE/CME loads are V2 there | this repo | `docs/aerospace/06-composites/FUNCTIONAL_SPEC.md` §4 | local | PHY-04 does not redefine laminate CTE; it consumes it later | — |

## Citation id mapping

Specs cite `[Rn]` = register `Sn` for n = 1…11 (R1 = S1, …, R11 = S11).

## Findings

- **CalculiX CTE semantics are secant (total) with a reference temperature** (S7). An instantaneous CTE table from a
  handbook must be integrated before it is written (TR-TMC-15); the 08 MAT record does not yet say which kind a `cte` value
  is — a request to PHY-01 / 08 (open question).
- **NAFEMS T1** (thermal stress, hot disc) was found in FeenoX (S3); the gap list had it as "not found".
- **The plugin dependency rule** (`.dependency-cruiser.cjs`) forbids `domain-physics → domain-cae`; same decision as PHY-03
  TECHNICAL_SPEC §2.1.

## Not verified

- NAFEMS LE11 original (paid) and the Abaqus/Altair pages (search only). FeenoX gives the geometry; the plan reproduces it.
- Timoshenko 1925 original text; the formula is proven numerically instead.
- ISO 286 g6 deviations for 18–30 mm (grade B, used only as test inputs) and the ISO 1 reference temperature value.
- Code_Aster SSNL111 reference values.
