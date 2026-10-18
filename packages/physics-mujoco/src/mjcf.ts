/**
 * Engine-neutral `SimulationModel` → MuJoCo MJCF XML. Every body frame sits at its centre of mass with world-aligned axes (so a child's
 * `pos` is the difference of centres of mass) and carries its full inertia tensor; joints are placed at their anchors in that frame. The
 * model has no geoms: no contacts, pure multibody dynamics. Loop-closing joints are `connect` equalities (a hinge outside the tree).
 */

import type { SimulationBody, SimulationLoop, SimulationModel, SimulationSpring } from '@core/dynamics/physicsEngine';
import type { Vec3 } from '@core/model/vectors';

const ZERO: Vec3 = [0, 0, 0];

/**
 * Near-rigid gear constraints. MuJoCo's default impedance (0.9–0.95) lets a light driver (a crank) slip by 100s of % against a heavy driven
 * side (a propeller seen through a reduction); 0.9999 holds the ratio to ~1 % during a violent start and exactly at steady state.
 */
const GEAR_IMPEDANCE = '0.9999 0.9999 0.001';

/** Name of the tendon of a point spring, and of its two attachment sites (A, B). */
export const springTendonName = (springId: string): string => `spring:${springId}`;
const springSiteName = (springId: string, end: 'a' | 'b'): string => `spring:${springId}:${end}`;

/** Attachment sites of the point springs, by the body that carries them ('world' = the ground). */
function springSites(springs: readonly SimulationSpring[], centers: ReadonlyMap<string, Vec3>): Map<string, string> {
  const sites = new Map<string, string>();
  for (const spring of springs)
    for (const [end, body, point] of [
      ['a', spring.bodyA, spring.pointA],
      ['b', spring.bodyB, spring.pointB],
    ] as const)
      sites.set(
        body,
        `${sites.get(body) ?? ''}<site name="${attribute(springSiteName(spring.id, end))}" pos="${numbers(minus(point, centers.get(body) ?? ZERO))}"/>`,
      );
  return sites;
}

/** Name of the `connect` equality number `index` of a loop (a revolute loop has two pins, a spherical loop one). */
export const loopEqualityName = (loopId: string, index: number): string => `loop:${loopId}:${index}`;

/** Number of `connect` equalities of a loop. */
export const loopPinCount = (loop: SimulationLoop): number => (loop.kind === 'spherical' ? 1 : 2);

const numbers = (values: readonly number[]): string => values.map((value) => String(value)).join(' ');

const minus = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** Names are ids, escaped for an XML attribute. */
const attribute = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Pin points of a loop, world: the anchor, or for a revolute loop anchor ± axis · halfSpan. */
function loopPins(loop: SimulationLoop): Vec3[] {
  if (loop.kind === 'spherical') return [loop.anchor];
  const at = (sign: number): Vec3 => [
    loop.anchor[0] + sign * loop.halfSpan * loop.axis[0],
    loop.anchor[1] + sign * loop.halfSpan * loop.axis[1],
    loop.anchor[2] + sign * loop.halfSpan * loop.axis[2],
  ];
  return [at(-1), at(1)];
}

/**
 * `connect` equalities of a loop (anchor in bodyA's frame, world for 'world'). Stiffness: reference time constant `loopTimeConstant`,
 * impedance d (solimp = d d 0.001 0.5 2): the steady violation under acceleration a is a (1 - d) tau^2 (zeta = 1).
 */
function loopXml(loop: SimulationLoop, centers: ReadonlyMap<string, Vec3>, model: SimulationModel): string {
  const reference = loop.bodyA === 'world' ? ZERO : (centers.get(loop.bodyA) ?? ZERO);
  const impedance = model.solver.loopImpedance;
  return loopPins(loop)
    .map(
      (pin, index) =>
        `<connect name="${attribute(loopEqualityName(loop.id, index))}" body1="${attribute(loop.bodyA)}" body2="${attribute(loop.bodyB)}" ` +
        `anchor="${numbers(minus(pin, reference))}" solref="${model.solver.loopTimeConstant} 1" solimp="${impedance} ${impedance} 0.001 0.5 2"/>`,
    )
    .join('');
}

/**
 * Dry friction as a near-rigid velocity constraint: MuJoCo's default soft friction row (impedance 0.9) lets a body creep at a speed
 * proportional to the unbalanced pull; impedance 0.9999 with the stiffest stable reference (2 · timestep) holds it to ~1e-6 m/s.
 */
const FRICTION_IMPEDANCE = '0.9999 0.9999 0.001';

