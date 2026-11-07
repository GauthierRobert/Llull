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
| TR-DRV-05 | DC motor law (`sim/actuators/dcMotor.ts`): ke = kt (SI). Friction torque T_f = kt·I0 is applied as a Coulomb friction level on the motor joint (constraint, holds at rest), not as a force. Rotor inertia enters as joint `armature` = η·N²·J_rotor (§13.10 item 2: the mesh sits between rotor and joint) on the output joint when a gearhead N is declared (MuJoCo: `armature` is "extra inertia not from body mass" [R2])                                                                                                                                                                                                              |
| TR-DRV-06 | Electrical state per step (exact for ω frozen at the midpoint): i_ss = (u − ke·ω)/R, i₁ = i_ss + (i₀ − i_ss)·e^(−Δt/τe). Torque over the step = kt·ī with ī = i_ss + (i₀ − i_ss)·(τe/Δt)·(1 − e^(−Δt/τe)). Copper energy over the step is the exact ∫R·i² of the exponential. Current limit: the drive clamps u so that the steady current stays ≤ I_lim. When L = 0 or τe < Δt / 50, quasi-static i = i_ss (info `DRV_ELECTRICAL_QUASI_STATIC`)                                                                                                                                                                                          |
| TR-DRV-07 | PMSM / BLDC law (DRV-M4): ideal FOC current loop; T = 1.5·p·λ·i_q (surface magnet, L_d = L_q). The torque command is limited by the envelope at the present speed: constant to ω_b = V_max / √(λ² + (L·I_max)²) / p (R = 0), then field weakening at the current limit with i_d = ((V_max/ω_e)² − λ² − (L·I_max)²) / (2λL), i_q = √(I_max² − i_d²), up to ω_max = V_max / ((λ − L·I_max)·p) when λ > L·I_max; V_max = V_bus/√3 (SVPWM). Copper loss 1.5·R·(i_d² + i_q²) enters the ledger (envelope with R = 0 is stated as model form)                                                                                                   |
| TR-DRV-08 | Stepper law (DRV-M4): T = −T_h(ω)·sin(N_r·(θ − θ_cmd)) − T_det·sin(4·N_r·θ); T_h(ω) from the pull-out table (holding torque at 0); θ_cmd from the step profile (full / half / micro-step). Steps lost = round(N_r·(θ_cmd − θ)/(π/2)) ≠ 0, reported with time (`DRV_STEPS_LOST`; corrected to whole electrical periods in 13.26 item 4). Induction law: Kloss T = 2·T_b / (s/s_b + s_b/s) or the equivalent-circuit form (§5); slip s = (ω_s − ω)/ω_s, ω_s from a line frequency or a V/f profile                                                                                                                                                                                                 |
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
kt·I0 as a level, rotor η·N²·J as armature (§13.10 item 2). Per step with ω frozen at the midpoint value (TR-DRV-06): exact exponential in i. Closed-form
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
| `DRV_THERMAL_OVER` / `DRV_THERMAL_PEAK_OVER` / `DRV_THERMAL_RUNAWAY`                       | size_drive, simulate        | steady winding at the RMS current above its limit (cycle assumed to repeat) / the simulated window itself above it / no steady state |
| `DRV_PEAK_OVER`, `DRV_RMS_OVER`, `DRV_SPEED_OVER`, `DRV_VOLTAGE_LIMITED`, `DRV_MARGIN_LOW` | size_drive                  | the limiting factor, with the value and the limit                                              |
| `DRV_TRACKING_ERROR` (warn)                                                                | simulate, size_drive        | prescribed / servo axis did not follow its profile: effort is not the inverse dynamics         |
| `DRV_STEPS_LOST`                                                                           | simulate                    | stepper slipped poles (time and count)                                                         |
| `DRV_MODE_UNSUPPORTED`                                                                     | set_motor_drive, simulate, load | the motor kind does not take that drive mode (13.26 item 1) |
| `DRV_STEPPER_TIMESTEP` (warn)                                                              | simulate                    | explicit step too coarse for the stepper ringing / damping (13.26 item 4) |
| `DRV_PMSM_VOLTAGE_OVER` (warn)                                                             | simulate                    | stator voltage above V_bus/√3: the envelope neglects R (13.26 item 3) |
| `DRV_INDUCTION_QUASI_STEADY` (info)                                                         | simulate                    | steady-state torque at the instantaneous slip, no flux transients (13.26 item 5) |
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

**13.13 Review round (DRV-M1).** Load validation of profiles and drives no longer throws on hostile records (unknown segment kind or move law, malformed table points, wrong-typed gains / target / feedforward; a try/catch backstop in `profileProblem`; the unit table is read with `Object.hasOwn`); `tests/unit/contract/pluginSliceFuzz.test.ts` runs the dynamics slice (`DYNAMICS_SEED`, `driveMutations`) and `hostileInput` has a dynamics entry. Anti-windup also freezes the integrator when the realized current was cut by the bus voltage or the current limit (aux slot `clipped`). The ledger reports the potential-energy change like the kinetic one.

### DRV-M2 (2026-11-07): transmissions, joint physics, load schedules

