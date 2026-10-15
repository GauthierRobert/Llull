# PHY-03: Thermal analysis — functional specification

Gap id **THM** · status: specification · written 2026-10-15 · technical spec: [`TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md)
· validation: [`validation/README.md`](validation/README.md) · sources: [`validation/sources.md`](validation/sources.md)
· gap list: [`../README.md`](../README.md) row PHY-03 · conventions: [`../../aerospace/TEMPLATE.md`](../../aerospace/TEMPLATE.md),
[`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md)

## 1. Summary

After the aerospace packs, llull can set up, mesh, solve and report **structural** finite-element cases (05 FEA: linear
static, modal, buckling, bundled CalculiX) on parts whose material records carry thermal conductivity `k`, specific
heat `cp` and expansion `cte`, with temperature tables (08 MAT). It cannot compute a single temperature. There is no
heat-transfer analysis type, no thermal boundary condition (prescribed temperature, heat flux, heat generation, film
convection, radiation), no transient time stepping, no temperature result, and no way to check a part against its
operating temperature limits. 05 FEA lists thermal analysis as "possible later through CalculiX `*HEAT TRANSFER`".

Avionics boxes, brake parts, engine mounts, battery packs, spacecraft radiators and cure tools are sized by temperature
first. A thermal answer is also the input of thermal stress and thermal fits (PHY-04). Without it, an owner who asks
"does this electronics box stay below 85 °C?" gets no answer from llull, and an agent has nothing to compare against.

This gap closes it by reusing the whole 05 FEA pipeline: two new analysis types (`heat_steady`, `heat_transient`), thermal
loads and boundary conditions on exact faces, the same Gmsh mesh and bundled CalculiX `*HEAT TRANSFER` procedure [R7],
temperatures and heat flows as **data** (extremes with location, probes, time histories, per-boundary heat flow, a heat
balance), temperature-limit margins with human disposition, analytic quick checks, and a validation corpus built on
NAFEMS T2/T3/T4 and closed-form solutions reproduced exactly by a generator.

## 2. Aerospace context & value

| Context | Today (who / which tools) | What llull adds | Source |
| ------- | ------------------------- | --------------- | ------ |
| Open-source FE heat transfer | CalculiX solves steady and transient conduction with film, radiation (including cavity radiation with view factors), surface and body flux and contact conductance through ABAQUS-style cards; MOOSE, FeenoX and FEATool publish NAFEMS T3/T4 verification | The same CalculiX procedures, driven by llull commands on exact faces, offline on the desktop | [R7], [R2], [R3], [R4] |
| Solver verification | Vendors publish NAFEMS T3 and T4 (Abaqus, OptiStruct, COMSOL); coarse linear meshes miss T3 by up to 10 % (MOOSE) | NAFEMS T2/T3/T4 in the quality gate, with the analytic value computed by llull's own generator (T3 36.6031 °C, T4 18.2538 °C) | [R1], [R2], [R5], generator |
| Radiation between surfaces | Grey diffuse exchange with configuration factors (Hottel, Howell catalogue of > 300 configurations) | Configuration factors as numbers (closed forms + numerical integration) the agent can check before a solve | [R8], [R9] |
| Hand calculations next to FE | Engineers check FE temperatures with slab, fin, semi-infinite and lumped-capacitance formulas | `thermal_analytic_check` returns the formula, inputs and value next to the FE result | [R9] |
| Thermal stress input | Thermal analysis output (temperature per node) is the load of a thermal-stress step | Results kept by hash for PHY-04 to read back with `*TEMPERATURE, FILE=` | [R7], PHY-04 |

**Value statements** (sourced only): NAFEMS T3/T4 targets and their reproduction by independent codes [R1]–[R4] let an
agent prove that llull's thermal chain gives the published number before trusting it on a real part. CalculiX's
`*HEAT TRANSFER` is already bundled by 05, so no new solver enters the installer [R7]. No programme ROI is claimed.

## 3. Personas & user stories

