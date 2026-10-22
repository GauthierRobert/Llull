/** Point-to-point spring-dampers between rigid bodies. */

import { GROUND, type PointSpring } from '@core/model/dynamics';
import { toMetres } from '@core/model/units';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, vec3, z } from '@core/commands/schema';
import { idOrNext } from '@lib/explicitId';
import { changed, failer } from '@core/commands/noop';
import { bodyMassProperties } from '@core/geometry/bodyMassProperties';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { CadDocument, Vec3 } from '@core/model/types';
import { dynamicsIdTaken, dynamicsOf, withDynamics } from './bodies';

/** Attachment points closer than this (m) have no direction for the spring force. */
const MIN_LENGTH_M = 1e-6;

/** World point of a spring end: `point` itself, or (frame "body") `point` as an offset from the body's centre of mass; else an error. */
function worldPoint(
  doc: CadDocument,
  bodyId: string,
  point: Vec3,
  frame: 'world' | 'body',
  kernel: GeometryKernel | null | undefined,
): Vec3 | { error: string } {
  const body = doc.dynamics?.bodies[bodyId];
  if (frame === 'world' || body === undefined) return point;
  const props = bodyMassProperties(doc, body, kernel);
  if ('error' in props) return props;
  const metres = toMetres(doc, 1);
  return [props.centerOfMass[0] / metres + point[0], props.centerOfMass[1] / metres + point[1], props.centerOfMass[2] / metres + point[2]];
}

/**
 * @affects adds 1 point spring to doc.dynamics (affected: [springId])
 * @invariant bodyA !== bodyB, each an existing rigid body or "ground" and at least one able to move; stiffness > 0, damping >= 0; the
 *            attachment points are distinct; free length >= 0 (default and preload both resolve to freeLengthM at the modelled pose);
 *            pointA / pointB are stored as world points whatever pointFrame was given
 * @failure unknown body, same body twice, both ends fixed / ground, coincident points, freeLengthMm with preloadN, preload that needs a
 *          negative free length, non-positive stiffness, taken id -> no-op
 */
