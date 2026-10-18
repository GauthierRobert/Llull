# Gap 01 PSC — Validation pack

This pack proves that llull's piping catalogue, pipe-spec and spec-resolution commands give the dimensions the
governing standards give, pick the component a piping engineer would pick, and refuse what a spec does not allow.
Every reference value comes from a source in [sources.md](sources.md) (graded A/B/C) or from a closed form whose
formula is cited. **No expected value was produced by running llull** (the commands do not exist yet; see
TECHNICAL_SPEC §10). The ASME and EN standards are paywalled: dimension tables come from two open-source data packages
(MIT) and public manufacturer / reference tables, cross-checked by two sources.

All cases are meant to run unattended (AF-23):

- Unit tests read the JSON files in `data/` directly (`tests/unit/plant/piping/*.test.ts`).
- `tests/unit/plant/scenarioPlans.test.ts` runs every plan in `plans/` through `build_project`, the same path as
  `llull run plan.json --json`, and compares each `expected` row (`value`, `abs` / `rel` tolerance) with the step's
  `data` or `error`.
- A plan field `harness.inline` names a fixture file to inline into a param before the run (the CLI equivalent is
  `--param-file`, TR-PSC-14). A plan field `unbuilt` lists the commands that do not exist yet.

## Gate policy

Only **grade A** values (two independent sources agree, or a primary source read) and cited closed forms are pass / fail
thresholds. Grade B rows ship as data with `verified: false`, and the cases that touch them test **behaviour** (the
flag propagates, the check warns), not the digits. Grade C values are never used.

## Files

| File | Content | Grade |
| ---- | ------- | ----- |
| `data/asme_b36_pipe_schedules.json` | ASME B36.10M Sch 5..160, STD, XS, XXS and B36.19M 5S..80S: NPS, OD, wall (382 rows) from `fluids` 1.3.1, with per-row cross-check against `formulab` | A (86 rows) / B |
| `data/asme_b16_5_wn_rf_flanges.json` | ASME B16.5 WN RF flanges Cl 150/300/600, NPS 1..12: OD, thickness, bolt circle, bolt count and size, raised face (24 rows) | A / B per field |
| `data/asme_b16_5_pt_group_1_1.json` | B16.5 group 1.1 P-T ratings (bar at 38 / 50 / 100 / 150 / 200 °C; psig at 100 °F) | A / B per row |
| `data/asme_b16_9_buttweld_fittings.json` | B16.9 LR 90 / LR 45 / SR 90 centre-to-end, tee run, concentric reducer length; negative example | A / B per row |
| `data/en_1092_1_flanges.json` | EN 1092-1 PN16 connection dimensions (DN50..200), PN40 DN100 | A (DN100) / B |
| `data/component_references.json` | plain-end mass closed form, B31.3 eq. 3a worked example, B16.10 face-to-face, B16.20 SWG, EN 10220 diameters, scopes | A / B per item |
| `data/llull_pipe_sizes_crosscheck.json` | llull's current `PIPE_SIZES` against B36.10M STD: the EN/ASME mix finding | — |
| `data/sample_spec_cs150.json` | **Test fixture** `CS150-A1` in the proposed `llull-pipe-spec` format (not a sourced spec) | — |
| `data/dodo_*.csv`, `data/LICENSE-dodo-LGPL-3.0.txt` | FreeCAD dodo tables (EN 1092-1 PN16, B16.9 reducers, an elbow table with a non-standard radius), LGPL-3.0 | see sources |
| `expected_results.json` | index of every VC: inputs, expected value, tolerance, source, grade, plan, test | — |
| `plans/sc-psc-0*.json` | CLI scenarios (`build_project` actions + `expected` rows) | — |

## Real use cases

| #  | Use case | What llull must do | VC |
| -- | -------- | ------------------ | -- |
| U1 | An owner asks the agent "lay out a 6-inch naphtha line in our carbon-steel Class 150 spec" | resolve pipe, elbows and flanges from the spec, OD and wall from B36.10M, LR elbow centre-to-end from B16.9 | VC-PSC-01, 03, 08, 15; SC-PSC-01, 02, 04 |
| U2 | A piping engineer sets up a new spec for a cooling-water system | import / edit a spec, branch table, check coverage | VC-PSC-08, 09, 16, 17; SC-PSC-02 |
| U3 | Process changes the design pressure of a line from 18 to 19.5 bar at 45 °C | spec check against B16.5 group 1.1 rating, refuse with a stable code | VC-PSC-07, 10; SC-PSC-03 |
| U4 | Spec writer decides the schedule for a 1200 psig NPS 4 line | B31.3 eq. 3a with CA and mill tolerance, lightest schedule ≥ required | VC-PSC-11; SC-PSC-03 |
| U5 | Structural engineer needs the operating weight of a line for pipe-rack design (feeds `check_pipe_supports`) | mass per metre steel + contents from the spec's OD / wall | VC-PSC-02; SC-PSC-01, 04 |
| U6 | A European project mixes EN 10220 tube and ASME fittings | flag the end-diameter mismatch | VC-PSC-14; SC-PSC-05 |
| U7 | A contractor delivers a catalogue taken from a CAD add-on | import with provenance; check dimensions against standard rules | VC-PSC-05; SC-PSC-05 |
| U8 | Fabricator orders flanges, gaskets and studs for NPS 4 Cl150 joints | flange OD / bolt circle / 8 × 5/8 in studs, SWG rings, valve face-to-face for spool lengths | VC-PSC-06, 12, 13 |

