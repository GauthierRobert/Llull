# PHY-16: Manufacturing process physics — functional specification

Gap id **PHY-16** · prefix **PRC** · status: specification · written 2026-10-15 · technical spec:
[`TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md) · validation: [`validation/README.md`](validation/README.md) · sources:
[`validation/sources.md`](validation/sources.md)

## 1. Summary

llull designs the part as it should be, but the shop makes the part as the process leaves it. After the aerospace packs,
sheet-metal parts get exact flat patterns (aerospace 07 FTR: bend allowance θ(R + K·T), bend tables, DXF) but **no
springback**: a 90° bend formed at the drawn radius opens up when the punch is removed, so the press brake must overbend
and the tool radius must be smaller than the drawing radius. 07 lists forming simulation explicitly as out of scope
(`../../aerospace/07-sheet-metal-machined-features/FUNCTIONAL_SPEC.md` §4.2). Likewise, additively manufactured (AM)
metal parts warp when residual stresses from layer-by-layer solidification are released (cutting from the build plate,
support removal), and thin machined parts move when bulk residual stress is machined away. None of this is predicted today.

This pack adds, in order of value and certainty:

1. **Analytic springback** for air or die bending of sheet (elastic-perfectly plastic pure bending): formed radius and
   angle after release, and **compensation** (tool radius and tool angle that give the drawn radius and angle), per bend
   of a 07 sheet-metal part, with every material input named and sourced.
2. **FE springback** through PHY-05 (nonlinear static, plasticity, NLGEOM) and PHY-06 (tool contact), with tool removal
   by CalculiX `*MODEL CHANGE` [R1], when the analytic assumptions do not hold (hardening, short flanges, coined bends).
3. **AM build distortion with the inherent-strain method**: layers activated stress-free in sequence (CalculiX `*MODEL
   CHANGE, ADD=STRAIN FREE` [R1]) and loaded by a calibrated inherent strain (thermal-analogy expansion), then support /
   plate removal; plus a geometric **overhang (downskin) check** against an explicit company or machine rule.
4. **COULD**: machining distortion from an initial residual-stress field (`*INITIAL CONDITIONS, TYPE=STRESS` then element
   removal [R1]); weld and heat-treatment distortion as hand-offs only.

Results are numbers first: formed radius / angle, compensated tool values, curvature and deflection after each layer and
after release, maximum distortion at named points, overhang face areas by angle band.

## 2. Aerospace context & value

| Context | Today (who / which tools) | What llull adds | Source |
| ------- | ------------------------- | --------------- | ------ |
| Brake-formed clips, angles, brackets (2024-T3, 7075-O/-W, Ti) | Shop overbend from experience or trial bends; springback tables or forming simulation (AutoForm, PAM-STAMP) at OEMs | Per-bend springback and compensation from the 07 bend table; compensation table on the drawing / router data | [R2] (07 bend data), derivation [R3] |
| Springback theory | Elastic-plastic bending results reproduced in sheet-forming texts; Gardiner (1957, Trans. ASME / ASM) is the usual citation for R_i/R_f = 4u³ − 3u + 1 | Exact derivation in the generator (same form) with validity limits and plane-strain option | [R3] (citation via search; derivation in generator) |
| Laser powder-bed fusion (L-PBF) metal parts | Inherent-strain tools (commercial: Simufact Additive, Ansys Additive, Amphyon; method papers: modified inherent strain, To et al.) | Layer-by-layer inherent-strain FE on the 05 mesh with bundled CalculiX; agent-scriptable calibration loop | [R4], [R1] |
| AM measurement benchmarks | NIST AM-Bench 2018 AMB2018-01: IN625 and 15-5 PH bridge structures; part deflection measured after the legs are cut from the base plate by EDM (IN625: 1.276 mm at ridge 1; 15-5: 1.168 mm) | A benchmark case for calibration / validation of the inherent-strain workflow (grade B until the data release is read) | [R5] |
| AM design rules | Overhang / self-support rules are machine and material specific (ISO/ASTM 52911-1 is the DfAM standard for L-PBF; paywalled) | `check_am_overhang` with an explicit threshold angle and source; no built-in default | [R6] (catalogue) |
| Thin machined parts (monolithic ribs, frames) | Residual-stress relaxation predicted with FE at large OEMs; otherwise found at inspection | COULD: element-removal distortion with an initial stress field | [R1] |

Value statements (sourced only): 07 shows llull already holds exact bend data for every sheet part [R2]; springback is the
next number the shop needs to make the bend first time. NIST published AM-Bench measurements specifically so that models
of residual stress and distortion can be checked against measurements [R5].

## 3. Personas & user stories

Roles follow [`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md) §1. Process predictions drive tooling and
first-article decisions, not airworthiness directly, but compensated geometry ends up on released manufacturing data, so
results are `reviewRequired` (AF-33) and releasing a compensation table is a 09 PLM approval (human gate, AF-34).

