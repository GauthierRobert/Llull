# PHY-05 NLS: validation pack

Proves the nonlinear structural analysis of `../FUNCTIONAL_SPEC.md` (`FR-NLS-*`) and `../TECHNICAL_SPEC.md` (`TR-NLS-*`).
Every expected value is one of:

- **(a) quoted** from a source in [`sources.md`](sources.md);
- **(b) derived** by [`generate_nls_reference.py`](generate_nls_reference.py) (Python 3 standard library only,
  deterministic; run `python3 -I generate_nls_reference.py` from this folder; about 90 s, dominated by the 40-element Lee
  frame run; two runs give byte-identical files);
- **(c) TBD** with the tool that will measure it.

Tolerances are llull acceptance choices, justified per case. No source claims them.

## Files

| File | Kind | Content |
| ---- | ---- | ------- |
| `generate_nls_reference.py` | generator | Writes all files below |
| `expected_results.json` | (a)+(b) | Cases in the physics README §6.3 schema, read by the PHY-00 harness |
| `elastica_cantilever.csv` | (b) | λ = PL²/EI → tip slope, δv/L, δh/L (elliptic closed form), linear theory, corotational cross-check |
| `lee_frame_path.csv` | (b) | Lee frame equilibrium path (20 elements per leg, every 5th arc step): normalised load, v/L (down), u/L |
| `thick_cylinder_elastic_plastic.csv` | (b) | Pressure vs plastic radius c for Tresca and von Mises (incompressible) |
| `moment_curvature_rectangle.csv` | (b) | M/My vs κ/κy, elastic-perfectly plastic rectangle |
| `plans/nls_cantilever_plastic_collapse.plan.json` | draft plan | Solid cantilever, J2 perfect plasticity, displacement control, tip probe |
| `plans/nls_thick_cylinder.plan.json` | draft plan | Annulus a = 100, b = 200 mm, plane strain by symmetric ends, ν = 0.49, pressure ramp |
| `plans/nls_column_imperfection.plan.json` | draft plan | Buckling case → `add_imperfection` (0.5 mm, mode 1) → NLGEOM run to 0.5 P_cr |
| `plans/nls_lee_frame.query.json` | draft query | `beam_large_deflection` input for NAFEMS NL7 |

Plans use today's commands for geometry (`set_units`, `add_box`, `add_cylinder`, `boolean {op,a,b}`), aerospace 08
material commands, the PHY-02 commands `add_material_model` / `define_constitutive_set` (param names to align with the
PHY-02 TECHNICAL_SPEC), aerospace 05 analysis commands and this pack's proposed commands. They are drafts until those
commands exist. No third-party file is stored here; CalculiX decks are pinned by commit and sha256 (`sources.md` S2).

## Real use cases

| # | Use case | Evidence | Cases |
| - | -------- | -------- | ----- |
| U1 | Permanent set after limit load (fittings, brackets) | 25.305 requires no detrimental permanent deformation at limit load (aerospace 05 register S1a) | VC-NLS-40, 64, 65 |
| U2 | Collapse load of ductile parts | NAFEMS NL benchmarks exist for exactly this class (S1b, S21) | VC-NLS-30, 40 |
| U3 | Post-buckling / imperfection sensitivity of thin members | Linear buckling (05) gives no collapse load | VC-NLS-50, 62 |
| U4 | Large rotation of flexures and frames, snap-through | NL7 (S1), elastica (S10) | VC-NLS-10, 20 |

## Validation cases

Status P (proposed). Gate: `unit` (no external tool), `integration` (needs ccx), `native` (native solver), `harness`.

