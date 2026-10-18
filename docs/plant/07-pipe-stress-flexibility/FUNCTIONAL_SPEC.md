# Gap 07 PST — Pipe stress and flexibility analysis: functional specification

Status: written 2026-10-18, specification only (nothing built). Authoring rules: [`../TEMPLATE.md`](../TEMPLATE.md).
Operator model: [`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md) (AF-nn). Validation:
[`validation/README.md`](validation/README.md). Technical design: [`TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md).

## 1. Summary

llull routes pipes (`add_pipe_run`), places shoes, guides, anchors and hangers (`add_pipe_support`), checks
support spacing against the MSS SP-69 / B31.1 span table (`check_pipe_supports`), computes pressure drop
(`pipe_hydraulics`) and pipe weight per metre (`pipeWeight.ts`). It cannot say whether a hot line will crack at
an elbow, lift off its supports, push a pump out of alignment or overload the steel it sits on. In a process plant
every line above roughly 150 °C (or on rotating equipment, or large and hot) goes through a **pipe stress
analysis** before the isometric is released: a 3D beam model of the line with its supports, solved for weight,
pressure, thermal expansion and occasional loads, and checked against the piping code (ASME B31.3 for process
plants, B31.1 for power piping). Today that number has to come from CAESAR II, AutoPIPE, ROHR2, START-PROF or
CAEPIPE, and the model has to be rebuilt there by hand or through a neutral file.

This gap adds an **engineering-level pipe flexibility and stress toolset**: build the stress model from the routed
lines, solve it with a 3D pipe-beam finite element solver (with one-way supports, gaps and friction), apply the
B31.3 / B31.1 code rules (sustained, displacement stress range, occasional), compute stress intensification and
flexibility factors, check equipment nozzle loads against API 610 / NEMA SM 23 limits, size spring hangers, and
hand the model to CAESAR II through its neutral file when a qualified stress engineer wants the reference tool.
Every result is computed by llull and is **not an approval**: a qualified piping stress engineer signs it off
(AF-33, AF-34).

## 2. Plant context and value

| Who does it today | Tool | Trigger | What llull adds |
| ----------------- | ---- | ------- | --------------- |
| Stress engineer at an EPC | CAESAR II (Hexagon), AutoPIPE (Bentley), ROHR2 (Sigma), START-PROF, CAEPIPE | stress-critical line list (temperature, size, rotating equipment, relief lines) | the model is built from the 3D routing, not retyped; agent runs the first pass |
| Piping designer in AutoCAD Plant 3D | exports PCF and hands it to the stress team (Plant 3D has no stress solver) [R9] | every stress-critical line | flexibility answer inside the design loop, before the iso is cut |
| Designer in AVEVA E3D | Pipe Stress Interface: writes a CAESAR II neutral file (`.cii`) per stress group, reads back displacements from the CAESAR II `.OUT` report and the returned `.cii` [R10] | stress groups | same round trip, plus a native first-pass solve |
| Designer in Smart 3D | PCF to CAESAR II with mapping files; results published back via Smart Interop Publisher [R11] | stress lines | same, scripted by an agent |
| Owner-operator (brownfield) | hand calc: thermal growth, guided cantilever, "is this loop big enough" | revamp, temperature increase | quick checks with sourced formulas, no licence needed |

The flexibility check is a safety gate: B31.3 requires that piping have sufficient flexibility so that thermal
expansion does not cause failure from overstress or fatigue, leaking joints, or detrimental loads on connected
equipment (B31.3 §319, public scope statement [R1]). Fatigue cracks at elbows and branch welds and pump misalignment
from nozzle loads are the failures this analysis prevents.

## 3. Personas and user stories

