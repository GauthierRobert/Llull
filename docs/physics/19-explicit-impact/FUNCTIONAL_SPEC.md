# PHY-19: High strain rate, impact and explicit dynamics (external solver hand-off) — functional specification

Gap id **EXP** · status: specification · written 2026-10-15 · validation pack: [`validation/README.md`](validation/README.md)
· sources register: [`validation/sources.md`](validation/sources.md) · technical spec: [`TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md)

## 1. Summary

The aerospace FEA pack (05) is implicit and linear; it explicitly leaves explicit dynamics out of scope. After PHY-02 and
PHY-05, llull can describe a Johnson–Cook law and run nonlinear statics, but it still cannot model a **fast, short
event**: a bird hitting a leading edge or a radome, a fan blade released inside a case, a box dropped onto a floor, a
fragment or a rod hitting a plate. These events need an **explicit** time integration (time step limited by the wave
speed through the smallest element), rate- and temperature-dependent plasticity, element failure and erosion, contact,
and energy-balance checks — a separate solver class.

In the MVP llull does not write an explicit solver. It will **prepare, hand off, run where installed, and read back**
(long term, see the note after this list):

1. **Set-up as document data.** An `explicit_dynamics` analysis case on the 05 model: end time, output, mass-scaling
   policy, initial velocities, gravity, rigid walls, contacts, time-history requests, J–C strength and failure from PHY-02.
2. **Hand-off to an open explicit solver.** The default target is **OpenCourant**, the community continuation of
   OpenRadioss under AGPL-3.0 after Siemens removed the OpenRadioss repository on 2026-10-01 [R1][R3]. llull writes the
   native Starter / Engine decks (`<Run>_0000.rad`, `<Run>_0001.rad`), runs a user-installed OpenCourant as an external
   process when present, and otherwise exports the deck for another machine. LS-DYNA keyword export is a COULD [R8].
3. **Results as data.** Time histories (displacement, velocity, rigid-wall and contact impulse / force, energies),
   maximum plastic strain with location, failed (eroded) elements, termination status, energy error, hourglass and
   contact energy ratios, added mass — numbers first, with quick analytic checks beside them.

Long term (V1 / V2), decision [RS1](../../decisions/RS1-native-compute.md) step RS-8 plans a llull-owned explicit solver
(`llull-compute explicit`, TECHNICAL_SPEC §2.2) bundled with the desktop app, so the same cases run offline without the
AGPL tool. The hand-off stays as the MVP path and as the cross-check.

Bird strike and blade-out are certification items [R11][R12]. llull's output is engineering preparation and screening:
every scenario result is `reviewRequired`, is marked `certificationEvidence: false`, and any acceptance is a human act.

## 2. Aerospace context & value

| Context | Today (who / which tools) | What llull adds | Source |
| ------- | ------------------------- | --------------- | ------ |
| Bird strike, airframe | Part 25 requires continued safe flight after a 4-lb bird at VC (sea level) or 0.85 VC (8000 ft) (25.571(e)(1)) and an 8-lb bird on the empennage at VC (25.631); applicants show compliance by test and analysis, the FAA has a certification-by-analysis presentation | Bird mass from the cited rule, speed always supplied by the owner, a substitute-bird model template, momentum and energy checks, deck for the stress office's explicit solver | [R11] |
| Engine bird ingestion, blade-out | CS-E 800 (bird strike and ingestion) and CS-E 810 (compressor and turbine blade failure) with AMC | Scope only: model preparation and results review for parts; the engine applicant certifies | [R12] |
| Open explicit solver | OpenRadioss (AGPL) was released by Altair; Siemens removed the repository on 2026-10-01; OpenCourant continues it under AGPL with Linux / Windows packages and containers | A supported hand-off target that the user installs; no solver code inside llull | [R1], [R3], [R5] |
| Commercial explicit solvers | LS-DYNA, Abaqus/Explicit, Radioss (Simcenter) | LS-DYNA keyword export (COULD) checked with the open PyDyna parser | [R8] |
| Dynamic material data | Johnson–Cook strength and failure, same parameters in Radioss and LS-DYNA; FAA-funded LLNL reports for Ti-6Al-4V and 2024-T3 | J–C from PHY-02 with provenance; FAA constants only as user-supplied, sourced, `unverified`-until-checked records | [R6]–[R9] |
| Run health | Analysts check energy ratio ≈ 1, hourglass and sliding energy (rule of thumb < 10 % of internal), added mass | Automatic energy-balance and mass-scaling checks with named thresholds | [R13], [R1] |

**Value statements** (sourced only): the open solver exists and reads both native and LS-DYNA keyword decks [R1]; the
Engine listing already reports energy error, energies and added mass per cycle, so llull can check run health without
proprietary post-processors [R1]; time-history output is impulse-based, which makes momentum checks direct [R2].

## 3. Personas & user stories

Roles per [`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md). Impact work touches certification, so the
qualified reviewer is always in the loop for scenario results.

