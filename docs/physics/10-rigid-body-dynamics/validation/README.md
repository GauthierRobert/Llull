# PHY-10 RBD: validation pack

Proves a future implementation of [`../FUNCTIONAL_SPEC.md`](../FUNCTIONAL_SPEC.md) (`FR-RBD-*`) and
[`../TECHNICAL_SPEC.md`](../TECHNICAL_SPEC.md) (`TR-RBD-*`). Values are (a) quoted (Andrews reference from the
Bari IVP test set), (b) derived by [`generate_rbd_reference.py`](generate_rbd_reference.py) (Python 3 standard
library, `python3 -I generate_rbd_reference.py`, ~5 s, byte-identical on re-run, checked twice on 2026-10-15), or
(c) behaviour cases (codes / flags). Tolerances are llull acceptance choices.

## Files

| File | Kind | Content |
| ---- | ---- | ------- |
| `generate_rbd_reference.py` | generator | Writes every file below |
| `expected_results.json` | (a)+(b)+(c) | 20 cases VC-RBD-01…54 (PHY README §6.3 schema) |
| `andrews_reference.json` | (a)+(b) | Andrews' squeezer: 42 parameters, q₀, reference q and q̇ at t = 0.03 s, initial q̈₁,₂ and λ₁,₂, and this generator's independent reproduction (max relative difference 1.6e-10 on q, 5.0e-8 on q̇) |
| `pendulum_period.csv` | (b) | T/T₀ vs amplitude 5…175°, K(k) by AGM and by quadrature |
| `slider_crank.csv` | (b) | x, v, a and crank torque every 15° (r 0.05 m, l 0.2 m, ω 100 rad/s, piston 0.5 kg) |
| `coulomb_decay.csv` | (b) | turning points of the Coulomb oscillator until stick |
| `plans/rbd_pendulum_release.plan.json` | draft plan | 1 kg point mass on a 1 m pendulum released at 90° (VC-RBD-10, 11) |
| `plans/rbd_compound_pendulum.plan.json` | draft plan | 500 × 10 × 10 mm box bar, mass from geometry (VC-RBD-12) |
| `plans/rbd_slider_crank.plan.json` | draft plan | closed-loop slider-crank, planar mode, crank velocity actuator (VC-RBD-20, 21) |
| `plans/rbd_spring_mass_damper.plan.json` | draft plan | prismatic joint with joint spring-damper (VC-RBD-30) |
| `plans/rbd_coulomb_oscillator.plan.json` | draft plan | prismatic joint, spring, Coulomb friction (VC-RBD-40) |

Plans use existing commands (`set_units`, `add_box`, `create_component`, `add_joint`, `create_material`,
`assign_material`) and the proposed PHY-10 commands of TECHNICAL_SPEC §4. They stay drafts until those exist.
No Andrews plan is shipped: building it from bodies and pivots needs the body-fixed pivot coordinates of the
original figure (TECHNICAL_SPEC open question 7); the M3 test builder works from `andrews_reference.json`.

## Real use cases

| # | Use case | Evidence | Cases |
| - | -------- | -------- | ----- |
| U1 | Prove the integrator on a recognised closed-loop index-3 benchmark | Bari test set reference (PSIDE, tol 1e-14) [S1][S2]; reproduced here | VC-RBD-01…04 |
| U2 | Joint reaction for a pin check | pendulum rod tension closed form | VC-RBD-11, 53 |
| U3 | Actuator torque for a crank mechanism | slider-crank inverse dynamics | VC-RBD-20, 21 |
| U4 | Spring-damper deployment | SMD closed form, energy | VC-RBD-30, 31 |
| U5 | Friction stick-slip | exact Coulomb oscillator | VC-RBD-40, 41 |
| U6 | Inertia from geometry | compound pendulum with box inertia | VC-RBD-12 |

## Validation cases

All status **P**. Gate `unit` = pure TS engine (no host, no kernel unless noted).