Roles follow [`AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md) §1.

| Role | Who | Uses | Main need |
| ---- | --- | ---- | --------- |
| **Operator (primary)** | AI agent through the `llull` CLI (`--doc`, `--app`); cloud agent through MCP | `llull run`, `llull fea_mesh`, `llull fea_solve`, `llull thermal_report --json`, `llull check_thermal --json` | Commands with units on every parameter, temperatures and heat flows as JSON, stable codes, analytic checks |
| **Owner** | The person who asks ("will the box stay below 85 °C in a 55 °C bay?"). **Not assumed to be an engineer** | Natural language; may watch the desktop app | A plain answer: hottest point, by how much it clears the limit, what was assumed, what needs an engineer |
| **Qualified reviewer** | Thermal or stress engineer, design-organisation signatory | Desktop review surfaces (temperature map, margins table, disposition dialog), exported INP | Audits boundary conditions (film coefficients, emissivities, sinks), dispositions negative or marginal temperature margins, signs |

User stories:

- **US-THM-1 (owner → operator).** "Does the avionics box stay below its 85 °C limit with 20 W inside and a 55 °C bay?"
  The agent assigns 08 records, adds heat generation on the board, film convection on the outer faces (h given by the
  owner or a cited source, never guessed), runs `heat_steady`, and reports max T, its location, the limit margin and every
  assumed value with its source.
- **US-THM-2 (operator).** A brake disc heats during a stop: the agent defines a time-dependent surface flux (amplitude
  table), runs `heat_transient` with an initial temperature, and reports the peak temperature and when it occurs.
- **US-THM-3 (operator).** Before running a radiator model the agent calls `compute_view_factors` on the radiating faces,
  checks the row sums, and compares one pair with `thermal_analytic_check check=view_factor`.
- **US-THM-4 (operator).** After every solve the agent calls `check_thermal` and refuses to report a result whose heat
  balance residual exceeds the named tolerance (`THM_HEAT_BALANCE`).
- **US-THM-5 (operator → reviewer).** A negative temperature margin cannot be accepted by the agent: the qualified
  reviewer dispositions it with a human-held signature (`dispose_thermal_limit`, human gate).
- **US-THM-6 (operator).** The thermal result is handed to PHY-04 (`thermo_static` case reads the temperatures by results
  hash) for thermal stress and fits.
- **US-THM-7 (reviewer).** The reviewer exports the CalculiX deck (`fea_export format=calculix_inp`) and runs it in the
  thermal office's own tool.

## 4. Scope / out of scope

| Phase | In scope |
| ----- | -------- |
| **MVP** | Analysis types `heat_steady`, `heat_transient` (05 `AnalysisCase`). Thermal BCs on exact faces / points: prescribed temperature, surface heat flux, volumetric heat generation, concentrated flux, film convection (constant h, sink T), radiation to ambient (constant ε, sink T). Initial temperature. Amplitudes (tables; sine/ramp sampled to tables). Time step control (fixed or automatic with DELTMX). Materials k, cp, ρ from 08 records with temperature tables / PHY-01 property models. Gmsh mesh + bundled CalculiX `*HEAT TRANSFER`. FRD/DAT import of NT, HFL, RFL. Results as data: T extremes with location, probes and time histories, per-BC heat flow, heat balance. Temperature limits with margins, `reviewRequired`, human disposition. `check_thermal`, `thermal_report`, `thermal_analytic_check`. Validation: NAFEMS T2/T3/T4, analytic cases, CalculiX `oneel8ra`. |
| **V1** | Cavity radiation (`RxCR`, cavities, environment temperature, closed cavities) and a read-only `compute_view_factors` query. Thermal contact conductance between parts (tied contact pair + `*GAP CONDUCTANCE`). Temperature-dependent film coefficient and emissivity tables. Orthotropic conductivity (`TYPE=ORTHO`, e.g. from 06 laminates). Thermal result export to VTU. `render_view` temperature field. |
| **V2** | Phase change through an apparent-heat-capacity table generated from latent heat (CalculiX has no latent-heat card, [R7]). Forced convection with fluid network elements (`FxFC`). Nastran thermal deck (SOL 153/159) export. Orbital heat loads as a hand-off (solar / albedo / planet IR from a dedicated orbital-thermal tool). Thermal-electrical (Joule) heating, with PHY-15 resistivity. |
| **Out of scope** | CFD and conjugate heat transfer with resolved flow (separate product line, `../README.md` "Not in this list"). Computing film coefficients from correlations as a certified value (llull may offer a cited correlation as a quick check, never as a silent default). Thermal-vacuum test correlation. Certification sign-off. |

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-THM-01 | MUST | **Steady-state heat conduction** analysis type `heat_steady` in the 05 analysis model, solved with CalculiX `*HEAT TRANSFER, STEADY STATE`. | Most equipment sizing is steady | [R7] |
| FR-THM-02 | MUST | **Transient** analysis type `heat_transient`: explicit initial temperature, end time, increment control (fixed or automatic, maximum temperature change per increment), output times. A transient case refuses to solve without `cp`, `ρ` and an initial temperature. | Transient needs specific heat (CalculiX) | [R7] |
| FR-THM-03 | MUST | **Film convection** on faces: q = h(T − T_sink), with h and T_sink given explicitly with units (or from a named, sourced correlation result). h is never defaulted. | Convection is the main cooling path of equipment | [R7], AF-31 |
| FR-THM-04 | MUST | **Heat input**: surface heat flux on faces (W/m², positive into the part), volumetric heat generation in parts (W/m³ or total W distributed over the part volume), concentrated flux at points (W, SHOULD). | Electronics dissipation, brake friction | [R7] |
| FR-THM-05 | MUST | **Radiation to ambient** on faces: q = εσ(θ⁴ − θ_sink⁴) on absolute temperature, with ε ∈ [0, 1] explicit (or from the PHY-15 `emissivity_ir` property with its provenance). The Stefan–Boltzmann constant and absolute zero are written to the deck and named in results. | Spacecraft, hot parts | [R7], [R11], PHY-15 |
| FR-THM-06 | SHOULD (V1) | **Cavity radiation** between faces of one or more parts, grouped into named cavities, open (radiating the remainder to an environment temperature) or closed; **view factors as data** through the read-only `compute_view_factors` query (matrix, row sums, method). | Radiators, enclosures, furnaces | [R7], [R8] |
| FR-THM-07 | MUST | **Time-dependent loads**: any temperature, flux or sink can follow a named amplitude (time table; sine and ramp are sampled to a table at a stated step). | NAFEMS T3 sine boundary; duty cycles | [R7], [R2] |
| FR-THM-08 | SHOULD (V1) | **Contact conductance** between touching parts: conductance (W/(m² K)) as a constant or a table of contact pressure and temperature. | Bolted equipment on cold plates | [R7] |
| FR-THM-09 | COULD (V2) | **Phase change** from a latent heat and a melting range, converted to an apparent specific-heat table with an energy check. | Phase-change materials, cure | [R7] (no latent card), [R9] |
| FR-THM-10 | MUST | **Thermal material data** come only from 08 MAT records (`k`, `cp`, `density`, temperature tables, basis, provenance) or PHY-01 property models; FEA-style read-only view, no copy. Evaluation outside a table's or model's valid range at a solved temperature is reported, never extrapolated silently. | One material model per document | 08 MAT, PHY-01 |
| FR-THM-11 | MUST | **Results as data** (AF-21): max and min temperature with location and part, temperature at probes (and probe time histories for transients), max heat-flux magnitude, heat flow through each boundary condition (W), time of peak temperature, all with units. | Agents and owners read numbers | AF-10, AF-21 |
| FR-THM-12 | MUST | **Heat balance**: every solved case reports Σ heat in, Σ heat out, stored energy change (transient) and the relative residual. `check_thermal` warns above a named tolerance (default 1 %, source "llull acceptance rule", `defaulted: true`). | Proves the model conserves energy | AF-20, AF-31 |
| FR-THM-13 | MUST | **Temperature limits and margins**: limits (min and/or max, °C or K) attached to parts or targets with a mandatory source (component datasheet, company rule, material record). Margin = limit − T (K) per row, status PASS / MARGINAL / FAIL (marginal band only when the caller sets one), `reviewRequired: true`, `disposition: "pending_human"` for FAIL/MARGINAL. No limit is ever defaulted. | "Does it stay below 85 °C?" is the owner's question | AF-31, AF-33, AF-34 |
| FR-THM-14 | SHOULD | **Analytic quick checks** (read-only): plane wall with convection, slab with generation, semi-infinite solid, lumped capacitance (with the Bi < 0.1 validity check), fin efficiency, grey parallel plates, view factors (parallel / perpendicular rectangles, coaxial discs), one-phase Stefan problem. | Engineering practice: check FE against hand calculations | [R9] |
| FR-THM-15 | MUST | **Traceability and staleness** reuse 05 (input hash, mesh hash, results hash, solver version); thermal BCs, amplitudes, initial temperature, step settings and limits enter the input hash. | Results must match the revision | 05 FR-FEA-22 |
| FR-THM-16 | MUST | **Deck export**: the 05 `fea_export format=calculix_inp` writes a complete thermal deck (`*CONDUCTIVITY`, `*SPECIFIC HEAT`, `*DENSITY`, `*PHYSICAL CONSTANTS`, `*INITIAL CONDITIONS`, `*AMPLITUDE`, `*HEAT TRANSFER`, `*BOUNDARY` DOF 11, `*DFLUX`, `*CFLUX`, `*FILM`, `*RADIATE`, `*NODE FILE NT`, `*EL FILE HFL`). | Hand-off to the thermal office | [R7] |
| FR-THM-17 | MUST | **Validation suite** (NAFEMS T2/T3/T4, analytic cases, CalculiX `oneel8ra`) runs in CI and gates releases (through PHY-00). | Credibility | [R1]–[R4], [R7] |
| FR-THM-18 | MUST | **Temperature field hand-off**: a solved thermal case exposes its nodal temperatures (per time point) by results hash so a PHY-04 `thermo_static` case can read them; staleness propagates (a stale thermal result makes the dependent mechanical result stale). | Thermal stress input | PHY-04 |
| FR-THM-19 | MUST | **Units** (AF-04): every thermal quantity takes `{ value, unit }` or states its unit; the temperature scale (`degC` or `K`) is fixed per case; radiation is always evaluated on absolute temperature; conversions to the analysis unit system follow the CalculiX units table and are unit-tested. | FE codes have no units; radiation on °C is a classic error | [R7], AF-04 |
| FR-THM-20 | MUST | **Named defaults** (AF-31): physical constants and the heat-balance tolerance are named with source and `defaulted`; film coefficient, emissivity, sink temperature, initial temperature and temperature limits are **never** defaulted. | No silent safety-relevant value | AF-31 |
| FR-THM-21 | MUST | **Readiness check and codes** (AF-11, AF-20): `check_thermal` returns pass / warn / fail items with the stable codes of TECHNICAL_SPEC §7.1 (set-up, material, units, heat path, mesh, results, heat balance, property range, limits). | Agents act on codes | AF-11, AF-20 |
| FR-THM-22 | MUST | **Unverified propagation and review** (AF-32, AF-33): an `unverified` k / cp / ρ / ε input flags every result and margin row computed from it; every limit-margin row and `check_thermal` result carries `reviewRequired: true` with a reason. | Typical data are not design data | AF-32, AF-33 |
| FR-THM-23 | MUST | **Human disposition** (AF-34): only `dispose_thermal_limit` with a human-held signature (09 PLM signing port) records the acceptance of a FAIL or MARGINAL limit row; an agent gets `THM_HUMAN_GATE`. | Accepting an exceedance is an approval act | AF-34 |
| FR-THM-24 | SHOULD | **Visual check** (AF-22): `render_view … analysisId=… field=temperature time=… --save t.png`; the desktop shows the temperature map, legend in the case's scale, probes and limit badges (review surface, FR-THM-11 data). | Multimodal agents and reviewers | AF-22 |
| FR-THM-25 | MUST | Every capability is a registry command reachable from CLI, MCP and UI (L1/L5); thermal set-up fits in one `build_project` plan checkable with `llull run --validate`. | One command layer | L1, AF-01, AF-05 |

## 6. Workflows

### 6.1 CLI (operator, primary)

Proposed commands are those of TECHNICAL_SPEC §4. Meshing and solving reuse the 05 transports (`fea_mesh`, `fea_solve`).

```bash
llull search thermal temperature                       # discover (AF-01)
llull describe create_analysis add_thermal_bc set_thermal_step check_thermal
llull guide                                            # thermal section: scales, absolute zero, minimal plans (AF-03)

# 1. one plan: geometry + 08 records (k, cp, rho) + thermal case
llull run box.plan.json --validate --doc box.llull.json                 # step path + param on error (AF-05)
llull run box.plan.json --doc box.llull.json --kernel occt --json       # $an from aliases

# 2. mesh, readiness, solve
llull fea_mesh analysisId=$an --doc box.llull.json --kernel occt --progress --timeout 300 --json
llull check_thermal analysisId=$an --doc box.llull.json --json          # must have no severity "error"
llull fea_solve analysisId=$an --doc box.llull.json --progress --timeout 900 --json

# 3. numbers first
llull thermal_report analysisId=$an --doc box.llull.json --json         # extremes, probes, heat flows, balance
llull check_temperature_limits analysisId=$an --doc box.llull.json --json   # margins, reviewRequired, disposition
llull thermal_analytic_check check=plane_wall 'inputs={"L_m":0.05,"k_W_mK":15,"h1_W_m2K":50,"Tinf1_degC":200,"h2_W_m2K":10,"Tinf2_degC":20}' --json

# 4. look and hand off
llull render_view view=iso analysisId=$an field=temperature --save out/t.png --doc box.llull.json
llull fea_export analysisId=$an format=calculix_inp --save out/box_thermal.inp --doc box.llull.json
```

The agent ends every thermal job with `check_thermal` and reports, in order (AF-36): what was analysed, max/min
temperature and where, heat balance residual, each limit margin, every assumed BC value with its source, every
`unverified` input, and "computed by llull, not approved — needs a qualified engineer" when a limit row exists.

### 6.2 MCP (cloud)

Same commands in the `analysis` toolset (05). `fea_mesh` / `fea_solve` exist only where the host bundles Gmsh and
CalculiX; otherwise `FEA_TOOL_MISSING` (05). Queries return the same JSON as the CLI.

### 6.3 Desktop UI (review and approval only)

Analysis tree with thermal BC glyphs (flux arrows, film and radiation symbols with values), temperature map with legend
and probes, time slider for transients, heat-balance panel, limits table with badges, and the disposition dialog
(human gate). No UI-only capability.

### 6.4 Surface matrix

| Capability | CLI (primary) | MCP | UI (review) |
| ---------- | ------------- | --- | ----------- |
| Thermal set-up | `llull run`, `llull add_thermal_bc …` | registry tools | tree, glyphs |
| View factors (V1) | `llull compute_view_factors --json` | same | matrix panel |
| Mesh / solve | `llull fea_mesh`, `llull fea_solve` | when hosted | progress |
| Results | `llull thermal_report --json` | same | map, slider |
| Readiness | `llull check_thermal --json` | same | badges |
| Limits / margins | `llull check_temperature_limits --json` | same | table |
| Disposition | prepare only (`THM_HUMAN_GATE`) | prepare only | **complete** (signature) |
| Deck | `llull fea_export … --save` | exchange dir | Export menu |

### 6.5 Error and edge behaviour

| Situation | Behaviour | FR |
| --------- | --------- | -- |
| Transient case, a part's record lacks `cp` | `check_thermal` error `THM_MATERIAL_NO_CP`; solve refused | FR-THM-02, 10 |
| No initial temperature in a transient case | error `THM_INITIAL_TEMPERATURE_MISSING` (never defaulted) | FR-THM-02, 20 |
| Steady case with no prescribed temperature, film or radiation anywhere | error `THM_NO_HEAT_PATH` (the steady problem has no unique solution) | FR-THM-01 |
| Emissivity outside [0, 1] | command rejected, `THM_EMISSIVITY_INVALID`, doc unchanged | FR-THM-05 |
| Solved temperatures leave a k(T) or cp(T) table range | warning `THM_PROPERTY_OUT_OF_RANGE` naming material, property, range and T reached; results flagged | FR-THM-10 |
| Heat balance residual above tolerance | warning `THM_HEAT_BALANCE` with the numbers; agent must not report the result as final | FR-THM-12 |
| A limit is exceeded | row FAIL, `THM_LIMIT_EXCEEDED`, pending human disposition | FR-THM-13, 23 |
| Geometry change after solve | results `stale`; dependent PHY-04 results stale too | FR-THM-15, 18 |

### 6.6 Glossary

| Term | Meaning |
| ---- | ------- |
| Film coefficient h | Convective heat transfer coefficient, W/(m² K); q = h(T − T_sink) [R7] |
| Sink temperature | Temperature of the environment a face exchanges heat with by film or radiation [R7] |
| Emissivity ε | Ratio of emitted radiation to a black body's; CalculiX assumes diffuse grey surfaces [R7] |
| View (configuration) factor F_ij | Fraction of diffuse radiation leaving face i that reaches face j [R8], [R9] |
| Heat balance residual | (Σ in − Σ out − ΔE_stored) / max(Σ in, Σ out) |
| Temperature margin | Limit − computed temperature, in K (positive = inside the limit) |

## 7. Acceptance criteria

`D` = `--doc case.llull.json --kernel occt --json`. Expected values and tolerances: `validation/expected_results.json`.

| # | Given | When (CLI) | Then (JSON) | VC |
| - | ----- | ---------- | ----------- | -- |
| AC-1 | `plans/thm_nafems_t3.plan.json` | `llull run <plan> D`; `fea_mesh`; `fea_solve`; `thermal_report analysisId=$an D` | probe `x080` at t = 32 s within 2 % of 36.6 °C | VC-THM-03 |
| AC-2 | `plans/thm_nafems_t4.plan.json` | same | probe `E` within 1 % of 18.2538 °C | VC-THM-04 |
| AC-3 | `plans/thm_wall_convection.plan.json` | same | probes `hot_face` 170.81 °C and `cold_face` 165.95 °C (±0.05 K); film heat flows 1459.46 W in / out; `data.heatBalance.residualRel` ≤ 1e-3 | VC-THM-01 |
| AC-4 | the CalculiX test deck `oneel8ra.inp` (pinned) | `fea_import_results format=frd` of its run | radiating-face T = −0.950739 °C, Σ RFL = 47.5369 W | VC-THM-14 |
| AC-5 | `plans/thm_parallel_plates_cavity.plan.json` (V1) | `compute_view_factors analysisId=$an D` | F(hot→cold) within 0.002 of 0.199825; row sum + environment = 1 | VC-THM-09 |
| AC-6 | `thermal_analytic_check` with the inputs of VC-THM-06…12 | one call each | values equal the generator to the stated tolerance; `data.formula` and `data.inputs` present | VC-THM-06…12 |
| AC-7 | `plans/thm_rejections.plan.json` | `llull run <plan> D`, then `check_thermal` | `THM_EMISSIVITY_INVALID` at the radiation step; `check_thermal` items `THM_MATERIAL_NO_CP`, `THM_INITIAL_TEMPERATURE_MISSING`, `THM_NO_HEAT_PATH` | VC-THM-61 |
| AC-8 | a solved case with a 85 °C limit exceeded | `check_temperature_limits D`; agent calls `dispose_thermal_limit … D` | row `status: "FAIL"`, `reviewRequired: true`, `disposition: "pending_human"`; disposition exits 1 with `THM_HUMAN_GATE`, doc hash unchanged | VC-THM-62 |
| AC-9 | any radiation case | `thermal_report D` | `data.physicalConstants` equals VC-THM-60 (σ and absolute zero, `defaulted: true`, sources) | VC-THM-60 |
| AC-10 | solved T3 | `set_parameter` on the bar length; `thermal_report D` | `state: "stale"`; `check_temperature_limits` exits 1 with `FEA_RESULTS_STALE` | VC-THM-50 |

## 8. Standards & regulatory alignment

| Reference | Use in llull | Status of what is claimed |
| --------- | ------------ | ------------------------- |
| NAFEMS TNSB Rev. 3 (1990) / *Benchmark Tests for Thermal Analysis* (1986) [R10] | T2/T3/T4 targets | Paid; targets taken from code verification material [R1]–[R4] and reproduced analytically |
| CalculiX / ABAQUS input conventions [R7] | Thermal deck writer and FRD reader | Verified in manual and source at a pinned commit |
| SI (2019) [R11] | Stefan–Boltzmann constant derived from exact constants | Derived; h confirmed by search, σ cross-checked against FeenoX |
| Equipment environmental qualification (e.g. RTCA DO-160 temperature categories) | Not used. Limits are owner-supplied data with sources | Not searched; llull ships no limit tables |

llull does not claim thermal certification credit; every limit row says "computed by llull, not approved".

## 9. KPIs / success metrics

| KPI | Target | How measured |
| --- | ------ | ------------ |
| Benchmarks passing | 100 % of VC-THM-01…14 within tolerance on desktop | `npm run quality:thermal` (PHY-00 runner) |
| Analytic agreement | `thermal_analytic_check` equals the generator to 1e-9 relative | unit tests |
| Heat balance | residual ≤ 1e-3 on every validation case | VC-THM-01.d |
| Silent defaults | 0 film coefficients, emissivities, sinks, initial temperatures or limits used without explicit value or named source | VC-THM-60, 61 |
| Agent usability | US-THM-1 completed unattended (except human gate) in ≥ 9 of 10 scripted runs | production-gate agent driver |

## 10. Risks & assumptions

| Risk / assumption | Impact | Mitigation |
| ----------------- | ------ | ---------- |
| Film coefficients and emissivities dominate the answer and are uncertain | Wrong temperatures with a confident number | Never defaulted; every value carries its source in the report; sensitivity runs later through PHY-18 |
| Radiation written on the Celsius scale | Grossly wrong radiation | Case-level temperature scale; `*PHYSICAL CONSTANTS, ABSOLUTE ZERO=` always written; unit test |
| CalculiX view factors are "approximate" (manual) | Cavity errors | `compute_view_factors` independent TS computation and row-sum check; VC-THM-30 measures the difference |
| Transient time step too coarse | Missed peaks | DELTMX and maximum increment exposed; T3 case pins a stable set-up; convergence through PHY-00 |
| Nonlinear radiation does not converge | Solve failure | readable `FEA_SOLVER_FAILED` log tail; suggestion to ramp the radiation amplitude |
| Assumption: CalculiX as bundled by 05 includes the heat-transfer procedures | none if true | they are part of the standard source (`calinput.f`, [R7]) |

## 11. References

- [R1] Abaqus Benchmarks Guide T3 / T4 — Dassault Systèmes — https://docs.software.vt.edu/abaqusv2024/English/SIMACAEBMKRefMap/simabmk-c-t3.htm (accessed 2026-10, search)
- [R2] MOOSE NAFEMS T3 verification — INL — https://github.com/idaholab/moose/tree/1d086a353a1b04f6425f2fe51a114a99a081bc1d/modules/heat_transfer (accessed 2026-10)
- [R3] FeenoX NAFEMS tests — Seamplex — https://github.com/seamplex/feenox/tree/3759eb2426a9e9a77ab8a9ce97db93071a389776/tests (accessed 2026-10)
- [R4] FEATool examples ex_heattransfer3/4 — Precise Simulation — https://github.com/precise-simulation/featool-multiphysics/tree/1fca801ad3c54cf7e2c90b0bf3c2e21255e4bcef/examples (accessed 2026-10)
- [R5] Altair OptiStruct OS-V:0110 — Altair — https://help.altair.com/hwsolvers/os/topics/solvers/os/nafems_test_problem_t3_r.htm (accessed 2026-10, search)
- [R6] COMSOL heat_convection_2d — COMSOL — https://doc.comsol.com/6.4/ (gap-list extract)
- [R7] CalculiX source, manual and tests — G. Dhondt — https://github.com/Dhondtguido/CalculiX/tree/fd588701edd6a92fde06e99b1bdf01f3b0f80f2c (accessed 2026-10)
- [R8] Howell, A Catalog of Radiation Configuration Factors — https://thermalradiation.net/calc/sectionc/C-11.html (accessed 2026-10, search)
- [R9] Lienhard & Lienhard, A Heat Transfer Textbook, 6th ed. — https://ahtt.mit.edu/ (accessed 2026-10, search)
- [R10] NAFEMS resource centre (TNSB Rev. 3; Benchmark Tests for Thermal Analysis) — https://www.nafems.org/publications/resource_center/ (catalogue)
- [R11] BIPM SI Brochure (defining constants) — https://www.bipm.org/en/publications/si-brochure (accessed 2026-10, search)
- [R12] pyViewFactor — https://pypi.org/project/pyviewfactor/ (accessed 2026-10)
- llull: `.claude/rules/architecture.md`; `docs/aerospace/05-fea-cae-handoff/TECHNICAL_SPEC.md`; `docs/aerospace/08-materials-standards-libraries/TECHNICAL_SPEC.md`; `docs/physics/README.md`
