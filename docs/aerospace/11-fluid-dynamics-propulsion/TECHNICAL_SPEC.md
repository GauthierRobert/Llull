# Gap 11 FLD — Fluid dynamics and rocket propulsion: technical specification

Companion of [FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md). Laws: `.claude/rules/architecture.md`.

## 1. Current state (before this gap)

- Fluid code: only `pipe_hydraulics` (incompressible Darcy-Weisbach, `packages/domain-aec/src/industrial/piping/`).
- `revolve_profile` (core, `commands/solids/profile.ts`) builds a solid of revolution from an [r, z] polygon.
  Its own description already mentions bell nozzles. `design_nozzle` composes it.
- Mass, volume and inertia of any solid come from `mass_properties` (01 / 08 resolver).

## 2. Target architecture

- A new plugin **`fluids`** in `packages/domain-aero/src/fluids/` with toolset `fluids`. It is installed by
  `src/app/plugins.ts`, and `@mcp/toolsets` gets a `fluids` getter.
- Pure maths: `isentropic.ts`, `shocks.ts`, `ductFlow.ts`, `rocketNozzle.ts` and `nozzleContour.ts`. There are
  four commands. `design_nozzle` is the only mutating one, and it composes `revolve_profile` through `execute`
  (L10).
- The ambient pressure for an altitude comes from the 10 AER air state (`../aerodynamics/airState`), which is in
  the same package.
- No kernel and no host process are needed. The V1 CEA hand-off would be a server transport (as `fea_solve` is),
  never a plugin import (L6).

## 3. Data model

There is no new document data. The nozzle is a standard `revolution` entity. Its contour is returned in `data`;
it is not stored. If the design must be editable as a recipe, the `design_nozzle` step stays in the feature
history (L8), so editing its params regenerates the solid.

## 4. Commands (toolset `fluids`)

| Name | Kind | Params | data | Codes |
| ---- | ---- | ------ | ---- | ----- |
| `compressible_flow` | query | `relation isentropic\|normal_shock\|oblique_shock\|fanno\|rayleigh`, `gamma`, `mach` \| `areaRatio`+`branch` \| `pressureRatio` \| `temperatureRatio` \| `prandtlMeyerDeg`, `deflectionDeg`+`branch` \| `waveAngleDeg` | `result` (all ratios, M2, β, θmax, ν, μ, 4fL*/D, …), provenance | `FLD_PARAM_INVALID`, `FLD_INPUT_CONFLICT`, `FLD_MACH_RANGE`, `FLD_SHOCK_DETACHED` |
| `nozzle_performance` | query | `chamberPressure`, `pressureUnit` (required), `chamberTemperatureK`, `gamma`, `molarMass`, `expansionRatio` \| `exitPressure`, `divergence ideal\|conical\|factor` (+`halfAngleDeg` / `divergenceFactor`), `cStarEfficiency`, `ambientPressure` \| `altitudeM`, `throatDiameterM` \| `throatAreaM2` \| `thrustN`+`thrustAt` | c*, exit {M, p, T, v}, throat {T, p}, C_F {vac, amb}, Isp {vac, amb}, c, optimum ε, expansion state, sizing {D_t, D_e, ṁ, F}, warnings, provenance | `FLD_PARAM_INVALID`, `FLD_INPUT_CONFLICT`, `FLD_EXPANSION_INVALID` |
| `design_nozzle` | mutating (composes `revolve_profile`) | `throatRadius`, `expansionRatio`, `contractionRatio`, `chamberLength`, `convergentHalfAngleDeg`, `shape conical\|bell`, `halfAngleDeg`, `lengthFraction`, `entranceAngleDeg`, `exitAngleDeg`, `wallThickness`, `position`, `segments`, `includeContour` | id, R_e, R_c, (R_e/R_t)², convergent / divergent / total length, L15, exit angle, contour (opt.), defaulted | `FLD_PARAM_INVALID`, `FLD_CONTOUR_INVALID` |
| `rocket_delta_v` | query | `ispS`, `initialMassKg`, `propellantMassKg` \| `finalMassKg` \| `targetDeltaVMS`, `thrustN` | Δv, mass ratio, c, m_p, m_f, ṁ, burn time, T/W | `FLD_PARAM_INVALID`, `FLD_INPUT_CONFLICT` |

Pressure units are `Pa`, `kPa`, `MPa`, `bar`, `atm` and `psi`. The unit is required, never inferred (AF-04).

