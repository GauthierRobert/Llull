# PHY-02 MATL — Validation pack

How to prove that a future implementation of the constitutive model library and the material-point driver is correct.
External facts are in [sources.md](sources.md) (S-ids). Every expected number is produced by
[generate_matl_reference.py](generate_matl_reference.py) (Python 3 standard library only) into
[expected_results.json](expected_results.json) (shared schema, `docs/physics/README.md` §6.3).

## Files

| File | What it is | Status |
| ---- | ---------- | ------ |
| `sources.md` | Sources, verification method, reproduction results, open items | complete |
| `treloar_1944_steinmann2012.csv` | Treloar rubber data (UT 25, ET 17, PS 14 rows incl. origin), nominal stress in MPa vs stretch, as tabulated by Steinmann et al. 2012; two identical transcriptions | pinned, grade B |
| `generate_matl_reference.py` | Reference algorithms: plane-strain J2 radial return (NL1), exact orthotropic inversion and PD test, Ramberg-Osgood, Armstrong-Frederick / Prager closed forms, incompressible hyperelastic stresses, exact least-squares fits on the Treloar table, Drucker scan, Prony / WLF, Norton / Garofalo, Johnson-Cook, CalculiX and Nastran card text | complete |
| `expected_results.json` | 107 cases, 12 significant digits, tolerance, source, grade, FR/TR proved | generated |
| `plans/nl1_material_point_proposed.json` | `build_project` plan: record, elastic + two plastic models, two sets, NL1 driver runs (10 increments per segment), check, CalculiX cards | proposed commands |
| `plans/fit_treloar_params.json` | Params for `fit_material_model` (Yeoh, three Treloar modes) | proposed command |

```bash
python3 -I generate_matl_reference.py           # writes expected_results.json (~3 s)
python3 -I generate_matl_reference.py --check   # exit 1 if stale
```

Determinism: run twice with `python3 -I`; outputs byte-identical (`cmp`).

## Real use cases

| # | Use case | Public basis | What llull must do | VC |
| - | -------- | ------------ | ------------------ | -- |
| U1 | Check a plasticity implementation before an over-yield FE run | NAFEMS NL1 (S1), reproduced analytically | Drive the point; match increments exactly and converged values | VC-MATL-01, 02 |
| U2 | Thick orthotropic part (forging, thick CFRP block) | CalculiX ORTHO / ENGINEERING CONSTANTS (S3, S4) | Convert, check PD, write cards | VC-MATL-03, 13 |
| U3 | Aluminium fitting past yield from handbook-style R-O data | NACA TN 902 form (S8), CalculiX form (S3) | Convert engineering form; evaluate | VC-MATL-04 |
| U4 | Cyclic loading near yield | Armstrong-Frederick / Prager closed forms | Kinematic hardening in the driver | VC-MATL-05 |
| U5 | Elastomer seal or mount | Treloar data (S10) | Fit, compare modes, scan stability, export | VC-MATL-06…09, 13 |
| U6 | Polymer relaxation at temperature | Prony + WLF (S13) | Relaxation and shift | VC-MATL-10 |
| U7 | Hot bolted joint creep definition | CalculiX Norton (S3) | Creep strain under constant stress | VC-MATL-11 |
| U8 | Impact law hand-off to PHY-19 | J-C form (S3) | Flow stress at (εp, ε̇, T) | VC-MATL-12 |

## Validation cases

