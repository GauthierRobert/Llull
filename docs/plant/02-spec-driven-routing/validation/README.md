# Gap 02 RTE — Validation pack

This pack proves that llull's spec-driven routing builds the right pipe: the right fittings, in the right number,
with the right cut lengths, connected to the right ports, and that it refuses or flags what a piping designer
would refuse or flag. Every reference value is (a) quoted from a source in [sources.md](sources.md) (grade A
gates, B / C do not), (b) derived from a cited closed form with the derivation shown below, or (c) marked
`TBD — measure with <tool>`. **No expected value was produced by running llull** (nothing of this gap is built).

How the cases run once the MVP lands (TECHNICAL_SPEC §9):

- Unit tests read `data/*.json` directly.
- `tests/unit/plant/scenarioPlans.test.ts` runs every `plans/*.json` through `build_project` (the path of
  `llull run plan.json --json`) after loading `data/spec_stub_cs150.json` through 01 PSC's `import_pipe_spec`, then
  compares each `expected` row (`path`, `value`, `abs` / `rel`). Plans with `cases` run each case as its own plan.
- The production-gate agent driver runs the same plans unattended (AF-23).

## Gate policy

- Gates: grade A rows and closed forms. The spec stub's numbers are **inputs**: every cut length is derived from
  the stub value the plan loads (e.g. gasket 3.0 mm, grade C as a standard value, is a declared input, not a
  claim about B16.21). Rows whose standard value is grade A (90 LR A, tee C / M, gate valve F-F) are also checked
  against the stub by `catalogueConsistency.test.ts` so the stub cannot drift from the published tables.
- Project rules (weld spacing, handwheel height, insulation thickness table, branch table) are **named defaults or
  explicit params**; their numbers never gate a claim about a standard.
- PCF output is not gated here (no openly licensed sample was reachable); 05-isometrics-fabrication owns it.

## Files

| File                                 | Content                                                                                                                                                           | Grade                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `data/b36_10m_pipe_dimensions.json`  | ASME B36.10M OD / Sch 40 / STD wall NPS 2-12, transcribed from fluids 1.3.1 (MIT) and cross-checked with llull `PIPE_SIZES`                                       | A                                      |
| `data/b16_9_fitting_dimensions.json` | B16.9 LR 90 A, LR 45 B, tee C = M, reducing tee 6×4, concentric reducer H; derived check B vs R tan 22.5°                                                         | A per row (reducers 3×2 / 4×3 / 6×4 B) |
| `data/flanged_components.json`       | B16.5 CL150 WN length through hub, bolt holes, raised face; B16.10 gate valve F-F; gasket thickness input; B31.3 socket-weld gap                                  | A / B / C per row                      |
| `data/insulation_heat_loss.json`     | ht 1.2.0 insulated-pipe example (73.120 W/m) + formula; own re-derivation                                                                                         | A                                      |
| `data/routing_rules.json`            | Vendor behaviours and project rules with their status (standard / vendor / project default)                                                                       | A / B / C per row                      |
| `data/spec_stub_cs150.json`          | Minimal spec CS150 (pipe, elbows, tees, reducer, olet, WN flanges, gaskets, bolt sets, gate valve, connection rules, branch table, insulation table) — plan input | inputs                                 |
| `expected_results.json`              | Index of every VC                                                                                                                                                 | —                                      |
| `plans/sc-rte-0*.json`               | `build_project` scenarios with `expected` rows; `status` / `unbuilt` list what is missing today                                                                   | —                                      |

## Real use cases

| #   | Use case                                                              | What llull must do                                                         | VC / plan                |
| --- | --------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------ |
| U1  | Pump discharge to a feed drum, DN100 CL150                            | port-to-port compass route, 4 elbows, 2 flange sets, cut list              | VC-RTE-01..03, SC-RTE-01 |
| U2  | Isolation valve on the pump discharge                                 | inline valve, flange sets, operability warning                             | VC-RTE-04, 05, SC-RTE-02 |
| U3  | Cooling-water header with branches                                    | branch table: reducing tee and weldolet; open-end detection                | VC-RTE-06, 07, SC-RTE-03 |
| U4  | Gravity drain at 1 %                                                  | slope geometry, elbow tolerance accept / refuse                            | VC-RTE-08, SC-RTE-04     |
| U5  | Agent mistakes (wrong size, rating, end type, short legs, odd angles) | stable codes, document unchanged                                           | VC-RTE-09..11, SC-RTE-05 |
| U6  | Brownfield: the drum is moved                                         | orthogonal stretch of the connected line                                   | VC-RTE-12, SC-RTE-06     |
| U7  | Hot insulated line near steel                                         | insulated envelope in clashes, line number with insulation code, heat loss | VC-RTE-13, 14, SC-RTE-07 |
| U8  | Old model with polyline pipes                                         | conversion to spec-driven runs                                             | VC-RTE-20, SC-RTE-09     |
| U9  | Auto-route (V2)                                                       | minimum bends and length in free space                                     | VC-RTE-18, SC-RTE-08     |

