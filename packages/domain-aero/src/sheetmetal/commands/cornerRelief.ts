import { defineCommand, z, vec3 } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import type { Vec2 } from '@core/model/types';
import { bendLinesOn } from '../checks';
import { cornerNotch, segmentLengthInside } from '../cornerGeometry';
import { withFoldedSolid } from '../fold';
import { nextNodeId, withModel, withNodes, withPart } from '../graph';
import { polygonsTouch } from '../placement';
import { fixed, refuser } from '../result';
import { partContext, isRefusal, flatNear } from '../partLookup';

const distanceBetween = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * @affects cuts a square notch at one right-angle outline corner of a flat (outline edit), records a corner_relief node, re-derives the folded solid
 * @invariant size defaults to the rule radius + thickness + depthExtra (a named default); the notch touches no bend line and no cutout
 * @failure unknown part, no flat / no corner within one thickness (FTR_FACE_NOT_FOUND), size <= 0 (FTR_PARAM_INVALID), not a convex right-angle corner, an adjacent edge not longer than size, a bend line or cutout in the notch (FTR_RELIEF_INVALID) -> rejected with error.code
 */
export const addCornerRelief = defineCommand({
  name: 'add_corner_relief',
  description:
    'Cut a square corner relief into a flat of a sheet-metal part, at one right-angle outline corner (typically where two flanges meet and their bends stop short of the corner), so the flanges can form without tearing. ' +
    'The corner is picked by the world point `corner.near` (within one thickness of the flat corner vertex, which must be a convex 90-degree vertex). The notch removes a size x size square at the corner; ' +
    'size is in the document length unit and defaults to the rule radius + thickness + the rule relief depthExtra (returned as a named default in data.size). ' +
    'The notch must leave both adjacent edges longer than size and touch no bend line or cutout. The flat pattern loses the same square. ' +
    'Refusals: FTR_PART_NOT_FOUND, FTR_FACE_NOT_FOUND, FTR_PARAM_INVALID, FTR_RELIEF_INVALID. Next: check_sheet_metal, flat_pattern.',
  params: z.object({
    id: z.string().describe('Sheet-metal part id (returned by add_sheet_metal_base).'),
    corner: z
      .object({
        near: vec3('World point [x, y, z] on or within one thickness of the flat corner vertex to relieve (document length unit).'),
      })
      .describe('Corner selector.'),
    size: z
      .number()
      .optional()
      .describe(
        'Side of the square notch in the document length unit; > 0. Default: rule inside radius + thickness + rule relief depthExtra (named default in the result).',
      ),
  }),
  run: (doc, params): CommandResult => {
    const fail = refuser(doc, 'add_corner_relief');
    const found = partContext(doc, params.id, fail);
    if (isRefusal(found)) return found.refusal;
    const { model, part, rule } = found;
    const T = rule.thickness;
    const defaulted = params.size === undefined;
    const depthExtra = rule.relief?.depthExtra ?? 0;
    const size = params.size ?? rule.insideRadius + T + depthExtra;
    if (!(size > 0)) return fail('FTR_PARAM_INVALID', `size must be > 0 (got ${size})`, 'Give a positive size.', { paths: ['size'] });
    const hit = flatNear(part, T, params.corner.near, 'corner.near', fail, 'Pick a point at a corner of a flat.');
    if (isRefusal(hit)) return hit.refusal;
    const { flat, local } = hit;
    const index = flat.outline.reduce(
      (best, point, i) => (distanceBetween(point, local) < distanceBetween(flat.outline[best] as Vec2, local) ? i : best),
      0,
    );
    const corner = flat.outline[index] as Vec2;
    if (distanceBetween(corner, local) > T + 1e-6)
      return fail(
        'FTR_FACE_NOT_FOUND',
        `no outline corner of ${flat.id} within one thickness of the picked point`,
        'Pick closer to the corner.',
        { ids: [part.id, flat.id], paths: ['corner.near'] },
      );
    const notch = cornerNotch(flat.outline, index, size);
    if (notch === null)
      return fail(
        'FTR_RELIEF_INVALID',
        `the corner of ${flat.id} at [${fixed(corner[0])}, ${fixed(corner[1])}] is not a convex right angle with both edges longer than ${fixed(size)}`,
        'Pick a 90-degree corner and reduce size.',
        { ids: [part.id, flat.id], paths: ['size', 'corner.near'] },
      );
    const centre = notch.square.reduce<Vec2>((sum, point) => [sum[0] + point[0] / 4, sum[1] + point[1] / 4], [0, 0]);
    const probe = notch.square.map(
      (point): Vec2 => [centre[0] + (point[0] - centre[0]) * (1 - 1e-6), centre[1] + (point[1] - centre[1]) * (1 - 1e-6)],
    );
    const blocking = bendLinesOn(part, flat).find((line) => segmentLengthInside(notch.square, line.a, line.b) > 1e-6);
    if (blocking !== undefined || flat.cutouts.some((cutout) => polygonsTouch(probe, cutout.points)))
      return fail(
        'FTR_RELIEF_INVALID',
        `the ${fixed(size)} notch would cut ${blocking !== undefined ? `bend ${blocking.id}` : 'a cutout'}`,
        'Reduce size, or inset the flange (widthStart / widthEnd) so its bend stops short of the corner.',
        { ids: [part.id, flat.id, ...(blocking !== undefined ? [blocking.id] : [])], paths: ['size'] },
      );
    const reliefId = nextNodeId(part, 'c');
    const nextPart = withNodes(part, [
      { ...flat, outline: notch.outline },
      { id: reliefId, type: 'corner_relief', on: flat.id, corner, size },
    ]);
    const next = withFoldedSolid(withModel(doc, withPart(model, nextPart)), nextPart, rule);
    return {
      ...changed(
        next,
        `add_corner_relief: part "${part.id}" corner relief ${reliefId} at [${fixed(corner[0])}, ${fixed(corner[1])}] of ${flat.id}: ${fixed(size)} x ${fixed(size)} square${defaulted ? ` (size defaulted from rule ${rule.name}: R + T + depthExtra)` : ''}.`,
        [part.id],
      ),
      data: {
        reliefId,
        flat: flat.id,
        corner,
        size: {
          value: size,
          source: defaulted ? `rule ${rule.name}: inside radius + thickness + depthExtra` : 'given',
          defaulted,
          verification: 'verified',
        },
      },
    };
  },
});
