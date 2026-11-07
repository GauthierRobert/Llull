/**
 * Engine-neutral `SimulationModel` → MuJoCo MJCF XML. Every body frame sits at its centre of mass with world-aligned axes (so a child's
 * `pos` is the difference of centres of mass) and carries its full inertia tensor; joints are placed at their anchors in that frame. The
 * model has no geoms: no contacts, pure multibody dynamics. Loop-closing joints are `connect` equalities (a hinge outside the tree).
 */

import { sub3 } from '@lib/vec3';
import { escapeXml } from '@lib/escapeXml';
import type { SimulationBody, SimulationLoop, SimulationModel, SimulationSpring, TransmissionCoupling } from '@core/dynamics/physicsEngine';
import type { Vec3 } from '@core/model/vectors';

const ZERO: Vec3 = [0, 0, 0];

/**
 * Near-rigid transmission constraints. MuJoCo's default impedance (0.9–0.95) lets a light driver (a crank) slip by 100s of % against a heavy driven
 * side (a propeller seen through a reduction); 0.9999 holds the ratio to ~1 % during a violent start and exactly at steady state.
 */
const GEAR_IMPEDANCE = '0.9999 0.9999 0.001';

/** Name of the equality (no backlash) or fixed tendon (backlash) of a transmission. */
export const transmissionName = (id: string): string => `trn:${id}`;

/**
 * A limit row (joint range or fixed-tendon range) with the stiffness K and damping B of a one-sided spring-damper. MuJoCo's direct `solreflimit`
 * form [-k, -b] is an ACCELERATION law (DRV-M0 13.2): the force of the row is its effective inertia times (k x + b v), so k = K / J, b = B / J.
 * Flat impedance (0.9999 0.9999 0.001) makes the row an exact linear spring-damper.
 */
const limitAttributes = (stiffness: number, damping: number, inertia: number): string =>
  `solreflimit="${-stiffness / inertia} ${-damping / inertia}" solimplimit="${GEAR_IMPEDANCE}"`;

/** Per-joint attributes that come from joint physics: the limit attributes, and the joints whose friction level varies. */
interface JointAttributes {
  readonly limit: ReadonlyMap<string, string>;
  /** Joints with a variable friction level: their friction constraint needs the stiff reference whatever the constant. */
  readonly dynamicFriction: ReadonlySet<string>;
}

function jointAttributes(model: SimulationModel): JointAttributes {
  const limit = new Map(
    (model.jointPhysics?.limits ?? []).map((entry) => [
      entry.joint,
      ` limited="true" range="${entry.min} ${entry.max}" ${limitAttributes(entry.stiffness, entry.damping, entry.effectiveInertia)}`,
    ]),
  );
  return { limit, dynamicFriction: new Set([...(model.jointPhysics?.frictionJoints ?? []), ...lossyInputs(model)]) };
}

/** Input joints of the transmissions that lose power: their friction level is rewritten every step. */
export const lossyInputs = (model: SimulationModel): string[] =>
  model.transmissions.filter((coupling) => coupling.efficiency !== undefined).map((coupling) => coupling.a);

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
        `${sites.get(body) ?? ''}<site name="${escapeXml(springSiteName(spring.id, end))}" pos="${numbers(sub3(point, centers.get(body) ?? ZERO))}"/>`,
      );
  return sites;
}

/** Name of the `connect` equality number `index` of a loop (a revolute loop has two pins, a spherical loop one). */
export const loopEqualityName = (loopId: string, index: number): string => `loop:${loopId}:${index}`;

/** Number of `connect` equalities of a loop. */
export const loopPinCount = (loop: SimulationLoop): number => (loop.kind === 'spherical' ? 1 : 2);