**13.14 Built.** `add_transmission` (gear with `teeth` / `reverseRotation` / η_f / η_b / `backlashDeg` + mesh stiffness, belt, lead screw, ball screw, rack and pinion; replaces `add_gear_coupling` and `gearLoss.ts`, both removed with no shim),
`set_joint_physics` (coulomb, stiction, Stribeck, load-dependent friction, end stops by stiffness + damping ratio or restitution, armature; fields replace, `null` clears), `add_load_schedule` (a body force or a joint torque / force from a profile or a
constant), `add_motor kind "speed"` on a prismatic joint (`speedMps`, `maxForceN`, stored as kind `linear_speed`). Data: core `model/transmissions.ts` (`Transmission`, `JointFriction`, `JointLimits`, `JointPhysics`, `LoadSchedule`, `couplingsOf`);
`DynamicsModel` loses `gears` and gains optional `transmissions`, `jointPhysics`, `loadSchedules` (load validation `commands/persistence/transmissionsValidation.ts`: shapes, joint / body / profile references, a joint driven once; total on hostile input,
`DYNAMICS_SEED` carries all three records, `mechanismMutations` + a hostile-reader entry + `tests/unit/drives/mechanismPersistence.test.ts`). Port (`dynamics/physicsEngine.ts`): `SimulationModel.gears` becomes `transmissions: TransmissionCoupling[]`
(ids, ratio, `efficiency {forward, backward}`, `backlash {gap, stiffness, damping, effectiveInertia}`), `jointPhysics?: JointPhysicsBlock` (`frictionJoints`, `restLatch`, `needsLoad`, `frictionLevel(state, observation)`, `limits`), and the trace gains
`heat` (cumulative joules per friction / transmission / stop element) and `stops` (peak penetration, peak force). Plugin: `sim/{transmissions,jointPhysics,loadSchedules,reflectedInertia,transmissionReport}.ts`, `commands/{transmissions,jointPhysics,loadSchedules}.ts`.
Adapter (`physics-mujoco`): `mjcf.ts` (equalities, limited fixed tendons, joint ranges), `constraintPhysics.ts` (per-step forward pass, friction levels, heat, stop work).

**13.15 Choices and corrections to the text above.**

1. **Transmission loss (TR-DRV-12 / 13, D-DRV-03) as built.** Every step the adapter runs a forward pass of the start state (loads and actuator forces applied) and reads the coupling row (equality, or the backlash tendon limit): its torque T_c on the
   driver DOF is `efc_J · efc_force`, no lag. Mode: when the driver moves (|v| > 1e-4) forward iff T_c · v < 0; at rest forward iff the applied torque (loads + servos) opposes T_c and exceeds it (so a screw with η_b <= 0 holds a load and still lifts when
   the motor wins). Level = |T_c| (1 - η_f) / η_f forward, |T_c| (1 - η_b) back-driven, added to the DOF's `frictionloss` (constant + joint-physics level + every coupling level; `solreffriction` 2 Δt and flat `solimpfriction` 0.9999, DRV-M0 13.1). The
   back-drive efficiency of a thread is not clamped: η_b <= 0 is the self-locking test (the reference file reports 0 for the clamped value; the level uses the real -0.0877 at μ 0.35).
2. **MuJoCo regularises joint equalities with the wrong inverse inertia (new finding, the cause of a failed first run).** `efc_R = (1 - d)/d · (w_1 + w_2)` with `w` the per-DOF inverse inertias, WITHOUT the polycoef factor, while the row's true inverse inertia is
   `w_1 + c² w_2`. Written as q_nut = 1.59e-3 m/rad · q_screw against a 1e-5 kg·m² screw the regularisation is 28 times the row, and a 0.5 N·m screw spun free for 5 ms (the nut fell at -8.5 m/s²) in raw MuJoCo too (all solvers, integrators, `solref` down to 2 dt).
   `mjcf.ts` writes every transmission equality with the larger coefficient as the dependent joint (|c| >= 1: `q_screw = 628 · q_nut`); then R is 1e-4 of the row and the coupling holds from the first step. Tendon limit rows (backlash) use MuJoCo's own tendon inverse inertia and are exact.
3. **Self-locking and creep.** A held load leaks at v = (1 - d)/d · Δt · (free acceleration of the load) through the soft friction row (about 1e-4 · Δt · a: 2.5e-7 m/s on the screw plan at Δt 1e-4). VC-DRV-14 (motor off, ≤ 1e-6 m in 1 s) is met at Δt 5e-5 (1.07e-6 at 1e-4); it scales with Δt.
   For `stiction` / `stribeck` joints that no transmission or loop couples, the adapter applies a Karnopp dead band (`restLatch`): while the joint is at rest (|v| < 1e-4) and its friction constraint is inside its limit, velocity AND position are restored after the step, so the displacement
   before breakaway is 0 (VC-DRV-17 needs ≤ 1e-9 m; without the latch 4e-9 at Δt 2e-5). Breakaway is detected on the constraint: the friction row at 1 - 1e-5 of its level switches the level to kinetic, so the slide breaks away at 2.000 s +- 1 ms and accelerates at (F - F_k)/m.
4. **End stops and backlash (corrects TR-DRV-17 / 03, 13.8b).** `solreflimit = [-K/J_eff, -B/J_eff]` with flat `solimplimit`; J_eff is the inertia of the rigidly coupled cluster at the joint (`reflectedInertia`: Σ c_k² J_k over the equality couplings, plus armature; static in the
   configuration, exact for a single hinge or a fixed chain), B = 2 ζ √(K J_eff), ζ from `dampingRatio` or the numeric inverse of the one-sided e(ζ) (default restitution 0.5). A backlash row uses the series inertia 1/(c²/J_in + 1/J_out) and, with no stiffness given, K = J_row (2π 100)²
   (`DRV_MESH_STIFFNESS_ASSUMED`, default damping ratio 0.5). The coarse-step rule is a refusal at ω_n Δt > 0.1 (`DRV_STEP_TOO_COARSE`; a timestep given to `simulate_motion` is refused, the auto timestep is halved like the loop-residual retry; DRV-M0 measured +0.45 % at 0.03, +6.8 % at 0.32). Run-time armature changes are not needed (armature is a build-time attribute): no `mj_setConst`.
5. **Ledger terms.** Friction and transmission heat is `level · |Δq|` per step of the part above the joint's constant friction (which the report still integrates from the sampled speed); a stop's heat is minus the work of its rows minus the spring energy ½ K x² it still holds, with the work taken by
   the trapezoid of the start and end forces, and over the active part only (with the dashpot force of the active end) when contact begins or ends inside a step. Closure at Δt 1e-5 (end stop impact, ζ 0.2): 6.2e-4 (first order in Δt: 1.6e-3 at 2e-5, 2.5e-3 at 4e-5). Servo work for runs that have joint physics or
   transmissions is settled after the next forward pass (force at the end state, not at the last RK4 stage). **Known limit:** a servo that jump-starts a mass from rest (the stick-slip plan: a 5 kg belt to 0.1 m/s in two steps) puts an impulse of ½ m v² (0.025 J) into the work estimate that is not resolved by a start / end mean;
   the plan's closure error is that impulse (16 % of 0.16 J at 1 s, constant in Δt), the same plan with the belt initially at speed closes to < 1e-3 (`tests/unit/drives/jointPhysics.test.ts`).
