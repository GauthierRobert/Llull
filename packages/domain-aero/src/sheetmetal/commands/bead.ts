import { defineCommand, z, vec3 } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import type { Vec2 } from '@core/model/types';
import type { BeadForm } from '@core/model/sheetMetal';
import { withFoldedSolid } from '../fold';
import { beadAreaChange, beadFootprint, beadGeometry } from '../formGeometry';
import { worldToFrame } from '../frames';
import { formsOf, getModel, nextNodeId, ruleOfPart, withModel, withNodes, withPart } from '../graph';
import { beadFootprints, insideOutline, polygonsTouch } from '../placement';
import { pickFlat } from '../pick';
import { fixed, refuse } from '../result';

/**
 * @affects forms a stiffening bead into one flat (arch added, trough removed in the folded solid), records a form node; the flat pattern is unchanged and lists the bead as a forming note
 * @invariant section = circular arch of inside radius R and outer radius R+T, crown `depth` above the flat face, junctions on the radial rays through the crown ends (no blend radii); the blank is not adjusted for material drawn into the bead
 * @failure unknown part, no flat at face.near (FTR_FACE_NOT_FOUND), path shorter than 1e-6 or sizes <= 0 or depth >= radius (FTR_FORM_INVALID), footprint leaving the flat, touching an edge/bend, a cutout or another bead (FTR_CUTOUT_INVALID) -> rejected with error.code
 */
export const addBead = defineCommand({
  name: 'add_bead',
  description:
    'Add a stiffening bead (a formed rib of circular cross-section) along a straight path on ONE flat of a sheet-metal part. ' +
    'The flat is picked by the world point `face.near`; `path` is [start, end], two world points [x, y, z] projected onto the flat plane. ' +
    'radius is the INSIDE radius of the arch (groove side), depth the height of the bead crown above the flat face on the bead side (0 < depth < radius), both in the document length unit; the arch is T thick (outer radius = radius + T). ' +
    "endShape 'round' closes both ends with a revolved cap (footprint = capsule); 'open' leaves the arch open at both path ends. The cross-section has no blend radii (junctions on the radial rays). " +
    'The bead stays wholly inside the flat, clear of its edges, bends, cutouts and other beads. The flat pattern is NOT changed: the bead is excluded and listed as a forming note (flat_pattern data.formingNotes, DXF NOTES); the blank is not adjusted for material drawn into the bead. ' +
    'Refusals: FTR_PART_NOT_FOUND, FTR_FACE_NOT_FOUND, FTR_FORM_INVALID, FTR_CUTOUT_INVALID. Next: flat_pattern, check_sheet_metal.',
  params: z.object({
    id: z.string().describe('Sheet-metal part id (returned by add_sheet_metal_base).'),
    face: z
      .object({ near: vec3('World point [x, y, z] on or near the flat that gets the bead (document length unit).') })
      .describe('Flat selector.'),
    path: z
      .tuple([
        vec3('Bead start [x, y, z], world point (document length unit).'),
        vec3('Bead end [x, y, z], world point (document length unit).'),
      ])
      .describe('Straight bead centre line as two world points, projected onto the picked flat (document length unit).'),
    radius: z.number().describe('Inside radius of the bead arch in the document length unit; > depth.'),
    depth: z
      .number()
      .describe('Height of the bead crown above the flat face on the bead side, in the document length unit; 0 < depth < radius.'),
    endShape: z.enum(['round', 'open']).describe("End treatment: 'round' (closed revolved caps) or 'open' (arch open at both ends)."),
    direction: z
      .enum(['up', 'down'])
      .optional()
      .describe("Bead towards the flat's +normal face ('up', default) or the -normal face ('down')."),
  }),
  run: (doc, params): CommandResult => {
    const fail = (code: Parameters<typeof refuse>[2], why: string, fix: string, where: Parameters<typeof refuse>[5] = {}): CommandResult =>
      refuse(doc, 'add_bead', code, why, fix, where);
    const model = getModel(doc);
    const part = model.parts[params.id];
    if (part === undefined)
      return fail('FTR_PART_NOT_FOUND', `no sheet-metal part "${params.id}"`, 'Create one with add_sheet_metal_base.', { paths: ['id'] });
    const rule = ruleOfPart(model, part);
    if (rule === undefined) return fail('FTR_RULE_NOT_FOUND', `rule "${part.rule}" is missing`, 'Recreate the rule.', { ids: [part.id] });
    const T = rule.thickness;
    const hit = pickFlat(part, T, params.face.near);
    if (hit === null || hit.distance > T + 1e-6)
      return fail(
        'FTR_FACE_NOT_FOUND',
        `no flat within one thickness of ${JSON.stringify(params.face.near)}`,
        'Pick a point on a flat face of the part.',
        { ids: [part.id], paths: ['face.near'] },
      );
    const { flat } = hit;
    const local = params.path.map((point): Vec2 => {
      const [x, y] = worldToFrame(flat.frame, point);
      return [x, y];
    });
    const [start, end] = local as [Vec2, Vec2];
    const form: BeadForm = {
      kind: 'bead',
      start,
      end,
      radius: params.radius,
      depth: params.depth,
      endShape: params.endShape,
      direction: params.direction ?? 'up',
    };
    const bead = beadGeometry(form, T);
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    if (bead === null || !(length > 1e-6))
      return fail(
        'FTR_FORM_INVALID',
        `cannot form a bead of radius ${params.radius}, depth ${params.depth} on a ${fixed(length)} long path`,
        'Use radius > 0, 0 < depth < radius and a path of two distinct points.',
        { paths: ['radius', 'depth', 'path'] },
      );
    const footprint = beadFootprint(start, end, bead.halfWidth, params.endShape);
    if (
      !insideOutline(flat, footprint, 1e-6) ||
      flat.cutouts.some((cutout) => polygonsTouch(footprint, cutout.points)) ||
      beadFootprints(formsOf(part), flat.id, T).some((other) => polygonsTouch(footprint, other))
    )
      return fail(
        'FTR_CUTOUT_INVALID',
        `the bead footprint (${fixed(2 * bead.halfWidth)} wide) does not fit inside ${flat.id} clear of its edges, bends, cutouts and other beads`,
        'Shorten or move the path, or reduce radius / depth.',
        { ids: [part.id, flat.id], paths: ['path'] },
      );
    const formId = nextNodeId(part, 'm');
    const nextPart = withNodes(part, [{ id: formId, type: 'form', on: flat.id, form }]);
    const next = withFoldedSolid(withModel(doc, withPart(model, nextPart)), nextPart, rule);
    return {
      ...changed(
        next,
        `add_bead: part "${part.id}" bead ${formId} on ${flat.id}: ${fixed(length)} long, inside R=${fixed(params.radius)}, depth ${fixed(params.depth)} ${form.direction}, ${params.endShape} ends, footprint ${fixed(2 * bead.halfWidth)} wide. Excluded from the flat pattern (forming note).`,
        [part.id],
      ),
      data: {
        formId,
        flat: flat.id,
        length,
        footprintWidth: 2 * bead.halfWidth,
        crownHalfWidth: bead.halfWidth,
        areaChangePerLength: beadAreaChange(form, T),
      },
    };
  },
});
