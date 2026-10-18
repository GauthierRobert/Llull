/** Rigid bodies of the dynamics model, gravity, and removal of any dynamics record. */

import type { CadDocument } from '../../model/types';
import { createDynamicsModel, type DynamicsModel } from '../../model/dynamics';
import { is3D } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { idOrNext, idTaken } from '../entity/explicitId';
import { changed, failer, report } from '../noop';
import { bodyMassProperties } from '../../dynamics/simulationModel';
import { formatLength } from '../document/units';
import { toMetres } from '../../model/units';

/** The document's dynamics model (empty when absent). */
export function dynamicsOf(doc: CadDocument): DynamicsModel {
  return doc.dynamics ?? createDynamicsModel();
}

export function withDynamics(doc: CadDocument, dynamics: DynamicsModel): CadDocument {
  return { ...doc, dynamics };
}

/** Every id used by any dynamics record (bodies, joints, gears, motors, propellers, cylinders share one id space). */
export function dynamicsIdTaken(dynamics: DynamicsModel, id: string): boolean {
  return [
    dynamics.bodies,
    dynamics.joints,
    dynamics.gears,
    dynamics.motors,
    dynamics.propellers,
    dynamics.cylinders ?? {},
    dynamics.springs ?? {},
  ].some((table) => idTaken(table, id));
}

/**
 * @affects adds 1 rigid body to doc.dynamics (affected: [bodyId])
 * @invariant every entity id exists, is 3D and belongs to no other body
 * @failure empty / unknown / 2D / already-used entity, taken id, non-positive density or mass -> no-op
 */
export const addRigidBody = defineCommand({
  name: 'add_rigid_body',
  description:
    'Make a set of 3D entities move together as ONE rigid body for physics simulation (simulate_motion). Mass, centre of mass and ' +
    "inertia are computed from the entities' real geometry: each entity uses its assigned material (density model, else plain density), else `density` (kg/m³, " +
    'default 7850 steel; aluminium 2700, wood 600, CFRP 1550). Give `massKg` when the real part mass is known (hollow parts): the ' +
    'distribution is scaled to it. `fixed: true` welds the body to the ground (engine block, frame, stand). A non-fixed body with no ' +
    'joint is a free body that falls under gravity. Next: connect bodies with add_body_joint. Returns the body id in affected[0] and ' +
    'its mass / centre of mass in the summary.',
  params: z.object({
    entityIds: z.array(z.string()).min(1).describe('Ids of the 3D entities forming the body (e.g. a propeller: hub + 3 blades + spinner).'),
    name: z.string().optional().describe('Display name, e.g. "propeller", "crankshaft".'),
    fixed: z.boolean().optional().describe('true = welded to the ground (never moves). Default false.'),
    density: z.number().positive().optional().describe('kg/m³ for entities without a material. Default 7850 (steel).'),
    massKg: z.number().positive().optional().describe('Known real mass in kg; the computed mass distribution is scaled to it.'),
    id: z.string().optional().describe('Optional explicit body id (shares the id space of all dynamics records).'),
  }),
  run: (doc, { entityIds, name, fixed, density, massKg, id }, ctx): CommandResult => {
    const fail = failer(doc, 'add_rigid_body');
    const dynamics = dynamicsOf(doc);
    const owners = new Map(Object.values(dynamics.bodies).flatMap((body) => body.entityIds.map((e) => [e, body.id] as const)));
    for (const entityId of entityIds) {
      const entity = doc.entities[entityId];
      if (entity === undefined) return fail(`entity '${entityId}' not found`);
      if (!is3D(entity) && entity.kind !== 'instance') return fail(`entity '${entityId}' is 2D (${entity.kind}); bodies need solids`);
      const owner = owners.get(entityId);
      if (owner !== undefined) return fail(`entity '${entityId}' already belongs to body '${owner}'`);
    }
    if (new Set(entityIds).size !== entityIds.length) return fail('entityIds lists an entity twice');
    const bodyId = idOrNext(id, 'body');
    if (dynamicsIdTaken(dynamics, bodyId)) return fail(`id '${bodyId}' is already used`);
    const body = {
      id: bodyId,
      entityIds,
      fixed: fixed ?? false,
      ...(name !== undefined ? { name } : {}),
      ...(density !== undefined ? { density } : {}),
      ...(massKg !== undefined ? { massKg } : {}),
    };
    const props = bodyMassProperties(doc, body, ctx?.kernel);
    if ('error' in props) return fail(props.error);
    const next = withDynamics(doc, { ...dynamics, bodies: { ...dynamics.bodies, [bodyId]: body } });
    const center = props.centerOfMass.map((c) => formatLength(doc, c / toMetres(doc, 1))).join(', ');
    return changed(
      next,
      `add_rigid_body: '${bodyId}'${name !== undefined ? ` (${name})` : ''} — ${entityIds.length} entit${entityIds.length === 1 ? 'y' : 'ies'}, ` +
        `${props.mass.toPrecision(4)} kg, centre of mass [${center}]${body.fixed ? ', fixed to ground' : ''}.`,
      [bodyId],
    );
  },
});

