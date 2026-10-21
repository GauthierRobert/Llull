# Mechanisms: kinematic joints, loops, contact stops, exploded views

Kinematic joints (`add_joint`) pose instances for assemblies and animation; force/mass physics is separate (`add_body_joint`, see
[DYNAMICS.md](DYNAMICS.md)). Every row below is implemented and covered by a test.

## SolidCraft joint kinds vs llull

| SolidCraft joint | llull `add_joint` kind | DOF (`values` order)                     | Limits | Dynamics (`add_body_joint`)                        | Test                                  |
| ---------------- | ---------------------- | ---------------------------------------- | ------ | -------------------------------------------------- | ------------------------------------- |
| Rigid            | `rigid`                | 0                                        | n/a    | refused: weld the body (`fixed: true`) or merge it | `mechanismKinds`, `bodyJointKinds`    |
| Revolute         | `revolute`             | 1 (angle, rad)                           | yes    | `revolute` (MuJoCo hinge)                          | `jointKinematics`, `mechanismLoops`   |
| Slider           | `prismatic`            | 1 (displacement)                         | yes    | `prismatic` (MuJoCo slide)                         | `jointKinematics`, `mechanismLoops`   |
| Cylindrical      | `cylindrical`          | 2 (angle, slide on the same axis)        | yes    | refused: prismatic + revolute through a body       | `mechanismKinds`, `bodyJointKinds`    |
| Pin-slot         | `pin_slot`             | 2 (angle about `axis`, slide on `slotAxis`) | yes | refused: prismatic + revolute through a body       | `mechanismKinds`, `bodyJointKinds`    |
| Planar           | `planar`               | 3 (u, v in the plane normal to `axis`, angle) | yes | refused: 2 prismatic + revolute through bodies     | `mechanismKinds`, `bodyJointKinds`    |
| Ball             | `ball`                 | 3 (Euler XYZ about the pivot)            | yes    | `ball` = `spherical` (MuJoCo ball, loop closure only) | `mechanismKinds`, `bodyJointKinds` |
| Cam              | `cam`                  | 0 (follower slide computed from the angle of `camJoint` and the 2D `profileId`) | n/a | refused (kinematic coupling only) | `mechanismKinds`, `bodyJointKinds` |

`pivot` (world point, default origin of instance `a`) places the pin; `limits` is one `{ min?, max? }` per DOF and clamps
`set_joint_value` / `drive_joint_to`. `set_joint_value` takes `dof` (0-based index) on multi-DOF joints.

Cam profile: a closed polyline, rectangle or circle whose local XY origin is the cam rotation centre; an in-line knife-edge follower
slides along `axis` (perpendicular to the cam axis, i.e. the axis of `camJoint`). Lift = `r(psi - theta) - r(psi)`; an eccentric disc
reproduces `e cos(theta) + sqrt(R^2 - e^2 sin^2(theta)) - (e + R)` (test `cam follower`).

## Closed loops

Mark the joints whose value is unknown `passive: true` and drive the others (`set_joint_value`, `motion_study`, `drive_joint_to`).
`evaluate_motion` (`apply`: false queries, true writes the pose) / `motion_study` plan a spanning tree from the instances no joint moves (the ground), then solve the
passive values so every joint beyond the tree closes (Levenberg-Marquardt on the pose residual of three reference points; the stored
values are the initial guess, so the assembly branch is kept; failed starts retry from 40 deterministic restarts).
`data.loop = { closed, residual, message, loops, passive }`. When the loop cannot close (Grashof violation at that angle) or a solved
joint leaves its limits, `closed` is false, `evaluate_motion` with `apply: true` refuses (document unchanged) and `drive_joint_to` stops there.

Verified (`tests/unit/mechanismLoops.test.ts`):

- four-bar (crank 2, coupler 4, rocker 3.5, ground 5) vs the Freudenstein relation over 13 crank angles in [0, 2.4]: rocker angle to 1e-8 rad.
- slider-crank (r = 2, l = 5) vs `x = r cos(theta) + sqrt(l^2 - r^2 sin^2(theta))` over 25 angles in [0, 2 pi]: slider x to 1e-8.
- four-bar (2, 2, 2, 5): the loop stops closing at `theta = acos(13/20)`; `drive_joint_to` stops there (4 decimals).

## Contact sets and driving

`create_contact_set` stores pairs of instances. `motion_study` (`contactSetId`) and `drive_joint_to` (`contactSetId`) scan the range, find the
first touching sample (bounding boxes of the posed instances, overlap > 1e-9 of the diagonal) or the first sample where a passive loop
stops closing, and bisect to the tolerance. Reported: `{ stopped, stopValue, reason: 'contact' | 'loop_open', pair }`.
Test: a unit slider and block 10 apart stop at 9 (`contactSets.test.ts`).

## Exploded views

`create_exploded_view` stores per-entity offsets (explicit, and/or auto: instance `i` in assembly order moves `i * spacing` along an axis, in
step `i`) in `doc.explodedViews`; `set_active_exploded_view` (no id = off, optional `step`) selects what the 3D viewport draws. Offsets are
applied to the drawn positions only; entity placements, `evaluate_motion` with `apply: true` and exports are unaffected. Sheets do not yet reference exploded views.

## Limits

- Cam: in-line knife-edge follower only (no offset, roller radius or force closure); `camJoint` must not be passive.
- Loop solver works on rest-relative rigid motions; bounding-box contact is conservative (AABB of the posed instance).
- Tree orientation: a joint is evaluated only when instance `a` is already reached from the ground; list the ground-side instance as `a`.
- `add_body_joint` refuses rigid, cylindrical, pin_slot, planar and cam; compose them from prismatic and revolute joints yourself.
