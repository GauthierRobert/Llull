# UXD — Validation plan

Proves that a professional can draft and model in llull with the incumbent's gestures at the incumbent's speed. Machine
profiles from [`../../readiness_gate.json`](../../readiness_gate.json): baselines on `ref-win11`, budgets on `office-min`.
Grades follow [`../../../plant/TEMPLATE.md`](../../../plant/TEMPLATE.md) plus the spec budget (`target`) of
[`../../VALIDATION.md`](../../VALIDATION.md) §2. Default level **PRL 3**; VC-UXD-54 (UX trace) is **PRL 1**, a prerequisite of
the harness measurements.

## 1. Contents

| File | What |
| ---- | ---- |
| [`expected_results.json`](expected_results.json) | index of the 57 cases (schema [`../../vc.schema.json`](../../vc.schema.json)) |
| [`sources.md`](sources.md) | R1–R37 external sources (URL, method, grade), M1–M3 llull measurements |
| [`generate_refs.mjs`](generate_refs.mjs) | `node generate_refs.mjs`: KLM predictions and every closed-form `expected` in `data/` (no llull import) |
| [`data/benchmark_tasks.json`](data/benchmark_tasks.json) | 15 tasks: fixture region, end state, incumbent / target / today operator sequences |
| [`data/klm_operators.json`](data/klm_operators.json) | KLM operator times (Kieras [R25] with [R26]), M placement rules R1–R5, sensitivity variants |
| [`data/klm_predictions.json`](data/klm_predictions.json) | generated: operator counts, formula and seconds per task and method |
| [`data/coordinate_grammar_cases.json`](data/coordinate_grammar_cases.json) | 18 grammar cases (14 valid with closed-form points, 4 refusals) |
| [`data/snap_cases.json`](data/snap_cases.json) | 15 snap / ortho / polar / tracking / view-cube closed forms |
| [`data/parity_checklist.json`](data/parity_checklist.json) | 38 parity rows (31 MUST) with today's state; filled by the review VC-UXD-56 |
| [`plans/task_fixture.json`](plans/task_fixture.json) | 25-step plan building every task region (runs on main, M1) |

## 2. Real use cases

1. **UC-1 Site layout** (civil): kerb lines by polar entry, offsets, trims, dimensions — T01–T06, T10.
2. **UC-2 Detail revision** (steel): window-select, move / copy by distance, layer change, grip edits — T07–T09, VC-UXD-27.
3. **UC-3 Repetitive placement** (plant): circles / blocks at many intersections with repeat-last — T11.
4. **UC-4 Part edit** (mechanical): extrude, edge fillets, change an earlier dimension, navigate — T12–T15.

## 3. How the benchmark works

- **Task sheet**: each task (`data/benchmark_tasks.json`) fixes a fixture region, the end state (command + params or a geometric
  check) and three methods as KLM operator sequences: the incumbent's expert method (documented mechanisms, sources in the
  task), the llull **target** method (after this pack) and the llull **today** method (null when the task cannot be done to spec
  precision in the UI).
- **KLM prediction** (VC-UXD-51, grade A closed form): seconds = Σ count × operator time with K 0.28, P 1.1, B 0.1, BB 0.2, H 0.4,
  M 1.2 s [R25]; sensitivity runs with K 0.20 and M 1.35 [R25][R26]. M placement follows rules R1–R5 in `klm_operators.json`,
  identical for every design (Kieras: consistency matters more than absolute accuracy). Results (M3, 2026-10-28):

  | Task | Incumbent | Target | Today | Task | Incumbent | Target | Today |
  | ---- | --------- | ------ | ----- | ---- | --------- | ------ | ----- |
  | T01 rectangle | 8.38 | 8.38 | — | T09 layer change | 9.08 | 9.08 | — |
  | T02 polyline by distances | 18.56 | 18.56 | — | T10 dimension | 9.82 | 9.82 | — |
  | T03 circle at intersection | 6.70 | 6.70 | — | T11 4 circles, repeat | 16.28 | 16.28 | — |
  | T04 offset | 8.68 | 8.68 | 6.42 | T12 extrude | 7.44 | 7.44 | 7.44 |
  | T05 trim ×3 | 9.82 | 9.82 | 16.48 | T13 fillet 4 edges | 14.94 | 14.94 | — |
  | T06 fillet | 9.88 | 9.88 | 8.64 | T14 edit depth | 7.84 | 7.44 | 7.44 |
  | T07 move by 50 | 10.40 | 10.40 | 7.16 | T15 iso + fit | 7.50 | 6.48 | 7.50 |
  | T08 3 copies | 14.02 | 14.02 | 12.38 | **Σ** | **159.34** | **157.92** | 8 of 15 |

  Worked example T03 (incumbent): `M K:C⏎ M P BB H M K:25⏎` = 3 M + 1 P + 1 BB + 1 H + 5 K = 3.6 + 1.1 + 0.2 + 0.4 + 1.4 =
  6.70 s. The target equals the incumbent by design on 13 tasks (parity), and is faster on T14 (single-click dimension edit)
  and T15 (fit key). Today's faster rows (T04, T06, T07, T08) come from shorter flows that skip prompts (pick = side for offset;
  nudge keys instead of a typed distance); they stay available in the target.
