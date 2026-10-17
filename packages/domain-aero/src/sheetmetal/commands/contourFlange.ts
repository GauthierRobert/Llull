import { defineCommand, z, vec2, vec3 } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import type { Vec2 } from '@core/model/types';
import { toDegrees } from '@lib/angle';
import { bendGeometry, bottomOffset } from '../frames';
import { withFoldedSolid } from '../fold';
import { EPS } from '../geometry2d';
import { flatOf, getModel, nextNodeIds, withModel, withNodes, withPart } from '../graph';
import { fixed, refuser } from '../result';
import { findRadiusRow, resolveK } from '../rules';
import { applyFlange } from './flange';
import { insideRadiusOf, isRefusal, partContext } from '../partLookup';

type Face = 'top' | 'bottom' | 'mid';

/** Radius of the face the path follows at a bend turning `up` (left) or not, given the inside radius R and thickness T. */
function faceRadius(face: Face, up: boolean, radius: number, thickness: number): number {
  if (face === 'mid') return radius + thickness / 2;
  return (face === 'top') === up ? radius : radius + thickness;
}

const normalizeAngle = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));

/**
 * @affects adds a chain of flats and bends (one bend per path vertex, starting at the picked edge) to the part and re-derives its folded solid
 * @invariant leg = mold-segment length - setback(start) - setback(end), setback = tan(theta/2) x face radius; the flat pattern develops each bend with BA = theta(R + K T), so unfolded area x T = folded volume at K 0.5
 * @failure unknown part, first segment in the base plane, zero-length or collinear segments (FTR_PARAM_INVALID), turn >= 180 (FTR_BEND_ANGLE_OUT_OF_RANGE), R below the radius-table minimum (FTR_BEND_RADIUS_BELOW_MIN), R = 0 (FTR_SHARP_BEND_FORBIDDEN), a leg <= 0 (FTR_FLANGE_TOO_SHORT), edge errors of add_flange -> rejected with error.code
 */