| Role | Who | Uses | Main need |
| ---- | --- | ---- | --------- |
| **Operator (primary)** | AI agent via the `llull` CLI (MCP for cloud agents) | `llull run plan.json`, `llull explicit_quick_check`, `llull export_explicit_deck --save`, `llull explicit_run`, `llull explicit_import_results`, `llull explicit_report --json`, `llull check_explicit` | Deterministic decks, stable codes, results as JSON, health checks it can prove |
| **Owner** | Designer, test engineer, student; **not assumed to be an engineer** | Natural language; may watch the desktop app | "Does the panel survive the bird / the drop?" answered with what was run, what passed, what needs an engineer |
| **Qualified reviewer** | Impact / crash analyst, design-organisation signatory | Desktop review surfaces, exported decks, the reviewer's own solver | Validates the bird model, the material law, mesh and energy health; dispositions results; signs |

User stories:

- **US-1 (owner → operator).** "Check this avionics box survives a 1.2 m drop onto concrete." The agent builds the plan
  (box, materials, rigid floor, gravity, 1.2 m height), runs `explicit_quick_check scenario=drop_test` (impact speed
  4.85 m/s), exports and runs the deck, reads the report (peak acceleration at the probe, max plastic strain, failed
  elements, energy error), runs `check_explicit`, and says "computed by llull, not approved — needs a qualified engineer".
- **US-2 (operator).** For a leading-edge bird-strike screening, the agent asks the owner for VC and the altitude case
  (llull never defaults a certification speed), uses the 4-lb mass of 25.571(e)(1), builds the substitute bird, runs, and
  checks plate impulse ≈ m·v and the energy balance. `EXP_HOURGLASS_HIGH` sends it back to remesh.
- **US-3 (operator → reviewer).** No OpenCourant on the machine (or macOS): `explicit_run` returns `EXP_TOOL_MISSING`; the
  agent exports `<Run>_0000.rad` / `_0001.rad` with `--save`, the reviewer runs them on a Linux cluster and the agent
  imports the results with `explicit_import_results`, which checks the deck hash.
- **US-4 (operator).** The agent wants Ti-6Al-4V J–C constants. llull has none built in; the agent records the FAA-report
  constants as a PHY-02 law with the citation, basis and valid ranges; every result is `unverified` until a human
  confirms the values against the report.
- **US-5 (reviewer).** The reviewer opens the run in the desktop app: energy plot, plastic-strain contour, eroded elements
  highlighted, all over the same data; she dispositions the result (accept with justification, reject, redesign).

## 4. Scope / out of scope

