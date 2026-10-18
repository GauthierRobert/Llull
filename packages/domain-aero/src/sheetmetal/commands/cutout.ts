import { defineCommand, z, vec3 } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed } from '@core/commands/noop';
import type { Vec2 } from '@core/model/types';
import type { SheetCutout } from '@core/model/sheetMetal';
import { pointInPolygon, polygonArea, segmentsIntersect, toCounterClockwise } from '@lib/polygon';
import { withFoldedSolid } from '../fold';
import { basisOf, frameToWorld, worldToFrame } from '../frames';
import { dot3, normalize3 } from '@lib/vec3';
import { circlePolygon, isSimplePolygon } from '../geometry2d';
import { withModel, withNodes, withPart } from '../graph';
import { readProfile } from '../profile';
import { fixed, refuser } from '../result';
import { partContext, isRefusal, flatNear } from '../partLookup';

const crosses = (a: readonly Vec2[], b: readonly Vec2[]): boolean =>
  a.some((p, i) => b.some((q, j) => segmentsIntersect(p, a[(i + 1) % a.length] as Vec2, q, b[(j + 1) % b.length] as Vec2)));

const inside = (inner: readonly Vec2[], outer: readonly Vec2[]): boolean =>
  inner.every((point) => pointInPolygon(point, outer)) && !crosses(inner, outer);

/**
 * @affects adds a cutout to one flat of the part and re-derives its folded solid; the profile entity stays
 * @invariant the cutout is projected normal to the flat, stored in flat-local coordinates (so it appears in the flat pattern) and lies wholly inside the flat outline
 * @failure unknown part, profile not a closed rectangle/polyline/circle, no flat at face.near (FTR_FACE_NOT_FOUND), cutout crossing the outline or another cutout (FTR_CUTOUT_INVALID) -> rejected with error.code
 */
