# PHY-09: Structural dynamics beyond modal — functional specification

Gap id **DYN** · status: specification · written 2026-10-15 · technical spec: [`TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md)
· validation: [`validation/README.md`](validation/README.md) · sources: [`validation/sources.md`](validation/sources.md)

## 1. Summary

Once the aerospace packs are built, llull can compute natural frequencies and mode shapes (aerospace 05 FEA,
`AnalysisType = 'modal'`, bundled CalculiX `*FREQUENCY`). It cannot say what a structure **does** under a dynamic
load: no frequency response to a harmonic force or base shake, no random-vibration response to a test or launch
spectrum (PSD), no shock response, no time-domain transient. There is no damping model, no way to hold a test
spectrum as data, no RMS or 3-sigma result, and no quick hand check (Miles' equation, SDOF transmissibility, shock
response spectrum) for an agent to sanity-check a big model against.

Equipment that flies is qualified by vibration and shock tests: a component on a launch vehicle is shaken to a
random spectrum such as the GEVS component profile (20–2000 Hz, 14.1 g rms at qualification [R3][R4]), and NASA
programmes specify vibroacoustic test levels and factors in NASA-STD-7001 [R9]. Designers size brackets and boxes
before the test with a random-vibration analysis, usually a Miles' equation quick check followed by a modal
frequency-response analysis [R6]. A design tool that stops at mode shapes leaves the owner with "the first mode
is 180 Hz" and no answer to "will it survive the shake test?".

This gap closes that in four steps, all as llull commands on top of 05 FEA:

1. **Dynamic analysis cases** in the 05 `AnalysisModel`: `frequency_response`, `random_response`,
   `transient_dynamic`, with damping, frequency sweep, base excitation, load histories and vibration spectra as
   document data.
2. **Solve with the bundled CalculiX** using modal superposition (`*FREQUENCY,STORAGE=YES` then `*STEADY STATE
   DYNAMICS` or `*MODAL DYNAMIC`) or direct integration (`*DYNAMIC`) [R1]. Random response and shock response
   spectra are computed by llull itself from the modal results, because CalculiX has no PSD or response-spectrum
   procedure (verified in the manual, TECHNICAL_SPEC §1).
3. **Results as numbers**: FRF peaks with frequency and amplification, RMS and 3-sigma responses, response PSD
   per probe, SRS tables, peak transient values with time, and an equivalent static load case that 05's margin
   table can use.
4. **Quick checks without FE** (`sdof_response`, `psd_rms`, `shock_response_spectrum`) and a read-only
   `check_dynamics`, so the agent can prove its numbers before a qualified engineer looks at them.

## 2. Aerospace context & value

| Context | Today (who / which tools) | What llull adds | Source |
| ------- | ------------------------- | --------------- | ------ |
| Component random-vibration qualification | Test engineers shake boxes to a GEVS / NASA-STD-7001 profile; analysts predict response with Nastran SOL 111 / random or with Miles' equation | Store the profile as data, compute overall g rms, run modal random response, report 3-sigma loads | [R3][R4][R6][R9] |
| Miles' quick estimate | Common first estimate of an equivalent load factor; known to over-estimate in many cases | `sdof_response` returns Miles and the exact band-limited integral side by side, and says which one is the answer of record | [R5][R6] |
| Frequency response, base shake | CalculiX, Abaqus, Nastran modal frequency response with modal or Rayleigh damping | CalculiX `*STEADY STATE DYNAMICS` + `*BASE MOTION` + `*MODAL DAMPING` driven by commands | [R1][R2] |
| Pyroshock / handling shock | Shock response spectrum (SRS) of a measured or specified pulse, Smallwood recursive filter (ISO 18431-4 lineage) | `shock_response_spectrum` on any time history or a half-sine; SRS of a computed transient probe | [R7][R8] |
| Transient (drop, impulse, actuator slam, joint load from PHY-10) | Modal or direct transient in an FE code | `transient_dynamic` with `*MODAL DYNAMIC` or `*DYNAMIC` (HHT α) and load histories, including PHY-10 joint reaction histories | [R1][R15] |
| Fatigue under random vibration | Random-fatigue methods (Miner on narrow-band, Dirlik) | Stress PSD per location exported to PHY-07; the damage calculation stays in PHY-07 | [R16] (not verified) |

**Value statements** (sourced only): CalculiX already ships modal frequency response, modal transient and direct
transient with Rayleigh, modal and structural damping, and regression decks for each (beamdy1…20) [R1][R2], so the
solver side needs no new tool on the desktop. Miles' approach is the usual first step and tends to over-estimate
[R6], which is why llull returns the exact integral next to it.

## 3. Personas & user stories

Roles follow [`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md) §1. Random-vibration and shock
results feed qualification and test decisions, so every response that can size a part or set a test level carries
`reviewRequired` (AF-33), and damping, peak factors and spectra are never defaulted silently (AF-31).