- **System proof on the harness** (VC-UXD-52, pack 06): the harness performs each task with the target method through `act.*`,
  each step declaring the commands it must produce; `observe.commands` gives the dispatched commands; keystroke and click counts
  from the UX trace (VC-UXD-54) must be ≤ the target counts in `klm_predictions.json`; the document must reach the end state.
  This proves the flow exists and is as short as specified; it does not measure human time.
- **Human time** (VC-UXD-53, pack 01 pilot): the same users, experienced in the incumbent, perform the 15 tasks in both tools on
  the same fixture (counterbalanced order, one warm-up per task, video- or trace-timed from the first input to the end state);
  pass when the median ratio llull / incumbent ≤ 1.2 per task. Incumbent and llull human times: **TBD — measure with the pack 01
  pilot protocol**. The KLM numbers above are predictions, never substitutes for these measurements.

## 4. Validation cases

Level column: PRL of the case ([`../../VALIDATION.md`](../../VALIDATION.md) §1). Drivers: unit / cli / electron (pack 06
harness) / perf (pack 03 runner) / review / field (pack 01).

| VC | Proves | Driver | Metric (short) | Expected / target | Tol. | Source / grade | Level |
| -- | ------ | ------ | -------------- | ----------------- | ---- | -------------- | ----- |
| VC-UXD-01 | FR-06, TR-02 | unit | grammar CG-01..14 | closed-form points | 1e-9 | derived, R5, R31 / A | PRL3 |
| VC-UXD-02 | FR-06, TR-02, TR-15 | unit | grammar refusals CG-15..18 | codes + columns | exact | spec / target | PRL3 |
| VC-UXD-03 | FR-07, FR-06, TR-01 | electron | `@100<30` and dynamic input in the line tool | (96.6025403784, 70) | 1e-9 | derived / A | PRL3 |
| VC-UXD-04 | FR-08 | unit | expressions, units, parameters in numeric fields | 31; 25.4; 20 | 1e-12 | derived, R31 / A | PRL3 |
| VC-UXD-05 | FR-09 | electron | cursor readout abs / rel / polar | formatted strings | exact | derived / A | PRL3 |
| VC-UXD-06 | FR-02, TR-06 | unit | alias file parse, last wins, unknown target | R2 example | exact | R2 / A | PRL3 |
| VC-UXD-07 | FR-01, FR-03, TR-01, TR-06 | electron | `REC` T01 + Space repeat | 1 `draw_rectangle` 120×80 at (300,0) | 1e-9 | derived / A | PRL3 |
| VC-UXD-08 | FR-04 | electron | view actions mid-command | 1 command, 4 points | exact | spec / target | PRL3 |
| VC-UXD-09 | FR-05, FR-46 | electron | session copied as plan → CLI replay | stateHash equal | exact | spec / target | PRL3 |
| VC-UXD-10 | FR-10, TR-03 | unit | snap modes SN-01..08 | closed forms | 1e-9 | derived, R3 / A | PRL3 |
| VC-UXD-11 | FR-10, FR-11 | unit | toggles, master, override | truth table | exact | R3 / A | PRL3 |
| VC-UXD-12 | FR-12 | electron | Tab cycling, tooltip, aperture | 3 candidates | exact | R3 / A | PRL3 |
| VC-UXD-13 | FR-13 | unit | grid snap off → raw cursor | (13.37, 4.21) | exact | derived / A | PRL3 |
| VC-UXD-14 | FR-14 | unit | ortho / polar SN-09..12, exclusivity | closed forms | 1e-9 | derived / A | PRL3 |
| VC-UXD-15 | FR-15, TR-04 | unit | tracking SN-13, SN-14 | (0,50); (50,50) | 1e-9 | derived / A | PRL3 |
| VC-UXD-16 | FR-16, TR-05 | electron | 3D vertex / circle-centre snap | rotated corner; (0,0,20) | 1e-6 | derived / A | PRL3 |
| VC-UXD-17 | FR-17 | electron | sketch inference, Ctrl suppresses | 1 undo step | exact | R18 / target | PRL3 |
| VC-UXD-18 | FR-18 | unit | window vs crossing on region G | 3 / 5 ids | exact | derived, R6 / A | PRL3 |
| VC-UXD-19 | FR-18, FR-45 | electron | click-click box = drag box | same ids | exact | R32 / A | PRL3 |
| VC-UXD-20 | FR-19 | electron | selection cycling | 3 ids visited | exact | R7 / target | PRL3 |
| VC-UXD-21 | FR-20 | electron | select all / previous / invert | scripted ids | exact | spec / target | PRL3 |
| VC-UXD-22 | FR-21, TR-09 | cli | `select_similar`, `select_by_filter` | G1..G5 | exact | derived / A | PRL3 |
| VC-UXD-23 | FR-22, TR-01 | electron | verb-noun move | delta (50,0,0) | 1e-9 | derived / A | PRL3 |
| VC-UXD-24 | FR-23, FR-44 | electron | hover latency, pick filters | ≤ 16.7 ms | p95 | derived / target | PRL3 |
| VC-UXD-25 | FR-24, FR-25, TR-08 | cli | `list_grips` positions | closed forms | 1e-9 | derived / A | PRL3 |
| VC-UXD-26 | FR-25, TR-08, TR-09, TR-15 | unit | `edit_grip` ops, codes, purity | closed forms | 1e-9 | derived / A | PRL3 |
| VC-UXD-27 | FR-24 | electron | grip drag = 1 command, undo, menu, Space cycle | 1 | exact | R8 / target | PRL3 |
| VC-UXD-28 | FR-26 | electron | typed gizmo value, pivot | 25 | 1e-9 | derived / A | PRL3 |
| VC-UXD-29 | FR-27, TR-09 | cli | stretch / break / join / lengthen | closed forms | 1e-9 | derived / A | PRL3 |
| VC-UXD-30 | FR-27 | electron | copy / rotate / scale / mirror click flows | T08 end state | 1e-9 | derived / A | PRL3 |
| VC-UXD-31 | FR-28, FR-29 | electron | 3-point arc, DLI, LINE chain | centre (50,0) r 50; 300 | 1e-9 | derived / A | PRL3 |
| VC-UXD-32 | FR-30 | electron | multi-edit layer = 1 command | 1 command, 5 ids | exact | R10 / target | PRL3 |
| VC-UXD-33 | FR-31, TR-09 | cli | `match_properties` | chosen fields copied | exact | derived / A | PRL3 |
| VC-UXD-34 | FR-32, TR-09 | cli | layer states, current layer | round trip | exact | derived / A | PRL3 |
| VC-UXD-35 | FR-33, TR-07, TR-15 | unit | keymap bindable / conflict / round trip | all bindable | exact | R21, R16 / target | PRL3 |
| VC-UXD-36 | FR-34 | electron | F3 F8 F9 F10 F11 F12 + status buttons | 12 | exact | R4 / target | PRL3 |
| VC-UXD-37 | FR-35, FR-36 | electron | shortcut bar, gestures | ≤ 100 ms | p95 | R16, R17, R29 / target | PRL3 |
| VC-UXD-38 | FR-37 | unit | tooltips show key + alias; no network | 100 %; 0 | exact | R34, R36 / target | PRL3 |
| VC-UXD-39 | FR-38 | electron | navigation presets, pan while drawing | §5.9 table | exact | R20 / target | PRL3 |
| VC-UXD-40 | FR-39 | electron | view cube directions, orbit point, previous | 26 | 1e-6 | derived / A | PRL3 |
| VC-UXD-41 | FR-40, TR-11 | review | SpaceMouse certification items, fps ratio | ≥ 0.9 | median | R23 / A | PRL3 |
| VC-UXD-42 | FR-41 | electron | previews never dispatch | 0 | exact | spec / target | PRL3 |
| VC-UXD-43 | FR-42, FR-45, TR-06, TR-14 | electron | prompt line content, aria, axe | 0 violations | exact | R32, R33 / target | PRL3 |
| VC-UXD-44 | FR-43, TR-09 | cli | `set_rollback` | replay to marker | exact | R19 / target | PRL3 |
| VC-UXD-45 | FR-44, TR-03, TR-13 | perf | snap query 1k / 10k / 100k | ≤ 2 ms | p95 | spec / target | PRL3 |
| VC-UXD-46 | TR-03 | unit | index = brute-force oracle | 0 mismatches | 0 | derived / A | PRL3 |
| VC-UXD-47 | FR-44, FR-41, TR-13 | perf | rubber-band frame time 10k | ≤ 16.7 ms | p95 | derived / target | PRL3 |
| VC-UXD-48 | FR-44, TR-13 | electron | commit-to-paint, key-to-armed | ≤ 100 ms | p95 | R29 / target | PRL3 |
| VC-UXD-49 | FR-45, TR-14 | review | WCAG 2.2 AA audit | accept | — | R32, R33 / target | PRL3 |
| VC-UXD-50 | FR-46 | unit | gesture tables name registered commands | 0 violations | 0 | spec / target | PRL3 |
| VC-UXD-51 | FR-47 | unit | KLM predictions reproduce; target ≤ incumbent | §3 table | 0.001 s | derived, R25 / A | PRL3 |
| VC-UXD-52 | FR-47, TR-01 | electron | 15 tasks, end state, counts ≤ target | `klm_predictions.json` | ≤ | derived / A | PRL3 |
| VC-UXD-53 | FR-47 | field | median human time ratio | ≤ 1.2 | median | spec (R26 band) / target | PRL3 |
| VC-UXD-54 | TR-12 | electron | UX trace events, order, off by default | event order | exact | spec / target | **PRL1** |
| VC-UXD-55 | TR-10, FR-46 | unit | preferences outside the document / undo | 0 commands | exact | spec / target | PRL3 |
| VC-UXD-56 | FR-47 | review | parity checklist all MUST met | accept | — | spec / target | PRL3 |
| VC-UXD-57 | FR-01, FR-44 | electron | suggestion list per keystroke | ≤ 50 ms | p95 | spec / target | PRL3 |