export const addContourFlange = defineCommand({
  name: 'add_contour_flange',
  description:
    'Add a contour flange to a sheet-metal part: an open profile of straight legs joined by bends of one inside radius, swept along a straight edge picked by `edge.near` (Z, channel, hat, stepped lips). ' +
    'path lists the profile vertices P1..Pn as [u, v] relative to the first mold vertex P0: u runs away from the edge in the base plane, v along the base +normal (document length unit). ' +
    'Every vertex of P0..P(n-1) becomes a bend of the turning angle there (a left turn bends up, a right turn bends down); the picked edge is the tangent line of the first bend, so the first segment must leave the base plane (v != 0 direction). ' +
    "side says which sheet face the path follows: 'top' (the +normal face, inside of up bends), 'bottom', or 'mid' (mid-thickness); setbacks are tan(angle/2) x (R, R+T or R+T/2) accordingly and the legs are the segments minus their setbacks. " +
    'All joins are tangent arcs of insideRadius (default the rule radius). widthStart / widthEnd inset the flange from the edge ends (document length unit). The flat pattern is analytic (BA = angle x (R + K T) per bend). ' +
    'Refusals: FTR_PART_NOT_FOUND, FTR_PARAM_INVALID, FTR_BEND_ANGLE_OUT_OF_RANGE, FTR_BEND_RADIUS_BELOW_MIN, FTR_SHARP_BEND_FORBIDDEN, FTR_FLANGE_TOO_SHORT, FTR_EDGE_NOT_STRAIGHT, FTR_EDGE_OCCUPIED. Next: flat_pattern, check_sheet_metal.',
  params: z.object({
    id: z.string().describe('Sheet-metal part id (returned by add_sheet_metal_base).'),
    edge: z
      .object({
        near: vec3(
          'World point [x, y, z] on or within one thickness of the straight edge that receives the flange (document length unit).',
        ),
      })
      .describe('Edge selector (the tangent line of the first bend).'),
    path: z
      .array(
        vec2(
          'Profile vertex [u, v] relative to P0 in the document length unit: u away from the edge in the base plane, v along the base +normal.',
        ),
      )
      .min(1)
      .describe('Vertices P1..Pn of the profile, in order from the edge; the first segment P0 -> P1 must not lie in the base plane.'),
    side: z
      .enum(['top', 'bottom', 'mid'])
      .describe("Sheet face the path follows: 'top' (+normal face of the base), 'bottom' or 'mid' (mid-thickness)."),
    insideRadius: z.number().optional().describe('Inside radius of every bend in the document length unit; default the rule radius; >= 0.'),
    widthStart: z.number().optional().describe('Inset of the flange from the edge start, in the document length unit (>= 0, default 0).'),
    widthEnd: z.number().optional().describe('Inset of the flange from the edge end, in the document length unit (>= 0, default 0).'),
  }),
  run: (doc, params): CommandResult => {
    const fail = refuser(doc, 'add_contour_flange');
    const found = partContext(doc, params.id, fail);
    if (isRefusal(found)) return found.refusal;
    const { model, part, rule } = found;
    const T = rule.thickness;
    const R = insideRadiusOf(found, params.insideRadius, fail);
    if (isRefusal(R)) return R.refusal;
    const points: Vec2[] = [[0, 0], ...params.path];
    const segments = points.slice(1).map((end, i) => {
      const start = points[i] as Vec2;
      const delta: Vec2 = [end[0] - start[0], end[1] - start[1]];
      return { length: Math.hypot(delta[0], delta[1]), heading: Math.atan2(delta[1], delta[0]) };
    });
    const turns = segments.map((segment, i) =>
      normalizeAngle(segment.heading - (i === 0 ? 0 : (segments[i - 1] as { heading: number }).heading)),
    );
    const zero = segments.findIndex((segment) => !(segment.length > EPS));
    if (zero >= 0)
      return fail('FTR_PARAM_INVALID', `path segment ${zero + 1} has zero length`, 'Give distinct vertices.', { paths: ['path'] });
    const straight = turns.findIndex((turn) => Math.abs(turn) < 1e-6);
    if (straight >= 0)
      return fail(
        'FTR_PARAM_INVALID',
        straight === 0 ? 'the first segment lies in the base plane' : `vertex P${straight} turns by 0 degrees (collinear segments)`,
        straight === 0
          ? 'Start the profile with a segment that leaves the base plane, or lengthen the base.'
          : 'Merge the collinear segments.',
        { paths: ['path'] },
      );
    const flat = turns.findIndex((turn) => Math.abs(turn) > Math.PI - 1e-6);
    if (flat >= 0)
      return fail(
        'FTR_BEND_ANGLE_OUT_OF_RANGE',
        `vertex P${flat} turns by ${fixed(toDegrees(Math.abs(turns[flat] as number)))} degrees`,
        'Bends must turn by less than 180 degrees (use add_hem for a fold-back).',
        { paths: ['path'] },
      );
    const setbacks = turns.map((turn) => Math.tan(Math.abs(turn) / 2) * faceRadius(params.side, turn > 0, R, T));
    for (const [i, turn] of turns.entries()) {
      const match = findRadiusRow(model.radiusTable, {
        material: rule.material,
        temper: rule.temper,
        thickness: T,
        unit: doc.units,
        angleDeg: toDegrees(Math.abs(turn)),
      });
      if (match !== undefined && R < match.minInsideRadius - 1e-9)
        return fail(
          'FTR_BEND_RADIUS_BELOW_MIN',
          `insideRadius ${fixed(R)} is below the table minimum ${fixed(match.minInsideRadius)} at vertex P${i} (${match.id})`,
          `Use insideRadius >= ${fixed(match.minInsideRadius)}.`,
          { paths: ['insideRadius'] },
        );
    }
    const legs = segments.map((segment, i) => segment.length - (setbacks[i] as number) - (setbacks[i + 1] ?? 0));
    const short = legs.findIndex((leg) => !(leg > EPS));
    if (short >= 0)
      return fail(
        'FTR_FLANGE_TOO_SHORT',
        `leg ${short + 1} is ${fixed(legs[short] as number)} long after the setbacks`,
        'Lengthen the segment or reduce the radius.',
        { paths: ['path'] },
      );

    const first = applyFlange(
      doc,
      'add_contour_flange',
      {
        id: params.id,
        edge: params.edge,
        angle: toDegrees(Math.abs(turns[0] as number)),
        length: legs[0] as number,
        lengthReference: 'tangent',
        position: 'material_outside',
        insideRadius: R,
        direction: (turns[0] as number) > 0 ? 'up' : 'down',
        ...(params.widthStart !== undefined ? { widthStart: params.widthStart } : {}),
        ...(params.widthEnd !== undefined ? { widthEnd: params.widthEnd } : {}),
      },
      { extraNodes: () => [] },
    );
    if (first.result.rejected === true || first.flatId === undefined || first.bendId === undefined) return first.result;
    const modelAfter = getModel(first.result.document);
    let current = modelAfter.parts[params.id] ?? part;
    const bottom = bottomOffset(current.side, T);
    const flats = [first.flatId];
    const bends = [first.bendId];
    for (let i = 1; i < turns.length; i++) {
      const parent = flatOf(current, flats[i - 1] as string);
      if (parent === undefined) break;
      const width = Math.max(...parent.outline.map((point) => point[0]));
      const length = Math.max(...parent.outline.map((point) => point[1]));
      const line: readonly [Vec2, Vec2] = [
        [0, length],
        [width, length],
      ];
      const signed = turns[i] as number;
      const geometry = bendGeometry(parent.frame, line, signed, R, T, bottom);
      const [flatId] = nextNodeIds(current, 'f', 1) as [string];
      const [bendId] = nextNodeIds(current, 'b', 1) as [string];
      const leg = legs[i] as number;
      current = withNodes(current, [
        {
          id: flatId,
          type: 'flat',
          outline: [
            [0, 0],
            [width, 0],
            [width, leg],
            [0, leg],
          ],
          frame: geometry.child,
          cutouts: [],
        },
        { id: bendId, type: 'bend', from: parent.id, to: flatId, lineInFrom: line, angle: signed, insideRadius: R },
      ]);
      flats.push(flatId);
      bends.push(bendId);
    }
    const next = withFoldedSolid(withModel(first.result.document, withPart(modelAfter, current)), current, rule);
    const k = resolveK(rule, R);
    const bendAllowance = turns.reduce((sum, turn) => sum + Math.abs(turn) * (R + k.value * T), 0);
    const developed = legs.reduce((sum, leg) => sum + leg, 0) + bendAllowance;
    return {
      ...changed(
        next,
        `add_contour_flange: part "${part.id}" ${bends.length} bend(s) ${bends.join(', ')} and flat(s) ${flats.join(', ')} from the edge: legs ${legs.map(fixed).join(', ')}, R=${fixed(R)}, side ${params.side}; developed length of the flange ${fixed(developed)} (K ${fixed(k.value)}).`,
        [part.id],
      ),
      data: { bends, flats, legs, setbacks, turnsDeg: turns.map((turn) => toDegrees(turn)), bendAllowance, developedLength: developed },
    };
  },
});