| Phase | In scope |
| ----- | -------- |
| **MVP (M1–M4)** | `explicit_dynamics` analysis type; controls (end time, animation / history intervals, precision, time-step floor, mass-scaling policy with limit); initial velocity, gravity, rigid walls (planar), imposed velocity; solid hex-dominant / tet meshes from 05 (Gmsh) and shells from 05 midsurfaces; elastic and J–C strength (PHY-02) with J–C failure and erosion; OpenCourant native deck export (`.rad`); run of a user-installed OpenCourant (external process, progress, timeout, cancel); import of the Engine listing, time histories (`th_to_csv`) and animation fields (`anim_to_vtk`); `explicit_report`, `explicit_energy_check`, `check_explicit`; quick checks (wave speeds, CFL, mass scaling, bar impact, Taylor estimate, J–C flow and failure, drop and bird kinematics). |
| **V1 (M5–M6)** | Contacts (self, surface-to-surface, with friction); SPH (and ALE) substitute bird with an EOS model (PHY-02 addition); scenario templates bird strike and drop test; container run (`ghcr.io/opencourant/opencourant`); rigid bodies; shells with J–C. llull-owned solver, first increment (RS1 RS-8a/b): solids, J–C with erosion, rigid walls, GPU with CPU twin. |
| **V2** | llull-owned solver contact and shells (RS1 RS-8c). LS-DYNA keyword export (COULD) and LS-DYNA results (d3plot via external converters); blade-out templates (rotating part, release, containment ring) for parts; composite failure for impact (with 06 CMP / PHY-08); restart files. |
| **Out of scope** | Bundling a third-party explicit solver (AGPL); a llull-owned solver before V1 (planned by RS1 RS-8 for V1 / V2); shipping proprietary material data; certification credit; hydrocodes for hypervelocity impact; crash-dummy / occupant models. |

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-EXP-01 | MUST | A 05 analysis case can have type **`explicit_dynamics`** with solver `opencourant` (MVP) or `ls_dyna` (export only, COULD). It uses the 05 parts, idealizations, mesh controls, probes and targets; all set-up is commands that replay and save. | L1/L4/L8 | L1 |
| FR-EXP-02 | MUST | **Explicit controls**: end time, animation interval, time-history interval, precision (double / extended single), minimum time step, mass-scaling policy (`none` / `selective` with target time step and a **required** maximum added-mass ratio), all with units. | The time step and mass scaling decide cost and validity | [R1] |
| FR-EXP-03 | MUST | **Initial and boundary conditions**: initial velocity per part, gravity, planar rigid walls (point, normal, friction), imposed velocity on targets, fixed constraints (05). Contacts (self, surface-to-surface) in V1. | Impact set-ups | [R1] |
| FR-EXP-04 | MUST | **Deck export** of OpenCourant native input: Starter `<Run>_0000.rad` (model) and Engine `<Run>_0001.rad` (run control, outputs), deterministic (same input, same bytes), units declared in `/BEGIN` from the analysis unit system. Refused if any part lacks elastic constants or a law. | The hand-off itself | [R1], [R4] |
| FR-EXP-05 | MUST | **Johnson–Cook strength** from the PHY-02 law (A, B, n, C, ε̇0, m, Tm, Tr, valid strain-rate and temperature range) written to `/MAT/PLAS_JOHNS`. | Rate- and temperature-dependent plasticity | [R6], [R7] |
| FR-EXP-06 | MUST | **Johnson–Cook failure** (D1–D5, ε̇0) written to `/FAIL/JOHNSON` with element deletion when D ≥ 1; failed element ids come back in results. | Erosion, penetration | [R6], [R7] |
| FR-EXP-07 | MUST | **Run** a user-installed OpenCourant (Starter then Engine) as an external process on the desktop: thread count, progress from the listing, timeout, cancel, exit status and log tail. Never on the cloud host unless configured. | Offline desktop loop | [R1] |
| FR-EXP-08 | MUST | **Import results**: Engine listing (cycles, time, time step, energy error, internal and kinetic energy, external work, mass error, added mass, termination), time histories through `th_to_csv`, animation fields through `anim_to_vtk`. Results are tied to the deck hash; others are review-only. | Results as data | [R1], [R2] |
| FR-EXP-09 | MUST | **Energy-balance and run-health check**: energy error, hourglass / internal, contact / internal, added-mass ratio, normal termination, momentum (rigid-wall impulse vs m·v where the scenario defines it); pass / warn / fail with codes and named thresholds. | Run health decides whether results mean anything | [R13], [R1] |
| FR-EXP-10 | MUST | **Results as data** (AF-21): per probe and rigid wall, bounded time histories with units; max von Mises and max equivalent plastic strain with location; failed-element list and count per part; final displacements; peak acceleration at probes (filtered by a named filter when requested). | Numbers first | AF-10, AF-21 |
| FR-EXP-11 | MUST | **Quick checks** (read-only): bar and dilatational wave speeds, CFL critical time step for a given element length, bar impact stress ρc₀v and duration 2L/c₀, largest elastic impact speed. | Sanity before and after a run | generator |
| FR-EXP-12 | MUST | **Mass-scaling report**: the added mass needed for a target time step before the run, and the actual added mass after it; above the user limit → fail. | Mass scaling changes inertia | [R1], [R13] |
| FR-EXP-13 | SHOULD (V1) | **Substitute bird** as SPH (or ALE) with an EOS material from PHY-02 (requested addition); geometry from mass and test density. | Bird strike | [R14] |
| FR-EXP-14 | COULD | **LS-DYNA keyword export** (`*MAT_JOHNSON_COOK`, `*INITIAL_VELOCITY`, `*RIGIDWALL_PLANAR`, …), verified by parsing with PyDyna; OpenCourant also reads `.k` natively. | Hand-off to commercial solvers | [R1], [R8] |
| FR-EXP-15 | MUST | **Validation family**: elastic bar on a rigid wall, Taylor rod (dynamic-yield estimate from lengths, reported only), drop test, as plans and quick checks. | Proving the chain | [R10], generator |
| FR-EXP-16 | MUST | **Scenario: bird strike** — mass from the cited rule (4 lb, 25.571(e)(1); 8 lb, 25.631) or explicit, **speed always explicit** with its source (VC is aircraft-specific), kinetic energy and impulse reported. Blade-out (CS-E 810) is a scope note for V2. | Certification-driven inputs must be named | [R11], [R12] |
| FR-EXP-17 | MUST | **Scenario: drop test** — height, orientation, floor (rigid wall), gravity; impact speed √(2gh) reported beside the run. | Equipment robustness | generator |
| FR-EXP-18 | MUST | **Range guard** (AF-30): J–C laws carry valid strain-rate and temperature ranges; quick checks refuse outside; after a run `check_explicit` fails when imported strain rate or temperature left the range (element ids, extreme value). | No silent extrapolation | AF-30 |
| FR-EXP-19 | MUST | **Tool availability**: missing OpenCourant (or no build for the platform, e.g. macOS) → `EXP_TOOL_MISSING` with an install hint; export still works. | AF-41 | [R1] |
| FR-EXP-20 | MUST | Every capability is reachable from the CLI, MCP and the desktop UI through the same registry. | L1/L5 | L1 |
| FR-EXP-21 | MUST | **Tool provenance and licence**: each run records solver name, version / tag, executable sha256 and licence (AGPL-3.0-or-later); llull does not link or modify the solver and shows its licence and source location. | AGPL obligations, reproducibility | [R1] |
| FR-EXP-22 | MUST | **Named defaults** (AF-31): hourglass-ratio limit default `{0.10, source: rule of thumb [R13], defaulted: true}`; **no default** for energy-error limit, added-mass limit, bird speed, drop height or failure acceptance (warnings when unset). | No silent safety value | AF-31 |
| FR-EXP-23 | MUST | **Review flag** (AF-33): every report and scenario result has `reviewRequired: true`, `certificationEvidence: false` and "computed by llull, not approved — needs a qualified engineer". | Certification items | AF-33 |
| FR-EXP-24 | MUST | **Unverified propagation** (AF-32): laws or EOS with basis `typical` / `supplier_unstated` / `unspecified` or grade-B provenance flag every result `unverified`; `check_explicit` warns `EXP_LAW_UNVERIFIED`. | Literature constants are not allowables | AF-32 |
| FR-EXP-25 | MUST | **Human disposition** (AF-34): failed elements, penetration or fail-level health checks in a scenario produce 05 margin rows `pending_human`; only `dispose_margin` with a human signature closes them. | Accepting impact damage is an approval act | AF-34 |
| FR-EXP-26 | MUST | **Stable codes** (AF-11) for every refusal and check item (TECHNICAL_SPEC §7.1). | Agents act on codes | AF-11 |

