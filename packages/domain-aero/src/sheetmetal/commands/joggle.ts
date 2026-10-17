import { defineCommand, z, vec2, vec3 } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import type { Vec2 } from '@core/model/types';
import type { SheetCutout, SheetNode } from '@core/model/sheetMetal';
import { toRadians } from '@lib/angle';
import { joggleQuantities, minJoggleOffset } from '@lib/sheetMath';
import { withFoldedSolid } from '../fold';
import { EPS, clipHalfPlane, isSimplePolygon, lineBasis, lineCrossings, sideOf, toLineFrame } from '../geometry2d';
import { childBends, formsOf, getModel, nextNodeIds, parentBend, ruleOfPart, withModel, withNodes, withPart } from '../graph';
import { relayout } from '../layout';
import { pickFlat } from '../pick';
import { fixed, refuse } from '../result';
import { resolveK } from '../rules';

type Side = 'left' | 'right' | 'on' | 'mixed';

function sideOfPoints(p: Vec2, q: Vec2, points: readonly Vec2[]): Side {
  const sides = points.map((point) => sideOf(p, q, point));
  const tolerance = 1e-9;
  if (sides.every((s) => Math.abs(s) <= tolerance)) return 'on';
  if (sides.every((s) => s >= -tolerance)) return 'left';
  if (sides.every((s) => s <= tolerance)) return 'right';
  return 'mixed';
}

/**
 * @affects splits one flat at a line into [kept part] -bend- [inclined flat] -reverse bend- [offset part], moves the descendants to the offset part, records a joggle node, re-derives the folded solid
 * @invariant the inclined straight s = (h - 2*rm*(1-cos phi))/sin phi >= 0 (rm = R + T/2); the offset part is inserted, so the developed length grows by the joggle's 2*BA + s
 * @failure offset too small (FTR_JOGGLE_OFFSET_TOO_SMALL), angle outside (0, 90], line not splitting the flat into two simple pieces / crossing a cutout or bend (FTR_JOGGLE_LINE_INVALID) -> rejected with error.code
 */