## 5. Algorithms

### 5.1 Compressible flow (TR-FLD-01)

These are the NACA 1135 closed forms for a calorically perfect gas.

**Isentropic flow:**

- T0/T = 1 + (γ−1)M²/2
- p/p0 = (T/T0)^(γ/(γ−1))
- A/A* = (1/M)[(2/(γ+1))(1 + (γ−1)M²/2)]^((γ+1)/(2(γ−1)))
- ν = √((γ+1)/(γ−1)) atan √((γ−1)(M²−1)/(γ+1)) − atan √(M²−1)

The p/p0 and T/T0 inverses are closed form. The A/A* and ν inverses use bisection (200 steps) on the monotone
branch.

**Normal shock:**

- M2² = (1 + (γ−1)M1²/2)/(γM1² − (γ−1)/2)
- p2/p1 = 1 + 2γ(M1²−1)/(γ+1)
- ρ2/ρ1 = (γ+1)M1²/((γ−1)M1² + 2)
- p02/p01 = (ρ2/ρ1)^(γ/(γ−1)) (p1/p2)^(1/(γ−1))

**Oblique shock:** tan θ = 2 cot β (M² sin²β − 1)/(M²(γ + cos 2β) + 2).

- β at θmax is found by a golden-section search on (μ, π/2).
- β for a given θ is found by bisection on (μ, β_max) for the weak branch, or on (β_max, π/2) for the strong one.
- θ > θmax means a detached shock: `FLD_SHOCK_DETACHED`.
- M2 = M_n2 / sin(β − θ).

**Fanno:**

- 4f̄L*/D = (1 − M²)/(γM²) + ((γ+1)/(2γ)) ln((γ+1)M²/(2 + (γ−1)M²))
- p/p*, T/T*, p0/p0* and V/V* follow from the same relations.

**Rayleigh:**

- p/p* = (1+γ)/(1+γM²)
- T0/T0* = 2(γ+1)M²(1 + (γ−1)M²/2)/(1+γM²)²

### 5.2 Ideal rocket (TR-FLD-02..05)

The chamber is at stagnation (infinite-area combustor), the flow is 1D isentropic with constant γ and M, and the
throat is sonic. R = R_u/M, with R_u = 8314.462618 J/(kmol·K).

- Γ = √γ (2/(γ+1))^((γ+1)/(2(γ−1)))
- c* = η_c* √(R T_c)/Γ
- M_e comes from ε (supersonic branch); p_e = p_c (p/p0)(M_e)
- C_F,vac = λ Γ √(2γ/(γ−1) (1 − (p_e/p_c)^((γ−1)/γ))) + ε p_e/p_c
- C_F = C_F,vac − ε p_a/p_c
- F = C_F p_c A_t
- ṁ = p_c A_t / c*
- Isp = F/(ṁ g0) = c* C_F/g0, with g0 = 9.80665
- v_e = c* × (momentum part of C_F)
- Optimum ε: the value with p_e = p_a
- Conical divergence: λ = (1 + cos α)/2

Warnings:

- p_e < 0.4 p_a: likely separation (Summerfield).
- p_e < p_a: over-expanded.
- Ambient defaulted to vacuum: named.
- One-γ limitation: always stated.

### 5.3 Nozzle contour (TR-FLD-06)

The throat is at axial 0 and the flow goes to +axial.

- **Upstream:** a cylinder of radius R_t √ε_c (length `chamberLength`), then a cone at the convergent half-angle
  into the upstream throat arc of radius 1.5 R_t.
- **Downstream:** an arc of radius 0.382 R_t up to the initial wall angle (θn for a bell, α for a cone).
- **Conical divergent:** a straight line at α until R_e = R_t √ε.
- **Bell divergent:** a quadratic Bézier from the arc end N (tangent θn) to the exit E (L_n, R_e) (tangent θe).
  - Its control point is the intersection of the two tangents. It must lie between N and E, otherwise
    `FLD_CONTOUR_INVALID`.
  - L_n = f × L15, with L15 = (R_t(√ε − 1) + R_d(sec 15° − 1))/tan 15°.
  - θn and θe default to the Huzel & Huang 80 % chart (Fig. 4-16, digitised in rocketisp 0.1.13), interpolated
    linearly and only for f = 0.8 and ε 5–50. Elsewhere the agent must give them.