- **Operator: AI agent driving the `llull` CLI** (AF-01..05). "Check line P-1203 (DN150, 260 °C, pump P-101 to
  exchanger E-102) for flexibility and pump nozzle loads; add a loop or a spring if needed." The agent runs one
  `build_project` plan: `create_stress_model` from the line, `set_pipe_operating_conditions`,
  `analyze_pipe_stress`, `check_pipe_stress`, `check_nozzle_loads`; it reads every ratio in `data` (AF-10, AF-21)
  and, on a failure, tries a remedy (move a guide, add a loop leg, select a spring) and re-runs.
  - US-1: as an operator I can build the stress model from the routed line and its existing supports without
    retyping geometry.
  - US-2: as an operator I get the governing stress ratio per node, per case, with the code clause and the inputs
    (AF-35), and a stable code for every failure (AF-11).
  - US-3: as an operator I can answer a quick question (thermal growth of 40 m at 180 °C, the SIF of a DN200 long
    radius elbow, the allowable stress range for 20 000 cycles) without building a model.
  - US-4: as an operator I can export the model to CAESAR II for the stress engineer and keep the two in sync.
- **Owner: not an engineer** (plant manager, project owner, small EPC principal). Wants to know "does this line pass,
  what did you change, who must sign". Every summary says, in plain words, what was computed, what failed, and that
  the result needs a qualified stress engineer (AF-33, AF-36).
- **Qualified reviewer: piping stress engineer** (often a PE / chartered engineer for the owner or the EPC). Reviews
  the model, the load cases, the code edition, defaulted inputs and unverified data; compares with CAESAR II on
  critical lines; signs the stress package. Needs the review surface (deformed shape, stress colour map, tables)
  and the CAESAR II hand-off.
  - US-5: as a reviewer I see every defaulted value (cycles, friction, install temperature, code edition) and every
    unverified material value before I sign.
  - US-6: as a reviewer I can approve a stress model revision; an agent cannot (AF-34).

## 4. Scope

| Phase | In scope | Out of scope |
| ----- | -------- | ------------ |
| **MVP** | stress model from `add_pipe_run` + `add_pipe_support` (straight runs, bends as elbows, anchors / rests / guides / line stops / hanger rods); linear-elastic 3D Timoshenko pipe beam; weight, pressure, thermal, imposed displacement; one-way rests, gaps and Coulomb friction (iterative); B31.3 (edition 2018 Appendix D SIFs; 2020+ with user-supplied B31J values) sustained, displacement stress range (eq. 1a / 1b, f by edition), occasional (user load); quick-check queries (thermal growth, SIF/k, allowables, guided cantilever); `check_pipe_stress`; JSON / CSV results; `reviewRequired` and human approval gate | wind and seismic generators, springs design, nozzle standards, modal / dynamic, CII export |
| **V1** | tees, olets, reducers, flanges, valves (rigid with weight), insulation and cladding weight; static wind (pressure by height) and static seismic (g loads) occasional cases; variable / constant spring hanger design and selection from a user-supplied vendor table; nozzle load checks API 610 Annex F, NEMA SM 23, API 617, user tables; equipment nozzle thermal growth as imposed displacement (03 EQP); support loads handed to steel checks (06 STA, existing `check_steel_members`); B31.1; CAESAR II neutral file export; stress report sheet; deformed-shape and stress-ratio rendering | WRC 537 / 297 local shell stresses, B31J tables built in, dynamic |
| **V2** | modal analysis, response spectrum (validated on NUREG/CR-1677 problems), harmonic / relief valve force time history (static DLF); WRC 537 / 297 shell local stress and nozzle flexibility; EN 13480-3, B31.4 / B31.8; buried pipe; CAESAR II results import (`.OUT` displacements) and `.cii` round-trip; expansion joints; slug flow | FEA of fittings (use the CAE plugin), creep range rules, fitness-for-service |

