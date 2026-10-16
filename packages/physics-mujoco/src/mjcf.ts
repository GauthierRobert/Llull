/**
 * Engine-neutral `SimulationModel` → MuJoCo MJCF XML. Every body frame sits at its centre of mass with world-aligned axes (so a child's
 * `pos` is the difference of centres of mass) and carries its full inertia tensor; joints are placed at their anchors in that frame. The
 * model has no geoms: no contacts, pure multibody dynamics.
 */

import type { SimulationBody, SimulationModel } from '@core/dynamics/physicsEngine';
import type { Vec3 } from '@core/model/vectors';

const ZERO: Vec3 = [0, 0, 0];

/**
 * Near-rigid gear constraints. MuJoCo's default impedance (0.9–0.95) lets a light driver (a crank) slip by 100s of % against a heavy driven
 * side (a propeller seen through a reduction); 0.9999 holds the ratio to ~1 % during a violent start and exactly at steady state.
 */
const GEAR_IMPEDANCE = '0.9999 0.9999 0.001';

const numbers = (values: readonly number[]): string => values.map((value) => String(value)).join(' ');

const minus = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** Names are ids, escaped for an XML attribute. */
const attribute = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function bodyXml(body: SimulationBody, parentCenter: Vec3, childrenOf: ReadonlyMap<string | null, SimulationBody[]>): string {
  const { joint } = body;
  const jointXml =
    joint !== null
      ? `<joint name="${attribute(joint.id)}" type="${joint.kind === 'revolute' ? 'hinge' : 'slide'}" pos="${numbers(minus(joint.anchor, body.centerOfMass))}" axis="${numbers(joint.axis)}" damping="${joint.damping}" frictionloss="${joint.friction}"/>`
      : body.fixed
        ? ''
        : '<freejoint/>';
  const children = (childrenOf.get(body.id) ?? []).map((child) => bodyXml(child, body.centerOfMass, childrenOf)).join('');
  return (
    `<body name="${attribute(body.id)}" pos="${numbers(minus(body.centerOfMass, parentCenter))}">` +
    `<inertial pos="0 0 0" mass="${body.mass}" fullinertia="${numbers(body.inertia)}"/>${jointXml}${children}</body>`
  );
}

/**
 * MJCF for `model`, integrated with RK4 at `timestep`. Gear couplings are joint equality constraints q_driven = ratio · q_driver (from the
 * initial pose), near-rigid (GEAR_IMPEDANCE) with the stiffest stable reference (time constant 2 · timestep). Servos are `intvelocity` actuators (ctrl = target velocity integrated
 * into a position set-point), evaluated by MuJoCo at every integrator stage.
 */
export function toMjcf(model: SimulationModel, timestep: number): string {
  const childrenOf = new Map<string | null, SimulationBody[]>();
  for (const body of model.bodies) childrenOf.set(body.parentId, [...(childrenOf.get(body.parentId) ?? []), body]);
  const roots = (childrenOf.get(null) ?? []).map((body) => bodyXml(body, ZERO, childrenOf)).join('');
  const gears = model.gears
    .map(
      (gear) =>
        `<joint name="${attribute(gear.id)}" joint1="${attribute(gear.driven)}" joint2="${attribute(gear.driver)}" polycoef="0 ${gear.ratio} 0 0 0" solref="${2 * timestep} 1" solimp="${GEAR_IMPEDANCE}"/>`,
    )
    .join('');
  const servos = model.servos
    .map(
      (servo) =>
        `<intvelocity name="${attribute(servo.id)}" joint="${attribute(servo.joint)}" kp="${servo.stiffness}" kv="${servo.damping}" ` +
        `actrange="-1e12 1e12" forcelimited="true" forcerange="${-servo.maxForce} ${servo.maxForce}"/>`,
    )
    .join('');
  return (
    '<mujoco model="llull"><compiler angle="radian" inertiafromgeom="false" balanceinertia="true"/>' +
    `<option timestep="${timestep}" integrator="RK4" gravity="${numbers(model.gravity)}"/>` +
    `<worldbody>${roots}</worldbody>${gears === '' ? '' : `<equality>${gears}</equality>`}` +
    `${servos === '' ? '' : `<actuator>${servos}</actuator>`}</mujoco>`
  );
}
