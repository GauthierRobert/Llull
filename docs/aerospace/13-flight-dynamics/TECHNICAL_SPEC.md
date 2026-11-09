# Gap 13 FLT — Technical specification

Specification 2026-11-02; FLT-M1 built 2026-11-07 (§13); FLT-M2 built 2026-11-08 (§14); FLT-M3 built 2026-11-09 (§15). Ids `TR-FLT-nn`. Validation cases in [validation/README.md](validation/README.md).

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
| `trim_flight`, `linearize_flight`   | read-only                   | condition                                                            | trim state, A/B, eigenvalues + mode labels (built, §17)                                                                                                                                                        |
| `sitl_bridge`                       | mutating (records session)  | autopilot: `ardupilot_json` \| `px4`, port                           | host transport; `FLT_SITL_TOOL_MISSING`, `FLT_SITL_TIMEOUT` (V1)                                                                                                                                               |
| `export_flight_loads`               | mutating                    | runId, at: time \| `peak_load` \| `envelope`                         | creates 14 FLL load cases; see 14 TECHNICAL_SPEC (built in FLL-M2: the run id is the scenario id, FLL-D9)                                                                                                      |

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
| FLT-M4      | `generate_aero_table` (VLM sweep + polar), pivoting surfaces, wind and gusts (built, §16)         | M1, 10 AER    |
| FLT-M5      | `export_flight_loads` → 14 FLL (built in 14 FLL-M2, audited); trim and linearisation (built, §17) | M2, 14 FLL-M1 |
| FLT-M6      | SITL bridges (ArduPilot JSON first, then PX4)                                                     | M3            |
| FLT-M7 (V2) | BEMT rotor, dataset replay / identification                                                       | M3            |

## 11. Open questions

- FLT-D1: keep the controller in TS inside the engine adapter, or a Rust crate from the start? **Decided: TS** (§14; measured: a 60 s
  closed-loop flight at 2 kHz runs in 2.6 s, inside the 5 s budget). The controller runs as an in-process actuator block on every physics
  tick, so a Rust sidecar would add one IPC round-trip per tick (120 000 for that flight); a Rust port only pays if the whole loop, physics
  included, moves native.
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
  against both id spaces when created, and every plugin command that creates a dynamics record checks the rotors too
  (`idTakenInDynamicsOrFlight`); `add_motion_profile` lives in core and cannot see `doc.flight`, so a profile may still take a rotor's id:
  `delete_dynamics_item` then refuses the ambiguous id instead of removing both, and load validation refuses a rotor key that is also a
  `doc.dynamics` id (hand-edited files). A body referenced by a rotor or a drag is never fixed (load validation); a future `set_body_fixed`
  must cascade or refuse.
- **FLT-D6 (twist frames in the port)**: world angular and linear velocity plus the orientation only; body-frame values are one rotation in
  the law (`flight/frames.ts`). Rejected: both frames in the port (redundant data every engine must keep consistent).
- **FLT-D7 (rotor speed in M1)**: a constant `rpm` per rotor (no spin-up torque, dΩ/dt = 0); the controller (M2) and the motor chain (M3)
  will command it. Rejected: driving it from a motion profile now (a second speed source the controller would have to replace).
- **FLT-D8 (validated range)**: a static pair is validated at |J| <= 0.05; a table over its J span (J below the first row, e.g. descent, is
  held at the first row and flagged). Air density is a per-record constant (default ISA sea level), not yet `standard_atmosphere` at altitude.
- **Energy**: rotor and drag work on the bodies is not integrated into the balance (the engine reports joint work only); a run with energy
  on says so (`FLT_ENERGY_UNCOUNTED`) instead of leaving it unexplained in `balanceErrorJ`.

## 14. Implementation status — FLT-M2 (2026-11-08)

**Built (TR-FLT-05, the steady + gust part of TR-FLT-04, FR-FLT-07 / 08 / 16 for the flight report).**

