# Gap 11 FLD — Fluid dynamics and rocket propulsion: functional specification

Status: written 2026-10-18; MVP implemented on the same branch (TECHNICAL_SPEC §13). Template:
[`../TEMPLATE.md`](../TEMPLATE.md). Operator model: [`../AGENT_FIRST.md`](../AGENT_FIRST.md).

## 1. Summary

A space-engine designer needs to know three things. What thrust and specific impulse does this chamber pressure,
propellant and nozzle give, in vacuum and at sea level? Does the nozzle over-expand and separate on the pad? What
does the nozzle wall look like and how much does it weigh? The same gas-dynamics relations size supersonic
inlets, wind tunnels and pitot corrections. llull had none of them: its only fluid tool is incompressible pipe
flow.

This gap adds:

- the classical one-dimensional compressible-flow toolbox of NACA Report 1135: isentropic flow, normal and oblique
  shocks, Prandtl–Meyer, Fanno and Rayleigh;
- an ideal rocket thrust-chamber performance model;
- a nozzle contour generator (conical or Rao parabolic bell) that creates the wall as a CAD solid;
- the rocket equation.

Thermochemistry (combustion temperature, γ, molar mass) is an **input** taken from NASA CEA. Equilibrium
chemistry is not re-implemented.

## 2. Context and value

| Who                                    | Today                                                           | With llull                                                                                                             |
| -------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Student / NewSpace small launcher team | NASA CEA + RPA + spreadsheets, then a CAD revolve drawn by hand | CEA chamber state → `nozzle_performance` → `design_nozzle` (solid) → `mass_properties` → `rocket_delta_v`, in one plan |
| Propulsion engineer (concept)          | Sutton & Biblarz relations in scripts; Rao charts read by hand  | the same relations with every assumption and source in `data`; chart angles from the digitised Huzel & Huang curve     |
| Wind tunnel / inlet design             | NACA 1135 tables                                                | `compressible_flow` with inverses (A/A\* → M, ν → M, θ → β)                                                            |

## 3. Personas and user stories

- **Operator: a CLI agent.** "Size a 100 kN LOX/RP-1 vacuum engine at 70 bar, give me Isp, throat and exit
  diameters and the nozzle wall solid in mm" (FR-FLD-02..05).
- **Owner: a non-engineer founder.** They want "Isp 335 s in vacuum, 290 s at sea level, the sea-level nozzle
  would separate", in plain words, with what is ideal and what is real.
- **Qualified reviewer: a propulsion engineer.** Any number used for a qualification test plan or a flight
  decision needs their sign-off. The ideal model is a concept-level tool, and its results say "ideal (no losses)".

## 4. Scope

| Phase           | Content                                                                                                                                                                                                                                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **MVP (built)** | isentropic, normal / oblique shock, Prandtl-Meyer, Fanno, Rayleigh (any γ); ideal rocket c\*, C_F, Isp (vacuum / ambient / altitude), sizing by thrust or throat; conical divergence λ; Summerfield separation warning; nozzle wall solid (conical / 80 % Rao bell with chart angles, or any bell with given angles); Tsiolkovsky Δv and burn time  |
| V1              | Kinetic / boundary-layer / two-phase loss factors with sourced correlations; method of characteristics (MOC) minimum-length and TOP contours; regenerative-cooling channel geometry and a Bartz heat-flux estimate; CEA hand-off (bundled NASA `cea` Python package as a host transport, like CalculiX) so the chamber state is computed, not typed |
| V2              | Nozzle flow, separation and plume CFD through [12 CFD](../12-cfd-gpu/FUNCTIONAL_SPEC.md) (local GPU Euler, V2 there); trajectory integration with drag (uses 10 AER)                                                                                                                                                                                                              |
| Out of scope    | Built-in chemical equilibrium, combustion instability, turbomachinery, solid-motor grain regression                                                                                                                                                                                                                                                 |

## 5. Functional requirements

