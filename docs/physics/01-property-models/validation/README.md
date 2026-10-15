# PHY-01 PROP — Validation pack

How to prove that a future implementation of property models is correct. External facts are in
[sources.md](sources.md) (S-ids). Every expected number is produced by
[generate_prop_reference.py](generate_prop_reference.py) (Python 3 standard library only) into
[expected_results.json](expected_results.json), which follows the shared schema of `docs/physics/README.md` §6.3.

## Files

| File | What it is | Status |
| ---- | ---------- | ------ |
| `sources.md` | Sources, how each was verified, cross-check table, open items | complete |
| `nist_cryogenic_fits.json` | 13 NIST fit definitions (6061-T6 k, cp, E, thermal strain; 304 k, cp, E piecewise; Ti-6Al-4V k; G-10CR k; OFHC Cu k RRR 50/100; two conflicting Invar transcriptions) with coefficients, data and equation ranges, fit error, which transcriptions agree, grade | complete for this subset |
| `generate_prop_reference.py` | Evaluates the forms, range statuses, CTE derivation, piecewise jump, transcription conflict, synthetic tables / Arrhenius / rate factors, exact rational least-squares refits, unit conversions, conductivity integrals | complete |
| `expected_results.json` | 81 cases, 12 significant digits, each with tolerance, source, grade and the FR/TR it proves | generated |
| `plans/cryo_6061_k_proposed.json` | `build_project` plan: 08 record + two NIST models + evaluations + check | proposed commands |
| `plans/range_refusal_ti64_proposed.json` | Ti-6Al-4V k: warned evaluation at 21 K, refusal at 10 K | proposed commands |
| `plans/fit_arrhenius_params.json` | Params file for `fit_property_model` (synthetic rows, rounded) | proposed command |

Running (from this folder):

```bash
python3 -I generate_prop_reference.py            # writes expected_results.json
python3 -I generate_prop_reference.py --check    # exit 1 if stale (quality gate)
```

Determinism: the generator was run twice with `python3 -I`; the two outputs were byte-identical (`cmp`).

## Real use cases

| # | Use case | Public basis | What llull must do | VC |
| - | -------- | ------------ | ------------------ | -- |
| U1 | LN2 / LH2 hardware: k of 6061-T6 and 304 between 20 K and 300 K | NIST fits (S1–S5) | Evaluate the published law with its range and fit error | VC-PROP-01, 03 |
| U2 | Heat leak through a stainless support | ∫ k dT from the NIST 304 fit | Integral over the range, with source | VC-PROP-20 |
| U3 | Copper thermal straps: purity matters | NIST OFHC RRR 50 vs 100 (S1, S2, S4, S5) | Keep the RRR condition on the model; pick the right one | VC-PROP-06 |
| U4 | Titanium struts below 23 K | NIST data range 23–300 K, equation 20–300 K (S1) | Warn between 20 and 23 K, refuse below 20 K | VC-PROP-08 |
| U5 | Al / steel joint contraction on cool-down | NIST thermal strain fits | Thermal strain and CTE from one model | VC-PROP-07 |
| U6 | Re-typed coefficients | Two transcriptions of the NIST Invar fit disagree (S2 vs S3) | Detect the conflict from the provenance | VC-PROP-09 |
| U7 | Owner test data → law | Synthetic Arrhenius set | Fit, report residuals, keep the data hash | VC-PROP-13, 14 |
| U8 | Hot strength vs temperature and rate | MMPDS-style % of RT (08) and rate factors | Same query for 08 tables and new forms | VC-PROP-12, 17 |

## Validation cases

"rel" = relative tolerance. All values are in `expected_results.json` under the case id prefix.

