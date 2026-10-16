# PHY-16 PRC: validation pack

Proves `../FUNCTIONAL_SPEC.md` (`FR-PRC-*`) and `../TECHNICAL_SPEC.md` (`TR-PRC-*`). Values are (a) quoted from
[`sources.md`](sources.md), (b) derived by [`generate_prc_reference.py`](generate_prc_reference.py) (stdlib only;
`python3 -I generate_prc_reference.py`; byte-identical on re-run), or (c) TBD. All material and process numbers in this
pack are **test inputs** (E 72 GPa, Y 300 MPa, T 1.6 mm; E 200 GPa, ε* = −0.002), not claims about an alloy or a machine.

## Files

| File | Kind | Content |
| ---- | ---- | ------- |
| `generate_prc_reference.py` | generator | Writes the files below |
| `expected_results.json` | (a)+(b) | Cases in the physics README §6.3 schema |
| `springback_ratio.csv` | (b) | R_i/R_f = 4u³ − 3u + 1 for u = 0 … 0.5 (regime column) |
| `springback_compensation.csv` | (b) | Tool radius / angle / overbend for five target bends (test material) |
| `layered_eigenstrain.csv` | (b) | Curvature increment and total per deposited layer, plus substrate removal |
| `plans/prc_springback_calc.query.json` | query | `springback_calc` input of VC-PRC-10 |
| `plans/prc_springback_compensation.query.json` | query | `springback_compensation` input of VC-PRC-20 |
| `plans/prc_am_layered_beam.plan.json` | draft plan | 100 × 10 mm beam: 4 mm plate + 2 mm deposit, 0.2 mm layers, ε*xx = −0.002, ν = 0, plate release |

## Real use cases

| # | Use case | Evidence | Cases |
| - | -------- | -------- | ----- |
| U1 | Press-brake tool radius and overbend for sheet clips | 07 provides the bends; springback is out of 07's scope (S2) | VC-PRC-10, 20, 50 |
| U2 | AM part distortion before and after plate removal | AM-Bench AMB2018-01 measures exactly this (S5) | VC-PRC-30, 40 |
| U3 | Machining distortion by layer removal (COULD) | same mechanics as substrate removal (generator) | VC-PRC-30.d |
| U4 | Support planning | overhang rules are machine-specific (S7) | VC-PRC-52, 54 |

## Validation cases

| VC | Proves | Set-up | Expected | Tol. | Grade / source | Gate |
| -- | ------ | ------ | -------- | ---- | -------------- | ---- |
| VC-PRC-10.a | FR-PRC-01; TR-PRC-01 | `plans/prc_springback_calc.query.json` | R_f = **4.98697250834 mm**; R_i/R_f = 0.9625078125 = 4u³ − 3u + 1 at u = 0.0125 | 1e-9 | A (generator, two forms) | unit |
| VC-PRC-10.b | FR-PRC-01 | same | θ_f = 87.0921711264° | 1e-9 | A | unit |
| VC-PRC-10.c | FR-PRC-01, 02 | plane strain, ν 0.33 | R_f = 4.99260081439 mm | 1e-9 | A | unit |
| VC-PRC-10.d | FR-PRC-01, 14 | R_i = 192 mm | elastic limit R_i = E T/(2Y) = 192 mm → `PRC_BEND_ELASTIC` | exact | A | unit |
| VC-PRC-11 | FR-PRC-01, 05 | FE plane-strain strip (1.6 mm), J2 perfect (PHY-02), NLGEOM, bend by end rotation to R_i 4.8 mm, release | R_f = 4.99260081439 mm (plane-strain closed form) | 5 % | A (closed form) | integration (V1) |
| VC-PRC-12 | FR-PRC-05, 06 | punch / die with PHY-06 contact, tool removed by `*MODEL CHANGE` | TBD — measure | — | TBD | integration (V1) |
| VC-PRC-20.a, b | FR-PRC-03, 04 | `plans/prc_springback_compensation.query.json` | tool R_i = 4.62653839002 mm; tool angle 92.8768883175° | 1e-9 | A | unit |
| VC-PRC-30.a | FR-PRC-07; TR-PRC-20 | analytic two-layer case | κ = −1.2957563978e-4 /mm (equals the Timoshenko bimetal form) | 1e-9 | A | unit |
| VC-PRC-30.b, c | FR-PRC-07, 08 | `plans/prc_am_layered_beam.plan.json` (V1) | κ after 10 layers −9.20109483135e-4 /mm; mid-span deflection −1.15013685392 mm (L = 100 mm) | 3 % | A (beam theory, superposition) | integration (V1) |
| VC-PRC-30.d | FR-PRC-09, 12 | same, release step | additional κ −1.11217022579e-3 /mm | 3 % | A | integration (V1) |
| VC-PRC-30.e | FR-PRC-08 | analytic all-at-once case | κ = −4.44444444444e-4 /mm (layered / at once = 2.07) | 1e-9 | A | unit |
| VC-PRC-31 | TR-PRC-20, 21 | carrier decision deck (nodal temperature vs element initial strain), one layer pair | TBD — choose the carrier that reproduces 30.a/b | — | TBD | integration (V1) |
| VC-PRC-40 | FR-PRC-10 | AM-Bench AMB2018-01 IN625 bridge, calibrated inherent strain | ridge-1 deflection 1.276 mm (15-5 PH: 1.168 mm) | 10 % | B (S5, search) | optional |
| VC-PRC-50 | FR-PRC-14 | 07 bracket with a bend below the radius-table minimum | `FTR_BEND_RADIUS_BELOW_MIN` relayed by `check_process` | exact | A (07 §7.2) | unit |
| VC-PRC-51 | FR-PRC-15, 16 | `springback_calc` without yield / with a `typical` 08 value | `PRC_MATERIAL_INPUT_MISSING` / `unverified: true` | exact | A (AF-31/32) | unit |
| VC-PRC-52 | FR-PRC-11, 15 | `check_am_overhang` without threshold | `PRC_OVERHANG_THRESHOLD_UNSET`, bands still returned | exact | A (AF-31) | unit |
| VC-PRC-53 | FR-PRC-17 | every result | `reviewRequired: true`, "not approved"; release of a compensation table by an agent → 09 human gate | exact | A (AF-33/34) | unit |
| VC-PRC-54 | FR-PRC-11; TR-PRC-30 | test part with downward faces at 45° and 30° to the plate and a horizontal ceiling | downskin angles 45 / 30 / 0° | 1e-6° | A (geometry) | unit (OCC) |
| VC-PRC-55 | FR-PRC-13, 18 | COULD items: weld inherent-shrinkage export; surface parity CLI / MCP / UI | TBD / same result hash on all surfaces | exact | TBD / A | deferred / integration |

## CLI harness (AF-23)

```bash
llull springback_calc "$(cat plans/prc_springback_calc.query.json)" --json > sb.json                  # VC-PRC-10
llull springback_compensation "$(cat plans/prc_springback_compensation.query.json)" --json > comp.json # VC-PRC-20
an=$(llull run plans/prc_am_layered_beam.plan.json --doc am.llull.json --kernel occt --json | jq -r '.data.aliases.an[0]')
llull fea_mesh analysisId=$an --doc am.llull.json --json && llull fea_solve analysisId=$an --doc am.llull.json --timeout 3600 --json
llull process_report analysisId=$an --doc am.llull.json --json > am.json                               # VC-PRC-30
```

## Re-generating

```bash
cd docs/physics/16-process-physics/validation && python3 -I generate_prc_reference.py && git diff --stat .
```
