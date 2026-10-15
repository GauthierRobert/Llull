# PHY-11 CRP: validation pack

This pack proves a future implementation of creep, stress relaxation and viscoelastic time response described in
[`../FUNCTIONAL_SPEC.md`](../FUNCTIONAL_SPEC.md) (`FR-CRP-*`) and [`../TECHNICAL_SPEC.md`](../TECHNICAL_SPEC.md)
(`TR-CRP-*`). Every expected value is one of:

- **(a) Quoted** from a source in [`sources.md`](sources.md).
- **(b) Derived** by [`generate_creep_reference.py`](generate_creep_reference.py) from a formula derived in its
  docstrings. Standard library only, deterministic: `python3 -I generate_creep_reference.py` (run twice, outputs
  byte-identical; checked 2026-10-15).
- **(c) Extracted** from a pinned public solver output (CalculiX `.frd.ref`), or **TBD** with the tool that will measure it.

Tolerances are **llull acceptance choices** explained per case; no source claims them. All material numbers in this pack
are **test inputs** (marked so in the plans with `basis: company` and the citation "test input of this validation case
(not a material claim)"). No creep data of a real alloy or polymer is stored here: real data is licensed (NIMS,
MMPDS, supplier) and lives only in 08 MAT private libraries ([S13]).

## Files

| File | Kind | Content |
| ---- | ---- | ------- |
| `generate_creep_reference.py` | generator | Writes the six files below. |
| `expected_results.json` | (b) + (c) | All VC values in the docs/physics/README.md §6.3 schema (`id, quantity, value, unit, tolerance, source, grade, proves`) plus `derivation`, `inputs`, `cross_check`. |
| `norton_relaxation_curve.csv` | (b) | σ(t) of a bar held at fixed strain (Norton n = 5) and preload ratio of a bolt with k_b/k_m = 1/3, t = 0, 1 s … 1e8 s. |
| `thick_cylinder_stationary_creep.csv` | (b) | σr, σθ, σz, σeq across a = 0.16 … b = 0.25 m, p = 10 MPa, n = 1, 3, 5, 10. |
| `beam_stationary_creep.csv` | (b) | σ(y)/σ_elastic,max of a rectangular beam in stationary creep bending, n = 1, 3, 5, 10. |
| `viscoelastic_sls.csv` | (b) | Standard linear solid: E(t), J(t) and E·J over 1e-2 … 1e3 s. |
| `wlf_shift.csv` | (b) | log10 aT and aT for T − Tr = 0 … 100 K with C1 = 17.44, C2 = 51.6 K. |
| `calculix_creep_reference.json` | (c) | CalculiX `beamcr`, `beamcr3`, `beamcr4` decks pinned by sha256 at commit fd58870, with the beamcr3 values (σzz ≈ 20 MPa, creep strain 0.319987–0.320016 at 1000 s). GPL, so not stored. |
| `plans/*.plan.json` | draft plans | `build_project` action lists. Geometry steps use existing llull commands (`set_units`, `add_box`, `add_cylinder`, `boolean`, `create_material`, `assign_material`). Analysis steps use **proposed** commands: 08 MAT `define_material_record` / `set_material_property`, PHY-02 `set_material_model` (name to align with the PHY-02 pack), 05 FEA `create_analysis` / `set_part_idealization` / `add_fea_constraint` / `add_fea_load` / `set_mesh_controls` / `add_result_probe`, and this pack's `set_creep_step` plus the `analysisType: "creep"` member and the probe `history` flag. Drafts until those exist. |
| `sources.md` | register | Sources, access mode, what was verified, grade. |

## Real use cases (sourced value statements only)

| # | Use case | Evidence | Cases |
| - | -------- | -------- | ----- |
| U1 | Check how much a hot or polymer part keeps deforming under a sustained load | The open solver llull already bundles (05) implements Norton creep in a `*VISCO` step and ships creep test decks [S1, S2]; commercial vendors publish creep benchmarks from NAFEMS [S3–S5]. | VC-CRP-10, 11, 40 |
| U2 | Bolt or clamp preload loss over time | Stress relaxation at fixed strain is the same Norton law integrated with a constraint (derivation in the generator). | VC-CRP-12, 13, 41 |
| U3 | Long-term stress redistribution in pressurised tubes and bent members | Stationary creep stresses differ from elastic ones (outer hoop stress exceeds the bore value for n > 2; outer-fibre bending stress falls to (2n+1)/(3n) of elastic). | VC-CRP-14, 15, 42, 43 |
| U4 | Screening creep-rupture life at temperature | Larson–Miller parameter [S6–S8]; time-fraction (linear) damage summation as used by ASME III-5 creep-fatigue [S9]. | VC-CRP-20, 21 |
| U5 | Polymer and composite-matrix parts: time and temperature dependent stiffness | Generalized Maxwell (Prony) and WLF shift [S10, S11]. | VC-CRP-30 … 34 |