const numbers = (values: readonly number[]): string => values.map((value) => String(value)).join(' ');

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
        `<connect name="${escapeXml(loopEqualityName(loop.id, index))}" body1="${escapeXml(loop.bodyA)}" body2="${escapeXml(loop.bodyB)}" ` +
        `anchor="${numbers(sub3(pin, reference))}" solref="${model.solver.loopTimeConstant} 1" solimp="${impedance} ${impedance} 0.001 0.5 2"/>`,
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
  physics: JointAttributes,
): string {
  const { joint } = body;
  const jointXml =
    joint !== null
      ? `<joint name="${escapeXml(joint.id)}" type="${joint.kind === 'revolute' ? 'hinge' : 'slide'}" pos="${numbers(sub3(joint.anchor, body.centerOfMass))}" axis="${numbers(joint.axis)}" damping="${joint.damping}" frictionloss="${joint.friction}"${joint.armature !== undefined && joint.armature > 0 ? ` armature="${joint.armature}"` : ''}${joint.stiffness !== undefined && joint.stiffness > 0 ? ` stiffness="${joint.stiffness}" springref="${joint.springReference ?? 0}"` : ''}${physics.limit.get(joint.id) ?? ''}${joint.friction > 0 || physics.dynamicFriction.has(joint.id) ? ` solreffriction="${2 * timestep} 1" solimpfriction="${FRICTION_IMPEDANCE}"` : ''}/>`
      : body.fixed
        ? ''
        : '<freejoint/>';
  const children = (childrenOf.get(body.id) ?? [])
    .map((child) => bodyXml(child, body.centerOfMass, childrenOf, timestep, sites, physics))
    .join('');
  return (
    `<body name="${escapeXml(body.id)}" pos="${numbers(sub3(body.centerOfMass, parentCenter))}">` +
    `<inertial pos="0 0 0" mass="${body.mass}" fullinertia="${numbers(body.inertia)}"/>${jointXml}${sites.get(body.id) ?? ''}${children}</body>`
  );
}

/**
 * Servos on an open kinematic chain (a robot arm: a jointed body hanging from a jointed body, no loops or gears). The servo damping acts
 * explicitly in RK4 and the chain's mass matrix is near-singular (links nearly rigid against each other), so the per-joint gains that are
 * stable alone chatter at the step rate (torque pinned at +-maxForce, aliased speeds); the implicit-in-velocity integrator is stable.
 */
function servoChain(model: SimulationModel): boolean {
  if (model.servos.length === 0 || model.loops.length > 0 || model.transmissions.length > 0) return false;
  const jointed = new Set(model.bodies.flatMap((body) => (body.joint === null ? [] : [body.id])));
  return model.bodies.some((body) => body.joint !== null && body.parentId !== null && jointed.has(body.parentId));
}

/** The constraint Jacobian rows are read (loop forces, coupling torques): dense layout. */
function needsDenseJacobian(model: SimulationModel): boolean {
  return (
    model.loops.length > 0 ||
    model.transmissions.some((coupling) => coupling.efficiency !== undefined || coupling.backlash !== undefined) ||
    (model.jointPhysics?.frictionJoints.length ?? 0) > 0 ||
    (model.jointPhysics?.limits.length ?? 0) > 0
  );
}

/**
 * Rigid transmission as a joint equality. MuJoCo regularises a joint equality row with the SUM of the two joints' inverse inertias, without the
 * polycoef factor (efc_R = (1 - d) / d · (w_1 + w_2)), while the row's real inverse inertia is w_1 + c² w_2: written as q_b = ratio · q_a with a
 * small ratio and a light a, the regularisation outweighs the row 30 times and the coupling is soft (DRV-M2: a 1.6 mm/rad screw against a 10 kg nut
 * followed the screw only after 5 ms). The row is therefore written with the joint of the larger coefficient as the dependent one (|c| >= 1).
 */
function transmissionEquality(coupling: TransmissionCoupling, timestep: number): string {
  const [dependent, driver, coefficient] =
    Math.abs(coupling.ratio) >= 1 ? [coupling.b, coupling.a, coupling.ratio] : [coupling.a, coupling.b, 1 / coupling.ratio];
  return (
    `<joint name="${escapeXml(transmissionName(coupling.id))}" joint1="${escapeXml(dependent)}" joint2="${escapeXml(driver)}" ` +
    `polycoef="0 ${coefficient} 0 0 0" solref="${2 * timestep} 1" solimp="${GEAR_IMPEDANCE}"/>`
  );
}

