# Gap 03 EQP — Validation pack

This pack proves that llull's parametric equipment commands are right: the geometry of formed heads and vessels, the
liquid volumes at a level, the weights, the ASME VIII-1 / API 650 thickness checks, the pump and exchanger templates and
the nozzle ports that piping (02 RTE) connects to. Every reference value comes from a published source graded in
[sources.md](sources.md), or from a cited closed form with its derivation in
[`data/derive_expected.py`](data/derive_expected.py). **No expected value was produced by running llull.**

All cases run automatically once the commands exist:

- unit tests read the JSON files in `data/` directly (`tests/unit/plant/equipment/*.test.ts`);
- `tests/unit/plant/equipment/scenarioPlans.test.ts` runs every plan in `plans/` through `build_project`, the same path
  as `llull run plan.json --json`, and compares each `expected[]` row (value, `rel` or `abs` tolerance).

## Gate policy

Only **grade A** values and cited closed forms are pass / fail thresholds. Grade B values are inputs or documentation
(for example the API 650 minimum-thickness row for 15–36 m is used, but the result must carry `unverified: true` and
`check_equipment` must warn `EQP_TABLE_UNVERIFIED`). Grade C values are never used. Code thicknesses and MAWPs are
always returned with `reviewRequired: true`: passing these VCs proves llull applies the formulas correctly, not that a
vessel is fit for service (that needs a qualified engineer and, for a real vessel, an ASME-stamped design).

## Files

| File | Content | Grade |
| ---- | ------- | ----- |
| `data/tank_head_volumes_jones.json` | 24 partial / full volumes (vertical and horizontal; conical, ellipsoidal, spherical, torispherical) from Jones via fluids 1.3.1 tests | A |
| `data/head_geometry_references.json` | standard torispherical proportions (ASME F&D, 80/10, DIN 28011, DIN 28013), head depths, full-head volumes for D = 1 m, head surface areas | A / B per row |
| `data/asme_viii_div1_examples.json` | UG-27, UG-32, UG-99 formulas and 7 worked examples with published and re-derived values | A / B per row |
| `data/api650_references.json` | one-foot method, PPNS worked example, Table 5-2a rows for A283 C / A36 / A516-70, minimum thickness table | A / B / C per row |
| `data/pump_envelopes.json` | ISO 2858 rows (a, f, h1, h2), ASME B73.1 rows (CP, D, X), API 610 type list | A / B per row |
| `data/tema_designations.json` | TEMA letters, tube sizes, shell clearance, unsupported spans, tube-count reference cases | A / B |
| `data/derive_expected.py` | independent re-implementation of the closed forms; prints every derived number used below | — |
| `expected_results.json` | index of the 25 VCs (20 MVP, 5 V1 / V2) | — |
| `plans/sc-eqp-0*.json` | 4 CLI scenarios (`build_project` actions + `expected[]`), commands flagged PROPOSED | — |

## Real use cases

| # | Use case | What llull must do | VC |
| -- | -------- | ------------------ | -- |
| U1 | An agent lays out a separator for a process unit from a one-line brief ("1.5 m × 4 m vertical separator, 10 barg, 4 nozzles, on a skirt") | parametric vessel with heads, skirt, nozzles with ports; volume, weights, thickness check, data sheet | VC-EQP-01, 03, 05, 06, 09, 12, 13 |
| U2 | A reflux drum on saddles with a level at 50 % and a revision that thins the shell | horizontal vessel, partial volumes, MAWP, failure code on the revision | VC-EQP-02, 14, 16, 19 |
| U3 | A shell-and-tube cooler from a TEMA designation | parse BEM, build bonnets / tubesheets / shell, shell- and tube-side volumes, nozzles on shell and channel | VC-EQP-11, 15, 18 |
| U4 | A fire-water tank: shell courses and the hydrotest | API 650 one-foot method per course with sourced allowables and minimums | VC-EQP-08, 17 |
| U5 | A pump skid placed from a catalogue size, nozzles ready for routing | ISO 2858 / B73.1 envelope, suction and discharge ports | VC-EQP-10, 12 |
| U6 | Hand-off to BIM / review | IFC equipment + distribution ports | VC-EQP-20 |

## Validation cases