| Item                                                                                                                                                                                                                                                                                                                                        | Where                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Port: `ActuatorBlock.advance` may return `bodyMoments` (world N·m about the centre of mass); `SimulationBody.initialTwist` (free body: COM velocity + angular velocity at t = 0, world). MuJoCo adds the moments to `xfrc_applied[3..5]` and writes the twist into the freejoint `qvel` (`body_dofadr`)                                     | `packages/core/src/dynamics/physicsEngine.ts`, `packages/physics-mujoco/src/mujocoPhysics.ts` |
| Quaternion product / relative rotation moved from the adapter to `@lib/quaternion` (shared by the adapter and the controller, not duplicated)                                                                                                                                                                                               | `packages/core/src/lib/quaternion.ts`                                                         |
| Slice `doc.flight.controllers`, `doc.flight.scenarios` (optional tables), load validation (schema + keys, rotors on the body, set-point order, controller of the scenario's body); `delete_dynamics_item` removes them and cascades body -> rotors -> controllers -> scenarios                                                              | `flight/{controlModel,model,document}.ts`, `commands/bodies.ts`                               |
| Cascaded PID: position (P, speed limits) -> velocity (PID, m/s² out) -> thrust vector m(a - g) with a tilt limit -> attitude set-point (thrust axis along it, heading) -> quaternion error (P) -> body rate (PID, rad/s² out, rate limits) -> τ = Jα + ω × Jω; derivative on the measurement, conditional integration + clamp (anti-windup) | `flight/controller.ts`                                                                        |
| Mixer: effectiveness B (4 × N: collective along the mean rotor axis, r × a - s·κ·a with κ = Cp·D / (2π·Ct) at J = 0), pseudo-inverse Bᵀ(BBᵀ)⁻¹ or an explicit matrix, rank of B·M (FLT_MIXER_RANK), allocation giving up yaw first then clamping; thrust -> rpm by the inverse rotor law at J = 0                                           | `flight/mixer.ts`                                                                             |
| The loop as an engine actuator block: controller every 1/rateHz (whole physics steps, FLT_CONTROL_RATE), first-order rotor lag, every rotor's wrench under the wind, exact per-step peaks / integrals / counts in the aux state; combined with a datasheet-motor block when the model has one                                               | `flight/flightBlock.ts`, `flight/flightRun.ts`                                                |
| Wind: steady + 1-cosine gusts on the scenario, on rotor inflow and body drag                                                                                                                                                                                                                                                                | `flight/wind.ts`, `flight/flightLoads.ts`                                                     |
| Metrics (attitude / rate peaks, tracking, events + recovery, saturation, thrust margin, shaft energy / power, per-rotor final state, figure of merit, J validity, `defaulted` -> `unverified`), verdict PASS / MARGINAL / FAIL against named limits, timestep check (GCI of the max tilt over dt, dt/2, dt/4)                               | `flight/{flightMetrics,flightVerdict}.ts`, `commands/flightRun.ts`                            |
| Commands `add_flight_controller`, `define_flight_scenario` (mutating), `run_flight`, `flight_report` (read-only, kernel-optional)                                                                                                                                                                                                           | `commands/flightControl.ts`, `commands/flightRun.ts`                                          |
| Validation plans `sc-flt-01-hover`, `sc-flt-02-gust` (golden pins + replay equality)                                                                                                                                                                                                                                                        | `validation/plans/`, `tests/golden/fltPlans.test.ts`                                          |

**Validation (`tests/unit/flight/flightClosedLoop.test.ts`, MuJoCo 3.16, dt 0.5 ms, controller 400 Hz).** VC-FLT-09: the reference quad,
knocked at t = 0 (0.36 m/s, 0.37 rad/s), returns to a hover at 4082.56 rpm per rotor (expected 4082.5), 2.73364 N and 19.0122 W per rotor,
76.049 W shaft and 51.31 W ideal in total (gate 0.1 %, spec tolerance 1 %); with the controller update disabled the same test fails (the
vehicle tumbles: FLT_DIVERGED at 4.53 s). VC-FLT-06: static APC 10x4.7 at 6528 rpm: 7.84039 N, 88.5698 W, ideal 62.3082 W, FM 0.70349 (gate
0.5 %). VC-FLT-07: 3 m/s 1-cosine gust of 1 s in hover: max tilt, recovery, saturation fraction and verdict present and finite, two runs
bit-identical (JSON). Independent oracle: in a steady 3 m/s wind the settled tilt (20 s) is 0.57757° against
atan(½ρ·CdA·v² / m g) = 0.57768° (gate 0.1 %), tilting into the wind (negative pitch for a +x wind, positive roll for +y). Gust run: measured max tilt 0.3967°, the position error stays inside the 0.1 m band (recovery 0 s), saturation 0, verdict
PASS. VC-FLT-14: the gust's max tilt at 0.5 / 0.25 / 0.125 ms converges monotonically (0.396719 / 0.396723 / 0.396726°, observed order 0.97) with a GCI of 7.9e-6 (gate 1 %). VC-FLT-02:
torque-free body (I = 0.01 / 0.02 / 0.03 kg·m², 1 rev/s plus 1e-3 rad/s perturbation, 10 s, zero gravity): |H| drift < 1e-6 on all three
axes, spin about the intermediate axis reverses, the other two stay within 1 %. Also: step response (1.5 m offset + 30° heading: final
error < 2 cm and < 0.5°), initial twist (x = v t to 1e-9), saturation (maxRpm 4400: thrust-margin and saturation checks FAIL), a
sign-inverted mixer (run_flight FLT_DIVERGED, flight_report FAIL), refusals (FLT_SCENARIO_UNKNOWN, FLT_CONTROL_RATE, FLT_RUN_TOO_LONG incl.
the timestep-check budget, FLT_BODY_NOT_FREE, FLT_NO_ENGINE). Pure laws in `flightControlLaws.test.ts` (mixer inverse of a quad X, ranks,
yaw-first allocation, gust shape, attitude algebra, verdict bands, block composition, controller trim and anti-windup).

**Decisions.**

- **FLT-D9 (flight_report without runId)**: `flight_report` takes the scenario and re-runs it exactly as `run_flight` (deterministic,
  read-only) instead of reading a stored run by `runId`: `run_flight` records nothing (§4), storing traces would grow the document and a
  history replay would re-simulate them. `record_flight_run` stays the path for host runs (SITL, M6). Rejected: a mutating `run_flight`
  that stores its summary.
- **FLT-D10 (where the loop runs)**: the controller, mixer, lags and every rotor live in an engine `ActuatorBlock` (the existing port for
  stateful actuators: `advance` once per step at the midpoint state, state in `aux`), which needed `bodyMoments` in its output. The rotors
  leave the pure `loads` callback during `run_flight` (body drag stays there); `simulate_motion` keeps the M1 path unchanged. Rejected: a
  stateful `loads` closure (the port requires it pure) and a second engine loop in the adapter.
- **FLT-D11 (gains)**: normalised gains (the velocity loop outputs m/s², the rate loop rad/s²; the mass and the reference body's inertia
  come from the model), so the defaults fly any multirotor size; every defaulted input is listed in the record and in the results'
  `defaulted`, which makes them `unverified` (FR-FLT-08). Rejected: raw N / N·m gains (no default can suit every vehicle).
- **FLT-D12 (set-points)**: piecewise-constant holds; `position` is the offset of the centre of mass from its start, in metres, world axes
  (Z up); `yawDeg` the heading about world Z from the start heading; the first set-point is at t = 0. Rejected: absolute document
  coordinates (an agent does not know the centre of mass) and ramps (a step is the standard response test; a ramp can be a later field).
- **FLT-D13 (wind in M2)**: steady + 1-cosine gusts on the scenario now, because VC-FLT-07 / 14 need a gust; Dryden turbulence and a
  document-level `set_wind` stay in M4. The wind acts on rotor inflow and body drag through the air-relative body state.
- **FLT-D14 (mixer)**: default pseudo-inverse of the geometry; allocation gives up yaw before clamping (roll / pitch / thrust keep
  priority); `FLT_MIXER_RANK` is checked when the controller is added (arms about the hub centroid, no mass properties needed) and again
  at run time about the actual centre of mass. Rejected: a fixed quad-X table (no hexa / octo / tilted rotors).
- **FLT-D15 (thrust margin, verdict bands)**: thrust margin = 1 - weight / Σ T(maxRpm, J = 0) along the thrust axis (share of the maximum
  thrust left at hover; 0.3 = T/W 1.43). A check passing within 10 % of its limit is MARGINAL. Default limits: margin >= 0.3, saturation
  <= 5 %, tilt <= 45°, final error <= 0.1 m, recovery <= 5 s; all overridable, `limitsDefaulted` lists the defaults used.
- **FLT-D16 (start state)**: controlled rotors start at the speed of the first controller update at rest (trimmed), not at 0 rpm, so a run
  measures the flight, not a spin-up transient. Rotors the controller does not command keep their own `rpm`.
- **FLT-D17 (divergence)**: `run_flight` refuses a closed loop whose thrust axis passes 90° (FLT_DIVERGED, time and state in the error
  detail, §4); `flight_report` gives a FAIL verdict with a `diverged` check instead, so an owner still gets "will it fly: no".
- **FLT-D18 (vehicle)**: no `define_flight_vehicle` yet: the controller and the scenario name one free body, and a body with other bodies
  jointed below it is refused (`FLT_VEHICLE_MULTIBODY`): the controller's mass, centre of mass and inertia would otherwise silently differ
  from the dynamics. Multi-body vehicles (servo-pivoted wings) come with FLT-M4.
- **FLT-D19 (anti-windup, review round 1)**: the allocation reports a clamped rotor and a yaw cut (λ < 1) separately. A clamp holds every
  integrator; a yaw cut holds only the yaw-rate integrator, because thrust, roll and pitch were still delivered. Test: a yaw channel
  saturated on > 90 % of the updates in a 5 m/s steady wind still trims the drift to < 2 cm (holding every integrator left 0.20 m of drift
  and 1.1 m of sag).
- **FLT-D20 (mixer conditioning)**: a full-rank layout is still refused when nearly singular (`FLT_MIXER_ILL_CONDITIONED`): the smallest
  pivot of the Gram matrix of B (thrust row scaled to unit length, the three torque rows by one common factor so a weak axis stays weak)
  under 1e-8 of the largest. Four rotors 0.01 mm off a line are refused, 1 mm off pass; a quad X scores about 8e-3.
- **FLT-D21 (divergence signal)**: the port exports `SimulationDivergedError` (with the time); the MuJoCo adapter throws it and
  `run_flight` maps it to `FLT_DIVERGED` by class, never by message text. MuJoCo resets a state whose acceleration or velocity explodes
  (its own instability guard), so in practice a flight diverges through the 90° tilt check.
- **FLT-D22 (report sampling and budget)**: `flight_report` takes the same `sampleRate` as `run_flight` (the recovery times are read on the
  samples, so they agree only at equal rates); a timestep check refuses when its three runs together exceed 600 000 steps
  (`FLT_RUN_TOO_LONG` with the summed count), before anything is flown.
- **Budgets**: at most 600 000 physics steps per run (FLT_RUN_TOO_LONG; a timestep check flies its finest run first) and 6001 samples;
  peaks, integrals and counts are exact per step, recovery uses the samples (50 Hz default). Measured: the 60 s hover at 2 kHz runs in 2.6 s (budget 5 s, §8).

**Not in M2 / remainder.** Host / UI: a `flight` toolset view in `@protocol/toolsets` (the four commands are listed under `assembly`), a
report panel and a viewport replay of a run (`run_flight` returns the series; `render_motion` does not read them yet). Later milestones:
motor / ESC / battery chain (M3), aero tables, pivot servos and Dryden turbulence (M4), trim / linearisation and `export_flight_loads`
(M5), SITL (M6).

## 15. Implementation status — FLT-M3 (2026-11-09)

**Built (TR-FLT-06, FR-FLT-06 and the battery part of FR-FLT-07 / 08).**

| Item                                                                                                                                                                                                                                                                                                                  | Where                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Slice `doc.flight.batteries` / `doc.flight.powertrains` (optional tables), load validation (schema, keys, OCV curve, battery / rotor references, one powertrain per battery and per rotor, shared id space); `delete_dynamics_item` removes them and cascades battery -> powertrain, rotor -> powertrain              | `flight/{powerModel,powerDocument,model,document}.ts`    |
| Pack law: V = OCV(SoC) - R_int·I, P_bus = V·I solved in closed form I = (OCV - sqrt(OCV² - 4·R_int·P)) / (2·R_int) (a pack that cannot deliver P = OCV² / 4R is a cut-off), SoC from the charge drawn; OCV linear in SoC between the table points, inverse lookup for the cut-off floor                               | `flight/powerChain.ts`                                   |
| Motor + ESC: the DC datasheet of add_motor (kt, R, I0): i = Q/kt + I0, V = kt·ω + R·i; ESC input power V·i / η, throttle = V / V_pack; speed cap when V_motor > V_pack from the positive root of kt·ω + R·(c·ω²/kt + I0) = V (propeller torque ∝ ω² at fixed J)                                                       | `flight/powerChain.ts`                                   |
| The chain inside the flight block: per physics step the shaft torque of every fed rotor -> motor current / voltage -> bus power -> pack current, SoC, energy, minimum voltage, peak current, peak throttle, over-current and voltage-limited step counts in the aux state; the low-voltage cut-off stops the motors   | `flight/{powerBlock,flightBlock}.ts`                     |
| Battery metrics per powertrain (charge in mAh, energy in Wh, mean / peak / final current, sag, cut-off time, `enduranceS` = cut-off time, or run time + remaining time at the final current down to the SoC floor where OCV = cut-off + R·I), warnings, series, verdict checks `battery_final_soc` / `battery_cutoff` | `flight/{batteryMetrics,flightMetrics,flightVerdict}.ts` |
| `estimate_endurance`: steady discharge at fixed rotor speeds (hover) along the OCV curve with sag, to cut-off / empty / pack-power / motor-voltage, with the momentum-theory hover power and the capacity / current bound                                                                                             | `flight/endurance.ts`, `commands/flightEndurance.ts`     |
| Commands `add_battery`, `add_flight_powertrain` (mutating), `estimate_endurance` (read-only); `run_flight` / `flight_report` gain `data.battery` and the `minFinalSoc` limit                                                                                                                                          | `commands/{flightPower,flightEndurance,flightRun}.ts`    |
| Validation plan `sc-flt-03-endurance` (golden pins + replay equality)                                                                                                                                                                                                                                                 | `validation/plans/`, `tests/golden/fltPlans.test.ts`     |

**Validation (`tests/unit/flight/flightPowerCommands.test.ts`, `flightPowerRun.test.ts`, MuJoCo 4.0, dt 2.5 ms).** Closed forms written in the
tests, independent of the implementation: hover of the 1.115 kg quad from its weight: 4082.5 rpm, 76.04 W shaft, momentum-theory ideal 51.31 W,
FM = Ct^1.5 / (Cp·sqrt(π/2)) = 0.6747 (1e-9); bus power Σ V·i / η from kt = 60/(2π·Kv), R, I0 (1e-9); V·I = P at the pack terminals.
Endurance on an ideal flat pack (R = 0) is capacity / current to 0.2 % (5.6 Ah at 14.8 V); with sag and the sloping OCV curve it matches an
independent 1 s integration written in the test to 0.5 %. Flown: the mean battery current of a closed-loop hover is the analytic hover current
within 2 % (final current within 1 %), mAh = A·s/3.6 and SoC = 1 - Q/C (1e-9), the lowest voltage is OCV - R·I (0.1 %); a 10 mAh pack reaches
its cut-off at capacity / current (3 %) and the motors stop (zero thrust, FLT_BATTERY_CUTOFF, report FAIL with `battery_cutoff`); a run that
stays above the cut-off extrapolates the endurance at the final current (ideal pack: capacity / current, 1 %); a 1S pack cannot spin the hover
speed and the thrust follows an independent bisection of the motor voltage equation (1 %, FLT_PACK_VOLTAGE_LIMITED); a motor over its peak
current warns FLT_MOTOR_CURRENT_LIMIT. With the powertrain code mutated (resistance ignored, speed cap removed, cut-off removed) five of these
tests fail. Sample pack of VC-FLT-11 (plan `sc-flt-03-endurance`: 4S 5.6 Ah, R_int 40 mΩ, 920 Kv class motors, ESC 95 %, 5 W avionics; grade C
inputs): hover 104.0 W electrical, 6.286 A at 16.55 V, throttle 0.297, endurance 2813.6 s (46.9 min) to the 3.0 V per cell cut-off against
3207 s for capacity / current. The bench measurement of VC-FLT-11 (hover current of the real 1.115 kg airframe) is still open: the chain is
verified against closed forms, not against a measured pack.

**Decisions.**

- **FLT-D23 (one powertrain record, not `add_flight_motor`)**: §4 listed `add_flight_motor` + `add_battery`. A motor of `doc.dynamics` is bound
  to a joint (it would drive that joint in `simulate_motion`), and a free-flight rotor has none; llull has one motor model (the DC datasheet:
  schema, consistency check, `kt`, `R`, `I0`), so the powertrain takes either a stored direct-drive dc motor (`motor`, copied) or an inline
  `datasheet` checked like `check_motor_data`, and `add_flight_powertrain` connects battery, motors and rotors. A brushless motor is entered as
  its Kt (60 / (2π·Kv)), R and I0. Rejected: a second `Motor` record with its own law; a rotor `motorId`.
- **FLT-D24 (units)**: pack-level numbers in explicit units: `capacityMah` of the whole pack, `internalResistanceOhm` of the whole pack,
  `cutoffVoltPerCell` and the OCV curve per cell. §3's `cells.parallel` is not stored: parallel strings only change the pack capacity and
  resistance, which the caller states for the pack (a 4S2P of 2800 mAh cells is `cellsSeries` 4, `capacityMah` 5600).
- **FLT-D25 (quasi-static motor)**: the current follows the torque algebraically (i = Q/kt + I0; no winding inductance, no rotor spin-up
  I·dω/dt in the chain); the rotor speed dynamics stay the controller's first-order lag `motorTimeConstantS` (FLT-D7). §5's dω/dt equation is
  left for FLT-M7 with the BEMT rotor. The ESC efficiency is one constant (no efficiency map).
- **FLT-D26 (voltage limit and cut-off)**: a rotor whose motor needs more voltage than the pack gives is held at the speed the pack sustains
  (terminal voltage of the previous step; FLT_PACK_VOLTAGE_LIMITED); at the low-voltage cut-off, an empty pack or a pack that cannot deliver the
  power, the motors stop and stay stopped (FLT_BATTERY_CUTOFF, a failing `battery_cutoff` check): the flight ends in the simulation, so a run
  past the cut-off shows the fall. A battery feeds one powertrain and a rotor belongs to one.
- **FLT-D27 (defaults flagged)**: without `ocv` a typical LiPo rest curve is used, without `cutoffVoltPerCell` 3.3 V, without `escEfficiency`
  0.95; each is listed in `defaulted` and makes the run `unverified` (FR-FLT-08). An OCV curve that does not run from SoC 0 to 1, whose SoC is
  not increasing or whose voltage decreases, or a cut-off at or above the full-charge voltage is `FLT_ECM_INVALID`.
- **FLT-D28 (reserve limit)**: `flight_report` gains `minFinalSoc` (default 0.2, MARGINAL within 10 %): the check `battery_final_soc` is
  `not_applicable` without a powertrain. This adds one check and one limit to every report (the golden pins of the M2 plans were updated).

**Not in M3 / remainder.** Motor thermal limits and ESC efficiency maps, Peukert / temperature dependence of the cell, the bench measurement of
VC-FLT-11, a minimum-endurance limit in `flight_report`, a viewport trace of SoC, and non-dc motors (PMSM / stepper data cannot yet feed the chain).

## 16. Implementation status — FLT-M4 (2026-11-09)

**Built (TR-FLT-03 aero surfaces, TR-FLT-04 Dryden turbulence, FR-FLT-03 / 04 / 12 / 08 for aero tables).**

| Item                                                                                                                                                                                                                                                                                                                                                        | Where                                                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `generate_aero_table`: one `analyze_vortex_lattice` call per pivot angle through `ctx.registry` (angles of attack swept inside the call, one factorisation); CL, Cm as solved, CD = cd0 + CDi; stored as `doc.flight.aeroSurfaces[id]` with reference S / c / span (m², m), moment centre, provenance `vlm+polar`, `unverified`, `designHash`, solver stats | `commands/flightAero.ts`, `flight/{aeroModel,aeroTable,aeroSweep}.ts` |
| Table lookup: bilinear in (α, pivot), held at the edges and counted (`FLT_AERO_OUTSIDE_TABLE`); stall bound: with `profileDrag.clMax` only the run of angles around zero lift where \|CL\| stays within it at every pivot angle is kept (valid range stored)                                                                                                | `flight/aeroTable.ts`                                                 |
| Surface law: air velocity at the moment centre u = -(v + ω × r) (relative to the wind) on the flow frame, α = atan2(uz, ux), q = ½ρ(ux² + uz²), F = q·S·[CD cos α - CL sin α, 0, CD sin α + CL cos α], pitching moment q·S·c·Cm about the spanwise axis, force at the moment centre                                                                         | `flight/aeroSurface.ts`                                               |
| Pivot servo in the flight block: per surface the angle slews toward the scenario command at `rateDegS` inside `[minDeg, maxDeg]`; the law reads the mean angle of the step; exact per-step peaks in aux; scenario set-points gain `pivotDeg` per surface id                                                                                                 | `flight/aeroBlock.ts`, `flight/flightBlock.ts`                        |
| Dryden turbulence: `wind.turbulence { sigmaMps, lengthScaleM, airspeedMps, seed }`, MIL-HDBK-1797 spectra realised by forming filters on Philox-counter Gaussian noise (every 5 ms, linear between samples, held after the end); steady + gusts + turbulence in one `WindSource`                                                                            | `flight/turbulence.ts`, `flight/wind.ts`                              |
| Stale detection: `designHash` = hash(generation inputs, body record, entities of the body); `run_flight` compares it again (`FLT_AERO_TABLE_STALE`, `unverified`, `data.aero[id].stale`)                                                                                                                                                                    | `flight/aeroTable.ts`, `flight/flightRun.ts`                          |
| Run output `data.aero[surfaceId]` (α range, final pivot / CL / CD / lift / drag, peak lift and time, share of steps outside the table, valid α range, stale, unverified); `simulate_motion` applies the table at the neutral pivot                                                                                                                          | `flight/aeroMetrics.ts`, `flight/flightLoads.ts`                      |
| Load validation of `aeroSurfaces`, `wind.turbulence`, set-point `pivotDeg` (keys, grid shape, servo inside the pivot range, pivot commands name servo surfaces of the scenario's body); `delete_dynamics_item` cascades body -> surface and strips pivot commands                                                                                           | `flight/{aeroDocument,document,model}.ts`                             |

**Evidence** (`tests/unit/flight/{aeroTableCommand,aeroRun,turbulence}.test.ts`, MuJoCo 4.0).

- Lift slope: an elliptic AR 20 wing gives CL_α within 3 % of 2πA/(A + 2) (VLM below the lifting-line value, as in VC-AER-35); a rectangular AR 20 wing
  sits 4.6 % below it (the known rectangular-wing gap); CD - cd0 = CL² / (π A e) with e near 1 for the elliptic planform (3 digits).
- VC-FLT-12: the force of a run at α = 4° equals ½ρV²S·CL from `analyze_vortex_lattice` at the same condition to 1e-5 (the dynamics samples the state at the
  step midpoint, so 1e-6 is not reachable at one step; the heavy body keeps the velocity change below 2e-7 m/s).
- 1-cosine gust: the peak load factor of a heavy wing equals ρ V CL_α U_g / (2 W/S) within 3 % and peaks at the gust midpoint (2.0 s).
- Dryden: Welch spectra (Hann, 8192-sample segments, 20 independent 600 s realisations) against Φu, Φv, Φw: log-mean ratio within 5 %, every bin of
  [corner/4, 10·corner] within a factor 1.6, pooled standard deviation within 5 % of the stated σ, same seed -> identical series, sample i independent of
  the series length. Mutation check: replacing the second-order numerator of the lateral / vertical filter fails the spectrum and variance tests.
- Steady crosswind on a drag body (zero gravity, CdA 0.5 m², 2 kg, 6 m/s): ground track within 0.5 % of x(t) = w·t - ln(1 + k·w·t) / k, k = ½ρCdA/m.
- Pivot servo: -10° -> +10° at 10 deg/s is at -5.0° after 1 s, 0° after 1.5 s, +10° held; a hand-edited command beyond the limit is held at the limit.
- Golden plan `sc-flt-04-wind-aero` (wing quad, pivoting wing, 6 m/s head wind, 1 s gust, Dryden σ 0.5 / 0.5 / 0.3, seed 3): pinned in `tests/golden/fltPlans.test.ts`.

**Decisions.**

- **FLT-D29 (pivot = servo state, not a second body)**: §3 sketched `pivotJointId` and FLT-D18 deferred multi-body vehicles to M4. The controller's mass,
  centre of mass and inertia are the vehicle body's own, so a jointed wing body would silently disagree with them; the pivot is instead a servo state of the
  surface (angle, rate limit, travel limits) that selects the table column. Consequence: the wing's own mass does not move and its hinge reaction is not
  a separate load (the aero wrench acts at the moment centre on the vehicle body); FLT_VEHICLE_MULTIBODY stays. Rejected: real jointed bodies with the
  controller re-derived from the whole subtree (a rewrite of M2's mass model, left for a later milestone when a mass-moving wing matters).
- **FLT-D30 (table axes and what the lattice cannot give)**: the table is (α, pivot) as §3 says. `analyze_vortex_lattice` has no sideslip, rotation-rate
  or flap-deflection input, so there is no β axis, no control-surface (hinged flap) deflection and no rate derivatives: lift and drag use the flow in the
  surface's x-z plane (the cross flow is ignored), and rate effects enter only through the local velocity ω × r at the moment centre. An all-moving surface
  (stabilator, pivoting wing) is covered by the pivot axis. A flap needs a VLM input first (reported to the aerodynamics owner).
- **FLT-D31 (turned wing is not the flat wing at α + pivot)**: the lattice keeps its trailing legs along the free stream, so a wing turned by 10° gives
  CL 5.6 % above the flat wing at α = 10°; the pivot sweep therefore solves the turned geometry (leading edges rotated about the pivot axis plus the incidence
  change) at each pivot angle instead of shifting α.
- **FLT-D32 (flow frame and half-wing direction)**: `forward` names the body axis of travel (default "+x"); the flow frame is x downstream, y = z × x, z up.
  The lattice measures incidence and camber about the span direction of the section list, so a half wing that runs toward -y of the flow frame is mirrored
  about y = 0 (or reversed when `mirror: false`); a "+x" table of a mirrored wing is identical to the "-x" one (test).
- **FLT-D33 (viscous model, stall, validity)**: CD = cd0 + CDi with a constant, stated `profileDrag.cd0` (default 0.01, then `unverified`; a stated `source`
  makes the result verified). The lattice is inviscid, so stall is a bound, not a model: `clMax` truncates the angle-of-attack axis, and outside the table
  the coefficients are held at the edge with a warning (FR-FLT-08), never extrapolated. §5's `allowExtrapolation` was not built.
- **FLT-D34 (staleness)**: the design is the body record and the entities of the body (the sections are inputs of the command, stored only as a hash):
  moving or reshaping the body's entities stales the table; editing the inputs means calling the command again. Rejected: storing the sections in the record
  (duplicates geometry the agent already holds).
- **FLT-D35 (turbulence model)**: Dryden with a fixed airspeed (frozen field, the stated `airspeedMps`, default 10 m/s listed in `defaulted`) and
  world-axis components u = x, v = y, w = z; the spectra are the MIL-HDBK-1797 forms (Φu with L, Φv / Φw with the (1 + 3(Lω/V)²) numerator).
  The realisation is a pure function of the seed (Philox counter noise, 5 ms hold-first-order stages started after an 8τ warm-up), computed once
  per run up to 600 s. The turbulence is not altitude or airspeed scheduled; a von Kármán form is not built (Dryden is what §5 names).
- **FLT-D36 (load validation fix)**: `referenceErrors` spread its own `errors` before the later checks pushed body problems into it, so a controller or
  scenario on a missing body passed load validation; the later checks now run first.

**Not in M4 / remainder.** A hinged control surface (flap) and sideslip / rate derivatives (need VLM inputs), a mass-moving pivoting wing (multi-body vehicle),
stall and post-stall models (a graded section polar), viewport replay of the surface, the `U3` forward-flight power comparison with pivoted wings (the
pieces exist: run `sc-flt-04-wind-aero`-style scenarios at two pivot commands), the `flight` toolset view. Next: FLT-M5 (`export_flight_loads`, trim, linearisation).

## 17. Implementation status — FLT-M5 (2026-11-09)

**Built (FR-FLT-10 trim and linearisation; the FR-FLT-09 hand-off to 14 FLL audited).**

| Item                                                                                                                                                                                                                                                                                                                          | Where                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `trim_flight` (read-only): steady straight flight at `airspeedMps` and `flightPathDeg` (or `freeFlightPath`) of a scenario's vehicle; unknowns roll, pitch, the controller's rotor speeds (within minRpm..maxRpm) and the pivot of every servo surface (within its travel); damped Gauss-Newton on the six body accelerations | `commands/flightTrim.ts`, `flight/trimSolve.ts`                               |
| State derivative of the vehicle from the SAME laws as `run_flight` (`rotorOutput`, `bodyDragForce`, `aeroOutput`, the document's own loads) plus rigid-body dynamics; no engine, no controller                                                                                                                                | `flight/trimModel.ts`                                                         |
| `linearize_flight` (read-only): trim, then central-difference A (8 x 8) and B (8 x controls), eigenvalues of A, labelled modes (phugoid / short period / Dutch roll / roll subsidence / spiral for aero vehicles; heave / yaw / pitch_translation / roll_translation in hover)                                                | `commands/flightTrim.ts`, `flight/{linearModel,flightModes}.ts`               |
| Dense nonsymmetric eigenvalue solver (balancing, Hessenberg, shifted QR; EISPACK balanc / elmhes / hqr), no dependency                                                                                                                                                                                                        | `flight/eigenvalues.ts`                                                       |
| `prepareVehicle`: the vehicle set-up of `runFlight` (model without flight records, free-body and multibody checks, compiled rotors / aero / drag, mass properties, controller, powertrains) factored out so a trim reads exactly what a run reads                                                                             | `flight/flightRun.ts`                                                         |
| Golden plan `sc-flt-05-loads`: reference quad -> `trim_flight` -> `linearize_flight` -> `run_flight` -> `export_flight_loads` -> static case (free-body support) -> `check_analysis` (no relief finding)                                                                                                                      | `validation/plans/sc-flt-05-loads.plan.json`, `tests/golden/fltPlans.test.ts` |

**Hand-off audit (`export_flight_loads`, 14 FLL-M2, already built).** It flies the scenario itself through `ctx.registry` (`run_flight`, detail `series`, 1 kHz) and reads
velocity, attitude, rates and rotor thrust, so no stored run id is needed (FLL-D9 / FLT-D9: **the run id of the §4 sketch is the scenario id**; `record_flight_run` stays for host
runs). The flight side owed it nothing new; what was missing was the end-to-end pin (flight -> loads -> analysis) and the statement of the trimmed hand-off: a trimmed flight is a
steady 1 g state, so its loads are `trim_flight` `data.rotors[].thrustN` as mount forces with zero acceleration; the golden plan runs the dynamic case (a climb scenario, peak load)
and `tests/unit/cae/flightLoadsRun.test.ts` stays the proof of the relief balance. Nothing of FLL-M2 was duplicated.

**Evidence** (`tests/unit/flight/{flightTrim,flightTrimWing,flightLinear}.test.ts`; no physics engine involved).

- Hover trim of the reference quad (M3 rotor, UIUC 4029 row, 1.115 kg): every rotor at sqrt(m g / (4 k)) = 4082.5 rpm with k = C_T ρ D⁴ / 3600 (closed form, to 1e-4 rpm; VC-FLT-09), level to 1e-7°, residual force / moment 1e-7 N / 1e-8 N·m. A symmetric vehicle keeps equal speeds because the damping selects the minimum-norm step.
- Forward flight at 8 m/s with body drag: tan(tilt) = drag / weight to 1e-2, nose down.
- Open-loop hover, rate controller out of the loop ("M2 controller off"): A has pitch-dot = -q (q about the +y axis, document axes), roll-dot = p, q-dot = p-dot = 0 to 1e-6, u-dot = -g pitch and v-dot = -g roll to 1e-5 (analytic integrator chains), dw/drpm = 2 k rpm / m on B; every eigenvalue is a defective zero (|λ| < 0.05, the cube root of the round-off), none growing.
- Linear test system: `centralJacobian` returns the A and B of x-dot = A x + B u to 1e-9; the eigenvalue solver reproduces triangular, companion ((s + 1)(s² + 2s + 5)), Jordan and badly scaled (1e-4..1e4 similarity) spectra to 1e-6.
- Glider (VLM wing 6 m x 1 m + pivoting tail, 50 kg, 20 m/s, `freeFlightPath`): trims at flight path -3.42°, pitch +1.24°, tail pivot -3.11° (inside ±8°), lift = W cos γ and drag = -W sin γ to 1e-3 N. **Phugoid period 9.075 s against Lanchester's sqrt(2) π V / g = 9.061 s (0.15 %)**, test tolerance 10 %; short period T 1.286 s, ζ 0.583, stable. The phugoid damping (theory ≈ 1 / (√2 L/D) ≈ 0.04) comes out at ζ ≈ -0.005 (no downwash lag or pitch-rate aero in the tables): only its smallness (|ζ| < 0.1) is asserted.
- Refusals: `FLT_TRIM_SATURATED` (maxRpm 4000: rotors at the limit, weight not carried), `FLT_TRIM_NOT_CONVERGED` (no controls to move), `FLT_TRIM_UNSUPPORTED` (aero surface travelling along -x), a level flight without thrust (glider); every refusal returns the unchanged document.

**Decisions.**

- **FLT-D37 (trim reuses the force laws, not the engine)**: the derivative is built from the laws `run_flight` calls (same functions, same compiled vehicle through `prepareVehicle`), evaluated at a body state with the controls given directly; the controller and the actuator lags are NOT in the loop, so the linearisation is the airframe plus rotors (A, B per rpm / per degree), which is what a controller is designed against. Rejected: finite differences of full engine runs (noise, 100x slower, MuJoCo-version dependent).
- **FLT-D38 (state and sign conventions)**: states [u, v, w, p, q, r, roll, pitch]; velocities and rates in the body axes of the document (x forward, y left, z up); roll about +x (right wing down positive), pitch nose-up positive (hence pitch-dot = -q); heading and position are not states (no wind, flat earth: they do not enter the dynamics), so the 8 x 8 A has no integrator for them.
- **FLT-D39 (condition and unknowns)**: the vehicle flies along body +x (an aero surface with another `forward` is `FLT_TRIM_UNSUPPORTED`); no turn (rates zero), no sideslip input (the solver finds the roll the symmetry allows), scenario wind ignored (warning). Unknowns are attitude and the controls (controller rotors, servo surfaces). Newton from fixed starts (level, ±3°, ±8°, 17°): deterministic.
- **FLT-D40 (named refusals)**: `FLT_TRIM_SATURATED` when the iteration ends with a control at a limit (untrimmable there: more thrust, a wider servo, a gentler condition), `FLT_TRIM_NOT_CONVERGED` otherwise; the residual is in units of the reference acceleration (g, and g / radius of gyration for the angular ones), tolerance 1e-9.
- **FLT-D41 (mode labels are heuristics; lateral aero modes are zero by construction)**: labels are read on the decoupled longitudinal / lateral blocks of A and matched to the full spectrum (`coupled` when no block root lies within 10 %); the M4 aero tables have no sideslip or rate dependence (FLT-D30), so the Dutch roll, roll subsidence and spiral of an aero vehicle are neutral roots, and the result says so in `warnings`. Eigenvectors are not computed (participation-based labelling is left).

**Not in M5 / remainder.** Steady turns and sideslip trim, trim with the controller's loops (closed-loop poles), eigenvector / participation labelling, lateral derivatives (need VLM sideslip / rate inputs, FLT-M4b), trim of a vehicle with powertrain limits (motor current, battery voltage), `plot_flight` of a trim, a `flight` toolset view. Next: FLT-M6 (SITL bridges).