| VC | Proves | Setup | Expected (examples) | Tol | Source / derivation | Grade |
| -- | ------ | ----- | ------------------- | --- | ------------------- | ----- |
| VC-PROP-01 | FR-PROP-02/03, TR-PROP-03 | 6061-T6 k, log10-polynomial, at 4, 10, 20, 77, 100, 200, 300 K | 5.34742389854 / 14.2043053579 / 28.4275476264 / 83.5314419471 / 97.7012229674 / 136.025244261 / 155.318789794 W/(m·K) | rel 1e-9 | S1 form + coefficients agreeing in T1–T4; evaluated by the generator | A |
| VC-PROP-02 | FR-PROP-02/03 | 6061-T6 cp at the same points | 0.291976487945 … 348.127924912 (77 K) … 953.864360101 (300 K) J/(kg·K) | rel 1e-9 | S1 + T1, T2, T4 | A |
| VC-PROP-03 | FR-PROP-02/03 | 304 k and cp at 4, 20, 77, 300 K | k(77 K) 7.92065160226 W/(m·K); cp(300 K) 469.448840674 J/(kg·K) | rel 1e-9 | S1 + T1–T3 | A |
| VC-PROP-04 | FR-PROP-02/03 | Ti-6Al-4V k at 23, 77, 300 K | 1.42129996445 / 3.47051408408 / 7.55457237646 W/(m·K) | rel 1e-9 | S1 + T1, T2 | A |
| VC-PROP-05 | FR-PROP-02/03 | G-10CR k (normal) at 20, 77, 300 K | 0.156421869666 / 0.279965413171 / 0.607982754731 W/(m·K) | rel 1e-9 | T1–T3 coefficients (range TBD, points inside both claimed ranges) | A (values) |
| VC-PROP-06 | FR-PROP-02/03 | OFHC Cu k, NIST rational form, RRR 50 and 100 at 4, 20, 77, 300 K | RRR 50: 320.38 / 1 367.85 / 515.07 / 392.37; RRR 100: 642.30 / 2 422.51 / 547.20 / 396.32 W/(m·K) | rel 1e-9 | T1, T3, T4 | A (values) |
| VC-PROP-07 | FR-PROP-02/07, TR-PROP-05 | 6061-T6 E (polynomial) at 4, 77, 295 K; thermal strain at 4, 20, 77, 293 K; CTE = s′/(1 + s) at 77, 200, 293 K | E(295 K) 70.2840414457 GPa; s(77 K) −3.88731729659e-3; α(293 K) 2.26423649957e-5 1/K | rel 1e-9 | S1 + T1, T2 (E range TBD; tLow from T2 = B); CTE is a llull derivation | A / B |
| VC-PROP-08 | FR-PROP-04, TR-PROP-04 | Range statuses: 6061 k at 0.5 K, 400 K (refuse), 2 K (equation only); Ti-6Al-4V at 10 K (refuse), 21 K (equation only); 6061 cp at 3 K (refuse) | `PROP_OUT_OF_RANGE` / `in_equation_range_only` exactly as listed; warned values carried for 2 K and 21 K | exact | S1 ranges | A |
| VC-PROP-09 | FR-PROP-05/08, TR-PROP-06/09 | 304 E piecewise (5–57 / 57–293 K); two Invar transcriptions | jump at 57 K 0.0373135477254 GPa (1.74e-4 relative, below the 1e-3 default → no warning); E(20 K) 210.062022, E(57 K) 214.398595171 (left segment), E(100 K) 213.73583 GPa; Invar difference at 300 K 8.1e-7 → `PROP_SOURCE_CONFLICT` | rel 1e-9 | T1/T2 | B (304 low segment), A (conflict arithmetic) |
| VC-PROP-10 | FR-PROP-02, TR-PROP-03 | Synthetic Arrhenius A = 1e-3 1/s, Q = 150 kJ/mol at 600, 800, 1000 K | 8.7416813144e-17 / 1.60766748177e-13 / 1.46203234889e-11 1/s | rel 1e-9 | synthetic; R exact (S8) | A |
| VC-PROP-11 | FR-PROP-05, TR-PROP-06 | Synthetic table (100,10),(200,40),(400,160) at 300 K | linear 100, loglinear 80, loglog 90, step 40 | rel 1e-12 | synthetic; §5.2 rules | A |
| VC-PROP-12 | FR-PROP-06 | 2D table bilinear in (T, log10 ε̇) at (383 K, 1 s⁻¹); J-C rate factor (C 0.014, 1000 s⁻¹); Cowper-Symonds (D 40.4 s⁻¹, q 5, 1000 s⁻¹) | 307.5 MPa; 1.09670857391; 2.89986930849 | rel 1e-12 | synthetic fixtures (constants not attributed) | A |
| VC-PROP-13 | FR-PROP-09, TR-PROP-08 | Refit 27 samples (4–300 K) of the 6061 k fit, degree 7 log10 polynomial | max relative error 0 ± 1e-8 (generator observed 5.1e-15); coefficients equal NIST a…h within 1e-5 (observed 1.4e-12) | abs | S1 + exact rational least squares | A |
| VC-PROP-14 | FR-PROP-09 | Arrhenius fit of the VC-PROP-10 data at 500…1000 K | Q 150 000 J/mol, A 1e-3 1/s | rel 1e-9 | synthetic | A |
| VC-PROP-15 | FR-PROP-10, TR-PROP-10 | Band on 6061 k at 77 K, kind `fitErrorVsData` 0.5 % | [83.1137847373, 83.9490991568] W/(m·K) | rel 1e-9 | S1 coefficients (A) + 0.5 % error (search extract) | B |
| VC-PROP-16 | FR-PROP-11, TR-PROP-02 | 6061 k at −196 °C, −320 °F; at 77 K in W/(mm·K) | 83.6343787049; 83.9384687781 W/(m·K); 0.0835314419471 W/(mm·K) | rel 1e-9 | affine conversions | A |
| VC-PROP-17 | FR-PROP-12, TR-PROP-07 | 08 percentOfRT table (70 °F 100 %, 300 °F 80 %, 500 °F 50 %) on 60 ksi via `evaluate_property` | 39 ksi at 400 °F (= 08 VC-MAT-16) | rel 1e-12 | 08 synthetic table | A |
| VC-PROP-18 | FR-PROP-13/16/23, TR-PROP-11/14 | (a) a `typical` model; (b) Ti-6Al-4V at 21 K; (c) a fitted model without data source used `forCertification` | (a) `unverified: true`, reason `basis typical`; (b) `rangeStatus: in_equation_range_only`, warning `PROP_OUTSIDE_DATA_RANGE`; (c) refused `MAT_VALUE_UNVERIFIED`, `reviewRequired: true`; `data.defaults[]` lists every default used | exact | AF-31/32/33 | A |
| VC-PROP-19 | FR-PROP-14/15, TR-PROP-12 | Wrong inputs: T outside range; T missing; T in MPa; 8 coefficients for `nistRational`; decreasing table; unknown property; RT scalar only with T given; 3 rows for a degree-7 fit | `PROP_OUT_OF_RANGE`, `PROP_VARIABLE_MISSING`, `MAT_UNIT_DIMENSION`, `PROP_FORM_INVALID`, `PROP_TABLE_NOT_MONOTONIC`, `PROP_NO_MODEL_FOR_PROPERTY`, `PROP_CONSTANT_ONLY`, `PROP_FIT_INSUFFICIENT_DATA`; each with remediation | exact | TECHNICAL_SPEC §7.1 | A |
| VC-PROP-20 | FR-PROP-18, TR-PROP-13 | ∫ k dT from 4 to 300 K for 304 and 6061-T6 | 3 030.84358308 W/m; 32 325.1862914 W/m | rel 1e-8 | S1 fits; converged Simpson (40 000 intervals) | A |
| VC-PROP-21 | FR-PROP-18 | Solver table for 6061 k over 4–300 K at relTol 1e-3 | ≤ 60 points; measured `maxRelError` ≤ 1e-3 on a 10× finer grid | budget | §5.8 | — (property check) |
| VC-PROP-22 | FR-PROP-19, 22 | Private-library model with a sentinel coefficient; save, snapshot, export_code, live-sync log; replay | sentinel absent from all outputs; replay identical with the provider; `MAT_LIBRARY_UNRESOLVED` without it | exact | 08 VC-MAT-14 pattern | — |
| VC-PROP-23 | KPIs (TECHNICAL_SPEC §8) | 1 000-point sample + integral; 200-model check | ≤ 20 ms; ≤ 200 ms | budget | — | — |

