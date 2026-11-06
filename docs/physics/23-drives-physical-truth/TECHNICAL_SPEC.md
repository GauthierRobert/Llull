# PHY-23 DRV — Drives and physical truth — Technical specification

Status: specification only (2026-11-04). Functional side: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md). Validation:
[`validation/README.md`](validation/README.md).

## 1. Current state in llull (main 00d5326f, 2026-11-04)

| Piece                    | File                                                                                                                                             | What it does                                                                                                                                                                               | Limit for this pack                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| model                    | `packages/core/src/model/dynamics.ts` (`Motor` union ~l.104)                                                                                     | bodies, body joints, gears, springs, motors, propellers, cylinders, solver settings                                                                                                        | no motor data, drive, profile, transmission kinds, joint physics                                                                        |
| `add_motor`              | `packages/domain-dynamics/src/commands/drives.ts:15`                                                                                             | `torque_curve` (`curve` [[rpm, N·m]], `torque`, `throttle`) or `speed` (`rpm`, `maxTorque`); revolute only                                                                                 | no electrical model, no linear actuator, `maxTorque` unchecked                                                                          |
| force laws               | `domain-dynamics/src/sim/forceLaws.ts`                                                                                                           | `motorForce = throttle · curveTorque(curve, rpm)`                                                                                                                                          | stateless                                                                                                                               |
| speed servo              | `core/src/dynamics/physicsEngine.ts:80` (`SimulationServo`), `physics-mujoco/src/mjcf.ts`                                                        | MuJoCo `<intvelocity>`, natural frequency 1/(2·Δt), gains on the measured effective inertia, force clamp                                                                                   | velocity only; no anti-windup ("a saturated spin-up is not caught up", DYNAMICS.md)                                                     |
| gears                    | `domain-dynamics/src/commands/connections.ts:150` (`add_gear_coupling`), `physics-mujoco/src/gearLoss.ts`                                        | MuJoCo joint equality (`polycoef`, solref 2·Δt, solimp 0.9999); constant efficiency as a speed-sign-smoothed loss torque on the driven joint                                               | one efficiency, no back-drive, no locking, no backlash; revolute–revolute only                                                          |
| joint friction / damping | `add_body_joint` `friction`, `damping` (`connections.ts:26`) → `mjcf.ts:78-90`                                                                   | `frictionloss` (Coulomb, `solimpfriction` 0.9999), viscous `damping`                                                                                                                       | one level, no stiction / Stribeck / load dependence                                                                                     |
| port                     | `core/src/dynamics/physicsEngine.ts`                                                                                                             | `PhysicsEngine.simulate(model, options) → SimulationTrace`; `loads(state)` evaluated at the step midpoint; trace has joint / body series, reactions, energy (`appliedWork`), loop residual | stateless loads; no auxiliary states; no per-step model parameters                                                                      |
| MuJoCo adapter           | `packages/physics-mujoco/src/{mjcf,mujocoPhysics}.ts`, MuJoCo 3.16.0 WASM                                                                        | hinge / slide, free joint, spatial tendons, joint equalities, `connect` loop closures, `intvelocity` servos, RK4 or `implicitfast`                                                         | no geoms, no `range` / `limited`, no fixed tendons, no `armature`, no other actuators                                                   |
| simulate                 | `domain-dynamics/src/commands/simulate.ts:43`                                                                                                    | read-only; `detail` summary / series / poses; `reactions`; `energy` (kinetic, potential, dissipated, input, propeller work, balance error); adaptive Δt halving on loop failure            | energy is totals only, not per element; no drive series                                                                                 |
| checks                   | `checkDynamics.ts`, `checkMotionClearance.ts`, `check_prototype`, `check_timestep_convergence` (engine)                                          | `FPR_MASS_DEFAULTED`, `FPR_UNREALISTIC`, `FPR_NO_LOSSES`, `FPR_LOOP_DRIFT`, `FPR_ENERGY_CLOSURE`, `FPR_TIMESTEP_SENSITIVE`; clearance along poses                                          | no effort, provenance or friction-model checks; Δt study is engine-specific                                                             |
| reference data           | `add_reference_data`, `compare_to_reference` (`engine/*`)                                                                                        | engine reference curves                                                                                                                                                                    | engine-specific (cycle torque, rpm)                                                                                                     |
| plots                    | `domain-dynamics/src/commands/plot.ts:113`                                                                                                       | SVG: joint angle / velocity, motor torque / power, reaction force, energy                                                                                                                  | no current, voltage, temperature, operating points                                                                                      |
| kinematic motion         | `core/src/commands/motion/*`                                                                                                                     | `add_joint` with `limits`, `add_drive_relation`, `motion_study`, `animate`, cam (knife-edge)                                                                                               | no time-based profiles                                                                                                                  |
| UI                       | `src/ui/panels/PhysicsSection.tsx`, `PhysicsLoadsSection.tsx`, review workspace                                                                  | setup, Simulate, rpm chart, torque / kW, replay                                                                                                                                            | no motor editor, no torque–speed or thermal chart                                                                                       |
| specs touching this      | PHY-10 FR-RBD-09 (actuators, spec only), PHY-21 V1 (μ·F·r) / V2 (backlash), aerospace 13 FLT FR-FLT-05/06 (flight PID, Kv motor + ESC + battery) | —                                                                                                                                                                                          | this pack builds FR-RBD-09 and PHY-21's μ·F·r / backlash; FLT keeps the battery / ESC chain and reuses this pack's motor and controller |

## 2. Target architecture

```
doc.dynamics (core model, extended)               packages/core/src/model/dynamics.ts + model/drives.ts (new)
  motors[]       kind torque_curve | speed | dc | pmsm | stepper | induction   (+ datasheet, source, gearhead)
  drives{}       motorId → { mode voltage | torque | velocity | position | prescribed, profile, tuning, limits, sampleHz }
  profiles{}     id → { quantity, unit, segments[], repeat }
  transmissions[] kind gear | belt | lead_screw | ball_screw | rack_pinion    (replaces gears[])
  jointPhysics{} jointId → { limits, friction model, armature }
  loadSchedules[] target, kind force | torque, profile, frame

plugin dynamics (packages/domain-dynamics)        commands (§4), actuator laws (sim/actuators/*.ts, pure), sizing, truth checks
  ├─ compile → SimulationModel (core port, extended §3.2): actuators with auxiliary states, transmissions, joint physics, schedules
  ├─ ctx.physics (MuJoCo adapter, physics-mujoco)    hinge / slide + armature, range / limited + solreflimit, fixed tendons (backlash),
  │                                                   joint equalities (gear, screw, rack), per-step frictionloss writes
  └─ ctx.physicsReference (V1, packages/physics-reference)  independent engine for the cross-check

core geometry/motionProfile.ts (pure)             profile evaluation, shared by drives, loads, PHY-22 `sweep` sources and motion_study (later)
```

Laws: L1 (each capability one command), L2 (core owns the port types and the profile evaluator, the plugin owns the laws, the
engines implement the port; core imports no plugin), L3 (analysis commands read-only), L5 (zod schemas), L8 (all new data is
document data, replayed), L9 pattern (`ctx.physics`, `ctx.physicsReference` injected by the composition root).

**C7 placement.** Actuator laws, profile evaluation, drive controllers and the ledger are **TypeScript in core / the plugin**. They are
evaluated inside the per-step `loads` callback of the in-process engine (MuJoCo WASM), and a native boundary per step would cost more
than the laws themselves. The reference engine (V1) is also TypeScript, in-process (`packages/physics-reference`) for the same reason:
it must call the same callback each sub-step. A Rust version is worth it only if a profiled model needs it (C7: "equivalent" is false
here because of the callback boundary). Decision D-DRV-02.

### Technical requirements