Built-in data is limited to what can be sourced (grade A, AF-30). Material allowables (B31.3 Table A-1) and B31J
tables are copyrighted; the user imports them (licensed copy) and llull marks them `unverified` until a qualified
person signs the import (AF-32).

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source | AF | VC |
| -- | --- | ----------- | --------- | ------ | -- | -- |
| FR-PST-01 | MUST | Build a stress model from routed pipes (by `pipeId`s, `line` or connected network) and their supports: nodes at ends, bends (near / far / mid), supports, branches and every `maxElementLengthMm`; supports mapped to restraints (anchor → 6 DOF, shoe → +vertical one-way with friction, guide → shoe + lateral, hanger rod → vertical rigid one-way in tension). | the model must come from the design, not be retyped | CAESAR II / E3D practice [R10, R11] | AF-01, AF-05 | VC-PST-07, 12 |
| FR-PST-02 | MUST | Operating conditions per line or pipe: up to 9 temperature / pressure sets (T1..T9, P1..P9), installation temperature, fluid density, insulation, corrosion allowance, mill tolerance, design cycles N. Every defaulted value is named in results (`defaulted: true`, source). | code input set | B31.3 §301, §302.3.5 [R1] | AF-04, AF-31 | VC-PST-03, 18 |
| FR-PST-03 | MUST | Material properties for stress: E(T), mean α(T) from the installation temperature, Sh(T), Sc, SMYS / SMTS, density; from a sourced built-in table (carbon steel growth, grade A rows) or an imported table with provenance; non-tabulated temperature refused, never extrapolated. | the result is only as good as the allowables | B31.3 App. C (Table C-1), App. A [R1]; PSI data [S3] | AF-30, AF-32 | VC-PST-04 |
| FR-PST-04 | MUST | Linear static solve of the 3D pipe-beam model (12 DOF elements with shear deformation, elbows with flexibility factor k): weight (pipe + contents + insulation + components), pressure (hoop, longitudinal; optional thrust), thermal expansion, imposed displacements. | the core of flexibility analysis | beam theory; PSI elements [S3] | AF-13 | VC-PST-06, 07, 08, 10, 12 |
| FR-PST-05 | MUST | Non-linear supports: one-way rests (lift-off), gaps on guides and line stops, limit stops, Coulomb friction (μ default 0.3 named), solved iteratively per operating case; non-convergence is a stable failure, never a silent result. | rests lift off and friction loads steel in real plants | PSI supports [S3] | AF-11 | VC-PST-11 |
| FR-PST-06 | MUST | Load cases by code: OPE (W+P+T), SUS (W+P), EXP (range OPE − SUS, algebraic), OCC (user forces; V1 wind / seismic) combined with SUS by scalar sum; editable list; default B31.3 set generated and named. | B31.3 §319, §302.3.6 | [R1], S10, S11 | AF-31 | VC-PST-05, 13 |
| FR-PST-07 | MUST | B31.3 code stresses per node: sustained S_L, expansion S_E with in- / out-of-plane SIFs, occasional; allowables S_h, S_A by eq. 1a and 1b (liberal) with f by **edition** (≤ 2020: 6.0 N^-0.2; 2022: 20 N^-0.333; caps fm 1.2 / 1.0; floor 0.15); ratio per node and governing node per case. | code compliance | S10, S12, S13 | AF-10, AF-21, AF-35 | VC-PST-03, 05, 09 |
| FR-PST-08 | MUST | SIF and flexibility factors: bends / welding elbows (h = T R1 / r2², k = 1.65/h, ii = 0.9/h^(2/3), io = 0.75/h^(2/3), none below 1), with the B31.3-2018 Appendix D formulas built in; for B31.3-2020 and later the user supplies B31J values per component type or the result is flagged `PST_SIF_EDITION`. | elbows and branches are where piping cracks | App. D / B31J [R1, R2], S5, S6 | AF-30, AF-32 | VC-PST-01, 02, 19 |
| FR-PST-09 | MUST | Results in `data` with units: displacements and rotations per node and case, support reactions (force + moment), element end forces, code stresses and ratios, governing summary, lift-off and gap status, friction forces; paged and filterable by node, pipe or support. | an agent and a reviewer read numbers, not plots | AF-21 | AF-10, AF-12 | VC-PST-07, 08 |
| FR-PST-10 | MUST | `check_pipe_stress`: pass / warn / fail list with codes for overstress (per case), lift-off in OPE, non-convergence, missing / unverified material data, defaulted cycles / friction / edition, stale results, unsupported components, excessive displacement (user limit). | agent self-verification | AF-20 | AF-11, AF-20 | VC-PST-18 |
| FR-PST-11 | MUST | Every analysis result carries `reviewRequired: true` with the reason; `approve_pipe_stress` records approval of a model revision by a human-held signature only; editing the model after approval marks the approval stale. | the result supports a release / safety decision | AF-33, AF-34 | AF-33, AF-34, AF-34a | VC-PST-18 |
| FR-PST-12 | MUST | Quick checks without a model: `thermal_growth` (α table, ΔL), `pipe_sif` (component, dims, edition), `pipe_stress_allowables` (Sc, Sh, N, edition → f, SA 1a / 1b), `guided_cantilever` (leg, displacement, D, E → F, M, S, minimum leg). | owner questions, designer rules of thumb | S24, S25 | AF-10, AF-35 | VC-PST-01, 03, 04, 05, 06 |
| FR-PST-13 | SHOULD | Spring hangers: restrained-weight run for hot loads, thermal run for travel, selection from a user-imported vendor spring table (sizes, rates, ranges), variability ≤ 25 % (15 % near rotating equipment, both named defaults), constant-effort hanger when no variable fits; the selected spring becomes a restraint with preload. | hot lines with vertical growth need springs | MSS SP-58 practice, S18 | AF-31 | VC-PST-14 |
| FR-PST-14 | SHOULD | Equipment nozzle checks: API 610 Annex F (component ≤ 2 × Table 5, resultant equations), NEMA SM 23 (3F + M ≤ 500 De, cumulative), API 617 (1.85 × NEMA), API 661 and user tables per nozzle; Table 5 values imported by the user (copyright) with `unverified` until signed. | rotating-equipment alignment | S19–S23 | AF-30, AF-32 | VC-PST-15 |
| FR-PST-15 | SHOULD | Occasional loads: static wind (pressure per height band × shape factor × exposed diameter incl. insulation) and static seismic (gX, gY, gZ fractions of weight); SUS + OCC ≤ 1.33 S_h (B31.3), k S_h (B31.1). | wind and seismic are code load cases | S11, S15 | AF-31 | VC-PST-13 |
| FR-PST-16 | SHOULD | Hand-off: CAESAR II neutral file (`.cii`) export of the model (nodes, elements, bends, restraints, materials, temperatures, pressures, SIF overrides); stress attributes on the PCF written by 05 ISO; V2 import of CAESAR II displacements for comparison. | qualified reviewer uses the reference tool | R10, R11, R12 | AF-12 | VC-PST-16 |
| FR-PST-17 | SHOULD | Report: `pipe_stress_report` writes a stress package (sheet / CSV / HTML: model summary, load cases, inputs with provenance, governing ratios, nozzle and support loads, spring schedule, unverified list, approval block) with `--save`. | the deliverable a reviewer signs | AF-12 | AF-12, AF-36 | VC-PST-18 |
| FR-PST-18 | SHOULD | Review surface: deformed shape (scale), stress-ratio colour per element, support load arrows, lift-off markers, in the 3D view and `render_view --save`; same data as FR-PST-09. | visual review for the reviewer and multimodal agents | AF-22 | AF-21, AF-22 | VC-PST-18 |
| FR-PST-19 | SHOULD | Couplings: equipment nozzle thermal growth (03 EQP) as imposed displacements; support reactions per case handed to steel design as point loads (06 STA, existing `check_steel_members`) instead of the current tributary-weight rule. | the plant is one model | INDUSTRIAL.md pipe loads | AF-35 | VC-PST-12 |
| FR-PST-20 | MUST | Determinism and staleness: same model and inputs give identical results; results carry an input hash; any edit of a pipe, support, condition or material referenced by a model marks recorded results stale. | AF-13, audit | AF-13, AF-40 | AF-13, AF-40 | VC-PST-07 |
| FR-PST-21 | COULD | Modal analysis and response-spectrum seismic (SRSS / CQC), validated on NUREG/CR-1677 Problem 1. | nuclear and high-seismic plants | R13 | AF-40 | VC-PST-17 |
| FR-PST-22 | COULD | Other codes: B31.1 (V1), EN 13480-3, B31.4 / B31.8 (V2), each as a named rule set with its own allowables and SIFs. | non-US projects | R3, R4 | AF-30 | VC-PST-19 |

