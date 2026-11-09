# Gap 14 FLL — Technical specification

Specification only (2026-11-02). Ids `TR-FLL-nn`.

## 1. Current state

| Area               | Exists                                                                                                                                                                                                                       | Limit                                                                                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Analysis types     | static, modal, buckling, nonlinear_static, frequency_response, random_response, explicit_dynamics, heat_steady / transient, thermo_static, coupled_temperature_displacement (`packages/domain-cae/src/commands/analysis.ts`) | Complete for the MVP physics                                                                                                                                                                             |
| Loads              | `add_fea_load` force / pressure (uniform) / gravity / moment; `set_base_excitation`; `define_load_history`; `equivalent_static_load_case`                                                                                    | No reaction import, no centrifugal, no pressure field, no inertial load set from a flight state                                                                                                          |
| Field mapping      | `fea_map_field`, `fea_import_field`                                                                                                                                                                                          | Temperature only                                                                                                                                                                                         |
| Meshing            | `fea_mesh` → `llull-mesh` (Netgen 6.2.2604); a mesh entity falls back to its triangles as STL (`server/src/fea/feaGeometry.ts`)                                                                                              | Reproduced 2026-11-02 on the drone body: 60k-triangle STL timed out (600 s); 12k triangles: `Netgen could not mesh face 3503`. Also: Netgen / OCCT DLLs must be on PATH on Windows or `FEA_TOOL_MISSING` |
| Materials          | `add_material_model` elastic iso / ortho / transversely isotropic, plasticity …, provenance + basis                                                                                                                          | No printed-part (walls + infill + layer) idealisation                                                                                                                                                    |
| Dynamics reactions | per-joint reactions in `simulate_motion`                                                                                                                                                                                     | No export (FR-RBD-12 specified in docs/physics/10, not built)                                                                                                                                            |

## 2. Architecture

- Plugin `packages/domain-cae` for every FEA-side command (load import, resonance, print idealisation, drop template,
  pressure mapping, bonded joints, aeroelastic loop driver). It reads 13 FLT run summaries through `ctx.registry`
  (composition via `execute`, L10), never by importing `domain-dynamics` internals.
- Implicit volume meshing: a new job in the Rust field engine (`solver/crates/llull-field`, already the implicit
  engine): `field_to_tets` (isosurface stuffing [R9] or marching-tetrahedra volume cells with node snapping + quality
  sliver removal), exposed as a server transport like `fea_mesh`; the FE mesh record stays the existing one.
- preCICE (V2) is an external, user-installed process; llull writes the adapter config and the CalculiX deck and reads
  results back (host transport, never bundled).

## 3. Data model sketch

```ts
interface FlightLoadSource {
  runId: string;
  time: number | 'peak_load' | 'envelope';
  vehicleId: string;
}
interface InertialLoad {
  linearAccel: Vec3;
  angularVel: Vec3;
  angularAccel: Vec3;
  refPoint: Vec3;
} // -> CalculiX *DLOAD GRAV + CENTRIF per element set
interface PrintIdealization {
  entityId: string;
  walls: number;
  lineWidthMm: number;
  topBottomLayers: number;
  infill: { pattern: 'gyroid' | 'grid' | 'lightning' | 'honeycomb'; density: number };
  layerAxis: Vec3;
  coupon: { E_xy: Quantity; E_z: Quantity; uts_xy: Quantity; uts_z: Quantity; source: SourceRef };
}
interface ResonanceCheck {
  modalAnalysisId: string;
  rpmRange: [number, number];
  harmonics: number[];
  bladeCount: number;
  marginPct: number;
}
```

## 4. Commands

