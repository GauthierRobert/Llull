# Gap 14 FLL — Flight loads into structure: load mapping, rotor vibration, landing, printed parts, aeroelasticity

Status: **specification only** (2026-11-02). Follows [`../TEMPLATE.md`](../TEMPLATE.md) and [`../AGENT_FIRST.md`](../AGENT_FIRST.md).
Upstream: [13 FLT](../13-flight-dynamics/FUNCTIONAL_SPEC.md) (flight dynamics), [12 CFD](../12-cfd-gpu/FUNCTIONAL_SPEC.md), [05 FEA](../05-fea-cae-handoff/FUNCTIONAL_SPEC.md).

## 1. Summary

llull's FEA (CalculiX via `packages/domain-cae`) already covers static, modal, buckling, nonlinear static, frequency and
random response, explicit dynamics, fatigue, crack growth, topology and thermal (steady, transient, thermo-mechanical).
What it lacks is **the bridge from flight to structure** and **the idealisation of the parts small UAS are made of**:

1. Loads only come in as hand-typed forces, uniform pressures, gravity and moments (`add_fea_load`). There is no import
   of flight reactions (13 FLT), no d'Alembert (inertial) load case for an accelerating free vehicle, no rotating
   (centrifugal) load, and no CFD pressure field mapped onto faces (`fea_map_field` maps temperature only).
2. Rotor-induced vibration is not connected: modal results are not compared with rotor harmonics over the rpm range.
3. 3D-printed parts are analysed as solid isotropic material, which is wrong by a large factor for walls + sparse infill
   and ignores the layer-direction weakness.
4. Organic bodies made by the implicit (SDF) engine cannot be meshed: reproduced on 2026-11-02 with the reference drone
   body (60 000-triangle STL: Netgen timed out after 600 s; 12 000 triangles: `FEA_MESH_FAILED … could not mesh face 3503`).
5. Aeroelasticity (static twist and divergence of a flexible wing, flutter of a servo-held pivoting wing) is out of
   scope everywhere today (docs/physics/README.md "Not in this list"; 05 FEA FUNCTIONAL_SPEC out of scope).

## 2. Context and value

A drone or light aircraft is sized by a few load cases: maximum thrust (motor arm and mount bending), manoeuvre
(inertial loads on the battery and payload mounts), hard landing / drop (gear, body, battery), rotor imbalance
vibration (resonance of arms, camera mounts, avionics), and fatigue over flight hours. Today engineers estimate these by
hand, then type them into FEA. llull can produce them from the same model it flies (13 FLT) and check the structure in
one parametric loop.

## 3. Personas and stories

| Persona              | Story                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Operator (CLI agent) | "Take the peak loads of the gust scenario and the 0.5 m drop, check the body, struts and wing pivots, give margins." |
| Owner                | "Will the printed body crack on a hard landing? Is anything resonating with the motors?"                             |
| Qualified reviewer   | Disposes FAIL / MARGINAL margins (existing `dispose_margin`) on flight-derived load cases.                           |

## 4. Scope

**MVP**: flight-loads export (13 FLT reactions → FEA load cases with inertial relief), rotor-harmonic resonance check
(Campbell), printed-part idealisation (walls + infill homogenisation, layer orthotropy), implicit-body volume meshing,
drop-test template on the existing explicit solver.
**V1**: centrifugal / rotating loads (propeller blades), fatigue from flight load histories (existing fatigue engine),
CFD surface pressure mapping (12 CFD → face pressures), adhesive / bonded-joint check (strut sockets).
**V2**: static aeroelasticity (VLM ⟷ FE beam / shell iteration, divergence), flutter (p-k) for servo-held pivoting
surfaces, two-way FSI through preCICE (external, optional).
**Out of scope**: certification of flight loads, crashworthiness of occupants, acoustic fatigue.

## 5. Functional requirements

