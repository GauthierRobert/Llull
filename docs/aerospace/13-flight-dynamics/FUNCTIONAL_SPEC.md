# Gap 13 FLT — Flight dynamics and flight simulation (6-DOF, rotors, controller in the loop)

Status: specification 2026-11-02; **FLT-M1 built** 2026-11-07 (body-frame rotors `add_rotor`, body drag `set_body_drag`, body state in the
physics port; TECHNICAL_SPEC §13). Follows [`../TEMPLATE.md`](../TEMPLATE.md) and
[`../AGENT_FIRST.md`](../AGENT_FIRST.md). Companion pack: [14 FLL](../14-flight-loads-aeroelasticity/FUNCTIONAL_SPEC.md)
(flight loads into structural analysis).

## 1. Summary

llull can design an aircraft or a drone, compute its mass properties, analyse its wing (lifting line, vortex lattice,
LBM CFD) and its structure (CalculiX), and simulate mechanisms (MuJoCo). It **cannot fly it**: no command answers
"does this vehicle hover, how does it respond to a gust or a stick input, how long does it fly on this battery, and which
loads does a manoeuvre put on the structure". The pieces exist (free rigid bodies, propeller coefficient laws, motors,
VLM, atmosphere) but they are not connected into a flight model:

- propeller thrust is a fixed **world** vector applied at the rotor centre, so a tilting airframe keeps thrusting
  straight up, and the advance ratio uses a constant user airspeed instead of the vehicle's velocity
  (`packages/domain-dynamics/src/sim/forceLaws.ts`, `packages/core/src/dynamics/physicsEngine.ts`, see TECHNICAL_SPEC §1);
- there is no aerodynamic force on bodies (drag, wing lift), no wind, no sensors, no controller, no mixer, no battery,
  no scripted mission, and no link to an autopilot (PX4 / ArduPilot).

This pack makes llull fly a vehicle from its CAD model: a 6-DOF free-flight model with body-frame rotor forces, aero
tables derived from llull's own VLM, a cascaded controller and mixer (or an external autopilot through software-in-the-loop),
a motor / ESC / battery chain, wind, and flight reports as numbers. FEA is **not** the right tool for this: FEA answers
"does the structure hold under these loads"; flight dynamics produces those loads. Pack 14 FLL carries them into FEA.

## 2. Aerospace context and value

- **Multirotor and hybrid VTOL design**: hover power, endurance, control authority (thrust margin, yaw authority from
  rotor torque), response to gusts, tilt-wing or pivoting-wing transitions. Done today with PX4 / ArduPilot SITL plus
  Gazebo, JSBSim, RotorPy, MATLAB/Simulink, or vendor tools, all disconnected from the CAD model.
- **Fixed-wing small UAS**: trim, static margin (llull already gives the neutral point from VLM), dynamic modes
  (phugoid, short period, Dutch roll) and the flight envelope.
- **Design loop**: the CAD change (arm length, wing chord, battery position) must regenerate the mass, inertia, aero and
  flight results in one parametric replay. That is llull's differentiator (parametric `.lld` designs, L8).

Reference vehicle for the validation pack: the "wing quad lite" designed in llull (1.115 kg, four 10-inch 2-blade props
on diagonal struts, four servo-pivoted elliptical wings, 4S2P Li-ion).

## 3. Personas and user stories

| Persona              | Story                                                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator (CLI agent) | "Fly the current design: hover 30 s, climb 5 m, forward 8 m/s with a 3 m/s side gust; give me thrust margin, power, attitude error and endurance as data." |
| Owner (non-engineer) | "Will my drone fly, for how long, and is it stable?" One verdict with named assumptions.                                                                   |
| Owner (developer)    | "Run my own controller / ArduPilot Lua mixer against the llull model before I build it."                                                                   |
| Qualified reviewer   | Signs off flight-envelope results used for a safety case (SORA / design verification), with the model's validity range shown.                              |

## 4. Scope

**MVP (FLT-M1..M3)**

- Body-frame rotor forces and torques on a free 6-DOF body (thrust follows attitude), advance ratio from the
  rotor's own axial velocity, reaction torque on the airframe, rotor drag (H-force) as an optional coefficient.
- Aero forces on bodies: drag area (CdA) per axis and lift / drag / moment tables per lifting surface, vs angle of
  attack and pivot angle, generated from `analyze_vortex_lattice` (inviscid) plus a section polar (viscous) with stall.
- Wind: constant + gust (1-cosine) + turbulence (Dryden, seeded) in the world frame.
- Built-in controller: cascaded PID (position → velocity → attitude → rate), a mixer matrix (rotors + servo channels),
  actuator limits and first-order motor / servo lags; scenario of setpoints over time.
- Motor + ESC + battery chain: Kv, Kt, winding resistance, no-load current, ESC efficiency, battery equivalent-circuit
  model (OCV(SoC), internal resistance), cut-off voltage → endurance.
- `run_flight` result as data: trajectories, attitudes, rotor speeds, currents, SoC, thrust margin, saturation time,
  tracking error, energy, plus the per-joint / per-mount reaction history for 14 FLL.