## 6. Workflows

### 6.1 CLI first (complete)

```text
llull search stress                                  # finds create_stress_model, analyze_pipe_stress, check_pipe_stress ...
llull describe analyze_pipe_stress                   # units of every param (AF-02, AF-04)
llull run plan.json --validate --doc plant.llull     # AF-05: params, aliases, edition and material presence
llull run plan.json --doc plant.llull --json > run.json
llull check_pipe_stress '{"modelId":"$stress1"}' --doc plant.llull --json
llull render_view '{"overlay":"pipe_stress","modelId":"stress-1","case":"EXP"}' --save exp.png
llull pipe_stress_report '{"modelId":"stress-1"}' --save P-1203-stress.html
llull export_caesar_neutral '{"modelId":"stress-1"}' --save P-1203.cii
```

Plan skeleton (full scenarios in `validation/plans/`):

1. `create_stress_model { line: "P-1203", code: "B31.3", edition: "2018", as: "stress1" }`.
2. `set_pipe_operating_conditions { modelId, installTempC: 21, cases: [{ name: "T1", tempC: 260, pressureBar: 12 }], cycles: 7000, fluidDensity: 850 }`.
3. `import_pipe_material_data { materialId: "A106-B", source, rows }` (once per project; human-signed, else `unverified`).
4. `analyze_pipe_stress { modelId }` → data (displacements, reactions, stresses, ratios, governing).
5. `check_pipe_stress { modelId }` → codes; on `PST_EXPANSION_OVERSTRESS` the agent changes the routing / supports
   (commands of 02 RTE and `add_pipe_support`) and re-runs 4–5.