| Id        | Priority | Requirement                                                                                                                                                                                                                              | Source                                  |
| --------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| FR-FLD-01 | MUST     | Compressible relations for any 1 < γ < 2, with inverses: isentropic from M, A/A\* (subsonic / supersonic branch), p/p0, T/T0 or ν; normal shock; oblique shock from θ (weak / strong, detachment detected) or β; Fanno; Rayleigh         | NACA Report 1135 [R1]                   |
| FR-FLD-02 | MUST     | Ideal rocket performance from p_c, T_c, γ, molar mass and ε or p_e: c\*, exit M / p / T / v, C_F and Isp in vacuum and at an ambient pressure or an altitude (standard atmosphere, 10 AER)                                               | Sutton & Biblarz [R2], NASA SP-125 [R3] |
| FR-FLD-03 | MUST     | Sizing: throat area or diameter, or a thrust target in vacuum or at ambient → mass flow, thrust, exit diameter                                                                                                                           | [R2]                                    |
| FR-FLD-04 | MUST     | Losses: conical divergence factor λ = (1 + cos α)/2, a given divergence factor, a c\* efficiency; never applied silently (defaulted flags)                                                                                               | [R2], [R6]                              |
| FR-FLD-05 | MUST     | Warn on over-expansion and on likely flow separation (Summerfield p_e < 0.4 p_a); name the optimum expansion ratio for the ambient                                                                                                       | [R7]                                    |
| FR-FLD-06 | MUST     | Nozzle wall as a CAD solid of revolution: chamber, conical convergent, Rao throat arcs (1.5 R_t / 0.382 R_t), conical or parabolic bell (length fraction of the 15° cone, θn / θe), wall thickness; lengths, radii and contour in `data` | Rao [R4], Huzel & Huang [R3]            |
| FR-FLD-07 | MUST     | Rocket equation Δv, mass ratio, burn time; inverse propellant mass for a Δv                                                                                                                                                              | Tsiolkovsky                             |
| FR-FLD-08 | MUST     | Stable `FLD_*` refusal codes, provenance (formulas + sources) and named defaults in every result                                                                                                                                         | AF-11, AF-31, AF-35                     |
| FR-FLD-09 | SHOULD   | CEA hand-off for the chamber state                                                                                                                                                                                                       | V1                                      |
| FR-FLD-10 | SHOULD   | MOC contour; regen cooling and Bartz heat flux                                                                                                                                                                                           | V1                                      |
| FR-FLD-11 | COULD    | Nozzle / plume CFD via 12 CFD                                                                                                                                                                                                                | V2                                      |

## 6. Workflows

```json
[
  {
    "command": "nozzle_performance",
    "params": {
      "chamberPressure": 70,
      "pressureUnit": "bar",
      "chamberTemperatureK": 3558.34,
      "gamma": 1.1507,
      "molarMass": 22.186,
      "expansionRatio": 16,
      "altitudeM": 0,
      "thrustN": 1000000
    }
  },
  { "command": "design_nozzle", "params": { "throatRadius": 100, "expansionRatio": 16, "wallThickness": 6 }, "as": "nozzle" },
  { "command": "mass_properties", "params": { "entityId": "$nozzle" } },
  { "command": "rocket_delta_v", "params": { "ispS": 330, "initialMassKg": 30000, "propellantMassKg": 24000, "thrustN": 1000000 } }
]
```

The chamber state comes from a NASA CEA run: the official NASA `cea` Python package (`pip install cea`), or CEA
online. MCP exposes the toolset `fluids`. In the UI the commands appear in the palette group "Fluids /
propulsion", and the nozzle solid is shown in the viewport.

## 7. Acceptance criteria