| Command                                                                    | Kind      | Purpose / failures                                                                                                                                                                                                           |
| -------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `export_flight_loads`                                                      | mutating  | 13 FLT run → load cases on an analysis: interface forces / moments at named mounts + inertial load; `FLL_RUN_STALE` if the design changed since the run                                                                      |
| `set_free_body_support`                                                    | mutating  | 3-2-1 statically determinate support at chosen points; `check_analysis` gains `FLL_RELIEF_RESIDUAL` (reaction > 1e-4 · applied)                                                                                              |
| `check_rotor_resonance`                                                    | read-only | crossings of modes with k·Ω (k = 1, 2, blade count …) over rpm; margin %; `--save` Campbell SVG                                                                                                                              |
| `set_print_idealization`                                                   | mutating  | homogenised orthotropic model per part; skin as shell option; `FLL_PRINT_COUPON_MISSING` → typical values + `unverified`                                                                                                     |
| `field_to_tets` (transport) + `fea_mesh` option `source: 'implicit_field'` | host      | tet mesh from the SDF; `FLL_IMPLICIT_MESH_QUALITY` if min dihedral below bound. **As built (FLL-M1)**: op `tets` of `llull-compute field`, run by `fea_mesh` when `set_mesh_controls source=implicit_field` (FLL-D1, D4, D7) |
| `create_drop_case`                                                         | mutating  | explicit case: rigid wall, initial velocity √(2gh), orientation; reuses `explicit_run`                                                                                                                                       |
| `add_rotating_load`                                                        | mutating  | centrifugal + Coriolis-free rotating load on a part about an axis at rpm (V1)                                                                                                                                                |
| `map_cfd_pressure`                                                         | mutating  | 12 CFD surface pressure → face pressures; reports ΣF and ΣM error (V1)                                                                                                                                                       |
| `check_bonded_joint`                                                       | read-only | average and peak (Volkersen) shear in a tube-in-socket bond (V1)                                                                                                                                                             |
| `run_static_aeroelastic`                                                   | read-only | VLM ↔ FE loop to convergence; divergence dynamic pressure (V2)                                                                                                                                                               |

## 5. Algorithms

- **Inertial relief**: for a rigid-body state (a, α, ω) at reference point O, each element receives the body force
  −ρ[a + α × r + ω × (ω × r)]; CalculiX takes GRAV (uniform) + CENTRIF (about an axis) distributed loads; angular
  acceleration terms are applied as a linear body-force field through per-element GRAV sets (V1 precision note).
  Supports: 3-2-1 points far apart; check that reactions vanish (VC-FLL-02).
- **Resonance**: Campbell crossings f_mode = k·rpm/60; margin = |f_mode − f_exc| / f_exc at the operating rpm band.
- **Print homogenisation**: skin (walls × line width) as shell or as a stiff layer; core modulus E_core = E_solid · φ^m
  with φ the infill density and m pattern-dependent (fit to coupons; no default exponent is claimed without a source);
  layer-direction modulus and strength from coupons (XY vs Z), otherwise the [R1] strengths as grade-B context only.
- **Implicit tets**: background BCC lattice at the voxel size, cut by the iso-surface, warp / snap nodes near the
  surface, stencil cut into tets, remove slivers; quality bound (min dihedral) per [R9].
- **Drop**: v0 = √(2gh); explicit central difference (existing llull_explicit) with penalty contact to a rigid wall.

## 6–7. Interop, surfaces and codes

CalculiX deck additions (`*DLOAD` GRAV / CENTRIF, `*DSLOAD` per face for mapped pressure). Codes: `FLL_RUN_STALE`,
`FLL_RELIEF_RESIDUAL`, `FLL_PRINT_COUPON_MISSING`, `FLL_IMPLICIT_MESH_QUALITY`, `FLL_MAP_CONSERVATION`,
`FLL_AEROELASTIC_DIVERGED`.

## 8. Budgets

Reference body (250 × 250 × 44 mm) meshed from the field at 2 mm in < 60 s, < 1.5 M tets; static solve < 2 min.

## 9. Tests

VC-FLL-01..09 as unit + golden plans; a production-gate scenario: the reference drone through hover-gust → loads →
body margins → resonance → drop.

## 10. Delivery

