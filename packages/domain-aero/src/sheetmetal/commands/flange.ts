import { defineCommand, z, vec3 } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import { toRadians } from '@lib/angle';
import { normalize2, sub2 } from '@lib/vec2';
import { bendQuantities } from '@lib/sheetMath';
import type { Vec2 } from '@core/model/types';
import type { SheetNode } from '@core/model/sheetMetal';
import { bendGeometry, bottomOffset } from '../frames';
import { withFoldedSolid } from '../fold';
import { EPS, moveEdgeInward } from '../geometry2d';
import { childBends, getModel, nextNodeId, parentBend, ruleOfPart, withModel, withNodes, withPart } from '../graph';
import { pickEdge } from '../pick';
import { fixed, refuse } from '../result';

const REFERENCES = ['outside_mold_line', 'inside_mold_line', 'tangent'] as const;
const POSITIONS = ['material_inside', 'material_outside', 'bend_outside'] as const;

/** Overlap length of intervals [a0,a1] and [b0,b1]. */
const overlap = (a0: number, a1: number, b0: number, b1: number): number =>
  Math.min(Math.max(a0, a1), Math.max(b0, b1)) - Math.max(Math.min(a0, a1), Math.min(b0, b1));

/**
 * @affects adds a flat + a bend to the part and re-derives its folded solid; modifies the parent flat only for position material_inside / bend_outside
 * @invariant flat leg = length - setback (tan(theta/2)*(R+T) for outside_mold_line, tan(theta/2)*R for inside_mold_line, none for tangent); the bend line lies on the picked edge
 * @failure unknown part/rule, angle outside (0, 180], R = 0 without allowSharpBends, edge not found / occupied, leg <= 0 -> rejected with error.code
 */