6. `check_nozzle_loads { modelId }` (V1) → per nozzle ratios.
7. `record_pipe_stress_results { modelId }` then `pipe_stress_report` and hand the package to the reviewer.

### 6.2 MCP

Same commands as tools in toolset `pipestress` (`@mcp/toolsets`); `analyze_pipe_stress` is read-only and
idempotent, so cloud agents may call it freely. Large result sets are paged (`nodes`, `cursor`).

### 6.3 UI (review and approval surface)

The reviewer opens the model, browses load cases, sees the deformed shape and ratio colours, opens the inputs table
(defaulted and unverified values highlighted), compares with an imported CAESAR II run (V2), and approves with a
signature (09 PLM signing). No capability exists only in the UI.

## 7. Acceptance criteria

| Id | Given | When | Then | VC |
| -- | ----- | ---- | ---- | -- |
| AC-01 | NPS 6 Sch 40 long-radius elbow (Do 6.625 in, T 0.280 in, R1 9 in) | `llull pipe_sif '{"component":"elbow", ...,"edition":"B31.3-2018"}' --json` | `h` 0.25038, `k` 6.5900, `ii` 2.2656, `io` 1.8880 (1e-4 rel), `provenance` names Appendix D | VC-PST-01 |
| AC-02 | N = 7000 and N = 100 000 cycles, ferrous material ≤ 517 MPa SMTS, edition 2016 | `pipe_stress_allowables` | f 1.0212 (fm 1.2) and 0.6000; edition 2022 gives 1.0455 and 0.4309; for edition ≤ 2002-style cap 1.0 the result names it | VC-PST-03 |
| AC-03 | 30 m carbon steel line 21.1 → 204.4 °C (70 → 400 °F) | `thermal_growth` | 67.52 mm (2.70 in / 100 ft) ± 0.05 mm, `source` Table C-1 / PSI | VC-PST-04 |
| AC-04 | Sc = Sh = 137.9 MPa, SL = 40 MPa, f = 1 | `pipe_stress_allowables` | SA(1a) 206.85 MPa, SA(1b) 304.75 MPa | VC-PST-05 |
| AC-05 | guided cantilever, NPS 6 Sch 40, E 200 GPa, L 6 m, Δ 50 mm | `guided_cantilever` | S 140.25 MPa, F 6509.0 N, minimum leg for SA 206.85 = 4.9405 m | VC-PST-06 |
| AC-06 | the PSI 3D fixture (NPS 10, two anchors, 900 °F) built by `add_pipe_run` + anchors | `analyze_pipe_stress` case OPE thermal only | node 30: dy 19.25 mm, dz 48.03 mm, rx 0.1521° (± 1 %) | VC-PST-07 |
| AC-07 | same fixture | weight only | node 30: dy 8.37 mm, dz −33.15 mm (± 3 %) | VC-PST-08 |
| AC-08 | 250 psi in NPS 10 Sch 40 | sustained case | hoop 3681.5 psi, longitudinal (exact area form) 1655.45 psi | VC-PST-09 |
| AC-09 | 10 ft NPS 10 run, anchor + axial stop, 500 °F | OPE | stop force = E A α ΔT = 1.0029e6 lbf (± 0.1 %) | VC-PST-10 |
| AC-10 | one-way +vertical rest under an upward load | OPE | rest reaction 0, `liftOff: true`, `PST_SUPPORT_LIFTOFF` warning | VC-PST-11 |
| AC-11 | L-bend 6 m × 3 m between two anchors, NPS 6, ε = 0.00225 | EXP | anchor C reaction (−7873.0, −2407.0) N, max S_E 106.79 MPa (no SIF) | VC-PST-12 |
| AC-12 | SUS 80 MPa + OCC 60 MPa at a node, Sh 137.9 MPa | `check_pipe_stress` | ratio 140 / 183.4 = 0.763, rule `B313-OCC` named grade B | VC-PST-13 |
| AC-13 | spring: hot load 10 kN, rate 100 N/mm, 20 mm up travel | `select_spring_hangers` / query | cold load 12 kN, variability 20 % (pass ≤ 25 %) | VC-PST-14 |
| AC-14 | NEMA SM 23 nozzle NPS 10, F 600 lbf, M 2000 ft-lbf | `check_nozzle_loads` | De 8.667 in, 3F + M = 3800 ≤ 4333.3, ratio 0.877, rule grade B | VC-PST-15 |
| AC-15 | any analysis | `check_pipe_stress` on a model with a defaulted cycle count, an imported but unsigned material and an edited pipe | codes `PST_CYCLES_DEFAULTED`, `PST_MATERIAL_UNVERIFIED`, `PST_RESULTS_STALE`; `reviewRequired: true`; `approve_pipe_stress` from an agent → `PST_HUMAN_GATE` | VC-PST-18 |

