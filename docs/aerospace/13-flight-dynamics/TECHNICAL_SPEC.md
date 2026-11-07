# Gap 13 FLT — Technical specification

Specification 2026-11-02; FLT-M1 built 2026-11-07 (§13). Ids `TR-FLT-nn`. Validation cases in [validation/README.md](validation/README.md).

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
- FLT-D3: default rotor table for unknown props: none (refuse) vs a generic APC-like table flagged grade C. **Decided: refuse** (§13).
- FLT-D4..D8 decided with FLT-M1 (§13): world wrenches from the laws, plugin slice `flight`, world twist in the port, constant rotor speed
  until M2, validated J ranges.

## 12. References

See [FUNCTIONAL_SPEC.md §11](FUNCTIONAL_SPEC.md#11-references) and [validation/sources.md](validation/sources.md).

## 13. Implementation status — FLT-M1 (2026-11-07)

**Audit re-verified against main 5a15f6378 (after DRV-M1..M4).** The §1 rows hold for propellers (`thrustDirection` is a world vector,
`airspeedMps` a constant, `SimulationState` had joint state only), rigid bodies and aero. Two rows were out of date: motors now have
datasheet DC / PMSM / stepper / induction models with current, voltage, thermal and an energy ledger (DRV-M1..M4: `add_motor`,
`set_motor_drive`), still no battery; and `add_load_schedule` already applied a world force at a body's centre of mass (no moment). The
load callbacks are composed by wrappers (`withCylinderForces`, `withInstalledLosses`, `withLoadSchedules`) that rebuild
`{ jointForces, bodyForces }`, so the flight wrapper is the outermost one (it is the only one that adds moments).

**Built (TR-FLT-01, TR-FLT-02, the drag part of TR-FLT-03).**

| Item                                                                                                                                                                                                                                                                                                                                                                            | Where                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Port: `BodyKinematics` (world COM position, rotation from t = 0, COM velocity, angular velocity), `SimulationState.bodies` for the bodies of `SimulationModel.bodyStates`, `AppliedLoads.bodyMoments` (world N·m about the COM), `SimulationTrace.bodyVelocity`                                                                                                                 | `packages/core/src/dynamics/physicsEngine.ts`                       |
| MuJoCo: a kinematics pass (`mj_kinematics` + `mj_comPos` + `mj_comVel`) before the loads, COM velocity from `cvel` shifted from the root subtree COM, the step-midpoint rule of the joint state (position + h/2·v, orientation advanced by ω·h/2, velocities extrapolated from the last step), moments into `xfrc_applied[3..5]`; nothing extra runs when `bodyStates` is empty | `packages/physics-mujoco/src/bodyKinematics.ts`, `mujocoPhysics.ts` |
| Slice `doc.flight` `{ rotors, bodyDrag }` (plugin `dynamics`), validated on load by a zod schema plus key / id / body cross-checks                                                                                                                                                                                                                                              | `packages/domain-dynamics/src/flight/{model,document}.ts`           |
| Rotor law: v_hub = v + ω × r, J = (v_hub · a)/(nD), Ct / Cp static or PCHIP table (slopes compiled once per run), T along a at the hub (r × F), reaction -s·Q·a, gyroscopic -ω × (I_s·2πn·s·a); body drag -½ρ·CdA_i·\|v\|·v_i in the body axes                                                                                                                                  | `flight/rotorLaw.ts`, `flight/frames.ts`, `flight/flightLoads.ts`   |
| `add_rotor`, `set_body_drag`; `delete_dynamics_item` removes a rotor by id and cascades a body's rotors and drag                                                                                                                                                                                                                                                                | `commands/flight.ts`, `commands/bodies.ts`                          |
| `simulate_motion` `data.flight` (per rotor: final thrust / torque / power, J min / max / final, samples outside the validated range; per drag body: speed and force; series with detail "series"), the laws re-evaluated on the recorded states; warnings `FLT_OUTSIDE_VALIDATED_RANGE`, `FLT_ENERGY_UNCOUNTED`                                                                 | `flight/flightReport.ts`, `commands/simulate.ts`                    |

**Validation (`tests/unit/flight/`).** VC-FLT-01 (z = -g t²/2 at 2 s, < 1e-6 rel, at engine level and with an idle rotor so the body-state
pass is active), VC-FLT-03 (four rotors tilted 20°: horizontal acceleration g·tan 20° = 3.5693 m/s² within 0.1 %, vertical < 1e-3 m/s²,
attitude held), VC-FLT-04 (7.8404 N, 88.570 W within 0.5 %), VC-FLT-05 (J = 0.267 from a body held at 6.8078 m/s, T = 4.5420 N within
0.5 %, no range warning), VC-FLT-08 (yaw acceleration 0.83333 rad/s² within 1e-6 rel, through the port and through a rotor's reaction
torque). Added closed forms: body-frame thrust of an off-centre rotor (pitch θ = -F r t²/(2 I_yy), position = double integral of
F·R(θ(t))·ẑ, < 1e-5 rel); gyroscopic precession of a gyrostat under a body torque τ (ω_x = (τ/h) sin Ωt, ω_y = (τ/h)(1 - cos Ωt), Ω = h/I,
orientation integrated from the closed form, < 1e-5 per quaternion component; mean precession rate τ/h); terminal velocity under body
drag (z = -(v_t²/g) ln cosh(g t/v_t), < 1e-5 rel); midpoint twist of a jointed body (v = ω × r). A model with no rotor or drag gives
byte-identical `simulate_motion` data (`flightBaseline.test.ts`, hash taken before the change; the FR-FPR-19 legacy hashes are unchanged).
Not in M1: VC-FLT-02 (needs an initial body twist: the scenario of FLT-M2), VC-FLT-06 / 09 (`flight_report` / trim, FLT-M2 / M5).

**Decisions.**

- **FLT-D3 (default rotor table)**: refuse, as proposed. `add_rotor` has no default coefficients; a static pair or a table without a
  source is `FLT_TABLE_SOURCE_MISSING`. Rejected: a generic grade-C APC-like table (it would silently stand in for data nobody measured).
- **FLT-D4 (frame of a law's wrench)**: the engine gives the laws the midpoint pose; the laws rotate their own body-fixed vectors and return
  WORLD forces and moments. Rejected: a `frame: 'world' | 'body'` tag in `AppliedLoads` (every engine would implement the rotation and the
  midpoint pose a second time; one pure-TS place is enough and is testable without an engine).
- **FLT-D5 (where rotors live)**: a plugin slice `doc.flight` owned by the dynamics plugin (L10), referencing `doc.dynamics` bodies by id.
  Rejected: new fields on core `DynamicsModel` / `PropellerLoad` (a core model change for a plugin capability). Cost: rotor ids are checked
  against both id spaces when created; a later explicit dynamics id equal to a rotor id makes `delete_dynamics_item` remove both.
- **FLT-D6 (twist frames in the port)**: world angular and linear velocity plus the orientation only; body-frame values are one rotation in
  the law (`flight/frames.ts`). Rejected: both frames in the port (redundant data every engine must keep consistent).
- **FLT-D7 (rotor speed in M1)**: a constant `rpm` per rotor (no spin-up torque, dΩ/dt = 0); the controller (M2) and the motor chain (M3)
  will command it. Rejected: driving it from a motion profile now (a second speed source the controller would have to replace).
- **FLT-D8 (validated range)**: a static pair is validated at |J| <= 0.05; a table over its J span (J below the first row, e.g. descent, is
  held at the first row and flagged). Air density is a per-record constant (default ISA sea level), not yet `standard_atmosphere` at altitude.
- **Energy**: rotor and drag work on the bodies is not integrated into the balance (the engine reports joint work only); a run with energy
  on says so (`FLT_ENERGY_UNCOUNTED`) instead of leaving it unexplained in `balanceErrorJ`.
