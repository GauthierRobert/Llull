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

| Command                                                                    | Kind      | Purpose / failures                                                                                                                                      |
| -------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `export_flight_loads`                                                      | mutating  | 13 FLT run → load cases on an analysis: interface forces / moments at named mounts + inertial load; `FLL_RUN_STALE` if the design changed since the run |
| `set_free_body_support`                                                    | mutating  | 3-2-1 statically determinate support at chosen points; `check_analysis` gains `FLL_RELIEF_RESIDUAL` (reaction > 1e-4 · applied)                         |
| `check_rotor_resonance`                                                    | read-only | crossings of modes with k·Ω (k = 1, 2, blade count …) over rpm; margin %; `--save` Campbell SVG                                                         |
| `set_print_idealization`                                                   | mutating  | homogenised orthotropic model per part; skin as shell option; `FLL_PRINT_COUPON_MISSING` → typical values + `unverified`                                |
| `field_to_tets` (transport) + `fea_mesh` option `source: 'implicit_field'` | host      | tet mesh from the SDF; `FLL_IMPLICIT_MESH_QUALITY` if min dihedral below bound                                                                          |
| `create_drop_case`                                                         | mutating  | explicit case: rigid wall, initial velocity √(2gh), orientation; reuses `explicit_run`                                                                  |
| `add_rotating_load`                                                        | mutating  | centrifugal + Coriolis-free rotating load on a part about an axis at rpm (V1)                                                                           |
| `map_cfd_pressure`                                                         | mutating  | 12 CFD surface pressure → face pressures; reports ΣF and ΣM error (V1)                                                                                  |
| `check_bonded_joint`                                                       | read-only | average and peak (Volkersen) shear in a tube-in-socket bond (V1)                                                                                        |
| `run_static_aeroelastic`                                                   | read-only | VLM ↔ FE loop to convergence; divergence dynamic pressure (V2)                                                                                          |

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
| FLL-M2      | `export_flight_loads`, `set_free_body_support`, relief check                       | 13 FLT-M2         |
| FLL-M3      | `set_print_idealization` + coupon workflow                                         | —                 |
| FLL-M4      | `check_rotor_resonance` (modal exists)                                             | 13 FLT-M3 for rpm |
| FLL-M5      | `create_drop_case`                                                                 | explicit exists   |
| FLL-M6 (V1) | rotating loads, fatigue from flight, CFD pressure mapping, bonded joints           | 12 CFD            |
| FLL-M7 (V2) | static aeroelastic, flutter, preCICE                                               | 10 AER, 13 FLT    |

## 11. Open questions

- FLL-D1: isosurface stuffing vs Netgen volume meshing of a cleaned surface (remesh first)? Default: implicit tets
  (robust by construction; Netgen failed on the reference body).
- FLL-D2: angular-acceleration body force: exact per-element load vs approximation; decide after VC-FLL-02 accuracy.

## 12. References

See [FUNCTIONAL_SPEC.md §11](FUNCTIONAL_SPEC.md#11-references).