## Validation cases

| VC | What | Reference | Tolerance | Grade |
| -- | ---- | --------- | --------- | ----- |
| VC-PSC-01 | Pipe OD / wall by NPS and schedule; NPS 6 Sch 40 = 168.3 / 7.11 mm; all 86 grade-A rows | B36.10M via S1 + S2 | exact (0.01 mm print) | A |
| VC-PSC-02 | Mass per metre: 28.264 kg/m (NPS 6 Sch 40), 16.075 (NPS 4 Sch 40), 8.633 (NPS 2½ Sch 40); water-filled 46.909 kg/m; existing `pipeWeightPerMetre(168.3, 1000)` = 0.46002 kN/m | m = 0.0246615 (D − t) t [S16, S17] | 1e-3 kg/m | A |
| VC-PSC-03 | B16.9 LR 90 centre-to-end 76.2 / 152.4 / 228.6 mm (NPS 2/4/6); LR 45 63.5 / 95.25 mm (NPS 4/6) | S8, S9, S10; A = 1.5 × NPS | 0.01 mm (inch × 25.4); printed metric ±0.5 mm | A |
| VC-PSC-04 | B16.9 concentric reducer length NPS 4 = 102 mm, NPS 8 = 152 mm | S11, S12 | 0.5 mm | A |
| VC-PSC-05 | Catalogue check flags an "LR" elbow with radius 0.75 × OD (126.2 mm at NPS 6) as `PSC_CATALOG_DIM_MISMATCH`; uncited value refused `PSC_PROVENANCE_MISSING` | B16.9 rule; dodo negative example | code + path | A / behavioural |
| VC-PSC-06 | B16.5 NPS 4 Cl150 WN RF: OD 228.6, bolt circle 190.5, 8 × 5/8 in, hole 19.05 mm; bolt count + size on all 24 rows | S2, S3, S4 | 0.01 mm; counts exact | A |
| VC-PSC-07 | Group 1.1 rating Cl150 19.6 bar, Cl300 51.1 bar at ≤ 38 °C; 45 °C interpolated 19.3667 bar; Cl150 285 psig | S5, S6, S7 | 1e-3 bar | A |
| VC-PSC-08 | Spec resolution: NPS 6 elbow → E90-LR Sch 40, 228.6 mm; NPS 1 → socket-weld E90-SW (unverified dims); NPS 10 pipe → STD 9.27 mm; NPS 30 → `PSC_SIZE_OUT_OF_RANGE` | fixture + B36.10M / B16.9 | exact | A / behavioural |
| VC-PSC-09 | Branch table: 6×6 T, 6×4 RT, 6×2 W, 6×1 S, 4×6 `PSC_BRANCH_UNDEFINED` | fixture | exact | behavioural |
| VC-PSC-10 | Spec design check: 19.0 bar at 45 °C passes the rating; 19.5 bar fails `PSC_PT_RATING_EXCEEDED` | VC-PSC-07 | exact | A |
| VC-PSC-11 | B31.3 eq. 3a: t = 3.5205 mm, required nominal 7.452 mm → Sch 80 (8.56); Sch 40 → `PSC_WALL_INSUFFICIENT`; `reviewRequired: true` | S18, S19 | 5e-4 mm | A |
| VC-PSC-12 | B16.10 Cl150 RF gate valve face-to-face 178 / 229 / 267 mm (NPS 2/4/6) | S20, S21 | 0.5 mm | A |
| VC-PSC-13 | B16.20 SWG NPS 4 Cl150: inner ring ID 106.4, centering ring OD 174.8 (sealing element 149.4 is B) | S22, S23, S24 | 0.05 mm | A / B |
| VC-PSC-14 | EN 1092-1 PN16 DN100 D 220, K 180; EN 10220 + ASME B16.9 spec flagged `PSC_DIM_STANDARD_MIXED` | S13, S14; EN 10220 list | 0.01 mm; code | A |
| VC-PSC-15 | `add_pipe_run` with `spec` + `nps: 2.5` → OD 73.0 mm, Sch 40; legacy `dn: 65` still 76.1 mm | S1, S2; current `pipeSizes.ts` | 0.001 mm | A |
| VC-PSC-16 | Unverified data propagates (`verified: false`, `PSC_DATA_UNVERIFIED`); draft spec warns `PSC_SPEC_NOT_APPROVED`; agent approval → `PSC_HUMAN_GATE` | AF-32/33/34 | codes | behavioural |
| VC-PSC-17 | Export → import → export is byte-identical (sha256 of canonical JSON); a plan replayed gives identical ids and data | AF-13 | exact | behavioural |
| VC-PSC-18 | NPS 14: B36.10M Sch 10 = 6.35 mm vs B36.19M 10S = 4.78 mm returned distinctly with their standard tag | S1 (S2 mislabels 4.78 as Sch 10) | values differ | B / behavioural |
| VC-PSC-19 | LR 90 elbow NPS 6 solid: in-plane extent 312.75 mm (228.6 + 168.3/2), out-of-plane 168.3 mm | closed form from VC-01 / VC-03 | 0.5 % (mesh), 1e-6 mm (OCC) | A |