| VC | Proves | Setup | Expected (examples) | Tol | Source / derivation | Grade |
| -- | ------ | ----- | ------------------- | --- | ------------------- | ----- |
| VC-MATL-01 | FR-MATL-10, TR-MATL-05 | NL1 perfect plasticity (E 250 GPa, ν 0.25, σy 5 MPa), plane strain, 8 segments, N = 10 / 1000 / 100 000 increments per segment | first yield at εxx 0.25e-4: σvM 5.0 MPa; point 7: N10 3.82350455285, N1000 3.91511459035, converged 3.91606036912 MPa (NAFEMS 3.917; Abaqus 3.824); other points 5.0 | N10/N1000 rel 1e-9; converged rel 2e-4 | generator radial return (§5.3); NAFEMS / Abaqus quoted (S1) | A (generator), B (quoted) |
| VC-MATL-02 | FR-MATL-05/10, TR-MATL-03/05 | Same with linear isotropic hardening H = 62.5 GPa (`plastic`); and the tangent reading | point 2 5.86206896552; point 3 5.48210796399 (NAFEMS and Abaqus 5.482); point 6 converged 7.31313231086 (NAFEMS 7.322); point 7 N10 4.11405326241 (Abaqus 4.114), converged 4.18963116268 (NAFEMS 4.230, −0.95 %); tangent reading point 2 6.08695652174 | as VC-MATL-01 | same | A / B |
| VC-MATL-03 | FR-MATL-02/03, TR-MATL-02 | Synthetic CFRP-like engineering constants → ORTHO D values; PD; ν12 = 3.8 (bound √13.5 = 3.67423461417); CalculiX manual ORTHO example → engineering constants; isotropic ν = 0.5, −1 | D1111 138354.037267, D1122 5590.0621118, D2222 12765.0460484, D2233 5868.49432427 MPa…; PD true; ν12 = 3.8 → not PD; manual example E1 399999.270591, E2 304220.243126, E3 217443.063445 MPa, PD; `MATL_POISSON_BOUND` | rel 1e-9 / exact | exact rational inversion | A (B for the manual example input) |
| VC-MATL-04 | FR-MATL-04, TR-MATL-04 | Engineering R-O E 72 GPa, σ0.2 400 MPa, n 15 (synthetic) | α 0.36; ε(σ0.2) 0.00755555555556; σ(ε = 0.01) 420.054211273 MPa | rel 1e-9 | algebra + bisection | A |
| VC-MATL-05 | FR-MATL-06, TR-MATL-05 | Armstrong-Frederick σy 200, C 20 000, γ 100 MPa (synthetic), uniaxial monotonic; Prager C 10 000 MPa reversal after εp 0.01 | σ(εp 0.005 / 0.01 / 0.05) 278.693868057 / 326.424111766 / 398.6524106 MPa; saturation 400; reverse yield −100 MPa (σmax 300) | rel 1e-3 (AF, ≥ 1000 increments) / 1e-9 | closed forms | A |
| VC-MATL-06 | FR-MATL-07, TR-MATL-06 | Nominal stress at λ = 2 in UT / ET / PS for synthetic Neo-Hooke (C10 0.2), Mooney-Rivlin (0.16, 0.02), Yeoh (0.18, −0.002, 0.0001), Arruda-Boyce (μ 0.27, λm 2.8), and the S11 Ogden set | e.g. Neo-Hooke 0.7 / 0.7875 / 0.75 MPa; Arruda-Boyce UT 0.548111303159; Ogden UT 0.602721615587 MPa | rel 1e-12 | closed forms §5.6 | A |
| VC-MATL-07 | FR-MATL-07/15, TR-MATL-06/10 | S11 Ogden set entered in the Ogden-1972 convention | μ0 0.4225 MPa; canonical (CalculiX) μ_i 0.4095, 0.003, 0.01 MPa | rel 1e-12 | S3 convention | A |
| VC-MATL-08 | FR-MATL-08/09, TR-MATL-07 | Linear least squares (absolute nominal-stress residual) on the pinned Treloar table: Neo-Hooke UT-only and all modes, Mooney-Rivlin, Yeoh; S11 Ogden set RMS | Neo-Hooke(all) C10 0.262442676945; MR C10 0.265829838273, C01 −0.00169590877646; Yeoh C10 0.183027183347, C20 −0.00141844935972, C30 3.93471468735e-5 MPa; RMS per mode (Yeoh UT 0.140354, ET 0.189842, PS 0.0270939 MPa); MR Drucker ET unstable at λ 8.86 (tension) / 0.28 (compression); Ogden set RMS UT 0.287921 MPa (report only) | rel 1e-6 | exact rational normal equations on S10 | A given the table; table B |
| VC-MATL-09 | FR-MATL-09, TR-MATL-08 | Drucker scan: S11 Ogden set; synthetic MR C10 0.2, C01 −0.15 MPa | Ogden: stable over the whole scan in all modes; MR: UT 1.16 / 0.86, ET 1.08 / 0.93, PS 1.14 / 0.88 (first unstable λ, tension / compression) → `MATL_HYPERELASTIC_UNSTABLE` | exact (grid) | Hessian §5.6 | A |
| VC-MATL-10 | FR-MATL-11, TR-MATL-09 | Prony g (0.3, 0.2), τ (0.1, 10) s (synthetic); WLF C1 17.44, C2 51.6 K, Tr = Tg = 373 K | G/G0 at t = 0, 0.1, 1, 10, 100 s: 1, 0.808373799101, 0.680981103586, 0.573575888234, 0.500009079986; log10 aT at 383 / 423 K: −2.83116883117 / −8.58267716535; at 360 K refused `MATL_SHIFT_OUT_OF_RANGE` | rel 1e-12 | closed form; constants S13 | A (arithmetic), B (constants, refusal rule) |
| VC-MATL-11 | FR-MATL-12, TR-MATL-09 | Norton A 1e-10, n 5 (S3 example), σ 50 MPa, t 10 h, m = 0 and −0.5; synthetic Garofalo | ε 0.3125 and 0.197642353761; Garofalo rate 7.40017838452e-12 1/s | rel 1e-12 | closed forms | A |
| VC-MATL-12 | FR-MATL-13, TR-MATL-09 | Synthetic J-C A 500, B 300 MPa, n 0.3, C 0.015, ε̇0 1/s, m 1, T_tr 293, T_m 1800 K at εp 0.1, 100/s, 600 K | 553.641286869 MPa | rel 1e-12 | closed form (S3 form) | A |
| VC-MATL-13 | FR-MATL-15, TR-MATL-10 | CalculiX cards: R-O (VC-MATL-04), engineering constants (VC-MATL-03), NL1 linear hardening as a 2-point curve to εp 0.001, Ogden N=3 (VC-MATL-07), Norton | exact text lines, e.g. `*DEFORMATION PLASTICITY` / `72000.,0.33,400.,15.,0.36`; `*HYPERELASTIC,OGDEN,N=3` / `0.4095,1.3,0.003,5.,0.01,-2.,0.,0.` / `0.` | exact | S3 + S4 | A |
| VC-MATL-14 | FR-MATL-15, TR-MATL-11 | Nastran MAT1 + MATS1 for NL1 hardening | `MAT1    1       250000.         0.25` / `MATS1   1               PLASTIC 62500.  1       1       5.` | exact | S7 | B |
| VC-MATL-15 | FR-MATL-16…20, TR-MATL-13/14 | Wrong inputs: linear hardening without `modulusKind`; curve without measure; ν = 0.5; ν12 = 3.8; Σg = 1.1; elastic + ramberg_osgood in one set; Prony exported to CalculiX; unreviewed fitted model used `forCertification` | `MATL_HARDENING_MODULUS_KIND_MISSING`, `MATL_CURVE_MEASURE_MISSING`, `MATL_POISSON_BOUND`, `MATL_ELASTIC_NOT_POSITIVE_DEFINITE`, `MATL_PRONY_INVALID`, `MATL_COMBINATION_INVALID`, `MATL_EXPORT_UNSUPPORTED`, `MAT_VALUE_UNVERIFIED` + `reviewRequired: true`; each with remediation; `data.defaults[]` lists every default | exact | TECHNICAL_SPEC §7.1 | A |
| VC-MATL-16 | FR-MATL-24, TR-MATL-15 | `add_material_model` with each PHY-07 / PHY-08 variant from their plans | accepted, stored, validated by the owning pack's rules; rejected in a constitutive set (`MATL_COMBINATION_INVALID`) | exact | PHY-07/08 §3.1 | — |
| VC-MATL-17 | FR-MATL-14 | E referencing a PHY-01 model (6061-T6 E(T)) driven at 77 K and at 400 K | uses 77.1450506573 GPa (PHY-01 VC-PROP-07); at 400 K `PROP_OUT_OF_RANGE` passes through | rel 1e-9 / exact | PHY-01 | A |
| VC-MATL-18 | KPIs (§8) | 8 × 1000 increments J2; Drucker scan; card export | ≤ 50 ms; ≤ 20 ms; ≤ 5 ms | budget | — | — |

