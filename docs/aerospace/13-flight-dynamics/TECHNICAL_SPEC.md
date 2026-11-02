# Gap 13 FLT — Technical specification

Specification only (2026-11-02). Ids `TR-FLT-nn`. Validation cases in [validation/README.md](validation/README.md).

## 1. Current state in llull (audit 2026-11-02, source read, nothing executed)

| Area            | What exists                                                                                                                                                                                                                                                   | Limit for flight                                                                                                                                                                                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rigid bodies    | `add_rigid_body`, `add_body_joint`, `simulate_motion`, `plot_simulation`, `render_motion`, `inspect_dynamics` (`packages/domain-dynamics/src/commands/*`). A non-fixed body with no joint is free: `packages/physics-mujoco/src/mjcf.ts` emits `<freejoint/>` | Fine as the 6-DOF integrator (MuJoCo 3.16 WASM, RK4 default; ≤ 600 s, ≤ 1e6 steps, ≤ 6001 samples)                                                                                                                                                                                                                                        |
| Propellers      | `add_propeller`: T = Ct·ρ·n²·D⁴, P = Cp·ρ·n³·D⁵, Q = P/(2πn); optional [J, Ct, Cp] table, PCHIP, `airspeedMps`, warning `FPR_OUTSIDE_VALIDATED_RANGE` (`sim/forceLaws.ts`, `sim/propellerTable.ts`, `core/src/model/dynamics.ts`)                             | `thrustDirection` is a **fixed world vector** applied at the rotor COM; `airspeedMps` is a constant; the load callback's `SimulationState` holds joint positions / velocities only, **no body pose or twist** (`packages/core/src/dynamics/physicsEngine.ts`). docs/DYNAMICS.md: "static (no forward speed) … no blade-element model yet" |
| Motors / servos | `add_motor`: torque curve or speed governor (PD servo, `targetVelocity`, `maxForce`, gain schedule `servoSchedule.ts`)                                                                                                                                        | No electrical model, no battery, no position-setpoint scenario for a wing pivot                                                                                                                                                                                                                                                           |
| Reactions       | per-joint force / moment, peaks and times (`sim/reactions.ts`, `reactionsView.ts`)                                                                                                                                                                            | No export to FEA (FR-RBD-12 in docs/physics/10 is specified, not built)                                                                                                                                                                                                                                                                   |
| Aero            | `standard_atmosphere`, `analyze_airfoil`, `analyze_wing`, `analyze_vortex_lattice` / native `vortex_lattice_solve`, `drag_buildup`, `compute_aero_drag` (`packages/domain-aero/src/aerodynamics`)                                                             | One free-stream condition per call, inviscid, no stall, no per-panel force output in the model frame, no table sweep                                                                                                                                                                                                                      |
| CFD             | `create_cfd_case` … `cfd_solve` (native LBM D3Q19 + Smagorinsky, CPU / wgpu; `solver/crates/llull-flow-lbm`)                                                                                                                                                  | Steady / time-averaged; no rotating parts or actuator disks (12 CFD V2)                                                                                                                                                                                                                                                                   |
| V&V             | `compare_to_expected`, `check_convergence`, `check_timestep_convergence` (`packages/domain-cae/src/vnv/*`)                                                                                                                                                    | Reusable as is                                                                                                                                                                                                                                                                                                                            |

## 2. Target architecture

- **Plugin**: extend `packages/domain-dynamics` (toolset `assembly`, new toolset view `flight`) — flight is rigid-body
  dynamics plus force laws; a separate plugin would duplicate the body / joint model (L10: new capability in its plugin).
- **Core port change (the one core change)**: `PhysicsEngine` load callbacks receive, per body, the world pose
  (position, quaternion) and twist (linear and angular velocity, world and body frame) — `SimulationState.bodies`. Force
  laws return wrenches **in the frame they declare** (`frame: 'world' | 'body'`); the engine rotates body-frame wrenches
  with the step-midpoint pose (same midpoint rule as `applyLoads` today). TR-FLT-01.