export const addFlange = defineCommand({
  name: 'add_flange',
  description:
    'Add an edge flange (a bend plus a flat leg) to a sheet-metal part on a straight outline edge picked by a world point `edge.near` (any point within one thickness of the edge). ' +
    "angle is the angle bent THROUGH in degrees (90 = right angle; a closed 45-degree angle is a 135-degree bend); direction up bends towards the flat's +normal face. " +
    'length is measured from the bend to the free end along the flange: to the outside mold line (virtual sharp of the outer faces, default for drawings), the inside mold line, or the bend tangent line. ' +
    "position says where the picked edge sits: 'material_outside' = the edge is the bend tangent line (the bend grows outside the profile), " +
    "'material_inside' = the edge is the outside mold line (the flat is trimmed back by the outside setback), 'bend_outside' = the edge is the extreme of the outer bend surface. " +
    'insideRadius defaults to the rule radius. widthStart / widthEnd inset the bend from the edge ends. All lengths are in the document length unit. ' +
    'Refusals: FTR_PART_NOT_FOUND, FTR_BEND_ANGLE_OUT_OF_RANGE, FTR_SHARP_BEND_FORBIDDEN (R = 0), FTR_EDGE_NOT_STRAIGHT (no edge at edge.near), FTR_EDGE_OCCUPIED, FTR_FLANGE_TOO_SHORT. ' +
    'Next: add_relief, add_sheet_cutout, flat_pattern, check_sheet_metal.',
  params: z.object({
    id: z.string().describe('Sheet-metal part id (returned by add_sheet_metal_base).'),
    edge: z
      .object({
        near: vec3(
          'World point [x, y, z] on or within one thickness of the straight edge that receives the flange (document length unit).',
        ),
      })
      .describe('Edge selector.'),
    angle: z
      .number()
      .describe(
        'Bend angle in degrees: the angle bent THROUGH (0 = flat, 90 = right angle). 0 < angle <= 180; 180 only with lengthReference tangent.',
      ),
    length: z.number().describe('Flange length in the document length unit, measured as lengthReference says; must leave a flat leg > 0.'),
    lengthReference: z
      .enum(REFERENCES)
      .describe("Where `length` ends at the bend: 'outside_mold_line', 'inside_mold_line' or 'tangent' (the bend tangent line)."),
    position: z
      .enum(POSITIONS)
      .describe("Where the picked edge sits relative to the bend: 'material_outside', 'material_inside' or 'bend_outside'."),
    direction: z
      .enum(['up', 'down'])
      .optional()
      .describe("Bend towards the flat's +normal face ('up', default) or the -normal face ('down')."),
    insideRadius: z.number().optional().describe('Inside bend radius in the document length unit; default the rule radius; >= 0.'),
    widthStart: z.number().optional().describe('Inset of the flange from the edge start, in the document length unit (>= 0, default 0).'),
    widthEnd: z.number().optional().describe('Inset of the flange from the edge end, in the document length unit (>= 0, default 0).'),
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: Parameters<typeof refuse>[2], why: string, fix: string, where: Parameters<typeof refuse>[5] = {}): CommandResult =>
      refuse(doc, 'add_flange', code, why, fix, where);
    const model = getModel(doc);
    const part = model.parts[params.id];
    if (part === undefined)
      return fail('FTR_PART_NOT_FOUND', `no sheet-metal part "${params.id}"`, 'Create one with add_sheet_metal_base.', { paths: ['id'] });
    const rule = ruleOfPart(model, part);
    if (rule === undefined)
      return fail('FTR_RULE_NOT_FOUND', `rule "${part.rule}" of part ${part.id} is missing`, 'Recreate the rule.', { ids: [part.id] });
    const { angle, length, lengthReference, position } = params;
    const T = rule.thickness;
    const R = params.insideRadius ?? rule.insideRadius;
    if (!(angle > 0 && angle <= 180) || (angle >= 180 && lengthReference !== 'tangent'))
      return fail(
        'FTR_BEND_ANGLE_OUT_OF_RANGE',
        `angle ${angle} degrees is not allowed`,
        'Bend angle is the angle bent through, 0 < angle < 180 degrees (180 only with lengthReference tangent).',
        { paths: ['angle'] },
      );
    if (!(R >= 0)) return fail('FTR_PARAM_INVALID', `insideRadius must be >= 0 (got ${R})`, 'Give R >= 0.', { paths: ['insideRadius'] });
    if (R === 0 && rule.allowSharpBends !== true)
      return fail(
        'FTR_SHARP_BEND_FORBIDDEN',
        'inside radius 0 and the rule does not allow sharp bends',
        'Use an inside radius >= the table minimum, or a rule with allowSharpBends.',
        { ids: [part.id], paths: ['insideRadius'] },
      );
    const widthStart = params.widthStart ?? 0;
    const widthEnd = params.widthEnd ?? 0;
    if (!(length > 0) || !(widthStart >= 0) || !(widthEnd >= 0))
      return fail('FTR_PARAM_INVALID', 'length must be > 0 and widthStart/widthEnd >= 0', 'Give positive lengths.', { paths: ['length'] });
    const theta = toRadians(angle);
    const q = angle >= 180 ? null : bendQuantities({ theta, insideRadius: R, thickness: T, k: 0.5 });
    const setback =
      lengthReference === 'outside_mold_line' ? (q?.ossb.value ?? 0) : lengthReference === 'inside_mold_line' ? (q?.issb.value ?? 0) : 0;
    const leg = length - setback;
    if (!(leg > EPS))
      return fail(
        'FTR_FLANGE_TOO_SHORT',
        `length ${fixed(length)} leaves a flat leg of ${fixed(leg)} after the ${fixed(setback)} setback`,
        `Use a length > ${fixed(setback)} (document length unit).`,
        { paths: ['length'] },
      );

    const hit = pickEdge(part, T, params.edge.near);
    if (hit === null || hit.distance > T + 1e-6)
      return fail(
        'FTR_EDGE_NOT_STRAIGHT',
        `no straight flat edge within one thickness of ${JSON.stringify(params.edge.near)}`,
        'Pick a point on a straight edge of a flat face.',
        { ids: [part.id], paths: ['edge.near'] },
      );
    const { flat } = hit;
    const trim =
      position === 'material_inside'
        ? (q?.ossb.value ?? 0)
        : position === 'bend_outside'
          ? (R + T) * Math.sin(Math.min(theta, Math.PI / 2))
          : 0;
    const flatBends = childBends(part, flat.id);
    const hasParent = parentBend(part, flat.id) !== undefined;
    if (trim > 0 && (flatBends.length > 0 || hasParent))
      return fail(
        'FTR_PARAM_INVALID',
        `position ${position} trims the flat, which already has bends`,
        'Use position material_outside on flats that already have bends.',
        { ids: [part.id, flat.id], paths: ['position'] },
      );
    const outline = trim > 0 ? moveEdgeInward(flat.outline, hit.index, trim) : [...flat.outline];
    if (outline === null)
      return fail(
        'FTR_PARAM_INVALID',
        `the flat is too small to trim by ${fixed(trim)}`,
        'Enlarge the profile or use position material_outside.',
        { ids: [part.id, flat.id], paths: ['position'] },
      );
    const a = outline[hit.index] as Vec2;
    const b = outline[(hit.index + 1) % outline.length] as Vec2;
    const along = normalize2(sub2(b, a));
    const edgeLength = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const start = Math.min(widthStart, edgeLength);
    const end = Math.max(start, edgeLength - widthEnd);
    if (end - start <= EPS)
      return fail('FTR_PARAM_INVALID', 'widthStart + widthEnd leave no flange width', 'Reduce the insets.', {
        paths: ['widthStart', 'widthEnd'],
      });
    const p: Vec2 = [a[0] + along[0] * end, a[1] + along[1] * end];
    const qEnd: Vec2 = [a[0] + along[0] * start, a[1] + along[1] * start];
    const taken = [
      ...flatBends.map((bend) => bend.lineInFrom),
      ...(hasParent
        ? [
            [
              [0, 0],
              [Math.max(...flat.outline.map((point) => point[0])), 0],
            ] as const,
          ]
        : []),
    ].some(([u, v]) => {
      const onLine =
        Math.abs((u[0] - a[0]) * along[1] - (u[1] - a[1]) * along[0]) < 1e-6 &&
        Math.abs((v[0] - a[0]) * along[1] - (v[1] - a[1]) * along[0]) < 1e-6;
      return (
        onLine &&
        overlap((u[0] - a[0]) * along[0] + (u[1] - a[1]) * along[1], (v[0] - a[0]) * along[0] + (v[1] - a[1]) * along[1], start, end) > 1e-6
      );
    });
    if (taken)
      return fail(
        'FTR_EDGE_OCCUPIED',
        'the picked edge already carries a bend',
        'Pick another edge or use widthStart/widthEnd to leave the existing bend free.',
        { ids: [part.id, flat.id], paths: ['edge.near'] },
      );

    const signed = params.direction === 'down' ? -theta : theta;
    const bottom = bottomOffset(part.side, T);
    const geometry = bendGeometry(flat.frame, [p, qEnd], signed, R, T, bottom);
    const width = Math.hypot(qEnd[0] - p[0], qEnd[1] - p[1]);
    const flatId = nextNodeId(part, 'f');
    const bendId = nextNodeId(part, 'b');
    const nodes: SheetNode[] = [
      { ...flat, outline },
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
      { id: bendId, type: 'bend', from: flat.id, to: flatId, lineInFrom: [p, qEnd], angle: signed, insideRadius: R },
    ];
    const nextPart = withNodes(part, nodes);
    const next = withFoldedSolid(withModel(doc, withPart(model, nextPart)), nextPart, rule);
    return changed(
      next,
      `add_flange: part "${part.id}" flange ${flatId} via bend ${bendId}: ${angle} degrees ${params.direction ?? 'up'}, R=${fixed(R)}, flat leg ${fixed(leg)} (length ${fixed(length)} to ${lengthReference}, setback ${fixed(setback)}), width ${fixed(width)}${trim > 0 ? `, base trimmed by ${fixed(trim)}` : ''}.`,
      [part.id],
    );
  },
});
