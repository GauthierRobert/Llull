import { defineCommand, z, vec3 } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import type { Vec2 } from '@core/model/types';
import type { FlangedHoleForm } from '@core/model/sheetMetal';
import { toRadians } from '@lib/angle';
import { withFoldedSolid } from '../fold';
import { developedHoleRadius, lipGeometry, lipVolume } from '../formGeometry';
import { frameToWorld, worldToFrame } from '../frames';
import { circlePolygon } from '../geometry2d';
import { formsOf, nextNodeId, withModel, withNodes, withPart } from '../graph';
import { beadFootprints, discClear, polygonDistanceAtLeast } from '../placement';
import { fixed, refuser } from '../result';
import { FLANGED_HOLE_SOURCE } from '../provenance';
import { resolveK } from '../rules';
import { partContext, isRefusal, flatNear } from '../partLookup';

/**
 * @affects cuts the physical hole (radius holeDiameter/2 + T + lipRadius) into one flat, adds the revolved lip to the folded solid and records a form node
 * @invariant the folded solid keeps the exact hole + lip (revolution recipe); the flat pattern shows the DEVELOPED hole (approximate, flagged), not the physical one
 * @failure unknown part, no flat at face.near (FTR_FACE_NOT_FOUND), non-positive sizes, angle outside (0, 90], wall length <= 0, lip across the axis, developed radius <= 0 (FTR_FORM_INVALID), hole outside the flat or touching a cutout / bead / outline (FTR_CUTOUT_INVALID) -> rejected with error.code
 */
