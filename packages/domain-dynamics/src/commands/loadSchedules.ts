/** add_load_schedule: a profile (or constant) applied as a force on a body or the generalised force of a joint. */

import type { CommandResult } from '@core/commands/types';
import { defineCommand, vec3, z } from '@core/commands/schema';
import { changed, codedRejection, failer } from '@core/commands/noop';
import { compileProfile, isProfileRefusal, profileUnitScale } from '@core/geometry/motionProfile';
import { idTakenInDynamicsOrFlight } from '../flight/model';
import type { LoadSchedule } from '@core/model/transmissions';
import { idOrNext } from '@lib/explicitId';
import { dynamicsOf, withDynamics } from './bodies';

/**
 * @affects adds 1 load schedule to doc.dynamics.loadSchedules (affected: [loadId])
 * @invariant exactly one target (a non-fixed body, or a revolute / prismatic joint); a joint load is a torque on a revolute and a force on a prismatic joint;
 *   a body load is a force with a non-zero world direction; the profile exists, compiles and has the load's quantity (torque / force)
 * @failure unknown / fixed target, both or neither target, wrong kind for the joint, missing direction, neither profile nor constant, wrong profile quantity -> no-op
 *   (profile problems DRV_PROFILE_INVALID); taken id -> no-op
 */
export const addLoadSchedule = defineCommand({
  name: 'add_load_schedule',
  description:
    'Apply a time-varying (or constant) load in simulate_motion: a FORCE on a rigid body (world axes, at its centre of mass, `direction` any non-zero vector) or the generalised force of a ' +
    'joint (`kind` "torque" on a revolute joint, N·m; "force" on a prismatic joint, N, positive along the joint axis by the right-hand rule). The value is the `profile` ' +
    '(add_motion_profile with quantity "torque" or "force", evaluated at the step midpoint) or the `constant`. Typical use: a payload force on a screw or a gear train, a torque ' +
    'disturbance, a force ramp for a breakaway test. The work of the load counts as external work in the energy ledger. Returns the load id in affected[0].',
  params: z.object({
    body: z.string().optional().describe('Id of the (non-fixed) rigid body to push; give this OR `joint`.'),
    joint: z.string().optional().describe('Id of the revolute / prismatic joint to load; give this OR `body`.'),
    kind: z.enum(['force', 'torque']).describe('"force" (N: body, or prismatic joint) or "torque" (N·m: revolute joint).'),
    direction: vec3(
      'World direction of a body force (non-zero, need not be unit), e.g. [0, 0, -1]. Required for a body, ignored for a joint.',
    ).optional(),
    profile: z.string().optional().describe('Id of a profile of quantity "force" / "torque" (add_motion_profile); the value over time.'),
    constant: z.number().optional().describe('Constant value in N or N·m, used when there is no profile (negative reverses).'),
    id: z.string().optional().describe('Optional explicit load id.'),
  }),
  run: (doc, params): CommandResult => {
    const fail = failer(doc, 'add_load_schedule');
    const dynamics = dynamicsOf(doc);
    if ((params.body === undefined) === (params.joint === undefined)) return fail('give exactly one of `body` or `joint`');
    if (params.profile === undefined && params.constant === undefined) return fail('give a `profile` or a `constant`');
    if (params.constant !== undefined && !Number.isFinite(params.constant)) return fail('constant must be finite');
    let direction: LoadSchedule['direction'];
    if (params.body !== undefined) {
      const body = dynamics.bodies[params.body];
      if (body === undefined) return fail(`body '${params.body}' not found`);
      if (body.fixed) return fail(`body '${params.body}' is fixed to the ground: a force on it does nothing`);
      if (params.kind !== 'force') return fail('a body takes a force (kind "force"); use `joint` for a torque');
      if (params.direction === undefined || !(Math.hypot(...params.direction) > 0))
        return fail('a body force needs a non-zero `direction`');
      direction = params.direction;
    } else {
      const joint = dynamics.joints[params.joint ?? ''];
      if (joint === undefined) return fail(`joint '${params.joint}' not found`);
      if (joint.kind === 'spherical') return fail(`joint '${joint.id}' is spherical: it has no coordinate to load`);
      if ((joint.kind === 'revolute') !== (params.kind === 'torque'))
        return fail(`${joint.kind} joint '${joint.id}' takes a ${joint.kind === 'revolute' ? 'torque' : 'force'}, not a ${params.kind}`);
    }
    if (params.profile !== undefined) {
      const stored = dynamics.profiles?.[params.profile];
      if (stored === undefined)
        return codedRejection(
          doc,
          'add_load_schedule',
          'DRV_PROFILE_INVALID',
          `profile '${params.profile}' not found`,
          'Create it with add_motion_profile (quantity "force" or "torque").',
        );
      const compiled = compileProfile(stored);
      if (stored.quantity !== params.kind || isProfileRefusal(compiled) || profileUnitScale(stored.quantity, stored.unit) === null)
        return codedRejection(
          doc,
          'add_load_schedule',
          'DRV_PROFILE_INVALID',
          `profile '${stored.id}' is a ${stored.quantity} profile, a ${params.kind} load needs a ${params.kind} profile`,
          'Create a profile with quantity "force" (N) or "torque" (N·m) with add_motion_profile.',
          [stored.id],
        );
    }
    const id = idOrNext(params.id, 'load');
    if (idTakenInDynamicsOrFlight(doc, id)) return fail(`id '${id}' is already used`);
    const load: LoadSchedule = {
      id,
      target: params.body !== undefined ? { body: params.body } : { joint: params.joint ?? '' },
      kind: params.kind,
      ...(direction === undefined ? {} : { direction }),
      ...(params.profile === undefined ? {} : { profile: params.profile }),
      ...(params.constant === undefined ? {} : { constant: params.constant }),
    };
    return changed(
      withDynamics(doc, { ...dynamics, loadSchedules: { ...dynamics.loadSchedules, [id]: load } }),
      `add_load_schedule: '${id}' — ${params.kind} on ${params.body !== undefined ? `body '${params.body}'` : `joint '${params.joint}'`}, ` +
        `${params.profile === undefined ? `constant ${params.constant}` : `profile '${params.profile}'`}.`,
      [id],
    );
  },
});