## 6. Workflows

### 6.1 CLI (operator's primary path)

```bash
llull search impact explicit bird drop
llull describe set_explicit_controls set_initial_velocity add_rigid_wall export_explicit_deck explicit_run explicit_report
llull guide                                      # physics explicit section: units (N-mm-t-s), time step, mass scaling, health checks

# 0. quick checks
llull explicit_quick_check check=critical_time_step 'inputs={"E_Pa":2e11,"nu":0.3,"rho_kg_m3":7850,"L_e_m":0.002}' --json
llull explicit_quick_check scenario=drop_test 'inputs={"h":{"value":1.2,"unit":"m"}}' --json

# 1. one plan: geometry + materials (08 + PHY-02 J-C) + explicit case + ICs/BCs + outputs
llull run box_drop.plan.json --validate --doc box.llull.json
llull run box_drop.plan.json --doc box.llull.json --kernel occt --json

# 2. mesh (05), check, export or run
llull fea_mesh analysisId=$an --doc box.llull.json --timeout 300 --json
llull check_explicit analysisId=$an --doc box.llull.json --json
llull export_explicit_deck analysisId=$an format=opencourant --save out/BOXDROP --doc box.llull.json   # writes _0000.rad, _0001.rad
llull explicit_run analysisId=$an threads=8 --progress --timeout 7200 --doc box.llull.json --json       # if installed

# 3. results (or import a run made elsewhere)
llull explicit_import_results analysisId=$an dir=out/BOXDROP --doc box.llull.json --json
llull explicit_report analysisId=$an --doc box.llull.json --json
llull explicit_energy_check analysisId=$an hourglassLimit=0.1 energyErrorLimit=0.05 addedMassLimit=0.02 --doc box.llull.json --json
llull check_explicit analysisId=$an --doc box.llull.json --json
llull render_view view=iso analysisId=$an field=eps_p time=last --save out/epsp.png --doc box.llull.json
```