- **Wall:** the inner points are offset along the outward normal (cos φ, −sin φ) by t. The wall thickness must
  satisfy t < 0.382 R_t, so the offset of the concave throat arc does not self-intersect.
- **Solid:** the closed [r, z] polygon (inner forward, outer back) goes to `revolve_profile` about +z at
  `position`, with 96 segments by default.

### 5.4 Rocket equation (TR-FLD-07)

- Δv = Isp g0 ln(m0/m_f)
- ṁ = F/(Isp g0)
- t_b = m_p/ṁ
- Inverse: m_f = m0 e^(−Δv/(Isp g0))

## 6. Interop

The nozzle solid exports like any solid (STL, glTF, STEP through `export_step` / `export_step_exact` on OCC).
Through `revolve_profile` it keeps an exact revolution recipe on the OCC kernel. No new file format. V1: a CEA
input deck (`.inp`) writer and output parser in the server transport.

## 7. Error codes

| Code | Meaning |
| ---- | ------- |
| FLD_PARAM_INVALID | value outside its documented range |
| FLD_INPUT_CONFLICT | alternative inputs both given or both missing |
| FLD_MACH_RANGE | Mach outside the relation's domain (e.g. a shock with M ≤ 1) |
| FLD_SHOCK_DETACHED | θ above θmax for M |
| FLD_EXPANSION_INVALID | ε ≤ 1 or p_e ≥ p_throat |
| FLD_CONTOUR_INVALID | the contour cannot close (contraction too small for the arcs, bell angles do not fit) |

## 8. Performance

All queries take under 5 ms (bisection with 200 steps). `design_nozzle` takes under 50 ms plus the revolution
tessellation. Results are deterministic.

## 9. Test strategy

| VC | Test |
| -- | ---- |
| VC-FLD-01..05 | `tests/unit/aero/fluids/compressible.test.ts` (13 table rows + inverses + refusals) |
| VC-FLD-10..15 | `tests/unit/aero/fluids/nozzle.test.ts` (CEA RP-1311 Ex. 8, two CEA engine cases, RS-25, SP-125 A-1 identity, λ, sizing, refusals) |
| VC-FLD-20..22 | `tests/unit/aero/fluids/designNozzle.test.ts` (bell ε 25, chart lookup, conical + Pappus volume, explicit angles, refusals, purity) |
| VC-FLD-30 | same file, `rocket_delta_v` |
| SC-FLD-01..03 | `tests/unit/aero/scenarioPlans.test.ts` |

## 10. Delivery plan

| Milestone | Content | State |
| --------- | ------- | ----- |
| M1 | compressible relations, ideal nozzle, contour solid, Δv | **done 2026-10-18** |
| M2 | CEA hand-off: server transport `cea_equilibrium` running the bundled NASA `cea` Python package (Apache-2.0, PyPI) in the desktop's CPython; chamber state + frozen / equilibrium Isp as data | ≈ 2 eng-weeks |
| M3 | Method of characteristics (minimum-length and Rao TOP), loss correlations (kinetic, boundary layer) from SP-8120 with sources | ≈ 4 eng-weeks |
| M4 | Regenerative cooling: channel geometry on the wall solid, Bartz h_g, coolant ΔT / Δp (reuses pipe_hydraulics friction), hand-off to PHY-03 thermal | ≈ 4 eng-weeks |
| M5 | Nozzle / plume CFD hand-off (SU2 / OpenFOAM) | ≈ 6 eng-weeks |

## 11. Open questions

1. Should CEA run in the desktop's bundled CPython? That needs licence review: Apache-2.0 is compatible.
2. Should γ vary along the nozzle (a two-γ or frozen-table model) before M2, to close the 4–6 % gap to CEA frozen?
3. Is there a public source for the 60 / 70 / 90 / 100 % Rao curves? rocketisp ships them, but only the 80 % curve
   is cross-checked.

## 12. References

See FUNCTIONAL_SPEC §11 and [validation/sources.md](validation/sources.md).

## 13. Implementation status (2026-10-18)

M1 is built:

- Plugin `fluidsPlugin` with 4 commands (`compressible_flow`, `nozzle_performance`, `design_nozzle`,
  `rocket_delta_v`), toolset `fluids`, palette group "Fluids / propulsion".
- Every VC of `validation/README.md` passes in `tests/unit/aero/fluids/*.test.ts` and in the scenario runner.