## Validation cases

| VC        | What                                                                                                                                                                               | Reference                                                         | Tolerance                                                                    | Test / plan                           | FR / TR               | AF           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------- | --------------------- | ------------ |
| VC-RTE-01 | Pump-to-vessel cut lengths 1269 / 2696 / 2696 / 1196 / 2769, total 10 626 mm; closing leg +X 3000                                                                                  | closed form §D1 with stub A 152, Y 76, g 3                        | 0.01 mm                                                                      | `jointStack.test.ts`, SC-RTE-01       | FR-RTE-03, 05, 06, 09 | AF-21        |
| VC-RTE-02 | Fitting counts: 4 elbow90LR, 2 WN, 2 gaskets, 2 bolt sets (16 studs), 5 pieces, 10 butt welds, 2 flanged joints                                                                    | topology §D1; B16.5 NPS 4 CL150 8 holes [S14][S15]                | exact                                                                        | SC-RTE-01                             | FR-RTE-04, 06, 15     | AF-10        |
| VC-RTE-03 | Centreline length 11 739.044 mm (4 × (π/2) × 152 arcs)                                                                                                                             | closed form §D1                                                   | 0.01 mm                                                                      | `fittings.test.ts`, SC-RTE-01         | FR-RTE-05, 15         | AF-21        |
| VC-RTE-04 | Gate valve inline: faces z 1685.5 / 1914.5; leg-0 cuts 527.5 / 354.5; 4 flange sets, 12 welds                                                                                      | §D2; B16.10 CL150 NPS 4 F-F 229 [S16][S17]                        | 0.01 mm; counts exact                                                        | SC-RTE-02                             | FR-RTE-07             | AF-21        |
| VC-RTE-05 | Handwheel centre 1800 > explicit limit 1500 → `RTE_VALVE_OPERATOR_HEIGHT` with the valve id                                                                                        | explicit param (no code value exists [S24])                       | exact code                                                                   | `checks.test.ts`, SC-RTE-02           | FR-RTE-18, 13         | AF-11, AF-31 |
| VC-RTE-06 | Branch table → reducing tee 6×4 and weldolet 6×2; header cuts 3857 / 5857, branch 1870                                                                                             | B16.9 6×6×4 C 143 / M 130 [S9][S12]; stub branch table            | 0.01 mm                                                                      | `branches.test.ts`, SC-RTE-03         | FR-RTE-08, 09         | AF-35        |
| VC-RTE-07 | Exactly one `RTE_OPEN_END` (free DN50 branch); status warn                                                                                                                         | topology                                                          | exact                                                                        | SC-RTE-03                             | FR-RTE-12, 13         | AF-20        |
| VC-RTE-08 | Slope 1 %: drop 80, leg 8000.39999, 0.572939°, turn 89.427061° → 90 LR elbow; cuts 7924.39999 / 844; tolerance 0.5° → `RTE_NO_FITTING_FOR_ANGLE`                                   | closed form §D4; tolerance behaviour [S1][S23]                    | 1e-6 mm / 1e-6°                                                              | `fittings.test.ts`, SC-RTE-04         | FR-RTE-05, 10         | AF-04, AF-11 |
| VC-RTE-09 | Size / rating / end-type mismatch refused: `RTE_SIZE_MISMATCH`, `RTE_RATING_MISMATCH`, `RTE_NO_CONNECTION_RULE`; document deep-equal to input                                      | vendor behaviour [S4][S25]                                        | exact                                                                        | SC-RTE-05e/f/g                        | FR-RTE-06, 11, 13     | AF-11        |
| VC-RTE-10 | Legs 250 / 304 / 340 between NPS 4 LR elbows: refused (cut −54) / fitting-to-fitting / weld spacing 36 < 50 (named project default)                                                | closed form `ℓ − 2A`; weld-spacing rule [S22]                     | 0.01 mm                                                                      | `jointStack.test.ts`, SC-RTE-05a/b/c  | FR-RTE-09, 13         | AF-11, AF-31 |
| VC-RTE-11 | 60° turn on a 90 / 45 spec → `RTE_NO_FITTING_FOR_ANGLE`, `detail.angleDeg` 60                                                                                                      | compass = fitting angles [S1]                                     | 1e-4°                                                                        | SC-RTE-05d                            | FR-RTE-05             | AF-11        |
| VC-RTE-12 | Stretch: vessel +500 X → last cut 3269; then +500 Y → +Y leg cut 3196, PIs 2-4 shift; elbows still 4                                                                               | algorithm §5.7, closed form                                       | 0.01 mm                                                                      | `stretch.test.ts`, SC-RTE-06          | FR-RTE-14             | AF-13        |
| VC-RTE-13 | Insulation from the spec table: 50 mm; envelope 188.9 mm; line number `80-HO-4001-CS150-H50`; one insulation clash (depth 24.45 mm) with a beam clearing the bare pipe by 25.55 mm | OD 88.9 [S5][S6]; geometry §D7                                    | 1e-9 mm (envelope), 0.5 mm (depth: clash depth is a box approximation today) | SC-RTE-07                             | FR-RTE-02, 16         | AF-31        |
| VC-RTE-14 | Heat loss 73.120 W/m (V1) and `reviewRequired: true`                                                                                                                               | ht 1.2.0 example + own derivation [S19]                           | 1e-4 rel                                                                     | `heatLoss.test.ts`, SC-RTE-07         | FR-RTE-23             | AF-33, AF-35 |
| VC-RTE-15 | Catalogue consistency: 90 LR A within 0.4 mm of 1.5 × NPS × 25.4; 45 LR B is taken from the table (R tan 22.5° differs by up to 3.44 mm at NPS 2), so routing must not compute B   | [S7][S8] two-source rows                                          | 0.5 mm / exact selection                                                     | `catalogueConsistency.test.ts`        | FR-RTE-05             | AF-30        |
| VC-RTE-16 | Pipe OD / wall used by routing = B36.10M rows (fluids) = llull `PIPE_SIZES` for DN50-250 (DN300 OD 323.8 vs 323.9: same 12.75 in)                                                  | [S5][S6]                                                          | 0.11 mm                                                                      | `catalogueConsistency.test.ts`        | FR-RTE-04             | AF-30        |
| VC-RTE-17 | Determinism: SC-RTE-01 twice → identical ids, `data` and order; golden snapshot stable                                                                                             | AF-13                                                             | exact                                                                        | golden `piping_pump_to_vessel`        | FR-RTE-24             | AF-13        |
| VC-RTE-18 | Auto-route (V2) in free space: length 6000 (Manhattan), 2 bends, `optimal: true`                                                                                                   | closed form (3 axes ⇒ ≥ 2 bends)                                  | exact                                                                        | `autoRoute.test.ts`, SC-RTE-08        | FR-RTE-22             | AF-40        |
| VC-RTE-19 | Every `RTE_*` refusal in TECHNICAL §7 is reachable from a plan, carries `ids` / `paths` / remediation, and leaves the document unchanged (deep-equal)                              | AF-11                                                             | exact                                                                        | `refusals.test.ts` (table-driven)     | FR-RTE-24             | AF-11        |
| VC-RTE-20 | Legacy `add_pipe_run` → run: 2 elbows, cuts 3848 / 2696 / 2348, 4 welds, 2 open ends, line number kept                                                                             | closed form §D9                                                   | 0.01 mm                                                                      | SC-RTE-09                             | FR-RTE-19             | AF-13        |
| VC-RTE-21 | Unverified propagation: a line on the stub spec (`status: stub`) shows `unverified: true` in `piping_takeoff` and `RTE_SPEC_UNVERIFIED` in `check_piping`                          | AF-32                                                             | exact                                                                        | `checks.test.ts`                      | FR-RTE-26             | AF-32, AF-33 |
| VC-RTE-22 | Heat tracing (V1): traced length = tracers × (centreline + Σ allowances); SC-RTE-07 line, 1 tracer, no allowances → 6.000 m                                                        | closed form, explicit inputs                                      | 1e-6 m                                                                       | `takeoff.test.ts`                     | FR-RTE-17             | AF-31        |
| VC-RTE-23 | Display geometry: SC-RTE-01 elbow solid volume vs Pappus π (OD/2)² · R · π/2 = 2 449 885.6 mm³ (OD 114.3, R 152); 16-segment section gives ratio 0.97450                           | closed form (Pappus; regular-polygon area ratio (n/2π) sin(2π/n)) | ratio in [0.970, 1.001]                                                      | `mass_properties` on the elbow entity | FR-RTE-20             | AF-21, AF-22 |
| VC-RTE-24 | Export hand-off: `piping_takeoff` counts of SC-RTE-01 equal the IFC `IfcPipeFitting` / `IfcPipeSegment` / `IfcDistributionPort` counts (08) and the PCF component records (05)     | TBD — measure with the 08 / 05 exporters once built               | exact                                                                        | 08 / 05 packs                         | FR-RTE-21, 25         | AF-10        |