6. **Deviations from 3.1 / 3.2.** `Transmission.gear` keeps a signed `ratio` and optional `teeth` (no `reverse` flag); `lead_screw` has no `starts` (`leadMm` is the advance per revolution, so tan λ = lead / (π d_m)); `LoadSchedule` has no `pointMm` / `frame` (a body force acts at the centre of mass in world axes; a moment is a joint torque);
   `JointPhysics.friction` uses unit-suffixed command fields (`staticNm` / `staticN`, `kineticNm`, `viscousNmsPerRad`, ...) checked against the joint kind and stored as SI `static`, `kinetic`, `coulomb`, `viscous`; a friction model REPLACES the joint's `friction` and `damping` (a viscous term when given, else the joint's damping) instead of
   being stored beside it, and `add_body_joint` keeps its numbers as plain data (no `jointPhysics` record is created for them); the port identifies joints by id, not index, and `frictionLevel` takes a `FrictionObservation` (radial load, bending moment, saturation flag) instead of `previousReactions`.
   The prismatic speed motor is its own stored kind, `linear_speed`, so every rpm reader keeps its type.
7. **Migration (no backward compatibility).** `add_gear_coupling`, `DynamicsModel.gears`, `SimulationGear`, `gearLoss.ts` (core plugin and adapter), `data.gears` (now `data.transmissions`), the golden plans and snapshots, `dynamicsLegacyOutput` hashes (key rename only for the flywheel: every number bit-identical; the geared run also differs by the
   transmission id prefix and the equality orientation), UI readers of `dynamics.gears` (two lines in `src/ui/panels`, no behaviour change) and the skill text were migrated in the same change.

**13.16 Oracle results (MuJoCo 3.16.0).** VC-DRV-10: 345.7539 rad/s² against 345.755 (0.0003 %); the back-driven case (η_b 0.8) 3244.165 against the closed form 3244.120 (0.0014 %); both ledgers close to 4e-10. VC-DRV-13: lift 10.3302 m/s² (reference 10.3303), fall 6.15455 (6.15455), η_f 0.736721 / η_b 0.664683 to 1e-6, ledger 2e-11.
VC-DRV-14: lift 2.9870 (2.98702), η_b -0.0877, motor off 2.5e-7 m/s creep (1.07e-6 m in 1 s at Δt 1e-4, 2.1e-7 m at 5e-5). VC-DRV-15: 113.0973 N from `screwAxialForce`, and a 1 kg nut on a ball screw (η 0.9, J 1e-9) accelerates at η T k / (m + J k² η) to 0.5 %. VC-DRV-16: relative angle peak-to-peak 0.5° within 2 % at a 0.5° gap, mesh 2000 N·m/rad,
peak penetration 0.65 % of the gap, ledger 1e-4. VC-DRV-17: breakaway at 2.000 s (±2 ms), acceleration just after within 2 % of (F - 1 N)/m, displacement before ≤ 1e-9 m, ledger 3e-7. VC-DRV-18: period 0.671 s (reference 0.671239, < 0.1 %), release at x 0.02 m, slip ends at x 0 (2 %), stick time 0.2 s (2 %).
VC-DRV-19: 10.19 rad/s² at Δt 1e-3 and 5e-4 (exact; the reaction is read in the same step). VC-DRV-20: restitution 0.57186 (reference 0.57174, 0.02 %), peak penetration 2.3916e-3 rad (2.391e-3), contact time 10.10 ms (10.10).

**13.17 Left.** `size_drive`, `check_motion_truth`, `fit_drive_parameters`, thermal model, plots, `packReplay23` (M3); pmsm / stepper / induction (M4). `drv_lead_screw` and `drv_stick_slip` run end to end (`tests/unit/drives/{transmissions,jointPhysics}.test.ts`) and left `blockedPlanCommands.json`;
`drv_servo_sizing` stays there for `size_drive` and `check_motion_truth` (its `add_transmission` and `set_joint_physics` steps now execute). Stop and backlash inertia is static in the configuration (a multibody whose effective inertia changes needs the per-step solref rewrite of 13.2.1).

### DRV-M3 (2026-11-07): sizing, truth, fit, reference series, plots

**13.18 Built.** Commands (plugin `dynamics`, toolset assembly): `size_drive` (duty-cycle sizing, thermal network, ratio sweep), `check_motion_truth` (items a-g of TR-DRV-23, one verdict), `fit_drive_parameters` (TR-DRV-25), `add_reference_data` with `series` and
`compare_to_reference <id | all_series>` (the generalised reference data of section 4), `plot_simulation` quantities `motor_current`, `motor_voltage`, `winding_temperature`, `operating_points`, `energy_ledger`; `check_prototype` runs `check_motion_truth` (quick) inside its dynamics
check when the model has drive physics (drives, transmissions, joint physics, load schedules or reference series; a model without them gets exactly the items it got before). `ledger` is declared on `SimulationData` (`sim/simulationReport.ts`, type `LedgerData`). Data: core
`model/drives.ts` `ReferenceSeries` + `SERIES_QUANTITIES`, `DynamicsModel.referenceSeries` (shares the dynamics id space; load validation `commands/persistence/referenceSeriesValidation.ts`; the datasheet `thermal` block is now validated on load too: a hostile `thermal` used to reach the
law). Plugin laws: `sim/actuators/thermal.ts`, `sim/{sizing,sizingReport,provenance,driveFit,seriesComparison,driveCharts,runData}.ts`, `sim/truth/{outputs,studyItems,ledgerItems,softnessItems,verdictItems}.ts`; commands `{sizeDrive,sizingRun,fitDrive,motionTruth,plotDrives}.ts`,
`engine/referenceSeries.ts`. The GCI arithmetic is `@lib/convergence` (`gciTriplet`, `richardson`), unchanged. `simulate_motion detail "drives"` now includes the joint series of `detail "series"` (plots need both). Plan fix: `drv_servo_sizing` wrote `ratio: 10` for a 10:1 reduction, which with
the stored meaning speed(driven) = ratio x speed(driver) is a 10x speed-UP; it is `ratio: 0.1`, and the gear carries a grade B source (catalogue range of a precision planetary stage) so that friction (grade C) is the one lowest-grade input of VC-DRV-34. `unboundedEffort` also covers `linear_speed`
(the stick-slip belt servo now warns `DRV_EFFORT_UNBOUNDED`, TR-DRV-24).