| Role | Who | Uses | Main need |
| ---- | --- | ---- | --------- |
| **Operator (primary)** | AI agent through the `llull` CLI (MCP for cloud agents) | `llull run`, `fea_mesh`, `fea_solve`, `dynamic_report`, `sdof_response`, `check_dynamics --json` | Commands with units in every param, deterministic JSON, stable codes |
| **Owner** | Person asking "will this survive the shake test?" (CubeSat team, supplier designer). **Not assumed to be an engineer** | Natural language; may watch the desktop app | A plain answer: peak response, margin, what needs a qualified engineer |
| **Qualified reviewer** | Dynamics / stress engineer, test-programme authority | Desktop review panels, exported decks, response tables | Accepts damping assumptions, spectra and test-level derivations; signs |

User stories:

- **US-1 (owner → operator).** "Our 2 kg avionics box goes on a launcher; check it against the GEVS component
  qualification random level." The agent defines the spectrum from the named library entry (with its source and
  grade), runs modal + random response, reports g rms and 3-sigma at the mounting feet and on the PCB, adds an
  equivalent static load case, runs 05 `compute_margins`, and ends with `check_dynamics`.
- **US-2 (operator).** Before the FE run, the agent calls `sdof_response` with the first frequency and an assumed
  Q to get Miles' g rms and the exact SDOF integral; after the run it compares with the FE result and explains the
  difference (mass participation, off-resonance input).
- **US-3 (operator).** The owner gives no damping. The agent cannot proceed silently: `fea_solve` refuses with
  `DYN_DAMPING_UNSET`; the agent proposes a value, cites where it comes from, and the result carries
  `damping.defaulted: false` with the source text the agent supplied, or the owner's own value.
- **US-4 (operator).** A pyro event is specified as an SRS; the agent computes the SRS of a candidate half-sine
  test pulse and reports where it under- or over-tests.
- **US-5 (operator).** PHY-10 produced a landing-gear joint reaction history; the agent imports it as a load
  history and runs a modal transient of the attachment fitting, reporting peak stress and time.
- **US-6 (reviewer).** The reviewer opens the response table, sees which modes were kept, the mass participation,
  the damping per mode, and the frequency points used, and signs or sends it back.

## 4. Scope / out of scope