## 8. Standards and regulatory alignment

| Standard | Use in this gap | Status in llull |
| -------- | --------------- | --------------- |
| ASME B31.3 Process Piping (2018, 2020, 2022, 2024 editions) [R1] | primary code: §302.3.5 (sustained, displacement stress range, f), §302.3.6 (occasional), §319 (flexibility), App. C (thermal expansion), App. D (≤ 2018) | rules as data with grade; allowables imported |
| ASME B31J Stress Intensification Factors (2017, reaffirmed; 2023 listed) [R2] | SIF / k for B31.3 ≥ 2020 and B31.1 ≥ 2020 | user-imported table, `unverified` until signed |
| ASME B31.1 Power Piping [R3] | V1 alternative rule set (single SIF, 0.75 i, k = 1.15 / 1.2) | rules as data, grade B |
| EN 13480-3 [R4] | V2 rule set | not specified here |
| MSS SP-58 (pipe hangers), MSS SP-69 (selection) [R5] | spring variability, span table (already used) | 25 % / 15 % named defaults |
| API 610 12th ed. (2021) Table 5 / Annex F [R6]; API 617; NEMA SM 23 [R7] | rotating equipment nozzle loads | formulas built in; tables imported |
| WRC 107 / 297 / 537 [R8] | V2 local shell stresses at vessel nozzles | not in MVP / V1 |
| NUREG/CR-1677 [R13] | V2 dynamic benchmark | grade C (document not reached) |

No clause text is reproduced. Equations are the forms quoted publicly by the cited secondary sources, graded in
`validation/sources.md`.

## 9. KPIs

| KPI | Target |
| --- | ------ |
| Agreement with the reference solver on the benchmark set (VC-PST-07, 08, 10, 12) | ≤ 1 % on displacements and reactions |
| Closed-form VCs (01, 03–06, 09) | 1e-4 relative |
| Time for an agent to go from a routed line to a checked stress result (plan of ≤ 8 steps) | < 30 s wall on a 300-node line, no human input |
| Share of stress-critical lines of the production-gate refinery unit that get a first-pass result | 100 % (V1) |
| Defaulted or unverified inputs hidden from the reviewer | 0 (every one listed by `check_pipe_stress` and in the report) |
| CAESAR II import of an exported `.cii` without manual repair (V1, reviewer-run) | ≥ 95 % of elements, TBD — measure with CAESAR II |

## 10. Risks and assumptions