| VC | What | Reference | Tolerance | Test |
| -- | ---- | --------- | --------- | ---- |
| VC-EQP-01 | Vertical tanks: partial volumes with conical, ellipsoidal, spherical, torispherical bottoms (14 rows) | Jones [S1] via fluids tests [S2] | 1e-9 rel | `headVolumes.test.ts` |
| VC-EQP-02 | Horizontal tanks: ellipsoidal and conical heads (7 rows MVP), torispherical (3 rows V1) | [S1] via [S2] | 1e-9 rel; 1e-6 (V1) | `headVolumes.test.ts` |
| VC-EQP-03 | Head depths and full volumes (2:1, hemi, F&D, 80/10, DIN 28011, DIN 28013); generated solid volume | closed form + numerical revolution integral; [S1], [S2] | 1e-9 closed form; OCC 1e-6; Manifold TBD band | `headGeometry.test.ts` |
| VC-EQP-04 | Head surface areas (weights, painting, insulation) | spheroid area [S3]; Honeywell [S4] (B) | 1e-9 rel | `headGeometry.test.ts` |
| VC-EQP-05 | UG-27(c)(1) shell thickness: 0.1601 in, 0.3990 in; uncorroded-radius variant 0.578 in | [S6], [S7], [S10] | 1e-9 vs derived | `asmeThickness.test.ts` |
| VC-EQP-06 | UG-32 heads: 2:1 (0.4506, 1.4917 in), torispherical (0.0531, 0.0177 in) | [S10], [S11], [S12] | 1e-9 vs derived | `asmeThickness.test.ts` |
| VC-EQP-07 | Applicability limit P ≤ 0.385 SE, missing allowable, MAWP round trip | [S8] | exact codes | `asmeThickness.test.ts` |
| VC-EQP-08 | API 650 one-foot: PPNS example 5.440 / 2.426 mm; A283 C / A36 / A516-70 Sd, St | [S15], [S16], [S17] | 1e-9; table exact | `api650.test.ts` |
| VC-EQP-09 | Empty / operating / test weights of SC-EQP-01 and 02 | derived (thin-wall rule, ρ given) | 1e-6 rel | `weights.test.ts` |
| VC-EQP-10 | Pump envelopes from ISO 2858 / B73.1 rows; unverified and unknown sizes | [S20]–[S25] | exact | `pumps.test.ts` |
| VC-EQP-11 | TEMA designation parse (BEM, AES, AEU, AKT; BXZ and BE refused) | [S27], [S28] | exact | `exchanger.test.ts` |
| VC-EQP-12 | Nozzle port position and direction (shell, head, channel nozzles; vertical and horizontal) | closed-form placement, convention in TECHNICAL_SPEC §5.4 | 1e-6 mm, 1e-9 | `nozzles.test.ts` |
| VC-EQP-13 | SC-EQP-01 vertical separator end to end | plan `expected[]` | per row | `scenarioPlans.test.ts` |
| VC-EQP-14 | SC-EQP-02 horizontal drum, revision failing `EQP_SHELL_UNDER_THICKNESS` | plan `expected[]` | per row | `scenarioPlans.test.ts` |
| VC-EQP-15 | SC-EQP-03 BEM exchanger, invalid TEMA refused | plan `expected[]` | per row | `scenarioPlans.test.ts` |
| VC-EQP-16 | Guardrails: `reviewRequired`, `unverified` propagation, stable codes, determinism | AGENT_FIRST AF-11/13/31–33 | exact | `guardrails.test.ts` |
| VC-EQP-17 | SC-EQP-04 API 650 tank, 6 courses; > 60 m refused | plan `expected[]` | per row | `scenarioPlans.test.ts` |
| VC-EQP-18 | (V1) tube counts and maximum unsupported tube span | ht 1.2.0 [S27] | exact | `tubeLayout.test.ts` |
| VC-EQP-19 | Regeneration keeps element id, port ids and flange-face positions | closed form (11.705574 m³) | 1e-9; ids exact | `regeneration.test.ts` |
| VC-EQP-20 | IFC export: 1 tank + 4 distribution ports | IFC4 entity names [S30] (C, confirm before gating) | exact counts | `ifcEquipment.test.ts` |
| VC-EQP-21 | Column tray stack elevations; 30 trays refused `EQP_TRAYS_DONT_FIT` | closed form | exact | `column.test.ts` |
| VC-EQP-22 | (V1) equipment template save / insert keeps relative port positions | closed form | 1e-9 | `templates.test.ts` |
| VC-EQP-23 | (V1) air cooler / compressor envelope ports | explicit inputs | exact | `airCooler.test.ts` |
| VC-EQP-24 | (V1) nozzle orientation view labels | SC-EQP-01 | exact text | `orientationView.test.ts` |
| VC-EQP-25 | (V2) saddle / reinforcement checks vs COMPRESS or PV Elite | TBD — measure with a licensed tool | TBD | V2 |

### Derivations used as expectations

All numbers below are printed by `python3 -I data/derive_expected.py`.