/**
 * @affects sets doc.dynamics.gravity
 * @failure none (any finite vector, [0,0,0] = weightless)
 */
export const setGravity = defineCommand({
  name: 'set_gravity',
  annotations: { idempotent: true },
  description:
    'Set the gravity vector of the physics simulation in m/s², world axes. Default [0, 0, -9.81] (Z up, Earth). [0, 0, 0] = weightless ' +
    '(isolates a mechanism from its own weight); [0, 0, -1.62] = Moon.',
  params: z.object({ gravity: vec3('Gravity acceleration [x, y, z] in m/s².') }),
  run: (doc, { gravity }): CommandResult => {
    const dynamics = dynamicsOf(doc);
    return report(withDynamics(doc, { ...dynamics, gravity }), `set_gravity: [${gravity.join(', ')}] m/s².`);
  },
});

/**
 * @affects removes 1 dynamics record; removing a body also removes its joints and springs, and removing a joint its gears, motors and propellers
 * @failure unknown id -> no-op
 */
export const deleteDynamicsItem = defineCommand({
  name: 'delete_dynamics_item',
  annotations: { destructive: true },
  description:
    'Remove a rigid body, joint, gear coupling, motor, propeller, cylinder pressure or point spring (add_spring) from the physics model by id. Cascades: a body ' +
    'takes its joints and springs with it; a joint takes the gears, motors, propellers and cylinder pressures on it. Entities (geometry) are never deleted.',
  params: z.object({ id: z.string().describe('Id of the body / joint / gear / motor / propeller / cylinder / spring to remove.') }),
  run: (doc, { id }): CommandResult => {
    const dynamics = dynamicsOf(doc);
    if (!dynamicsIdTaken(dynamics, id)) return failer(doc, 'delete_dynamics_item')(`no dynamics record '${id}'`);
    const keep = <T>(table: Record<string, T>, drop: (key: string, value: T) => boolean): Record<string, T> =>
      Object.fromEntries(Object.entries(table).filter(([key, value]) => !drop(key, value)));
    const joints = keep(dynamics.joints, (key, joint) => key === id || joint.parent === id || joint.child === id);
    const goneJoint = (joint: string): boolean => joints[joint] === undefined;
    const next: DynamicsModel = {
      ...dynamics,
      bodies: keep(dynamics.bodies, (key) => key === id),
      joints,
      gears: keep(dynamics.gears, (key, gear) => key === id || goneJoint(gear.driver) || goneJoint(gear.driven)),
      motors: keep(dynamics.motors, (key, motor) => key === id || goneJoint(motor.joint)),
      propellers: keep(dynamics.propellers, (key, propeller) => key === id || goneJoint(propeller.joint)),
      ...(dynamics.cylinders === undefined
        ? {}
        : { cylinders: keep(dynamics.cylinders, (key, cyl) => key === id || goneJoint(cyl.piston) || goneJoint(cyl.crank)) }),
      ...(dynamics.springs === undefined
        ? {}
        : { springs: keep(dynamics.springs, (key, spring) => key === id || spring.bodyA === id || spring.bodyB === id) }),
    };
    const removed = (['bodies', 'joints', 'gears', 'motors', 'propellers', 'cylinders', 'springs'] as const)
      .map((table) => Object.keys(dynamics[table] ?? {}).length - Object.keys(next[table] ?? {}).length)
      .reduce((a, b) => a + b, 0);
    return report(
      withDynamics(doc, next),
      `delete_dynamics_item: removed '${id}'${removed > 1 ? ` and ${removed - 1} dependent record(s)` : ''}.`,
    );
  },
});