export const addFlangedHole = defineCommand({
  name: 'add_flanged_hole',
  description:
    'Add a flanged (lightening) hole to ONE flat of a sheet-metal part: a hole with a lip bent up or down around it, as on stiffened ribs. ' +
    'The flat is picked by the world point `face.near`; `center` is the hole axis point [x, y, z] (projected onto the flat). holeDiameter is the bore diameter of the lip where the bend starts; ' +
    'flangeHeight is the rise of the free end of the lip above the flat face on the lip side; flangeAngle is the angle bent through in degrees (0 < angle <= 90; 90 = cylindrical lip); lipRadius is the inside radius of the bend between flat and lip. ' +
    'The physical hole in the flat has radius holeDiameter/2 + thickness + lipRadius (data.cutRadius). In the flat pattern the hole is DEVELOPED to a smaller circle (data.flatCutDiameter) flagged approximate and unverified (stretch flange): do not cut it without a trial. ' +
    'All lengths are in the document length unit. The hole and its lip must lie wholly inside the flat, clear of its edges, bends, cutouts and beads. ' +
    'Refusals: FTR_PART_NOT_FOUND, FTR_FACE_NOT_FOUND, FTR_FORM_INVALID, FTR_CUTOUT_INVALID. Next: flat_pattern, check_sheet_metal.',
  params: z.object({
    id: z.string().describe('Sheet-metal part id (returned by add_sheet_metal_base).'),
    face: z
      .object({ near: vec3('World point [x, y, z] on or near the flat that gets the hole (document length unit).') })
      .describe('Flat selector.'),
    center: vec3('World point [x, y, z] of the hole axis (document length unit); projected onto the flat plane.'),
    holeDiameter: z.number().describe('Bore diameter of the lip where the bend starts, in the document length unit; > 0.'),
    flangeHeight: z
      .number()
      .describe(
        'Rise of the lip free end above the flat face on the lip side, in the document length unit; must exceed lipRadius*(1-cos(angle)).',
      ),
    flangeAngle: z.number().describe('Angle the lip is bent through, in degrees: 0 < angle <= 90 (90 = cylindrical lip).'),
    lipRadius: z.number().describe('Inside (concave) radius of the bend between flat and lip, in the document length unit; > 0.'),
    direction: z
      .enum(['up', 'down'])
      .optional()
      .describe("Lip towards the flat's +normal face ('up', default) or the -normal face ('down')."),
  }),
  run: (doc, params): CommandResult => {
    const fail = refuser(doc, 'add_flanged_hole');
    const found = partContext(doc, params.id, fail);
    if (isRefusal(found)) return found.refusal;
    const { model, part, rule } = found;
    const T = rule.thickness;
    const hit = flatNear(part, T, params.face.near, 'face.near', fail);
    if (isRefusal(hit)) return hit.refusal;
    const { flat } = hit;
    const [cx, cy] = worldToFrame(flat.frame, params.center);
    const center: Vec2 = [cx, cy];
    const form: FlangedHoleForm = {
      kind: 'flanged_hole',
      center,
      holeDiameter: params.holeDiameter,
      flangeHeight: params.flangeHeight,
      angle: toRadians(params.flangeAngle),
      lipRadius: params.lipRadius,
      direction: params.direction ?? 'up',
    };
    const lip = lipGeometry(form, T);
    if (lip === null)
      return fail(
        'FTR_FORM_INVALID',
        `cannot form the lip: holeDiameter ${params.holeDiameter}, flangeHeight ${params.flangeHeight}, flangeAngle ${params.flangeAngle}, lipRadius ${params.lipRadius} give a non-positive wall length or a lip across the hole axis`,
        `Use sizes > 0, 0 < flangeAngle <= 90, flangeHeight > lipRadius*(1-cos(angle)) = ${fixed(params.lipRadius * (1 - Math.cos(form.angle)))} and a larger holeDiameter for leaning lips.`,
        { paths: ['holeDiameter', 'flangeHeight', 'flangeAngle', 'lipRadius'] },
      );
    const k = resolveK(rule, params.lipRadius);
    const developed = developedHoleRadius(lip, form, k.value, T);
    if (!(developed > 1e-6))
      return fail(
        'FTR_FORM_INVALID',
        `the developed hole radius ${fixed(developed)} is not positive: the lip needs more material than the hole provides`,
        'Reduce flangeHeight or lipRadius, or enlarge holeDiameter.',
        { paths: ['flangeHeight', 'lipRadius', 'holeDiameter'] },
      );
    const disc = circlePolygon(center, lip.cutRadius);
    const crowded =
      !discClear(flat, center, lip.cutRadius, 1e-6) ||
      beadFootprints(formsOf(part), flat.id, T).some((footprint) => !polygonDistanceAtLeast(footprint, center, lip.cutRadius + 1e-6));
    if (crowded)
      return fail(
        'FTR_CUTOUT_INVALID',
        `the ${fixed(2 * lip.cutRadius)} diameter hole of the lip does not fit clear of the outline, bends, cutouts and beads of ${flat.id}`,
        'Move the centre inward or reduce holeDiameter / lipRadius.',
        { ids: [part.id, flat.id], paths: ['center', 'holeDiameter'] },
      );
    const formId = nextNodeId(part, 'm');
    const nextPart = withNodes(part, [
      { ...flat, cutouts: [...flat.cutouts, { points: disc, circle: { center, radius: lip.cutRadius }, form: formId }] },
      { id: formId, type: 'form', on: flat.id, form },
    ]);
    const next = withFoldedSolid(withModel(doc, withPart(model, nextPart)), nextPart, rule);
    const world = frameToWorld(flat.frame, center);
    return {
      ...changed(
        next,
        `add_flanged_hole: part "${part.id}" flanged hole ${formId} on ${flat.id} at [${fixed(world[0])}, ${fixed(world[1])}, ${fixed(world[2])}]: bore ${fixed(params.holeDiameter)}, lip ${fixed(params.flangeHeight)} high at ${params.flangeAngle} degrees ${form.direction}, R=${fixed(params.lipRadius)}; physical hole diameter ${fixed(2 * lip.cutRadius)}, flat cut diameter ${fixed(2 * developed)} (APPROXIMATE, unverified stretch-flange model).`,
        [part.id],
      ),
      data: {
        formId,
        flat: flat.id,
        cutRadius: lip.cutRadius,
        wallLength: lip.wall,
        lipVolume: lipVolume(form, T),
        flatCutDiameter: {
          value: 2 * developed,
          source: FLANGED_HOLE_SOURCE,
          defaulted: false,
          verification: 'unverified',
          approximate: true,
        },
        kFactor: { value: k.value, source: k.source, defaulted: false, verification: k.verification },
      },
    };
  },
});