| Phase | In scope |
| ----- | -------- |
| **MVP (M1–M4)** | Damping models: modal (per-mode ζ), Rayleigh (α, β or from two target ratios), structural loss factor `structuralLossFactor` from the material record (PHY-01 property model). Vibration spectra as document data (ASD breakpoints, log-log). Load histories (time tables). `frequency_response` (modal, CalculiX SSD) with force or base acceleration. `random_response` (modal, llull post-processing of CalculiX modal results): response ASD, rms, 3-sigma at probes and nodal max. Quick checks `sdof_response`, `psd_rms`, `shock_response_spectrum`, `damping_coefficients`. Equivalent static load case into 05. `check_dynamics`. Results as data, `reviewRequired`, stale tracking (05 rules). |
| **V1 (M5–M6)** | `transient_dynamic` modal (`*MODAL DYNAMIC`) and direct (`*DYNAMIC`, HHT α), base displacement input, PHY-10 joint reaction histories as loads, SRS of a computed probe history, stress ASD export for PHY-07 random fatigue, Nastran BDF SOL 111/112 export (cards to verify against pyNastran as 05 does). |
| **V2** | Multi-input / correlated random excitation (cross-spectra), response spectrum analysis (SRS input, modal combination), enforced motion with large mass, Dirlik counting handed to PHY-07, acoustic-to-structural loads from PHY-20. |
| **Out of scope** | Writing an FE solver; nonlinear dynamics, contact or impact (PHY-06, PHY-19); rotor dynamics with Coriolis (CalculiX `*COMPLEX FREQUENCY` exists [R1], later item); acoustic FE / SEA (PHY-20 is hand-off only); computing test tolerances or approving test levels (human act). |

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-DYN-01 | MUST | A 05 analysis case of type `frequency_response`, `random_response` or `transient_dynamic` holds its modal basis settings (number of modes, or a frequency limit) and refuses to solve until the modal step it depends on is part of the run. | Modal superposition needs the modes first (`*FREQUENCY,STORAGE=YES`) | [R1] |
| FR-DYN-02 | MUST | **Frequency response** to forces, pressures or base acceleration over a frequency band, with the number of points per interval and the bias of point placement, giving magnitude and phase of displacement, velocity, acceleration and stress at probes. | Harmonic and sine-sweep qualification | [R1] |
| FR-DYN-03 | MUST | **Damping** as explicit data: per-mode viscous ratios (ranges of modes), Rayleigh α/β (or derived from two target ratios at two frequencies), or a structural loss factor `structuralLossFactor` read from the material record through the PHY-01 property-model API (catalogue row added by this pack). The applied ζ per kept mode is always reported. No default damping exists. | Response amplitude is inversely proportional to damping; an unstated damping is an unstated result | [R1], AF-31 |
| FR-DYN-04 | MUST | FRF results report each peak: frequency (Hz), amplitude with unit, phase, the dominant mode, and the dynamic amplification relative to the static response where a static response exists. | Numbers, not plots (AF-21) | AF-21 |
| FR-DYN-05 | SHOULD | Peak quality factor from the half-power bandwidth next to the input 1/(2ζ), so the agent can show the model behaves as assumed. | Classic check of damping | derived |
| FR-DYN-06 | MUST | **Base excitation** by acceleration (harmonic) or displacement (transient) on the constrained DOFs, reporting absolute and relative response, and transmissibility at probes. | Shaker tests drive the base; CalculiX restricts acceleration base motion to steady-state dynamics | [R1] |
| FR-DYN-07 | MUST | **Vibration spectra** as document data: ASD breakpoints (g²/Hz or (m/s²)²/Hz vs Hz) with log-log interpolation, name, source, grade, and the overall g rms computed exactly per segment. A small sourced library holds the GEVS component qualification and acceptance profiles, each flagged with its grade (B until the standard is read directly). | Test and launch environments are given as ASDs | [R3][R4] |
| FR-DYN-08 | MUST | **Random response** (single input, stationary Gaussian): response ASD and rms of acceleration, displacement and stress at probes and the nodal maximum, by modal superposition. Miles' equation is available as a labelled quick check only, never as the answer of record of a random-response case. | Qualification by analysis of random vibration | [R5][R6] |
| FR-DYN-09 | MUST | Peak response from rms uses a **named peak factor** (default 3, "3-sigma", stated as defaulted with its rationale: P(\|x\| > 3σ) = 0.27 % for a Gaussian response). | AF-31: a peak factor is a safety-relevant choice | derived, AF-31 |
| FR-DYN-10 | MUST | **Modal truncation control**: report the cumulative effective mass per direction for the kept modes (from the solver's participation table), warn below a user threshold (no default threshold: unset gives a warning), and report the highest kept frequency versus the top of the excitation band. | Missing modes under-predict response | [R1][R2] |
| FR-DYN-11 | MUST | **Shock response spectrum** (query): maximax, positive and negative absolute-acceleration SRS of a time history or a half-sine, at given frequencies or a fractional-octave grid, for a given Q, with the algorithm named (Smallwood ramp-invariant) and the sampling check (≥ 10 samples per period of the highest frequency, else refuse). | Shock specification and test design | [R7][R8] |
| FR-DYN-12 | SHOULD (V1) | **Transient dynamics**: modal (`*MODAL DYNAMIC`) or direct (`*DYNAMIC`, HHT α in [−1/3, 0], default −0.05 named) with load histories; peak values with time at probes, and probe histories with `--save`. | Drop, impulse, joint loads | [R1][R15] |
| FR-DYN-13 | SHOULD (V1) | PHY-10 joint reaction histories become load histories of a transient case through a command, keeping the PHY-10 provenance and `unverified` flags. | Mechanism loads into structures | PHY-10 |
| FR-DYN-14 | MUST | **Equivalent static load case**: from a random (rms × peak factor) or transient (peak) result, create a 05 load case (`limit`) as body acceleration or probe-based load, with provenance (case, spectrum, damping, peak factor) so 05 `compute_margins` can use it. | Quasi-static design loads from random response are standard practice | [R6], 05 |
| FR-DYN-15 | SHOULD (V1) | **Stress ASD export** per location (frequency, ASD, rms, zero-crossing rate) for PHY-07 random fatigue. llull does not compute random-fatigue damage in this pack. | PHY-07 owns fatigue | [R16] |
| FR-DYN-16 | MUST | Validation suite (SDOF analytics, CalculiX beamdy decks, NAFEMS FV32 modal pre-step, GEVS integration, SRS) runs in CI with the PHY-00 harness. | Credibility | PHY-00 |
| FR-DYN-17 | MUST | **Quick checks without FE**: `sdof_response` (harmonic, random, shock for one SDOF), `psd_rms`, `damping_coefficients`, all pure and instant. | The agent sanity-checks before and after FE | AF-20, AF-21 |
| FR-DYN-18 | MUST | **Readiness check** `check_dynamics` with stable codes: damping unset, modal basis missing or truncated, band above kept modes, spectrum invalid, sampling too coarse, results stale, Miles used as answer, unverified inputs, review pending. | AF-20 | AF-20 |
| FR-DYN-19 | MUST | **Units** on every param and result: Hz, s, g or m/s², g²/Hz, mm, MPa per the 05 unit system; g means 9.80665 m/s² and is stated. | AF-04, AF-10 | AF-04 |
| FR-DYN-20 | MUST | **Review and unverified flags**: every random, shock and transient result and every equivalent static load case carries `reviewRequired: true` with a reason; damping or spectra marked `unverified` (grade below A, or user typical values) propagate. | AF-32, AF-33 | AF-32, AF-33 |
| FR-DYN-21 | MUST | **Human gate**: accepting a dynamic result for a qualification decision (for example "analysis replaces a test" or "test level derived from analysis") is a 05 disposition with a human-held signature; the agent gets `DYN_HUMAN_GATE`. | AF-34 | AF-34 |
| FR-DYN-22 | MUST | Every capability is reachable from UI, CLI and MCP through the registry; heavy outputs (probe histories, response ASD tables) only with `--save` or paging. | L1/L5, AF-12 | AF-01, AF-12 |

## 6. Workflows

### 6.1 CLI (`llull`, the operator's primary path)

Commands are those of TECHNICAL_SPEC §4. FEA transports (`fea_mesh`, `fea_solve`) are the 05 ones; they learn the
new analysis types. `D="--doc box.llull.json --kernel occt --json"`.

```bash
llull search random vibration                      # discover (AF-01)
llull describe set_dynamic_damping define_vibration_spectrum dynamic_report
llull guide                                        # dynamics section: units, g, damping must be explicit, 3-sigma

# 0. quick check before any FE (pure queries)
llull psd_rms spectrum=gevs_component_qual $D                       # 14.14 g rms, segment slopes
llull sdof_response fnHz=180 Q=10 'input={"kind":"random","spectrum":"gevs_component_qual"}' $D

# 1. one plan: geometry + material + modal + random case (aliases)
llull run box_random.plan.json --validate $D
llull run box_random.plan.json $D
# 2. mesh, check, solve (05 transports; the random post-processing runs inside fea_solve)
llull fea_mesh analysisId=$an $D --timeout 300
llull check_dynamics analysisId=$an $D            # must have no severity "error"
llull fea_solve analysisId=$an $D --progress --timeout 900
# 3. numbers first
llull dynamic_report analysisId=$an $D            # modes kept, mass participation, damping per mode, rms, 3-sigma, peaks
llull equivalent_static_load_case analysisId=$an probe=feet peakFactor=3 targetAnalysisId=$static $D
llull compute_margins analysisId=$static $D       # 05
llull check_dynamics analysisId=$an $D
# 4. hand-offs (heavy artefacts with --save)
llull export_response_psd analysisId=$an probe=pcb_centre --save out/pcb_stress_psd.csv $D
llull fea_export analysisId=$an format=calculix_inp --save out/box_random.inp $D
```

The agent reports (AF-36): what was analysed, the spectrum and its grade, damping and its source, g rms and
3-sigma per probe, kept-mode coverage, every `unverified` input, and "computed by llull, not approved — needs a
qualified engineer".

### 6.2 MCP agent (cloud)

Same commands through `build_project` and the `analysis` toolset. `fea_solve` is available only where the host
has `ccx`; quick checks (`sdof_response`, `psd_rms`, `shock_response_spectrum`, `damping_coefficients`) work
everywhere because they are pure.

### 6.3 Desktop UI (review only)

FRF and ASD plots, SRS log-log plots and mode tables built on the same `data`; damping and spectrum provenance
badges; the 05 disposition dialog for human gates. No capability exists only in the UI.

### 6.4 Error and edge behaviour

| Situation | Behaviour | FR |
| --------- | --------- | -- |
| No damping defined | `fea_solve` and `check_dynamics` refuse with `DYN_DAMPING_UNSET`; quick checks require `zeta` or `Q` explicitly | FR-DYN-03 |
| Excitation band above the highest kept mode × 1.5 (llull threshold, named) | Warning `DYN_BAND_ABOVE_MODES` with the numbers; solve allowed | FR-DYN-10 |
| Effective mass below threshold, or threshold unset | `DYN_MODAL_TRUNCATION` warning / `DYN_TRUNCATION_THRESHOLD_UNSET` | FR-DYN-10 |
| Base acceleration requested in a transient | Refused `DYN_BASE_ACCEL_TRANSIENT` (CalculiX allows acceleration base motion only in steady-state dynamics [R1]); remediation: give displacement history | FR-DYN-06 |
| ASD with a zero or negative level, unsorted frequencies, or a single point | `DYN_SPECTRUM_INVALID` naming the breakpoint | FR-DYN-07 |
| SRS sampling below 10 samples per period of the highest frequency | `DYN_SAMPLING_TOO_COARSE` with the needed rate | FR-DYN-11 |
| Results stale after a geometry, damping or spectrum change | `DYN_RESULTS_STALE` (05 hashing extended with dynamic inputs) | FR-DYN-20 |
| Miles' result fed into an equivalent load case | Refused `DYN_MILES_NOT_ANSWER` unless `allowQuickCheck: true` and the case is tagged `quick_check` | FR-DYN-08 |

### 6.5 Glossary

| Term | Meaning here |
| ---- | ------------ |
| ASD / PSD | Acceleration (power) spectral density, one-sided, g²/Hz unless stated |
| g rms | Square root of the area under the ASD (or response ASD) |
| Q | Amplification at resonance, 1/(2ζ) for viscous damping |
| FRF | Frequency response function (complex ratio response / input) |
| Transmissibility | Ratio of absolute response to base input |
| SRS | Shock response spectrum: peak response of SDOF oscillators to a transient, versus their natural frequency |
| Effective modal mass | Mass participating in a mode for a rigid-body direction (CalculiX definition [R1]) |

## 7. Acceptance criteria

`D = --doc case.llull.json --kernel occt --json`; values and tolerances from `validation/expected_results.json`.

| # | Given | When (CLI) | Then (JSON) | VC |
| - | ----- | ---------- | ----------- | -- |
| AC-1 | — | `llull sdof_response fnHz=100 zeta=0.05 'input={"kind":"harmonic"}' $D` | `data.peak.amplification` = 10.0125234864, `data.atFn.amplification` = 10.0 | VC-DYN-01, 02 |
| AC-2 | — | `llull sdof_response fnHz=100 Q=10 'input={"kind":"random","asdG2PerHz":0.04}' $D` | `data.milesGrms` = 7.92665459521, `data.exactGrms` = 7.96618927735, `data.answerOfRecord` = "exact" | VC-DYN-07 |
| AC-3 | — | `llull psd_rms spectrum=gevs_component_qual $D` | `data.grms` = 14.1356137191 ±1e-9 rel, `data.grade` = "B", `data.unverified` = true | VC-DYN-10 |
| AC-4 | — | `llull shock_response_spectrum 'input={"kind":"half_sine","peakG":1,"durationS":0.011}' Q=10 'frequenciesHz=[10,…,2000]' $D` | `data.maximax[*]` within 0.5 % of VC-DYN-13 | VC-DYN-13 |
| AC-5 | `plans/dyn_beamdy8_ssd.plan.json` | run, `fea_mesh`, `fea_solve`, `dynamic_report` | 9 frequency points; tip u_x amplitude peak at 13 096 Hz ±1 %; the native FRF at the CalculiX points within 2 % of the pinned beamdy8 run | VC-DYN-06, 20 |
| AC-6 | a random case without damping | `llull fea_solve analysisId=$an $D` | exit 1, `data.code` = `DYN_DAMPING_UNSET` | VC-DYN-40 |
| AC-7 | `plans/dyn_cantilever_random_gevs.plan.json` | run, mesh, solve, `dynamic_report` | tip acceleration rms within 5 % of the modal-SDOF estimate; `data.massParticipation` reported; `reviewRequired: true` | VC-DYN-21 |
| AC-8 | solved random case | `llull equivalent_static_load_case … peakFactor=3` | 05 load case created with `provenance.peakFactor` = {value 3, defaulted false}; omitting it gives {value 3, defaulted true, rationale "Gaussian 3-sigma"} | VC-DYN-09, 41 |
| AC-9 | the deliberately wrong set-ups of VC-DYN-42 | `llull run … --validate` then the failing command | each returns its code and remediation (TECHNICAL_SPEC §7.1) | VC-DYN-42 |
| AC-10 | spectrum from the library (grade B) | `dynamic_report` and `check_dynamics` | `unverified: true`, warning `DYN_SPECTRUM_UNVERIFIED` | VC-DYN-43 |

## 8. Standards & regulatory alignment

| Reference | Use in llull | Status of what is claimed |
| --------- | ------------ | ------------------------- |
| GSFC-STD-7000B GEVS [R3] | Library entry "GEVS component qualification / acceptance" ASD (20–2000 Hz, 14.1 g rms qual) | Catalogue and title confirmed by search; levels from a secondary application note [R4a] and an MIT-licensed code copy [R4b]; grade B until Table 2.4-3 is read |
| NASA-STD-7001 (A 2011, superseded by B in 2017) [R9] | Scope only: vibroacoustic test factors and minimum workmanship levels exist; no level is shipped | Values not seen (fetch blocked); TBD |
| Miles 1954 [R5]; NTRS 19900015329 [R6] | `sdof_response` Miles quick check and its known over-estimation | Citation and abstract via search |
| ISO 18431-4 / Smallwood ramp-invariant SRS [R7][R8] | SRS algorithm | Algorithm and coefficients from pyyeti source (BSD-3, read); ISO catalogue only |
| CalculiX manual and test suite [R1][R2] | Deck keywords, damping semantics, outputs, reference decks | Read at a pinned commit |
| NAFEMS TNSB Rev. 3 FV32 [R13][R14] | Modal pre-step benchmark | Two vendor manuals quote the same values (paid original) |

llull claims no qualification credit: dynamic results are "for design / pre-test prediction; not a qualification
report" until a customer qualifies the toolchain.

## 9. KPIs / success metrics

| KPI | Target | How measured |
| --- | ------ | ------------ |
| Analytic cases passing | 100 % of VC-DYN-01…14 (pure, no solver) | `npm test` |
| Solver cases passing | VC-DYN-06, 15, 20, 21 within tolerance on desktop | `npm run quality:dyn` |
| Silent damping / peak factors | 0 results without explicit damping and a named peak factor | VC-DYN-40, 41 |
| Time from plan to first random-response table (20k-node bracket, 30 modes) | ≤ 5 min agent wall time, ≤ 90 s compute | production gate |
| Agent usability | US-1 completed unattended except human gates in ≥ 9 of 10 runs | agent driver |

## 10. Risks & assumptions

| Risk / assumption | Impact | Mitigation |
| ----------------- | ------ | ---------- |
| Damping is the largest uncertainty and is rarely known | Response off by factors | No default; per-mode report; sensitivity hint in `check_dynamics` (response ∝ 1/ζ near resonance) |
| GEVS / 7001 values seen only through secondary sources | Wrong test level shipped | Grade B and `unverified` flag until a human reads the standard; library entries carry the source text |
| CalculiX has no random or response-spectrum procedure | Must post-process | Random response computed by llull from modal data (frequencies, participation factors, mode shapes): verified against CalculiX SSD at its own points (VC-DYN-06, 20) |
| Modal frequency-point grid misses sharp peaks | Under-predicted rms | llull integrates its own analytic modal FRF on an adaptive grid; CalculiX SSD points are a cross-check only |
| `*BASE MOTION` applies to all homogeneously constrained nodes of a DOF [R1] | Unintended base nodes | `check_dynamics` lists the nodes/targets that will move |
| Structural damping semantics (complex stiffness iηK) differ from viscous ζ | Misread damping | The report shows both η and the equivalent ζ = η/2 at resonance |

## 11. References

- [R1] CalculiX CrunchiX User's Manual (`doc/CalculiX.tex`: *FREQUENCY, *STEADY STATE DYNAMICS, *MODAL DYNAMIC, *DYNAMIC, *MODAL DAMPING, *DAMPING, *BASE MOTION, *AMPLITUDE, frequency analysis participation factors) — G. Dhondt, GPL-2.0 — https://github.com/Dhondtguido/CalculiX/tree/fd588701edd6a92fde06e99b1bdf01f3b0f80f2c (accessed 2026-10)
- [R2] CalculiX test decks beamdy1, beamdy3, beamdy8, beamdy10bm, beamdynamic with `.dat.ref` — same repository, `test/` (accessed 2026-10)
- [R3] GSFC-STD-7000B General Environmental Verification Standard (approved 2021-04-28) — NASA GSFC — https://standards.nasa.gov/standard/GSFC/GSFC-STD-7000 (accessed 2026-10, search; fetch blocked)
- [R4a] Vibration Research application note quoting GSFC-STD-7000B Table 2.4-3 — https://vibrationresearch.com/?p=20548 (accessed 2026-10, search)
- [R4b] `wobbl` `src/wobbl/life/modal.py` GEVS profiles (MIT) — https://github.com/sohan-bhat/wobbl/blob/1df4cee6a480a8e3aadbe029f614db3508933bb0/src/wobbl/life/modal.py (accessed 2026-10)
- [R5] J. W. Miles, "On structural fatigue under random loading", J. Aeronautical Sciences 21(11):753–762, 1954 — citation via SAE / Cambridge reference lists (accessed 2026-10, search)
- [R6] S. K. Thampi, S. N. Vidyasagar, "Random vibration analysis of space flight hardware using NASTRAN", 18th NASTRAN Users' Colloquium, 1990 — NASA NTRS 19900015329 — https://ntrs.nasa.gov/citations/19900015329 (accessed 2026-10, search)
- [R7] D. Smallwood, "An improved recursive formula for calculating shock response spectra", 51st Shock and Vibration Bulletin, 1980; ISO 18431-4 — cited in [R8] (accessed 2026-10)
- [R8] pyYeti `srs.py` (BSD-3-Clause) — https://github.com/twmacro/pyyeti/blob/39c5af215e0e45f1ebce9a83040ba95541b3f6a9/pyyeti/srs.py (accessed 2026-10)
- [R9] NASA-STD-7001 Payload Vibroacoustic Test Criteria (7001A; 7001B supersedes A, 2017) — https://standards.nasa.gov/standard/NASA/NASA-STD-7001 (accessed 2026-10, search)
- [R13] Abaqus Benchmarks Guide, FV32 Cantilevered tapered membrane — https://abaqus-docs.mit.edu/2017/English/SIMACAEBMKRefMap/simabmk-c-fv32.htm (accessed 2026-10, search)
- [R14] Altair OptiStruct OS-V:0440 Cantilevered Tapered Membrane — https://help.altair.com/hwsolvers/os/topics/solvers/os/cantilevered_tapered_membrane_fv32_r.htm (accessed 2026-10, search)
- [R15] I. Miranda, R. M. Ferencz, T. J. R. Hughes, "An improved implicit-explicit time integration method for structural dynamics", Earthquake Eng. Struct. Dyn. 18:643–653, 1989 — as cited by [R1]
- [R16] T. Dirlik, "Application of computers in fatigue analysis", PhD thesis, University of Warwick, 1985 — **not verified** (PHY-07 COULD item)
- llull: `.claude/rules/architecture.md`; aerospace 05 `../../aerospace/05-fea-cae-handoff/TECHNICAL_SPEC.md`; PHY gap list `../README.md`
