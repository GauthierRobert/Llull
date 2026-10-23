/** bend_body — bend a straight region of a solid onto a circular arc about an axis (01 DEF M1, FR-DEF-05). */

import { defineCommand, vec3, z } from '../schema';
import type { CommandResult } from '../types';
import { idParam, outputParam } from './schema';
import { type DeformPlan, runDeform } from './run';
import { type Refusal, extentWithin, resolveRegion, resolveTargetFrame } from './target';

/** A full turn: a larger bend overlaps itself. */
const FULL_TURN = 2 * Math.PI;

/**
 * @affects replaces the entity by a mesh entity whose brep recipe is a deform node with a bend law
 * @invariant the neutral fibre (the frame origin plane y = 0) keeps its length; det J = (R − y)/R inside the region, the body past the region end
 *   follows rigidly; a cylinder bent on its own axis is a torus segment; kernel-optional: mesh path today
 * @failure not exactly two of radius / angleDeg / length|region -> DEF_BEND_UNDERDETERMINED / DEF_BEND_OVERDETERMINED; radius <= the inner-side distance -> DEF_BEND_RADIUS_TOO_SMALL; angle >= 360 or a tail that hits the body -> DEF_SELF_INTERSECTION; angle <= 0 -> DEF_NO_EFFECT
 */