The agent reports (AF-36): event and inputs (with the source of speed / height), run health, max plastic strain and
failed elements, the quick-check comparison, every `unverified` input, rows needing a human, "not approved" sentence.

### 6.2 MCP (cloud)

Set-up, export, quick checks, import and reports work everywhere. `explicit_run` exists only on hosts configured with
OpenCourant (AGPL network-use obligations apply to a modified solver offered over a network; llull runs it unmodified,
open question TS §11). Otherwise `EXP_TOOL_MISSING`.

### 6.3 Desktop UI (review and approval only)

Explicit case panel (read-only view), energy and time-history charts, plastic-strain and failed-element overlays over
`explicit_report` data, tool provenance card (name, version, licence, source link), 05 disposition dialog.

### 6.4 Surface matrix

| Capability | CLI | MCP | UI |
| ---------- | --- | --- | -- |
| Set-up | `llull run`, set-up commands | registry tools | case panel |
| Quick checks | `llull explicit_quick_check` | same | — |
| Export | `llull export_explicit_deck --save` | exchange dir | Export menu |
| Run | `llull explicit_run` (desktop) | where configured | progress |
| Import / report / checks | `llull explicit_import_results`, `explicit_report`, `explicit_energy_check`, `check_explicit` | same | charts, overlays |
| Disposition | prepare only | prepare only | **complete** (signature) |

### 6.5 Error and edge behaviour

| Situation | Behaviour | FR |
| --------- | --------- | -- |
| No initial velocity, imposed motion, gravity or load | `check_explicit` fail `EXP_NO_EXCITATION` | FR-EXP-03 |
| Critical time step tiny because of one sliver element | warning `EXP_SMALL_TIME_STEP` naming the element, with the quick-check dt | FR-EXP-11 |
| Mass scaling above the user limit | fail `EXP_ADDED_MASS_HIGH`; results kept, flagged | FR-EXP-12 |
| Engine stops without `NORMAL TERMINATION` | `EXP_ABNORMAL_TERMINATION`, log tail, results review-only | FR-EXP-08 |
| Results imported from a deck with another hash | `EXP_RESULTS_FOREIGN`, review-only | FR-EXP-08, 21 |
| Bird-strike scenario without a speed | refused `EXP_SCENARIO_INPUT_MISSING` (names `speed`) | FR-EXP-16 |
| macOS desktop | `EXP_TOOL_MISSING` (no listed macOS build; container hint) | FR-EXP-19 |

## 7. Acceptance criteria

`D` = `--doc case.llull.json --kernel occt --json`. Values: `validation/expected_results.json`.