| Role | Who | Uses | Main need |
| ---- | --- | ---- | --------- |
| **Operator (primary)** | AI agent with the `llull` CLI | `springback_calc`, `springback_compensation`, `check_process`, `am_build_setup`, `check_am_overhang`, `process_report` | Explicit material inputs with sources, compensation as data, codes when assumptions fail |
| **Owner** | Designer / supplier asking "what tool radius and angle do I need?" or "will this AM bracket warp off the plate?" — not assumed to be an engineer | Natural language | A table to hand to the shop, with what was assumed |
| **Qualified reviewer** | Manufacturing engineer (forming / AM process owner) | Desktop review: bend table with compensation, distortion overlay, overhang map | Approves the material data, calibration and the compensation table for release |

User stories:

- **US-1 (owner → operator).** "Make the bracket bends come out at 90° and R 4.8 mm." The agent calls
  `springback_compensation` on the 07 part: the command reads the bend table through 07 `flat_pattern`, takes E and the
  yield stress from the 08 record (temper-specific, sourced), and returns per bend the tool radius, tool angle and overbend,
  flagged `reviewRequired`. If the record has only `typical` values, every row is `unverified`.
- **US-2 (operator).** A bend with R_i ≥ E·T/(2Y) is still elastic at the outer fibre: `PRC_BEND_ELASTIC` (the bend fully
  springs back; it cannot be formed at that radius by bending alone).
- **US-3 (operator).** For a short-flange, strongly hardening material the agent runs the FE route: a plane-strain strip,
  PHY-02 J2 plasticity, PHY-05 NLGEOM steps "bend" and "release", and compares FE and analytic in one JSON.
