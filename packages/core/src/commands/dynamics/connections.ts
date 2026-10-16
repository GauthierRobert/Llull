/** Joints between rigid bodies and gear couplings between joints. */

import { GROUND, type DynamicJoint, type DynamicsModel } from '../../model/dynamics';
import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { idOrNext } from '../entity/explicitId';
import { changed, failer } from '../noop';
import { dynamicsIdTaken, dynamicsOf, withDynamics } from './bodies';

const RAD_PER_S_PER_RPM = (2 * Math.PI) / 60;

/** True when `ancestor` is `body` or above it in the joint tree. */
function isAncestor(dynamics: DynamicsModel, ancestor: string, body: string): boolean {
  const parentOf = new Map(Object.values(dynamics.joints).map((joint) => [joint.child, joint.parent]));
  for (let current: string | undefined = body, guard = 0; current !== undefined && guard <= parentOf.size; guard++) {
    if (current === ancestor) return true;
    current = parentOf.get(current);
  }
  return false;
}

/**
 * @affects adds 1 joint to doc.dynamics (affected: [jointId])
 * @invariant child is an existing non-fixed body with no joint yet; parent is GROUND or another body; no loop; axis non-zero
 * @failure unknown / fixed / already-jointed child, unknown parent, loop, zero axis, taken id -> no-op
 */
export const addBodyJoint = defineCommand({
  name: 'add_body_joint',
  description:
    'Connect a rigid body (child) to the ground or to another body (parent) with ONE degree of freedom, for simulate_motion. ' +
    '"revolute": the child spins about `axis` through `anchor` (a shaft in its bearings, a propeller hub, a crank pin, a hinge). ' +
    '"prismatic": the child slides along `axis` (a piston in its bore). `anchor` is a world point on the axis in DOCUMENT units ' +
    '(e.g. the shaft centre); `axis` a world direction (need not be unit). Each body can be the child of only one joint; parents may ' +
    'chain (ground → crank → connecting rod). Optional: damping (bearing viscous loss, N·m·s/rad), friction (dry friction torque, N·m), ' +
    'initialRpm / initialVelocity (speed at t = 0). Returns the joint id in affected[0].',
  params: z.object({
    kind: z.enum(['revolute', 'prismatic']).describe('"revolute" = rotation about the axis; "prismatic" = translation along it.'),
    child: z.string().describe('Id of the moving body.'),
    parent: z.string().optional().describe(`Body the child is mounted on, or "${GROUND}" (default) for the fixed world.`),
    anchor: vec3('World point on the joint axis, document units (e.g. the shaft centre [0, 200, 800]).'),
    axis: vec3('World direction of the axis, e.g. [0, 1, 0] for a shaft along Y.'),
    damping: z.number().min(0).optional().describe('Viscous damping: N·m·s/rad (revolute) or N·s/m (prismatic). Default 0.'),
    friction: z.number().min(0).optional().describe('Dry friction: N·m (revolute) or N (prismatic). Default 0.'),
    initialRpm: z.number().optional().describe('Revolute only: speed at t = 0 in rpm (overrides initialVelocity).'),
    initialVelocity: z.number().optional().describe('Speed at t = 0: rad/s (revolute) or m/s (prismatic). Default 0.'),
    id: z.string().optional().describe('Optional explicit joint id.'),
  }),
  run: (doc, params): CommandResult => {
    const fail = failer(doc, 'add_body_joint');
    const dynamics = dynamicsOf(doc);
    const parent = params.parent ?? GROUND;
    const child = dynamics.bodies[params.child];
    if (child === undefined) return fail(`child body '${params.child}' not found (add_rigid_body first)`);
    if (child.fixed) return fail(`body '${child.id}' is fixed to the ground and cannot move`);
    const existing = Object.values(dynamics.joints).find((joint) => joint.child === child.id);
    if (existing !== undefined) return fail(`body '${child.id}' already hangs on joint '${existing.id}' (one joint per child body)`);
    if (parent !== GROUND && dynamics.bodies[parent] === undefined) return fail(`parent body '${parent}' not found`);
    if (parent === child.id || isAncestor(dynamics, child.id, parent))
      return fail(`joining '${child.id}' to '${parent}' would close a loop`);
    if (Math.hypot(...params.axis) < 1e-12) return fail('axis must be a non-zero vector');
    const jointId = idOrNext(params.id, 'bjoint');
    if (dynamicsIdTaken(dynamics, jointId)) return fail(`id '${jointId}' is already used`);
    const initialVelocity =
      params.initialRpm !== undefined && params.kind === 'revolute' ? params.initialRpm * RAD_PER_S_PER_RPM : (params.initialVelocity ?? 0);
    const joint: DynamicJoint = {
      id: jointId,
      kind: params.kind,
      parent,
      child: child.id,
      anchor: params.anchor,
      axis: params.axis,
      damping: params.damping ?? 0,
      friction: params.friction ?? 0,
      initialVelocity,
    };
    return changed(
      withDynamics(doc, { ...dynamics, joints: { ...dynamics.joints, [jointId]: joint } }),
      `add_body_joint: ${params.kind} '${jointId}' — '${child.id}' on '${parent}', axis [${params.axis.join(', ')}] through [${params.anchor.join(', ')}].`,
      [jointId],
    );
  },
});

