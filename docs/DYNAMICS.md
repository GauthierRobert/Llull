# Rigid-body dynamics (motion physics)

llull can run a mechanism forward in time with real physics: mass and inertia from the CAD geometry, joints, gear
trains, engines and propellers, integrated by **MuJoCo** (Google DeepMind's C engine, official WASM build
`@mujoco/mujoco`, pinned) behind the injected `PhysicsEngine` interface (`@core/dynamics/physicsEngine`, architecture L9).
The same commands run in the browser (WASM loaded on the first Simulate), in the CLI and on the MCP server.

## The model (document data, `doc.dynamics`)

| Command                                                   | What it adds                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add_rigid_body`                                          | entities that move as one part; mass / centre of mass / full inertia tensor from their geometry (material density, else `density` kg/m³, default steel); `massKg` rescales; `fixed` welds to ground                                                                                                                                     |
| `add_body_joint`                                          | revolute (shaft, hinge, crank pin), prismatic (piston) or spherical (ball pin, loop closure only) joint to `ground` or a parent body, anchor in document units, damping, dry friction, initial speed. A body may be the child of several joints: closed loops (see below)                                                               |
| `add_gear_coupling`                                       | rigid ratio between two joints (spur, belt, planetary), enforced as a near-rigid constraint                                                                                                                                                                                                                                             |
| `add_spring`                                              | point-to-point spring-damper between two bodies (or a body and the ground): world attachment points, stiffness N/m, damping N·s/m, free length (default the distance at the modelled pose) or preload; a MuJoCo spatial tendon                                                                                                          |
| `add_motor`                                               | `torque_curve` engine (N·m vs rpm × throttle) or `speed` governor (holds rpm, max torque)                                                                                                                                                                                                                                               |
| `add_propeller`                                           | static-thrust propeller: T = Ct·ρ·n²·D⁴, P = Cp·ρ·n³·D⁵, Q = P/(2πn)                                                                                                                                                                                                                                                                    |
| `add_cylinder_pressure`                                   | gas pressure on a piston (prismatic joint) driven by a crank: `table`, `wiebe` (exact IMEP calibration) or `single_zone` (Woschni heat loss) model, four- or two-stroke; crank radius, rod length and TDC read from the joints                                                                                                          |
| `set_dynamics_solver`                                     | timestep (`auto` = 0.5 deg of crank), integrator, loop constraint stiffness and the residual tiers                                                                                                                                                                                                                                      |
| `set_gravity`, `delete_dynamics_item`, `inspect_dynamics` | gravity vector; removal with cascade; read-only listing (mass, inertia about the joint axis, problems) plus topology, mobility, redundancy and loop gaps                                                                                                                                                                                |
| `engine_quick_check`                                      | analytic slider-crank kinematics, torque, rod force, side thrust and MEP / torque / power without simulating                                                                                                                                                                                                                            |
| `simulate_motion`                                         | read-only run: final rpm per joint, settle time, engine torque/power, propeller thrust/torque/power/tip Mach, measured gear ratios, warnings; `detail: "series"` adds time series, `"poses"` adds body poses for playback. With loops or cylinders also `data.loops` (residual, tier, solver), `data.reactions` and `data.engineReport` |

UI: **Mechanisms › Physics** lists the bodies, runs _Simulate_, shows the operating point and an rpm chart, and replays
the motion in the 3D view (play / scrub / slow motion down to 1/100).

Engine layout: `packages/core/src/dynamics/` (engine contract, doc → model, force laws, report),
`packages/physics-mujoco/` (MJCF generation + stepping), `packages/core/src/geometry/{massProperties,entityMassProperties}.ts`.

### Springs, energy and unsettled-run warnings

`add_body_joint` takes `stiffness` (N·m/rad revolute, N/m prismatic; 1 N/mm = 1000 N/m) and `springReference` (rad or m from the modelled
pose, default 0) and maps them to MuJoCo `stiffness` / `springref`; a spring needs a tree joint (a loop-closing joint has no coordinate:
`simulate_motion` refuses it) and spherical joints take none. `simulate_motion energy: true` (automatic when a joint has a spring) adds
`data.energy` (kinetic, potential = gravity + springs relative to the start pose, total, energy dissipated by joint damping / friction,
largest departure of the total from its start value) and with `detail: "series"` `data.series.energy`; `plot_simulation` draws it as the
`energy` quantity. Checks: mass on a prismatic spring T = 2π√(m/k) to 5e-9; torsional oscillator and spring + gravity pendulum < 0.5 %;
undamped 30 deg pendulum total-energy drift 1e-13 of the peak; damped flywheel KE = ½I(ω0e^(-ct/I))² < 0.2 % and the loss equals the
dissipated energy (0.01 %). An unsettled joint is reported by direction: "still accelerating", "still decelerating", "oscillates with an
amplitude still decaying / growing", or neutrally "not yet steady".

`add_spring` joins two attachment points (world coordinates at the modelled pose, document units; each then rides on its body) with
F = k·(L - L0) + c·dL/dt along the line of the points (spatial tendon between two sites); L0 = `freeLengthMm`, else the distance minus
`preloadN`/k, else the distance. It works with any joint arrangement (rocker, four-bar link, free body). Its energy is in the potential
energy, its damper in `dissipatedJ`, and `data.springs` gives length range and force per spring. `delete_dynamics_item` removes it (also
when either body goes). `render_motion` draws each spring as a green zig-zag between the moving attachment points and lists them in
`data.frames[].springs`. Checks (`tests/unit/dynamicsSprings.test.ts`): mass on a spring to the ground T = 2π√(m/k) to 1e-9, static
deflection m·g/k exact, undamped energy drift 3e-9 (mass), < 0.5 % (rocker), 2e-5 (four-bar with a coupler spring).

Energy balance: `data.energy` also reports `inputWorkJ` (work of motors, speed governors and cylinder gas pressure, ∫τ·dθ per step from
the engine's applied forces and servo forces, plus the propellers' absorbed work), `propellerWorkJ` (∫Q|ω|dt, carried away by the air) and
`balanceErrorJ` = initial + input - dissipated - propellers - final (and `balanceErrorFraction`). Flywheel with a flat torque curve and
viscous damping to steady state: balance error 4e-10 relative; speed governor 3e-6; torque-curve motor + propeller < 1 %. Not counted:
the work of propeller thrust on a body that translates.

## Recipe (agent or CLI): engine → reduction gear → propeller

```jsonc
// llull --doc engine.llull.json run physics.json   then   llull --doc engine.llull.json simulate_motion duration=10
{
  "actions": [
    { "command": "add_rigid_body", "params": { "id": "crank", "entityIds": ["<crank / sun gear ids>"] } },
    { "command": "add_rigid_body", "params": { "id": "prop", "entityIds": ["<hub, spinner, blades>"], "density": 600 } },
    {
      "command": "add_body_joint",
      "params": { "id": "crank_j", "kind": "revolute", "child": "crank", "anchor": [0, 60, 800], "axis": [0, 1, 0], "initialRpm": 700 },
    },
    {
      "command": "add_body_joint",
      "params": { "id": "prop_j", "kind": "revolute", "child": "prop", "anchor": [0, 200, 800], "axis": [0, 1, 0] },
    },
    // planetary, ring fixed, sun 21 / ring 51: carrier = 21 / 72 of the sun speed
    { "command": "add_gear_coupling", "params": { "driver": "crank_j", "driven": "prop_j", "ratio": 0.2917 } },
    {
      "command": "add_motor",
      "params": {
        "joint": "crank_j",
        "kind": "torque_curve",
        "curve": [
          [600, 200],
          [2500, 285],
          [3675, 290.6],
          [4200, 0],
        ],
      },
    },
    // NACA TR-684, 3 blades, 15° at 0.75 R: Ct 0.132, Cp 0.061
    { "command": "add_propeller", "params": { "joint": "prop_j", "diameter": 1.4, "thrustCoefficient": 0.132, "powerCoefficient": 0.061 } },
  ],
}
```

Read the answer in the summary: the engine's settled rpm against its rated rpm says whether the propeller loads it
(below rated) or lets it over-rev (at the curve's fall-off); thrust, absorbed power and tip Mach follow. Planets: one
body + revolute joint per planet with `parent` = the carrier body, coupled to the carrier joint with ratio
`-ringTeeth / planetTeeth`.

## How it was verified (`tests/unit/{massProperties,mujocoPhysics,dynamics*}.test.ts`)

| Check                                                         | Source of truth                                           | Result                                                           |
| ------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------- |
| Mass properties of box / cylinder / sphere, rotated, combined | closed-form formulas, parallel-axis theorem               | exact to 1e-9                                                    |
| Flywheel under constant torque: ω = τt/I                      | closed form                                               | 1e-8                                                             |
| Gear pair: driver feels I₁ + r²I₂                             | closed form                                               | < 0.2 %                                                          |
| Compound pendulum period                                      | closed form                                               | < 0.1 %                                                          |
| Propeller spin-up ω(t) = ω∞·tanh(kω∞t/I)                      | exact ODE solution                                        | 1.4e-6 relative at dt = 1 ms; **2nd-order convergence asserted** |
| Geared engine + propeller transient (8 s)                     | SciPy DOP853 on the reduced ODE (rtol 1e-11)              | final rpm identical; < 0.012 % during the start                  |
| Same model, native MuJoCo (C, Python) vs WASM                 | independent build of the engine                           | 7.8e-11 rad/s                                                    |
| Steady state and power balance                                | torque-balance root, P_engine = P_prop + P_bearing        | identical rpm; residual 3e-11 W                                  |
| Cessna 150 / O-200-A, 69" prop, static rpm                    | FAA TCDS 3A19 (2320–2470 rpm) + NACA TR-684 coefficients  | **2320 rpm**                                                     |
| Rotec R3600 radial, 3:2 PSRU, 84"×55" prop                    | Rotec data (2300–2400 prop rpm at take-off) + NACA TR-684 | 2033 rpm static (below take-off, as expected)                    |

Self-checks in every result: gear-ratio deviation (with when it happened), unsettled runs, propeller tip Mach > 0.85,
propeller figure of merit > 0.8 (no real propeller exceeds ~0.75).

## Closed loops, engines and reactions (PHY-21)

A joint graph may contain loops (slider-crank, four-bar, multi-cylinder engine). `dynamics/topology.ts` picks a spanning tree rooted at
the ground (prismatic joints first, then revolute, in creation order; the last-declared joint of a loop closes it) and
`inspect_dynamics` reports it with the mobility (Gruebler count, Jacobian rank, true degrees of freedom, redundant constraint rows and the
suggestion to make one planar loop joint `spherical`). Tree joints are MuJoCo coordinates; a loop closure is a `connect` equality (two
pins on the axis for a revolute joint, one for a spherical joint) with a stiff reference (`loopTimeConstantSteps` timesteps,
`loopImpedance` 0.9999). A prismatic joint cannot close a loop (`FPR_LOOP_PRISMATIC`); a loop open at the start pose is refused before
integrating (`FPR_LOOP_OPEN`, limit 1 µm). Loop joints have no coordinate: motors, gears, propellers and cylinder pressure sit on tree joints.

`simulate_motion` reports the largest loop-constraint violation (`data.loops.residualM`) against the physical pin clearance: pass up to
1 µm, warn up to 10 µm (`FPR_LOOP_DRIFT`, reactions approximate), fail above (reactions unreliable). The error scales with the
acceleration of the lightest body at the pin times the square of the constraint time constant: lower the timestep for light bodies under
large gas forces. `reactions` (`peaks` by default with loops) gives force and moment on the child of every joint and loop, in world axes
at the joint anchor, with peak, time and crank angle. For a driven joint the component along its axis includes the drive force itself.

`add_cylinder_pressure` applies the gas force as the generalised force of the piston joint; `data.engineReport` gives, over the last full
cycle, the torque against crank angle (1 deg), mean torque, indicated power, IMEP, the cycle-energy closure (gate 0.5 %), speed ripple
against the analytic ΔE/(I·ω²) and the peak wrist-pin, rod, side-thrust, crank-pin and main-bearing loads.

| Check (`tests/unit/{mujocoLoops,mujocoEngine,mujocoEngineStatic,engineAnalytic}.test.ts`) | Source of truth                      | Result       |
| ----------------------------------------------------------------------------------------- | ------------------------------------ | ------------ |
| Slider-crank r 49.2125 mm, l 150 mm at 2700 rpm: piston travel against crank angle        | exact kinematics x(θ)                | < 1e-6 m     |
| Crank held at 30..150 deg under 1000 N: crank torque, rod force, side thrust              | F·dx/dθ, F/cos β, F·tan β            | < 0.5 %      |
| Governed engine, pressure curve from a Wiebe model: cycle energy                          | ∮T dθ against Σ∮p dV                 | < 0.5 % gate |
| Flywheel engine: speed ripple                                                             | ΔE/(I·ω₀²) from the run torque curve | < 5 %        |
| Gear 51/21 behind the loop mechanism                                                      | tooth counts                         | < 0.1 %      |

## Limits (by design, for now)

- Propeller: static (no forward speed), coefficients supplied by the user (published data or a test); no blade-element model yet.
- Engine: a mean torque curve (`add_motor`) or, with `add_cylinder_pressure`, individual cylinder gas pulses on a slider-crank. No engine friction (FMEP), gear efficiency, tabulated propeller coefficients or calibration to a brake torque yet: indicated, not brake, values. The crank must turn in the positive sense of its joint axis.
- No contacts / collisions (pure multibody dynamics). Loop closures are soft constraints, gated against the pin clearance (see above); a spherical joint cannot carry a body on its own.
- Spin-up time depends on rotating inertia that is modelled: parts absent from the CAD (a crankshaft) are absent from it.
- Kinematic joint names on `add_body_joint` (SC-F4): `ball` is the `spherical` joint (MuJoCo ball); `revolute` / `prismatic` map to hinge / slide. `rigid`, `cylindrical`, `pin_slot`, `planar` and `cam` have no single MuJoCo joint and are refused with the composition to use (see [MECHANISMS.md](MECHANISMS.md)).