**13.19 Choices and corrections to the text above.**

1. **Thermal (TR-DRV-09).** The network is evaluated on the recorded current series after the run (exact 2x2 matrix exponential per sample interval, mean i² by the trapezoid, R(T) at the start-of-interval winding temperature). The winding LAW inside the simulation keeps the datasheet R: the thermal feedback does not
   change the current of the same run (copper R rises 0.39 %/K, so 100 K of winding rise is 39 % more resistance; for a hot duty cycle read the steady values of `size_drive`, not the transient of a short run). Closed forms (steady at the RMS current, runaway current, continuous current at the limit) are exact;
   the periodic-mean check of VC-DRV-08 is the steady value at the RMS current, which the stepped network confirms (13.20).
2. **`size_drive` margins and verdict.** margin = capacity / demand - 1 per factor (peak_current against the sheet peak current else the stall current U/R, rms_current against the nominal current, speed against the maximum speed, thermal as (limit - ambient) / (steady - ambient) - 1); the limiting factor is the smallest, `DRV_MARGIN_LOW` below `margin`,
   a negative margin raises the coded fail. A factor the sheet cannot judge is listed in `notEvaluated`, never passed. `ratioSweep` is in reductions N (motor turns per output turn, gear ratio = sign / N) on the gear whose driver is the motor joint (`DRV_SWEEP_NO_GEAR` otherwise), run on copies; `best` = the largest limiting margin (ties: lowest peak torque),
   reported beside the analytic sqrt(J_load / J_motor) (inertias of the joints: bodies + armature). The RMS reads the 1 kHz sample grid (the series starts with a zero sample, the output of the step that ended at t = 0: 0.1 % under a 6 A constant).
3. **Verdict (TR-DRV-23).** trusted = no item fails, warns or was skipped, and every graded input is A / B (the provenance item is one of the items); plausible = no fail but a warning, a skipped item or an input of grade C / unsourced; not_trusted = any fail. A warning therefore keeps a verdict from `trusted` (the text of TR-DRV-23 said "no fail"; a
   warned item is by definition not clean). Inputs graded: datasheet motors (an accepted inconsistent sheet is grade C), speed / linear-speed bounds, torque curves (always unsourced), lossy transmissions (efficiency, backlash, thread friction; an ideal ratio is geometry and is not listed), joint friction models, and the plain `friction` / `damping` numbers of `add_body_joint` (grade C).
4. **Timestep study.** `quick` = dt and dt/2 (order ASSUMED 1, said in the item); `full` = dt, dt/2, dt/4 with the observed order and GCI = 1.25 |f1 - f2| / (r^p - 1) of the finest pair (`gciTriplet`); pass <= 1 % of the value, warn <= 10 %, fail above; `DRV_CONVERGENCE_IRREGULAR` when p is outside [0.5, 4] or the triplet is not monotone. An output that is a numerical ERROR (`energy.balanceErrorJ`,
   `ledger.closureErrorJ`) is judged by its slope when it falls with the step (pass inside [0.5, 4.5]), and as a step-independent floor against the energy scale (pass <= 1e-4) when it does not (the servo plan: 4.9e-8 J, 5.7e-7 of the energy scale: the books close to the rounding of the recording, not to the step). Outputs equal to 1e-9 relative at every step read `identical to round-off`. The first step is the
   caller's, else half the controller period of the fastest sampled drive (a whole number of steps, and halving keeps it whole), else simulate_motion's rule; a step whose half is below 5e-6 s is a `not_run` study, not a pass. Measured orders on the servo plan are 0.94 - 1.01 (the first-order servo and winding steps), GCI under 0.01 %.
5. **DRV-M2 leftovers, decisions.** (a) *Servo jump start (13.15 item 5).* NOT fixed: the force history inside a step is not exposed by the engine, and an energy estimate completed from the observed kinetic energy would close the books by construction and hide real errors. `check_motion_truth` reports the closure fail and names the cause (`DRV_LEDGER_SERVO_JUMP`) when the error is
   within a factor 4 of 1/2 J |v_target² - v_0²| of a velocity servo (drv_stick_slip: error 0.0250 J, estimate 0.0300 J with the block's 1 kg counted in the belt joint's inertia; verdict `not_trusted`; with the belt already at speed the closure is < 1e-3 and no cause item appears). (b) *Stop / backlash closure first order in dt.* `DRV_LEDGER_ORDER` states the observed order of the closure error
   (end stop impact of VC-DRV-20, dt 4e-5 / 2e-5 / 1e-5: 8.4e-6, 4.2e-6, 2.1e-6 J, order 1.04) and warns only when the error does not shrink; the closure item itself stays `warn` above 1e-3 (2.5e-3 relative at dt 4e-5, honestly). (c) *Configuration-dependent J_eff.* NOT built (per-step `solreflimit` rewrite): `check_motion_truth` flags it (`DRV_STOP_INERTIA_VARIES`, warn) for a stop or
   backlash whose joint carries other moving joints below it (or sits in a closed loop) when those joints travelled more than 0.5 deg / 1 mm in the run; pass when they stayed still. Why: the rewrite needs the instantaneous inertia of the row, which the port does not expose (no mass matrix), and the static value is exact for the single hinge and rigid clusters that every validation case uses; flagging gives the agent the
   same information at no cost to the step time. Build it when a use case has a stop whose inertia changes by more than the contact stiffness tolerance (open item for DRV-V1, whose reference engine can measure the difference).
