# Gap 10 AER — Aerodynamics: technical specification

Companion of [FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md). Laws: `.claude/rules/architecture.md` (L1–L10).

## 1. Current state in llull (before this gap)

- No atmosphere, airfoil, wing or drag code. The only fluid code is `pipe_hydraulics`
  (`packages/domain-aec/src/industrial/piping/`): Darcy-Weisbach plus Colebrook, for liquids only.
- NACA ordinates exist only as a validation generator of 02 SRF
  (`docs/aerospace/02-advanced-surfacing/validation/generate_naca.py`, checked against UIUC files to 1e-7 c).
  There is no command for them.
- Solids can be triangulated in world space (`@core/geometry/entityTriangles`), and document units convert to
  metres (`@core/model/units`). Both are reused here.

## 2. Target architecture

- A new plugin **`aerodynamics`** in `packages/domain-aero/src/aerodynamics/` (decision AERO3: one `domain-aero`
  package, one `CadPlugin` per discipline) with MCP toolset `aerodynamics`. It is installed by
  `src/app/plugins.ts`, and its commands are listed by the `aerodynamics` getter in `packages/mcp/src/toolsets.ts`.
- Pure maths lives in the plugin: no React, DOM or network (L2). The commands are read-only queries (L1), except
  `draw_naca_airfoil`, which composes `draw_polyline` through `execute` (L10).
- No kernel is needed (L9). The frontal area works on display triangles, so it works on both kernels.
- The atmosphere, air state, speed units and result helpers live in `domain-aero/src/shared/`, which both
  plugins import. Neither plugin imports the other's modules.

```
packages/domain-aero/src/shared/        used by both plugins (10 AER, 11 FLD)
  atmosphere.ts          US 1976 layers, Sutherland, geopotential conversion
  airState.ts            altitude | density -> ρ, μ, a, p; ISA offset floor
  speed.ts               speed + unit -> m/s
  results.ts             `sig` (data at 10 significant digits), `briefReport` (summary at 6)
packages/domain-aero/src/aerodynamics/
  naca.ts                NACA 4-digit + 230-series ordinates, camber slope
  panelMethod.ts         linear-vortex panels (one factorisation for all angles), thin-airfoil integrals
  airfoilContour.ts      NACA / polyline -> clockwise panel nodes (open-TE detection, 801-point cap)
  liftingLine.ts         Glauert series, wing area
  projectedArea.ts       silhouette rasterisation, wetted area
  geometryArea.ts        entity ids + flowParams -> metres -> projected area (one validation for 3 commands)
  skinFriction.ts        Cf correlations + validity ranges
  cycling.ts             Martin 1998, Bassett 1999 formulas
  cyclingParams.ts       one schema for both models; cyclingMartin.ts / cyclingBassett.ts runners; cyclingCommand.ts dispatches
  *Command.ts, airfoilCommands.ts, dragCommands.ts, catalog.ts, plugin.ts, codes.ts
```

## 3. Data model

No new document data. All commands are queries, and `draw_naca_airfoil` creates a standard `polyline` entity, so
the document version and migrations are unchanged. A future persistent "aero model" (wing definition with
sections, a polar cache) would be a plugin `DocumentExtension`. It is not needed for the MVP.

## 4. Commands (toolset `aerodynamics`)