- **Controller loop**: a fixed-rate discrete controller (default 400 Hz, physics 1–2 kHz) evaluated between physics
  substeps inside the engine adapter; state is plain data in the run (pure, seeded, deterministic, FR-FLT-16).
- **Native path**: the controller, mixer, wind and battery laws are pure TS first (they are cheap); the 6-DOF loop stays
  in MuJoCo. A Rust `llull-flight` crate is a later option only if profiling shows the TS callbacks dominate (C7: do not
  port a working part without cause).
- **SITL bridge**: a server host transport (`server/src/flight/sitlBridge.ts`), localhost UDP / process spawn only,
  never a command side effect (L6, AF-41 offline). The command `sitl_bridge` validates and records; the host runs it.
- Laws: commands pure (L1/L3), document = recipe (L8) — the vehicle, aero tables and scenarios are document data and
  regenerate with the design parameters.

## 3. Data model (sketch)

```ts
// packages/domain-dynamics/src/model/flight.ts (plugin document slice `flight`)
interface FlightVehicle {
  id: string;
  bodyIds: string[];
  referenceBodyId: string;
  frame: 'FRD' | 'FLU';
}
interface Rotor {
  id: string;
  bodyId: string;
  hubPoint: Vec3;
  axisBody: Vec3;
  spin: 'cw' | 'ccw';
  diameterM: number;
  table: { rows: [J: number, ct: number, cp: number][]; source: SourceRef; grade: 'A' | 'B' | 'C' };
  hForceCoeff?: number;
  motorId: string;
}
interface Motor {
  id: string;
  kv: number;
  resistanceOhm: number;
  noLoadCurrentA: number;
  escEfficiency: number;
  maxCurrentA: number;
}
interface Battery {
  id: string;
  cells: { series: number; parallel: number };
  ocv: [soc: number, volt: number][];
  internalResistanceOhm: number;
  capacityAh: number;
  cutoffVoltPerCell: number;
  source: SourceRef;
}
interface AeroSurface {
  id: string;
  bodyId: string;
  refPoint: Vec3;
  refAreaM2: number;
  refChordM: number;
  pivotJointId?: string;
  table: AeroTable;
}
interface AeroTable {
  alphaDeg: number[];
  pivotDeg?: number[];
  cl: number[][];
  cd: number[][];
  cm: number[][];
  validity: { alphaDeg: [number, number]; reynolds: [number, number] };
  provenance: 'vlm+polar' | 'cfd' | 'measured';
  unverified: boolean;
}
interface BodyDrag {
  bodyId: string;
  cdaM2: Vec3;
} // per body axis
interface Wind {
  steady: Vec3;
  gusts: { t0: number; duration: number; peak: Vec3 }[];
  turbulence?: { model: 'dryden'; intensity: number; seed: number };
}
interface Controller {
  kind: 'cascaded_pid';
  rateHz: number;
  loops: PidLoop[];
  mixer: number[][];
  outputs: OutputChannel[];
}
interface Scenario {
  id: string;
  durationS: number;
  setpoints: { t: number; position?: Vec3; yawDeg?: number; pivotDeg?: Record<string, number> }[];
  wind?: Wind;
  initialSoc: number;
}
```

Document version: plugin slice added with an empty default; no migration of existing documents (owner rule: no
backward-compat shims).

## 4. Commands