- **Head volumes.** Vertical bottom filled to h (Jones): ellipsoidal V = π/4 (Dh/a)² (a − h/3) for h < a, else
  πD²/4 (h − a/3); torispherical uses α = asin((1−2k)/(2(f−k))), a₁ = fD(1−cos α), a₂ = kD cos α and the three-branch
  formula printed in S2. The full torispherical head volume is also integrated numerically over the crown-sphere +
  knuckle-torus profile (200 000 slices); both agree to 3e-12. ASME F&D on D = 1 m: depth 0.169338 m, V = 0.0809990 m³
  (the handbook "0.0809 D³").
- **Horizontal partial volume** (ellipsoidal heads): V = A_f L + π a h² (1 − h/(3R)), A_f = R² acos((R−h)/R) −
  (R−h)√(2Rh − h²). SC-EQP-02 at h = 1.0 m: 10.471976 m³ (half of 20.943951); at h = 0.5 m: 4.012358 m³.
- **ASME VIII-1** in the corroded condition: t = P(R+CA)/(SE − 0.6P) + CA; 2:1 head t = P(D+2CA)/(2SE − 0.2P) + CA;
  MAWP shell = SE(t−CA)/(R+CA + 0.6(t−CA)); MAWP head = 2SE(t−CA)/(D+2CA + 0.2(t−CA)); Pt = 1.3 · min(MAWP) · 1.0.
  SC-EQP-01 (P 1.0 MPa, S 137.9, E 1, ID 1500, t 10, CA 3): t_req shell 8.4843 mm, head 8.4644 mm, MAWP 1.27483 MPa
  (shell governs), Pt 1.65728 MPa. SC-EQP-02 (P 1.5, E_shell 0.85, ID 2000, shell 18, heads 16): t_req shell
  15.9347 mm, MAWP 1.73738 MPa, Pt 2.25859 MPa; with a 12 mm shell t_avail 9 < 12.93 → fail.
- **Weights** (method stated in `data.method`): shell = π/4((D+2t)² − D²) L ρ; formed head = exact solid between the
  inside profile and its outward offset by t (numerical quadrature, 1e5 segments; the same routine gives the
  hemisphere 2π/3((R+t)³ − R³) to 7e-11); skirt = annulus × height × ρ; ρ = 7850 kg/m³ given in the plan. SC-EQP-01:
  shell 1489.555 kg, each head 194.637 kg, skirt 754.642 kg, body empty 2633.470 kg, operating 5262.100 kg (liquid
  3.0925 m³ × 850 kg/m³), test 10585.627 kg (7.95216 m³ water). SC-EQP-02: body empty 6485.731 kg, test 27429.682 kg.
  Nozzles, internals, insulation and platforms are excluded from the gated `body.*` values (reported separately).
- **API 650** one-foot: td = 4.9 D (H − 0.3) G / Sd + CA, tt = 4.9 D (H − 0.3) / St. SC-EQP-04 (D 20, H 12, G 1,
  A36M 160 / 171 MPa, CA 1.5): course 1 td 8.66625 mm, tt 6.70526 mm; courses 4–6 governed by the 6 mm minimum.
- **BEM volumes** (SC-EQP-03): shell side π/4·0.6²·4.777 − 300·π/4·0.01905²·4.777 = 0.942199 m³; tube side
  300·π/4·0.015748²·4.877 + 2(π/4·0.6²·0.3 + π·0.6³/24) = 0.511175 m³ (baffles, tie rods, pass partitions ignored and
  listed in `data.assumptions`).

### Known biases (expected and documented, not failures)

- The common thin-wall rule (inside area × t) underestimates a 2:1 head of D 1500 / t 10 by 1.6 % (191.459 kg against
  194.637 kg). llull uses the exact offset solid; `data.method` names it, and the thin-wall value is not used.
- Manifold tessellates revolutions, so a solid's kernel volume is slightly below the closed form; the closed form is
  what `vessel_volume` returns, and VC-EQP-03 pins the tessellation band once measured.
- `vessel_volume` excludes nozzle bores and internals (trays, baffles, tubes on the shell side are subtracted only for
  exchangers, as stated).

## What could not be verified

- The ASME, API, ISO, TEMA texts (paywalled). Only formulas and table rows confirmed by ≥ 2 independent public
  sources gate; everything else is flagged (sources.md, "Not verified").
- Pump weights, motor frame sizes, full ISO 2858 / B73.1 tables: future rows must come from a vendor datasheet or a
  catalogue record imported by the user, and are `unverified` until two sources agree.
- Saddle (Zick), skirt, lug, nozzle reinforcement (UG-37), wind and seismic checks: V1, no numbers in this pack yet.