| VC | Proves | Setup | Expected | Tol. | Grade | Gate |
| -- | ------ | ----- | -------- | ---- | ----- | ---- |
| VC-RBD-01 | FR-RBD-01/03/05; TR-RBD-20/21 | Andrews 0–0.03 s | β 15.8107711963, Θ −15.7563710598, γ 0.0408222401307, Φ −0.534730116323, δ 0.524409965881, Ω 0.534730116323, ε 1.04808074104 rad | 1e-6 rad | A | unit |
| VC-RBD-02 | FR-RBD-03 | same | angular velocities (JSON) | 1e-4 rel | A | unit |
| VC-RBD-03 | FR-RBD-07; TR-RBD-22/30 | Andrews t = 0 | β̈ 14222.44392, Θ̈ −10666.83294 rad/s²; λ₁ 98.5668703962, λ₂ −6.12268834426 N | 1e-9 rel | A | unit |
| VC-RBD-04 | FR-RBD-06; TR-RBD-23 | Andrews 0.03 s | reproduction residual 1.6e-13 m; llull gate ≤ 1e-9 m | 1e-9 m | A | unit |
| VC-RBD-10 | FR-RBD-01/03 | pendulum L 1 m, 10/45/90/135/170° | 2.0102358926, 2.08661217983, 2.36824634629, 3.06568823962, 4.89436002875 s | 1e-5 rel | A | unit + golden plan |
| VC-RBD-11 | FR-RBD-07/12; TR-RBD-30 | 1 kg, bottom of swing | 10.1046200978, 29.41995, 48.7352799022 N | 1e-6 rel | A | unit |
| VC-RBD-12 | FR-RBD-02; TR-RBD-10 | compound box bar 0.5 m | 1.15845886378 s (small), 1.36737602921 s (90°); slender formula 1.15840094518 s must **not** be matched | 1e-6 rel | A | unit (OCC for geometry mass) |
| VC-RBD-20 | FR-RBD-01/04 | slider-crank kinematics | x(0) 0.25 m, a(0) −625 m/s², x(90°) 0.19364916731 m, v −5 m/s, a 129.099444874 m/s² | 1e-9 rel | A | unit |
| VC-RBD-21 | FR-RBD-08/09; TR-RBD-31 | crank torque, 0.5 kg piston | 4.5806214323 N·m (60°), −3.22748612184 N·m (90°) | 1e-6 rel | A | unit |
| VC-RBD-30 | FR-RBD-08; TR-RBD-11/21 | SMD 1 kg, 1000 N/m, 2 N·s/m, x₀ 10 mm | x(0.5) −6.05596072679 mm, x(1.0) 3.63397076193 mm, δ 0.19879118577 | 1e-6 rel | A | unit |
| VC-RBD-31 | FR-RBD-06; TR-RBD-21 | undamped SMD, 100 periods | energy change 0 (≤ 1e-3) | 1e-3 abs | A | unit |
| VC-RBD-40 | FR-RBD-10; TR-RBD-40/41 | Coulomb oscillator | 5 half cycles, stop 1.57079632679 s, rest −1.9335 mm | 1e-6 rel | A | unit |
| VC-RBD-41 | FR-RBD-10 | incline μs 0.3 | 16.699244234° | 0.01° | A | unit |
| VC-RBD-50 | FR-RBD-02, 16 | instance without mass | `RBD_MASS_MISSING` | exact | A | unit + CLI |
| VC-RBD-51 | FR-RBD-17; TR-RBD-24 | same plan twice / CLI vs MCP vs UI | identical data hash | exact | A | golden + server |
| VC-RBD-52 | FR-RBD-16 | seven wrong set-ups | codes listed in the JSON | exact | A | unit + CLI |
| VC-RBD-53 | FR-RBD-12; TR-RBD-60 | export pendulum pivot load to a 05 static case | `limit`, `reviewRequired`, provenance.studyHash | exact | A | unit |
| VC-RBD-54 | FR-RBD-18 | unverified density | `unverified: true`, `RBD_MASS_UNVERIFIED` | exact | A | unit |

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
llull run plans/rbd_pendulum_release.plan.json $D > run.json          # last step = dynamics_study (AF-14 data per step)
python3 -I compare.py run.json expected_results.json VC-RBD-10        # period from crossing events
llull run plans/rbd_slider_crank.plan.json $D > sc.json               # check_mechanism step must be status != fail
python3 -I compare.py sc.json expected_results.json VC-RBD-21
```

`run_benchmarks` (PHY-00) consumes `expected_results.json`; behaviour cases are asserted by the CLI test suite.

## Re-generating

```bash
cd docs/physics/10-rigid-body-dynamics/validation
python3 -I generate_rbd_reference.py
```