| Command                             | Kind                        | Params sketch                                                        | Notes / failures                                                                                                                                                                                               |
| ----------------------------------- | --------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `define_flight_vehicle`             | mutating                    | bodyIds, referenceBodyId, frame                                      | `FLT_BODY_NOT_FREE` if the reference body has a joint to ground                                                                                                                                                |
| `add_rotor`                         | mutating                    | bodyId, hubPoint, axis, spin, diameter, table \| tableRef, motorId   | replaces `add_propeller` for free flight; `FLT_TABLE_SOURCE_MISSING`                                                                                                                                           |
| `add_flight_motor`, `add_battery`   | mutating                    | §3 fields + source                                                   | `FLT_ECM_INVALID` (OCV not monotone)                                                                                                                                                                           |
| `generate_aero_table`               | mutating                    | surfaceEntityIds, alphaRange, pivotRange, polar (section CL/CD vs α) | runs VLM per (α, pivot) through `ctx.registry` (`vortex_lattice_solve` native when large), adds viscous CD and stall from the polar; result `provenance: 'vlm+polar'`, `unverified` unless the polar is graded |
| `add_aero_surface`, `set_body_drag` | mutating                    | §3                                                                   | `FLT_AERO_TABLE_RANGE`                                                                                                                                                                                         |
| `set_wind`                          | mutating                    | §3 `Wind`                                                            | seeded, deterministic                                                                                                                                                                                          |
| `add_flight_controller`             | mutating                    | loops, gains, mixer, limits, lags                                    | `FLT_MIXER_RANK` if the mixer cannot command the 4 axes                                                                                                                                                        |
| `define_flight_scenario`            | mutating                    | §3 `Scenario`                                                        |                                                                                                                                                                                                                |
| `run_flight`                        | read-only (records nothing) | scenarioId, timestep, detail                                         | returns series + report; `FLT_DIVERGED` (attitude > 90° or NaN) with the time and state                                                                                                                        |
| `record_flight_run`                 | mutating                    | summary from a host run                                              | same trust model as `record_cfd_results`                                                                                                                                                                       |
| `flight_report`                     | read-only                   | runId                                                                | verdicts vs limits (thrust margin ≥ 30 %, saturation < 5 %, battery cut-off not reached …, all named and overridable)                                                                                          |
| `trim_flight`, `linearize_flight`   | read-only                   | condition                                                            | trim state, A/B, eigenvalues + mode labels (V1)                                                                                                                                                                |
| `sitl_bridge`                       | mutating (records session)  | autopilot: `ardupilot_json` \| `px4`, port                           | host transport; `FLT_SITL_TOOL_MISSING`, `FLT_SITL_TIMEOUT` (V1)                                                                                                                                               |
| `export_flight_loads`               | mutating                    | runId, at: time \| `peak_load` \| `envelope`                         | creates 14 FLL load cases; see 14 TECHNICAL_SPEC                                                                                                                                                               |

Every command: `defineCommand` + zod params + `@affects @invariant @failure` + happy / failure tests (NON-NEGOTIABLE 2).

## 5. Algorithms

- **Rotor law (TR-FLT-02)**: V_axial = (v_hub_world − w_world) · a_world, with v_hub = v_cg + ω × r and a_world the rotor
  axis rotated by the body quaternion; J = V_axial/(nD); CT, CP by PCHIP in J (existing `propellerTable.ts`); T = CT ρ n² D⁴
  along a_world, Q = CP ρ n² D⁵/(2π) about −spin·a_world; optional H-force = k_H · T · v_inplane (flagged empirical).
  ρ from `standard_atmosphere` at the vehicle altitude.
- **Motor / ESC / battery (TR-FLT-06)**: ω_cmd from throttle; motor dynamics I·dω/dt = Kt·i − Q − b·ω with
  Kt = 60/(2π·Kv) (SI); i from V_esc = Kt·ω + R·i; battery V = OCV(SoC) − R_int·I_total; dSoC/dt = −I/(3600·C).
  The QPROP motor model [R4] is the reference formulation.
- **Aero surfaces (TR-FLT-03)**: local velocity at the reference point (including rotation and wind); α, β; bilinear
  table lookup in (α, pivot); forces in the wind frame rotated to the body; refuse outside validity unless
  `allowExtrapolation` is set (then `unverified`).
- **Wind (TR-FLT-04)**: 1-cosine gust v = (V_peak/2)(1 − cos(2π(t − t0)/T)); Dryden turbulence by filtered white noise
  with a seeded PRNG (`@lib` deterministic RNG).