export const bendBody = defineCommand({
  name: 'bend_body',
  annotations: { readsMeshTriangles: true },
  description:
    'Bend a straight region of a 3D solid or mesh onto a circular arc (a bar becomes an arc, a cylinder a torus segment). Give exactly TWO of: radius ' +
    '(document units, of the neutral fibre), angleDeg (degrees, 0 < angle < 360, how far the region turns) and length (document units, the straight region length; ' +
    'or region.start and region.end, which gives the same). The neutral fibre is the plane through frame.origin perpendicular to frame.reference: its length is ' +
    'kept (radius x angle = length); material toward the centre of curvature (frame.reference direction) is shortened by (R - y)/R and material away from it is lengthened. ' +
    'The bend axis is perpendicular to both the frame axis and frame.reference and passes through the point radius away from the origin along frame.reference; the bend direction is set by frame.reference ' +
    '(it points toward the centre of curvature). The frame origin defaults to the centre of the face where the body starts along the axis, the axis to the longest ' +
    'bounding-box direction and the reference to the next longest. The part of the body past the region follows the bent end rigidly. symmetric true keeps the middle ' +
    'of the region in place and bends both halves away from it. Volume changes by Pappus: V x (1 - mean offset / R). ' +
    'The result replaces the entity as a mesh entity that keeps the construction (brep recipe). ' +
    'Refuses radius <= the distance from the neutral fibre to the body on the centre side (DEF_BEND_RADIUS_TOO_SMALL), 360 degrees or more, or a straight part that would hit the bent body (DEF_SELF_INTERSECTION) ' +
    'and not exactly two of radius / angleDeg / length (DEF_BEND_UNDERDETERMINED / DEF_BEND_OVERDETERMINED). Then call analyze_deformation (fibre lengths) and check_deformation.',
  params: z.object({
    id: idParam,
    radius: z
      .number()
      .describe('Bend radius of the neutral fibre, document units, > 0 (must exceed the body extent on the centre side).')
      .optional(),
    angleDeg: z.number().describe('Angle the region turns, degrees, > 0 and less than 360.').optional(),
    length: z
      .number()
      .describe(
        'Length of the bent region along the axis, document units, > 0 (the neutral fibre length). The region starts at region.start, default where the body starts.',
      )
      .optional(),
    region: z
      .object({
        start: z
          .number()
          .describe('Where the bend starts along the axis, document units from the frame origin. Default: where the body starts.')
          .optional(),
        end: z
          .number()
          .describe('Where the bend ends along the axis, document units from the frame origin; with start this fixes the length.')
          .optional(),
      })
      .describe('Bent region along the axis; giving both start and end counts as giving length.')
      .optional(),
    symmetric: z
      .boolean()
      .describe('true: keep the middle of the region in place and bend both halves away from it. Default false (the region start stays).')
      .optional(),
    frame: z
      .object({
        origin: vec3(
          'A point of the neutral fibre, world document units. Default: the centre of the face where the body starts along the axis (the neutral fibre passes through the body centre line).',
        ).optional(),
        axis: vec3(
          'Direction the straight region runs along, unitless (normalised). Default: the longest bounding-box direction.',
        ).optional(),
        reference: vec3(
          'Direction toward the centre of curvature, unitless; its component perpendicular to the axis is used and the bend turns toward it. Default: the next longest bounding-box direction.',
        ).optional(),
      })
      .describe('Bend frame; every field defaults from the body bounds and the defaults used are reported in data.frame.')
      .optional(),
    output: outputParam.optional(),
  }),
  run: (doc, { id, radius, angleDeg, length, region, symmetric, frame, output }, ctx): CommandResult =>
    runDeform(doc, ctx, {
      command: 'bend_body',
      id,
      verb: 'bent',
      output,
      plan: (target): DeformPlan | Refusal => {
        const fromRegion = region?.start !== undefined && region.end !== undefined ? region.end - region.start : undefined;
        const given = [radius, angleDeg, length ?? fromRegion].filter((value) => value !== undefined).length;
        const both = length !== undefined && fromRegion !== undefined;
        if (given < 2 && !both)
          return {
            code: 'DEF_BEND_UNDERDETERMINED',
            message: 'give exactly two of radius, angleDeg and length (or region)',
            paths: ['params'],
          };
        if (given > 2 || both)
          return {
            code: 'DEF_BEND_OVERDETERMINED',
            message: 'give exactly two of radius, angleDeg and length (or region)',
            paths: ['params'],
          };
        if (angleDeg !== undefined && !(angleDeg > 0))
          return {
            code: 'DEF_NO_EFFECT',
            message: `angleDeg ${angleDeg} must be > 0 (the bend direction comes from frame.reference)`,
            paths: ['params.angleDeg'],
          };
        const span = length ?? fromRegion;
        if (span !== undefined && !(span > 0))
          return { code: 'DEF_REGION_INVALID', message: `length ${span} must be > 0`, paths: ['params.length'] };
        if (radius !== undefined && !(radius > 0))
          return { code: 'DEF_BEND_RADIUS_TOO_SMALL', message: `radius ${radius} must be > 0`, paths: ['params.radius'] };
        const theta = angleDeg === undefined ? undefined : (angleDeg * Math.PI) / 180;
        const bendRadius = radius ?? (span as number) / (theta as number);
        const regionLength = span ?? bendRadius * (theta as number);
        if (regionLength / bendRadius >= FULL_TURN - 1e-9)
          return {
            code: 'DEF_SELF_INTERSECTION',
            message: `the bend turns ${((regionLength / bendRadius) * 180) / Math.PI} degrees (must be < 360): its ends overlap`,
            paths: ['params'],
          };
        const resolved = resolveTargetFrame(target, frame, 'start', 'y');
        if ('code' in resolved) return resolved;
        const start = region?.start ?? resolved.extent.min[2];
        const bendRegion = resolveRegion(resolved.extent, { start, end: start + regionLength, falloff: 'linear' }, 'linear');
        if ('code' in bendRegion) return bendRegion;
        const bentExtent = extentWithin(target, resolved.frame, bendRegion.start, bendRegion.end, resolved.extent);
        return {
          law: { kind: 'bend', radius: bendRadius, symmetric: symmetric === true },
          frame: resolved.frame,
          region: bendRegion,
          extent: bentExtent,
          checkOverlap:
            regionLength / bendRadius >= Math.PI / 2 &&
            (resolved.extent.min[2] < bendRegion.start || resolved.extent.max[2] > bendRegion.end),
          defaulted: resolved.defaulted,
        };
      },
    }),
});