/** Backlash as a fixed tendon of length ratio · q_a - q_b limited to ±gap/2, a one-sided spring-damper at each edge (DRV-M0 13.3). */
function backlashTendon(coupling: TransmissionCoupling, backlash: NonNullable<TransmissionCoupling['backlash']>): string {
  return (
    `<fixed name="${escapeXml(transmissionName(coupling.id))}" limited="true" range="${-backlash.gap / 2} ${backlash.gap / 2}" ` +
    `${limitAttributes(backlash.stiffness, backlash.damping, backlash.effectiveInertia)}>` +
    `<joint joint="${escapeXml(coupling.a)}" coef="${coupling.ratio}"/><joint joint="${escapeXml(coupling.b)}" coef="-1"/></fixed>`
  );
}

/**
 * MJCF for `model`, integrated with RK4 (or implicitfast, per `solver.integrator`) at `timestep`. Transmissions are joint equality
 * constraints q_driven = ratio · q_driver (from the initial pose), near-rigid (GEAR_IMPEDANCE) with the stiffest stable reference (time
 * constant 2 · timestep), or a limited fixed tendon when they have backlash; joint end stops are joint ranges. Loop joints are `connect` equalities with the loop solref / solimp, and `diagexact` is enabled when loops exist.
 * Servos are `intvelocity` actuators (ctrl = target velocity integrated into a position set-point), evaluated by MuJoCo at every
 * integrator stage.
 */
export function toMjcf(model: SimulationModel, timestep: number): string {
  const childrenOf = new Map<string | null, SimulationBody[]>();
  for (const body of model.bodies) childrenOf.set(body.parentId, [...(childrenOf.get(body.parentId) ?? []), body]);
  const centers = new Map(model.bodies.map((body) => [body.id, body.centerOfMass] as const));
  const springs = model.springs ?? [];
  const sites = springSites(springs, centers);
  const roots = (childrenOf.get(null) ?? [])
    .map((body) => bodyXml(body, ZERO, childrenOf, timestep, sites, jointAttributes(model)))
    .join('');
  const tendons = springs
    .map(
      (spring) =>
        `<spatial name="${escapeXml(springTendonName(spring.id))}" stiffness="${spring.stiffness}" damping="${spring.damping}" springlength="${spring.freeLength}">` +
        `<site site="${escapeXml(springSiteName(spring.id, 'a'))}"/><site site="${escapeXml(springSiteName(spring.id, 'b'))}"/></spatial>`,
    )
    .join('');
  const equalities = model.transmissions
    .filter((coupling) => coupling.backlash === undefined)
    .map((coupling) => transmissionEquality(coupling, timestep))
    .join('');
  const backlash = model.transmissions
    .flatMap((coupling) => (coupling.backlash === undefined ? [] : [backlashTendon(coupling, coupling.backlash)]))
    .join('');
  const loops = model.loops.map((loop) => loopXml(loop, centers, model)).join('');
  const servos = model.servos
    .map(
      (servo) =>
        `<intvelocity name="${escapeXml(servo.id)}" joint="${escapeXml(servo.joint)}" kp="${servo.stiffness}" kv="${servo.damping}" ` +
        `actrange="-1e12 1e12" forcelimited="true" forcerange="${-servo.maxForce} ${servo.maxForce}"/>`,
    )
    .join('');
  const integrator = model.solver.integrator === 'implicitfast' || servoChain(model) ? 'implicitfast' : 'RK4';
  const flags = `<flag${model.loops.length > 0 ? ' diagexact="enable"' : ''} energy="enable"/>`;
  const jacobian = model.loops.length > 0 || needsDenseJacobian(model) ? ' jacobian="dense"' : '';
  return (
    '<mujoco model="llull"><compiler angle="radian" inertiafromgeom="false" balanceinertia="true"/>' +
    `<option timestep="${timestep}" integrator="${integrator}"${jacobian} gravity="${numbers(model.gravity)}">${flags}</option>` +
    `<worldbody>${sites.get('world') ?? ''}${roots}</worldbody>${equalities === '' && loops === '' ? '' : `<equality>${equalities}${loops}</equality>`}` +
    `${tendons === '' && backlash === '' ? '' : `<tendon>${tendons}${backlash}</tendon>`}${servos === '' ? '' : `<actuator>${servos}</actuator>`}</mujoco>`
  );
}