- **Controller (TR-FLT-05)**: cascaded PID with anti-windup clamp; mixer `u = M · [T, τx, τy, τz]` → per-rotor thrust →
  ω via inverse rotor law; servo channels with rate limits.
- **Integration**: MuJoCo RK4, physics dt default 1 ms, controller at an integer divisor rate; `check_timestep_convergence`
  applies to any run.

## 6. Interop

- ArduPilot JSON SITL (V1): UDP, physics listens on 9002; SITL sends a packet with magic 18458 (16 channels), frame
  rate, frame count and pwm[16] in µs; llull answers JSON with timestamp, imu.gyro, imu.accel_body, NED position and
  velocity, attitude or quaternion; optional airspeed, wind, battery voltage and current [R6][R7].
- PX4 SITL (V1): Gazebo-style lockstep; llull replaces the physics side; `HEADLESS=1` style, external process [R8].
- Flight log export: CSV and a JSON series (same shape as `simulate_motion` series) for plotting tools.

## 7. Surfaces and error codes

CLI first (`llull run_flight …`); UI: replay in the viewport (existing `render_motion`), report panel. Codes:
`FLT_BODY_NOT_FREE`, `FLT_TABLE_SOURCE_MISSING`, `FLT_ECM_INVALID`, `FLT_AERO_TABLE_RANGE`, `FLT_MIXER_RANK`,
`FLT_DIVERGED`, `FLT_SITL_TOOL_MISSING`, `FLT_SITL_TIMEOUT`, warnings `FLT_OUTSIDE_VALIDATED_RANGE`,
`FLT_VORTEX_RING_RISK`, `FLT_GROUND_EFFECT_EMPIRICAL`.

## 8. Budgets

60 s scenario, 4 rotors + 4 surfaces, physics 1 kHz, controller 400 Hz: < 5 s wall on the desktop; memory < 200 MB;
series decimated to ≤ 6001 samples (existing cap) with peaks kept exactly.

## 9. Test strategy

Unit tests per law (rotor, motor, battery, aero table, wind, PID, mixer) against VC-FLT-01..09; golden `build_project`
plans for the reference drone hover and gust scenarios (VC-FLT-07, 09); timestep convergence (VC-FLT-14); contract test
that body-frame thrust rotates with attitude (VC-FLT-03); server test for the SITL bridge with a recorded packet
exchange (VC-FLT-10, no network beyond localhost).

## 10. Delivery plan

| Milestone   | Content                                                                                           | Depends on    |
| ----------- | ------------------------------------------------------------------------------------------------- | ------------- |
| FLT-M1      | Core port: body pose / twist in load callbacks; body-frame rotor law with J from state; body drag | —             |
| FLT-M2      | Controller, mixer, scenario, `run_flight`, `flight_report`                                        | M1            |
| FLT-M3      | Motor / ESC / battery chain, endurance                                                            | M2            |
| FLT-M4      | `generate_aero_table` (VLM sweep + polar), pivoting surfaces, wind and gusts                      | M1, 10 AER    |
| FLT-M5      | `export_flight_loads` → 14 FLL; trim and linearisation                                            | M2, 14 FLL-M1 |
| FLT-M6      | SITL bridges (ArduPilot JSON first, then PX4)                                                     | M3            |
| FLT-M7 (V2) | BEMT rotor, dataset replay / identification                                                       | M3            |

## 11. Open questions

- FLT-D1: keep the controller in TS inside the engine adapter, or a Rust crate from the start? Default: TS (C7, measure first).
- FLT-D2: bundle ArduPilot SITL binaries (GPL-3.0) or detect a user install? Default: detect, never bundle (legal check).
- FLT-D3: default rotor table for unknown props: none (refuse) vs a generic APC-like table flagged grade C. Default: refuse.

## 12. References

See [FUNCTIONAL_SPEC.md §11](FUNCTIONAL_SPEC.md#11-references) and [validation/sources.md](validation/sources.md).
