/**
 * `CadDocument.dynamics` + entity geometry → the engine-neutral `SimulationModel` (SI units). Bodies get their mass properties from their
 * entities' geometry; the joint tree is ordered parent before child; gear initial speeds are made consistent with the ratios.
 */

import type { CadDocument, Entity, Vec3 } from '../model/types';
import { GROUND, type DynamicJoint, type DynamicsModel, type RigidBody } from '../model/dynamics';
import { toMetres } from '../model/units';
import { entityMassProperties } from '../geometry/entityMassProperties';
import { combineMassProperties, type InertiaTensor, type MassProperties } from '../geometry/massProperties';
import { RAD_PER_S_PER_RPM, appliedLoadsFor, speedServoGains } from './forceLaws';
import type { SimulationBody, SimulationJoint, SimulationModel, SimulationServo } from './physicsEngine';

/** kg/m³ of a body entity without a material: steel. */
const DEFAULT_DENSITY = 7850;

/** SI mass properties of one body (kg, m, kg·m²). */
export interface BodyMassProperties {
  readonly mass: number;
  readonly centerOfMass: Vec3;
  readonly inertia: InertiaTensor;
}

/**
 * Mass properties of `body` in SI units, or an error. Entity densities: assigned material (g per document unit³), else the body density,
 * else steel. `massKg` rescales the whole distribution.
 */
export function bodyMassProperties(doc: CadDocument, body: RigidBody): BodyMassProperties | { error: string } {
  const metres = toMetres(doc, 1);
  const unitVolume = metres ** 3;
  const densityOf = (solid: Entity): number => {
    const material = solid.materialId === undefined ? undefined : doc.materials[solid.materialId];
    const kgPerCubicMetre = material !== undefined ? material.density / 1000 / unitVolume : (body.density ?? DEFAULT_DENSITY);
    return kgPerCubicMetre * unitVolume;
  };
  const parts: MassProperties[] = [];
  for (const id of body.entityIds) {
    const entity = doc.entities[id];
    if (entity === undefined) return { error: `body '${body.id}' references missing entity '${id}'` };
    const props = entityMassProperties(entity, doc, densityOf);
    if (props === null) return { error: `body '${body.id}': entity '${id}' (${entity.kind}) has no solid volume` };
    parts.push(props);
  }
  const combined = combineMassProperties(parts);
  if (combined === null) return { error: `body '${body.id}' has zero mass` };
  const scale = body.massKg !== undefined ? body.massKg / combined.mass : 1;
  return {
    mass: combined.mass * scale,
    centerOfMass: combined.centerOfMass.map((c) => c * metres) as unknown as Vec3,
    inertia: combined.inertia.map((value) => value * scale * metres * metres) as unknown as InertiaTensor,
  };
}

function unitAxis(axis: Vec3): Vec3 {
  const length = Math.hypot(axis[0], axis[1], axis[2]);
  return [axis[0] / length, axis[1] / length, axis[2] / length];
}

/** Joint speeds at t = 0: each driven joint left at 0 starts at ratio × its driver (else the gear constraint would jerk it). */
function initialVelocities(dynamics: DynamicsModel): Record<string, number> {
  const speeds: Record<string, number> = Object.fromEntries(Object.values(dynamics.joints).map((j) => [j.id, j.initialVelocity]));
  const gears = Object.values(dynamics.gears);
  for (let pass = 0; pass < gears.length; pass++)
    for (const gear of gears) {
      const driver = speeds[gear.driver] ?? 0;
      if (dynamics.joints[gear.driven]?.initialVelocity === 0 && driver !== 0) speeds[gear.driven] = gear.ratio * driver;
    }
  return speeds;
}

/** Bodies ordered parent before child; error on a joint cycle. */
function treeOrder(bodies: readonly RigidBody[], jointOfChild: ReadonlyMap<string, DynamicJoint>): RigidBody[] | { error: string } {
  const ordered: RigidBody[] = [];
  const placed = new Set<string>();
  let remaining = [...bodies];
  while (remaining.length > 0) {
    const ready = remaining.filter((body) => {
      const parent = jointOfChild.get(body.id)?.parent;
      return parent === undefined || parent === GROUND || placed.has(parent);
    });
    if (ready.length === 0) return { error: `joint loop through bodies ${remaining.map((b) => `'${b.id}'`).join(', ')}` };
    for (const body of ready) placed.add(body.id);
    ordered.push(...ready);
    remaining = remaining.filter((body) => !placed.has(body.id));
  }
  return ordered;
}