## Validation cases

Status: **P** = proposed. Gate column: `unit` (no external process), `integration` (desktop with bundled CalculiX,
`npm --prefix server test`, skipped with a reason when `LLULL_CCX` is unset), `quality` (`npm run quality:physics`,
PHY-00 harness), `CLI` (agent-driver script, AF-23).

| VC | Proves | Setup | Expected | Tolerance | Source / grade | Gate |
| -- | ------ | ----- | -------- | --------- | -------------- | ---- |
| VC-CRP-01 | FR-CRP-01, 13; TR-CRP-01, 02 | Run each draft plan, save, load, `replay_history`. | `analysis` slice deep-equal; step-scoped ids identical; `is pure` holds for `set_creep_step` and every extended command. | exact | L1 | unit + golden |
| VC-CRP-02 | FR-CRP-02; TR-CRP-10 | `set_creep_step` on a case whose material has no PHY-02 creep model. | Refused, `CRP_LAW_MISSING`, document unchanged. | exact | — | unit |
| VC-CRP-10 | FR-CRP-02, 05; TR-CRP-20 | `creep_closed_form check=norton_constant_stress` with A = 1e-10 MPa⁻⁵ s⁻¹, n = 5, σ = 20 MPa, t = 1000 s. | ε_cr = **0.32**. CalculiX beamcr3 reference 0.319987–0.320016. | 0.5 % | (b) + (c) S1, S2 · **A** | unit |
| VC-CRP-11 | FR-CRP-02; TR-CRP-20 | Same, time hardening m = −0.5. | ε_cr = **0.0202385770251**. | 1 % | (b) S1 form · **A** | unit |
| VC-CRP-12 | FR-CRP-03; TR-CRP-21 | `check=norton_relaxation`, E = 200 GPa, A = 1e-18, n = 5, σ0 = 100 MPa. | σ(3600 s) = **93.8687499151 MPa**; t(σ = 50 MPa) = **187 500 s**. | 0.5 % / 1 % | (b) · **A** | unit |
| VC-CRP-13 | FR-CRP-04; TR-CRP-21 | `check=bolt_relaxation`, same law, k_b/k_m = 1/3 and rigid members, t = 1e6 s. | F/F0 = **0.357822413961** (k_b/k_m = 1/3) and **0.333333333333** (rigid). | 0.5 % | (b) · **A** | unit |
| VC-CRP-14 | FR-CRP-06; TR-CRP-22 | `check=thick_cylinder_stationary`, a = 0.16 m, b = 0.25 m, p = 10 MPa, n = 5 (and n = 1). | σθ(a) = **14.466573955**, σθ(b) = **20.466573955**, σeq(a) = **21.1886745886 MPa**; n = 1 gives Lamé **23.8753387534 MPa**. | 3 % (exact for n = 1, 1e-12) | (b) · **A** | unit |
| VC-CRP-15 | FR-CRP-06; TR-CRP-22 | `check=beam_stationary`, b = 10, h = 20 mm, M = 1e5 N·mm, n = 5. | outer fibre **110 MPa** (elastic 150); y = h/4 **95.7605619626 MPa**. | 3 % | (b) · **A** | unit |
| VC-CRP-16 | FR-CRP-23; TR-CRP-12 | Unit conversion of A. | 1e-10 MPa⁻⁵ s⁻¹ = **1e-40 Pa⁻⁵ s⁻¹** = **3.6e-7 MPa⁻⁵ h⁻¹** (m = 0); m = −0.5: **6e-9 MPa⁻⁵ h⁻⁰·⁵**. | 1e-12 | (b) · **A** | unit |
| VC-CRP-20 | FR-CRP-08; TR-CRP-30 | `creep_rupture_life` with an explicit LM model, T1 = 800 K, t_r1 = 1000 h, C = 20; iso-LMP to 850 K. | LMP = **18 400 K**; t_r(850 K) = **44.3668733098 h** (reliability 0.9.0 formula gives the same). | 1e-12 / 1e-9 | (b) S6, S7 · **A** | unit |
| VC-CRP-21 | FR-CRP-09 | `creep_damage_summary` with blocks (500 h at t_r = 1000 h) and (200 h at t_r = 400 h). | D = **1.0**, status `fail` at the D ≥ 1 limit (`CRP_DAMAGE_EXCEEDED`), `reviewRequired`. | 1e-12 | (b) S9 concept · **B** | unit |
| VC-CRP-30 | FR-CRP-10; TR-CRP-40 | SLS E∞ = 1000, E1 = 2000 MPa, τ = 10 s through the PHY-02 driver and `creep_closed_form check=sls`. | E(τ) = **1735.75888234 MPa**; J(10τ) = **9.76217337768e-4 /MPa**; interconversion residual < 1e-9 (generator −1.3e-14). | 1e-9 | (b) · **A** | unit |
| VC-CRP-31 | FR-CRP-10 | Kelvin–Voigt E = 1000 MPa, τ = 10 s, t = τ. | J = **6.32120558829e-4 /MPa**. | 1e-9 | (b) · **A** | unit |
| VC-CRP-32 | FR-CRP-10; TR-CRP-40 | Two-term Prony E∞ = 1000, (1500 MPa, 1 s), (500 MPa, 100 s), t = 10 s. | **1452.48680891 MPa**. | 1e-9 | (b) · **A** | unit |
| VC-CRP-33 | FR-CRP-11; TR-CRP-41 | `creep_closed_form check=wlf_shift` with C1 = 17.44, C2 = 51.6 K. | log10 aT = **−2.83116883117** (ΔT = 10 K), **−8.58267716535** (ΔT = 50 K). ΔT < 0 (below Tr) → `CRP_WLF_OUT_OF_RANGE`. | 1e-9 abs | (b) + S11 · **B** (constants search-verified) | unit |
| VC-CRP-34 | FR-CRP-11 | SLS of VC-CRP-30 at Tg + 10 K, t = 0.01 s. | **2015.35894449 MPa** (E(t/aT)). | 1e-9 | (b) + S11 · **B** | unit |
| VC-CRP-40 | FR-CRP-01, 05, 07; TR-CRP-50, 51 | `plans/crp_norton_unit_cube.plan.json` → `fea_mesh`, `fea_solve`, `creep_report`. Also run the pinned `beamcr3.inp`. | Probe `centre` CEEQ at t = 1000 s = 0.32; beamcr3 within 1e-4 of the `.frd.ref`. | 1 % (native) / 1e-4 rel (ref deck) | (b) + (c) · **A** | integration |
| VC-CRP-41 | FR-CRP-03, 05; TR-CRP-50 | `plans/crp_bar_relaxation.plan.json` (preload step + `*VISCO` with held uz). | s_zz history at 3600 s = 93.8687 MPa; curve within 1 % of `norton_relaxation_curve.csv` for t ≤ 3600 s. | 1 % | (b) · **A** | integration |
| VC-CRP-42 | FR-CRP-06; TR-CRP-50 | `plans/crp_thick_cylinder_stationary.plan.json` (quarter tube, plane strain, 1e5 s). | Hoop stress at bore 14.4666, outer 20.4666 MPa (stationary). | 3 % | (b) · **A** | integration |
| VC-CRP-43 | FR-CRP-06; TR-CRP-50 | `plans/crp_beam_stationary_bending.plan.json`. | \|s_xx\| at mid-span outer fibre 110 MPa, at y = h/4 95.76 MPa. | 3 % (ends excluded) | (b) · **A** | integration |
| VC-CRP-44 | FR-CRP-07 | Run pinned `beamcr.inp`. | TBD: freeze U and PE from `beamcr.dat.ref` with the DAT reader. | 1e-4 rel | (c) | integration |
| VC-CRP-45 | FR-CRP-12 | V2: SLS relaxation of a held cube with MFront `GeneralizedMaxwell` loaded by CalculiX (`analysisType: "viscoelastic"`). | σ(t)/ε0 follows E(t) of VC-CRP-30 within 1 %. TBD: build and pin the MFront library. | 1 % | (b) + S10 | integration (V2) |
| VC-CRP-46 | FR-CRP-07 | COMSOL / NAFEMS elastoplastic + creep tube. | TBD: values not seen (S4, S5 grade C). Catalogue only, not a gate. | — | C | — |
| VC-CRP-47 | FR-CRP-07 | code_aster `ssnp02a` (Norton via LEMAITRE, plane strain) re-built in llull. | TBD: compare EPXX at order 40 (code_aster 7.0567e-4, reference 7.056e-4). Reported only (grade B). | 2 % | (c) S12 · **B** | integration (optional) |
| VC-CRP-60 | FR-CRP-14; TR-CRP-60 | `creep_rupture_life` with no C and no LM model on the material. | Refused `CRP_LM_MODEL_MISSING`; no silent C = 20. With `C: {value: 20, source: "convention, [S7]"}` given explicitly, `data.C.defaulted: false`. | exact | AF-31 | unit + CLI |
| VC-CRP-61 | FR-CRP-15 | Any `creep_rupture_life`, `creep_damage_summary`, `creep_report` result. | `reviewRequired: true`, `reviewReason`, summary contains "not approved". | exact | AF-33 | unit + CLI |
| VC-CRP-62 | FR-CRP-16 | Creep law from a PHY-02 model whose provenance basis is `typical` (unverified). | `unverified: true` with reasons on every result row; `check_creep` warning `CRP_LAW_UNVERIFIED` (not suppressible). | exact | AF-32 | unit |
| VC-CRP-63 | FR-CRP-17; TR-CRP-11 | Stress or temperature outside the law's `validRange` (e.g. σ = 500 MPa when the fit covers 1–400 MPa). | `creep_closed_form` refuses `CRP_LAW_OUT_OF_RANGE`; after a solve, `check_creep` fails with the element ids and max stress seen. | exact | AF-30 | unit + integration |
| VC-CRP-64 | FR-CRP-18 | Agent calls `dispose_margin` on a creep-life row with D ≥ 1. | Exit 1, `FEA_HUMAN_GATE`, document unchanged. | exact | AF-34 | unit + CLI |
| VC-CRP-65 | FR-CRP-19, 21, 22 | The deliberately wrong set-ups of TECHNICAL_SPEC §7.1 (missing law, creep case without any viscous material, `cetol` ≤ 0, duration ≤ 0, m ≤ −1, temperature table with an A jump > 10× between points, and a solve artifact whose final time is below the hold duration → `CRP_HOLD_INCOMPLETE`). | Each returns its documented code, ids/path and remediation. | exact | TECHNICAL_SPEC §7.1 | unit + CLI |
| VC-CRP-66 | FR-CRP-20 | Save a document whose creep law comes from a `storage: private` library (NIMS-derived fit). | Saved file and live-sync log contain no law coefficients (08 TR-MAT-31); `creep_report` after reload without the library returns `available: false`. | exact | S13, 08 MAT | unit (fuzz) |

## CLI harness (AF-23)

```bash
D="--doc case.llull.json --kernel occt --json"
an=$(llull run plans/crp_norton_unit_cube.plan.json $D | jq -r '.data.aliases.an[0]')    # AF-14 aliases
llull check_creep analysisId=$an $D > check.json            # must not contain severity "error"
llull fea_mesh analysisId=$an $D --timeout 300 > mesh.json
llull fea_solve analysisId=$an $D --timeout 900 --progress > solve.json
llull creep_report analysisId=$an $D > report.json         # probes[centre].history[-1].ceeq vs VC-CRP-10
python3 -I compare.py report.json expected_results.json VC-CRP-10    # PHY-00 harness: value, tolerance, unit
llull creep_closed_form check=norton_relaxation 'inputs={"E_MPa":200000,"A":1e-18,"n":5,"sigma0_MPa":100,"t_s":3600}' --json
```

Refusal cases assert exit code 1 and `data.code`.

## Re-generating

```bash
cd docs/physics/11-creep-viscoelasticity/validation
python3 -I generate_creep_reference.py   # rewrites expected_results.json and the five CSV files
git diff --stat .                        # must be empty unless the generator changed
```
