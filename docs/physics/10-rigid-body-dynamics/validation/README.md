# PHY-10 RBD: validation pack

Proves a future implementation of [`../FUNCTIONAL_SPEC.md`](../FUNCTIONAL_SPEC.md) (`FR-RBD-*`) and
[`../TECHNICAL_SPEC.md`](../TECHNICAL_SPEC.md) (`TR-RBD-*`). Values are (a) quoted (Andrews reference from the
Bari IVP test set), (b) derived by [`generate_rbd_reference.py`](generate_rbd_reference.py) (Python 3 standard
library, `python3 -I generate_rbd_reference.py`, ~5 s, byte-identical on re-run, checked twice on 2026-10-15), or
(c) behaviour cases (codes / flags). Tolerances are llull acceptance choices.

## Files

| File                                          | Kind              | Content                                                                                                                                                                                         |
| --------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generate_rbd_reference.py`                   | generator         | Writes every file below                                                                                                                                                                         |
| `expected_results.json`                       | (a)+(b)+(c)       | 22 cases VC-RBD-01…58 (PHY README §6.3 schema)                                                                                                                                                  |
| `andrews_reference.json`                      | (a)+(b)           | Andrews' squeezer: 42 parameters, q₀, reference q and q̇ at t = 0.03 s, initial q̈₁,₂ and λ₁,₂, and this generator's independent reproduction (max relative difference 1.6e-10 on q, 5.0e-8 on q̇) |
| `pendulum_period.csv`                         | (b)               | T/T₀ vs amplitude 5…175°, K(k) by AGM and by quadrature                                                                                                                                         |
| `slider_crank.csv`                            | (b)               | x, v, a and crank torque every 15° (r 0.05 m, l 0.2 m, ω 100 rad/s, piston 0.5 kg)                                                                                                              |
| `coulomb_decay.csv`                           | (b)               | turning points of the Coulomb oscillator until stick                                                                                                                                            |
| `plans/rbd_pendulum_release.plan.json`        | plan (runs today) | 1 kg point mass (1 mm cube) on a 1 m pendulum released at 90° (VC-RBD-10, 11)                                                                                                                   |
| `plans/rbd_compound_pendulum.plan.json`       | plan (runs today) | 500 × 10 × 10 mm steel box bar, mass and inertia from geometry, released at 90° (VC-RBD-12)                                                                                                     |
| `plans/rbd_compound_pendulum_small.plan.json` | plan (runs today) | same bar hanging at rest, kicked at 0.005 rad/s: small-amplitude period (VC-RBD-12)                                                                                                             |
| `plans/rbd_slider_crank.plan.json`            | plan (runs today) | closed-loop slider-crank, speed governor on the crank (VC-RBD-20, 21)                                                                                                                           |
| `plans/rbd_spring_mass_damper.plan.json`      | plan (runs today) | prismatic joint with joint spring-damper (VC-RBD-30, 31)                                                                                                                                        |
| `plans/rbd_coulomb_oscillator.plan.json`      | plan (runs today) | prismatic joint, joint spring, Coulomb friction (VC-RBD-40)                                                                                                                                     |

The plans use registered commands only: `add_rigid_body` (mass from geometry, or `massKg` rescaling it), `add_body_joint` (anchor,
axis, `stiffness` + `springReference` for the initial deflection, `damping`, `friction`, `initialVelocity`; the ground is the body id
`ground`), `add_spring`, `add_motor`, `set_gravity`, `inspect_dynamics` and `simulate_motion` (`detail: "series"`, `reactions`,
`energy`). They replace the proposed PHY-10 commands of TECHNICAL_SPEC §4 (`set_ground`, `set_body_properties`, `dynamics_study`,
`set_mechanism_mode`, `set_joint_geometry`, `set_initial_conditions`, `add_spring_damper`), which stay proposals. Differences from the
physical case, all documented in `server/tests/packReplay10.test.ts`:

- A point mass is a 1 mm cube of 1 kg (inertia 1.7e-7 kg m², a constant 8.3e-8 relative effect on the pendulum period).
- Massless slider-crank links are not representable: the crank is a 100 kg flywheel (stiff speed servo) and the rod 5 g (a 1 mg rod
  opens the loop by 16 um, tier `fail`); the piston is the specified 0.5 kg. The 5 g rod is 0.7 % of the crank torque, so
  VC-RBD-21 is replayed against the closed form of that model (rod mass and inertia added to the virtual-power formula; with the rod
  mass at 0 the same formula reproduces the pack values to 2e-9). The plan sets `loopTimeConstantSteps` 16. History (ENG-3): the
  engine used to be 0.33 % / 0.53 % low at 60 / 90 deg against the massless values. Causes, in order of size: (1) the 5 g rod, +0.7 %
  of the torque missing from the reference; (2) the loop closure relaxing over 2 steps (the default), which the integrator resolves
  badly: +0.73 % at 2 steps, 0.12 % at 4, 0.03 % at 8, 0.01 % at 16, a function of steps only (not of the step size); (3) the speed
  servo's finite stiffness: its ripple times the crank inertia is an error torque, 0.15 % at 1 / (8 dt), 0.04 % at 1 / (4 dt); (4) the
  servo force was read after `mj_step`, i.e. at the last RK4 stage (a predicted state), up to 0.3 % off. Left: 3.3e-4 / 4.9e-4.
- The Coulomb friction is MuJoCo's near-rigid soft constraint (impedance 0.9999): rest position -1.9335004 mm (1.9e-7 relative),
  last turning point 2.1e-4 relative late; no creep after the stop.
- Not replayed (no engine counterpart): the Andrews squeezer (VC-RBD-01…04), VC-RBD-41 and VC-RBD-50…58 (error codes, `check_mechanism`,
  load export). `inspect_dynamics` reports the slider-crank mobility (1 DOF, 1 redundant row with the wrist pin spherical).

Measured against `expected_results.json` (`server/tests/packReplay10.test.ts`, relative error / tolerance used): periods of the
pendulum 8.3e-8 / 1e-5; pivot tension 5e-9…1.3e-7 / 1e-6; compound pendulum 2.6e-13 and 5.3e-8 / 1e-6; spring-mass-damper
x(0.5 s), x(1 s), decrement 3e-12…3e-11 / 1e-6; slider-crank x(90°) 2.3e-7, v(90°) 1.8e-6 (1e-5), a(0), a(90°) 2.7e-4, 6.5e-5 (1e-3),
torque 3.3e-4, 4.9e-4 (6e-4); Coulomb stop time 2.1e-4 (1e-3), rest 1.9e-7 (1e-5).

## Real use cases

| #   | Use case                                                           | Evidence                                                             | Cases         |
| --- | ------------------------------------------------------------------ | -------------------------------------------------------------------- | ------------- |
| U1  | Prove the integrator on a recognised closed-loop index-3 benchmark | Bari test set reference (PSIDE, tol 1e-14) [S1][S2]; reproduced here | VC-RBD-01…04  |
| U2  | Joint reaction for a pin check                                     | pendulum rod tension closed form                                     | VC-RBD-11, 53 |
| U3  | Actuator torque for a crank mechanism                              | slider-crank inverse dynamics                                        | VC-RBD-20, 21 |
| U4  | Spring-damper deployment                                           | SMD closed form, energy                                              | VC-RBD-30, 31 |
| U5  | Friction stick-slip                                                | exact Coulomb oscillator                                             | VC-RBD-40, 41 |
| U6  | Inertia from geometry                                              | compound pendulum with box inertia                                   | VC-RBD-12     |

## Validation cases

All status **P**. Gate `unit` = pure TS engine (no host, no kernel unless noted).

| VC        | Proves                        | Setup                                                    | Expected                                                                                                                         | Tol.     | Grade             | Gate                         |
| --------- | ----------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------- | ---------------------------- |
| VC-RBD-01 | FR-RBD-01/03/05; TR-RBD-20/21 | Andrews 0–0.03 s                                         | β 15.8107711963, Θ −15.7563710598, γ 0.0408222401307, Φ −0.534730116323, δ 0.524409965881, Ω 0.534730116323, ε 1.04808074104 rad | 1e-6 rad | A                 | unit                         |
| VC-RBD-02 | FR-RBD-03                     | same                                                     | angular velocities (JSON)                                                                                                        | 1e-4 rel | A                 | unit                         |
| VC-RBD-03 | FR-RBD-07; TR-RBD-22/30       | Andrews t = 0                                            | β̈ 14222.44392, Θ̈ −10666.83294 rad/s²; λ₁ 98.5668703962, λ₂ −6.12268834426 N                                                      | 1e-9 rel | A                 | unit                         |
| VC-RBD-04 | FR-RBD-06; TR-RBD-23          | Andrews 0.03 s                                           | reproduction residual 1.6e-13 m; llull gate ≤ 1e-9 m                                                                             | 1e-9 m   | A                 | unit                         |
| VC-RBD-10 | FR-RBD-01/03                  | pendulum L 1 m, 10/45/90/135/170°                        | 2.0102358926, 2.08661217983, 2.36824634629, 3.06568823962, 4.89436002875 s                                                       | 1e-5 rel | A                 | unit + golden plan           |
| VC-RBD-11 | FR-RBD-07/12; TR-RBD-30       | 1 kg, bottom of swing                                    | 10.1046200978, 29.41995, 48.7352799022 N                                                                                         | 1e-6 rel | A                 | unit                         |
| VC-RBD-12 | FR-RBD-02; TR-RBD-10          | compound box bar 0.5 m                                   | 1.15845886378 s (small), 1.36737602921 s (90°); slender formula 1.15840094518 s must **not** be matched                          | 1e-6 rel | A                 | unit (OCC for geometry mass) |
| VC-RBD-20 | FR-RBD-01/04                  | slider-crank kinematics                                  | x(0) 0.25 m, a(0) −625 m/s², x(90°) 0.19364916731 m, v −5 m/s, a 129.099444874 m/s²                                              | 1e-9 rel | A                 | unit                         |
| VC-RBD-21 | FR-RBD-08/09; TR-RBD-31       | crank torque, 0.5 kg piston                              | 4.5806214323 N·m (60°), −3.22748612184 N·m (90°)                                                                                 | 1e-6 rel | A                 | unit                         |
| VC-RBD-30 | FR-RBD-08; TR-RBD-11/21       | SMD 1 kg, 1000 N/m, 2 N·s/m, x₀ 10 mm                    | x(0.5) −6.05596072679 mm, x(1.0) 3.63397076193 mm, δ 0.19879118577                                                               | 1e-6 rel | A                 | unit                         |
| VC-RBD-31 | FR-RBD-06; TR-RBD-21          | undamped SMD, 100 periods                                | energy change 0 (≤ 1e-3)                                                                                                         | 1e-3 abs | A                 | unit                         |
| VC-RBD-40 | FR-RBD-10; TR-RBD-40/41       | Coulomb oscillator                                       | 5 half cycles, stop 1.57079632679 s, rest −1.9335 mm                                                                             | 1e-6 rel | A                 | unit                         |
| VC-RBD-41 | FR-RBD-10                     | incline μs 0.3                                           | 16.699244234°                                                                                                                    | 0.01°    | A                 | unit                         |
| VC-RBD-50 | FR-RBD-02, 16                 | instance without mass                                    | `RBD_MASS_MISSING`                                                                                                               | exact    | A                 | unit + CLI                   |
| VC-RBD-51 | FR-RBD-17; TR-RBD-24          | same plan twice / CLI vs MCP vs UI                       | identical data hash                                                                                                              | exact    | A                 | golden + server              |
| VC-RBD-52 | FR-RBD-16                     | seven wrong set-ups                                      | codes listed in the JSON                                                                                                         | exact    | A                 | unit + CLI                   |
| VC-RBD-53 | FR-RBD-12; TR-RBD-60          | export pendulum pivot load to a 05 static case           | `limit`, `reviewRequired`, provenance.studyHash                                                                                  | exact    | A                 | unit                         |
| VC-RBD-54 | FR-RBD-18                     | unverified density                                       | `unverified: true`, `RBD_MASS_UNVERIFIED`                                                                                        | exact    | A                 | unit                         |
| VC-RBD-55 | FR-RBD-20; TR-RBD-01/02       | kinematic commands unchanged; pivot defaulted            | identical `evaluate_motion` data; `RBD_PIVOT_DEFAULTED`                                                                          | exact    | A                 | unit                         |
| VC-RBD-56 | FR-RBD-04, 14; TR-RBD-50      | `check_mechanism` on the slider-crank, spatial vs planar | spatial DOF 1, redundant 3 (18 coordinates, 20 equations, rank 17); planar DOF 1, redundant 0                                    | exact    | A (derived count) | unit                         |
| VC-RBD-57 | FR-RBD-19, 21, 22; TR-RBD-70  | budgets, paging                                          | `RBD_BUDGET_EXCEEDED`; page fields                                                                                               | exact    | A                 | unit                         |
| VC-RBD-58 | FR-RBD-13; TR-RBD-60          | V1 history export to PHY-09                              | `source.fromPhy10` (values TBD)                                                                                                  | exact    | A                 | V1                           |

Notes:

- **Andrews grade A**: two routes agree — the published reference (PSIDE at tolerance 1e-14 on a Cray C90, as
  shipped in the test-set Fortran) and this generator's index-1 RK4 reproduction (12 000 steps) to 1.6e-10
  relative on the angles. The initial accelerations and multipliers also match the test-set initial vector.
- **VC-RBD-10** three independent routes agree to all 12 printed digits: AGM, Simpson quadrature of K(k), and an
  RK4 simulation of the pendulum ODE (time to the zero crossing).
- **VC-RBD-12** is chosen so that using the slender-rod inertia instead of the box inertia fails (5e-5 difference
  against a 1e-6 tolerance): it proves the engine reads the inertia tensor from geometry.
- **VC-RBD-40** has no smoothing: a regularised friction law that keeps creeping after the 5th turning point fails.

## CLI harness (AF-23)

```bash
D="--doc case.llull.json --json"
llull run plans/rbd_pendulum_release.plan.json $D > run.json          # last step = simulate_motion (data.series, data.reactions)
llull run plans/rbd_slider_crank.plan.json $D > sc.json               # inspect_dynamics step: mobility 1 DOF; last step: series
npm --prefix server test -- packReplay10                              # every plan against expected_results.json
```

`run_benchmarks` (PHY-00) consumes `expected_results.json`; the plans are replayed by `server/tests/packReplay10.test.ts`
(`LLULL_PACK10_TABLE=<file>` writes the measured numbers).

## Re-generating

```bash
cd docs/physics/10-rigid-body-dynamics/validation
python3 -I generate_rbd_reference.py
```