| VC | Proves | Set-up | Expected | Tol. | Grade / source | Gate |
| -- | ------ | ------ | -------- | ---- | -------------- | ---- |
| VC-NLS-01 | FR-NLS-01, 07, 08; TR-NLS-01, 06 | Each draft plan: run, save, load, `replay_history` | `analysis` slice deep-equal, ids step-scoped, `is pure` for every new command; changing σy in the PHY-02 model marks curves stale | exact | — | unit + golden |
| VC-NLS-10.a–d | FR-NLS-01, 08, 11, 12; TR-NLS-20, 21 | `nonlinear_analytic_check check=elastica_cantilever`; `beam_large_deflection` cantilever, 20 elements | δv/L = 0.3017207738 (λ = 1), 0.493457480397 (λ = 2), 0.81060902488 (λ = 10); δh/L = 0.160641720825 (λ = 2) | analytic 1e-9; native 1 % (2 % for δh) | A: generator, two methods (S10) | unit / native |
| VC-NLS-20.a | FR-NLS-05, 12; TR-NLS-20 | `plans/nls_lee_frame.query.json` | first limit load P L²/EI = **18.55** (generator 18.5632 at 40 el./leg) | 1 % | A: S1 + S20 | native |
| VC-NLS-20.b | FR-NLS-05 | same | v/L at the limit point = **0.407** (generator 0.40616) | 0.004 abs | A: S1 + S20 | native |
| VC-NLS-20.c | FR-NLS-05 | same | v/L where the path climbs back to 31.89 = **0.781** (NAFEMS 0.784, Abaqus 0.781, generator 0.78085) | 0.004 abs | A: S1 + S20 | native |
| VC-NLS-20.d | FR-NLS-05 | same; `snapBack: true` | min load on the snap-back branch −9.427 (generator only) | 3 % | B (single method) | native |
| VC-NLS-30.a | FR-NLS-02, 06; TR-NLS-21 | analytic check; and FE plan with ν = 0.3 variant | first-yield pressure, von Mises plane strain, ν = 0.3: **89.8736758805 MPa** | 1e-9 analytic; 2 % FE (first increment with PEEQ > 0 bracketing) | A: generator | unit / integration |
| VC-NLS-30.b | FR-NLS-02, 05, 06 | `plans/nls_thick_cylinder.plan.json`, displacement-controlled variant to 3 mm bore displacement | plateau (limit) pressure **166.398466152 MPa** = (2/√3) σy ln 2 | 2 % | A: generator (limit analysis) | integration |
| VC-NLS-30.c, d | FR-NLS-06 | analytic check | Tresca p_c = 144.105298838, p_y = 77.9625 MPa | 1e-9 | A | unit |
| VC-NLS-30.e | FR-NLS-02, 06 | thick-cylinder plan (ν = 0.49), pressure 149.850 MPa | elastic-plastic radius c = 150 mm (PEEQ > 0 boundary on the mid-plane) | 3 % on pressure at c = 150 mm | A: generator | integration |
| VC-NLS-31 | FR-NLS-02 | NAFEMS NL2 | TBD (tables not obtained) — only consistency: generator p_c = 166.4 MPa > NL2 maximum 160 MPa if a = 100, b = 200 | — | C | — |
| VC-NLS-40.a, e | FR-NLS-07, 11 | analytic check | M_p = 250 000 N·mm; M/My(κ = 2κy) = 1.375 | 1e-9 | A | unit |
| VC-NLS-40.b | FR-NLS-05, 07 | `plans/nls_cantilever_plastic_collapse.plan.json`; `limit_load method=plateau slopeFraction=0.02 window=5` | collapse tip load **500 N** = M_p / L | 3 % (root constraint and shear raise the FE value slightly; revisit after the first run) | A: generator (S12) | integration |
| VC-NLS-40.c, d | FR-NLS-05, 07 | variants: propped, fixed-fixed (NLGEOM off) | 3000 N, 4000 N | 3 % | A | integration |
| VC-NLS-41 | FR-NLS-02, 06; TR-NLS-04 | Run pinned ccx decks `beampiso`, `beampkin`, `beampd`; parse with the increment reader | displacements per increment equal the `.dat.ref` values | 1e-4 rel | TBD (extract with the M2 reader, then freeze) | integration |
| VC-NLS-50.a | FR-NLS-09 | analytic check | P_cr = 4605.81538718 N | 1e-9 analytic; 2 % vs 05 buckling | A | unit / integration |
| VC-NLS-50.b, c | FR-NLS-09, 10 | `plans/nls_column_imperfection.plan.json` at 0.5 and 0.8 P_cr | additional mid-span deflection 0.5 mm and 2.0 mm | 5 % (small-deflection formula vs NLGEOM FE) | A: generator | integration |
| VC-NLS-60 | FR-NLS-05, 13 | cantilever plan with load control to 600 N | `NLS_LIMIT_POINT_REACHED`, `lowerBound` ≤ 500 N, no `limitLoad` | exact | A (spec) | integration |
| VC-NLS-61 | FR-NLS-04, 13 | Lee frame as 3D beam-like solid under displacement control (draft) | `NLS_SNAP_BACK_DETECTED` | exact | A (spec) | integration |
| VC-NLS-62 | FR-NLS-09, 15 | `add_imperfection` without amplitude | exit 1, `NLS_IMPERFECTION_AMPLITUDE_UNSET`, doc unchanged | exact | A (AF-31) | unit |
| VC-NLS-63 | FR-NLS-04, 13 | `add_analysis_step control.kind=arc_length` on solver calculix | exit 1, `NLS_ARC_LENGTH_UNSUPPORTED` | exact | A (S2) | unit |
| VC-NLS-64 | FR-NLS-17 | any query result | `reviewRequired: true`, summary contains "not approved" | exact | A (AF-33) | unit |
| VC-NLS-65 | FR-NLS-03, 15 | `nonlinear_report` of each plan | every control / threshold / amplitude is `{value, source, defaulted}` | exact | A (AF-31) | unit |
| VC-NLS-66 | FR-NLS-16 | PHY-02 model flagged `unverified` | `unverified: true` + reasons in `limit_load`; `NLS_MATERIAL_MODEL_UNVERIFIED` in `check_nonlinear` | exact | A (AF-32) | unit |
| VC-NLS-67 | FR-NLS-14 | `compute_margins criterion=limit_load` on the cantilever with a limit case above 500 N / 1.5, then agent `dispose_margin` | row `FAIL`, `pending_human`; agent gets `FEA_HUMAN_GATE` | exact | A (05 AF-34) | unit |
| VC-NLS-68 | FR-NLS-19 | limit-load margin without a convergence study | warning `VNV_NO_CONVERGENCE_STUDY` | exact | A (PHY-00) | unit |
| VC-NLS-69 | FR-NLS-20 | V2 Code_Aster export re-run | TBD (needs a code_aster install) | — | TBD | manual |
| VC-NLS-71 | FR-NLS-10, 07 | five wrong set-ups (NLGEOM off with large rotation and thresholds given, no imperfection after a buckling case, PEEQ past the curve, one element through a yielding wall, unload step without threshold) | codes `NLS_NLGEOM_RECOMMENDED`, `NLS_IMPERFECTION_MISSING`, `NLS_STRAIN_BEYOND_CURVE`, `NLS_MESH_PLASTIC_ADEQUACY`, `NLS_PERMANENT_SET_THRESHOLD_UNSET` | exact | A (spec) | unit + integration |
| VC-NLS-70 | FR-NLS-18 | 20k-node C3D20R cantilever, 50 increments | wall time TBD — measure on the reference desktop | — | TBD | production gate |