function bodyXml(
  body: SimulationBody,
  parentCenter: Vec3,
  childrenOf: ReadonlyMap<string | null, SimulationBody[]>,
  timestep: number,
  sites: ReadonlyMap<string, string>,
): string {
  const { joint } = body;
  const jointXml =
    joint !== null
      ? `<joint name="${attribute(joint.id)}" type="${joint.kind === 'revolute' ? 'hinge' : 'slide'}" pos="${numbers(minus(joint.anchor, body.centerOfMass))}" axis="${numbers(joint.axis)}" damping="${joint.damping}" frictionloss="${joint.friction}"${joint.stiffness !== undefined && joint.stiffness > 0 ? ` stiffness="${joint.stiffness}" springref="${joint.springReference ?? 0}"` : ''}${joint.friction > 0 ? ` solreffriction="${2 * timestep} 1" solimpfriction="${FRICTION_IMPEDANCE}"` : ''}/>`
      : body.fixed
        ? ''
        : '<freejoint/>';
  const children = (childrenOf.get(body.id) ?? []).map((child) => bodyXml(child, body.centerOfMass, childrenOf, timestep, sites)).join('');
  return (
    `<body name="${attribute(body.id)}" pos="${numbers(minus(body.centerOfMass, parentCenter))}">` +
    `<inertial pos="0 0 0" mass="${body.mass}" fullinertia="${numbers(body.inertia)}"/>${jointXml}${sites.get(body.id) ?? ''}${children}</body>`
  );
}

/**
 * Servos on an open kinematic chain (a robot arm: a jointed body hanging from a jointed body, no loops or gears). The servo damping acts
 * explicitly in RK4 and the chain's mass matrix is near-singular (links nearly rigid against each other), so the per-joint gains that are
 * stable alone chatter at the step rate (torque pinned at +-maxForce, aliased speeds); the implicit-in-velocity integrator is stable.
 */
function servoChain(model: SimulationModel): boolean {
  if (model.servos.length === 0 || model.loops.length > 0 || model.gears.length > 0) return false;
  const jointed = new Set(model.bodies.flatMap((body) => (body.joint === null ? [] : [body.id])));
  return model.bodies.some((body) => body.joint !== null && body.parentId !== null && jointed.has(body.parentId));
}

/**
 * MJCF for `model`, integrated with RK4 (or implicitfast, per `solver.integrator`) at `timestep`. Gear couplings are joint equality
 * constraints q_driven = ratio · q_driver (from the initial pose), near-rigid (GEAR_IMPEDANCE) with the stiffest stable reference (time
 * constant 2 · timestep). Loop joints are `connect` equalities with the loop solref / solimp, and `diagexact` is enabled when loops exist.
 * Servos are `intvelocity` actuators (ctrl = target velocity integrated into a position set-point), evaluated by MuJoCo at every
 * integrator stage.
 */
export function toMjcf(model: SimulationModel, timestep: number): string {
  const childrenOf = new Map<string | null, SimulationBody[]>();
  for (const body of model.bodies) childrenOf.set(body.parentId, [...(childrenOf.get(body.parentId) ?? []), body]);
  const centers = new Map(model.bodies.map((body) => [body.id, body.centerOfMass] as const));
  const springs = model.springs ?? [];
  const sites = springSites(springs, centers);
  const roots = (childrenOf.get(null) ?? []).map((body) => bodyXml(body, ZERO, childrenOf, timestep, sites)).join('');
  const tendons = springs
    .map(
      (spring) =>
        `<spatial name="${attribute(springTendonName(spring.id))}" stiffness="${spring.stiffness}" damping="${spring.damping}" springlength="${spring.freeLength}">` +
        `<site site="${attribute(springSiteName(spring.id, 'a'))}"/><site site="${attribute(springSiteName(spring.id, 'b'))}"/></spatial>`,
    )
    .join('');
  const gears = model.gears
    .map(
      (gear) =>
        `<joint name="${attribute(gear.id)}" joint1="${attribute(gear.driven)}" joint2="${attribute(gear.driver)}" polycoef="0 ${gear.ratio} 0 0 0" solref="${2 * timestep} 1" solimp="${GEAR_IMPEDANCE}"/>`,
    )
    .join('');
  const loops = model.loops.map((loop) => loopXml(loop, centers, model)).join('');
  const servos = model.servos
    .map(
      (servo) =>
        `<intvelocity name="${attribute(servo.id)}" joint="${attribute(servo.joint)}" kp="${servo.stiffness}" kv="${servo.damping}" ` +
        `actrange="-1e12 1e12" forcelimited="true" forcerange="${-servo.maxForce} ${servo.maxForce}"/>`,
    )
    .join('');
  const integrator = model.solver.integrator === 'implicitfast' || servoChain(model) ? 'implicitfast' : 'RK4';
  const flags = `<flag${model.loops.length > 0 ? ' diagexact="enable"' : ''} energy="enable"/>`;
  const jacobian = model.loops.length > 0 ? ' jacobian="dense"' : '';
  return (
    '<mujoco model="llull"><compiler angle="radian" inertiafromgeom="false" balanceinertia="true"/>' +
    `<option timestep="${timestep}" integrator="${integrator}"${jacobian} gravity="${numbers(model.gravity)}">${flags}</option>` +
    `<worldbody>${sites.get('world') ?? ''}${roots}</worldbody>${gears === '' && loops === '' ? '' : `<equality>${gears}${loops}</equality>`}` +
    `${tendons === '' ? '' : `<tendon>${tendons}</tendon>`}${servos === '' ? '' : `<actuator>${servos}</actuator>`}</mujoco>`
  );
}