| # | Given | When (CLI) | Then (JSON) | VC |
| - | ----- | ---------- | ----------- | -- |
| AC-1 | steel-like test material | `explicit_quick_check check=wave_speed` | c0 5047.54 m/s, cd 5856.36 m/s (1e-9) | VC-EXP-10 |
| AC-2 | L_e = 2 mm, target 1e-6 s | `check=critical_time_step`, `check=mass_scaling` | dt 3.41509e-7 s; added-mass ratio 7.574 | VC-EXP-11 |
| AC-3 | `plans/exp_bar_rigid_wall.plan.json` | run → export → `explicit_run` → `explicit_report` | wall force plateau 39 623 N ± 3 %, duration 79.2 µs ± 3 % | VC-EXP-50 |
| AC-4 | `plans/exp_drop_box.plan.json` | same | first contact 0.4947 s ± 0.5 %; v_z −4851 mm/s ± 0.5 % | VC-EXP-51 |
| AC-5 | `energy_balance_sample.csv` | `explicit_energy_check` | error −0.002, hourglass 0.05, contact 0.03, status pass; limit named `defaulted: true` | VC-EXP-40, 60 |
| AC-6 | `engine_listing_sample.txt` | listing parser (import) | error −0.2 %, normal termination | VC-EXP-42 |
| AC-7 | Ti J–C law + test D1–D5 | `export_explicit_deck format=opencourant` → Starter | Starter exits normally; values echoed | VC-EXP-54 |
| AC-8 | same plan exported twice | — | identical sha256 | VC-EXP-56 |
| AC-9 | no OpenCourant | `explicit_run` | exit 1, `EXP_TOOL_MISSING`, export still works | VC-EXP-57 |
| AC-10 | any report | — | `reviewRequired: true`, `certificationEvidence: false`, "not approved" | VC-EXP-61 |
| AC-11 | grade-B J–C law | report, `check_explicit` | `unverified: true`; warning `EXP_LAW_UNVERIFIED` | VC-EXP-62 |
| AC-12 | failed elements in a bird scenario | agent `dispose_margin` | `FEA_HUMAN_GATE`, document unchanged | VC-EXP-63 |

## 8. Standards & regulatory alignment

| Reference | Use | Status |
| --------- | --- | ------ |
| 14 CFR 25.571(e)(1), 25.631 [R11] | Bird masses (4 lb / 8 lb) and the speed definitions the owner must supply | Search renderings of eCFR and FAA documents; eCFR page not opened |
| EASA CS-E 800 / CS-E 810 [R12] | Scope of engine bird ingestion and blade failure | Titles verified; text not seen |
| OpenCourant / Radioss input format [R1], [R4] | Deck writer, listing parser | Verified in the repository (cfg files, QA decks read for format only) |
| LS-DYNA keyword [R8] | COULD export | Layout via PyDyna; LS-DYNA not run |
| Johnson & Cook 1983 / 1985 [R6] | Law form (owned by PHY-02) | Citations; form via two solvers' parameter sets |

llull claims no certification credit; scenario results are screening data for a qualified reviewer.

## 9. KPIs / success metrics

| KPI | Target | How measured |
| --- | ------ | ------------ |
| Quick-check correctness | 100 % of VC-EXP-10…42 | unit tests from `expected_results.json` |
| Hand-off correctness | Starter accepts 100 % of decks from the plans; VC-EXP-50/51 within tolerance | integration suite with OpenCourant |
| Deck determinism | identical sha256 on re-export | VC-EXP-56 |
| Health-check coverage | 100 % of imported runs have energy, hourglass, added-mass and termination status | VC-EXP-55 |
| Silent defaults | 0 certification speeds, heights or acceptance limits defaulted | VC-EXP-60 |
| Unflagged results | 0 scenario results without `reviewRequired` | VC-EXP-61 |

## 10. Risks & assumptions