### Derivations used as expectations

- **Mass per metre** (VC-PSC-02): `0.0246615 = π × 7850 kg/m³ × 10⁻⁶`; NPS 6 Sch 40: 0.0246615 × 161.19 × 7.11 =
  28.2638 kg/m; ID = 168.3 − 2 × 7.11 = 154.08 mm; water π/4 × 0.15408² × 1000 = 18.6459 kg/m; sum 46.9096 kg/m;
  × 9.80665 / 1000 = 0.460024 kN/m, the value today's `pipeWeightPerMetre(168.3, 1000)` returns (same formula, wall
  from its STD table), so the new command and the old helper must agree.
- **Interpolated rating** (VC-PSC-07): 19.6 + (19.2 − 19.6) × (45 − 38)/(50 − 38) = 19.3667 bar.
- **B31.3** (VC-PSC-11): t = 1200 × 114.3 / (2 × (19000 × 1 × 1 + 1200 × 0.4)) = 137 160 / 38 960 = 3.52053 mm;
  + c 3 mm = 6.52053 mm; / (1 − 0.125) = 7.45203 mm. B36.10M NPS 4 walls (S1): Sch 40 6.02, Sch 80 8.56 → Sch 80.
- **Elbow bounds** (VC-PSC-19): bend centre at the origin, end faces in the planes x = 0 and y = 0: the outer wall at
  θ = 0 reaches x = R + OD/2 = 228.6 + 84.15 = 312.75 mm; same along y; out of plane ± OD/2.
- **Spec resolution** (VC-PSC-08/09): the fixture is the source of the *selection*; the *dimensions* returned with
  the selection are the grade-A catalogue rows.

### Current-state findings the pack pins

- llull's `PIPE_SIZES` mixes EN 10220 outside diameters (26.9, 33.7, 42.4, 76.1, 139.7) with ASME STD walls
  (`data/llull_pipe_sizes_crosscheck.json`). An ASME NPS 2½ pipe (OD 73.0) or NPS 5 (OD 141.3) is more than the
  1.5 mm match tolerance away from the llull row, so `pipeWallThickness` falls back to `max(2.5, OD/40)` (2.5 mm
  instead of 5.16; 3.53 mm instead of 6.55) and the weight used by the support and frame checks is low. VC-PSC-15 keeps
  legacy pipes unchanged and makes spec-driven pipes exact.
- `formulab` 0.72.3 lists 4.78 mm as "SCH10" for NPS 14 and 16; B36.10M Sch 10 is 6.35 mm and 4.78 mm is B36.19M 10S.
  VC-PSC-18 guards against the same mix-up in llull's catalogue.
- A FreeCAD piping table labels elbows with a bend radius of 0.75 × OD; B16.9 LR is 1.5 × NPS (VC-PSC-05).

## What could not be verified

- ASME B16.11 socket-weld / threaded dimensions, MSS SP-97 olets, EN 10253 fittings, B16.47 Series A/B, caps,
  reducing tees: no two open sources. The open catalogue ships these as empty families; a user imports them from a
  licensed catalogue (FR-PSC-03). Results using them are `verified: false` (VC-PSC-08 NPS 1 case).
- B16.5 ratings for other material groups and above 50 °C for Class ≥ 300 (sources disagree): not shipped; the rating
  table format accepts them on import with provenance.
- B31.3 allowable stresses (Table A-1): not shipped; `pipe_wall_check` requires S explicitly (AF-31).
- Plant 3D `.pspc` SQLite schema: only the file roles are public (sources P3); direct import is V2.