6. **Reference series.** `ReferenceSeries { id, quantity, target, times, values, source {name, grade}, uncertainty?, bandRel? }` in `dynamics.referenceSeries`; quantities `joint_position`, `joint_velocity`, `motor_current`, `motor_voltage`, `motor_torque` (at the joint), `motor_speed` (rad/s at the shaft), `ledger_energy` (one end-of-run point, target a ledger kind or `<element>/<kind>`).
   The comparison interpolates the recorded series at the reference times; status pass when RMS error / largest |reference| <= `bandRel` (0.05), else fail for a grade A / B reference and warn for C (as the engine references); a missing reading uncertainty is listed in the note, never taken as 0. `delete_dynamics_item` removes a series with the joint or motor it measures.
   Deviation: the engine curves stay in `prototype.references` (their `quantity` enum is engine-only), so the generalisation is a second store, not a wider union.
7. **`fit_drive_parameters` (TR-DRV-25).** All shipped models are linear in their unknowns, so there is no Gauss-Newton branch. Mechanical: J w' = tau - T_f sign(w) - b w with w' by a centred difference (samples next to a stop are skipped); electrical: u = R i + L di/dt + kt w (L only when known). A regressor with equilibrated condition number > 1e8 is refused naming the confounded pair; a spin-down with J unknown and no torque is
   refused structurally (the equation is homogeneous: scale freedom). New finding: a spin-up at ONE constant torque is unidentifiable for (J, T_f, b) as well (dw/dt = (tau - T_f)/J - (b/J) w has two combinations for three unknowns, condition 1.6e14): the torque must vary, or one parameter be known. The sigma is the ordinary least-squares one (noise in the equation, not in the regressors): with J unknown a
   noisy speed biases the value beyond its sigma (said in the description).
8. **Plots.** The ledger and operating-point charts are SVG built by `sim/driveCharts.ts` and stacked under the time panels in the same `data.svg`; `winding_temperature` runs the thermal network on the plotted current at `ambientC`.
9. **Not done.** The PHY-22 drive readout hook (`<motor>.<quantity>`, MOV-M5, a `render_animation` change in core `commands/render`) and the UI badge (DRV-M5) are outside this lane; `engines: ["reference"]` answers `NATIVE_TOOL_MISSING` until DRV-V1.

**13.20 Oracle results (MuJoCo 3.16.0).** VC-DRV-06: 130.89662 C against 130.89662 (exact), continuous current 3.400978 A (3.400978). VC-DRV-07: network time constants 916.527 / 36.631 s, winding rise at 10 / 41.5 / 300 / 809 / 3000 / 10000 s within 7e-13 of the reference. VC-DRV-08: I_rms 3.000000, T_rms 0.1809 N·m (1e-9, hand: sqrt(36 / 4)); stepped network over 1500 periods: periodic mean 115.465 C against 115.924 C (0.46 K, gate 3 K).
VC-DRV-09: runaway 5.863494 A (5.863494). VC-DRV-11: analytic sweep rows within 1e-12; `size_drive` on the servo plan, best N 12 against the inertia match 10.000 (one sweep step; the Coulomb friction at the load moves the optimum up). VC-DRV-12: RMS 1.0 (1e-9). VC-DRV-29: T_f 0.00414 within 0.5 % and b within 2 % from the six reference samples (three usable equations); with J unknown `DRV_FIT_UNIDENTIFIABLE` naming (inertia, coulombNm).
VC-DRV-30: on `rbd_compound_pendulum` (90 deg release) at dt 1 / 0.5 / 0.25 ms the energy balance error falls with observed order 4.15 (gate 3.5 - 4.5) and the period is identical at every step (GCI 0); **gap:** the plan the VC names, `rbd_compound_pendulum_small` (0.005 rad/s), has an energy error at 1e-16 J (round-off) at every step, so no order exists to observe: the item reads `pass` at round-off. VC-DRV-33: the PHY-22 slider-crank
(1e6 N·m, no source) gives `DRV_EFFORT_UNBOUNDED` on `drive` and `DRV_PARAM_UNSOURCED` (`drive.effort`), verdict `plausible`. VC-DRV-34: verdict `plausible`, `j_load.friction` the lowest-grade input, `DRV_PARAM_UNSOURCED` lists exactly it; regraded to B the verdict is `trusted`. VC-DRV-35: `size_drive`, `check_motion_truth`, `fit_drive_parameters` return the same document and no step (is-pure tests), two plan replays give the identical document and
bit-identical series. VC-DRV-36: not covered here (UI, MOV-M5). VC-DRV-37: verdict ok, limiting factor rms_current (margin +1077 %), best N 12 within one step of 10; **gap:** the second half (load inertia x 4) does not exceed the rating of this motor: the RMS current goes from 0.269 A to 0.618 A against 3.17 A (verdict ok); the factor that raises `DRV_RMS_OVER` (3.73 A) and `DRV_THERMAL_OVER`
(steady 199 C) is x 30, which the test uses. VC-DRV-38: ledger closure 1.2e-7 (gate 1e-3), regenerated energy -0.0944 J over 1 s, gear loss 0.0243312 J against the hand prediction (1/eta - 1 of the forward load energy plus 1 - eta_b of the back-driven) 0.0243296 J (ratio 0.99994).

**13.21 Left.** pmsm / stepper / induction (M4), the Drives panel and truth badge (M5), the drive readouts of PHY-22 (MOV-M5), the reference engine (V1, `engines`), a per-step stop inertia if a use case needs it (13.19 item 5c), thermal feedback into the winding law (13.19 item 1).