/** Moment of inertia (kg·m²) about `joint`'s axis of every body carried by it (its child and that child's descendants). */
function inertiaAboutJoint(bodies: readonly SimulationBody[], joint: SimulationJoint): number {
  const carried = new Set<string>();
  for (const body of bodies)
    if (body.joint?.id === joint.id || (body.parentId !== null && carried.has(body.parentId))) carried.add(body.id);
  const [ax, ay, az] = joint.axis;
  return bodies
    .filter((body) => carried.has(body.id))
    .reduce((total, body) => {
      const [ixx, iyy, izz, ixy, ixz, iyz] = body.inertia;
      const own = ixx * ax * ax + iyy * ay * ay + izz * az * az + 2 * (ixy * ax * ay + ixz * ax * az + iyz * ay * az);
      const d = [0, 1, 2].map((i) => (body.centerOfMass[i] ?? 0) - (joint.anchor[i] ?? 0));
      const along = (d[0] ?? 0) * ax + (d[1] ?? 0) * ay + (d[2] ?? 0) * az;
      const offsetSquared = d.reduce((sum, value) => sum + value * value, 0) - along * along;
      return total + own + body.mass * Math.max(0, offsetSquared);
    }, 0);
}

/** First reference from a gear / motor / propeller to a joint that cannot move (missing, or on a fixed body). */
function danglingReference(dynamics: DynamicsModel, movable: ReadonlySet<string>): string | null {
  for (const gear of Object.values(dynamics.gears))
    for (const joint of [gear.driver, gear.driven])
      if (!movable.has(joint)) return `gear '${gear.id}' uses joint '${joint}', which cannot move`;
  for (const load of [...Object.values(dynamics.motors), ...Object.values(dynamics.propellers)])
    if (!movable.has(load.joint)) return `'${load.id}' acts on joint '${load.joint}', which cannot move`;
  return null;
}

/** The simulation model of the document's dynamics at integration step `timestep` (s), or the first problem that prevents simulating it. */
export function buildSimulationModel(
  doc: CadDocument,
  timestep: number,
): { model: SimulationModel; mass: Record<string, BodyMassProperties> } | { error: string } {
  const dynamics = doc.dynamics;
  if (dynamics === undefined || Object.keys(dynamics.bodies).length === 0) return { error: 'no rigid bodies (add_rigid_body first)' };
  const metres = toMetres(doc, 1);
  const jointOfChild = new Map(Object.values(dynamics.joints).map((joint) => [joint.child, joint]));
  const order = treeOrder(Object.values(dynamics.bodies), jointOfChild);
  if ('error' in order) return order;
  const speeds = initialVelocities(dynamics);
  const mass: Record<string, BodyMassProperties> = {};
  const bodies: SimulationBody[] = [];
  for (const body of order) {
    const props = bodyMassProperties(doc, body);
    if ('error' in props) return props;
    mass[body.id] = props;
    const joint = body.fixed ? undefined : jointOfChild.get(body.id);
    const simulationJoint: SimulationJoint | null =
      joint === undefined
        ? null
        : {
            id: joint.id,
            kind: joint.kind,
            anchor: joint.anchor.map((c) => c * metres) as unknown as Vec3,
            axis: unitAxis(joint.axis),
            damping: joint.damping,
            friction: joint.friction,
            initialVelocity: speeds[joint.id] ?? 0,
          };
    const parent = joint?.parent;
    bodies.push({
      id: body.id,
      parentId: parent === undefined || parent === GROUND ? null : parent,
      mass: props.mass,
      centerOfMass: props.centerOfMass,
      inertia: props.inertia,
      joint: simulationJoint,
      fixed: body.fixed,
    });
  }
  const simulated = new Map(bodies.flatMap((body) => (body.joint === null ? [] : [[body.joint.id, body.joint] as const])));
  const dangling = danglingReference(dynamics, new Set(simulated.keys()));
  if (dangling !== null) return { error: dangling };
  const servos: SimulationServo[] = Object.values(dynamics.motors).flatMap((motor) => {
    const joint = simulated.get(motor.joint);
    if (motor.kind !== 'speed' || joint === undefined) return [];
    const gains = speedServoGains(inertiaAboutJoint(bodies, joint), timestep);
    return [{ id: motor.id, joint: motor.joint, targetVelocity: motor.rpm * RAD_PER_S_PER_RPM, ...gains, maxForce: motor.maxTorque }];
  });
  const bodyOfJoint = Object.fromEntries(Object.values(dynamics.joints).map((joint) => [joint.id, joint.child]));
  const loads = appliedLoadsFor(Object.values(dynamics.motors), Object.values(dynamics.propellers), bodyOfJoint);
  return { model: { gravity: dynamics.gravity, bodies, gears: Object.values(dynamics.gears), servos, loads }, mass };
}