| Id        | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TR-DRV-01 | Port extension (core `physicsEngine.ts`): `SimulationModel.actuators?: ActuatorBlock` with `aux0: Float64Array` and `advance(state, aux, dt) → { aux, jointForces, bodyForces, ledger }`. It is called exactly once per physics step, with the midpoint state the adapter already builds for `loads`, and is deterministic and pure (no closure state). Engines store `aux` in the trace (`trace.aux`, sampled like joint series)                                                                                                                                                                                                         |
| TR-DRV-02 | Port extension: `SimulationModel.jointPhysics?: { frictionLevel(state, prevReactions) → Float64Array; limits: JointLimit[]; armature: Float64Array }`. The adapter writes `dof_frictionloss` before each `mj_step` (verified in DRV-M0) and maps limits to `range` + `limited` + `solreflimit` (direct form `[-k, -b]`), armature to `armature`                                                                                                                                                                                                                                                                                           |
| TR-DRV-03 | Port extension: `SimulationModel.transmissions?: TransmissionCoupling[]` = `{ a: jointIndex, b: jointIndex, ratio (b per a, any unit pair rad/m), backlash?: { gap, stiffness, damping } }`. Without backlash: joint equality `polycoef [0, ratio]` (hinge–hinge, hinge–slide). With backlash: a fixed tendon `coef [ratio, −1]` with `limited`, `range ±gap/2`, `solreflimit` from stiffness / damping (DRV-M0 spike). Transmission losses are not forces here: they are friction levels on the input joint (TR-DRV-12)                                                                                                                  |
| TR-DRV-04 | `check_motor_data` checks (relative gap = (derived − given) / given, pass ≤ 0.02): stall current U/R; stall torque kt·U/R; ke from the speed constant (1 / (kn·2π/60)) vs kt; no-load speed (U − R·I0)/kt vs n0; τm = J·R/kt²; speed–torque gradient n0 / T_stall. A check is skipped (listed `notGiven`) when an input is absent                                                                                                                                                                                                                                                                                                         |
| TR-DRV-05 | DC motor law (`sim/actuators/dcMotor.ts`): ke = kt (SI). Friction torque T_f = kt·I0 is applied as a Coulomb friction level on the motor joint (constraint, holds at rest), not as a force. Rotor inertia enters as joint `armature` = J_rotor·N² on the output joint when a gearhead N is declared (MuJoCo: `armature` is "extra inertia not from body mass" [R2])                                                                                                                                                                                                                                                                       |
| TR-DRV-06 | Electrical state per step (exact for ω frozen at the midpoint): i_ss = (u − ke·ω)/R, i₁ = i_ss + (i₀ − i_ss)·e^(−Δt/τe). Torque over the step = kt·ī with ī = i_ss + (i₀ − i_ss)·(τe/Δt)·(1 − e^(−Δt/τe)). Copper energy over the step is the exact ∫R·i² of the exponential. Current limit: the drive clamps u so that the steady current stays ≤ I_lim. When L = 0 or τe < Δt / 50, quasi-static i = i_ss (info `DRV_ELECTRICAL_QUASI_STATIC`)                                                                                                                                                                                          |
| TR-DRV-07 | PMSM / BLDC law (DRV-M4): ideal FOC current loop; T = 1.5·p·λ·i_q (surface magnet, L_d = L_q). The torque command is limited by the envelope at the present speed: constant to ω_b = V_max / √(λ² + (L·I_max)²) / p (R = 0), then field weakening at the current limit with i_d = ((V_max/ω_e)² − λ² − (L·I_max)²) / (2λL), i_q = √(I_max² − i_d²), up to ω_max = V_max / ((λ − L·I_max)·p) when λ > L·I_max; V_max = V_bus/√3 (SVPWM). Copper loss 1.5·R·(i_d² + i_q²) enters the ledger (envelope with R = 0 is stated as model form)                                                                                                   |
| TR-DRV-08 | Stepper law (DRV-M4): T = −T_h(ω)·sin(N_r·(θ − θ_cmd)) − T_det·sin(4·N_r·θ); T_h(ω) from the pull-out table (holding torque at 0); θ_cmd from the step profile (full / half / micro-step). Steps lost = round(N_r·(θ_cmd − θ)/(π/2)) ≠ 0, reported with time (`DRV_STEPS_LOST`). Induction law: Kloss T = 2·T_b / (s/s_b + s_b/s) or the equivalent-circuit form (§5); slip s = (ω_s − ω)/ω_s, ω_s from a line frequency or a V/f profile                                                                                                                                                                                                 |
| TR-DRV-09 | Thermal law: nodes winding / housing, C_w = τ_w / R_th1, C_s = τ_s / R_th2 (datasheet convention; the eigen time constants of the coupled network differ, stated as accuracy note `DRV_THERMAL_MODEL_FORM` with both pairs). Copper resistance R(T) = R25·(1 + α·(T_w − 25 °C)), α = 0.0039 /K default. Exact exponential (matrix exponential of the 2×2 network) update per step with the step's mean copper power. Runaway when I²·R25·α·(R_th1 + R_th2) ≥ 1 for the RMS current (`DRV_THERMAL_RUNAWAY`)                                                                                                                                |
| TR-DRV-10 | Controllers (`sim/actuators/control.ts`): discrete, zero-order hold, sample period = k·Δt with integer k (else `DRV_CONTROL_RATE`). Position loop P(+I) → velocity loop PI → torque command (current loop ideal or the DC electrical law in voltage control). Anti-windup: integrator clamping when the output saturates. Feedforward: J_ref·a_profile + friction estimate. Tuning from `bandwidthHz` f_c and ζ with J_ref = reflected inertia at the motor (rotor·N² + load): velocity PI k_p = 2ζω_c·J_ref, k_i = ω_c²·J_ref; position k_p,pos = ω_c / 4 (cascade separation 4). Stability guard: ω_c·T_s ≤ 0.2 else `DRV_CONTROL_RATE` |
| TR-DRV-11 | Prescribed mode: a high-gain velocity / position servo following the profile (as today's `speed` servo, natural frequency 1/(2Δt)) with effort limit = the motor's peak (or the declared limit). Data reports the tracking error RMS and peak; tracking error > 1 % of the move (or 0.5° / 0.1 mm) warns `DRV_TRACKING_ERROR` (the effort is then not the inverse dynamics)                                                                                                                                                                                                                                                               |
| TR-DRV-12 | Transmission losses as friction levels on the input joint, scheduled per step: forward mode (input drives): level =                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | T_c     | ·(1 − η_f)/η_f referred to the input side; back-drive mode: level from η_b. For a lead screw the efficiencies follow from geometry: tan λ = lead / (π·d_m·starts), tan φ' = μ / cos α_n (α_n flank half-angle, 0 square), η_f = tan λ / tan(λ + φ'), η_b = tan(λ − φ') / tan λ (≤ 0 ⇒ self-locking). Mode from the sign of the input-side applied torque × coupling force at the previous step; at rest the back-drive (holding) rule applies. Self-locking then emerges from the friction constraint holding the joint                                                                      |
| TR-DRV-13 | Coupling force for TR-DRV-12 comes from the equality / tendon constraint force of the previous step (MuJoCo `efc_force` of that row), the same one-step lag as TR-DRV-16; the Δt/2 run of `check_motion_truth` measures it                                                                                                                                                                                                                                                                                                                                                                                                                |
| TR-DRV-14 | Backlash: total gap g (angle at the output, or length for a rack); the tendon limit acts on both sides. "Lost motion on reversal" = g by construction; contact stiffness k_mesh (default J_reflected · (2π·100 Hz)²: a 100 Hz mesh mode at the reflected inertia, stated as an assumption when no stiffness is given, `DRV_MESH_STIFFNESS_ASSUMED`)                                                                                                                                                                                                                                                                                       |
| TR-DRV-15 | Friction models → level per step: Coulomb: F_c. Stiction: F_s while                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | v       | < v_tol (default 1e-4 m/s or rad/s), F_k otherwise. Stribeck: F_c + (F_s − F_c)·exp(−(v/v_s)²). Viscous: MuJoCo `damping`. The level is a box bound on the constraint force (MuJoCo frictionloss [R3]), so a joint at rest holds up to the level with no creep                                                                                                                                                                                                                                                                                                                               |
| TR-DRV-16 | Load-dependent friction: level = T_0 + μ·r·                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | F_r     | (+ μ·r_b·                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | M_b | / r_arm for bending, MotionSolve-style inputs [R12]) with F_r the joint reaction of the previous step (`jointReaction`), preload added as normal force F_p / μ_s per [R12] |
| TR-DRV-17 | End stops: `range [min, max]`, `limited true`, `solreflimit [−k, −b]` with b = 2ζ·√(k·J_eff) from the restitution e by ζ = −ln e / √(π² + ln² e). Peak penetration and peak stop force are reported per joint (`data.stops`)                                                                                                                                                                                                                                                                                                                                                                                                              |
| TR-DRV-18 | Profiles (`core/src/geometry/motionProfile.ts`, pure): segments evaluated in normalised time x ∈ [0, 1]; laws and coefficients in §5.4; trapezoid accel fraction default 1/3; S-curve from (v_max, a_max, jerk) or a duration with jerk fraction 1/4; `move` keeps C¹ (position, velocity) between segments and refuses a discontinuity in velocity (`DRV_PROFILE_DISCONTINUOUS`) unless `allowStep`; table: linear or monotone cubic (Fritsch–Carlson, as `propellerTable.ts`)                                                                                                                                                           |
| TR-DRV-19 | Ledger (`sim/ledger.ts`): per step, per element: electrical input u·ī·Δt, copper ∫R·i², friction level ×                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Δq      | per joint (constraint friction power from `efc_force`·v), transmission loss (from TR-DRV-12 levels), stop dissipation (limit `efc_force`·v, negative part), spring, kinetic, potential, external work, motor regeneration (u·ī < 0). Closure = input − Δstored − dissipated; reported absolute and relative to the largest term                                                                                                                                                                                                                                                              |
| TR-DRV-20 | `simulate_motion` `detail: 'drives'`: series per motor (u, i, T, ω, P_el, P_mech, T_w, flags) plus the ledger per element; `energy: true` adds the ledger to every detail. `detail: 'poses+series'` from PHY-22 TR-MOV-04 includes drive series                                                                                                                                                                                                                                                                                                                                                                                           |
| TR-DRV-21 | RMS over a window: √(Σ x_k²·Δt_k / Σ Δt_k) on the sample grid (trapezoid weights). `size_drive` runs over whole repeats of the profile when a repeat exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| TR-DRV-22 | Ratio sweep (`size_drive ratioSweep`): the model is re-run per ratio (transmission ratio replaced in a copy of the model, never the document); reports peak / RMS motor torque, peak speed, inertia ratio J_load/(N²·J_motor) and the best ratio by the limiting factor                                                                                                                                                                                                                                                                                                                                                                   |
| TR-DRV-23 | `check_motion_truth`: (a) ledger closure ≤ 1e-3 relative (pass), ≤ 1e-2 (warn); (b) Δt study: runs at Δt, Δt/2 (quick) and Δt/4 (full) on the outputs named by `outputs` or the default set (final joint speeds, peak reactions, RMS motor torques, end positions), observed order p = log₂(e₁/e₂) and GCI = 1.25·                                                                                                                                                                                                                                                                                                                        | f₁ − f₂ | /(2^p − 1) per output (PHY-00 vocabulary); pass when GCI ≤ 1 % of the value; (c) softness: loop residual tiers (existing), stop / backlash penetration ≤ 1 % of the travel / gap; (d) effort: TR-DRV-24; (e) provenance: lowest grade; (f) reference data (`compare_to_reference`, generalised); (g) reference engine (V1): `ctx.physicsReference` run, agreement on the same outputs. Verdict: `trusted` = no fail and every parameter grade A/B; `plausible` = no fail but grade C / unsourced or a skipped item; `not_trusted` = any fail. Each item: `{ id, status, value, limit, fix }` |
| TR-DRV-24 | Effort check: actuators whose bound comes from no motor model and no source, or whose bound exceeds 10× the peak effort used in the run, raise `DRV_EFFORT_UNBOUNDED` (warn); `check_dynamics` adds it to its findings                                                                                                                                                                                                                                                                                                                                                                                                                    |
| TR-DRV-25 | `fit_drive_parameters`: linear least squares where the model is linear in the unknowns (spin-down: J·ω̇ = −T_f − b·ω, with ω̇ from a centred difference on the measured series; step: kt, R from the electrical equation with measured u, i, ω), Gauss-Newton otherwise. Identifiability by the rank / condition number of the regressor (> 1e8 ⇒ `DRV_FIT_UNIDENTIFIABLE`, naming the confounded pair, e.g. J and T_f from a spin-down alone). Output: values, 1σ from the residual covariance, residual RMS                                                                                                                               |
| TR-DRV-26 | Reference engine (V1, `packages/physics-reference`): minimal coordinates, articulated-body algorithm for the tree, loop closures by Lagrange multipliers with position / velocity projection each step (hard constraints), Dormand–Prince 5(4) with rtol 1e-9; implements the same port (actuators, joint physics with friction as a stick / slip state machine, transmissions as hard couplings, limits as unilateral impulses with the restitution coefficient). No code shared with `physics-mujoco`                                                                                                                                   |
| TR-DRV-27 | Determinism: actuator, controller and ledger code uses no `Math.random`, no wall clock, no `Map` iteration over insertion-varying keys; MuJoCo single-thread. Golden plans pin series hashes per engine version                                                                                                                                                                                                                                                                                                                                                                                                                           |

## 3. Data model

### 3.1 Document (core, `packages/core/src/model/drives.ts`, referenced from `dynamics.ts`)

```ts
export interface ParameterSource {
  readonly name: string;
  readonly url?: string;
  readonly grade: 'A' | 'B' | 'C';
}

export interface DcMotorDatasheet {
  readonly nominalVoltageV: number;
  readonly terminalResistanceOhm: number;
  readonly torqueConstantNmPerA: number;
  readonly rotorInertiaKgM2: number;
  readonly terminalInductanceH?: number;
  readonly noLoadCurrentA?: number;
  readonly nominalCurrentA?: number;
  readonly stallTorqueNm?: number;
  readonly noLoadSpeedRpm?: number;
  readonly speedConstantRpmPerV?: number;
  readonly maxSpeedRpm?: number;
  readonly peakCurrentA?: number;
  readonly thermal?: {
    readonly rthWindingHousingKPerW: number;
    readonly rthHousingAmbientKPerW: number;
    readonly tauWindingS: number;
    readonly tauMotorS: number;
    readonly maxWindingC: number;
    readonly alphaPerK?: number;
  };
}
export interface Gearhead {
  readonly ratio: number;
  readonly efficiency: number;
  readonly efficiencyBack?: number;
  readonly inertiaKgM2?: number;
}

export type Motor =
  | ExistingTorqueCurveMotor
  | ExistingSpeedMotor // unchanged data; `speed` gains prismatic (speedMps, maxForceN)
  | {
      readonly kind: 'dc';
      readonly id: string;
      readonly joint: string;
      readonly datasheet: DcMotorDatasheet;
      readonly gearhead?: Gearhead;
      readonly source: ParameterSource;
      readonly acceptInconsistent?: string;
    }
  | {
      readonly kind: 'pmsm';
      readonly id: string;
      readonly joint: string;
      readonly fluxLinkageWb: number;
      readonly polePairs: number;
      readonly resistanceOhm: number;
      readonly inductanceH: number;
      readonly currentLimitA: number;
      readonly continuousCurrentA: number;
      readonly busVoltageV: number;
      readonly rotorInertiaKgM2: number;
      readonly thermal?: DcMotorDatasheet['thermal'];
      readonly gearhead?: Gearhead;
      readonly source: ParameterSource;
    }
  | {
      readonly kind: 'stepper';
      readonly id: string;
      readonly joint: string;
      readonly holdingTorqueNm: number;
      readonly stepAngleDeg: number;
      readonly rotorInertiaKgM2: number;
      readonly pullOut: readonly (readonly [number, number])[];
      readonly detentTorqueNm?: number;
      readonly gearhead?: Gearhead;
      readonly source: ParameterSource;
    }
  | {
      readonly kind: 'induction';
      readonly id: string;
      readonly joint: string;
      readonly model:
        | { readonly kind: 'kloss'; readonly breakdownTorqueNm: number; readonly breakdownSlip: number }
        | {
            readonly kind: 'circuit';
            readonly phaseVoltageV: number;
            readonly r1Ohm: number;
            readonly r2Ohm: number;
            readonly x1PlusX2Ohm: number;
          };
      readonly polePairs: number;
      readonly lineFrequencyHz: number;
      readonly rotorInertiaKgM2: number;
      readonly source: ParameterSource;
    };

export type DriveSpec =
  | { readonly mode: 'voltage'; readonly volts?: number; readonly profile?: string; readonly currentLimitA?: number }
  | { readonly mode: 'torque'; readonly profile: string; readonly currentLimitA?: number }
  | {
      readonly mode: 'velocity' | 'position';
      readonly profile: string;
      readonly target?: string; // joint measured (default: motor joint)
      readonly gains?: { readonly kp: number; readonly ki?: number; readonly kd?: number; readonly kpPosition?: number };
      readonly tune?: { readonly bandwidthHz: number; readonly dampingRatio: number };
      readonly feedforward?: boolean;
      readonly currentLimitA?: number;
      readonly busVoltageV?: number;
      readonly sampleHz: number;
    }
  | { readonly mode: 'prescribed'; readonly profile: string; readonly target?: string; readonly effortLimit?: number }
  | { readonly mode: 'steps'; readonly profile: string; readonly microsteps?: number } // stepper
  | { readonly mode: 'line' | 'v_per_f'; readonly frequencyProfile?: string }; // induction

export type ProfileLaw = 'linear' | 'trapezoid' | 's_curve' | 'cycloidal' | 'poly345' | 'modified_sine' | 'modified_trapezoid' | 'harmonic';
export type ProfileSegment =
  | { readonly kind: 'dwell'; readonly duration: number }
  | {
      readonly kind: 'move';
      readonly law: ProfileLaw;
      readonly to: number;
      readonly duration?: number;
      readonly vmax?: number;
      readonly amax?: number;
      readonly jerk?: number;
      readonly accelFraction?: number;
    }
  | { readonly kind: 'sine'; readonly amplitude: number; readonly frequencyHz: number; readonly cycles: number; readonly phaseDeg?: number }
  | {
      readonly kind: 'table';
      readonly points: readonly (readonly [number, number])[];
      readonly interpolation: 'linear' | 'monotone_cubic';
    };
export interface MotionProfile {
  readonly id: string;
  readonly quantity: 'position' | 'velocity' | 'torque' | 'force' | 'voltage' | 'frequency';
  readonly unit: string;
  readonly start?: number;
  readonly segments: readonly ProfileSegment[];
  readonly repeat?: number;
}

export type Transmission =
  | {
      readonly kind: 'gear';
      readonly id: string;
      readonly driver: string;
      readonly driven: string;
      readonly ratio: number;
      readonly reverse?: boolean;
      readonly efficiency: number;
      readonly efficiencyBack?: number;
      readonly backlashDeg?: number;
      readonly meshStiffnessNmPerRad?: number;
      readonly meshDampingRatio?: number;
      readonly source?: ParameterSource;
    }
  | {
      readonly kind: 'belt';
      readonly id: string;
      readonly driver: string;
      readonly driven: string;
      readonly driverDiameterMm: number;
      readonly drivenDiameterMm: number;
      readonly efficiency: number;
      readonly source?: ParameterSource;
    }
  | {
      readonly kind: 'lead_screw';
      readonly id: string;
      readonly screw: string;
      readonly nut: string;
      readonly leadMm: number;
      readonly meanDiameterMm: number;
      readonly mu: number;
      readonly flankAngleDeg?: number;
      readonly starts?: number;
      readonly source?: ParameterSource;
    }
  | {
      readonly kind: 'ball_screw';
      readonly id: string;
      readonly screw: string;
      readonly nut: string;
      readonly leadMm: number;
      readonly efficiency: number;
      readonly efficiencyBack: number;
      readonly source?: ParameterSource;
    }
  | {
      readonly kind: 'rack_pinion';
      readonly id: string;
      readonly pinion: string;
      readonly rack: string;
      readonly pitchRadiusMm: number;
      readonly efficiency: number;
      readonly backlashMm?: number;
      readonly source?: ParameterSource;
    };

export interface JointPhysics {
  readonly limits?: {
    readonly min: number;
    readonly max: number;
    readonly stiffness: number;
    readonly dampingRatio?: number;
    readonly restitution?: number;
  };
  readonly friction?:
    | { readonly model: 'coulomb'; readonly kinetic: number; readonly viscous?: number; readonly source: ParameterSource }
    | {
        readonly model: 'stiction';
        readonly static: number;
        readonly kinetic: number;
        readonly viscous?: number;
        readonly source: ParameterSource;
      }
    | {
        readonly model: 'stribeck';
        readonly static: number;
        readonly coulomb: number;
        readonly stribeckVelocity: number;
        readonly viscous?: number;
        readonly source: ParameterSource;
      }
    | {
        readonly model: 'load_dependent';
        readonly mu: number;
        readonly pinRadiusMm: number;
        readonly preloadN?: number;
        readonly frictionArmMm?: number;
        readonly base?: number;
        readonly source: ParameterSource;
      };
  readonly armatureKgM2?: number;
}

export interface LoadSchedule {
  readonly id: string;
  readonly target: { readonly body: string; readonly pointMm?: Vec3 } | { readonly joint: string };
  readonly kind: 'force' | 'torque';
  readonly direction?: Vec3;
  readonly frame?: 'world' | 'body';
  readonly profile?: string;
  readonly constant?: number;
}
```

`DynamicsModel` gains `drives`, `profiles`, `transmissions` (the `gears` array migrates into it: no-backward-compat rule, old
documents are not kept compatible, golden plans updated in the same change), `jointPhysics`, `loadSchedules`. The joint's
`friction` / `damping` numbers stay as the Coulomb / viscous shortcut and are stored as `jointPhysics.friction { model: 'coulomb' }`
with `source { name: 'add_body_joint', grade: 'C' }`.

Units: SI in the model (N, N·m, rad, m, A, V, Ω, H, K, s), except the `*Mm` geometric inputs and profile values in their stated `unit`
(`deg`, `mm`, `rad`, `m`, …), converted once at compile time.

### 3.2 Port additions (core `dynamics/physicsEngine.ts`)

```ts
export interface ActuatorBlock {
  readonly size: number;
  readonly aux0: Float64Array;
  advance(
    state: SimulationState,
    aux: Float64Array,
    dt: number,
  ): {
    readonly aux: Float64Array;
    readonly jointForces: Float64Array;
    readonly bodyForces: readonly BodyForce[];
    readonly ledger: Float64Array; // per-element energies this step, layout from ledgerLayout
  };
  readonly ledgerLayout: readonly { readonly element: string; readonly kind: LedgerKind }[];
}
export interface JointPhysicsBlock {
  frictionLevel(state: SimulationState, previousReactions: Float64Array, previousCouplingForces: Float64Array): Float64Array;
  readonly limits: readonly {
    readonly joint: number;
    readonly min: number;
    readonly max: number;
    readonly stiffness: number;
    readonly damping: number;
  }[];
  readonly armature: Float64Array;
}
export interface TransmissionCoupling {
  readonly a: number;
  readonly b: number;
  readonly ratio: number;
  readonly backlash?: { readonly gap: number; readonly stiffness: number; readonly damping: number };
}
// SimulationModel gains: actuators?, jointPhysics?, transmissions? (gears[] removed); SimulationTrace gains aux, ledger, stops, couplingForces
```

## 4. Commands (plugin `dynamics`, toolset `assembly`; `evaluate_motion_profile` in core `commands/motion`)

| Command                                                     | Kind                 | Params (sketch)                                                                                                       |
| ----------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `add_motor` (changed)                                       | mutating             | discriminated `kind` per §3.1; `speed` accepts a prismatic joint (`speedMps`, `maxForceN`)                            |
| `update_motor` (new)                                        | mutating             | `motor`, partial fields of its kind                                                                                   |
| `check_motor_data` (new)                                    | read-only            | `motor` or inline `datasheet`                                                                                         |
| `set_motor_drive` (new)                                     | mutating             | `motor` + `DriveSpec`                                                                                                 |
| `add_motion_profile` (new, core)                            | mutating             | `MotionProfile`                                                                                                       |
| `evaluate_motion_profile` (new, core)                       | read-only            | `profile`, `samples` (2…10001) or `times[]`                                                                           |
| `add_transmission` (new; replaces `add_gear_coupling`)      | mutating             | `Transmission`                                                                                                        |
| `set_joint_physics` (new)                                   | mutating             | `joint` + `JointPhysics` (fields replaced; `null` clears)                                                             |
| `add_load_schedule` (new)                                   | mutating             | `LoadSchedule`                                                                                                        |
| `simulate_motion` (changed)                                 | read-only            | `detail` adds `drives`; `energy` returns the per-element ledger                                                       |
| `plot_simulation` (changed)                                 | read-only            | quantities add `motor_current`, `motor_voltage`, `winding_temperature`, `operating_points`, `energy_ledger`           |
| `size_drive` (new)                                          | read-only            | `motor`, `duration?` (default: whole repeats of the drive profile), `margin` (0.2), `ambientC` (25), `ratioSweep?`    |
| `check_motion_truth` (new)                                  | read-only            | `duration?`, `level: 'quick' \| 'full'`, `outputs?: string[]`, `engines?: ['reference']`                              |
| `fit_drive_parameters` (new)                                | read-only            | `series` (reference-data id or inline `{ t[], omega[], current?[], voltage?[], torque?[] }`), `unknowns[]`, `known{}` |
| `add_reference_data` / `compare_to_reference` (generalised) | mutating / read-only | time series of any joint, drive or ledger quantity, not only engine curves                                            |
| `delete_dynamics_item` (changed)                            | mutating             | also profiles, transmissions, drives, load schedules (cascade: a profile in use is refused with its users listed)     |

Tags (abridged; full text in each command's description):

```
add_motor  @affects doc.dynamics.motors   @invariant dc data passes check_motor_data or carries acceptInconsistent (result unverified)
           @failure unknown / non-revolute joint -> DRV_JOINT_INVALID; inconsistent sheet -> DRV_MOTOR_DATA_INCONSISTENT (checks listed)
set_motor_drive @affects doc.dynamics.drives @failure profile missing or of the wrong quantity -> DRV_PROFILE_INVALID;
           sampleHz not an integer divisor or w_c T_s > 0.2 -> DRV_CONTROL_RATE; tune without a reflected inertia -> DRV_TUNE_NO_INERTIA
add_motion_profile @affects doc.dynamics.profiles @failure velocity jump between segments -> DRV_PROFILE_DISCONTINUOUS;
           S-curve infeasible for (D, v, a, j, duration) -> DRV_PROFILE_INFEASIBLE (with the shortest feasible duration)
add_transmission @affects doc.dynamics.transmissions @failure joint kinds do not match the kind (screw needs revolute + prismatic)
           -> DRV_TRANSMISSION_JOINTS; a joint already driven by another transmission -> DRV_TRANSMISSION_OVERCONSTRAINED;
           efficiency outside (0, 1] -> DRV_EFFICIENCY_INVALID
set_joint_physics @affects doc.dynamics.jointPhysics @failure static < kinetic -> DRV_FRICTION_INVALID; min >= max -> DRV_LIMITS_INVALID
size_drive / check_motion_truth / fit_drive_parameters / check_motor_data / evaluate_motion_profile
           @affects nothing (read-only) @invariant input deep-equal, no FeatureStep
size_drive @failure motor has no drive or no profile -> DRV_NO_DUTY_CYCLE; simulation refusal -> DRV_SOURCE_FAILED (quoted)
```

## 5. Algorithms

### 5.1 DC motor (exact per step)

Electrical: L·di/dt = u − R(T_w)·i − ke·ω; mechanical: torque kt·i on the joint (through the gearhead: N·η·kt·i forward), friction
kt·I0 as a level, rotor J·N² as armature. Per step with ω frozen at the midpoint value (TR-DRV-06): exact exponential in i. Closed-form
check (no friction, no load, rotor only): the 2×2 system has eigenvalues −253.666 s⁻¹ and −3170.58 s⁻¹ for the 148877 data (overdamped).
ω(t) and i(t) are in `drv_reference.json` `dcStep`. Over 30 ms the input energy is 8.6763 J: copper 4.3405 J, kinetic 4.3358 J,
magnetic 1.0e-7 J. A step start from rest dissipates as much as it stores, a classic result the ledger must show.

### 5.2 Transmissions

Gear spin-up through N and η with input inertia J_i and output J_o: α_o = T / (J_i·N + J_o/(N·η)). Lead screw lifting mass m with
screw inertia J and motor torque T_m: a = (T_m·k·η_f − m·g) / (m + J·k²·η_f), k = 2π/lead. Falling with the motor off (back-driven):
a = m·g / (m + J·k²/η_b), zero when self-locking (η_b ≤ 0). Derivations: power through the thread is η × the input power in each
direction (docstrings of `validation/generate_drv_reference.py`). The inertia-matching ratio for a pure inertial load is N = √(J_L/J_m); the
peak motor torque there is 2·√(J_m·J_L)·α_L.

### 5.3 Friction

Stick-slip of a mass on a belt (Coulomb with stiction): stick until k·x = F_s; slip m·ẍ = −k·x + F_k from x_s with ẋ = v_b, ending
when ẋ = v_b again at u = ω·t = 2π − 2·atan(a/v_b), a = (x_s − x_e)·ω; then stick from 2x_e − x_s back to x_s for 2(x_s − x_e)/v_b.
For m 1 kg, k 100 N/m, v_b 0.1 m/s, F_s 2 N, F_k 1 N: slip 0.47124 s, stick 0.2 s, period 0.67124 s.

### 5.4 Profiles and cam laws (rise h over duration β; x = t/β; C_v, C_a = peak v·β/h, a·β²/h)

| Law                | s(x)                                                               | C_v     | C_a     | C_j      |
| ------------------ | ------------------------------------------------------------------ | ------- | ------- | -------- |
| cycloidal          | x − sin(2πx)/(2π)                                                  | 2       | 6.28319 | 39.4784  |
| poly345            | 10x³ − 15x⁴ + 6x⁵                                                  | 1.875   | 5.77350 | 60       |
| harmonic           | (1 − cos πx)/2                                                     | 1.57080 | 4.93480 | ∞ (ends) |
| modified trapezoid | a: sine ramps of width 1/8, flat 2/8 (Neklutin)                    | 2.00000 | 4.88812 | —        |
| modified sine      | a: sine of period 1/2 on [0, 1/8] and [7/8, 1], period 3/2 between | 1.75960 | 5.52796 | —        |

Trapezoid (v_max, a_max): T = D/v_max + v_max/a_max when D ≥ v_max²/a_max, else triangular T = 2·√(D/a_max). 7-segment S-curve
(v_max, a_max, j): T = D/v_max + v_max/a_max + a_max/j when v_max ≥ a_max²/j and D ≥ v_max·(v_max/a_max + a_max/j); otherwise
reduced phases (solved in closed form per case, Biagiotti–Melchiorri [R33]).

### 5.5 Machines (DRV-M4)

PMSM envelope: TR-DRV-07; example λ 0.01 Wb, p 4, L 0.2 mH, I_max 20 A, V_bus 24 V: T_max 1.2 N·m, base 321.634 rad/s, max 577.350 rad/s.
Induction equivalent circuit (magnetising branch at the terminals): T(s) = 3·V²·(R2/s) / (ω_s·((R1 + R2/s)² + X²)),
s_b = R2/√(R1² + X²), T_b = 3V² / (2ω_s·(R1 + √(R1² + X²))); Kloss is its R1 = 0 form [R25]. Stepper small-angle natural frequency
√(T_h·N_r/J)/(2π).

### 5.6 Truth verdict

See TR-DRV-23. The Δt study reuses the existing adaptive halving infrastructure in `simulate.ts`; GCI with the observed order
clamped to [0.5, 4] (an order outside this range is itself reported: `DRV_CONVERGENCE_IRREGULAR`).

## 6. Interop and persistence

All new data lives in `doc.dynamics` (persisted, replayed through history). Profiles are plain JSON tables. `export_urdf` keeps
emitting joints; it adds `<limit effort velocity lower upper>` from motor and joint-physics data (URDF fields exist for these). No
vendor file import in this pack (V2).

## 7. Surfaces and stable error codes

| Code                                                                                       | Raised by                   | Meaning / fix                                                                                  |
| ------------------------------------------------------------------------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------- |
| `DRV_MOTOR_DATA_INCONSISTENT`                                                              | add_motor, check_motor_data | datasheet checks disagree > 2 %: re-read the sheet, or pass `acceptInconsistent` with a reason |
| `DRV_JOINT_INVALID`                                                                        | add_motor, set_motor_drive  | missing joint or a joint kind the motor cannot drive                                           |
| `DRV_PROFILE_INVALID` / `_DISCONTINUOUS` / `_INFEASIBLE`                                   | profiles, drives            | bad quantity, velocity jump, impossible S-curve (shortest feasible duration given)             |
| `DRV_CONTROL_RATE`                                                                         | set_motor_drive, simulate   | sample period not k·Δt or ω_c·T_s > 0.2                                                        |
| `DRV_TUNE_NO_INERTIA`                                                                      | set_motor_drive             | tuning needs bodies with mass on the driven chain                                              |
| `DRV_TRANSMISSION_JOINTS` / `_OVERCONSTRAINED`                                             | add_transmission            | wrong joint kinds / a joint already coupled                                                    |
| `DRV_EFFICIENCY_INVALID`, `DRV_FRICTION_INVALID`, `DRV_LIMITS_INVALID`                     | edits                       | value out of range                                                                             |
| `DRV_EFFORT_UNBOUNDED` (warn)                                                              | check_dynamics, truth       | an actuator bound with no source or > 10× its use: use a motor model or a sourced limit        |
| `DRV_PARAM_UNSOURCED` (warn)                                                               | truth, size_drive           | listed parameters have no source: results `unverified`                                         |
| `DRV_ELECTRICAL_QUASI_STATIC` (info)                                                       | simulate                    | τe ≪ Δt: current treated as quasi-static                                                       |
| `DRV_THERMAL_MODEL_FORM` (info)                                                            | simulate, size_drive        | the 2-node network's time constants vs the datasheet pair                                      |
| `DRV_THERMAL_OVER` / `DRV_THERMAL_RUNAWAY`                                                 | size_drive, simulate        | winding above its limit / no steady state at that RMS current                                  |
| `DRV_PEAK_OVER`, `DRV_RMS_OVER`, `DRV_SPEED_OVER`, `DRV_VOLTAGE_LIMITED`, `DRV_MARGIN_LOW` | size_drive                  | the limiting factor, with the value and the limit                                              |
| `DRV_TRACKING_ERROR` (warn)                                                                | simulate, size_drive        | prescribed / servo axis did not follow its profile: effort is not the inverse dynamics         |
| `DRV_STEPS_LOST`                                                                           | simulate                    | stepper slipped poles (time and count)                                                         |
| `DRV_MESH_STIFFNESS_ASSUMED` (info)                                                        | simulate                    | backlash contact stiffness defaulted                                                           |
| `DRV_CONVERGENCE_IRREGULAR` (warn)                                                         | check_motion_truth          | observed order outside [0.5, 4]: refine Δt or check discontinuities                            |
| `DRV_FIT_UNIDENTIFIABLE`                                                                   | fit_drive_parameters        | the data cannot separate the named pair; add the missing experiment                            |
| `DRV_NO_DUTY_CYCLE`, `DRV_SOURCE_FAILED`                                                   | size_drive                  | no profile / the simulation refused (quoted)                                                   |
| `NATIVE_TOOL_MISSING`                                                                      | check_motion_truth engines  | (V1) no reference engine installed                                                             |

CLI: no special case (AF-01). UI: Mechanisms › Physics › Drives (`src/ui/panels/DrivesSection.tsx`, charts in
`src/ui/panels/drives/*`), palette entries from the registry; truth badge in `PhysicsSection.tsx`.

## 8. Performance and robustness budgets (reference machine: the owner's Windows 11 workstation)

| Operation                                                     | Budget                         |
| ------------------------------------------------------------- | ------------------------------ |
| Actuator + controller + ledger evaluation per step, 10 motors | ≤ 10 % of the MuJoCo step time |
| `drv_servo_sizing` plan, 5 s at Δt 0.1 ms (50 000 steps)      | ≤ 5 s through the CLI          |
| `size_drive` with a 6-ratio sweep                             | ≤ 7 × one simulation           |
| `check_motion_truth level quick` / `full`                     | ≤ 3× / ≤ 8× one simulation     |
| Reference engine, 10-body tree, 1 s at rtol 1e-9              | ≤ 30 s (verification only)     |
| `evaluate_motion_profile` 10 001 samples                      | ≤ 50 ms                        |

Robustness: every law is pure and total (non-finite input → refusal code, never NaN in a series); the simulation step cap
(1 000 000) and the existing timeouts stay; the Δt study never runs below 1e-6 s.

## 9. Test strategy

| Level                        | What                                                                                                                    | VC                                |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| unit (laws, pure)            | DC exponential step, thermal matrix exponential, controllers, friction levels, screw efficiencies, profiles, envelopes  | 03–09, 12, 13, 15, 21–27          |
| unit (commands)              | schemas, codes, purity, check_motor_data, set_motor_drive guards, profile continuity, transmission joints               | 01, 02, 33–35                     |
| unit (MuJoCo, through plans) | the validation plans with tolerances from `expected_results.json`                                                       | 04, 05, 10, 13, 14, 16–20, 23, 24 |
| contract                     | tool-schema snapshot, `isolatedSuites` if a suite fakes the engine, `blockedPlanCommands.json` entries removed as built | —                                 |
| golden                       | `drv_servo_sizing`, `drv_lead_screw`: ids, data, series hashes (per engine version)                                     | 35                                |
| server                       | `packReplay23` replays the plans through the CLI (as `packReplay10`)                                                    | all plan VCs                      |
| oracle                       | `generate_drv_reference.py` (stdlib, byte-identical)                                                                    | all A cases                       |
| cross-engine (V1)            | reference engine vs MuJoCo on pendulum, double pendulum, slider-crank, Andrews                                          | 31, 32                            |
| component                    | Drives panel dispatches; charts from `size_drive` data                                                                  | 36 (UI part)                      |
| human                        | reviewer reads the ledger and the torque–speed chart on the sizing plan                                                 | —                                 |

## 10. Delivery plan

| Milestone | Content                                                                                                                                                                                                                                                         | Lane          | Depends on         | Effort (agent-days) |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ------------------ | ------------------- |
| DRV-M0    | spike on MuJoCo 3.16 WASM: per-step `dof_frictionloss` writes, `range` + `solreflimit [−k, −b]` restitution, fixed tendon limit as backlash, hinge–slide equality, `armature`, constraint forces readable per row; `dcmotor` vs the core law (decides D-DRV-01) | 1             | —                  | 1.5                 |
| DRV-M1    | profiles (core) + `evaluate_motion_profile`; `dc` motor + `check_motor_data`; port `ActuatorBlock`; drives voltage / torque / velocity / position / prescribed with tuning and guards; drive series; ledger; `DRV_EFFORT_UNBOUNDED`                             | 1             | M0                 | 5                   |
| DRV-M2    | `add_transmission` (gear with η_f / η_b + locking + backlash, belt, lead / ball screw, rack) replacing `add_gear_coupling`; `set_joint_physics` (stiction, Stribeck, load-dependent, limits, armature); `add_load_schedule`                                     | 1             | M0                 | 5                   |
| DRV-M3    | `size_drive`, `check_motion_truth` (a)–(f), generalised reference data, `fit_drive_parameters`, `check_prototype` aggregation, plots, `packReplay23`, golden plans; PHY-22 readout hook (`<motor>.<quantity>`)                                                  | 1 (+4 server) | M1, M2             | 4                   |
| DRV-M4    | `pmsm`, `stepper`, `induction` kinds                                                                                                                                                                                                                            | 1             | M1                 | 3                   |
| DRV-M5    | Drives panel, charts, truth badge, verified in the desktop app                                                                                                                                                                                                  | 2             | M3                 | 3                   |
| DRV-V1    | `packages/physics-reference` + cross-check (g); hydraulic cylinder; Andrews' squeezer under `check_motion_truth`                                                                                                                                                | 1             | M3                 | 6                   |
| DRV-V2    | contacts, flexible shafts, efficiency maps, cogging, pneumatics, FMI 3.0 controllers, catalogue import                                                                                                                                                          | —             | V1, PHY-06, PHY-09 | later               |

MVP (M0–M3) ≈ 15.5 agent-days; V1 ≈ 12 more. Order: M0 → (M1 ∥ M2) → M3 → (M4 ∥ M5) → V1. Each milestone: `cad-reviewer`, `npm run
check:coverage`, server suite (`packReplay23`), the plans' `blockedPlanCommands.json` entries removed as commands land.

## 11. Open questions and proposed decisions

| #         | Question                                                                                               | Proposed                                                                                                                                                                                                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-DRV-01  | Core motor law vs MuJoCo's native `dcmotor` actuator [R4]                                              | **Core law** (TR-DRV-05/06): engine-independent (the reference engine and PMSM / stepper / induction need it anyway), exact per-step ledger, one implementation. **DECIDED (DRV-M0, §13.7)**: `dcmotor` is first order (speed 1.5 % off at dt 1e-5, current 5 % off at dt 1e-4); the core law is within 0.005 % |
| D-DRV-02  | Language of the laws and the reference engine (C7)                                                     | TypeScript, in-process (per-step callback); Rust only after a measured need                                                                                                                                                                                                                                     |
| D-DRV-03  | Transmission losses: force law (today's smoothed loss torque) or friction level                        | **Friction level** on the input joint (TR-DRV-12): holds at rest, gives self-locking without a special case, no sign smoothing (the chatter Modelica warns about [R9]); `gearLoss.ts` retired                                                                                                                   |
| D-DRV-04  | `add_gear_coupling` kept beside `add_transmission`?                                                    | No (owner rule: no backward compatibility). One command; golden plans and docs updated in M2                                                                                                                                                                                                                    |
| D-DRV-05  | Default copper α                                                                                       | 0.0039 /K (maxon catalogue convention [R1]); Simscape uses 3.93e-3 [R5]; overridable per motor                                                                                                                                                                                                                  |
| D-DRV-06  | Ship a motor catalogue?                                                                                | Not in this pack (licences of vendor data). Datasheet entry by the agent with a source; a local user library later (V2)                                                                                                                                                                                         |
| OQ-DRV-01 | Is writing `dof_frictionloss` between steps supported by the 3.16 JS bindings without a recompile?     | **DECIDED (DRV-M0, §13.1)**: yes, a plain array write takes effect at the next `mj_step`; emit flat `solimpfriction` 0.9999 or the hold creeps. No fallback needed (a rebuild costs 0.64 ms anyway)                                                                                                             |
| OQ-DRV-02 | MuJoCo limit restitution with `solreflimit` direct form: is the impact exactly a linear spring-damper? | **DECIDED (DRV-M0, §13.2)**: yes with a flat `solimplimit` (0.9999 0.9999 0.001); but the direct form is an ACCELERATION law (divide K, B by the row's effective inertia) and a one-sided stop has e = 0.5717, not the bilateral 0.5266                                                                         |
| OQ-DRV-03 | PHY-21 Q2 (two mechanism models)                                                                       | out of scope; profiles are shared so a later unification keeps them                                                                                                                                                                                                                                             |
| OQ-DRV-04 | IFToMM per-problem reference tables (pendulum, slider-crank) were not reachable                        | V1 cross-engine cases use the reference engine; pin IFToMM values when read (grade upgrade)                                                                                                                                                                                                                     |

## 12. References

[R1]–[R33], M1: [`validation/sources.md`](validation/sources.md).

## 13. As built

### DRV-M0 (spike, 2026-11-06): MuJoCo 3.16.0 WASM

Pinned by `tests/unit/mujocoDriveSpike.test.ts` (20 tests, raw MJCF through `@mujoco/mujoco`; no port or adapter code changed). Numbers: Node, reference machine.

**13.1 `dof_frictionloss` per step (OQ-DRV-01: decided, works).** `model.dof_frictionloss[i] = x` between two `mj_step` calls takes effect at the next step (no
recompile, no `mj_setConst`). J 0.01, 1.5 N·m applied: level 2 holds, lowered to 0.5 it slips at (1.5 − 0.5)/0.01 · 0.1 s = 10.000 rad/s, raised to 3 it stops
(|ω| < 1e-6). The row is `efc_type 1` (friction-DOF), `efc_id` = dof, `efc_force` = −1.5000 while sticking (the reaction is readable). **The hold is not exact by
default**: the soft row impedance leaks a constant creep, 0.158 rad/s with the default `solimpfriction`, 1.5e-4 rad/s with `solimpfriction="0.9999 0.9999 0.001"`,
1.5e-5 rad/s adding `solreffriction="0.0002 1"` (2 timesteps at 1e-4). Rule for M2 (TR-DRV-02): always emit flat `solimpfriction` 0.9999 and `solreffriction`
= 2 dt. The fallback was not needed, its cost: `from_xml_string` + `MjData` = 0.64 ms for a one-body model, against 1.2 µs per `mj_step`.

**13.2 Limit with `solreflimit [−k, −b]` (OQ-DRV-02: decided, with corrections to TR-DRV-17).**

1. **The direct form is an acceleration law**, scaled by the row's effective inertia. The same (k, b) gives an identical impact on J 0.01 and J 0.04 (restitution
   equal to 1e-6, peak to 1e-9; `armature` changes nothing either), and passing K = 1000 N·m/rad unscaled gives ω_n 10x too low (restitution 0.94, peak 2.9x). M1 / M2
   must write `solreflimit = [−K/J_eff, −B/J_eff]`. In a multibody J_eff of the row depends on the configuration, so either rewrite the row's solref per step from the
   effective inertia, or use the explicit alternative (item 5). M2 decides with a multi-body test; a single hinge on a fixed chain is exact either way.
2. With flat `solimplimit="0.9999 0.9999 0.001"`, J 0.01, K 1000, ζ 0.2 (ω_n 316.2 s⁻¹), 1 rad/s impact at dt 1e-5: restitution **0.57194** vs the one-sided
   spring-damper oracle (force ≥ 0, explicit 1e-6 s) **0.57169** (0.04 %); peak penetration **2.39138e-3 rad** vs 2.39086e-3 (0.02 %) and vs the reference
   `endStop.peakPenetrationRad` 2.39111e-3; contact ends at 10.11 ms. The default `solimplimit` (0.9, 0.95) moves the peak by 0.5 % and e by 0.003: flat is the rule.
3. **VC-DRV-20 reference defect (to fix in M1).** The reference `endStop.restitution` 0.52662 = exp(−ζπ/√(1−ζ²)) is the BILATERAL spring-damper (the damper keeps
   pulling after the spring force reached zero). A stop cannot pull; the one-sided value is **0.5717** (8.6 % higher, measured and by the oracle), far outside the
   3 % tolerance. M1 regenerates `endStop.restitution` in `generate_drv_reference.py` / `expected_results.json` and changes the ζ ⇄ e map of TR-DRV-17 to a numeric
   inverse of the one-sided e(ζ) instead of ζ = −ln e/√(π²+ln²e). Peak penetration and contact time agree with the reference.
4. Timestep: restitution error against dt 1e-5 is +0.45 % at dt 1e-4 (ω_n dt 0.03) and +6.8 % at dt 1e-3 (0.32). Rule: ω_n dt ≤ 0.05, else a coarse-step refusal.
5. Explicit alternative (stop force `−max(0, Kq + Bq̇)` through `qfrc_applied`, dt 1e-4): restitution within 0.05 of the oracle (asserted to one decimal only).
   The limit row is readable: `efc_type 3` (joint limit), `efc_force` in N·m = K x + B v of the stop within 1 %.

**13.3 Fixed tendon as backlash (works).** Two hinges, `<fixed limited range="±gap/2" solreflimit="−K −B" solimplimit=flat>` with coefficients (1, −1): the driver
crosses the free gap alone (first load motion at 0.0316 s vs analytic √(gap/α) = 0.03162 s; no constraint row while inside), deepest penetration 1.6e-4 rad (1.6 % of the
10 mrad gap, K 1e6, ζ 0.5 in acceleration units), then both turn together (1.0000 rad/s at 0.3 s, momentum + 0.1 N·m on J 0.03, as predicted). Row: `efc_type 4`
(tendon limit); `ten_length` is readable. Same acceleration-law caveat as 13.2. TR-DRV-03 stands.

**13.4 Hinge–slide equality (works; needs a tight solref).** `<joint joint1=slide joint2=hinge polycoef="0 ratio 0 0 0">` with `solref="0.0004 1"` (4 dt) and flat solimp
holds q_b = ratio·q_a to 6e-8 relative; the angular acceleration matches the reflected inertia J + m·ratio² to 4 decimals and the row force (`efc_type 0`) is the
nut's m·a = 3.18e-4 N. **The default equality solref (0.02 1, solimp 0.9/0.95) lags by 73 %** under a 0.5 mN·m load: the adapter must always set `solref` ≤ 4 dt and flat
`solimp` on transmission equalities (TR-DRV-03). Valid for hinge–hinge and hinge–slide.

**13.5 Armature (works with a refresh).** `armature="0.02"` on J 0.01 gives ω = T t/(J + a) exactly (3.333333333 rad/s). **Writing `dof_armature` alone is silently ignored**
(the value reads back but the mass matrix is not rebuilt); `mj_setConst(model, data)` after the write applies it (ω 2.000000000 for 0.04 + 0.01). M2 must add `mj_setConst`
to the `MujocoModule` binding if armature changes at run time; a build-time `armature` (rotor J·N²) needs nothing.

**13.6 Constraint rows (readable per row).** `nefc`, `efc_type`, `efc_id`, `efc_force` give friction (type 1), equality (0), joint limit (3) and tendon limit (4) rows
separately, in generalised-force units of the row (N·m on a hinge, N on a slide); every value above was read this way. `efc_*` are already declared in `bindings.ts`.

**13.7 `dcmotor` vs the core law (D-DRV-01: decided, core law).** MuJoCo 3.16 has `<dcmotor motorconst resistance inductance>` (one `act` state = current). Maxon 148877,
48 V step, rotor only; errors against the exact `dcStep` solution at the reference samples on the step grid (4.28 ms is on the grid only for dt 1e-5) and the peak 36.8299 A:

| Law              | dt     | max speed error | max current error | peak current error |
| ---------------- | ------ | --------------- | ----------------- | ------------------ |
| core (spec 5.1)  | 1e-5   | < 0.001 %       | 0.001 %           | 0.0001 %           |
| core             | 2.5e-5 | 0.002 %         | 0.006 %           | 0.001 %            |
| core             | 1e-4   | 0.044 %         | 0.10 %            | 0.03 %             |
| native `dcmotor` | 1e-5   | 1.53 %          | 0.06 %            | 0.001 %            |
| native `dcmotor` | 2.5e-5 | 3.76 %          | 0.36 %            | 0.009 %            |
| native `dcmotor` | 1e-4   | 13.9 %          | 5.2 %             | 0.15 %             |

The native law is first order: the current state is staggered by about half a step against the velocity (a constant absolute speed error of about α·dt/2 = 0.73 rad/s at
dt 1e-5, hence large at 0.5 ms) and its late-time current error grows with dt. It fails the 0.5 % acceptance (AC-3) at every step tested; the core law passes with a margin
of 5x at dt 1e-4 (a third of L/R = 0.29 ms). The core law is the exponential of 5.1 with ω_mid = ω + ½Δt·kt·i/J and torque kt · (mean current over the step). `dcmotor` stays
a possible cross-check only; no change to M1.

**13.8 Plan changes.** (a) M1 fixes the VC-DRV-20 reference (13.2.3) and the ζ map of TR-DRV-17. (b) M2 limits / backlash write K, B in acceleration units (J_eff) or use an
explicit applied-force stop. (c) M2 run-time armature needs `mj_setConst` in the binding. (d) Every constraint row the adapter emits uses flat impedance and solref ≤ 4 dt
(friction, equality, limits). (e) No port change was needed in M0.

### DRV-M1 (2026-11-06): profiles, DC motor, drives, ledger

**13.9 Built.** Commands (plugin `dynamics`, toolset assembly, except the two profile commands that live in core `commands/motion`): `add_motion_profile`, `evaluate_motion_profile`,
`add_motor kind "dc"` (datasheet + gearhead + source, checked on entry), `check_motor_data`, `set_motor_drive` (voltage / torque / velocity / position / prescribed), `simulate_motion detail "drives"`
(per-motor series, `data.drives`, `data.ledger`), `DRV_EFFORT_UNBOUNDED` in `check_dynamics`; `add_motor kind "speed"` takes an optional `source` for its `maxTorque`; `delete_dynamics_item`
handles profiles (refused while a drive uses one, users listed) and drops the drive of a deleted motor or joint. Data: core `model/drives.ts`; `DynamicsModel` gains `profiles` and `drives`
(load validation in `commands/persistence/drivesValidation.ts`: shapes, the profile compiled again, drive to motor and drive to profile cross references both ways). Core `geometry/motionProfile.ts`
(pure evaluator, the unit table) and `lib/pchip.ts` (the Fritsch-Carlson interpolant of the propeller table, shared). Port (`dynamics/physicsEngine.ts`): `SimulationModel.actuators?: ActuatorBlock`
as in 3.2 plus `joints` (the ids `jointForces` is indexed by), `SimulationJoint.armature?`, `SimulationTrace.{aux, ledger, actuatorWork}`; the MuJoCo adapter calls `advance` once per step with the
midpoint state it gives `loads`, adds the joint and body forces, records aux and the cumulative ledger per sample, and writes `armature` into the joint. The jointPhysics and transmissions blocks
are M2. Plugin laws: `sim/actuators/{dcMotor,controller,block,series,motorData}.ts`, `sim/{ledger,driveReport,endStop}.ts`.

**13.10 Choices and corrections to the text above.**

1. **D-DRV-01 as built.** The winding is the exponential of TR-DRV-06 with ω frozen at the engine's step-midpoint velocity (the extrapolation `loads` already uses); the torque is kt times the mean current. The
   current in the series is the end-of-step current. L = 0 or τe < Δt/50 is quasi-static (no magnetic term; `DRV_ELECTRICAL_QUASI_STATIC` info). Torque, velocity, position and prescribed modes drive an ideal current
   loop (L ignored there: the ledger closes without a magnetic term); only `voltage` mode integrates the winding. Current limit: `currentLimitA`, else `peakCurrentA`, else U/R; `busVoltageV` bounds R*i + ke*ω.
2. **Gearhead (corrects TR-DRV-05 / 12 for the motor).** The mesh sits between the rotor and the joint, so the rotor's inertial torque is upstream of the loss: the joint sees `(J_o + η N² (J_r + J_g)) α = η N τ_em`.
   The armature written to MuJoCo is therefore η_f N² J, not N² J (VC-DRV-10 reference 345.755 rad/s² is met to 0.5 %; N² J gave 328.5). The no-load friction kt I0 reaches the joint as η_f N kt I0.
   Exact while motoring; when back-driving the armature is an approximation (η_b is applied to the torque only). Torque and braking torque use η_f (motoring, τ·ω_m >= 0) and 1/η_b (braking).
3. **Open circuit.** A datasheet motor with no drive adds its armature and friction and no torque (its terminals are open); there is no `drives` data for it.
4. **Controllers.** The measurement is the midpoint state (a half-step estimate), the command is held for k = round(1/(sampleHz Δt)) steps; k·Δt must equal 1/sampleHz to 1e-6 or the run is refused
   (`DRV_CONTROL_RATE`, also refused at `set_motor_drive` when ω_c/sampleHz > 0.2). The integrator is not advanced while the clamped output pushes further into saturation. `tune` is resolved from the
   reflected inertia at run time (bodies + armature), `gains` {kp, ki, kpPosition} are stored with the defaults ki 0 and kpPosition 0 filled in. Position mode is a P loop (kpPosition, plus the profile
   velocity with feedforward) around the velocity PI. **Prescribed** is a PD servo with ω_n·Δt = 0.1 and the profile acceleration times J as feedforward (the S-curve of VC-DRV-24 then needs 0.1000 N·m
   to 1 %; without the feedforward the servo's own transient put 3.6 % on the peak). Torque profiles are at the motor shaft; velocity / position profiles are the target joint's.
5. **Profiles.** `ProfileSegment` is a flat object in the command (kind, law, to, duration, vmax, amax, jerk, accelFraction, sine and table fields) and a discriminated union in the model. Value
   continuity is always checked; velocity continuity only for `position` profiles; `repeat > 1` needs the end to equal the start. The S-curve with a longer duration than the shortest stretches by lowering the
   cruise speed (bisection on the monotone T(v)); a trapezoid with `amax` and a longer `duration` solves v from D = v (T - v/a). A duration-only S-curve uses `accelFraction` (default 1/3) and jerk fraction 1/4.
   Sine segments are added to the value at their start (continuous by construction). Table times are relative to the segment start; its first value is the current value. Caps: 10000 segments, 100000 table
   points, 10001 samples.
6. **Effort.** `DRV_EFFORT_UNBOUNDED` is raised by `check_dynamics` for a speed motor without `source`, and for a sourced one whose bound is more than 10 times the peak servo torque of the run.
   `simulate_motion` itself stays quiet about it (existing summaries unchanged). A governor whose bound is below what its start-up kick would use saturates, so its measured peak equals the bound.
7. **End stops (TR-DRV-17, DRV-M0 13.8a).** `sim/endStop.ts` has the one-sided restitution e(ζ) = e^(-ζθ/√(1-ζ²))·|cos θ - ζ/√(1-ζ²) sin θ|, θ = atan2(2ζ√(1-ζ²), 2ζ²-1), and its numeric
   inverse (bisection, domain ζ in [0, 0.999]); `generate_drv_reference.py` and `expected_results.json` carry restitution 0.571740 (spike 0.57194, 0.04 %), the release time 8.840 ms and the contact time
   10.105 ms (spike 10.11 ms); the bilateral 0.526621 stays as `restitutionBilateral`. The reference file sha is `f0baa56b…15f24`; VC-DRV-20 now has 3 values (88 in all). `mujocoDriveSpike.test.ts` asserts
   the new reference. No end-stop command yet (M2 `set_joint_physics`).
8. **Announced speed.** A datasheet motor announces no top speed (its speed depends on the load): `FPR_SAMPLING_ALIASED` is not evaluated for a run whose only motors are datasheet motors.

**13.11 Oracle results (MuJoCo 3.16.0, Δt 1e-5 unless stated).** VC-DRV-04: speed within 1.4e-5 relative and current within 2.7e-5 relative (end-of-step current) of the exact `dcStep` samples at 0.5 / 1 / 2 / 4.28 / 10 / 20 / 30 ms;
peak 36.83 A at 0.87 ms. VC-DRV-05: input 8.67631 J, copper 4.34049 J, kinetic 4.33582 J, magnetic 1.0e-7 J, closure 2.3e-8 of the input (gate 1e-3). VC-DRV-03: 7589.15 rpm to 0.2 %. VC-DRV-23 (J 1e-3, ζ 1, ω_c 100,
10 kHz, Δt 1e-4): 0.6976 / 1.0003 / 1.1349 / 1.0270 against 0.6967 / 1.0 / 1.1353 / 1.0270. VC-DRV-24: peak effort 0.100 N·m within 1 %, tracking error 1e-4 rad on a 1 rad move. VC-DRV-01 / 02 as in the plan,
VC-DRV-21 / 22 to 1e-6, the gearhead case to 0.5 %.

**13.12 Left.** Thermal model and its VCs (06-09, `size_drive`), `check_motion_truth`, `fit_drive_parameters`, plots, the prismatic `speed` motor of the stick-slip plan, transmissions, `set_joint_physics`, `add_load_schedule`, the
`jointPhysics` / `transmissions` port blocks (M2); pmsm / stepper / induction (M4). Blocked plans remaining: `drv_lead_screw` (add_transmission), `drv_stick_slip` (set_joint_physics), `drv_servo_sizing` (add_transmission,
set_joint_physics, size_drive, check_motion_truth); `drv_maxon_step` runs end to end (`tests/unit/drives/dcMotorStep.test.ts`).