| Risk | Effect | Mitigation |
| ---- | ------ | ---------- |
| Code text and tables are paywalled (B31.3 Table A-1, B31J, API 610 Table 5) | built-in values would be unsourced | rules as public forms with grades; tables imported by a licensed user and signed (AF-32) |
| Edition differences (Appendix D removed in 2020, f changed in 2022) | wrong allowable or SIF | `edition` is a required named input; defaulting it raises `PST_EDITION_DEFAULTED` |
| A non-engineer owner treats a pass as approval | unsafe release | `reviewRequired`, plain summary, human gate, report approval block (AF-33/34) |
| Non-linear supports fail to converge or converge to a wrong state | wrong loads | iteration cap, `PST_NONLINEAR_NOT_CONVERGED`, status per support in data |
| The routing model lacks components (valves, flanges, tees) until 01 PSC / 02 RTE land | SIFs and weights missing | MVP supports runs + bends; missing components listed as warnings; V1 after 02 RTE |
| Elbow modelled as straight segments | under-predicts flexibility | curved element with k (TECHNICAL §5.3); VC on k |
| Users compare with CAESAR II and find differences from modelling conventions (elbow nodes, friction, Bourdon) | loss of trust | conventions documented and exported; `.cii` hand-off |
| Results over-read: B31.3 checks do not cover creep, FFS, buckling of thin-wall pipes | false safety | out-of-scope list in the report; `PST_CREEP_RANGE` warning when T is above the creep onset given by the material table |

Assumptions: steel / alloy pipe, linear elastic material, small displacements; temperatures below the creep range;
the model's supports are where `add_pipe_support` put them.

## 11. References

- [R1] ASME B31.3 Process Piping — ASME catalogue — https://www.asme.org/codes-standards/find-codes-standards/b31-3-process-piping (accessed 2026-10)
- [R2] ASME B31J Stress Intensification Factors (i-Factors), Flexibility Factors (k-Factors) and Their Determination for Metallic Piping Components — ASME catalogue — https://www.asme.org/Products/Codes-Standards/B31J-2017-Stress-Intensification-Factors-iFactors (accessed 2026-10)
- [R3] ASME B31.1 Power Piping — ASME catalogue — https://www.asme.org/codes-standards/find-codes-standards/b31-1-power-piping (accessed 2026-10)
- [R4] EN 13480-3 Metallic industrial piping — Part 3: Design and calculation — CEN catalogue (accessed 2026-10)
- [R5] MSS SP-58 Pipe Hangers and Supports — MSS catalogue — https://msshq.org (accessed 2026-10)
- [R6] API Std 610 Centrifugal Pumps for Petroleum, Petrochemical and Natural Gas Industries, 12th ed. — API catalogue — https://www.api.org (accessed 2026-10)
- [R7] NEMA SM 23 Steam Turbines for Mechanical Drive Service — NEMA catalogue (accessed 2026-10)
- [R8] WRC Bulletin 537 / 107 / 297 — Welding Research Council — https://store.accuristech.com/wrc (accessed 2026-10)
- [R9] Eng-Tips thread on Plant 3D ↔ CAESAR II through PCF — https://eng-tips.com/posts/9053776 (search extract, accessed 2026-10)
- [R10] AVEVA E3D Pipe Stress Interface User Guide — https://help.aveva.com/AVEVA_Everything3D/2.1/PSIUG/PSIUG10.09.1.html (search extract, accessed 2026-10)
- [R11] Hexagon Smart 3D Piping — stress analysis workflow with CAESAR II — https://docs.hexagonppm.com/r/en-US/Intergraph-Smart-3D-Piping/13/443779 (search extract, accessed 2026-10)
- [R12] Hexagon CAESAR II User's Guide — Neutral file interface; Import PCF — https://docs.hexagonppm.com/r/en-US/CAESAR-II-Users-Guide/Version-12/337038 (search extract, accessed 2026-10)
- [R13] Bezler P., Hartzman M., Reich M., Piping Benchmark Problems, NUREG/CR-1677 Vol. 1, BNL, 1980 — https://digital.library.unt.edu/ark:/67531/metadc1211143/ (located, not read)
- Validation sources S1–S25: [`validation/sources.md`](validation/sources.md)