| Risk / assumption | Impact | Mitigation |
| ----------------- | ------ | ---------- |
| Upstream OpenRadioss was removed (2026-10-01); OpenCourant is weeks old [R1][R3] | Solver continuity | Target the deck format (shared with Radioss), pin tool versions and hashes, keep LS-DYNA export as an alternative |
| AGPL-3.0 solver plus a closed `hm_reader` binary dependency of unclear redistribution status [R1] | Licence exposure if bundled | Do not bundle in MVP: user-installed or container; record provenance; legal decision before any bundling (TS §11) |
| No macOS build listed [R1] | Desktop gap | Container runtime path; export for remote run |
| Literature J–C constants vary widely and the primary FAA tables were not reached [R9] | Wrong material response | No built-in constants; `unverified` until a human confirms against the report; range guards |
| Explicit results are mesh-, contact- and hourglass-sensitive | Over-trust by a non-engineer owner | Health checks, `reviewRequired`, `certificationEvidence: false`, human dispositions |
| Substitute-bird models need an EOS model PHY-02 does not list | Bird scenario delayed to V1 | Request the addition (TS §11) |
| Own solver (RS1 RS-8): element library (hourglass, tet locking, shells) | Wrong stiffness or energy | Published formulations only (TS §11 Q10), patch and single-element tests, OpenCourant cross-check |
| Own solver: contact robustness and speed | Penetration, unstable runs | Contact only in V2; health checks and energy balance on every run |
| Own solver: V&V cost | Effort 16+ w and scarce open benchmarks | Solids and rigid walls first; every case also runs through the hand-off where installed; `reviewRequired`, `certificationEvidence: false` |

## 11. References

- [R1] OpenCourant (README, LICENSE, COPYRIGHT, INSTALL, RELEASES, EXTLIB_VERSION, hm_cfg_files) — https://github.com/OpenCourant/OpenCourant/tree/b19ec63f372474aa52dbbff41bd2e5288cf5b04e (accessed 2026-10)
- [R2] OpenCourant Tools (`th_to_csv`, `anim_to_vtk`) — https://github.com/OpenCourant/Tools/tree/c58c805696f7364f0efe80b5dd1585f70670232e (accessed 2026-10)
- [R3] Phoronix, "OpenCourant: Rocky Linux Developers Create Community Fork Of OpenRadioss" (2026-10-04) — https://phoronix.com/news/OpenRadioss-OpenCourant (accessed 2026-10, search)
- [R4] Altair Radioss help, Starter input — https://help.altair.com/hwsolvers/rad/topics/solvers/rad/starter_input_r.htm (accessed 2026-10, search)
- [R5] Wikipedia, Radioss — https://en.wikipedia.org/wiki/Radioss (accessed 2026-10, search)
- [R6] Johnson & Cook (1985), Eng. Fract. Mech. 21: 31–48 — https://doi.org/10.1016/0013-7944(85)90052-9 (citation; 1983 Ballistics symposium paper cited alongside)
- [R7] Radioss `/MAT/PLAS_JOHNS`, `/FAIL/JOHNSON` cfg — in [R1] (accessed 2026-10)
- [R8] PyDyna `ansys-dyna-core` 0.12.1 — https://pypi.org/project/ansys-dyna-core/0.12.1/ (accessed 2026-10)
- [R9] Lesuer, DOT/FAA/AR-00/25; Kay, DOT/FAA/AR-03/57 — https://www.osti.gov/biblio/11977-experimental-investigations-material-models-ti-t3 ; https://www.osti.gov/biblio/15006359 (accessed 2026-10, search; PDFs not reached)
- [R10] G. I. Taylor (1948), Proc. R. Soc. A 194: 289–299 — https://doi.org/10.1098/rspa.1948.0081 (citation)
- [R11] 14 CFR §25.631 and §25.571(e)(1) — https://www.ecfr.gov/current/title-14/chapter-I/subchapter-C/part-25/subpart-D/subject-group-ECFRff93ea3edba9270/section-25.631 ; https://www.govinfo.gov/content/pkg/FR-2015-07-20/pdf/2015-17404.pdf (accessed 2026-10, search)
- [R12] EASA CS-E (CS-E 800, CS-E 810) — https://www.easa.europa.eu/en/document-library/certification-specifications (accessed 2026-10, search, titles only)
- [R13] LS-DYNA energy-balance FAQ; Ansys forum; DYNAmore 2021 — https://ftp.lstc.com/anonymous/outgoing/jday/faq/energy_balance ; https://www.dynalook.com/conferences/13th-european-ls-dyna-conference-2021/impact-blast/iliev_mott_macdonald.pdf (accessed 2026-10, search)
- [R14] Wilbeck, AFML-TR-77-134 / AFFDL-TR-77-60 — https://apps.dtic.mil/sti/pdfs/ADA061313.pdf (accessed 2026-10, search)
- L1 llull laws and packs — `.claude/rules/architecture.md`, `docs/aerospace/05-fea-cae-handoff/`, `docs/physics/README.md`