**V1 (FLT-M4..M5)**

- Software in the loop: ArduPilot JSON SITL backend (UDP, documented protocol) and PX4 SITL (external process, lockstep),
  localhost only. llull is the physics; the autopilot is the real flight code.
- Linearisation and trim: trim states for hover / forward flight, A, B matrices, eigenvalues (dynamic modes) as data.
- Ground contact (landing gear springs / dampers), ground effect (rotor) as an optional factor.

**V2**

- Blade element momentum theory (BEMT) rotor model from the blade geometry in the CAD model (chord, twist, airfoil polars).
- Dataset replay: drive the model with logged motor speeds and compare to logged accelerations (NeuroBEM / Blackbird class
  datasets) to identify parameters.
- Unsteady CFD-derived corrections (prop wash on wings) from 12 CFD actuator disks.

**Out of scope**: certified flight-model qualification (FAA / EASA FSTD levels), real-time HIL with hardware I/O, vortex
ring state high-fidelity modelling (flagged as a validity limit instead), multiplayer / visual flight simulator graphics.

## 5. Functional requirements

| Id        | Pri    | Requirement                                                                                                                                                                           | Rationale                                                        | Source                   |
| --------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------ |
| FR-FLT-01 | MUST   | A vehicle body can fly freely in 6-DOF with gravity; rotor thrust and torque act along the rotor axis **in the body frame**                                                           | Thrust must tilt with the airframe; today it is a world vector   | audit, TECHNICAL_SPEC §1 |
| FR-FLT-02 | MUST   | Rotor coefficients follow the advance ratio J = V_axial/(nD) computed from the vehicle state, with measured CT(J), CP(J) tables (graded source) and a warning outside the table range | Forward flight changes thrust and power [R1][R2]                 | [R1][R2]                 |
| FR-FLT-03 | MUST   | Body drag (CdA per body axis) and lifting-surface tables (CL, CD, Cm vs α and pivot angle) act at a named point; tables can be generated from llull's VLM plus a section polar        | Wings and fuselage drag drive forward-flight power and stability | 10 AER                   |
| FR-FLT-04 | MUST   | Wind model: steady, discrete gust, seeded turbulence                                                                                                                                  | Gust response is the first question for small UAS                | —                        |
| FR-FLT-05 | MUST   | Controller in the loop: cascaded PID with named gains, mixer matrix, actuator limits and lags, scenario setpoints vs time                                                             | A multirotor is unstable without control                         | —                        |
| FR-FLT-06 | MUST   | Electric chain: motor (Kv, R, I0), ESC efficiency, battery ECM with cut-off; report current, SoC, endurance                                                                           | Endurance is the owner's first metric                            | [R4] QPROP motor models  |
| FR-FLT-07 | MUST   | Flight report as data: thrust margin, saturation fraction, tracking error, power, energy, endurance, max attitude, max rates, verdict PASS / MARGINAL / FAIL against named limits     | AF numeric equivalents                                           | AGENT_FIRST              |
| FR-FLT-08 | MUST   | Every result carries its validity envelope (J range of tables, α range of aero tables, Reynolds range) and `unverified` when an input is defaulted                                    | No silent extrapolation                                          | AGENT_FIRST AF-31/32     |
| FR-FLT-09 | MUST   | Reaction history at every rotor mount, wing pivot and payload mount, exportable to 14 FLL load cases                                                                                  | Flight loads feed FEA                                            | 14 FLL                   |
| FR-FLT-10 | SHOULD | Trim and linearisation: trim states, A/B matrices, eigenvalues with mode names                                                                                                        | Stability and controller design                                  | —                        |
| FR-FLT-11 | SHOULD | ArduPilot JSON SITL bridge (localhost UDP) and PX4 SITL bridge (external process)                                                                                                     | Fly the real autopilot code against the CAD-derived model        | [R6][R7][R8]             |
| FR-FLT-12 | SHOULD | Pivoting / tilting surfaces driven by servo channels with rate and angle limits                                                                                                       | The reference vehicle's wings                                    | —                        |
| FR-FLT-13 | SHOULD | Ground contact and rotor ground effect (optional factor, flagged as model-limited)                                                                                                    | Take-off and landing loads                                       | [R11]                    |
| FR-FLT-14 | COULD  | BEMT rotor model from blade geometry                                                                                                                                                  | Props without measured tables                                    | [R9][R10]                |
| FR-FLT-15 | COULD  | Dataset replay and parameter identification against flight logs                                                                                                                       | Model calibration                                                | [R12][R13]               |
| FR-FLT-16 | MUST   | Deterministic: same document, scenario and seed give bit-identical results; timestep convergence check available                                                                      | Replay, tests, golden plans (L8)                                 | PHY-00                   |

## 6. Workflows (CLI first)

```bash
llull run fly.json --doc drone.llull.json      # builds the flight model from the design, then:
llull run_flight scenarioId=hover_climb_gust --doc drone.llull.json --json
llull flight_report runId=... --doc drone.llull.json
llull plot_flight runId=... field=attitude --save att.svg
llull export_flight_loads runId=... at=peak_load --doc drone.llull.json   # -> 14 FLL load cases
llull sitl_bridge autopilot=ardupilot_json --doc drone.llull.json         # V1, localhost only
```