- **US-4 (owner → operator).** "Will this AM bracket distort after it is cut off the plate?" The agent calls `am_build_setup`
  (layer height, build direction, plate, supports), sets a calibrated inherent strain (from a calibration coupon or the
  owner's process data; no default), solves, and reads plate-attached and released distortion at named points. It runs
  `check_am_overhang` with the machine rule the owner gave (e.g. "45° from the plate, source: machine vendor manual").
- **US-5 (reviewer).** The reviewer releases the compensation table through 09 PLM; an agent cannot complete the release.

## 4. Scope / out of scope

| Phase | In scope |
| ----- | -------- |
| **MVP** | `springback_calc` (single bend, uniaxial or plane-strain option, validity checks), `springback_compensation` (per 07 bend; data only), `check_process` (sheet: validity, minimum radius relayed from 07, unverified inputs), `check_am_overhang` (downskin angle bands, threshold required), named-input contract, codes, VC-PRC-10/20/50–54. |
| **V1** | FE springback (pure bending by end rotation; then punch / die with PHY-06 contact and `*MODEL CHANGE` tool removal); AM inherent-strain build (layer slicing of the 05 mesh by height, stress-free activation, inherent strain as orthotropic expansion, plate / support removal step), `process_report`; calibration helper (`am_calibrate_inherent_strain`: fit a scalar or orthotropic inherent strain to a measured coupon deflection); VC-PRC-11, 30, 40. |
| **V2** | Springback with hardening laws from PHY-02 (analytic linear hardening, FE general); compensated flat pattern written back as a new 07 part revision through 07 commands (`execute`), never by editing geometry directly; machining distortion (initial stress + element removal); AM: support-structure stiffness and recoater-interference flag. |
| **Out of scope** | Thermal process simulation of melt pools (moving heat source), welding simulation (hand-off), heat-treatment quench simulation, stretch / hydro-forming of doubly curved skins, thinning and FLD, cure / composite process (excluded in the physics README), certification of process specifications. |

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-PRC-01 | MUST | `springback_calc`: inputs T, R_i, bend angle, E, yield stress Y (each with unit; Y and E from an 08 record or explicit `{ value, unit, source }`), stress state `uniaxial` \| `plane_strain` (explicit). Outputs u = R_i Y/(E T), R_f, R_i/R_f, final angle θ_f = θ_i (R_i + T/2)/(R_f + T/2), springback angle, regime. | Shop question #1 | derivation [R3] |
| FR-PRC-02 | MUST | Plane-strain option uses E′ = E/(1 − ν²) and Y′ = 2Y/√3 (von Mises), with ν explicit; the option used is echoed. | Wide sheet bends are plane strain | derivation |
| FR-PRC-03 | MUST | `springback_compensation`: for a target R_f and θ_f (or for every bend of a 07 part, read through 07 `flat_pattern`), the tool radius R_i and tool angle θ_i and the overbend θ_i − θ_f. No document change. | Compensation table for the press brake | [R2], derivation |
| FR-PRC-04 | SHOULD | The compensation output is also available as a sheet table / CSV (`--save`) keyed by 07 bend ids. | Hand-off to the shop | [R2] |
| FR-PRC-05 | SHOULD (V1) | **FE springback**: a `forming_springback` analysis (PHY-05 `nonlinear_static` steps "form" and "release") on a strip or a 07 part region, with PHY-02 plasticity, NLGEOM on, forming by end rotation (pure bending) or by tools (PHY-06 contact), and release by removing the tool contact (`*MODEL CHANGE, TYPE=CONTACT PAIR, REMOVE`) or the prescribed rotation. Output: formed radius / angle measured on named points. | Hardening, short flanges | [R1], PHY-05, PHY-06 |
| FR-PRC-06 | SHOULD (V1) | Tool definitions (punch radius, die opening, die radius) as analysis data; tools as rigid or elastic parts. | Air bending set-up | [R1] |
| FR-PRC-07 | SHOULD (V1) | **AM inherent strain**: an `am_build_distortion` analysis on the 05 mesh: build direction, layer (lumped) height, base-plate part, optional support region; inherent strain `{ εxx, εyy, εzz }` in build coordinates with source (calibration or owner data; no default). | L-PBF distortion | [R4], [R1] |
| FR-PRC-08 | SHOULD (V1) | Layers are activated in build order, **stress-free**, and receive the inherent strain in their activation step (CalculiX `*MODEL CHANGE, TYPE=ELEMENT, ADD=STRAIN FREE` + orthotropic `*EXPANSION` with a unit temperature increment). | Layering matters (generator: 2.07× vs all-at-once, VC-PRC-30.e) | [R1], derivation |
| FR-PRC-09 | SHOULD (V1) | **Release steps**: remove supports and / or the base plate (element removal) and report the distortion change. | AM-Bench measures after EDM cut | [R1], [R5] |
| FR-PRC-10 | SHOULD (V1) | **Calibration**: `am_calibrate_inherent_strain` fits the inherent strain to a measured coupon deflection (a cantilever or bridge coupon) with the PHY-05/PHY-00 machinery; the fit result is a sourced material-process datum (stored on the 08 record as a PHY-01 property with provenance). | Inherent strain is process-specific | [R4] |
| FR-PRC-11 | MUST | `check_am_overhang`: for an exact solid and a build direction, area of downward-facing faces by downskin-angle band (0° = horizontal ceiling, 90° = vertical wall), faces below a **required** threshold listed with ids; the threshold carries its source. | Support planning | [R6] (standard catalogue only) |
| FR-PRC-12 | COULD (V2) | **Machining distortion**: initial residual-stress field (uniform per region or layered table) on the stock mesh, element removal of machined regions, distortion of the finished part; analytic layer-removal check (VC-PRC-30.d). | Thin machined parts | [R1] |
| FR-PRC-13 | COULD (V2) | **Weld / heat-treatment distortion**: export of an inherent-shrinkage load case only (no welding physics). | Hand-off | — |
| FR-PRC-14 | MUST | `check_process`: sheet bends — elastic regime (`PRC_BEND_ELASTIC`), u outside validity, minimum bend radius (07's `FTR_BEND_RADIUS_BELOW_MIN` relayed), missing or unverified inputs; AM — missing calibration, missing threshold, layer height vs mesh size. | AF-20 | AF-20, 07 |
| FR-PRC-15 | MUST | **No defaults** for Y, E, ν, inherent strain, overhang threshold, layer height; named defaults only for pure conventions (angle measured as bent through, as in 07). | AF-31 | AF-31 |
| FR-PRC-16 | MUST | **Unverified propagation**: an 08 property with basis `typical` / unsourced, or an uncalibrated inherent strain, flags every result. | AF-32 | AF-32 |
| FR-PRC-17 | MUST | **Review flag**: every result `reviewRequired: true` with the "not approved" sentence; release of a compensation table or a compensated flat pattern goes through 09 PLM approval (human gate). | AF-33/34 | AF-33, AF-34 |
| FR-PRC-18 | MUST | Every capability is a registry command reachable from CLI, MCP and UI; results deterministic. | L1/L5, AF-13 | L1 |

## 6. Workflows

### 6.1 CLI

```bash
llull search springback compensation overhang
# 1. single bend, no part needed
llull springback_calc 'inputs={"thickness_mm":1.6,"insideRadius_mm":4.8,"angle_deg":90,"E":{"value":72000,"unit":"MPa","source":"…"},"yield":{"value":300,"unit":"MPa","source":"…"},"stressState":"uniaxial"}' --json
# 2. all bends of a 07 sheet-metal part (bend table read through flat_pattern)
llull springback_compensation id=$part 'material={"recordId":"aa2024_t3_sheet","yieldProperty":"Fty"}' stressState=plane_strain nu=0.33 --doc bracket.llull.json --json
llull check_process id=$part --doc bracket.llull.json --json            # validity, min radius (07), unverified inputs
# 3. AM (V1)
llull run plans/prc_am_layered_beam.plan.json --doc am.llull.json --kernel occt --json
llull fea_mesh analysisId=$an --doc am.llull.json --json && llull fea_solve analysisId=$an --progress --timeout 3600 --doc am.llull.json --json
llull process_report analysisId=$an --doc am.llull.json --json          # curvature / deflection per layer and after release
llull check_am_overhang id=$part buildDirection='[0,0,1]' 'threshold={"downskinDeg":45,"source":"owner: machine vendor rule"}' --doc am.llull.json --json
```

Reports (AF-36): what was computed, the compensation / distortion values, every unverified input, what needs review, the
"not approved" sentence.

### 6.2 MCP

Same tools (toolset `analysis` for FE, `manufacturing` for the sheet queries, see TECHNICAL_SPEC §7). Analytic queries work
on every host.

### 6.3 Desktop UI (review only)

07 bend table with extra columns (formed radius, tool radius, tool angle, overbend, flags); AM distortion overlay per
layer (05 overlay); overhang colour map built on `check_am_overhang` data; 09 approval dialog for release.

### 6.4 Error and edge behaviour

| Situation | Behaviour | FR |
| --------- | --------- | -- |
| R_i ≥ E T/(2Y) | `PRC_BEND_ELASTIC`: no plastic forming; R_f = ∞ (flat after release) | FR-PRC-01 |
| Yield stress missing or not sourced | `PRC_MATERIAL_INPUT_MISSING` (no default) | FR-PRC-15 |
| 07 part without bends / not a sheet part | `PRC_NO_BENDS` | FR-PRC-03 |
| Inherent strain not calibrated | AM run allowed only with explicit values; result `unverified` + `PRC_INHERENT_STRAIN_UNCALIBRATED` | FR-PRC-10, 16 |
| Layer height smaller than the mesh size in build direction | `PRC_LAYER_MESH_MISMATCH` (layers would be empty) | FR-PRC-14 |
| Overhang threshold absent | `PRC_OVERHANG_THRESHOLD_UNSET`, angle bands still returned | FR-PRC-11 |

## 7. Acceptance criteria

| # | Given | When | Then | VC |
| - | ----- | ---- | ---- | -- |
| AC-1 | T 1.6 mm, R_i 4.8 mm, 90°, E 72 GPa, Y 300 MPa (test inputs), uniaxial | `springback_calc` | R_f = 4.98697250834 mm, θ_f = 87.0921711264°, R_i/R_f equal to 4u³ − 3u + 1 at u = 0.0125 | VC-PRC-10 |
| AC-2 | same, plane strain, ν 0.33 | `springback_calc` | R_f = 4.99260081439 mm | VC-PRC-10.c |
| AC-3 | R_i = 192 mm | `springback_calc` | `PRC_BEND_ELASTIC` | VC-PRC-10.d |
| AC-4 | target R_f 4.8 mm, θ_f 90° | `springback_compensation` | tool R_i = 4.62653839002 mm, tool angle 92.8768883175° | VC-PRC-20 |
| AC-5 | 07 bracket with a bend below the radius-table minimum | `check_process` | `FTR_BEND_RADIUS_BELOW_MIN` relayed, status fail | VC-PRC-50 |
| AC-6 | `plans/prc_am_layered_beam.plan.json` (V1) | run, mesh, solve, `process_report` | curvature after 10 layers within 3 % of −9.20109483135e-4 1/mm; after plate removal within 3 % of the generator | VC-PRC-30 |
| AC-7 | overhang test part, threshold unset | `check_am_overhang` | bands returned (45° / 30° / 0° faces), `PRC_OVERHANG_THRESHOLD_UNSET` | VC-PRC-52, 54 |
| AC-8 | any result | all queries | `reviewRequired: true`, "not approved" | VC-PRC-53 |

## 8. Standards & regulatory alignment

| Reference | Use | Status |
| --------- | --- | ------ |
| Aerospace 07 FTR bend conventions [R2] | Bend angle = angle bent through; bend ids; radius table | Internal spec |
| ISO/ASTM 52911-1 (DfAM, L-PBF metals) [R6] | Cited as the context for overhang rules; no clause content used | Catalogue only (paywalled), not fetched |
| NIST AM-Bench [R5] | Benchmark data source | Search extract; data release not read |
| CalculiX manual [R1] | `*MODEL CHANGE`, `*EXPANSION`, `*INITIAL CONDITIONS` | Read at a pinned commit |

llull claims no process qualification. Compensation tables are "computed, not approved" until released through 09 PLM.

## 9. KPIs / success metrics

| KPI | Target | How measured |
| --- | ------ | ------------ |
| Analytic correctness | 100 % of VC-PRC-10/20/30 analytic cases at 1e-9 | unit tests |
| Silent inputs | 0 results using an unsourced Y, E, inherent strain or threshold without `unverified` | VC-PRC-51, 52 |
| Agent completion | US-1 unattended in ≥ 9 of 10 scripted runs | agent driver |
| FE agreement | FE springback within 5 % of the plane-strain closed form on the pure-bending strip | VC-PRC-11 |

## 10. Risks & assumptions

| Risk / assumption | Impact | Mitigation |
| ----------------- | ------ | ---------- |
| Elastic-perfectly plastic theory ignores hardening, Bauschinger effect, thinning and the neutral-axis shift | Under-predicts springback of hardening alloys | Validity flags; FE route (V1); hardening analytic (V2) |
| Air bending is not pure bending (three-point loading, local curvature varies) | Angle error | Analytic labelled "pure bending"; FE with tools (V1); shop trial confirms |
| Inherent strain must be calibrated per machine / material / parameters | Uncalibrated predictions are wrong | No default; calibration helper; `unverified` |
| AM-Bench values only from search extracts | Benchmark not yet a gate | Grade B; read the data release (open question) |
| Material yield values for tempers (e.g. 2024-T3) are licensed (MMPDS) | No shipped values | Taken from the user's 08 record; private library rules (08) |
| Assumption: PHY-05/06 deliver steps, contact and `*MODEL CHANGE` sections | Dependency | V1 only |

## 11. References

- [R1] CalculiX User's Manual (`*MODEL CHANGE`, `*EXPANSION`, `*INITIAL CONDITIONS`, `*CONTACT PAIR`) — G. Dhondt, GPL-2.0 — https://github.com/Dhondtguido/CalculiX/tree/fd588701edd6a92fde06e99b1bdf01f3b0f80f2c (accessed 2026-10, git)
- [R2] Aerospace 07 FTR, sheet-metal and machined features — this repo — `docs/aerospace/07-sheet-metal-machined-features/`
- [R3] F. J. Gardiner, "The Springback of Metals", Trans. ASME 79 (1957) 1–9 (venue also cited as Trans. ASM) — citation via search only; formula re-derived in the generator
- [R4] Modified inherent strain method for L-PBF (A. To group; OSU seminar abstract) — https://mae.osu.edu/events/2021/03/modified-inherent-strain-method-predicting-residual-distortion-and-stress-laser (accessed 2026-10, search); self-supporting design with inherent strain, arXiv 2208.14246 — https://arxiv.org/abs/2208.14246 (search)
- [R5] NIST AM-Bench 2018, AMB2018-01 post-process part deflection — NIST — https://www.nist.gov/node/1339701 (accessed 2026-10, search); AM-Bench metadata repository https://github.com/usnistgov/ambench (commit 77adb06c6de95b9b97e1dd26d46561f29db927af, git)
- [R6] ISO/ASTM 52911-1 Additive manufacturing — Design — Part 1: Laser-based powder bed fusion of metals — ISO — https://www.iso.org/search.html?q=52911-1 (catalogue search link; page not fetched, standard number from secondary knowledge — verify)
