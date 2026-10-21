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
  `airfoil_from_naca` (02 SRF) with `as: "polyline"`, which composes `draw_polyline` through `execute` (L10); the former `draw_naca_airfoil` is retired onto it.
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
  panelMethod.ts         linear-vortex panels (one influence build for all angles; LU reuse: TS follow-up, §2.1), thin-airfoil integrals
  airfoilContour.ts      NACA / polyline -> clockwise panel nodes (open-TE detection, 801-point cap)
  liftingLine.ts         Glauert series, wing area
  projectedArea.ts       silhouette rasterisation, wetted area
  geometryArea.ts        entity ids + flowParams -> metres -> projected area (one validation for 3 commands)
  skinFriction.ts        Cf correlations + validity ranges
  roadLoad.ts            road-load power (Martin 1998 terms, bicycle preset) and Bassett 1999 formulas
  roadLoadParams.ts      one schema for both models; roadLoadRun.ts / roadLoadBassett.ts runners; roadLoadCommand.ts dispatches
  *Command.ts, airfoilCommands.ts, dragCommands.ts, catalog.ts, plugin.ts, codes.ts
```

### 2.1 Stack amendment (RS1, 2026-10-18)

Decided by the owner in [RS1](../../decisions/RS1-native-compute.md) (programme step **RS-7**, medium row).

| Item | Before | Now |
| ---- | ------ | --- |
| 2D panel method (`panelMethod.ts`, M1) | TS | unchanged: stays TS (600 panels meet the §8 budget) |
| M3 vortex lattice and any future 3D panel method | TS (planned) | TS for small N; when N exceeds what TS handles (as built: 1000 panels, §14), the influence build and the dense LU run in `llull-compute panel <job-folder>` (crate `llull-panel`, faer), reached through a host transport in `server/` (job style, like 05 FEA `fea_solve`); the result returns as query `data` with provenance `{ tool: 'llull-compute panel', version, threads }` |
| Reference | — | the TS solver stays the small-case path and the test oracle (RS1 §2 rule 4); native vs TS: VC-AER-33 |
| Missing binary | — | `NATIVE_TOOL_MISSING` with an install hint; the TS path still runs up to its cap |

TS follow-up (small, not RS, RS1 §5): `panelMethod.ts` calls `solveLinear` twice on the same matrix (the α = 0 and
α = π/2 right-hand sides), so it factorises twice. Factorise once and reuse the LU for both right-hand sides, and store
the influence matrices in `Float64Array`. VC-AER-10..12 must stay green unchanged.

## 3. Data model

No new document data. All commands are queries, and `airfoil_from_naca` with `as: "polyline"` creates a standard `polyline` entity, so
the document version and migrations are unchanged. FR-AER-14 reads the 12 CFD document slice (`cfd.results`,
`model/cfd.ts`) read-only; it adds no data of its own. A future persistent "aero model" (wing definition with
sections, a polar cache) would be a plugin `DocumentExtension`. It is not needed for the MVP.

## 4. Commands (toolset `aerodynamics`)

| Name                  | Kind                                | Params (sketch)                                                                                                                                                                                                                                                                                                                            | data                                                                                              | Failure codes                                                                                      |
| --------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `standard_atmosphere` | query                               | `altitude`, `altitudeUnit m\|ft\|km`, `altitudeType geometric\|geopotential`, `temperatureOffsetK`, `speed`+`speedUnit`, `referenceLengthM`                                                                                                                                                                                                | T, p, ρ, a, μ, ν, g, ratios, flow {Mach, q, EAS, Re}, provenance                                  | `AER_ALTITUDE_OUT_OF_RANGE`, `AER_PARAM_INVALID`                                                   |
| `analyze_airfoil`     | query                               | `naca` \| `entityId`, `alphasDeg[]`, `panelsPerSide`, `momentReference`, `includeSurface`                                                                                                                                                                                                                                                  | polar [{α, cl, clCirculation, cm, cdPressure}], liftSlope, zeroLiftAngle, thinAirfoil, surface Cp | `AER_AIRFOIL_SOURCE_CONFLICT`, `AER_AIRFOIL_INVALID`, `AER_PARAM_INVALID`, `AER_SOLVER_FAILED`     |
| `analyze_wing`        | query                               | `span`, `rootChord`, `tipChord`, `planform`, `twistDeg`, `naca` \| `sectionLiftSlopePerRad`+`zeroLiftAngleDeg`, `alphasDeg[]`, `terms`, speed + air state                                                                                                                                                                                  | geometry {S, AR, λ, c̄}, polar [{CL, CDi, e, lift N, Di N}], CL*α, Helmbold CL*α, stations         | `AER_PARAM_INVALID`, `AER_AIRFOIL_INVALID`, `AER_SOLVER_FAILED`, air-state codes                   |
| `frontal_area`        | query                               | `entityIds[]`, `flowDirection`, `resolution`                                                                                                                                                                                                                                                                                               | frontal m² ± uncertainty, wetted m², length m, extents                                            | `AER_ENTITY_NOT_FOUND`, `AER_NO_GEOMETRY`, `AER_PARAM_INVALID`                                     |
| `compute_aero_drag`           | query                               | speed, `cdA` \| `cd`+`referenceAreaM2` \| `cd`+`entityIds`, `frictionModel`+`wettedAreaM2`+`lengthM`, air state                                                                                                                                                                                                                            | drag N, power W, q, Mach, Re, friction {Cf, N}, warnings                                          | `AER_AREA_SOURCE_CONFLICT`, `AER_PARAM_INVALID`, geometry and air-state codes                      |
| `road_load_power`     | query                               | `model road_load\|bassett_1999`, `speed` \| `powerW`; road_load: `vehicle generic\|bicycle`, `massKg`, `cdA` \| `cd`+`entityIds`, `crr` (required for generic), `gradePercent`, `headwindMS`, `wheelAreaM2`, `drivetrainEfficiency`, `bearingLosses`; bassett: `riderHeightM`, `riderMassKg`, `bikeMassKg`, `k1` \| factors, `trackFactor` | speed, power, breakdown, 1 h distance, inputs with `defaulted`                                    | `AER_SPEED_SOURCE_CONFLICT`, `AER_AREA_SOURCE_CONFLICT`, `AER_NO_EQUILIBRIUM`, `AER_PARAM_INVALID` |

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

### 5.7 Road load and track cycling (TR-AER-07)

**Road load (Martin 1998 terms), steady state.** One model for every road vehicle; the bicycle-only terms (Fw, bearings) are zero unless `vehicle: bicycle` or given:

P = [½ρ(CdA + Fw)V_A|V_A|V_G + V_G Crr m g cos(atan G) + V_G(91 + 8.7V_G)e-3 + V_G m g sin(atan G)] / E_c

- V_A = V_G + headwind. The sign-preserving square handles a tailwind faster than the rider.
- `vehicle: bicycle` defaults (named and flagged): Fw 0.0044 m², Crr 0.0032, bearings on, E_c 0.976. `vehicle: generic`: Fw 0, no bearings, η 1 (power at the wheels), and `crr` is required: there is no sourced default for an arbitrary vehicle.
- Inverse: the speed is found by a downward scan from 100 m/s, then bisection on the first bracket (the largest
  root, which matters for descents).

**Bassett 1999, eq. 8:**

P = K(0.00953 M_t V + 0.00775 V² + K1 A_f 0.007551 V³), with V in km/h.

- A_f = 0.0293 H^0.725 M^0.425 + 0.0604
- M_t = M + 10 kg
- K1 = Kd·Kpo·Kb·Kc·Kh
- Kd comes from the paper's polytropic atmosphere: n = 1.235, R = 287.1, T1 = 288 K, g = 9.807.

## 6. Interop and persistence

No new file format in the MVP. Plans in `validation/plans/*.json` are standard `build_project` actions. A Cp /
polar CSV export and the XFOIL hand-off are V1 items (§10).

**Link to 12 CFD (FR-AER-14).** `compute_aero_drag` and `road_load_power` get a third drag-area source, `cfdCaseId`,
mutually exclusive with `cdA` and `cd` + area (`AER_AREA_SOURCE_CONFLICT` as today). The command reads
`doc.cfd.results[caseId]`: it refuses `AER_CFD_RESULT_UNUSABLE` when the result is missing, stale (case or geometry
hash changed) or `converged: false`, and otherwise uses `forces.cdAM2`. The CFD free stream must match the requested
speed within 1 %, or the command warns that CdA is being reused at another Reynolds number. The result `provenance`
names the case, its `resultsHash`, solver and resolution, and an `unverified` CFD result stays `unverified`.

**External-solver export (FR-AER-13, V2).** A host transport `cfd_export_case` (12 CFD `server/src/cfd/`, local
files only) takes the surface and domain from `prepare_cfd_case`, so watertightness, patches and domain sizing are
checked once, by 12 CFD. It writes:

- OpenFOAM: `constant/triSurface/body.stl` (one solid per boundary tag), `system/blockMeshDict` (the farfield box),
  `system/snappyHexMeshDict`, `0/` fields from the free stream, `simpleFoam` (low speed) or `rhoCentralFoam`
  (compressible) controls;
- SU2: a Gmsh volume mesh (bundled Python Gmsh, as in 05 FEA) and a `.cfg` with the markers and free stream.

`cfd_import_external` reads the external forces and surface Cp (OpenFOAM `forces` function object and surface
sampling; SU2 `history.csv` and `surface_flow.csv`), stores them in the 12 CFD result store, and records them with
`record_cfd_results` and `solver: 'external'` in provenance. External solvers are never bundled or started by llull.

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
| AER_NO_EQUILIBRIUM                     | no steady speed ≤ 100 m/s for the power               |
| AER_CFD_RESULT_UNUSABLE (planned)      | the 12 CFD case has no result, or it is stale or not converged |

## 8. Performance budgets

| Operation    | Size                            | Time            |
| ------------ | ------------------------------- | --------------- |
| panel solve  | 600 panels (dense LU)           | < 0.2 s         |
| VLM / 3D panel (M3) | ≤ 1000 panels TS; 1000–20 000 `llull-compute panel` (§2.1) | TS 1000 panels 1.3 s; native 2400 / 5000 / 10 000 panels 2.4 / 4.4 / 23 s (§14) |
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
| VC-AER-20..23 | `roadLoad.test.ts` (Bassett Table 7, Martin closed forms, Defraeye ranking)                                                           |
| SC-AER-01..05 | `tests/unit/aero/scenarioPlans.test.ts` runs every plan in `validation/plans/` through `build_project` and checks its `expected` rows |
| VC-AER-30     | planned (M6): `cfdSource.test.ts` with a recorded 12 CFD result fixture (fresh, stale, not converged, speed mismatch)                  |
| VC-AER-31     | planned (M7): `compressibility.test.ts` (Prandtl-Glauert closed form) + a 12 CFD CLI scenario (Euler, extruded NACA 0012)             |
| VC-AER-32     | planned (M4): `server/tests/cfd/externalExport.test.ts` (case files parsed back; known-result import round trip)                      |
| VC-AER-33     | built (M3, RS-7): `llull-panel` `cargo test` (`npm run native:check`) + `server/tests/aeroPanelNative.test.ts` (native vs TS on the same lattice; skipped with a logged reason without the binary) |
| VC-AER-34..37 | built (M3): `vortexLattice.test.ts` (Bertin & Smith swept wing, elliptic wing vs lifting line, neutral point), `dragBuildup.test.ts` |

The coverage gate on `packages/domain-aero/src/**` is 90/85/90/90 (CLAUDE.md).

## 10. Delivery plan

| Milestone | Content                                                                                                                                           | State                 |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| M1        | atmosphere, NACA, panel, lifting line, frontal area, drag, cycling (this spec)                                                                    | **done 2026-10-18**   |
| M2        | XFOIL hand-off: server transport `xfoil_polar` like `fea_solve`, bundled binary (GPL, decision 5), viscous polar as data                          | todo, ≈ 3 eng-weeks   |
| M3        | Vortex-lattice (horseshoe VLM) over a wing / tail definition read from lofts; neutral point; drag build-up tables with sources. Large N: influence build + dense LU in `llull-compute panel` (crate `llull-panel`, faer, RS1 §2.1), VC-AER-33 | **done 2026-10-19** (§14) |
| M4        | External-solver export / import (`cfd_export_case`, `cfd_import_external`) on the case prepared by 12 CFD; the built-in solvers moved to [12 CFD](../12-cfd-gpu/TECHNICAL_SPEC.md) §10 | todo, ≈ 3 eng-weeks (after 12 CFD M1; was 6–8 before preparation was shared) |
| M5        | UI: Cp and span-loading plots in the Analysis tab (same pattern as `plot_simulation`)                                                             | todo                  |
| M6        | `cfdCaseId` drag-area source in `compute_aero_drag` / `road_load_power` (FR-AER-14), VC-AER-30                                                            | todo, ≈ 1 eng-week, after 12 CFD M2 |
| M7        | Prandtl-Glauert / Kármán-Tsien corrections and the cross-check against the 12 CFD Euler solver (FR-AER-15), VC-AER-31                             | todo, ≈ 1 eng-week, after 12 CFD M4 |

## 11. Open questions

1. Licensing of a bundled XFOIL (GPL) on the desktop: same decision as Gmsh / CalculiX (decision 5).
2. Should `analyze_wing` read its planform from a `loft_sections` entity rather than from numbers? This needs
   the section-ring fix of 02 SRF (24-point resampling).
3. Should rider CdA presets (Defraeye 2010) be shipped as a sourced table? They are B-grade, and a choice for the
   owner. They are kept as documentation only for now.
4. When the 12 CFD free stream and the `compute_aero_drag` speed differ, should CdA be reused with a warning (proposed) or
   refused? Reynolds effects on CdA are small for bluff bodies above the drag crisis but not for streamlined ones.
5. Is the external-solver export (M4) still wanted now that llull has its own solvers (12 CFD)? It serves users who
   already run OpenFOAM / SU2 locally and want a second opinion; it is COULD and can be dropped without affecting 12 CFD.

## 12. References

See FUNCTIONAL_SPEC §11 and [validation/sources.md](validation/sources.md). Stack: [RS1 native compute programme](../../decisions/RS1-native-compute.md) (owner decision 2026-10-18).

## 13. Implementation status (2026-10-18)

M1 is built and green:

- Plugin `aerodynamicsPlugin` with 6 commands (the NACA section drawing moved to `airfoil_from_naca`, `as: "polyline"`) (`standard_atmosphere`, `analyze_airfoil`,
  `analyze_wing`, `frontal_area`, `compute_aero_drag`, `road_load_power`), toolset `aerodynamics`, palette group.
- Tests: `tests/unit/aero/aerodynamics/*.test.ts` and `tests/unit/aero/scenarioPlans.test.ts`. Every VC listed in
  `validation/README.md` passes, against data pinned in `validation/data/`.

Known limits are listed in FUNCTIONAL_SPEC §10.

## 14. Implementation status — M3 (RS-7), 2026-10-19

**Built:** M3 — `analyze_vortex_lattice`, `drag_buildup` (plugin `aerodynamics`), the native job `llull-compute panel` (crate
`solver/crates/llull-panel`, faer 0.24) and the host transport `vortex_lattice_solve`; the RS1 §5 follow-up of `panelMethod.ts`.

| Item | Where |
| ---- | ----- |
| Horseshoe kernel (bound vortex on the panel quarter-chord line, trailing legs to +∞ along +x, control point at three-quarter chord; Katz & Plotkin eq. 10.115 + the closed-form semi-infinite leg), influence build, one LU for the x̂ and ẑ free streams (Γ(α) = cos α Γx + sin α Γz), Trefftz-plane 2D velocities | `aerodynamics/vlmKernel.ts` |
| Lattice from sections: spanwise stations by leading-edge arc length (uniform, or sine spacing = full-span cosine clustered at the tips), uniform chordwise; LE, chord and incidence interpolated; mirror about y = 0 keeping bound vortices along +span; sections from a `loft` entity (each ring in world frame: LE = least x, TE = largest x, incidence from their heights) | `aerodynamics/vlmLattice.ts` |
| Loads: Kutta–Joukowski in the free stream (ρ = 1, \|V\| = 1), Cm about `referencePoint` (nose up +), CDi = ½ Σ Γ_i (v_i × s_i)·x̂ in the Trefftz plane, strip cl, CL_α / Cm_α by ±0.5° central differences at α = 0, x_np = x_ref − (Cm_α / CL_α) c_ref, static margin with the CG at `referencePoint` | `aerodynamics/vlmLoads.ts` |
| Params, validation (codes `AER_SURFACE_SOURCE_CONFLICT`, `AER_SURFACE_INVALID`, `AER_LATTICE_TOO_LARGE`), result data shared by the command and the transport | `aerodynamics/vlmModel.ts`, `vlmCommand.ts` |
| Drag build-up CD0 = Σ Cf FF Q S_wet / S_ref with sourced formulas only (§ below) | `aerodynamics/dragBuildup.ts`, `dragBuildupCommand.ts` |
| Dense LU factorised once, `Float64Array`; the panel method solves its two right-hand sides on one factorisation (bit-identical to the former two `solveLinear` calls, VC-AER-10..12 unchanged) | `aerodynamics/denseLu.ts`, `panelMethod.ts` |
| `llull-compute panel <job-folder>`: `job.json` `{ panels }` + `panels.f64` (12 f64 per panel) → `gamma.f64` (Γx, Γz) + `solve.json` `{ threads, buildMs, factorMs, residualX, residualZ }`; the influence build is the TS one operation for operation (rows in parallel), the LU is faer's partial-pivot LU | `solver/crates/llull-panel` |
| `vortex_lattice_solve` transport (CLI, `POST /exchange`, toolset `aerodynamics`): analyze_vortex_lattice params + `timeoutS` / `verify`; loads computed in TS from the native Γ; `NATIVE_TOOL_MISSING` without the binary | `server/src/native/vortexLattice.ts`, `tools.ts` |

**Decisions.**

- **TS cap 1000 panels** (both sides): 1.34 s for a 1000-panel wing with two angles on the reference laptop (dense LU dominates);
  `AER_LATTICE_TOO_LARGE` above, naming `vortex_lattice_solve`. **Native cap 20 000 panels** (the dense matrix is 3.2 GB).
- **Camber** enters as a per-surface zero-lift angle (thin-airfoil α_L0 of `naca`, or `zeroLiftAngleDeg`) subtracted from the section
  incidence: the lattice stays on the chord plane. A loft's rings give chord and incidence only (no camber line is extracted).
- **Lofts as wing definitions** (open question 2, partly): `analyze_vortex_lattice` reads a `loft` entity directly (`loftId`);
  `analyze_wing` (lifting line) still takes numbers.
- **Planar wake** along +x (body axis) at every α, as in Bertin & Smith and Katz & Plotkin §12.3; the Trefftz plane is normal to x.
- **Native determinism (VC-AER-33):** the influence matrix is bit-identical to TS; faer's blocked LU differs from the TS elimination
  by round-off (measured ≤ 1e-14 of max |Γ| on the 56- and 288-panel lattices); a rerun with the same thread count is bit-identical.
  The Γ are query data (no document record), so cross-thread-count bit equality is not required (RS1 §2 rule 3).
- **Drag build-up formulas:** only those confirmed from a readable source (validation `sources.md` S15, S16): Raymer eq. 12.26 /
  12.27 / 12.30 (via OpenAeroStruct, which cites them), Torenbeek and Hoerner form factors (via the OpenVSP documentation), the
  OpenAeroStruct mixed laminar / turbulent Cf. Raymer's fuselage / nacelle form factors and his Q tables were not confirmed, so
  bodies use Torenbeek or Hoerner and Q is an input (default 1, flagged). Not modelled: roughness cutoff Reynolds number, wave drag,
  excrescences.

**Validation (all green):** VC-AER-33 (crate fixture + `server/tests/aeroPanelNative.test.ts`), VC-AER-34 Bertin & Smith swept wing
CL_α 3.4442 /rad vs 3.443 published, VC-AER-35 elliptic wing (AR 20 slope within 1.5 % of lifting line, e within 0.5 % at 200 strips,
native 2400 panels e within 0.3 %), VC-AER-36 quarter-chord neutral point, VC-AER-37 build-up closed forms
(`tests/unit/aero/aerodynamics/{vortexLattice,dragBuildup}.test.ts`).

**Measured (Windows laptop, 22 hardware threads, release build, 2026-10-19):** `llull-compute panel` 2400 panels 2.4 s (build 0.13 s,
LU 0.55 s), 5000 panels 4.4 s (0.48 s, 3.1 s), 10 000 panels 23.4 s (2.0 s, 17.7 s); relative residuals ≤ 1e-13.

**Not built (M3 remainder / later):** sideslip and lateral derivatives, a wake aligned with the free stream, ground effect, viscous
section polars inside the VLM (XFOIL, M2), the 3D source–doublet panel method.

**Review follow-ups (2026-10-19).** A surface whose leading edges all lie on y = 0 (a fin) or on both sides of it (a full-span
definition or loft) is not mirrored by default (`mirror: true` on it is refused, `AER_SURFACE_INVALID`): mirroring would lay the
image onto the surface (singular or near-singular system). `llull-compute panel` also returns the O(n²) Trefftz-plane velocities
(`trefftz.f64`, bit-identical to the TS `trefftzBasis` for the same Γ, crate fixture), so the host thread only does O(n) work per angle.