The plan `fly.json` declares the vehicle (`define_flight_vehicle` from rigid bodies), rotors (`add_rotor`), aero surfaces
(`add_aero_surface`, tables from `generate_aero_table`), the battery and electric chain, the controller and a scenario.
The UI shows the replay (existing `render_motion` path) and the report; it is a review surface, not the entry point.

## 7. Acceptance criteria

- Given a free body with four body-fixed rotors at constant equal thrust tilted 20° in pitch, when it flies, then its
  horizontal acceleration equals g·tan 20° = 3.5693 m/s² within 0.1 % (VC-FLT-03).
- Given the APC SF 10x4.7 static table, when a rotor spins at 6528 rpm, then thrust is 7.840 N and shaft power 88.57 W
  within 0.5 % (VC-FLT-04), and the figure of merit reported is 0.7035 (VC-FLT-06).
- Given the reference drone at 1.115 kg, when it hovers, then rotor speed is 4083 rpm ± 1 % and shaft power
  76.0 W ± 1 % with the UIUC 4029 rpm coefficients (VC-FLT-09).
- Given a hover scenario with a 1-cosine gust, when the controller runs, then the report gives the max attitude excursion,
  recovery time and saturation fraction as numbers and a verdict against the named limits (VC-FLT-07).
- Given any run, when it is replayed, then results are bit-identical, and a timestep halving changes the tracked quantity
  by less than the stated GCI band (VC-FLT-14).

## 8. Standards and regulatory alignment

- ASTM F3298-24 (design and construction of lightweight UAS) — scope is fixed-wing per its abstract; no flight-model
  clauses are claimed here [R14].
- EASA light-UAS means of compliance (design verification linked to SAIL; item "strength and deformation" under ED-325)
  — cited for context only, search-sourced, no load factors are taken from it [R15].
- Validation vocabulary: ASME V&V 10 / V&V 20 through PHY-00 (llull's harness).

## 9. KPIs

- 100 % of grade-A cases pass in CI; hover-power prediction within 10 % of a bench test on the first printed vehicle
  (owner measurement, logged as a grade-A local reference).
- A full 60 s scenario at 1 kHz physics runs in < 5 s on the desktop (MuJoCo native path).

## 10. Risks and assumptions

- Static or wind-tunnel CT/CP tables do not hold at high advance ratio in descent (vortex ring state) [R1]; the model
  flags descent rates above a threshold instead of pretending accuracy.
- Prop wash on the wings and wing–rotor interference are not captured by VLM; V1 uses an empirical slipstream factor
  (flagged `unverified`), V2 uses 12 CFD actuator disks.
- GPL autopilots (ArduPilot) run as separate processes, never linked (licence boundary; legal confirmation pending).
- Printed-part flexibility is ignored in flight (rigid bodies); 14 FLL checks it afterwards.

## 11. References

See [validation/sources.md](validation/sources.md) for grades and access notes.

- [R1] Bangura and Mahony, Nonlinear dynamic modeling for high performance control of a quadrotor, ACRA 2012 — ANU — https://researchportalplus.anu.edu.au/en/publications/nonlinear-dynamic-modeling-for-high-performance-control-of-a-quad/ (search-only)
- [R2] UIUC Propeller Data Site — University of Illinois — https://m-selig.ae.illinois.edu/props/propDB.html (accessed 2026-11)
- [R4] QPROP — M. Drela, MIT — https://web.mit.edu/drela/Public/web/qprop/ (accessed 2026-11)
- [R6] SITL JSON backend readme — ArduPilot — https://github.com/ArduPilot/ardupilot/blob/master/libraries/SITL/examples/JSON/readme.md (accessed 2026-11)
- [R7] SITL with JSON — ArduPilot docs — https://ardupilot.org/dev/docs/sitl-with-JSON.html (accessed 2026-11)
- [R8] Gazebo simulation with PX4 — PX4 docs — https://docs.px4.io/main/en/sim_gazebo_gz/ (accessed 2026-11)
- [R9] CCBlade — NREL / WISDEM — https://github.com/WISDEM/CCBlade (accessed 2026-11)
- [R10] NeuroBEM — UZH Robotics and Perception Group — https://rpg.ifi.uzh.ch/NeuroBEM.html (accessed 2026-11)
- [R11] Ground effect on multirotors (Sanchez-Cuevas et al.) — Univ. Sevilla repository — https://idus.us.es/handle/11441/94910 (search-only)
- [R12] Blackbird dataset — MIT AERA — https://github.com/mit-aera/Blackbird-Dataset (accessed 2026-11)
- [R13] RotorPy — https://github.com/spencerfolk/rotorpy (accessed 2026-11)
- [R14] ASTM F3298-24 — ASTM — https://store.astm.org/f3298-24.html (catalogue page, accessed 2026-11)
- [R15] EASA light-UAS means of compliance — EASA — https://www.easa.europa.eu/sites/default/files/dfu/crd_moc_light-uas-2511.pdf (search-only)