**13.22 Review round (DRV-M3).** (1) The id of an engine reference (`add_reference_data` without `series`) must be free in the dynamics id space, and `compare_to_reference <id>` prefers the engine reference when both exist (they can no longer both exist). (2) `size_drive` fails `DRV_THERMAL_PEAK_OVER` when the winding temperature of the simulated window, from ambient, exceeds its limit: the `DRV_THERMAL_OVER` criterion is the steady value at the
RMS current and ASSUMES the cycle repeats indefinitely, so a short burst followed by a long idle can pass it and still overheat (test: 40 A for 2 s in 320 s, RMS 3.16 A, peak winding above 155 C). (3) The fit covariance equilibrates the columns before the normal matrix (as the solver does) and rescales; a null sigma with spare equations carries `sigmaNote`. (4) `DRV_LEDGER_SERVO_JUMP` additionally needs the servo's joint to be within 20 % of the speed step from its
target at the first recorded sample (a servo that saturates and ramps is not a jump start), and reads "consistent with a servo jump start", not a proof. (5) `?? 0` fallbacks removed from the new code (`elementAt` or explicit guards); `check_motion_truth` costs quick = 2 runs (about 3x one run's work), full = 3 runs (about 7x). (6) With narrowed `outputs` the summary reads "verdict V for outputs [...] only", `data.verdictScope` says so and an info item
`DRV_STUDY_SCOPE` records it; the reference series of one document are capped at 500 000 points in all (load validation and `add_reference_data`, hostile-reader case). Payload note: `simulate_motion detail "drives"` now returns the joint series of `detail "series"` besides the drive series and the ledger, so its data grows by the joint series of every joint (about 6001 samples each at most).

### DRV-UI (2026-11-07): Mechanisms › Physics shows motors, drives, profiles and the ledger

**13.23 Built (`src/ui/panels/`).** `motorSummary.ts` (pure presentation) reads every motor kind through exhaustive switches with no default (`motorKindLabel`, `motorFacts`, `motorHeadline`; also the drive modes, profile segment kinds and a segment's duration): adding the DRV-M4 motor kinds fails the typecheck here. `PhysicsMotors.tsx` is the new "Motors & drives" block of the Physics section: one row per motor (kind, headline, joint; picking it focuses the bodies of its joint through `mechanismFocus.motorFocus`), a details block with the stored datasheet of a `dc` motor (rated voltage, R, L, kt, kv, rotor inertia, no-load / stall / nominal / peak values, gearhead, source and grade, the "unverified" reason), the attached drive (mode, voltage, limits, controller gains / tuning, sample rate) or "terminals are open" when there is none, its profile (quantity, unit, segments with start times; a segment whose length follows from vmax / amax shows no start time after it), and the profiles no drive uses. The only edit is the constant terminal voltage of a datasheet motor: `set_motor_drive {motor, mode: "voltage", volts[, currentLimitA]}` (the current limit of the existing drive is kept); a blank or non-numeric entry dispatches nothing and says so, a refusal from the command is shown. `PhysicsLedger.tsx` shows `data.ledger` of the run (one row per element in J, input, dissipated, stored change, closure with its pass / warn / fail tier), read through `readLedger`, a structural guard (the host API `SimulationData` does not declare `drives` / `ledger`); the panel's run already asks for `energy: true`, which turns the ledger on without losing the poses of the playback. `reviewTimelineModel.crankJointOf` needed no change (it keys on the joint of any motor kind on a revolute joint); a test pins it for a `dc` motor.

**13.24 Left.** Creating a datasheet motor or a motion profile from the panel (large forms; today by command / CLI), the other drive modes (torque / velocity / position / prescribed) and picking a profile from the panel, the per-motor run numbers of `data.drives` (peak current, tracking error; the Physics table still shows the end torque and power of every motor) and the electrical series charts (`detail: "drives"` drops the poses the playback needs).

### DRV-M4 (2026-11-07): `pmsm`, `stepper` and `induction` motor kinds

**13.25 Built.** Model (`core/model/drives.ts`): `PmsmMotor`, `StepperMotor`, `InductionMotor` (datasheet + optional gearhead + source + `acceptInconsistent`, like `dc`), the union `DatasheetMotor`, `DRIVE_MODES_BY_KIND`, the drive mode `frequency`, the drive fields `frequencyHz` and `stepDivision`; `Motor` includes them; `LedgerKind` gains `iron` and `rotor` (core port, `physicsEngine.ts`). Load validation: `persistence/machinesValidation.ts` (one `*MotorProblem` per kind, hostile records named, no throw), `driveReferenceProblems` checks the drive mode against the motor kind (`DRV_MODE_UNSUPPORTED`), `driveProblem` checks `frequencyHz` and `stepDivision`. Plugin `dynamics`: `add_motor` kinds `pmsm` / `stepper` / `induction` (sheets `pmsmDatasheet` / `stepperDatasheet` / `inductionDatasheet`, `commands/machineSchemas.ts` + `motorBuild.ts`), `check_motor_data` (stored motor of any kind), `set_motor_drive` (modes per kind, fields a kind does not use refused), `size_drive`, `check_motion_truth` provenance, `add_reference_data` series, `plot_simulation` (operating points with the torque envelope / pull-out / torque-speed curve of the kind, `sim/actuators/curves.ts`), `simulate_motion` `data.drives` (stepper account `stepper { lostSteps, peakLostSteps, firstLostS, peakLagDeg }`) and warnings `DRV_STEPS_LOST`, `DRV_STEPPER_TIMESTEP`, `DRV_PMSM_VOLTAGE_OVER`, `DRV_INDUCTION_QUASI_STEADY`. Laws: `sim/actuators/{pmsm,stepper,induction}.ts` (pure, closed forms), one step function per kind (`machineStep.ts`), the kind-independent parts (`drivetrain.ts`: gearhead, rotor inertia, friction; `machine.ts`: peak torque, capacity, thermal network, ledger layout per kind), the actuator block of `block.ts` runs any of them with the same loop, ledger and `aux` contract as the DC motor (aux slots 12 -> 19: `power`, stepper `command` / `offset` / `lag` / `lostSteps` / `lostTime`, induction `frequency`). UI: `src/ui/panels/motorSummary.ts` display branches only (facts, headline, the `frequency` mode label).

**13.26 Choices and corrections to the text above.**
1. **Modes per kind (D-DRV-M4-01).** dc: voltage, torque, velocity, position, prescribed. pmsm: torque, velocity, position, prescribed (field-oriented: the command is a torque; there is no terminal voltage to give). stepper: position, velocity (open-loop step command, no sample rate / gains / tuning / target). induction: voltage (`volts` phase RMS or a voltage profile at the fixed `frequencyHz`: direct on line) and frequency (a `frequency` profile in Hz with constant volts per hertz). A mode a kind does not take is refused by name, `DRV_MODE_UNSUPPORTED`, in `set_motor_drive`, at run build and at load; a field a kind has no use for (`volts` on a pmsm, `sampleHz` on a stepper, `currentLimitA` on an induction motor, ...) is a no-op with the field named, never silently ignored. The velocity / position loops of dc and pmsm are the same cascade (TR-DRV-10), anti-windup included (the PMSM envelope sets `clipped`).
2. **`add_motor` stays one flat object (D-DRV-M4-02).** The brief asked for a zod discriminated union. A root-level union has no `type: "object"`, which the tool schema of the CLI / agent APIs needs, and every existing `add_motor` call is flat; the kinds are discriminated by `kind` with one sheet object per kind (`pmsmDatasheet`, `stepperDatasheet`, `inductionDatasheet`, each a zod object with its own units and `.describe()`), and `buildDatasheetMotor` refuses a kind without its sheet. Decided for compatibility with the registered schema; a union can replace it later without changing the stored record.
3. **PMSM (TR-DRV-07 as built).** Amplitude-invariant dq model (Krause, *Analysis of Electric Machinery*, ch. 4; Pillay and Krishnan, IEEE Trans. Ind. Appl. 25(2), 1989): T = 1.5·p·λ·i_q, v_d = R·i_d − ω_e·L·i_q, v_q = R·i_q + ω_e·(L·i_d + λ), L_d = L_q = L (surface magnets). Kt = 1.5·p·λ in N·m per A of phase-current AMPLITUDE (a sheet value per A RMS is divided by √2); the sheet gives λ or Kt, both are checked against each other (2 %). The current loop is ideal; the torque command is cut to the envelope at the present speed (constant torque I_max to ω_b = V_max / (p·√(λ² + (L·I_max)²)), then the intersection of the current disc and the voltage disc, i_d = ((V_max/ω_e)² − λ² − (L·I_max)²) / (2·λ·L), up to ω_max = V_max / (p·(λ − L·I_max)), zero beyond), V_max = V_bus/√3, `currentLimitA` / `busVoltageV` of the drive override the sheet. A partial torque in the weakening region uses the smallest |i_d| that keeps the voltage inside the bus: i_d = min(0, (√((V_max/ω_e)² − (L·i_q)²) − λ)/L). **Added to the spec:** for λ ≤ L·I_max the characteristic current is inside the current limit and the speed range is unbounded; the envelope continues along the top of the voltage circle, i_q = V_max/(ω_e·L) (maximum-torque-per-volt), which is continuous with the intersection form. The envelope and the base / maximum speeds take R = 0 (as the spec states); the stator voltage the run actually needs includes R·i and is recorded; above V_max the run warns `DRV_PMSM_VOLTAGE_OVER` (the real limit is slightly lower than the envelope). Electrical input = 1.5·(v_d·i_d + v_q·i_q) = 1.5·R·(i_d² + i_q²) + T·ω exactly (L_d = L_q), so the ledger closes by algebra of the model, not by construction of the ledger. No iron loss, no cogging, no inverter loss (model form).
4. **Stepper (TR-DRV-08 as built).** Two-phase hybrid: N_r = steps / 4 teeth, one full step = π/2 electrical = 2π / steps; T = T_h(ω)·(I_set/I_rated)·sin(N_r·(θ_cmd − θ)) − T_det·sin(4·N_r·θ) − c·ω (Acarnley, *Stepping Motors: a Guide to Theory and Practice*, 4th ed., IET 2002; Kenjo and Sugawara, *Stepping Motors and Their Microprocessor Controls*, 2nd ed.). T_h(ω) is the datasheet pull-out curve (rpm, N·m; the holding torque below the first point, zero beyond the last) or, without one, the first-order roll-off T_h / √(1 + (N_r·ω·L/R)²) of a phase driven at the electrical frequency N_r·ω (model form: a chopper drive holds the current further out, so the datasheet curve is the better input). The step command: a position profile is the commanded shaft angle, a velocity profile is the step rate integrated (midpoint rule); the field angle is quantised to 1 / `stepDivision` of a full step (1 full, 2 half, n micro; the holding torque is not scaled by the micro-step current vector: sinusoidal micro-stepping holds T_h at every position); the field starts aligned with the rotor (no start transient from an unaligned field). **Correction to TR-DRV-08:** the text counts a lost step when round(N_r·(θ_cmd − θ)/(π/2)) ≠ 0, which flags a rotor that holds a stable equilibrium at a lag above 45 electrical degrees (a load above 0.71·T_h, though a loaded stepper is stable to 90). A stepper loses synchronism in whole electrical periods, 4 full steps, so `steps lost` = 4·round(N_r·(θ_cmd − θ)/2π): the run reports the net steps lost, the largest, the time of the first (`DRV_STEPS_LOST`) and the peak electrical lag (`data.drives[id].stepper`); a lag inside ±π is never reported lost. Electrical input = 2·R·I_set² + (field + detent torque)·ω (the stored field energy is not tracked: model form; closure is therefore by construction for this kind and VC-DRV-27 checks the torque law, not the books); the viscous damping loss c·ω² goes to the ledger kind `rotor`. The detent torque acts only on a DRIVEN stepper (an undriven one adds its inertia, like every datasheet motor); damping defaults to 0 (an undamped rotor rings after every step: measured period 250.72 Hz against 251.646). The field torque and the damping are applied explicitly per step, so the run warns `DRV_STEPPER_TIMESTEP` when ω_n·Δt or c·Δt/J exceeds 0.2 (ω_n from the rotor inertia, a lower bound on the load: conservative) instead of refusing (the precedent `DRV_STEP_TOO_COARSE` of stops is a refusal; a stepper run at 1 ms is still informative, and the warning names the step to use).
5. **Induction (TR-DRV-08 as built).** Per-phase steady-state approximate equivalent circuit with the magnetising branch at the terminals (Fitzgerald, Kingsley and Umans, *Electric Machinery*, 6th ed., sec. 6.6; Chapman, *Electric Machinery Fundamentals*, 5th ed., ch. 6): T = 3·V²·R2·s / (ω_s·((R1·s + R2)² + (s·X)²)) with s = (ω_s − ω)/ω_s, ω_s = 2π·f/p and X = (X1 + X2)·|f|/f_rated (the reactances scale with the frequency); s_b = R2/√(R1² + X²), T_b = 3·V²/(2·ω_s·(R1 + √(R1² + X²))), starting torque at s = 1. Datasheet: R1, R2, X1, X2, Xm (sets only the magnetising current, not the torque, in this circuit), optional iron-loss resistance R_c, rated phase voltage and frequency; the sheet's breakdown torque / slip and starting torque are checked against the circuit (2 %). Supply: DOL = `voltage` mode with `volts` and `frequencyHz`; V/f = `frequency` mode, V = V_rated·min(1, |f|/f_rated) (no low-frequency boost; the stator drop is then large at low f and the starting torque small: stated, not corrected). A supply with no frequency gives no torque (no DC injection braking). Torque is evaluated at the instantaneous slip with no flux transients (model form, `DRV_INDUCTION_QUASI_STEADY` in every run: a DOL start has real torque pulsations at the line frequency that this does not show). Power flow: P_ag = T·ω_s, rotor copper 3·I2²·R2 = s·P_ag (ledger `rotor`), stator copper 3·I2²·R1 (`copper`), iron 3·V²/R_c (`iron`), electrical input = P_ag + stator copper + iron (negative = regeneration above synchronous speed). Phase RMS quantities throughout.
6. **What the recorded series mean per kind.** `currentA`: dc winding current; pmsm phase-current amplitude √(i_d² + i_q²); stepper phase current I_set; induction load current I2 (RMS, the rotor-referred stator current: the magnetising current is not in it, so the sheet's `nominalCurrentA` is a load current of the circuit). `voltageV`: terminal voltage; stator voltage amplitude; phase R·I (no back-EMF: the supply voltage a chopper needs is not modelled); phase RMS. The effective copper resistance of the thermal network is chosen so that copper power = r·current²: R, 1.5·R, 2·R, 3·(R1 + R2); `electricalPowerW` now reads the recorded input power (`aux.power`; identical to voltage × mean current for dc). The shared `capacity.peakCurrentA` may be absent (an induction sheet without `peakCurrentA`): the factor is listed in `notEvaluated`, never passed.
7. **Ledger layout per kind.** dc / pmsm record the five shared entries; stepper adds `rotor`; induction adds `iron` and `rotor`. The ledger sums copper + iron + rotor + gearhead + joint dissipation as dissipated; `LedgerKind` is a core port type and gained `iron` and `rotor`.
8. **Provenance and references.** Every datasheet kind is a graded input `<id>.datasheet` (an accepted inconsistent sheet is grade C); reference series may target any datasheet motor.
9. **Not done (spec did not ask, or no data).** Field weakening with a torque request beyond the envelope is cut (flagged `limited` / `DRV_VOLTAGE_LIMITED`), not rescheduled; the PMSM has no saliency (L_d ≠ L_q), MTPA or cogging; no stepper resonance damping model or microstep current-vector error; no induction saturation, deep-bar effects, flux dynamics, star-delta switching or V/f boost. There is no reference data for a measured PMSM, stepper or induction run in the repository: VC-DRV-25..27 are the textbook / closed-form values of `drv_reference.json`; the machine kinds have no bench series (`drv_*` plans) and no catalogue motor graded A beyond the maxon RE 40.

**13.27 Oracle results (MuJoCo 3.16.0; `tests/unit/drives/machine{Laws,Runs,VC}.test.ts`).** VC-DRV-25: T_max 1.2 N·m (1e-6: exact), base speed 321.6339 rad/s by bisection of the envelope (321.6338, 0.00004 %), maximum speed 577.3503 (577.3503), envelope 1.2 / 1.2 / 1.030425 / 0.632139 / 0.359263 N·m at 100 / 300 / 400 / 500 / 550 rad/s (reference 1.2 / 1.2 / 1.030425 / 0.632139 / 0.359263; i_d −10.25 / −17 / −19.0826 A); through the engine a 0.5 N·m command gives 99.0 rad/s after 0.2 s on J = 1.01e-3 (hand T·t/J, 0.5 %), the field-weakening run settles at the maximum speed within 1 %. VC-DRV-26: breakdown 197.2076 N·m at slip 0.194029 and starting 84.0179 N·m by golden-section search of the torque curve (reference 197.2076 / 0.194029 / 84.0179, within 1e-6), Kloss 80 / 100 / 38.4615 / 19.8020 N·m (1e-9) from the circuit with R1 → 0; the DOL start accelerates at T_start/J = 70.01 rad/s² (0.7 % at 10 ms) and the rotor copper loss of the no-load start equals the final kinetic energy ½·J·ω_s² within 2 % (textbook identity ∫s·P_ag dt = ∫(ω_s − ω)·J dω). VC-DRV-27: ringing 250.72 Hz against 251.646 (0.37 %, gate 2 %), static deflection 0.6000° at 0.25 N·m (gate 1 %); a 0.8 N·m load on 0.5 N·m holding slips (`DRV_STEPS_LOST`, a multiple of 4 steps), a 0.3 N·m load loses steps at 60 rad/s (L/R pull-out 0.082 N·m) and not at 1 rad/s (0.4975 N·m). Ledgers close below 1e-3 for the four runs of each kind.

**13.28 Left.** The Drives panel for the new kinds (PhysicsMotors still shows their datasheet facts and the model, but the drive block and the voltage editor are `dc` only: DRV-M5), a measured PMSM / stepper / induction series as reference data (none in the repository), an electrical `fit_drive_parameters` for the machine kinds (its step fit is the DC winding equation u = R·i + L·di/dt + kt·ω; the mechanical fit is kind-independent), thermal feedback into the winding law (13.19 item 1), `check_dynamics` messages that still name `add_motor kind "dc"` as the example of a motor model.