| Id        | Pri    | Requirement                                                                                                                                                                                                                                          | Rationale                                                             |
| --------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| FR-FLL-01 | MUST   | `export_flight_loads` turns a 13 FLT run (time, peak or envelope) into FEA load cases: mount forces and moments at the interfaces plus the vehicle's linear and angular acceleration as inertial (d'Alembert) loads                                  | Flight loads without retyping; the free vehicle stays in equilibrium  |
| FR-FLL-02 | MUST   | Inertia-relief-equivalent support for a free vehicle: a statically determinate 3-2-1 support plus applied inertial loads, with a check that support reactions are ≈ 0                                                                                | A flying vehicle has no ground support                                |
| FR-FLL-03 | MUST   | `check_rotor_resonance`: modal frequencies vs 1P / 2P / blade-pass harmonics over the rpm range from 13 FLT (hover to max), crossings and margins as data, Campbell plot                                                                             | Arms and camera mounts resonate with rotors                           |
| FR-FLL-04 | MUST   | Printed-part idealisation: a part flagged `printed` with walls, infill pattern / density and layer direction gets homogenised orthotropic properties (or a shell for the skin + reduced core), with sourced coupon values and `unverified` otherwise | Solid isotropic PETG overstates stiffness and ignores Z weakness [R1] |
| FR-FLL-05 | MUST   | Implicit (SDF) bodies mesh to tetrahedra directly from the field, conforming to the iso-surface with a quality bound, without going through STL + Netgen                                                                                             | Reproduced failure on the reference body                              |
| FR-FLL-06 | MUST   | Drop / hard-landing template on `explicit_dynamics`: vehicle mass properties, impact velocity from height, ground wall, peak accelerations and stresses                                                                                              | The most common small-UAS structural failure                          |
| FR-FLL-07 | SHOULD | Centrifugal and gyroscopic loads for rotating parts (CalculiX centrifugal distributed load)                                                                                                                                                          | Propeller blade root stress, hub                                      |
| FR-FLL-08 | SHOULD | Flight load histories (13 FLT series) feed the existing fatigue cases (`define_load_history`, rainflow)                                                                                                                                              | Fatigue over flight hours                                             |
| FR-FLL-09 | SHOULD | CFD surface pressure (12 CFD) mapped to face pressures with force and moment conservation reported                                                                                                                                                   | Aero loads on wings and canopy                                        |
| FR-FLL-10 | SHOULD | Bonded-joint check for glued tube-in-socket joints (shear stress over the bond length, peel flag)                                                                                                                                                    | Strut sockets                                                         |
| FR-FLL-11 | COULD  | Static aeroelastic coupling (VLM loads ↔ FE deflection, twist) with divergence speed                                                                                                                                                                 | Flexible printed wings                                                |
| FR-FLL-12 | COULD  | Flutter (p-k) of a pivoting surface held by a servo of given torsional stiffness                                                                                                                                                                     | Servo-held wings                                                      |
| FR-FLL-13 | COULD  | Two-way FSI through preCICE + CalculiX adapter (external, optional, never bundled)                                                                                                                                                                   | High-fidelity coupling [R5][R6]                                       |

## 6. Workflow

```bash
llull run_flight scenarioId=gust --doc drone.llull.json
llull export_flight_loads runId=... at=peak_load analysisId=an-body --doc drone.llull.json
llull set_print_idealization entityId=body walls=2 infill='{"pattern":"lightning","density":0.1}' layerAxis=[0,0,1] --doc drone.llull.json
llull fea_mesh analysisId=an-body ; llull fea_solve analysisId=an-body ; llull compute_margins analysisId=an-body
llull check_rotor_resonance analysisId=an-modal runId=... --save campbell.svg
llull create_drop_case heightM=0.5 orientation=level --doc drone.llull.json ; llull explicit_run ...
```

## 7. Acceptance criteria

- Given a free body under inertial loads from a known acceleration, when solved, then the support reactions are below
  1e-6 of the applied load (VC-FLL-02).
- Given a uniform cantilever, when `check_rotor_resonance` runs, then the first bending frequency matches
  (1.8751²/2π)·√(EI/(m'L⁴)) within 1 % and the crossing rpm with 2P is reported (VC-FLL-04).
- Given the reference drone body, when meshed through FR-FLL-05, then a valid quadratic tet mesh is produced and its
  volume is within 0.5 % of the implicit body volume (VC-FLL-09).
- Given a 0.5 m drop, then the impact velocity used is √(2gh) = 3.1316 m/s (VC-FLL-05).

## 8. Standards

No small-UAS structural load standard with public load factors was found (ASTM F3298-24 catalogue page: fixed-wing
scope per its abstract [R7]; EASA light-UAS MoC search-only [R8]). Load factors are therefore **named defaults the owner
confirms** (AGENT_FIRST: named safety defaults), not claimed from a standard.

## 9. KPIs

Margins for the four reference load cases in < 10 min end to end on the desktop; grade-A cases 100 % in CI.

## 10. Risks

- Printed-part properties vary strongly with settings [R1]; coupon tests by the owner are the only grade-A source.
- Implicit-field tet meshing is new code (isosurface stuffing class algorithm); quality guarantees must be proven by tests.
- Aeroelastic and flutter results are safety-relevant: `reviewRequired` always.

## 11. References

- [R1] Printing parameters of PET-G and PLA (tensile strength by orientation, infill, layer height) — PMC — https://pmc.ncbi.nlm.nih.gov/articles/PMC9230522/ (accessed 2026-11)
- [R5] preCICE — https://github.com/precice/precice (LGPL-3.0, accessed 2026-11)
- [R6] preCICE CalculiX adapter — https://github.com/precice/calculix-adapter (GPLv3, accessed 2026-11)
- [R7] ASTM F3298-24 — https://store.astm.org/f3298-24.html (catalogue, accessed 2026-11)
- [R8] EASA light-UAS means of compliance — https://www.easa.europa.eu/sites/default/files/dfu/crd_moc_light-uas-2511.pdf (search-only)
- [R9] Labelle and Shewchuk, Isosurface stuffing: fast tetrahedral meshes with good dihedral angles, ACM SIGGRAPH 2007 — https://people.eecs.berkeley.edu/~jrs/papers/stuffing.pdf (to fetch and pin before implementation; not read in this session)
