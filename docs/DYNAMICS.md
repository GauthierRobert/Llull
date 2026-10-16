# Rigid-body dynamics (motion physics)

llull can run a mechanism forward in time with real physics: mass and inertia from the CAD geometry, joints, gear
trains, engines and propellers, integrated by **MuJoCo** (Google DeepMind's C engine, official WASM build
`@mujoco/mujoco`, pinned) behind the injected `PhysicsEngine` interface (`@core/dynamics/physicsEngine`, architecture L9).
The same commands run in the browser (WASM loaded on the first Simulate), in the CLI and on the MCP server.

## The model (document data, `doc.dynamics`)

| Command                                                   | What it adds                                                                                                                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add_rigid_body`                                          | entities that move as one part; mass / centre of mass / full inertia tensor from their geometry (material density, else `density` kg/m³, default steel); `massKg` rescales; `fixed` welds to ground                       |
| `add_body_joint`                                          | revolute (shaft, hinge, crank pin) or prismatic (piston) joint to `ground` or a parent body, anchor in document units, damping, dry friction, initial speed                                                               |
| `add_gear_coupling`                                       | rigid ratio between two joints (spur, belt, planetary), enforced as a near-rigid constraint                                                                                                                               |
| `add_motor`                                               | `torque_curve` engine (N·m vs rpm × throttle) or `speed` governor (holds rpm, max torque)                                                                                                                                 |
| `add_propeller`                                           | static-thrust propeller: T = Ct·ρ·n²·D⁴, P = Cp·ρ·n³·D⁵, Q = P/(2πn)                                                                                                                                                      |
| `set_gravity`, `delete_dynamics_item`, `inspect_dynamics` | gravity vector; removal with cascade; read-only listing (mass, inertia about the joint axis, problems)                                                                                                                    |
| `simulate_motion`                                         | read-only run: final rpm per joint, settle time, engine torque/power, propeller thrust/torque/power/tip Mach, measured gear ratios, warnings; `detail: "series"` adds time series, `"poses"` adds body poses for playback |

UI: **Mechanisms › Physics** lists the bodies, runs _Simulate_, shows the operating point and an rpm chart, and replays
the motion in the 3D view (play / scrub / slow motion down to 1/100).

Engine layout: `packages/core/src/dynamics/` (engine contract, doc → model, force laws, report),
`packages/physics-mujoco/` (MJCF generation + stepping), `packages/core/src/geometry/{massProperties,entityMassProperties}.ts`.

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

## Limits (by design, for now)

- Propeller: static (no forward speed), coefficients supplied by the user (published data or a test); no blade-element model yet.
- Engine: mean torque curve — no individual cylinder firing pulses, no slider-crank pistons yet.
- No contacts / collisions (pure multibody dynamics); each body is the child of one joint (no closed loops yet).
- Spin-up time depends on rotating inertia that is modelled: parts absent from the CAD (a crankshaft) are absent from it.