Why ν = 0.49 in the thick-cylinder FE gate: the closed-form elastic-plastic boundary relation p(c) assumes an
incompressible material (exact for ν = 0.5); with ν = 0.3 only first yield (30.a) and the limit pressure (30.b, from
limit analysis, independent of elasticity) are exact.

## CLI harness (AF-23)

```bash
D="--doc case.llull.json --kernel occt --json"
an=$(llull run plans/nls_cantilever_plastic_collapse.plan.json $D | jq -r '.data.aliases.an[0]')
llull fea_mesh analysisId=$an $D --timeout 600 > mesh.json
llull check_nonlinear analysisId=$an $D > check.json          # no severity "error"
llull fea_solve analysisId=$an $D --timeout 3600 --progress > solve.json
llull limit_load analysisId=$an probe=tip method=plateau 'plateau={"slopeFraction":0.02,"window":5}' $D > ll.json
llull beam_large_deflection "$(cat plans/nls_lee_frame.query.json)" --json > lee.json
# PHY-00 judge: compare_to_expected / run_benchmarks with expected_results.json (VC-NLS-40.b, VC-NLS-20.*)
```

## Re-generating

```bash
cd docs/physics/05-nonlinear-structural/validation
python3 -I generate_nls_reference.py && git diff --stat .   # empty unless the generator changed
```
