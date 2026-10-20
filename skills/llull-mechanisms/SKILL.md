---
name: llull-mechanisms
description: Make parts move in llull (local CAD) through the `llull` CLI — kinematic joints between component instances (hinges, sliders, gear ratios, poses) and rigid-body dynamics (bodies, joints, springs, motors, gears, propellers simulated with MuJoCo), checked against hand-computed mass, inertia, speeds and periods, plus clearance and mobility checks. Use when asked to animate, articulate, simulate, drive, or check the motion of a mechanism, linkage, engine, gearbox, hinge or pendulum in llull.
---

# llull-mechanisms: kinematics and dynamics, verified

llull has two motion models. Pick one per question:

| Question | Model | Commands |
| -------- | ----- | -------- |
| "Where is part B when the hinge is at 30°?" (poses, no forces) | kinematic joints between component instances | `add_joint` `set_joint_value` `add_drive_relation` `evaluate_motion` `bake_motion` |
| "How fast does it spin / how long does it take / what forces?" | rigid-body dynamics (MuJoCo) | `add_rigid_body` `add_body_joint` `add_spring` `add_motor` `add_gear_coupling` `add_propeller` `set_gravity` `simulate_motion` |

Discover details with `llull describe <command>`; list them with `llull list assembly`. Units: document lengths (mm) for anchors and
positions, SI for dynamics (kg, N·m, rad/s, rpm, s). Angles in RADIANS.

## Kinematics (instances + joints)

1. Model each moving part, then turn it into a component instance: `create_component` (returns the instance id) and
   `insert_instance` for more copies.
2. `add_joint` `kind=revolute|prismatic`, `a` = fixed instance frame, `b` = moving instance, `axis` `"x"|"y"|"z"` or a vector.
3. `set_joint_value` (radians or mm, or `"=expr"` over parameters), couple joints with `add_drive_relation`
   (`driven = driver * ratio + offset`, e.g. a 2:1 gear pair).
4. `evaluate_motion` (read-only: `data.instancePositions`, `data.instanceRotations`) — check a pose against your own trigonometry
   (a point at radius r on a revolute joint at angle θ is at `(r cos θ, r sin θ)` about the axis). `bake_motion` writes the pose.
5. `check_mechanism` reports mobility (Grübler-Kutzbach count): `FPR_MECH_LOCKED` = nothing can move, `FPR_MECH_UNDERCONSTRAINED` =
   more freedoms than drives.

## Dynamics (bodies + joints + loads)

Plan the numbers first. Worked example — a steel flywheel R50 x 20 mm on a damped shaft, driven by a 1 N·m motor:

- mass `m = 7850 kg/m³ · π · 0.05² · 0.02 = 1.2331 kg`; inertia `I = ½ m r² = 0.0015413 kg·m²`;
- steady speed `ω = T / c = 1 / 0.01 = 100 rad/s = 954.9 rpm`; time constant `I / c = 0.154 s` (settled after ~4 time constants).

```json
[
  { "command": "set_units", "params": { "units": "mm" } },
  { "command": "add_cylinder", "params": { "radius": 50, "height": 20, "position": [0, 0, 0] }, "as": "disc" },
  { "command": "add_rigid_body", "params": { "entityIds": ["$disc"], "name": "flywheel", "density": 7850 }, "as": "wheel" },
  { "command": "add_body_joint", "params": { "kind": "revolute", "child": "$wheel", "anchor": [0, 0, 0], "axis": [0, 0, 1], "damping": 0.01 }, "as": "shaft" },
  { "command": "add_motor", "params": { "joint": "$shaft", "kind": "torque_curve", "torque": 1 } }
]
```

```bash
llull run flywheel.json --doc mech.llull.json
llull inspect_dynamics --doc mech.llull.json                 # massKg 1.23308, inertiaAboutJointAxis 0.00154134 -> matches
llull simulate_motion duration=5 --doc mech.llull.json --json  # joints.<id>.finalVelocity 100, finalRpm 954.93, settledAfter ~0.6 s
```

Always compare `inspect_dynamics` (mass, centre of mass, inertia about the joint axis) with your hand values BEFORE simulating, then
the simulated speeds / periods with the analytic ones: a pendulum of length L has period `2π·sqrt(L/g)` for small swings, a
mass-spring `2π·sqrt(m/k)`, a gear pair `ω_driven = ratio · ω_driver`.

- Materials: give each body a material (`assign_material`), `density`, or the real `massKg`; otherwise the steel default is used and
  `check_dynamics` warns `FPR_MASS_DEFAULTED`.
- `fixed: true` welds a body to the ground; a body with no joint falls under gravity (`set_gravity` to change it).
- Closed loops (slider-crank, four-bar): declare every joint; `inspect_dynamics` reports `data.mobility.dof` (a crank-driven
  slider-crank has 1) and `data.loopGapsM` (must be ≤ 1 µm or `simulate_motion` refuses with `FPR_LOOP_OPEN`). Make one revolute
  loop joint `spherical` in a planar loop to avoid redundant constraints.
- `simulate_motion energy=true` adds the energy balance; `balanceErrorJ` near 0 is a self-check of the run.

## Check the motion

```bash
llull check_mechanism --doc mech.llull.json                  # mobility vs drives
llull check_dynamics duration=2 --doc mech.llull.json        # realistic inputs, timestep sensitivity, loop drift, energy closure
llull check_motion_clearance clearanceMm=1 --doc mech.llull.json   # parts hitting each other while moving (needs the geometry kernel)
llull plot_simulation --save speed.png --doc mech.llull.json       # see describe plot_simulation for the series to plot
```

`status` is the worst item: fail > not_run > warn > pass, and `not_run` is never a pass (the engine or kernel was missing).

## Known traps

- Joint `anchor` is a WORLD point in document units (mm), on the axis; `axis` need not be unit length.
- Motors, gear couplings, springs and propellers must sit on tree joints, not on the joint that closes a loop.
- Kinematic joints (`add_joint`) only move component INSTANCES; dynamics bodies (`add_rigid_body`) take plain 3D entities.
- `evaluate_motion` changes nothing; `bake_motion` moves the instances (and is undoable).
- Simulate long enough: at least a few time constants, or two crank turns for a four-stroke engine; read `steady` and `warnings`.
- Every result here is computed by llull and marked for engineering review; say so when you report it.