### FR → VC coverage

| FR | VC |
| -- | -- |
| FR-PROP-01 | VC-PROP-01, 06 (condition RRR), 09 |
| FR-PROP-02 | VC-PROP-01…07, 10 |
| FR-PROP-03 | VC-PROP-01…06 |
| FR-PROP-04 | VC-PROP-08, 18 |
| FR-PROP-05 | VC-PROP-09, 11 |
| FR-PROP-06 | VC-PROP-12 |
| FR-PROP-07 | VC-PROP-07 |
| FR-PROP-08 | VC-PROP-09 |
| FR-PROP-09 | VC-PROP-13, 14 |
| FR-PROP-10 | VC-PROP-15 |
| FR-PROP-11 | VC-PROP-16 |
| FR-PROP-12 | VC-PROP-17 |
| FR-PROP-13 | VC-PROP-18 |
| FR-PROP-14 | VC-PROP-19 |
| FR-PROP-15 | VC-PROP-09, 19 |
| FR-PROP-16 | VC-PROP-18 |
| FR-PROP-17 | VC-PROP-21 (consumer tabulation API), review of PHY-03/04/05 packs |
| FR-PROP-18 | VC-PROP-20, 21 |
| FR-PROP-19 | VC-PROP-22 |
| FR-PROP-20 | `sources.lock.json` CI check (08 VC-MAT-18 pattern), after M6 |
| FR-PROP-21 | — (COULD; no VC until a pack adds a variable) |
| FR-PROP-22 | VC-PROP-22 (replay), `is pure` unit tests |
| FR-PROP-23 | VC-PROP-18 |

## CLI harness (AF-23)

```bash
D="--doc case.llull.json --json"
llull run plans/cryo_6061_k_proposed.json $D > run.json                       # proposed commands
jq '.data.aliases' run.json                                                    # AF-14 alias map
llull evaluate_property '{"material":"aa6061_t6","property":"k","at":{"T":{"value":77,"unit":"K"}}}' $D > k77.json
python3 -I compare.py k77.json expected_results.json "VC-PROP-01/aa6061_t6.k/T=77K"
llull evaluate_property '{"material":"ti6al4v","property":"k","at":{"T":{"value":10,"unit":"K"}}}' $D; echo "exit $?"   # 1, PROP_OUT_OF_RANGE
llull check_property_models $D > check.json
```

`compare.py` belongs to PHY-00 (V&V harness): it reads a case by id and asserts value, unit and tolerance, codes and
exit codes.

## Known gaps (honest status)

1. NIST primary pages not fetched; coefficients rest on transcription agreement (sources.md).
2. Fit errors for G-10CR and copper, equation ranges for 6061 E and G-10CR k: TBD.
3. No real (non-synthetic) owner dataset for fitting; VC-PROP-13 uses NIST-generated samples, VC-PROP-14 synthetic data.
4. VC-PROP-21…23 are property / budget checks without a generator value.