/**
 * @affects adds 1 gear coupling to doc.dynamics (affected: [gearId])
 * @invariant driver !== driven, both existing joints; ratio finite and non-zero; a joint is driven by at most one gear
 * @failure unknown joint, self-coupling, zero ratio, already-driven joint, circular coupling, taken id -> no-op
 */
export const addGearCoupling = defineCommand({
  name: 'add_gear_coupling',
  description:
    'Couple two joints rigidly, like meshing gears, a belt or a chain: speed(driven) = ratio × speed(driver), enforced by the physics ' +
    "engine, so each side feels the other's inertia and load. ratio = -teeth(driver)/teeth(driven) for an external spur mesh (opposite " +
    'rotation), +teeth(driver)/teeth(driven) for a belt or an internal ring gear. Planetary with fixed ring, sun → carrier: ' +
    'ratio = sunTeeth / (sunTeeth + ringTeeth). Planets relative to the carrier: -ringTeeth / planetTeeth (driver = carrier joint). ' +
    'Returns the coupling id in affected[0].',
  params: z.object({
    driver: z.string().describe('Joint id whose speed drives the other (e.g. the crankshaft joint).'),
    driven: z.string().describe('Joint id that follows (e.g. the propeller joint).'),
    ratio: z.number().describe('speed(driven) / speed(driver); negative reverses the direction.'),
    id: z.string().optional().describe('Optional explicit coupling id.'),
  }),
  run: (doc, { driver, driven, ratio, id }): CommandResult => {
    const fail = failer(doc, 'add_gear_coupling');
    const dynamics = dynamicsOf(doc);
    if (dynamics.joints[driver] === undefined) return fail(`driver joint '${driver}' not found (add_body_joint first)`);
    if (dynamics.joints[driven] === undefined) return fail(`driven joint '${driven}' not found`);
    if (driver === driven) return fail('a joint cannot drive itself');
    if (!(Math.abs(ratio) > 0) || !Number.isFinite(ratio)) return fail('ratio must be finite and non-zero');
    const twice = Object.values(dynamics.gears).find((gear) => gear.driven === driven);
    if (twice !== undefined) return fail(`joint '${driven}' is already driven by gear '${twice.id}'`);
    const driverOf = new Map(Object.values(dynamics.gears).map((gear) => [gear.driven, gear.driver]));
    for (let current: string | undefined = driver, guard = 0; current !== undefined && guard <= driverOf.size; guard++) {
      if (current === driven) return fail(`'${driven}' already drives '${driver}' through gears: the coupling would be circular`);
      current = driverOf.get(current);
    }
    const gearId = idOrNext(id, 'gear');
    if (dynamicsIdTaken(dynamics, gearId)) return fail(`id '${gearId}' is already used`);
    return changed(
      withDynamics(doc, { ...dynamics, gears: { ...dynamics.gears, [gearId]: { id: gearId, driver, driven, ratio } } }),
      `add_gear_coupling: '${gearId}' — speed(${driven}) = ${ratio} × speed(${driver}).`,
      [gearId],
    );
  },
});