| Milestone   | Content                                                                            | Depends on        |
| ----------- | ---------------------------------------------------------------------------------- | ----------------- |
| FLL-M1      | `field_to_tets` + `fea_mesh source=implicit_field` (unblocks the drone body today) | llull-field       |
| FLL-M2      | `export_flight_loads`, `set_free_body_support`, relief check (**built**, §13)      | 13 FLT-M2         |
| FLL-M3      | `set_print_idealization` + coupon workflow (**built**, §15)                        | —                 |
| FLL-M4      | `check_rotor_resonance` (modal exists) (**built**, §14)                            | 13 FLT-M3 for rpm |
| FLL-M5      | `create_drop_case`                                                                 | explicit exists   |
| FLL-M6 (V1) | rotating loads, fatigue from flight, CFD pressure mapping, bonded joints           | 12 CFD            |
| FLL-M7 (V2) | static aeroelastic, flutter, preCICE                                               | 10 AER, 13 FLT    |

## 11. Decisions and open questions

- FLL-D1 (decided 2026-11-08, FLL-M1): **isosurface stuffing in Rust** (`solver/crates/llull-field/src/stuffing.rs`, op `tets` of
  `llull-compute field`), not Netgen on a remeshed surface. BCC lattice of spacing `globalSize` (corners at the grid nodes, centres at the
  cell centres) over the body bounds padded by 2 spacings, the outermost layer held outside (always closed); cut points by a bracketed root
  search on the field (Illinois regula falsi, stopped when the bracket no longer shrinks), not a linear interpolation; vertices warped onto
  cut points closer than α = 0.24999 (long edges) / 0.41189 (short edges) of the edge [R9]; stencils by the signs of each BCC tetrahedron.
  Two changes from [R9], whose parity rule was not available in this session: a quadrilateral on a lattice face is split by its **shorter
  diagonal** (exact tie: the diagonal through the smaller vertex key), evaluated by both tetrahedra on the same numbers, so the mesh is
  conforming; a prism whose three diagonals turn one way gets a **Steiner vertex** at its centroid (never seen on 80 sweep fields, unit-tested
  directly). The [R9] dihedral bounds are therefore not proven for this variant; they are the refusal gate (`FLL_IMPLICIT_MESH_QUALITY` below
  10.7832° or above 164.817°, or any folded / non-manifold / inverted / degenerate element, or any **open** boundary face) and measured:
  worst 13.6° over the sweep, 17.5° on a gyroid sheet, 20.1° on the drone stand-in. **Pin [R9] and compare its parity rule before raising
  the gate.** Conformity is checked, not assumed (review round 1): a boundary face with a corner off the iso-surface (`open`) is a crack
  between neighbours that split a shared quadrilateral differently; a test that flips one split proves the count sees it. Elements are
  oriented by the **reference configuration** (lattice vertices unwarped, cut points at edge midpoints, where every stencil piece is convex),
  never by the warped geometry, so a geometrically inverted element is counted (`inverted`) and refused instead of being turned over.
- FLL-D3 (FLL-M1): second order: one mid node per edge; mid nodes of boundary edges are projected onto the iso-surface (Newton on the field
  gradient, at most 0.25 of the edge), undone where any of the 20 **Bernstein coefficients** of det J (a cubic in the barycentric
  coordinates) is below 0.2 of the straight element's det J: det J is their convex combination, so this bounds it everywhere in the element
  (sufficient, not necessary: a few valid curvings are undone). The undo loop is bounded by progress. The reported volume is the exact
  integral of det J (Keast degree 3). Sphere R 10 at 2 mm: C3D4 −1.01 %, C3D10 −0.0012 %.
- FLL-D4 (FLL-M1): `source` is a **mesh control** (`set_mesh_controls source=implicit_field`), not an argument of the `fea_mesh` call: it is
  document data, so it enters the mesh input hash (a change makes the mesh stale), replays, and convergence studies re-mesh the same way
  (level controls carry it). Uniform size only: refinements and conformal bonding are refused (`FLL_IMPLICIT_MESH_UNSUPPORTED`), so are
  shell / plane-stress parts and plane-intersection targets; `edgesNear` is refused (a field has no B-rep edges).