export const addSheetCutout = defineCommand({
  name: 'add_sheet_cutout',
  description:
    'Cut a hole through ONE flat of a sheet-metal part. Give the shape ONE of three ways: `profileId` (a closed rectangle / closed polyline / circle drawn earlier on a plane PARALLEL to the flat), ' +
    'or `circle` { center, radius }, or `polygon` { points } given directly as WORLD points [x, y, z] that are projected normal onto the flat (no drawing needed; this is the way to cut a flange, whose plane is vertical or tilted: ' +
    'e.g. on a flange standing on the y = 0 edge of a part, with face.near [100, 0, 20], circle center [100, 0, 20] radius 4 cuts a hole 20 above the bend). ' +
    'A drawn profile on a flange needs its plane rotated onto the flange (rotate_entity, radians); circle/polygon avoid that. The cut is normal to the flat: the shape is projected onto the flat picked by the world point `face.near` ' +
    "(any point on or within one thickness of the flat), stored in the flat's own coordinates and appears as a cutout (CIRCLE for a circle) in flat_pattern and the DXF. " +
    'The profile must lie wholly inside that flat and not touch other cutouts. All lengths are in the document length unit. ' +
    'Refusals: FTR_PART_NOT_FOUND, FTR_PROFILE_NOT_CLOSED, FTR_FACE_NOT_FOUND, FTR_CUTOUT_INVALID. Next: check_sheet_metal (hole-to-bend and hole-to-edge distances), flat_pattern.',
  params: z.object({
    id: z.string().describe('Sheet-metal part id (returned by add_sheet_metal_base).'),
    face: z.object({ near: vec3('World point [x, y, z] on or near the flat to cut (document length unit).') }).describe('Flat selector.'),
    profileId: z
      .string()
      .optional()
      .describe(
        'Id of a closed 2D profile entity (rectangle, closed polyline or circle) on a plane parallel to the flat. Omit when giving circle or polygon.',
      ),
    circle: z
      .object({
        center: vec3('World point [x, y, z] of the hole axis (document length unit); projected onto the flat plane.'),
        radius: z.number().describe('Hole radius in the document length unit; > 0.'),
      })
      .optional()
      .describe('Round hole in world coordinates, projected normal onto the picked flat. Use instead of profileId.'),
    polygon: z
      .object({
        points: z
          .array(vec3('World point [x, y, z] of a vertex (document length unit); projected onto the flat plane.'))
          .min(3)
          .describe('Polygon vertices as world points [x, y, z] (3 or more).'),
      })
      .optional()
      .describe(
        'Closed polygon (3+ vertices, any winding) in world coordinates, projected normal onto the picked flat. Use instead of profileId.',
      ),
  }),
  run: (doc, { id, face, profileId, circle: circleInput, polygon }): CommandResult => {
    const fail = refuser(doc, 'add_sheet_cutout');
    const found = partContext(doc, id, fail);
    if (isRefusal(found)) return found.refusal;
    const { model, part, rule } = found;
    const given = [profileId, circleInput, polygon].filter((value) => value !== undefined).length;
    if (given !== 1)
      return fail('FTR_PARAM_INVALID', `give exactly one of profileId, circle, polygon (got ${given})`, 'Pass one shape.', {
        paths: ['profileId', 'circle', 'polygon'],
      });
    const entity = profileId === undefined ? undefined : doc.entities[profileId];
    if (profileId !== undefined && entity === undefined)
      return fail('FTR_PARAM_INVALID', `no entity "${profileId}"`, 'Draw the profile first.', { paths: ['profileId'] });
    const loop = entity === undefined ? undefined : readProfile(entity);
    if (typeof loop === 'string')
      return fail('FTR_PROFILE_NOT_CLOSED', loop, 'Pass a closed, simple 2D profile: a rectangle, closed polyline or circle.', {
        ids: [profileId ?? ''],
        paths: ['profileId'],
      });
    const hit = flatNear(part, rule.thickness, face.near, 'face.near', fail);
    if (isRefusal(hit)) return hit.refusal;
    const { flat } = hit;
    const shapeIds = profileId === undefined ? [id, flat.id] : [id, flat.id, profileId];
    if (loop !== undefined && Math.abs(dot3(normalize3(loop.frame.normal), basisOf(flat.frame).z)) < 1 - 1e-6)
      return fail(
        'FTR_CUTOUT_INVALID',
        'the profile plane is not parallel to the picked flat',
        'Draw the profile on a plane parallel to the flat (same orientation), or pass circle / polygon in world coordinates instead (projected onto the flat; no rotation needed).',
        { ids: shapeIds },
      );
    const planar = (world: readonly [number, number, number]): Vec2 => {
      const [x, y] = worldToFrame(flat.frame, world);
      return [x, y];
    };
    const project = (point: Vec2): Vec2 => (loop === undefined ? point : planar(frameToWorld(loop.frame, point)));
    const circle =
      circleInput !== undefined
        ? { center: planar(circleInput.center), radius: circleInput.radius }
        : loop?.circle === undefined
          ? undefined
          : { center: project(loop.circle.center), radius: loop.circle.radius };
    const points =
      circle !== undefined
        ? circlePolygon(circle.center, circle.radius)
        : toCounterClockwise(polygon !== undefined ? polygon.points.map(planar) : (loop?.points ?? []).map(project));
    if (!isSimplePolygon(points) || polygonArea(points) < 1e-9)
      return fail(
        'FTR_CUTOUT_INVALID',
        'the projected profile is degenerate (is the profile parallel to the flat?)',
        'Draw the profile on a plane parallel to the flat.',
        { ids: profileId === undefined ? [id] : [profileId] },
      );
    if (!inside(points, flat.outline))
      return fail(
        'FTR_CUTOUT_INVALID',
        'the cutout is not wholly inside the picked flat',
        'Move the profile inside the flat (bend zones cannot be cut) or pick the right flat.',
        { ids: shapeIds },
      );
    if (
      flat.cutouts.some(
        (other) =>
          crosses(points, other.points) ||
          points.some((p) => pointInPolygon(p, other.points)) ||
          other.points.some((p) => pointInPolygon(p, points)),
      )
    )
      return fail('FTR_CUTOUT_INVALID', 'the cutout overlaps an existing cutout', 'Move the profile away from the other cutout.', {
        ids: shapeIds,
      });
    const cutout: SheetCutout = { points, ...(circle !== undefined ? { circle } : {}) };
    const nextPart = withNodes(part, [{ ...flat, cutouts: [...flat.cutouts, cutout] }]);
    const next = withFoldedSolid(withModel(doc, withPart(model, nextPart)), nextPart, rule);
    return changed(
      next,
      `add_sheet_cutout: part "${id}" flat ${flat.id} cut ${circle !== undefined ? `circle R=${fixed(circle.radius)} at [${fixed(circle.center[0])}, ${fixed(circle.center[1])}]` : `${points.length}-vertex profile`} (${flat.cutouts.length + 1} cutout(s) on the flat).`,
      [id],
    );
  },
});