Ids in the "Proves" column abbreviate `FR-UXD-nn` / `TR-UXD-nn`.

## 5. Running on the Electron harness (pack 06)

The harness itself (launch modes, `act.*` DSL, `observe.*`, `perf.*`, VC runner, CI matrix) is specified in
[`../../06-desktop-e2e/TECHNICAL_SPEC.md`](../../06-desktop-e2e/TECHNICAL_SPEC.md); this pack only supplies:

- the fixture (`plans/task_fixture.json`, loaded with `llull run` into the instance before each task);
- per task, the target-method steps as `act.press` / `act.type` / `act.click` at fixture coordinates mapped to screen by the
  harness, each declaring `expect` commands (e.g. T03: `expect: [{ name: 'draw_arc', params: { center: [500, 50], radius: 25 } }]`);
- tags `@VC-UXD-nn` on the desktop tests so `npm run e2e:vc -- --pack docs/readiness/02-drafting-interaction --vc …` maps
  results to this index;
- timing through `perf.measure` around each task and the UX trace (TR-UXD-12) for keystroke / click counts and the latency
  cases (VC-UXD-24, -48, -57).

`perf` cases (VC-UXD-45, -47) run on the pack 03 runner with generated drawings of 1k / 10k / 100k segments (seeded, random
lines and arcs in a square of side 10 000 mm; generator owned by 03 PRF).