### FR → VC coverage

| FR | VC |
| -- | -- |
| FR-MATL-01 | VC-MATL-15 (sets), 16 |
| FR-MATL-02 | VC-MATL-03 |
| FR-MATL-03 | VC-MATL-03, 15 |
| FR-MATL-04 | VC-MATL-04 |
| FR-MATL-05 | VC-MATL-02, 13, 15 |
| FR-MATL-06 | VC-MATL-05 |
| FR-MATL-07 | VC-MATL-06, 07 |
| FR-MATL-08 | VC-MATL-08 |
| FR-MATL-09 | VC-MATL-08, 09 |
| FR-MATL-10 | VC-MATL-01, 02, 05 |
| FR-MATL-11 | VC-MATL-10 |
| FR-MATL-12 | VC-MATL-11 |
| FR-MATL-13 | VC-MATL-12 |
| FR-MATL-14 | VC-MATL-17 |
| FR-MATL-15 | VC-MATL-07, 13, 14 |
| FR-MATL-16…20 | VC-MATL-15 |
| FR-MATL-21 | design review against 06 CMP (no shared storage) |
| FR-MATL-22 | `is pure` tests; private-library fuzz (08 VC-MAT-14 pattern) |
| FR-MATL-23 | — (COULD, V2) |
| FR-MATL-24 | VC-MATL-16 |

## CLI harness (AF-23)

```bash
D="--doc case.llull.json --json"
llull run plans/nl1_material_point_proposed.json $D > run.json
jq '.data.steps[] | select(.command=="material_point_response") | .data.rows[-2].vonMises' run.json   # point 7
python3 -I compare.py run.json expected_results.json "VC-MATL-02/isotropicH62500/point7(0.0,0.25)e-4/N10"
llull fit_material_model --params plans/fit_treloar_params.json --json > yeoh.json
python3 -I compare.py yeoh.json expected_results.json "VC-MATL-08/treloarFit/yeoh_all"
llull check_material_models $D
```

`compare.py` is the PHY-00 harness comparator.

## Known gaps (honest status)

1. NAFEMS NL1 and Treloar primaries not read (grade B); the converged generator values gate, NAFEMS values are reported.
2. No non-linear fit VC yet (Ogden / Chaboche LM is V2): add one with a recovered-parameter fixture when M7 starts.
3. Nastran creep / viscoelastic cards not verified.
4. VC-MATL-16…18 have no generator value (contract / budget checks).
