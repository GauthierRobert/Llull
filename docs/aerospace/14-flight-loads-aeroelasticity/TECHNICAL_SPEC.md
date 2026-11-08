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
| FLL-M2      | `export_flight_loads`, `set_free_body_support`, relief check                       | 13 FLT-M2         |
| FLL-M3      | `set_print_idealization` + coupon workflow                                         | —                 |
| FLL-M4      | `check_rotor_resonance` (modal exists)                                             | 13 FLT-M3 for rpm |
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
- FLL-D2: angular-acceleration body force: exact per-element load vs approximation; decide after VC-FLL-02 accuracy.

## 12. References

See [FUNCTIONAL_SPEC.md §11](FUNCTIONAL_SPEC.md#11-references).