| Given                                                                     | When                                       | Then                                                                                                                | VC            |
| ------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------- |
| NACA 1135 table rows (13 cases, γ 1.4)                                    | `compressible_flow`                        | ratios within 5e-4, angles within 0.01°                                                                             | VC-FLD-01..05 |
| NASA CEA chamber states (RP-1311 Ex. 8, LOX/LH2 206 bar, LOX/RP-1 70 bar) | `nozzle_performance`                       | c\* within 0.5 %, throat T within 1.5 %, Isp (vac and sea level) within 3 % of shifting equilibrium                 | VC-FLD-10/11  |
| RS-25 published 452.3 s                                                   | same with the CEA state at 2994 psia, ε 69 | ideal ≥ published, ≤ +6 %; separation warning at sea level                                                          | VC-FLD-13     |
| SP-125 A-1 (ε 14, 1000 psia, 14.696 psi)                                  | `nozzle_performance`                       | C_F,vac − C_F,SL = 0.206 (book 1.768 − 1.562) within 1e-3                                                           | VC-FLD-14     |
| λ = (1 + cos 15°)/2                                                       | conical                                    | 0.98296                                                                                                             | VC-FLD-21     |
| an 80 % bell, ε 25                                                        | `design_nozzle`                            | (R_e/R_t)² = 25, length 0.8 L15, θn within 0.2° and θe within 0.05° of the chart, wall volume = Pappus within 0.2 % | VC-FLD-20/22  |
| Δv closed form                                                            | `rocket_delta_v`                           | exact                                                                                                               | VC-FLD-30     |

## 8. Standards and regulation

None claimed. NASA SP-125 and SP-8120 are design guides, not standards. Export control: a nozzle contour of a
real engine can be ITAR / EAR controlled. llull's export marking (08 MAT `set_export_marking`) applies to the
document, as for any other part.

## 9. KPIs

- Every VC automated (unit tests + scenarios).
- A complete engine concept (performance + nozzle solid + mass + Δv) in one 4-step plan.

## 10. Risks and assumptions

- **One constant γ.** With CEA's chamber γ and molar mass, c\* is exact to 0.02 % and Isp is within about 3 % of
  shifting equilibrium. A frozen-composition expansion gives 4–6 % less. Real engines deliver less again: RS-25
  delivers 452.3 s, while this ideal model gives about 473 s for its chamber state.
- **Rao angles** are a digitised chart (±0.5°), covering only the 80 % bell for ε 5–50. Outside that range the
  agent must give θn and θe.
- **Summerfield 0.4** is a rough rule. Other tests report separation at 0.5–0.8 of ambient (NASA TM X-64890).
- **No heat transfer**: wall thickness is geometry only. Thermal and stress sizing go through 05 FEA / PHY-03.

## 11. References

- [R1] Ames Research Staff, Equations, tables, and charts for compressible flow — NACA Report 1135, 1953 — https://ntrs.nasa.gov/citations/19930091059.
- [R2] Sutton G. P., Biblarz O., Rocket Propulsion Elements, Wiley, ch. 3 (book; the relations are standard).
- [R3] Huzel D. K., Huang D. H., Design of Liquid Propellant Rocket Engines — NASA SP-125, 2nd ed., 1971 — https://ntrs.nasa.gov/citations/19710019929.
- [R4] Rao G. V. R., Exhaust nozzle contour for optimum thrust — Jet Propulsion 28(6):377-382, 1958.
- [R5] Gordon S., McBride B. J., Computer Program for Calculation of Complex Chemical Equilibrium Compositions and Applications — NASA RP-1311, 1994/1996 — https://ntrs.nasa.gov/citations/19950013764; NASA `cea` Python package 3.3.4 — https://pypi.org/project/cea/.
- [R6] Malina F. J., Characteristics of the rocket motor unit based on the theory of perfect gases — J. Franklin Inst. 230:433, 1940 (divergence factor); NASA NTRS 19980227347 conical nozzle tests.
- [R7] Summerfield M., Foster C. R., Swan W. C., Flow separation in overexpanded supersonic exhaust nozzles — Jet Propulsion 24:319, 1954; NASA TP-1207 (https://ntrs.nasa.gov/citations/19780022611).
- [R8] NASA SP-8120, Liquid Rocket Engine Nozzles, 1976 — https://ntrs.nasa.gov/citations/19770009165.
- [R9] L3Harris, RS-25 engine — https://www.l3harris.com/all-capabilities/rs-25-engine.
