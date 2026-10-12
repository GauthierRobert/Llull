import { type CadDocument, type SubdivisionEntity, type Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { colorField, defineCommand, vec3, z, layerIdField, nameField } from '../schema';
import { noop } from '../noop';
import { centroid3, distance3, sub3 } from '../../lib/vec3';
import { newEntity } from '../entity/newEntity';
import {
  DEFAULT_SOLID_COLOR,
  commitSolid,
  existingLayerOrDefault,
  explicitIdField,
  explicitIdOrNext,
  explicitIdTaken,
} from './shared';
import { sketchPath } from './sketchCurves';
import { catmullRomBeziers, sampleChain } from '../../geometry/curveSegments';
import { boundaryPatchCage, coonsSides } from '../../geometry/boundaryPatch';
import { cageProblem } from '../../geometry/subdivision';
import { cageData, cageText, levelsField, sizeProblem } from './subdivision';

const MAX_PATCH_CELLS = 24;

/** Dense polylines of the boundary curves (inline points or 2D sketch curves), or an error. */
function boundaryPolylines(
  doc: CadDocument,
  curves: Vec3[][] | undefined,
  curveIds: string[] | undefined,
): Vec3[][] | string {
  if ((curves === undefined) === (curveIds === undefined))
    return 'give exactly one of curves or curveIds';
  if (curves !== undefined) {
    if (curves.some((points) => points.length < 2)) return 'every curve needs at least 2 points';
    return curves.map((points) =>
      points.length === 2 ? points : sampleChain(catmullRomBeziers(points, false), false),
    );
  }
  const polylines: Vec3[][] = [];
  for (const id of curveIds ?? []) {
    const chain = sketchPath(doc, id);
    if (typeof chain === 'string') return chain;
    polylines.push(sampleChain(chain, false));
  }
  return polylines;
}

/**
 * @command surface_from_curves
 * @pure
 * @layer core/commands
 * @affects creates 1 subdivision entity (a thickened boundary patch) at the patch centre
 * @invariant 2 opposite curves or 4 curves closing a loop; cells 1..24 per direction; thickness > 0
 * @failure wrong curve count / open loop / degenerate patch / bad sizes / duplicate id -> no-op
 */
export const surfaceFromCurves = defineCommand({
  name: 'surface_from_curves',
  description:
    'Create a freeform shell part from boundary curves — hoods, fairings, fenders, panels, saddle ' +
    'tops, aero covers. Give 4 curves that close a loop (any order or direction; ends must meet) for a ' +
    'Coons patch spanning them, or 2 opposite curves for a surface ruled between them. Curves are ' +
    '`curves` (each 2+ world points; 3+ points pass a smooth curve through them) or `curveIds` (2D ' +
    'sketch curves — line, arc, polyline, spline — each in its own plane). The surface is thickened by ' +
    '`thickness` behind its front side (flip: in front) into a closed solid with a sharp rim, stored as ' +
    'a subdivision solid: reshape it with edit_subdivision_cage; with the OCC kernel it is an exact ' +
    'B-spline solid (STEP). The smooth surface follows the curves within the smoothing of a ' +
    '`cells` grid (more cells = closer). Returns data { vertexCount, faceCount, vertices }.',
  params: z.object({
    curves: z
      .array(z.array(vec3('Curve point [x, y, z] in world coordinates.')))
      .describe('2 or 4 boundary curves as world point lists (alternative to curveIds).')
      .optional(),
    curveIds: z
      .array(z.string())
      .describe('2 or 4 ids of 2D sketch curves bounding the patch (alternative to curves).')
      .optional(),
    thickness: z.number().describe('Wall thickness in document units (> 0).'),
    flip: z
      .boolean()
      .describe('Thicken toward the other side of the surface (default false).')
      .optional(),
    cells: z
      .tuple([z.number().int(), z.number().int()])
      .describe(
        `Cage cells [along the first curve, across] (1..${MAX_PATCH_CELLS} each; default [8, 8]).`,
      )
      .optional(),
    levels: levelsField.optional(),
    layerId: layerIdField(),
    color: colorField(DEFAULT_SOLID_COLOR),
    name: nameField(),
    id: explicitIdField(),
  }),
  run: (doc, params): CommandResult => {
    const fail = (why: string): CommandResult => noop(doc, `surface_from_curves: ${why}; no-op.`);
    const { thickness, flip = false, cells = [8, 8], levels = 2, layerId, name } = params;
    const explicitId = params.id;
    if (explicitIdTaken(doc, explicitId)) return fail(`entity id "${explicitId}" already exists`);
    if (!(thickness > 0)) return fail(`thickness must be > 0 (got ${thickness})`);
    if (!cells.every((n) => Number.isInteger(n) && n >= 1 && n <= MAX_PATCH_CELLS))
      return fail(`cells must be integers 1..${MAX_PATCH_CELLS}`);
    const polylines = boundaryPolylines(doc, params.curves, params.curveIds);
    if (typeof polylines === 'string') return fail(polylines);
    const points = polylines.flat();
    const extent = points.reduce((size, p) => Math.max(size, distance3(p, points[0] as Vec3)), 0);
    const sides = coonsSides(polylines, Math.max(extent * 1e-4, 1e-9));
    if (typeof sides === 'string') return fail(sides);
    const cage = boundaryPatchCage(sides, cells[0], cells[1], thickness, flip);
    if (typeof cage === 'string') return fail(cage);
    const problem = sizeProblem(cage, levels) ?? cageProblem(cage);
    if (problem !== null) return fail(problem);
    const origin = centroid3(cage.vertices);
    const id = explicitIdOrNext(explicitId, 'subd');
    const entity = newEntity(
      'subdivision',
      id,
      {
        vertices: cage.vertices.map((p) => sub3(p, origin)),
        faces: cage.faces,
        creases: cage.creases,
        levels,
      },
      origin,
      params.color ?? DEFAULT_SOLID_COLOR,
      {
        name,
        layerId: existingLayerOrDefault(doc, layerId),
      },
    ) as SubdivisionEntity;
    const result = commitSolid(
      doc,
      entity,
      `surface_from_curves: created "${id}" from ${polylines.length} curves, ${thickness} thick (${cageText(cage, levels)})`,
    );
    return { ...result, data: cageData(entity) };
  },
});