export const addSpring = defineCommand({
  name: 'add_spring',
  description:
    'Add a spring-damper force element (physics, for simulate_motion; NOT the add_coil solid geometry) between a point on one rigid body and a point on another body or the ground, for simulate_motion ' +
    '(a coil spring, a gas strut, a bungee, an engine-valve spring). Force along the line joining the two points: ' +
    'F = stiffness · (length - freeLength) + damping · d(length)/dt, positive = pulling the ends together; it works in any direction and ' +
    'for any joint arrangement (a rocker, a four-bar link, a falling body). `pointA` / `pointB` are WORLD points in DOCUMENT units at the ' +
    'pose the bodies are modelled in (where the spring physically attaches); each then rides on its body. With pointFrame "body" they are ' +
    "instead OFFSETS from each body's centre of mass (world axes, document units; a ground end stays a world point), e.g. [0, 0, 50] = 50 units above it. " +
    '`bodyA` / `bodyB` are rigid ' +
    'body ids (add_rigid_body) or "ground". Stiffness in N/m (1 N/mm = 1000 N/m), damping in N·s/m. The spring is relaxed at ' +
    '`freeLengthMm` (mm); by default that is the distance between the points at the modelled pose (no force at the start). `preloadN` ' +
    'instead sets the tension force at the modelled pose (positive = stretched, pulling together; negative = compressed, pushing apart), ' +
    'which fixes the free length = distance - preloadN / stiffness; give at most one of the two. Spring energy is part of the potential ' +
    "energy of simulate_motion (energy: true), and simulate_motion reports each spring's length range and force (data.springs); " +
    'render_motion draws it as a zig-zag. Mass on a spring: period 2π·sqrt(m/k), static deflection m·g/k. Remove with delete_dynamics_item ' +
    '(also removed when either body is). Returns the spring id in affected[0].',
  params: z.object({
    bodyA: z.string().describe('Rigid body id carrying the first end, or "ground".'),
    bodyB: z.string().describe('Rigid body id carrying the second end, or "ground".'),
    pointA: vec3('World point of the first end at the modelled pose, document units.'),
    pointB: vec3('World point of the second end at the modelled pose, document units. Must differ from pointA.'),
    pointFrame: z
      .enum(['world', 'body'])
      .optional()
      .describe(
        '"world" (default): pointA / pointB are world points. "body": each is an offset from its body\'s centre of mass, world axes, ' +
          'document units (a ground end stays a world point).',
      ),
    stiffness: z.number().positive().describe('Spring rate in N/m (1 N/mm = 1000 N/m). Must be > 0.'),
    damping: z.number().min(0).optional().describe('Viscous damping along the spring in N·s/m. Default 0.'),
    freeLengthMm: z
      .number()
      .min(0)
      .optional()
      .describe('Length in mm at which the spring force is zero. Default: the distance between pointA and pointB (relaxed at the start).'),
    preloadN: z
      .number()
      .optional()
      .describe(
        'Alternative to freeLengthMm: tension force in N at the modelled pose (positive = stretched, pulling together; negative = compressed). Default 0.',
      ),
    id: z.string().optional().describe('Optional explicit spring id (shares the id space of all dynamics records).'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const fail = failer(doc, 'add_spring');
    const dynamics = dynamicsOf(doc);
    const ends = [params.bodyA, params.bodyB];
    const unknown = ends.find((end) => end !== GROUND && dynamics.bodies[end] === undefined);
    if (unknown !== undefined) return fail(`body '${unknown}' not found (add_rigid_body first, or use "${GROUND}")`);
    if (params.bodyA === params.bodyB) return fail(`both ends are on '${params.bodyA}': a spring joins two different bodies`);
    if (ends.every((end) => end === GROUND || dynamics.bodies[end]?.fixed === true))
      return fail('both ends are on the ground or on fixed bodies: the spring could not move anything');
    if (params.freeLengthMm !== undefined && params.preloadN !== undefined) return fail('give freeLengthMm or preloadN, not both');
    const frame = params.pointFrame ?? 'world';
    const pointA = worldPoint(doc, params.bodyA, params.pointA, frame, ctx?.kernel);
    if ('error' in pointA) return fail(pointA.error);
    const pointB = worldPoint(doc, params.bodyB, params.pointB, frame, ctx?.kernel);
    if ('error' in pointB) return fail(pointB.error);
    const metres = toMetres(doc, 1);
    const distance = Math.hypot(...pointA.map((c, i) => c - (pointB[i] ?? 0))) * metres;
    if (distance < MIN_LENGTH_M) return fail('pointA and pointB coincide: the spring needs two distinct attachment points');
    const freeLengthM =
      params.freeLengthMm !== undefined ? params.freeLengthMm / 1000 : distance - (params.preloadN ?? 0) / params.stiffness;
    if (freeLengthM < 0)
      return fail(
        `preloadN ${params.preloadN} N at ${params.stiffness} N/m would need a negative free length (distance ${distance * 1000} mm)`,
      );
    const springId = idOrNext(params.id, 'spring');
    if (dynamicsIdTaken(dynamics, springId)) return fail(`id '${springId}' is already used`);
    const spring: PointSpring = {
      id: springId,
      bodyA: params.bodyA,
      bodyB: params.bodyB,
      pointA,
      pointB,
      stiffness: params.stiffness,
      damping: params.damping ?? 0,
      freeLengthM,
    };
    const force = params.stiffness * (distance - freeLengthM);
    return changed(
      withDynamics(doc, { ...dynamics, springs: { ...dynamics.springs, [springId]: spring } }),
      `add_spring: '${springId}' — '${params.bodyA}' to '${params.bodyB}', ${params.stiffness} N/m, damping ${spring.damping} N·s/m, ` +
        `free length ${+(freeLengthM * 1000).toPrecision(6)} mm, length at the modelled pose ${+(distance * 1000).toPrecision(6)} mm, ` +
        `force there ${+force.toPrecision(5)} N (${force >= 0 ? 'pulling together' : 'pushing apart'}).`,
      [springId],
    );
  },
});