- FLL-D5 (FLL-M1, revised in review round 1): `facesNear` = the face region of the nearest boundary triangle, grown across neighbours whose
  **field normals** (normalised gradient at the triangle centroid) turn by less than 40° (llull-mesh's angle), tolerance max(1e-3 ×
  diagonal, ½ spacing); `pointsNear` = nearest node. Facet normals are not enough: stuffing cuts a sharp field edge that lies off the
  lattice planes into a strip of intermediate facets, and a facet-normal flood chained around it onto the next face (a box rotated off the
  lattice: the +x face set reached the −x face); the gradient jumps at the edge, so the region stops there. Verified: the end face of an
  axis box exactly; the +x face of a rotated box (every node within one spacing of its plane, ≥ 80 % on it); the pad faces of the drone
  stand-in (nodes within h of z = ∓10 and r ≤ 16 + h, areas within 5 % of π 16²).
- FLL-D6 (FLL-M1): an implicit body is derived and read-only (`assign_material` is refused, and its entity is rebuilt on load), so the
  material is given to `create_implicit_body material=<name>` and kept on the body record. Changing it later = a new body (follow-up: a body
  material command if owners need it). A body's `materialId` that is not a document material refuses the load (`implicit.bodies.<id>.
materialId`), like every other dangling reference.
- FLL-D7 (FLL-M1): host lifecycle: one job per part, shared by concurrent identical calls (content key over the job files), each caller with
  its own signal; the job tree is killed when its last caller leaves; a job silent for `LLULL_FIELD_TETS_STALL_S` (120 s) is stopped
  (`FLL_IMPLICIT_MESH_STALLED`); cancel / stall / refusal commit nothing. Budgets: 2^26 lattice vertices (checked before evaluation,
  `FLL_IMPLICIT_MESH_TOO_LARGE`), 2·10^6 tetrahedra (checked while stuffing) and the TS pre-check from the body volume (12 × 1.25 tets per
  spacing³, `FEA_MESH_TOO_LARGE`). Progress: every whole percent and at least every 5 s while a phase reports (lattice planes, root-search
  chunks, stuffing layers, the quality scan, projection chunks, each undo pass). Convergence studies pass the caller's signal and progress
  sink to every level, so a study of a field-meshed case is cancellable.
- FLL-D8 (FLL-M1, review round 1): **explicit bounds clip exactly.** For a body created with `bounds` (a bare TPMS or lattice), the FE solid
  is the field intersected with the bounds box (the compiler's own box primitive and sharp intersect, built in `implicitBodyField`), so the
  clip is an iso-surface and no lattice corner on the border is inside the field. A border corner inside the field is refused by name
  (`FLL_IMPLICIT_MESH_CLIPPED`) as a backstop. The display mesh of such a body is not clipped that way (marching tetrahedra over the bounds
  padded by 2 voxels, open at the grid border): bounds state the solid, the display mesh only shows it. Clipped gyroid: −1.04 % at h 0.2,
  −0.25 % at h 0.1 against a fine quadrature (second order: the chord across the sharp creases where the sheet meets the box).
- FLL-D2: angular-acceleration body force: exact per-element load vs approximation; decide after VC-FLL-02 accuracy. **Resolved for M2 in §13** (centroid lumping, measured).

## 12. References

See [FUNCTIONAL_SPEC.md §11](FUNCTIONAL_SPEC.md#11-references).

## 13. Implementation status — FLL-M2 (2026-11-09)

**Built (TR-FLL: `export_flight_loads`, `set_free_body_support`, the relief check).**

| Item                                                                                                                                                                                                                                                                                    | Where                                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Model: `FeaLoad.kind = 'inertial'` (`vector` = absolute acceleration of the reference point O, `angularVelocity`, `angularAccel`, `referencePoint`), `FeaLoad.flightSource { scenario, timeS, designHash }` (all null for an explicit state), `FeaConstraint.freeBody`                  | `packages/core/src/model/analysis.ts`; value validation `model/validate.ts`                  |
| `export_flight_loads`: scenario (+ `at` time / `peak_load` / `envelope`) or explicit `state`; per instant one load case: inertial load, gravity load, one force (or moment) load per mount; re-export replaces the earlier flight loads of the same load case                           | `flightLoads/exportFlightLoads.ts`, `flightInstants.ts`                                      |
| `set_free_body_support`: three displacement constraints holding 3 / 2 / 1 translations at three points, the dofs chosen as the best conditioned of nine patterns by the pivot of the 6 x 6 rigid-body restraint matrix (refused below 0.05 of the point spread: `FLL_SUPPORT_SINGULAR`) | `flightLoads/freeBodySupport.ts`, `supportPattern.ts`                                        |
| Relief check in `check_analysis`: `FLL_RELIEF_RESIDUAL` (error), `FLL_RELIEF_UNASSESSED` (warning), `FLL_RUN_STALE` (error), `FLL_INERTIAL_UNSUPPORTED` (error)                                                                                                                         | `flightLoads/checkItems.ts`, `rigidBalance.ts`, `designHash.ts`; hook in `commands/check.ts` |
| CalculiX deck: uniform part `EALL, GRAV` (field g - a, summed with gravity loads), rotation about O `EALL, CENTRIF, w^2, O, axis`, angular acceleration one `GRAV` line per element; the Nastran export refuses an inertial load (`FLL_INERTIAL_UNSUPPORTED`)                           | `decks/inertialBodyForce.ts`, `decks/mechanical.ts`, `decks/bdf/loads.ts`                    |

**Validation.** `tests/unit/cae/flightLoads.test.ts` (set-up, deck text, relief and stale items, failure paths, purity), `flightLoadsRun.test.ts` (a real MuJoCo flight: the quad X climbing, rotor thrusts as mounts), `ccxFlightRelief.test.ts` (real CalculiX, skipped without `ccx`). VC-FLL-02 (reactions vanish), on a 2 x 1 x 1 mm bar: with the balancing mount force two disjoint 3-2-1 patterns give the same mid-section stress to 1e-6 (the reactions are nil); with 60 % of m a (or 70 % of the weight) the stress depends on the pattern by more than 5 %; sigma_xx of a bar accelerated at 10^4 g is within 0.7 to 1.4 of rho a L (nodal stress, end load split equally over the nodes). Flight: with the rotor thrusts as mounts the force residual is 9e-7 of the applied force and the moment residual 1e-5 of the applied moment at the peak load of a 3 s climb sampled at 1 kHz (gate 1e-4), and the case is flagged (`FLL_RELIEF_RESIDUAL`) without mounts.

**Decisions.**

- **FLL-D9 (the flight run is read through the registry)**: 13 FLT keeps no stored run (`run_flight` records nothing, FLT-D9), so the run id is the scenario id: `export_flight_loads` flies it with `run_flight` (`ctx.registry`, detail `series`, default 200 Hz sampling) and reads velocity, attitude, body rate and rotor thrust. No import of `domain-dynamics`. The vehicle must start in the document axes (identity attitude): accelerations are rotated into those axes by the Z-Y-X Euler angles of the series.
- **FLL-D10 (acceleration is a difference of samples)**: the series has no acceleration, so a = d v / dt and alpha = d(body rate) / dt by central differences of the recorded samples. At 1 kHz the vertical balance closes to 1e-6, at 200 Hz to about 1e-3: raise `sampleRate` when the 1e-4 relief gate matters (the 13 series round to 7 digits, the floor).
- **FLL-D11 (staleness)**: `designHash` = hash of `doc.dynamics`, the flight slice (read opaquely), the entities and materials of the rigid bodies and the document unit. Changing a body, rotor, controller, scenario, gravity or the geometry or material of a body makes every load of the export `FLL_RUN_STALE` in `check_analysis`; an unrelated entity or the analysis itself does not. Exporting again refreshes it.
- **FLL-D12 (reactions from the loads, not the solve)**: with a determinate 3-2-1 support the reactions are minus the net wrench of the loads on the rigid body, so `FLL_RELIEF_RESIDUAL` is computed before the solve from the loads and the mass properties of the analysed solids (mass from the material density, centre and inertia from `resolveMassProperties`): residual force = |sum F + M (g - a - alpha x s - w x (w x s))|, residual moment about the centre of mass = |sum (x - c) x F + sum M - (I alpha + w x I w)|, each against 1e-4 of the applied (the larger of the sum of mount magnitudes and the body force). A force acts at the mean of its target points. Per-node forces, pressures and a part without mass are listed as `FLL_RELIEF_UNASSESSED` instead of guessed. A post-solve cross-check on the solver reactions is not built: the deck does not print `RF`, and ccx `RF` at a free dof is K u, not the support reaction, so reactions need the applied nodal loads subtracted.
- **FLL-D13 (the mounts)**: a mount is `{ name, target, force | rotorId + direction, moment? }`: the force is fixed (analysis units) or the rotor thrust of the instant times a direction in model axes. Rotor reaction torques and gyroscopic moments are not exported (not in the series): they show as a moment residual when they do not cancel. The flight model and the FE body must share mass, centre and inertia, or the moment gate flags the difference (the flown rigid body's inertia is `inertiaKgM2`, the FE body's is the geometry's).
- **FLL-D2 (resolved for M2)**: angular acceleration is one `GRAV` line per element with the field at its centroid, rotation is CENTRIF; both are lumped at the centroid, so the net moment of the body force differs from I alpha by the element self-inertia. Measured on the bar (balanced by the exact I alpha, or a free spin): the mid-section stress depends on the 3-2-1 pattern by 8.6 % (6 tets) / 2.5 % (48) / 0.9 % (384) for the angular acceleration and 9.5 / 4.7 / 2.2 % for CENTRIF. Refine the mesh where the inertia moment matters; an exact consistent per-element load is the alternative if owners need it.
- **Point supports**: a point support has a singular stress field whatever its reaction; read stresses away from the three support nodes (the mid-section in the tests).

**Not in M2.** A solved-reaction cross-check; rotor reaction torques as mount moments; multi-body vehicles (13 FLT-M4); `envelope` is the three peaks (specific force, angular velocity, angular acceleration), not a convex envelope of all instants; nonlinear / modal analyses refuse inertial loads (`FLL_INERTIAL_UNSUPPORTED` in `check_analysis`); the Nastran export refuses them.

## 14. Implementation status — FLL-M4 (2026-11-09)

**Built.** `check_rotor_resonance` (read-only, plugin `cae`, toolset analysis): crossings of the stored modal frequencies of a solved modal analysis with the k . rpm / 60 excitation of the flight model's rotors.

| Piece                                                                                                                                                                                                      | Where                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Command                                                                                                                                                                                                    | `packages/domain-cae/src/flightLoads/checkRotorResonance.ts` |
| Arithmetic: crossing rpm = 60 f / k, margin = abs(f - k rpm/60) / (k rpm/60), smallest margin over a band                                                                                                  | `flightLoads/campbellMath.ts`                                |
| Campbell SVG (rpm vs Hz, mode lines, k rpm/60 rays, shaded bands, crossings; `data.svg` + `data.width`, so `--save x.svg` / `x.png` work like `render_probe_history`)                                      | `flightLoads/campbellSvg.ts`                                 |
| Rotors, controller rpm band, trimmed speed, read through `ctx.registry` (`inspect_dynamics`, `trim_flight`; no import of `domain-dynamics`, L10)                                                           | `flightLoads/rotorSource.ts`                                 |
| Codes `FLL_NOT_MODAL`, `FLL_MODAL_UNAVAILABLE` (unsolved / stale / untrusted results), `FLL_NO_MODES`, `FLL_NO_ROTORS`, `FLL_ROTOR_UNKNOWN`, `FLL_TRIM_FAILED`, `FLL_BAND_INVALID`, `FLL_THRESHOLD_SOURCE` | `flightLoads/codes.ts`                                       |

**Decisions.**

- **FLL-D14 (what is read)**: only the stored modal results (`trustedRecord` state solved: a stale or unsolved case is refused, never read as zero modes; modes at or below 1e-3 Hz are rigid-body modes and skipped). Frequencies are constant with rpm: no centrifugal stiffening, no gyroscopic split, so the Campbell mode lines are horizontal (stated in `data.note`). Exact for the stored result; a spinning rotor on a flexible mount needs a prestressed modal solve (not built).
- **FLL-D15 (rpm band and operating speeds)**: band = caller `rpmBand`, else `minRpm..maxRpm` of the flight controller commanding the rotor (the scenario's controller with `scenario`), else the rotor's own constant rpm, else none (rows unknown). Operating speeds = caller `operatingRpm`, else the trimmed speed of `scenario` (`trim_flight` at `airspeedMps` / `flightPathDeg`; a failed trim is `FLL_TRIM_FAILED`), else the rotor's own rpm when above 0. The band, the operating speeds and their sources are in `data.rotors[]`.
- **FLL-D16 (no invented requirement)**: the spec names no required margin, so none is defaulted. `marginThresholdPct` is given together with `marginSource` (else `FLL_THRESHOLD_SOURCE`). Without it every row is `unknown` (crossings and margins are still reported); with it a row passes when its smallest margin over the band (0 at a crossing) is at least the threshold, else fails. The overall status is fail if any row fails, else unknown if any row or rotor is unknown (no band, no blade count), else pass; `reviewRequired` is true unless every row passes (also true for imported-unbound results).
- **FLL-D17 (blade count)**: the flight model (`add_rotor`) has no blade count. It is the caller's `bladeCount` / `bladeCounts` (per rotor); harmonics default to [1, 2] plus the blade count. A rotor without a blade count is listed in `data.unassessed` and the overall status cannot be pass.

**Validation.** `tests/unit/cae/rotorResonance.test.ts`. VC-FLL-04 oracle (Euler-Bernoulli cantilever of VC-FLL-01, rho 1270 kg/m^3): f1 = 72.078 Hz, f2 = 451.72 Hz as a `.dat` modal fixture: 2P crossing 2162.34 rpm (60 f / 2, exact), 1P 4324.68 rpm; hand margin: 72.078 Hz against 2P at 3000 rpm (100 Hz) is 27.922 %, at the 2400 rpm band edge (80 Hz) 9.9025 %. Failure paths: unknown / non-modal / unsolved / stale analysis, rigid-body-only results, no rotors, unknown rotor or scenario, inverted band, threshold without source, failed trim, schema rejection; purity; deterministic SVG. Trimmed hover speed read from `trim_flight` on a quad. The tests were mutation-checked (crossing factor, unknown to pass, threshold comparison each fail a test). **Not built:** a golden plan (the spec names none for M4; a modal solve needs CalculiX, so the real-solver case is open), a Campbell with speed-dependent frequencies, the rotor blade count in the flight model.

## 15. Implementation status — FLL-M3 (2026-11-09)

**Built.** Three commands (plugin `cae`, toolset analysis, `packages/domain-cae/src/flightLoads/print/`): `record_print_coupon` (a measured printed coupon: pattern, infill density, direction xy | z, modulus, optional UTS, source), `fit_print_infill_exponent` (read-only least squares of ln E = ln C + m ln density for one pattern and direction) and `set_print_idealization` (the printed part of a static / modal / buckling case, stored in `AnalysisCase.printed[entityId]`). The deck writes the part as one homogenised orthotropic solid: `*ELASTIC, TYPE=ENGINEERING CONSTANTS`, `*DENSITY` and `*ORIENTATION` (the build direction is material direction 3), through the same `*SOLID SECTION` as every part. Types: `@core/model/printIdealization`; coupons in `AnalysisModel.printCoupons` / `printCouponOrder` (shared by all cases).

- **FLL-D18 (inputs stored, constants derived)**: the case stores walls, lineWidthMm, layerHeightMm, topBottomLayers, infill { pattern, density }, the unit layerAxis, the solid coupon values (MPa) and the exponent with its source. The orthotropic constants are derived from them and the part geometry when the deck is written or the command is called (`printedProperties`), so a geometry or material edit never leaves stale constants; the full input hash covers `printed` (the mesh hash does not).
- **FLL-D19 (model)**: modulus per direction = coupon modulus x (f + (1 - f) x density^m), f the skin fraction; directions 1 and 2 in the build plane (coupon XY), 3 along `layerAxis` (coupon Z); density ratio f + (1 - f) x density. Parallel (Voigt) mixing of skin and core. Infill density 1 recovers the coupon moduli exactly and the E_z / E_xy ratio of the coupons is the ratio at every density (VC-FLL-06: the idealisation reproduces the orientation ratio of the coupon inputs). The layer height is a new input (the data model of §3 had topBottomLayers without a thickness).
- **FLL-D20 (skin fraction)**: first order, measured on the part triangles: skin volume per unit face area = walls x lineWidth x |sin theta| + topBottomLayers x layerHeight x |cos theta| (theta = angle between the face normal and the build direction), summed and divided by the enclosed volume, capped at 1. Exact for faces parallel or perpendicular to the build direction; corners and edges are counted twice, so a skin that is thick against the part over-estimates (stated in `data.unverifiedReasons`). The skin is a stiff layer of the single solid; the shell option of §4 is NOT built (one idealisation per part and case: a shell skin plus a solid core needs two parts).
- **FLL-D21 (what is not measured)**: coupons give moduli and strengths only. Poisson ratio is the part material's (`elasticConstants`, every plane), shear is isotropic-like: G12 = E_xy / (2 (1 + nu)), G13 = G23 = E_z / (2 (1 + nu)). The result always carries `unverified: true` with these reasons; the deck prints `** UNVERIFIED`. Constants that are not positive definite (the coupon moduli too far apart for that nu) are refused (`FLL_PRINT_STIFFNESS`). The material of the part supplies nu and density only: its E is replaced by the coupons.
- **FLL-D22 (no typical values, no default exponent)**: the only value in the repository with a citable source is [R1]'s UTS (VC-FLL-06), which is a strength of one printer / filament / setting and not a modulus. No typical modulus exists, so a missing coupon is `FLL_PRINT_COUPON_MISSING` and nothing is substituted; a missing exponent is `FLL_PRINT_EXPONENT_MISSING`. The exponent is either given with a source or fitted (`infillExponent { fitDirection }`) from the recorded coupons of the part's infill pattern; the fit needs 2 coupons at distinct densities (`FLL_PRINT_FIT_POINTS`) and a positive exponent. The fit reports m, C (the modulus extrapolated to density 1, warned when it differs from the solid coupon by more than 10 %), the rms of ln E residual, the largest relative residual and R^2; two coupons fit exactly (warned). Strengths are reported as given (`strengths.homogenised: false`): no strength-versus-infill law is claimed.
- **FLL-D23 (scope and conflicts)**: static, modal and buckling cases only (`FLL_PRINT_CASE_TYPE`; load validation refuses other types); a printed part whose material also has a plastic / hyperelastic / creep set is refused by the deck (`FLL_PRINT_CONSTITUTIVE`); a printed part never shares its `*MATERIAL` with a solid part of the same document material. `layerAxis` is in the document frame; the FLL-D12 relief mass still uses the solid material density (a printed part's lighter mass is not read there).

**Validation.** `tests/unit/cae/printIdealization.test.ts` (fit recovers C and m of exact synthetic data to 1e-12; density 1 recovers the coupon moduli; E_z / E_xy ratio kept; skin fraction of the 2 x 1 x 1 box against the hand sum; engineering constants, density and orientation text for build directions z, x; load validation of every field; refusals and purity), `tests/unit/cae/ccxPrintedBar.test.ts` (real CalculiX: the bar of 2 x 1 x 1 mm pulled in the build plane and along the build direction gives sigma = E_xy_eff x 1e-3 and E_z_eff x 1e-3 within 1e-5, ratio 0.75; skipped without ccx), plugin slice fuzz seed `cae#printed`.

**Left.** Shell skin option; a measured shear / Poisson coupon workflow; strength homogenisation; printed mass in the FLL-D12 relief balance; removing a recorded coupon.
