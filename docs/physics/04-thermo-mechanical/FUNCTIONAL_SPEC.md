# PHY-04: Thermo-mechanical coupling & thermal fits — functional specification

Gap id **TMC** · status: specification · written 2026-10-15 · technical spec: [`TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md)
· validation: [`validation/README.md`](validation/README.md) · sources: [`validation/sources.md`](validation/sources.md)
· gap list: [`../README.md`](../README.md) row PHY-04 · depends on [`../03-thermal-analysis/`](../03-thermal-analysis/FUNCTIONAL_SPEC.md)

## 1. Summary

After the aerospace packs and PHY-03, llull computes stresses for mechanical loads (05 FEA) and temperatures for thermal
loads (PHY-03), and its material records carry a coefficient of thermal expansion `cte` with temperature tables (08 MAT).
Nothing joins them: a temperature change produces no strain in an analysis, a part heated unevenly shows no distortion,
and an assembly fit is checked only at its drawing temperature. 03 GDT stores fits as code text with explicit limits and
a worst-case / RSS / Monte-Carlo stack-up — at one temperature only.

Mixed-material joints are where this hurts. An aluminium housing with a steel shaft, a titanium fitting on a CFRP skin or
a steel bolt in an aluminium lug change their clearance by tens of micrometres between −55 °C and +85 °C: a sliding fit can
seize, an interference fit can come loose, and thermal stresses in a restrained part can exceed those of the mechanical
loads. The validation pack shows it on a plain 20 mm H7/g6 fit: 7–41 µm clearance at 20 °C becomes a possible −10 µm
interference at −55 °C with an aluminium housing (VC-TMC-06.a).

This gap adds: (1) a **sequential thermo-mechanical** analysis type (`thermo_static`) that takes its temperature field
from a PHY-03 result, a uniform value, an analytic expression or an imported table and solves the thermal strain in
CalculiX; (2) a **coupled** type (`coupled_temperature_displacement`, V1) using CalculiX's coupled procedure; (3) **thermal
distortion as data** (displacements, face flatness change, relative motion of datums); (4) a read-only **`fit_at_temperature`**
query that turns 03 GDT fit limits and 08 CTE data into clearance or interference at any temperature, with interference
pressure for shrink fits; and (5) analytic thermal-stress checks, all with explicit reference temperatures and human gates.

## 2. Aerospace context & value

| Context | Today (who / which tools) | What llull adds | Source |
| ------- | ------------------------- | --------------- | ------ |
| Thermal stress in FE | CalculiX reads temperatures into a static step (`*TEMPERATURE`, also from an `.frd` file) and solves coupled thermo-mechanics (`*COUPLED TEMPERATURE-DISPLACEMENT`) | Both paths driven from the llull analysis model, with the PHY-03 result referenced by hash | [R7] |
| Verification | NAFEMS LE11 (thermal load on a solid of revolution, σzz = −105 MPa at A) is published by Abaqus, OptiStruct and reproduced by FeenoX (−105.041 MPa) | LE11 in the quality gate, plus NAFEMS T1 (hot disc) and closed-form cases | [R1], [R2], [R3] |
| Bimetal and mismatch | Timoshenko's 1925 bimetal curvature is the classical reference for layered mismatch | Analytic check and FE case for layered parts | [R4] |
| Fits and tolerances | 03 GDT: fits as code text with explicit limits, stack-ups at one temperature; ISO 286 tables are not shipped | Fit clearance at temperature from the same PMI limits and 08 CTE data, with the derivation in `data` | 03 GDT, [R5], [R6] |
| Composites | 06 CMP: hygrothermal CTE/CME loads are V2 | PHY-04 consumes laminate CTE later; it does not redefine it | 06 CMP |

**Value statements** (sourced only): NAFEMS LE11 and T1 are reproduced by independent codes [R1]–[R3], so an agent can
prove llull's thermal-strain chain before trusting it. The fit check reuses PMI limits already in the document (03 GDT), so
no tolerance is retyped. No programme ROI is claimed.

## 3. Personas & user stories

| Role | Who | Uses | Main need |
| ---- | --- | ---- | --------- |
| **Operator (primary)** | AI agent via the `llull` CLI (or MCP) | `llull fit_at_temperature --json`, `llull run`, `llull fea_solve`, `llull thermal_distortion_report --json` | Clearances and stresses as numbers with the formula and inputs, stable codes |
| **Owner** | Asks "will this shaft still turn at −55 °C?" — **not assumed to be an engineer** | Natural language | A yes/no with the numbers behind it and what needs an engineer |
| **Qualified reviewer** | Stress / design engineer, signatory | Desktop review (fit table, distortion plot, margins), INP deck | Approves fits that bind or loosen at the extremes, thermal-stress margins |

User stories:

- **US-TMC-1 (owner → operator).** "Does the 20 mm H7/g6 shaft still turn in the aluminium housing from −55 to +85 °C?"
  The agent reads both PMI size dimensions, calls `fit_at_temperature` with the spec temperature and the range, and reports
  the minimum clearance per temperature, the status (`interference_possible` at −55 °C), the CTEs used with their sources,
  and "needs a qualified engineer".
- **US-TMC-2 (operator).** A bracket heated on one side: the agent solves PHY-03 steady temperatures, creates a
  `thermo_static` case that references that result, runs it, and reports max von Mises and the margins (05) for the thermal
  load case, with the load-case category set explicitly.
- **US-TMC-3 (operator).** An optical bench must stay flat: `thermal_distortion_report` returns the out-of-plane deviation of
  the mounting face before and after the thermal load, compared with the 03 flatness tolerance on that face.
- **US-TMC-4 (operator).** For a shrink-fitted bush the agent asks `fit_at_temperature` for the interference pressure at the
  hot extreme and learns the joint is loose (`TMC_FIT_LOOSE`).
- **US-TMC-5 (reviewer).** A fit that binds at −55 °C cannot be accepted by the agent; the reviewer dispositions it with a
  signature (`dispose_fit_result`, human gate).

## 4. Scope / out of scope

| Phase | In scope |
| ----- | -------- |
| **MVP** | `thermo_static` analysis type: temperature field from a PHY-03 result (same mesh), uniform, analytic expression in x, y, z, or an imported nodal table; explicit stress-free reference temperature; isotropic CTE (constant or temperature table) with explicit secant/instantaneous basis; combined thermal + mechanical loads in one static step; results through 05 (stresses, displacements, margins) plus thermal strain. `fit_at_temperature` (clearance / interference at temperatures, from PMI limits or explicit limits, per-part temperatures). `thermal_stress_check` analytic checks. `thermal_distortion_report`. Validation: LE11, T1, restrained bar, thick cylinder (sequential), fits. |
| **V1** | `coupled_temperature_displacement` (CalculiX coupled procedure, steady or transient). Temperature mapping between different thermal and mechanical meshes (interpolation with a mapping-error report). Orthotropic CTE (`TYPE=ORTHO`, from 06 laminates when 06 V2 exists). Shrink-fit pressure and hub hoop stress inside `fit_at_temperature`. Fit stack-ups at temperature (03 `analyze_stackup` contributors with CTE). Bimetal / layered parts FE once 05 supports bonded multi-part meshes. |
| **V2** | Thermal-plastic (NAFEMS-style three-bar, code_aster SSNL111) with PHY-05. Transient thermal stress histories with many time points (fatigue input to PHY-07). Hygrothermal (moisture) strains with 06 V2 / PHY-14. |
| **Out of scope** | Thermal buckling eigenvalue (could come with 05 buckling later), creep relaxation of preloads (PHY-11), contact opening with friction (PHY-06), certification sign-off. |

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-TMC-01 | MUST | **Sequential thermo-mechanical analysis** `thermo_static`: a static case whose loads include a temperature field; thermal strain ε_th from the part CTE and the reference temperature; solved by the bundled CalculiX. | Thermal stress is the main missing load | [R7] |
| FR-TMC-02 | MUST | **Temperature field sources**: (a) a solved PHY-03 case (`heat_steady` result, or a `heat_transient` time point) referenced by results hash; (b) uniform; (c) analytic expression of x, y, z with stated units; (d) imported nodal table (CSV) with units. | Real workflows mix computed and prescribed fields; LE11 prescribes an expression | [R3], PHY-03 FR-THM-18 |
| FR-TMC-03 | MUST | **Reference (stress-free) temperature** is explicit per case (no default); the result names it. | A wrong reference shifts every thermal stress | AF-31 |
| FR-TMC-04 | MUST | **Material CTE** comes from the 08 record / PHY-01 model; its **basis** (secant from a stated reference, or instantaneous) must be known; llull converts to the secant form CalculiX expects and reports the conversion. Missing CTE or unknown basis refuses the solve. | CalculiX α is secant w.r.t. `ZERO` | [R7], 08 MAT |
| FR-TMC-05 | SHOULD | **Layered / mismatched parts**: parts of different CTE bonded together give mismatch stresses and curvature; analytic bimetal check always; FE when 05 provides bonded multi-part meshes (V1). | Bimetals, bonded inserts, CFRP/metal | [R4] |
| FR-TMC-06 | MUST | **Thermal stress results** reuse 05: max von Mises and components with location, probes, margins (`compute_margins`) for a load case whose category (`limit` / `ultimate`) is set explicitly for the thermal case. | No silent factor on thermal loads | 05 FR-FEA-18, AF-31 |
| FR-TMC-07 | MUST | **`fit_at_temperature`** (read-only): for a hole/shaft pair (03 PMI size dimensions or explicit limits), each part's CTE and temperature(s), return per temperature the limit diameters, minimum and maximum clearance (negative = interference), status (`clearance`, `interference`, `interference_possible`, `clearance_possible`), the intended fit class derived from the limits at the spec temperature, the formula and inputs. | "Does it still fit at −55 °C?" | 03 GDT, [R5] |
| FR-TMC-08 | MUST | **Thermal distortion as data** (AF-21): `thermal_distortion_report` returns displacement extremes, per named face the out-of-plane deviation from the best-fit plane (before/after), relative displacement between named points or datum features, and the comparison with any 03 flatness / profile tolerance on that face (`reviewRequired`). | Optical benches, sealing faces | AF-21, 03 GDT |
| FR-TMC-09 | MUST | **CTE conversions are explicit**: instantaneous → secant integration, re-referencing to another temperature, temperature-table sampling for PHY-01 fitted models; each conversion recorded in `data.provenance`. | Handbook CTEs are often instantaneous | [R7] |
| FR-TMC-10 | SHOULD (V1) | **Shrink / press fits at temperature**: interference pressure (Lamé, solid or hollow shaft in a hub of given outer diameter) and hub bore hoop stress at each temperature; `TMC_FIT_LOOSE` when interference is lost. | Bushings, bearings | [R9] |
| FR-TMC-11 | MUST | **Named defaults** (AF-31): reference temperature, spec temperature of a fit and load-case category are never defaulted; physical constants and tolerances that are defaulted carry source and `defaulted: true`. | No silent safety value | AF-31 |
| FR-TMC-12 | MUST | **Readiness check and codes** (AF-11, AF-20): `check_thermo_mechanical` returns pass / warn / fail items with the codes of TECHNICAL_SPEC §7.1 (field source, staleness, mesh match, CTE presence and basis, reference temperature, ranges). | Agents act on codes | AF-11, AF-20 |
| FR-TMC-13 | MUST | **Review and gates** (AF-32–34): `unverified` CTE/E/ν propagates to stresses, fit rows and distortion; every fit row and margin row carries `reviewRequired: true`; accepting a binding or loose fit, or a negative thermal margin, needs a human signature (`dispose_fit_result`; 05 `dispose_margin`). | Approval acts | AF-32, AF-33, AF-34 |
| FR-TMC-14 | MUST | **Staleness chain**: a thermo-mechanical result is stale when its referenced thermal result, the CTE data, the reference temperature or the geometry changes; a fit result is recomputed on every call (query). | Results match the revision | 05 FR-FEA-22, PHY-03 FR-THM-18 |
| FR-TMC-15 | SHOULD (V1) | **Coupled analysis** `coupled_temperature_displacement` (CalculiX `*COUPLED TEMPERATURE-DISPLACEMENT`, steady or transient) combining PHY-03 thermal BCs and 05 mechanical BCs in one case. CalculiX couples through boundary-condition updates; the displacement-to-temperature effect is limited to radiation. | Deformation-dependent radiation, transient thermal stress | [R7] |
| FR-TMC-16 | SHOULD (V1) | **Mesh mapping** of temperatures from a thermal mesh to a different mechanical mesh, with a reported interpolation error (max difference at shared points, nodes outside the source mesh). MVP requires the same mesh. | Thermal and stress meshes often differ | — |
| FR-TMC-17 | SHOULD | **Analytic checks** `thermal_stress_check`: restrained bar / plate / block, hot circular inclusion, bimetal, thick cylinder with radial gradient, through-thickness gradient (curvature, bow), shrink-fit pressure, secant CTE. | Hand-check FE results | [R4], [R9] |
| FR-TMC-18 | MUST | **Validation suite** (LE11, T1, restrained bar, thick cylinder, fits, CTE conversions) runs in CI through PHY-00. | Credibility | [R1]–[R3] |
| FR-TMC-19 | MUST | Every capability is a registry command reachable from CLI, MCP and UI; one `build_project` plan holds the full set-up. | L1/L5, AF-01, AF-05 | L1 |

## 6. Workflows

### 6.1 CLI (operator, primary)

```bash
llull search fit temperature thermal stress
llull describe fit_at_temperature set_temperature_field thermal_distortion_report

# A. fit check (no FE): PMI limits from 03 GDT + 08 CTE
llull run housing.plan.json --doc h.llull.json --kernel occt --json                 # parts, records, PMI ($bore, $pin)
llull fit_at_temperature holePmiId=$bore shaftPmiId=$pin 'specTemperature={"value":20,"unit":"degC"}' \
  'temperatures=[{"value":-55,"unit":"degC"},{"value":85,"unit":"degC"}]' --doc h.llull.json --json

# B. sequential thermal -> stress
llull run bracket.plan.json --doc b.llull.json --kernel occt --json                 # heat_steady $th + thermo_static $ms
llull fea_mesh analysisId=$th --doc b.llull.json --json && llull fea_solve analysisId=$th --doc b.llull.json --json
llull fea_mesh analysisId=$ms --doc b.llull.json --json                             # same controls -> same meshHash
llull check_thermo_mechanical analysisId=$ms --doc b.llull.json --json
llull fea_solve analysisId=$ms --doc b.llull.json --json
llull compute_margins analysisId=$ms --doc b.llull.json --json                      # 05 margins, category explicit
llull thermal_distortion_report analysisId=$ms 'faces=[{"name":"mount","target":{…}}]' --doc b.llull.json --json
llull thermal_stress_check check=thick_cylinder 'inputs={"a_mm":10,"b_mm":20,"dT_K":100,"E_MPa":200000,"nu":0.3,"alpha_per_K":1.2e-5}' --json
```

The agent ends a thermo-mechanical job with `check_thermo_mechanical` and `compute_margins`, a fit job with the fit rows,
and reports (AF-36): what was checked, the worst clearance / margin and where, the reference temperatures and CTEs with
their sources, every `unverified` input, and "computed by llull, not approved — needs a qualified engineer".

### 6.2 MCP

Same commands in toolset `analysis`. `fit_at_temperature` and `thermal_stress_check` need no solver and work on every host.

### 6.3 Desktop UI (review only)

Fit table per temperature with status badges; deformed shape (scaled) with the thermal load; flatness change of named
faces; margins table; disposition dialogs (human gate).

### 6.4 Surface matrix

| Capability | CLI | MCP | UI |
| ---------- | --- | --- | -- |
| Fit at temperature | `llull fit_at_temperature --json` | same | table |
| Thermal stress set-up | `llull run`, `llull set_temperature_field` | same | tree |
| Solve | 05 transports | when hosted | progress |
| Distortion | `llull thermal_distortion_report --json` | same | deformed view |
| Disposition | prepare only (`TMC_HUMAN_GATE`) | prepare only | **complete** |

### 6.5 Error and edge behaviour

| Situation | Behaviour | FR |
| --------- | --------- | -- |
| Referenced thermal result is stale or missing | `TMC_THERMAL_RESULT_STALE` / `FEA_RESULTS_MISSING`; solve refused | FR-TMC-14 |
| Thermal and mechanical meshes differ, mapping not allowed | `TMC_MESH_MISMATCH` (MVP) | FR-TMC-16 |
| Part without CTE | `TMC_MATERIAL_NO_CTE` | FR-TMC-04 |
| CTE basis unknown | `TMC_CTE_BASIS_UNKNOWN` (the agent must state secant/instantaneous) | FR-TMC-04, 09 |
| Temperature outside a CTE table range | `TMC_PROPERTY_OUT_OF_RANGE`, no extrapolation | FR-TMC-07 |
| Size dimension without limits / not a fit pair | `TMC_FIT_LIMITS_MISSING` / `TMC_FIT_NOT_A_PAIR` | FR-TMC-07 |
| A clearance fit can interfere at a temperature | row `interference_possible`, `TMC_FIT_INTERFERENCE` | FR-TMC-07, 13 |
| An interference fit loses interference | row `clearance_possible`, `TMC_FIT_LOOSE` | FR-TMC-10, 13 |

### 6.6 Glossary

| Term | Meaning |
| ---- | ------- |
| Reference (stress-free) temperature | Temperature at which the part has no thermal strain |
| Secant (mean) CTE | α_sec(T) = (L(T) − L(T_ref)) / (L(T_ref)(T − T_ref)); what CalculiX `*EXPANSION` expects with `ZERO` = T_ref [R7] |
| Instantaneous CTE | α_inst(T) = (1/L) dL/dT; secant = average of instantaneous over [T_ref, T] |
| Spec temperature | Temperature at which the drawing / PMI limits apply |
| Clearance | Hole diameter − shaft diameter; negative = interference |

## 7. Acceptance criteria

`D` = `--doc case.llull.json --kernel occt --json`. Values: `validation/expected_results.json`.

| # | Given | When (CLI) | Then (JSON) | VC |
| - | ----- | ---------- | ----------- | -- |
| AC-1 | `plans/tmc_nafems_le11.plan.json` | run, `fea_mesh`, `fea_solve`, `fea_report` | probe `A` σzz within 3 % of −105 MPa | VC-TMC-02 |
| AC-2 | `plans/tmc_restrained_bar.plan.json` | same | probe `mid` σxx within 0.5 % of −252 MPa | VC-TMC-01 |
| AC-3 | `plans/tmc_thick_cylinder_sequential.plan.json` | solve `$th`, then `$ms` | hoop stress at bore −209.82 MPa and outer 133.03 MPa within 2 % | VC-TMC-05 |
| AC-4 | `plans/tmc_fit_al_steel.plan.json` | the plan's `fit_at_temperature` step | rows: −55 °C min clearance −0.0102560 mm `interference_possible` + `TMC_FIT_INTERFERENCE`; 20 °C 0.007/0.041 mm; +85 °C max 0.0559963 mm; every row `reviewRequired: true` | VC-TMC-06, 62 |
| AC-5 | `thermal_stress_check` with the VC-TMC-03/04/07/08/09 inputs | one call each | equal to the generator to the stated tolerance; `formula`, `inputs` in `data` | VC-TMC-03, 04, 07, 08, 09 |
| AC-6 | `thermo_static` without `referenceTemperature`; `fit_at_temperature` without `specTemperature` | the call | exit 1, `TMC_REFERENCE_TEMPERATURE_MISSING` / `TMC_SPEC_TEMPERATURE_MISSING` | VC-TMC-60 |
| AC-7 | solved AC-3, then change the bore temperature of `$th` | `fea_report analysisId=$ms D` | `state: "stale"`; `compute_margins` exits 1 with `FEA_RESULTS_STALE` | VC-TMC-50 |
| AC-8 | the deliberately wrong set-ups of VC-TMC-61 | each call | documented code, remediation, ids | VC-TMC-61 |
| AC-9 | an `interference_possible` row | agent calls `dispose_fit_result … D` | exit 1, `TMC_HUMAN_GATE`, doc unchanged | VC-TMC-63 |

## 8. Standards & regulatory alignment

| Reference | Use | Status |
| --------- | --- | ------ |
| NAFEMS TNSB Rev. 3 (LE11) | verification target | paid; values via [R1]–[R3] |
| ISO 286-1/-2 (limits and fits) [R6] | fit limits come from PMI; no table shipped | catalogue only |
| ISO 1 (standard reference temperature) [R11] | spec temperature must be explicit; a default is an open question | catalogue only; value not seen |
| CalculiX conventions [R7] | `*EXPANSION`, `*TEMPERATURE`, coupled procedures | verified at a pinned commit |

## 9. KPIs / success metrics

| KPI | Target | How measured |
| --- | ------ | ------------ |
| Benchmarks passing | 100 % of numeric VC-TMC within tolerance | `quality:thermal` via PHY-00 |
| Fit correctness | `fit_at_temperature` equals the generator to 1e-9 mm | unit tests (VC-TMC-06) |
| Silent defaults | 0 reference / spec temperatures or load categories defaulted | VC-TMC-60 |
| Agent usability | US-TMC-1 answered unattended in ≥ 9 of 10 runs | agent driver |

## 10. Risks & assumptions

| Risk / assumption | Impact | Mitigation |
| ----------------- | ------ | ---------- |
| Secant vs instantaneous CTE confusion | Thermal strains wrong by the curvature of α(T) | Basis mandatory; conversions explicit and tested (VC-TMC-07) |
| Thermal and mechanical meshes differ | Wrong temperatures at nodes | MVP same mesh; V1 mapping with error report |
| Fit check ignores elastic deformation of thin parts and temperature gradients inside a part | Optimistic answer | Per-part temperature only; result says "uniform temperature per part"; FE path for gradients |
| Thermal load category and factors are programme-specific | Wrong margins | Category explicit; no default factor on thermal loads |
| CalculiX coupled procedure limited (BC-update coupling) | Some couplings not represented | Documented in the result provenance; coupled is V1 |

## 11. References

- [R1] Abaqus Benchmarks Guide LE11 — https://abaqus-docs.mit.edu/2017/English/SIMACAEBMKRefMap/simabmk-c-le11.htm (accessed 2026-10, search)
- [R2] Altair OptiStruct OS-V:0070 — https://help.altair.com/hwsolvers/os/topics/solvers/os/nafems_test_problem_le11_r.htm (accessed 2026-10, search)
- [R3] FeenoX LE11 and T1 — https://github.com/seamplex/feenox/tree/3759eb2426a9e9a77ab8a9ce97db93071a389776 (accessed 2026-10)
- [R4] Timoshenko, Analysis of bi-metal thermostats, JOSA 11 (1925) 233 — https://doi.org/10.1364/JOSA.11.000233 (accessed 2026-10, search)
- [R5] ISO 286 fit values (secondary) — https://www.roymech.co.uk/Useful_Tables/ISO_Tolerances/how-to-use-iso-tolerances/ (accessed 2026-10, search)
- [R6] ISO 286-1/-2 — ISO catalogue (accessed 2026-10, catalogue)
- [R7] CalculiX — https://github.com/Dhondtguido/CalculiX/tree/fd588701edd6a92fde06e99b1bdf01f3b0f80f2c (accessed 2026-10)
- [R8] Cast3M LE11 — http://www-cast3m.cea.fr/html/CasTestsCastem/node9.html (gap-list extract)
- [R9] Classical thermoelasticity (Timoshenko & Goodier) — derivations in `validation/generate_thermomech_reference.py`
- [R10] code_aster SSNL111 — https://gitlab.com/codeaster/src (commit 94bf28a308de5a77587675a598aacdddb722f84e) (accessed 2026-10)
- [R11] ISO 1:2022 — https://www.evs.ee/en/iso-1-2022 (accessed 2026-10, catalogue)
- llull: `docs/aerospace/03-gdt-mbd-pmi/TECHNICAL_SPEC.md`, `docs/aerospace/05-fea-cae-handoff/TECHNICAL_SPEC.md`,
  `docs/aerospace/08-materials-standards-libraries/TECHNICAL_SPEC.md`, `docs/physics/03-thermal-analysis/TECHNICAL_SPEC.md`
