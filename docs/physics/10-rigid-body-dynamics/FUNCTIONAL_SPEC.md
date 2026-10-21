# PHY-10: Rigid-body dynamics with forces — functional specification

Gap id **RBD** · status: specification · written 2026-10-15 · technical spec: [`TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md)
· validation: [`validation/README.md`](validation/README.md) · sources: [`validation/sources.md`](validation/sources.md)

## 1. Summary

llull already models mechanisms **kinematically**: revolute and prismatic joints between assembly instances
(`add_joint`, `set_joint_value`), linear couplings between joints (`add_drive_relation`), a sweep that reports
instance poses and bounding-box interference (`motion_study`), and `evaluate_motion` with `apply: true` to write a pose back
(`packages/core/src/commands/motion/*`). There is no time, no mass in motion, no force, no gravity, no spring or
damper, no friction and no joint reaction. Reading the code also shows kinematic limits that matter for dynamics
(TECHNICAL_SPEC §1): joints are applied one by one from the anchor instance's **origin**, the `frame` selector is
stored but not used, closed loops (four-bar, slider-crank) are not solved, and rotations are composed by adding
Euler angles.

Aircraft and spacecraft mechanisms are sized by dynamics: a landing-gear retraction actuator must overcome
gravity, inertia and friction in a given time; a flap or door linkage passes loads through pins and lugs that are
then stress-checked; a deployment hinge is driven by a torsion spring and stopped by a damper. The numbers an
engineer needs are joint reactions over time, actuator force or torque, and peak values with the instant they occur.
Those reactions are the load cases of the structural checks (aerospace 05 FEA, PHY-05, PHY-09).

This gap adds constrained multibody dynamics to llull:

1. **Mechanism data on top of the existing joints**: body masses and inertias from `mass_properties` (exact
   centroid and inertia from aerospace 01 KRN) or given explicitly, ground, gravity, springs and dampers,
   applied forces with time profiles, joint actuators, Coulomb and viscous joint friction, initial conditions,
   and joint pivot geometry.
2. **A read-only `dynamics_study`** that integrates the index-3 constrained equations of motion with a
   generalised-α scheme in pure TypeScript, deterministically, and returns trajectories, joint reactions,
   actuator efforts, energies, friction states and constraint residuals as data.
3. **Exports** of joint reactions to aerospace 05 load cases (peak instants) and to PHY-09 load histories
   (transient), with provenance.
4. **`check_mechanism`** (degrees of freedom, redundant or inconsistent constraints, missing mass, gravity unset,
   time step vs stiffness) so the agent proves its own set-up.

## 2. Aerospace context & value

| Context | Today (who / which tools) | What llull adds | Source |
| ------- | ------------------------- | --------------- | ------ |
| Mechanism loads into structure | Multibody codes (Adams, Simpack, RecurDyn, Project Chrono) compute joint reactions; stress engineers then apply them in FE | `dynamics_study` reactions → `export_joint_loads` → 05 load case with provenance | [R10][R11] |
| Actuator sizing | Required force / torque versus stroke and time from inverse or forward dynamics | Joint actuators with prescribed motion return the effort history and its peak | — (llull design) |
| Benchmarking multibody solvers | The Bari IVP test set publishes Andrews' squeezing mechanism (7 bodies, index-3 DAE) with a high-accuracy reference solution; COMSOL and the SciML benchmarks use it | Andrews' squeezer is llull's gate (VC-RBD-01…04); this pack reproduces the reference independently to 1.6e-10 | [R1][R2][R3] |
| Time integration of constrained mechanics | Generalised-α for index-3 DAEs (Arnold & Brüls), Baumgarte stabilisation, index reduction | One integrator family, documented, with its numerical damping named | [R5][R6][R7] |
| Open engines | Project Chrono (BSD-3), MuJoCo (Apache-2.0, deterministic per its docs, soft constraints), Rapier (Apache-2.0, Rust + JS/WASM, `enhanced-determinism` feature) | Evaluated in TECHNICAL_SPEC §5.1; MVP uses its own integrator for purity and determinism | [R10][R11][R12] |

**Value statements** (sourced only): the Andrews reference values are public and reproducible with a short
standard-library script (this pack's generator does it), so llull can prove its integrator against a recognised
benchmark before anyone relies on a joint load. Kinematic studies already exist in llull, so a mechanism an agent
builds today becomes a dynamic one by adding data, not by rebuilding it.

## 3. Personas & user stories

Roles follow [`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md) §1. Joint loads that feed a
stress check or an actuator specification carry `reviewRequired` (AF-33); masses from unverified densities
propagate `unverified` (AF-32); gravity, friction and stiffness are never defaulted silently (AF-31).

| Role | Who | Uses | Main need |
| ---- | --- | ---- | --------- |
| **Operator (primary)** | AI agent through the `llull` CLI (cloud: MCP) | `llull run`, `check_mechanism`, `dynamics_study --json`, `export_joint_loads` | Deterministic, unit-tagged results and stable codes |
| **Owner** | Person asking "how much force does the actuator need?" or "what load goes through this hinge pin?". **Not assumed to be an engineer** | Natural language; may watch the desktop app animate the result | A plain answer with the peak and when it happens |
| **Qualified reviewer** | Mechanisms or loads engineer | Desktop review (plots, animation), exported load cases | Accepts friction, stiffness and mass assumptions; signs loads used for certification |

User stories:

- **US-1 (owner → operator).** "Size the actuator that retracts this gear leg in 2 s." The agent adds masses from
  the parts' materials, gravity, the actuator with a position profile, runs `check_mechanism` and `dynamics_study`,
  and reports peak actuator force, its instant, and the joint reactions at each pin.
- **US-2 (operator).** It exports the peak pin loads to the 05 static case of the lug and runs `compute_margins`
  there; every exported load carries the study hash, the instant and `reviewRequired`.
- **US-3 (operator).** A deployment hinge is driven by a torsion spring and stopped by a damper; the agent reports
  latch-up speed, time to deploy and peak hinge reaction, and hands the reaction history to PHY-09 for a transient
  check of the bracket.
- **US-4 (operator).** The agent models a slider-crank in 3D; `check_mechanism` reports redundant constraints and
  suggests the planar mode; the agent switches, re-checks, and proceeds.
- **US-5 (operator).** Friction makes the mechanism stick; `dynamics_study` reports the stick interval and the
  break-away force instead of creeping.
- **US-6 (reviewer).** The reviewer opens the study, sees the mass properties used (with source), friction and
  spring data with citations, the integrator settings and the constraint residual, and signs or sends back.

## 4. Scope / out of scope

| Phase | In scope |
| ----- | -------- |
| **MVP (M1–M4)** | Rigid bodies = assembly instances; ground; gravity (explicit); body mass from geometry (01 KRN) or explicit; joints: existing revolute and prismatic plus pivot geometry, `fixed` and `spherical` (core extension, open question 1); planar mode; translational and joint springs/dampers with free length and preload; applied forces/torques with time profiles; joint actuators (position, velocity, force) with profiles; constant Coulomb + viscous joint friction with stick-slip; initial conditions with consistent assembly; index-3 generalised-α integrator, fixed step; `dynamics_study` results as data; joint reactions; `check_mechanism`; exports to 05 load cases; quick checks (pendulum, compound pendulum, spring-mass-damper, slider-crank, Coulomb oscillator). |
| **V1 (M5–M6)** | Reaction-dependent joint friction (μ · pin radius · \|F\|); cylindrical and universal joints; adaptive step with deterministic controller; drive relations (gears) as dynamic constraints; export of reaction histories to PHY-09; `bake_dynamics_frame` (pose at time t into instance transforms); animation of a study in the UI from saved data. |
| **V2** | Flexible bodies from 05 modal results (component mode synthesis); unilateral contacts and end stops (impact with restitution); cam/follower and gear contact; external engine cross-check transport (Chrono or MuJoCo) on the desktop. |
| **Out of scope** | Vehicle tyre models, real-time control loops / co-simulation (FMI), granular media, soft-body physics, game-style collision physics, certification sign-off. |

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-RBD-01 | MUST | Forward dynamics of a mechanism made of assembly instances and joints over a time span, with outputs at a fixed output step: pose, velocity and acceleration of each body, value and rate of each joint. | The core capability | [R1][R5] |
| FR-RBD-02 | MUST | Body mass properties: `geometry` (mass, centroid and inertia tensor from `mass_properties`, exact on OCC per 01 KRN, per-part densities for instances) or explicit (kg, centroid, inertia about the centroid in kg·m²), each recorded with its source. | Inertia drives dynamics | 01 KRN TR-KRN-40 |
| FR-RBD-03 | MUST | Closed kinematic loops are supported (four-bar, slider-crank, Andrews' squeezer), with a consistent initial assembly solved by Newton on the constraints. | Most aircraft mechanisms are closed loops | [R1] |
| FR-RBD-04 | MUST | Planar mode (motion in a plane, 3 DOF per body) besides spatial mode, to avoid the redundant constraints of planar mechanisms modelled in 3D. | Redundancy makes reactions indeterminate | [R4] |
| FR-RBD-05 | MUST | Integrator: generalised-α for index-3 constrained systems with the spectral radius ρ∞ as a named setting (default 0.9, stated as defaulted), fixed step, Newton tolerance stated. | Second-order accurate for coordinates and multipliers | [R5][R6] |
| FR-RBD-06 | MUST | Position constraints are satisfied at every output step to a stated residual (≤ 1e-9 m by default, named), reported as `constraintResidualM`; energy balance (kinetic + potential + spring − work of non-conservative forces) reported. | Drift and energy errors must be visible | [R7] |
| FR-RBD-07 | MUST | **Joint reactions**: force and moment at each joint, on body b, in the joint frame and in world axes, with the instant of the peak resultant; derived from the constraint multipliers. | The loads for structural checks | [R1] |
| FR-RBD-08 | MUST | Force elements: translational spring-damper between two body points (stiffness, damping, free length, preload), joint spring-damper (torsional or axial), applied force or torque in world or body axes with a time profile. | Springs, dampers, loads | — |
| FR-RBD-09 | MUST | Joint actuators: prescribed position, velocity (as motion constraints) or force/torque, with constant, ramp, sine or table profiles; the actuator effort (force or torque) is returned over time with its peak. | Actuator sizing (inverse dynamics through prescribed motion) | — |
| FR-RBD-10 | MUST | Joint friction: Coulomb (constant force or torque) with a static factor and viscous term; true stick (velocity held at zero while the required force is within the static limit), slip and break-away events reported with times. Reaction-dependent friction is V1. | Friction often dominates small mechanisms | — |
| FR-RBD-11 | MUST | Gravity is an explicit vector or `none`; an unset gravity is a refusal (`RBD_GRAVITY_UNSET`). | AF-31: no silent environment | AF-31 |
| FR-RBD-12 | MUST | **Export joint loads to 05**: at chosen instants or at the peak resultant, create 05 load cases (`limit`) applying the reaction to the part's pin faces (05 targets, distributing coupling), with provenance (study hash, time, joint, frame) and `reviewRequired`. | Mechanism loads feed stress checks | 05 FR-FEA-08 |
| FR-RBD-13 | SHOULD (V1) | Export a reaction history to PHY-09 as a load history for a transient structural analysis. | Dynamic amplification in structure | PHY-09 FR-DYN-13 |
| FR-RBD-14 | MUST | `check_mechanism`: mobility (DOF from the constraint Jacobian rank), redundant constraints (with the joints involved), inconsistent constraints, bodies without mass, massless bodies in an under-determined chain, ground missing, gravity unset, initial assembly residual, step size vs highest spring/joint frequency, unverified masses. | AF-20 | AF-20 |
| FR-RBD-15 | MUST | Quick checks without a mechanism model: pendulum period (large amplitude), compound pendulum, spring-mass-damper response, slider-crank kinematics and torque, Coulomb oscillator decay. | The agent sanity-checks its model | AF-21 |
| FR-RBD-16 | MUST | Stable error codes (TECHNICAL_SPEC §7.1) with ids and remediation. | AF-11 | AF-11 |
| FR-RBD-17 | MUST | Deterministic: same plan, same engine version ⇒ identical `data` (byte-identical JSON). | AF-13; golden tests | AF-13 |
| FR-RBD-18 | MUST | `unverified` propagates from mass inputs (density, faceted geometry per 01 KRN FR-KRN-23), spring/friction data marked unverified, into every derived reaction and export; `reviewRequired` on reactions, actuator efforts and exports. | AF-32, AF-33 | AF-32, AF-33 |
| FR-RBD-19 | MUST | Units: inputs in document length units or SI as named in each param (`…Mm`, `…M`, `…Kg`, `…N`, `…Nm`, `…S`); outputs SI for forces and moments, document units and SI for positions, every field unit-suffixed. Masses from densities in g/(doc unit)³ are converted (today's `Material.density` convention). | AF-04, AF-10 | AF-04 |
| FR-RBD-20 | MUST | Existing kinematic commands keep their behaviour; the dynamic model reads joints and instances but never changes them, except through explicit mutating commands (`bake_dynamics_frame`, V1). | Backward compatibility | L1 |
| FR-RBD-21 | MUST | Heavy outputs (full trajectories) are bounded: summary maxima by default, sampled series on request with paging or `--save`. | AF-12 | AF-12 |
| FR-RBD-22 | MUST | Long studies report progress and honour `--timeout` (host), and respect budgets on bodies, steps and output size with a stable refusal. | AF-40 | AF-40 |
| FR-RBD-23 | MUST | Andrews' squeezer, pendulum, compound pendulum, slider-crank, spring-mass-damper and Coulomb cases run in CI through the PHY-00 harness. | Credibility | PHY-00 |

## 6. Workflows

### 6.1 CLI (`llull`, primary)

`D="--doc gear.llull.json --kernel occt --json"`.

```bash
llull search dynamics joint reaction                    # AF-01
llull describe set_body_properties add_joint_actuator dynamics_study export_joint_loads
llull guide                                             # mechanism section: units, gravity explicit, planar mode, minimal plan

llull mechanism_quick_check kind=pendulum 'inputs={"lengthM":1,"amplitudeDeg":90}' $D   # 2.36824634629 s

llull run gear_retract.plan.json --validate $D           # assembly + joints + masses + gravity + actuator (AF-05)
llull run gear_retract.plan.json $D
llull check_mechanism $D                                 # DOF, redundancy, masses, gravity, step size
llull dynamics_study name=retract $D                     # summary: peaks with times, residual, energy, unverified, reviewRequired
llull dynamics_study name=retract 'outputs={"joints":["pin_A"],"series":true}' --save out/pinA.json $D
llull export_joint_loads study=retract jointIds='["pin_A","pin_B"]' at=peak_resultant targetAnalysisId=$lug $D
llull compute_margins analysisId=$lug $D                 # 05
llull check_mechanism $D
```

Report order (AF-36): what was simulated (bodies, joints, duration, integrator), peak actuator effort and joint
loads with times, every `unverified` input, what needs a qualified engineer.

### 6.2 MCP (cloud)

Same commands; `dynamics_study` is a pure query and runs on any host within the budgets (§8 TS). Exports are
ordinary mutating commands.

### 6.3 Desktop UI (review only)

Animation of the stored series (the viewport player already animates declarative clips; it gains a "play study"
source), plots of reactions and efforts, the mass-property table with sources, and the 05 disposition dialog for
human gates. Nothing is computed only in the UI.

### 6.4 Error and edge behaviour

| Situation | Behaviour | FR |
| --------- | --------- | -- |
| A moving instance has no density and no explicit mass | `RBD_MASS_MISSING` naming the instance | FR-RBD-02 |
| Planar mechanism modelled in spatial mode | `check_mechanism` warns `RBD_REDUNDANT_CONSTRAINTS` with the joints and suggests `set_mechanism_mode mode=planar`; the study runs with rank-reduced constraints and marks indeterminate reaction components | FR-RBD-04, 07 |
| Constraints cannot all hold (wrong pivot) | `RBD_CONSTRAINTS_INCONSISTENT` / `RBD_INITIAL_INCONSISTENT` with the residual per joint | FR-RBD-03 |
| Step too large for the stiffest spring | Warning `RBD_STEP_TOO_LARGE` (step > T_min / 20, named rule) | FR-RBD-14 |
| Lock-up (singular configuration, e.g. toggle position) | Study stops with `RBD_SINGULAR_CONFIGURATION` at the time it occurs; data up to that time returned | FR-RBD-01 |
| Budget exceeded (bodies, steps, output points) | `RBD_BUDGET_EXCEEDED` with the limit and how to narrow the request | FR-RBD-22 |
| Exporting loads from a study whose inputs changed | `RBD_STUDY_STALE` (study hash mismatch) | FR-RBD-12 |

### 6.5 Glossary

| Term | Meaning here |
| ---- | ------------ |
| Index-3 DAE | Equations of motion with position-level constraints and Lagrange multipliers |
| Generalised-α | One-step implicit integrator with controllable high-frequency damping (ρ∞) |
| Joint reaction | Force and moment the joint transmits to body b |
| Planar mode | Bodies move in one plane: x, z translation and rotation about y (for normal y) |
| Stick / slip | Friction state with zero / non-zero relative velocity |

## 7. Acceptance criteria

`D = --doc case.llull.json --json`; values from `validation/expected_results.json`.

| # | Given | When (CLI) | Then (JSON) | VC |
| - | ----- | ---------- | ----------- | -- |
| AC-1 | Andrews' squeezer model built from `validation/andrews_reference.json` (plan generated at M3, TECHNICAL_SPEC §9) | `llull dynamics_study durationS=0.03 … $D` | 7 angles within 1e-6 rad of VC-RBD-01; `data.constraintResidualM` ≤ 1e-9 | VC-RBD-01, 04 |
| AC-2 | `plans/rbd_pendulum_release.plan.json` | `llull run <plan> $D` (study step) | period from the 0-crossing events = 2.36824634629 s ±1e-5 rel; pivot reaction at the bottom = 29.41995 N ±1e-6 rel | VC-RBD-10, 11 |
| AC-3 | `plans/rbd_compound_pendulum.plan.json` | same | period 1.15845886378 s ±1e-6 rel (box inertia, not the slender formula) | VC-RBD-12 |
| AC-4 | `plans/rbd_slider_crank.plan.json` | same | piston a(0) = −625 m/s², torque at 60° = 4.5806214323 N·m, at 90° = −3.22748612184 N·m | VC-RBD-20, 21 |
| AC-5 | `plans/rbd_spring_mass_damper.plan.json` | same | x(0.5 s) = −6.05596072679 mm, x(1 s) = 3.63397076193 mm ±1e-6 rel | VC-RBD-30 |
| AC-6 | `plans/rbd_coulomb_oscillator.plan.json` | same | 5 slip phases, stick from t = 1.5708 s at x = −1.9335 mm, no motion after | VC-RBD-40 |
| AC-7 | an instance without mass | `llull dynamics_study … $D` | exit 1, `RBD_MASS_MISSING` | VC-RBD-50 |
| AC-8 | any plan, twice | two runs | identical `data` hash | VC-RBD-51 |
| AC-9 | the wrong set-ups of VC-RBD-52 | each command | documented code + remediation | VC-RBD-52 |
| AC-10 | pendulum study | `llull export_joint_loads … $D` | 05 load case created, `category: "limit"`, `provenance.studyHash` present, `reviewRequired: true` | VC-RBD-53 |
| AC-11 | masses from an `unverified` density | `dynamics_study`, `check_mechanism` | `unverified: true`, warning `RBD_MASS_UNVERIFIED` | VC-RBD-54 |

## 8. Standards & regulatory alignment

There is no standard for multibody solvers. llull aligns with published benchmarks and methods:

| Reference | Use | Status |
| --------- | --- | ------ |
| Bari IVP Test Set, Andrews' squeezing mechanism [R1][R2] | Gate benchmark | Reference values read in the test-set Fortran as distributed in deTestSet (GPL); reproduced independently |
| Hairer & Wanner, Solving ODE II [R3] | Problem origin (cited by the test set and SolveDAE) | Citation only |
| Arnold & Brüls 2007 [R5]; Chung & Hulbert 1993 [R6]; Baumgarte 1972 [R7] | Integrator and stabilisation | Bibliographic data and abstracts via search |
| DLMF §22.19, §19.8 [R8][R9] | Pendulum period with K(k); AGM | §22.19 via search; AGM identity checked numerically against quadrature in the generator |
| 01 KRN mass properties | Inertia input | Specified pack |

Results carry "computed by llull, not approved — needs a qualified engineer" whenever they feed a load case or an
actuator specification.

## 9. KPIs / success metrics

| KPI | Target | How measured |
| --- | ------ | ------------ |
| Benchmarks | 100 % of VC-RBD-01…41 within tolerance | `npm test` (pure engine) |
| Determinism | identical data hash across 10 runs and across CLI / MCP / UI | VC-RBD-51 |
| Performance | Andrews 0.03 s in ≤ 2 s; 20-body spatial mechanism, 2 s simulated at 1 ms in ≤ 10 s | production gate |
| Silent defaults | 0 studies with unset gravity, unnamed ρ∞ or friction | VC-RBD-52 |
| Agent usability | US-1 unattended except human gates in ≥ 9 of 10 runs | agent driver |

## 10. Risks & assumptions

| Risk / assumption | Impact | Mitigation |
| ----------------- | ------ | ---------- |
| Existing joints pivot at the anchor instance origin and have no pivot point | Wrong dynamic geometry | `set_joint_geometry` (plugin) now; core `pivot` field later (open question 1) |
| Redundant constraints from spatial modelling of planar mechanisms | Indeterminate reactions | Planar mode; rank-revealing reduction; reactions flagged `indeterminate` |
| Friction modelling (stick-slip) is numerically delicate | Wrong break-away loads | Exact stick as a constraint with switching, validated on the Coulomb oscillator |
| Mass properties on Manifold are mesh-based | Small inertia errors | 01 KRN flags them `unverified`/approximate; propagated |
| Pure-TS performance for large mechanisms | Slow studies | Budgets; sparse Jacobians; external engine (V2) |
| Determinism of `Math.sin`/`cos` across JS engines | Golden drift | Pin by engine version; tolerance-based golden for cross-platform; open question 6 |

## 11. References

- [R1] Bari IVP Test Set for Initial Value Problem Solvers, problem "andrews" (rev. 1.2, 2006) — Università di Bari — https://archimede.uniba.it/~testset/problems/andrews.php (accessed 2026-10, via [R2]; host not fetched)
- [R2] deTestSet 1.1.7.4 (K. Soetaert et al., GPL), `src/Ex_andrews.f` and `R/ex_andrews.R` derived from [R1] — https://github.com/cran/deTestSet/tree/d5c4cbe821920ad0a2ac36ec03c6175531316213 (accessed 2026-10)
- [R3] E. Hairer, G. Wanner, Solving Ordinary Differential Equations II, Springer — as cited by [R2] and [R4]
- [R4] SolveDAE `examples/daes/andrews.py` (stabilised index-1 formulation, cites [R1], [R3]) — https://github.com/SolveDAE/solve_dae (accessed 2026-10)
- [R5] M. Arnold, O. Brüls, "Convergence of the generalized-α scheme for constrained mechanical systems", Multibody Syst. Dyn. 18(2):185–202, 2007 — https://orbi.uliege.be/handle/2268/27094 (accessed 2026-10, search)
- [R6] J. Chung, G. M. Hulbert, "A time integration algorithm for structural dynamics with improved numerical dissipation: the generalized-α method", J. Appl. Mech. 60:371–375, 1993 (accessed 2026-10, search)
- [R7] J. Baumgarte, "Stabilization of constraints and integrals of motion in dynamical systems", Comput. Methods Appl. Mech. Eng. 1:1–16, 1972, doi:10.1016/0045-7825(72)90018-7 (accessed 2026-10, search)
- [R8] NIST DLMF §22.19 Physical applications (pendulum) — https://dlmf.nist.gov/22.19 (accessed 2026-10, search)
- [R9] NIST DLMF §19.8 Quadratic transformations (AGM) — https://dlmf.nist.gov/19.8 (not fetched; identity verified numerically)
- [R10] Project Chrono (BSD-3-Clause) — https://github.com/projectchrono/chrono (HEAD 60b3938a9d4ecb56d99d8b8724abdbc89db68f32, accessed 2026-10)
- [R11] MuJoCo (Apache-2.0), docs "Simulation" (deterministic) and "Computation" (soft constraints) — https://github.com/google-deepmind/mujoco (HEAD 0d1406da61670d085bb0bcec47b502899b188a03, accessed 2026-10)
- [R12] Rapier (Apache-2.0), JS/WASM bindings, `enhanced-determinism` feature — https://github.com/dimforge/rapier (HEAD 475caa3ff4646fd9a796b67d14116256f4962bc7, accessed 2026-10)
- llull code: `packages/core/src/commands/motion/{jointsEdit,jointsDrive,jointsKinematics,motionStudy,animation}.ts`, `packages/core/src/commands/assembly/*`, `packages/core/src/model/types.ts` (`Joint`, `JointMateRef`, `DriveRelation`, `InstanceEntity`, `Material`), `packages/core/src/commands/inspect/measureSolid.ts`
