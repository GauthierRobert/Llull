/** bend_body — bend a straight region of a solid onto a circular arc about an axis (01 DEF M1, FR-DEF-05). */

import { defineCommand, vec3, z } from '../schema';
import type { CommandResult } from '../types';
import { bodyParams, infiniteParam, outputParam, targetIds } from './schema';
import type { DeformPlan } from './request';
import { runDeform } from './run';
import { type Refusal, defaultTolerance, extentWithin, resolveRegion, resolveTargetFrame } from './target';

/** A full turn: a larger bend overlaps itself. */
const FULL_TURN = 2 * Math.PI;

/**
 * @affects replaces the entity by a mesh entity whose brep recipe is a deform node with a bend law
 * @invariant region.infinite: theta = (z - start) / R at every height (no rigid straight part, no clamp; length = region length per angle, symmetric = the same arc moved so the region middle stays in place); the body must turn less than 360 degrees in all; the neutral fibre (the frame origin plane y = 0) keeps its length; det J = (R − y)/R inside the region, the body past the region end
 *   follows rigidly; a cylinder bent on its own axis is a torus segment, and a 360 degree bend of the whole body a closed torus (exact kernel only); kernel-optional: exact warp on the native kernel, mesh path otherwise
 * @failure not exactly two of radius / angleDeg / length|region -> DEF_BEND_UNDERDETERMINED / DEF_BEND_OVERDETERMINED; radius <= the inner-side distance -> DEF_BEND_RADIUS_TOO_SMALL; angle > 360, 360 with a tail or on the mesh path, or a tail that hits the body -> DEF_SELF_INTERSECTION; angle <= 0 -> DEF_NO_EFFECT
 */
export const bendBody = defineCommand({
  name: 'bend_body',
  annotations: { readsMeshTriangles: true },
  description:
    'Bend a straight region of a 3D solid or mesh onto a circular arc (a bar becomes an arc, a cylinder a torus segment). Give exactly TWO of: radius ' +
    '(document units, of the neutral fibre), angleDeg (degrees, 0 < angle <= 360, how far the region turns; exactly 360 on the whole body closes a ring and needs the native exact kernel) and length (document units, the straight region length; ' +
    'or region.start and region.end, which gives the same). The neutral fibre is the plane through frame.origin perpendicular to frame.reference: its length is ' +
    'kept (radius x angle = length); material toward the centre of curvature (frame.reference direction) is shortened by (R - y)/R and material away from it is lengthened. ' +
    'The bend axis is perpendicular to both the frame axis and frame.reference and passes through the point radius away from the origin along frame.reference; the bend direction is set by frame.reference ' +
    '(it points toward the centre of curvature). The frame origin defaults to the centre of the face where the body starts along the axis, the axis to the longest ' +
    'bounding-box direction and the reference to the next longest. The part of the body past the region follows the bent end rigidly. symmetric true keeps the middle ' +
    'of the region in place and bends both halves away from it. With region.infinite true the bend rate (angle per length) holds along the WHOLE axis: the region only fixes the rate, nothing stays straight, ' +
    'and the body is refused (DEF_SELF_INTERSECTION) when it would turn 360 degrees or more in all. Volume changes by Pappus: V x (1 - mean offset / R). ' +
    'The result replaces the entity as a mesh entity that keeps the construction (brep recipe). ' +
    'Refuses radius <= the distance from the neutral fibre to the body on the centre side (DEF_BEND_RADIUS_TOO_SMALL), more than 360 degrees, 360 with a straight part left or without the exact kernel, or a straight part that would hit the bent body (DEF_SELF_INTERSECTION) ' +
    'and not exactly two of radius / angleDeg / length (DEF_BEND_UNDERDETERMINED / DEF_BEND_OVERDETERMINED). Then call analyze_deformation (fibre lengths) and check_deformation.',
  params: z.object({
    ...bodyParams,
    radius: z
      .number()
      .describe('Bend radius of the neutral fibre, document units, > 0 (must exceed the body extent on the centre side).')
      .optional(),
    angleDeg: z
      .number()
      .describe(
        'Angle the region turns, degrees, > 0 and at most 360 (360 only for the whole body, on the exact kernel: the two end faces are sewn into a ring).',
      )
      .optional(),
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
        infinite: infiniteParam,
      })
      .describe(
        'Bent region along the axis; giving both start and end counts as giving length. With infinite true it only fixes the rate (and the start where the arc begins).',
      )
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
  run: (doc, { id, ids, keepSource, radius, angleDeg, length, region, symmetric, frame, output }, ctx): CommandResult =>
    runDeform(doc, ctx, {
      command: 'bend_body',
      ids: targetIds(id, ids),
      keepSource,
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
        const resolved = resolveTargetFrame(target, frame, 'start', 'y');
        if ('code' in resolved) return resolved;
        const start = region?.start ?? resolved.extent.min[2];
        const bendRegion = resolveRegion(
          resolved.extent,
          { start, end: start + regionLength, falloff: 'linear', infinite: region?.infinite },
          'linear',
        );
        if ('code' in bendRegion) return bendRegion;
        if (bendRegion.infinite === true) {
          const turn = (resolved.extent.max[2] - resolved.extent.min[2]) / bendRadius;
          if (turn >= FULL_TURN - 1e-9)
            return {
              code: 'DEF_SELF_INTERSECTION',
              message: `the infinite bend turns the ${resolved.extent.max[2] - resolved.extent.min[2]} long body by ${(turn * 180) / Math.PI} degrees: a turn of 360 degrees or more makes its ends overlap`,
              paths: ['params'],
            };
          return {
            law: { kind: 'bend', radius: bendRadius, symmetric: symmetric === true },
            frame: resolved.frame,
            region: bendRegion,
            extent: resolved.extent,
            defaulted: resolved.defaulted,
          };
        }
        // a full turn of the whole body closes into a ring (its end faces coincide within the tolerance): the exact kernel sews it
        const gap = Math.abs(regionLength - FULL_TURN * bendRadius);
        const tolerance = output?.tolerance ?? defaultTolerance(target.diagonal);
        const closedRing =
          gap <= 2 * tolerance &&
          bendRegion.start <= resolved.extent.min[2] + tolerance &&
          bendRegion.end >= resolved.extent.max[2] - tolerance &&
          !symmetric;
        if (regionLength / bendRadius >= FULL_TURN - 1e-9 && !closedRing)
          return {
            code: 'DEF_SELF_INTERSECTION',
            message: `the bend turns ${((regionLength / bendRadius) * 180) / Math.PI} degrees: a turn of more than 360 degrees, or a full turn with a straight part left, makes its ends overlap`,
            paths: ['params'],
          };
        const bentExtent = extentWithin(target, resolved.frame, bendRegion.start, bendRegion.end, resolved.extent);
        return {
          law: { kind: 'bend', radius: bendRadius, symmetric: symmetric === true },
          frame: resolved.frame,
          region: bendRegion,
          extent: bentExtent,
          checkOverlap:
            !closedRing &&
            regionLength / bendRadius >= Math.PI / 2 &&
            (resolved.extent.min[2] < bendRegion.start || resolved.extent.max[2] > bendRegion.end),
          ...(closedRing ? { ring: true } : {}),
          defaulted: resolved.defaulted,
        };
      },
    }),
});