| Name                  | Kind                                | Params (sketch)                                                                                                                                                                                                                                                                   | data                                                                                              | Failure codes                                                                                      |
| --------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `standard_atmosphere` | query                               | `altitude`, `altitudeUnit m\|ft\|km`, `altitudeType geometric\|geopotential`, `temperatureOffsetK`, `speed`+`speedUnit`, `referenceLengthM`                                                                                                                                       | T, p, ρ, a, μ, ν, g, ratios, flow {Mach, q, EAS, Re}, provenance                                  | `AER_ALTITUDE_OUT_OF_RANGE`, `AER_PARAM_INVALID`                                                   |
| `draw_naca_airfoil`   | mutating (composes `draw_polyline`) | `naca`, `chord`, `pointsPerSide`, `closedTrailingEdge`, `incidenceDeg`, `position`                                                                                                                                                                                                | — (1 polyline)                                                                                    | `AER_AIRFOIL_INVALID`, `AER_PARAM_INVALID`                                                         |
| `analyze_airfoil`     | query                               | `naca` \| `entityId`, `alphasDeg[]`, `panelsPerSide`, `momentReference`, `includeSurface`                                                                                                                                                                                         | polar [{α, cl, clCirculation, cm, cdPressure}], liftSlope, zeroLiftAngle, thinAirfoil, surface Cp | `AER_AIRFOIL_SOURCE_CONFLICT`, `AER_AIRFOIL_INVALID`, `AER_PARAM_INVALID`, `AER_SOLVER_FAILED`     |
| `analyze_wing`        | query                               | `span`, `rootChord`, `tipChord`, `planform`, `twistDeg`, `naca` \| `sectionLiftSlopePerRad`+`zeroLiftAngleDeg`, `alphasDeg[]`, `terms`, speed + air state                                                                                                                         | geometry {S, AR, λ, c̄}, polar [{CL, CDi, e, lift N, Di N}], CL*α, Helmbold CL*α, stations         | `AER_PARAM_INVALID`, `AER_AIRFOIL_INVALID`, `AER_SOLVER_FAILED`, air-state codes                   |
| `frontal_area`        | query                               | `entityIds[]`, `flowDirection`, `resolution`                                                                                                                                                                                                                                      | frontal m² ± uncertainty, wetted m², length m, extents                                            | `AER_ENTITY_NOT_FOUND`, `AER_NO_GEOMETRY`, `AER_PARAM_INVALID`                                     |
| `aero_drag`           | query                               | speed, `cdA` \| `cd`+`referenceAreaM2` \| `cd`+`entityIds`, `frictionModel`+`wettedAreaM2`+`lengthM`, air state                                                                                                                                                                   | drag N, power W, q, Mach, Re, friction {Cf, N}, warnings                                          | `AER_AREA_SOURCE_CONFLICT`, `AER_PARAM_INVALID`, geometry and air-state codes                      |
| `cycling_power`       | query                               | `model martin_1998\|bassett_1999`, `speed` \| `powerW`; martin: `massKg`, `cdA` \| `cd`+`entityIds`, `crr`, `gradePercent`, `headwindMS`, `wheelAreaM2`, `chainEfficiency`, `bearingLosses`; bassett: `riderHeightM`, `riderMassKg`, `bikeMassKg`, `k1` \| factors, `trackFactor` | speed, power, breakdown, 1 h distance, inputs with `defaulted`                                    | `AER_SPEED_SOURCE_CONFLICT`, `AER_AREA_SOURCE_CONFLICT`, `AER_NO_EQUILIBRIUM`, `AER_PARAM_INVALID` |

Every command carries `@affects / @invariant / @failure` tags in its source (C2).

## 5. Algorithms

### 5.1 Standard atmosphere (TR-AER-01)

The seven geopotential layers of the 1976 standard, with these constants: base heights 0, 11, 20, 32, 47, 51,
71 km′; lapse rates −6.5, 0, +1, +2.8, 0, −2.8, −2.0 K/km′; T0 288.15 K; p0 101 325 Pa; g0 9.80665;
R* 8314.32 J/(kmol·K); M0 28.9644; r0 6 356 766 m. Each base pressure is integrated once at module load:
p = pb (Tb/T)^(g0 M0/(R* L)) in a gradient layer, and pb exp(−g0 M0 ΔH/(R\* Tb)) in an isothermal one.

Derived properties:

- Speed of sound: a = √(γ R T), γ = 1.4.
- Viscosity (Sutherland): μ = 1.458e-6 T^1.5/(T + 110.4).
- Gravity: g = g0 (r0/(r0+Z))².
- Geopotential altitude: H = r0 Z/(r0 + Z).

ISA+ΔT adds ΔT to T at the standard pressure. Above 80 km the value returned is the molecular-scale temperature,
which is what the PDAS table prints.

### 5.2 NACA sections (TR-AER-02)

The equations are those of Report 824:

- Thickness: yt = 5t(0.2969√x − 0.1260x − 0.3516x² + 0.2843x³ − a4 x⁴), with a4 = 0.1015 (open TE) or
  0.1036 (closed TE).
- 4-digit camber: two parabolas joined at p.
- 230 camber: the cubic with m = 0.2025 and k1 = 15.957.

Surfaces are offset normal to the mean line. Stations use cosine spacing, and the points are listed in Selig
order. Only the 230 mean line has a verified (m, k1). The 210/220/240/250 lines are refused rather than built
from unverified constants.

### 5.3 Panel method (TR-AER-03)

This is the linear-strength vortex method of Kuethe & Chow (program VORTEX). For m panels:

- The m+1 node strengths γ'_j = γ_j/(2πV∞) solve m normal-flow conditions plus the Kutta condition
  γ'\_1 + γ'_{m+1} = 0.