## Derivations used as expectations

Common inputs (stub CS150): NPS 4 LR 90 A = 152, WN CL150 Y = 76, gasket g = 3.0, weld gap 0
(centre-to-end includes the gap; named default).

- **D1 (SC-RTE-01).** PIs: P0 (0,0,1000) → (0,0,2500) → (0,3000,2500) → (3000,3000,2500) → (3000,3000,4000) →
  (6000,3000,4000). Leg lengths 1500, 3000, 3000, 1500, 3000 (sum 12 000). Cuts: 1500 − (3 + 76) − 152 = 1269;
  3000 − 2·152 = 2696 (twice); 1500 − 304 = 1196; 3000 − 152 − 76 − 3 = 2769; total 10 626. Elbow arc
  (π/2)·152 = 238.761; centreline 12 000 − 8·152 + 4·238.761 = 11 739.044. Butt welds: 2 per elbow (8) + 1 per WN
  flange (2) = 10. Studs 2 × 8 = 16.
- **D2 (SC-RTE-02).** Valve F-F 229 centred at z 1800: faces 1685.5 / 1914.5. Lower piece
  (1685.5 − 3 − 76) − (1000 + 3 + 76) = 527.5. Upper piece (2500 − 152) − (1914.5 + 3 + 76) = 354.5.