export const addJoggle = defineCommand({
  name: 'add_joggle',
  description:
    'Add a joggle (two reverse bends of angle phi that offset the rest of a flat by `offset`) across the full width of one flat of a sheet-metal part. ' +
    "The flat is picked by the world point `face.near`; `line` is the start tangent line of the first bend as two [x, y] points in the flat's own plane coordinates (for the base flat these are the profile coordinates); " +
    "the line is extended to the flat's outline. The piece on the RIGHT of line[0] -> line[1] keeps the flat (for a flat that is attached through a bend the side attached to the bend is kept automatically); " +
    'an inclined flat of length s and the offset piece are inserted on the LEFT. offset (the offset between the two flat faces), angle (degrees, 0 < angle <= 90) and insideRadius are in document length unit / degrees. ' +
    'Inclined straight s = (offset - 2*(R+T/2)*(1-cos(angle)))/sin(angle) must be > 0, else FTR_JOGGLE_OFFSET_TOO_SMALL (increase the offset to more than 2*(R+T/2)*(1-cos(angle)), or reduce R or angle). ' +
    'Other refusals: FTR_PART_NOT_FOUND, FTR_FACE_NOT_FOUND, FTR_BEND_ANGLE_OUT_OF_RANGE, FTR_SHARP_BEND_FORBIDDEN, FTR_JOGGLE_LINE_INVALID. flat_pattern then reports the joggle allowance and run.',
  params: z.object({
    id: z.string().describe('Sheet-metal part id (returned by add_sheet_metal_base).'),
    face: z
      .object({ near: vec3('World point [x, y, z] on or near the flat to joggle (document length unit).') })
      .describe('Flat selector.'),
    line: z
      .tuple([
        vec2('Start of the line [x, y] in the flat plane coordinates (document length unit).'),
        vec2('End of the line [x, y] in the flat plane coordinates (document length unit).'),
      ])
      .describe(
        "Start tangent line of the first joggle bend, as two [x, y] points in the picked flat's plane coordinates (document length unit).",
      ),
    offset: z.number().describe('Offset between the two flat faces in the document length unit; > 0.'),
    angle: z.number().describe('Joggle bend angle phi in degrees; 0 < angle <= 90.'),
    insideRadius: z
      .number()
      .optional()
      .describe('Inside bend radius of both bends in the document length unit; default the rule radius; >= 0.'),
    side: z
      .enum(['up', 'down'])
      .describe("Direction of the offset: 'up' moves the offset piece towards the flat's +normal side, 'down' towards -normal."),
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: Parameters<typeof refuse>[2], why: string, fix: string, where: Parameters<typeof refuse>[5] = {}): CommandResult =>
      refuse(doc, 'add_joggle', code, why, fix, where);
    const model = getModel(doc);
    const part = model.parts[params.id];
    if (part === undefined)
      return fail('FTR_PART_NOT_FOUND', `no sheet-metal part "${params.id}"`, 'Create one with add_sheet_metal_base.', { paths: ['id'] });
    const rule = ruleOfPart(model, part);
    if (rule === undefined) return fail('FTR_RULE_NOT_FOUND', `rule "${part.rule}" is missing`, 'Recreate the rule.', { ids: [part.id] });
    const T = rule.thickness;
    const R = params.insideRadius ?? rule.insideRadius;
    const phi = toRadians(params.angle);
    if (!(params.angle > 0 && params.angle <= 90))
      return fail(
        'FTR_BEND_ANGLE_OUT_OF_RANGE',
        `joggle angle ${params.angle} degrees is outside (0, 90]`,
        'Joggle angle is the angle of each bend, 0 < angle <= 90 degrees.',
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
    const k = resolveK(rule, R).value;
    const quantities = joggleQuantities({ thickness: T, insideRadius: R, k, phi, offset: params.offset });
    const minimum = minJoggleOffset(T, R, phi);
    if (!(params.offset > 0) || quantities === null || quantities.inclinedStraight.value <= 1e-6)
      return fail(
        'FTR_JOGGLE_OFFSET_TOO_SMALL',
        `offset ${fixed(params.offset)} leaves an inclined straight <= 0 (needs offset > ${fixed(minimum)})`,
        `Increase offset to more than ${fixed(minimum)} (2*(R+T/2)*(1-cos(angle))), or reduce R or angle.`,
        { ids: [part.id], paths: ['offset', 'angle', 'insideRadius'] },
      );
    const hit = pickFlat(part, T, params.face.near);
    if (hit === null || hit.distance > T + 1e-6)
      return fail(
        'FTR_FACE_NOT_FOUND',
        `no flat within one thickness of ${JSON.stringify(params.face.near)}`,
        'Pick a point on a flat face of the part.',
        { ids: [part.id], paths: ['face.near'] },
      );
    const { flat } = hit;
    const [start, end] = params.line;
    if (Math.hypot(end[0] - start[0], end[1] - start[1]) < EPS)
      return fail('FTR_JOGGLE_LINE_INVALID', 'the joggle line has zero length', 'Give two distinct points.', { paths: ['line'] });
    const invalid = (why: string): CommandResult =>
      fail(
        'FTR_JOGGLE_LINE_INVALID',
        why,
        'Pick a line that splits the flat into two simple pieces without crossing cutouts or existing bends.',
        { ids: [part.id, flat.id], paths: ['line'] },
      );

    let p: Vec2 = start;
    let q: Vec2 = end;
    const attach = parentBend(part, flat.id);
    if (attach !== undefined) {
      const [a, b] = attach.lineInFrom;
      const connection: Vec2 = [Math.hypot(b[0] - a[0], b[1] - a[1]) / 2, 0];
      if (sideOf(p, q, connection) > 0) {
        const swap = p;
        p = q;
        q = swap;
      }
    }
    const direction = lineBasis(p, q).direction;
    const crossings = lineCrossings(flat.outline, p, direction);
    if (crossings.length !== 2)
      return invalid(`the line crosses the flat outline ${crossings.length} time(s); it must cross it exactly twice`);
    p = crossings[0] as Vec2;
    q = crossings[1] as Vec2;
    const width = Math.hypot(q[0] - p[0], q[1] - p[1]);
    const normal = lineBasis(p, q).outward;
    const kept = clipHalfPlane(flat.outline, p, normal, 'negative');
    const moved = clipHalfPlane(flat.outline, p, normal, 'positive');
    if (!isSimplePolygon(kept) || !isSimplePolygon(moved)) return invalid('the line does not split the flat into two simple pieces');

    if (formsOf(part).some((node) => node.on === flat.id))
      return invalid('the flat carries a flanged hole or bead, which a joggle cannot split');
    const sideOfCutout = (cutout: SheetCutout): Side => sideOfPoints(p, q, cutout.points);
    if (flat.cutouts.some((cutout) => ['mixed', 'on'].includes(sideOfCutout(cutout)))) return invalid('the line crosses a cutout');
    const bends = childBends(part, flat.id);
    const bendSides = bends.map((bend) => sideOfPoints(p, q, [bend.lineInFrom[0], bend.lineInFrom[1]]));
    if (bendSides.some((side) => side === 'mixed' || side === 'on'))
      return invalid('the line crosses or coincides with an existing bend line');

    const toMoved = (point: Vec2): Vec2 => toLineFrame(point, p, direction);
    const straight = quantities.inclinedStraight.value;
    const sign = params.side === 'up' ? 1 : -1;
    const [inclineId, afterId] = nextNodeIds(part, 'f', 2) as [string, string];
    const [firstBend, secondBend] = nextNodeIds(part, 'b', 2) as [string, string];
    const [jogId] = nextNodeIds(part, 'j', 1) as [string];
    const movedCutouts = flat.cutouts.filter((cutout) => sideOfCutout(cutout) === 'left');
    const nodes: SheetNode[] = [
      { ...flat, outline: kept, cutouts: flat.cutouts.filter((cutout) => sideOfCutout(cutout) === 'right') },
      {
        id: inclineId,
        type: 'flat',
        outline: [
          [0, 0],
          [width, 0],
          [width, straight],
          [0, straight],
        ],
        frame: flat.frame,
        cutouts: [],
      },
      {
        id: afterId,
        type: 'flat',
        outline: moved.map(toMoved),
        frame: flat.frame,
        cutouts: movedCutouts.map((cutout) => ({
          points: cutout.points.map(toMoved),
          ...(cutout.circle !== undefined ? { circle: { center: toMoved(cutout.circle.center), radius: cutout.circle.radius } } : {}),
        })),
      },
      { id: firstBend, type: 'bend', from: flat.id, to: inclineId, lineInFrom: [p, q], angle: sign * phi, insideRadius: R },
      {
        id: secondBend,
        type: 'bend',
        from: inclineId,
        to: afterId,
        lineInFrom: [
          [0, straight],
          [width, straight],
        ],
        angle: -sign * phi,
        insideRadius: R,
      },
      {
        id: jogId,
        type: 'joggle',
        on: flat.id,
        bends: [firstBend, secondBend],
        incline: inclineId,
        after: afterId,
        line: [p, q],
        offset: params.offset,
        angle: phi,
        insideRadius: R,
      },
    ];
    const reparented = bends.flatMap((bend, index): SheetNode[] => {
      if (bendSides[index] !== 'left') return [];
      const [a, b] = bend.lineInFrom;
      return [{ ...bend, from: afterId, lineInFrom: [toMoved(a), toMoved(b)] }];
    });
    const nextPart = relayout(withNodes(part, [...nodes, ...reparented]), T);
    const next = withFoldedSolid(withModel(doc, withPart(model, nextPart)), nextPart, rule);
    return changed(
      next,
      `add_joggle: part "${part.id}" joggle ${jogId} on ${flat.id}: ${params.side} ${fixed(params.offset)}, ${params.angle} degrees, R=${fixed(R)}; inclined straight ${fixed(straight)}, run ${fixed(quantities.run.value)}, ` +
        `developed ${fixed(quantities.developed.value)}, allowance ${fixed(quantities.allowance.value)} (bends ${firstBend}, ${secondBend}; flats ${inclineId}, ${afterId}); width ${fixed(width)}.`,
      [part.id],
    );
  },
});