- The influence coefficients C_n1, C_n2, C_t1 and C_t2 are the closed forms of the reference.
- Cp = 1 − (V_t/V∞)².

Outputs:

- cl comes from integrating the pressure (normal force rotated by α).
- clCirculation = 2Γ/(V∞c) is reported as a convergence check.
- The pressure drag must tend to 0 (d'Alembert), so it is also a check.

Contours come in two ways. A NACA contour is built directly, clockwise from the lower trailing edge. A polyline is
made clockwise, and an open trailing-edge base is detected as a segment with |dy| > 2|dx| and length < 5 % chord
behind the rearmost point. That base is left out of the panels.

Thin-airfoil theory integrates the camber slope in θ (4000 midpoints):

- α_L0 = −(1/π)∫(dz/dx)(cos θ − 1)dθ
- A_n = (2/π)∫(dz/dx) cos nθ dθ
- cm_c/4 = (π/4)(A2 − A1)

### 5.4 Lifting line (TR-AER-04)

The equation solved is Σ A_n sin nθ (sin θ + n μ) = μ (α + ε(η) − α_L0) sin θ, with μ = c(η) a0/(4b), using the
odd terms only (symmetric loading). There are N collocation points θ_k = kπ/(2N), k = 1..N, so the root is at
θ = π/2.

Results:

- CL = π AR A1
- CDi = π AR Σ n A_n²
- e = CL²/(π AR CDi)
- Local cl = 4b Σ A_n sin nθ / c

The wing area is exact for an elliptical planform (πbc0/4) and Simpson-integrated otherwise. Helmbold's
low-aspect-ratio slope is returned for comparison. A warning is raised for AR < 4.

### 5.5 Frontal and wetted area (TR-AER-05)

1. The world triangles (instances expanded) are scaled to metres.
2. They are projected on the plane normal to the flow, using an orthonormal basis (u, v).
3. The projections are rasterised on a grid with `resolution` cells along the larger extent; a cell is filled when
   its centre lies in any triangle (barycentric test), which gives a union, so overlaps count once.
4. Area = filled cells × cell². Uncertainty = ½ × boundary cells × cell².
5. The wetted area is the exact sum of the triangle areas of the display mesh.

### 5.6 Drag and skin friction (TR-AER-06)

D = ½ρV²·CdA. With a friction model, D_f = Cf(Re_L)·q·S_wet is added. The correlations and their validity ranges:

- Blasius 1.328/√Re, laminar, 1e3..5e5
- 0.074/Re^0.2, 5e5..1e7
- Prandtl-Schlichting 0.455/(log Re)^2.58, 5e5..1e9
- ITTC-1957 0.075/(log Re − 2)², 1e5..1e10

A warning is raised outside these ranges, and also above Mach 0.3.

### 5.7 Cycling (TR-AER-07)

**Martin 1998, steady state:**

P = [½ρ(CdA + Fw)V_A|V_A|V_G + V_G Crr m g cos(atan G) + V_G(91 + 8.7V_G)e-3 + V_G m g sin(atan G)] / E_c

- V_A = V_G + headwind. The sign-preserving square handles a tailwind faster than the rider.
- Defaults are named and flagged: Fw 0.0044 m², Crr 0.0032, E_c 0.976.
- Inverse: the speed is found by a downward scan from 40 m/s, then bisection on the first bracket (the largest
  root, which matters for descents).

**Bassett 1999, eq. 8:**

P = K(0.00953 M_t V + 0.00775 V² + K1 A_f 0.007551 V³), with V in km/h.

- A_f = 0.0293 H^0.725 M^0.425 + 0.0604
- M_t = M + 10 kg
- K1 = Kd·Kpo·Kb·Kc·Kh
- Kd comes from the paper's polytropic atmosphere: n = 1.235, R = 287.1, T1 = 288 K, g = 9.807.

## 6. Interop and persistence

No new file format. Plans in `validation/plans/*.json` are standard `build_project` actions. A Cp / polar CSV
export and the XFOIL / OpenFOAM hand-off are V1 / V2 items (§10).

## 7. Surfaces and error codes

The CLI (`llull <command> '{…}' --json`), MCP (toolset `aerodynamics`) and the UI command palette (group
"Aerodynamics") all expose the same commands. The stable codes are listed below. Their remediation strings are in
`codes.ts`.

| Code                                   | Meaning                                               |
| -------------------------------------- | ----------------------------------------------------- |
| AER_PARAM_INVALID                      | a value outside its documented range                  |
| AER_ALTITUDE_OUT_OF_RANGE              | outside −5..86 km geometric                           |
| AER_AIR_STATE_CONFLICT                 | altitude and density both given                       |
| AER_AIRFOIL_INVALID                    | unsupported NACA designation or not a closed polyline |
| AER_AIRFOIL_SOURCE_CONFLICT            | both or neither of naca / entityId                    |
| AER_ENTITY_NOT_FOUND / AER_NO_GEOMETRY | bad ids / only 2D entities                            |
| AER_SOLVER_FAILED                      | singular panel or lifting-line system                 |
| AER_AREA_SOURCE_CONFLICT               | ambiguous drag area                                   |
| AER_SPEED_SOURCE_CONFLICT              | both or neither of speed / power                      |
| AER_NO_EQUILIBRIUM                     | no steady speed ≤ 40 m/s for the power                |

## 8. Performance budgets

| Operation    | Size                            | Time            |
| ------------ | ------------------------------- | --------------- |
| panel solve  | 600 panels (dense LU)           | < 0.2 s         |
| lifting line | 40 terms                        | < 1 ms          |
| frontal area | 400 × 400 grid × ~10⁴ triangles | < 0.5 s         |
| frontal area | 2000 cells                      | grows as cells² |

The resolution is capped at 2000 cells. All commands are deterministic (AF-13).

## 9. Test strategy

| VC            | Test                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| VC-AER-01     | `tests/unit/aero/aerodynamics/atmosphere.test.ts` (45 PDAS rows)                                                                      |
| VC-AER-02..05 | `drag.test.ts` (box, sphere, union, drag, Cf check values)                                                                            |
| VC-AER-10..12 | `airfoil.test.ts` (Joukowski exact, NACA 2412, NACA 0012 vs Ladson / McCroskey, convergence, UIUC-validated ordinates)                |
| VC-AER-13     | `wing.test.ts` (elliptic exact, rectangular, taper, washout, forces)                                                                  |
| VC-AER-20..23 | `cycling.test.ts` (Bassett Table 7, Martin closed forms, Defraeye ranking)                                                            |
| SC-AER-01..05 | `tests/unit/aero/scenarioPlans.test.ts` runs every plan in `validation/plans/` through `build_project` and checks its `expected` rows |

The coverage gate on `packages/domain-aero/src/**` is 90/85/90/90 (CLAUDE.md).

## 10. Delivery plan

| Milestone | Content                                                                                                                                           | State                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| M1        | atmosphere, NACA, panel, lifting line, frontal area, drag, cycling (this spec)                                                                    | **done 2026-10-18**   |
| M2        | XFOIL hand-off: server transport `xfoil_polar` like `fea_solve`, bundled binary (GPL, decision 5), viscous polar as data                          | todo, ≈ 3 eng-weeks   |
| M3        | Vortex-lattice (horseshoe VLM) over a wing / tail definition read from lofts; neutral point; drag build-up tables with sources                    | todo, ≈ 4 eng-weeks   |
| M4        | CFD hand-off (OpenFOAM `simpleFoam` / SU2 case writer from a watertight body + farfield; forces and surface Cp import as 05-style result records) | todo, ≈ 6–8 eng-weeks |
| M5        | UI: Cp and span-loading plots in the Analysis tab (same pattern as `plot_simulation`)                                                             | todo                  |

## 11. Open questions

1. Licensing of a bundled XFOIL (GPL) on the desktop: same decision as Gmsh / CalculiX (decision 5).
2. Should `analyze_wing` read its planform from a `loft_sections` entity rather than from numbers? This needs
   the section-ring fix of 02 SRF (24-point resampling).
3. Should rider CdA presets (Defraeye 2010) be shipped as a sourced table? They are B-grade, and a choice for the
   owner. They are kept as documentation only for now.

## 12. References

See FUNCTIONAL_SPEC §11 and [validation/sources.md](validation/sources.md).

## 13. Implementation status (2026-10-18)

M1 is built and green:

- Plugin `aerodynamicsPlugin` with 7 commands (`standard_atmosphere`, `draw_naca_airfoil`, `analyze_airfoil`,
  `analyze_wing`, `frontal_area`, `aero_drag`, `cycling_power`), toolset `aerodynamics`, palette group.
- Tests: `tests/unit/aero/aerodynamics/*.test.ts` and `tests/unit/aero/scenarioPlans.test.ts`. Every VC listed in
  `validation/README.md` passes, against data pinned in `validation/data/`.

Known limits are listed in FUNCTIONAL_SPEC §10.