## 6. Commands and capabilities that do not exist yet

Used by cases but not on main (2026-10-28): `list_grips`, `edit_grip`, `copy_entities`, `rotate_entities`, `scale_entities`,
`mirror_entities`, `stretch_2d`, `break_2d`, `join_2d`, `lengthen_2d`, `match_properties`, `set_current_layer`,
`save_layer_state`, `restore_layer_state`, `delete_layer_state`, `select_similar`, `select_by_filter`, `set_rollback`,
`set_entity_layer.entityIds`, `trim.boundary`, `annotations.prompts`; the UI pieces of TECHNICAL_SPEC §2.1. The fixture plan
uses existing commands only (M1).

## 7. Notes on the data

- Every `expected` in `data/` is written by `generate_refs.mjs` from the `meaning` / `input` fields; re-run it after any edit and
  commit the outputs (VC-UXD-51 checks they reproduce).
- Incumbent operator sequences use mechanisms documented in sources.md; alias strings other than `L C E P Z` [R2] are grade C
  (assumed shipped defaults). Changing an alias length by one character changes the prediction by 0.28 s.
- KLM assumes error-free expert execution and its RMS error is 21 % [R26, grade B]; it gates only "target ≤ incumbent under the
  same rules" and the operator counts of the shipped flow, never human time.
- Nothing in this pack is measured on users yet: VC-UXD-53 is `TBD — measure` until the pilot (01 PIL) runs.