- **D3 (SC-RTE-03).** Header 0 → 10 000 with a 6×6×4 tee at 4000 (C 143): 4000 − 143 = 3857 and
  6000 − 143 = 5857 (the weldolet at 7000 does not cut the header). Branch to TP-3 at y 2000: 2000 − 130 = 1870.
- **D4 (SC-RTE-04).** s = 0.01, plan length 8000: drop 80; leg √(8000² + 80²) = 8000.39999; angle atan 0.01 =
  0.5729387°; turn into the vertical acos(80 / 8000.39999) = 89.4270613°, deviation 0.5729387° (≤ 1° accept,
  > 0.5° refuse). NPS 2 A = 76: cuts 8000.39999 − 76 = 7924.39999 and (1000 − 80) − 76 = 844.
- **D5 (SC-RTE-05).** Two NPS 4 LR elbows need 2·152 = 304 between PIs: 250 → −54 (refuse), 304 → 0
  (fitting-to-fitting), 340 → 36 (< max(4·6.02, 50) = 50 → warning).
- **D6 (SC-RTE-06).** §5.7 walk: Δ = (500,0,0) on leg 4 (+X) → 3000 + 500 − 152 − 76 − 3 = 3269. Then
  Δ = (0,500,0): legs 4 (+X), 3 (+Z), 2 (+X) are perpendicular (their PIs move +500 Y), leg 1 (+Y) absorbs it:
  3500 − 304 = 3196.
- **D7 (SC-RTE-07).** NPS 3 OD 88.9, insulation 50: envelope 188.9 (radius 94.45). Pipe centre z 3000; IPE200
  (depth 200) with its axis at z 2830 (axis assumed at the centroid; to confirm against `add_steel_member`): top 2930. Bare pipe bottom 2955.55 → clear by 25.55; insulation bottom 2905.55 → penetration 24.45.
- **D8 (SC-RTE-08).** Free space, start leaving +X at the origin, end entering travelling +Z at (3000, 2000,
  1000): every path has length ≥ |Δx| + |Δy| + |Δz| = 6000; three non-zero axis displacements need three
  directions, so ≥ 2 bends; the path +X 3000, +Y 2000, +Z 1000 reaches both bounds.
- **D9 (SC-RTE-09).** Legacy points (1000,3000,1500) → (5000,3000,1500) → (5000,6000,1500) → (5000,6000,4000):
  legs 4000, 3000, 2500; open ends (gap 0): 4000 − 152 = 3848; 3000 − 304 = 2696; 2500 − 152 = 2348.

All derivations were recomputed with a scratch Python script (closed forms only; no llull code).

## Known limits of this pack

- No PCF / IDF sample could be downloaded (see sources.md "Not verified"); the hand-off is a 05 ISO VC.
- Weldolet heights are not verified (SC-RTE-03 DN50 cut is TBD).
- The WN flange Y values differ by 1.3-1.6 mm between sources (raised face included or not); they are stub
  inputs, not gates.
- The beam-axis convention in SC-RTE-07 must be confirmed against `add_steel_member` before the plan is run.
- Handwheel height, insulation thickness and branch-table cells are project data with no public standard value.
