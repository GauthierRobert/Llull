import type { CadDocument, SubdivisionEntity, Vec3 } from '../../model/types';
import type { CageSymmetry } from '../../model/subdivisionCage';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed } from '../noop';
import { replaceEntity } from '../entity/entityOps';
import {
  type SymmetryAxis,
  mirrorPoint,
  projectToPlane,
  pairVertices,
  symmetricTopologyProblem,
  symmetryDeviation,
} from '../../geometry/subd/symmetry';
import { dirRejection } from './codes';
import { isEntity, subdivisionOf } from './shared';

const COMMAND = 'set_cage_symmetry';

/** Bounding-box diagonal of the cage (the unit of the default pairing tolerance). */
function cageSize(vertices: ReadonlyArray<Vec3>): number {
  const spans = [0, 1, 2].map((axis) => {
    const values = vertices.map((p) => p[axis] as number);
    return Math.max(...values) - Math.min(...values);
  });
  return Math.hypot(...spans);
}

/** Positions with every mirror pair of `plane` made exact (mean of the pair), and on-plane vertices projected onto the plane. */
function snapped(vertices: ReadonlyArray<Vec3>, plane: SymmetryAxis, partner: readonly number[]): Vec3[] {
  return vertices.map((p, v): Vec3 => {
    const w = partner[v] as number;
    if (w < 0) return p;
    if (w === v) return projectToPlane(p, plane);
    const other = mirrorPoint(vertices[w] as Vec3, plane);
    return [(p[0] + other[0]) / 2, (p[1] + other[1]) / 2, (p[2] + other[2]) / 2];
  });
}

/**
 * @affects modifies 1 subdivision entity (`symmetry`; positions when `snap`)
 * @invariant every vertex has a mirror image within `tolerance` for each plane; every face maps to a face; the partners are stored on the entity
 * @failure missing id (DIR_ENTITY_NOT_FOUND), unmatched vertices (DIR_SYMMETRY_UNPAIRED, lists them), unmatched faces (DIR_SYMMETRY_TOPOLOGY) -> no-op
 */
export const setCageSymmetry = defineCommand({
  name: COMMAND,
  description:
    'Declare mirror symmetry of a subdivision solid through entity-local coordinate planes at its origin (planes ["x"] mirrors x to -x). ' +
    'Every vertex is paired with its mirror image within `tolerance` (default 1e-6 x the cage diagonal); later edit_subdivision_cage, ' +
    'set_cage_crease, extrude_cage_faces, inset_cage_faces and loop_cut_cage keep the cage symmetric. `snap` true moves near-mirror ' +
    'vertices onto exact mirror positions first (use it with a larger tolerance to symmetrise a rough cage). Empty `planes` clears the ' +
    'symmetry. Refuses unpaired vertices (DIR_SYMMETRY_UNPAIRED, ids and distances in the summary) and faces without a mirror face ' +
    '(DIR_SYMMETRY_TOPOLOGY). Returns data { planes, tolerance, pairs, onPlane, maxDeviation }.',
  params: z.object({
    id: z.string().describe('Id of the subdivision solid.'),
    planes: z
      .array(z.enum(['x', 'y', 'z']))
      .max(3)
      .describe('Mirror planes (entity-local, through the origin); empty clears the symmetry.'),
    tolerance: z
      .number()
      .positive()
      .describe('Largest distance (document units) between a vertex and its mirror partner. Default 1e-6 x cage diagonal.')
      .optional(),
    snap: z
      .boolean()
      .describe('true: move paired vertices onto exact mirror positions (mean of the pair) and on-plane vertices onto the plane.')
      .optional(),
  }),
  run: (doc: CadDocument, params): CommandResult => {
    const entity = subdivisionOf(doc, params.id, COMMAND);
    if (!isEntity(entity)) return entity;
    const reject = (code: string, message: string, path: string[] = []): CommandResult =>
      dirRejection(doc, COMMAND, code, message, [entity.id], path);
    const planes = [...new Set(params.planes)] as SymmetryAxis[];
    if (planes.length === 0) {
      if (entity.symmetry === undefined) return reject('DIR_NOTHING_TO_DO', 'the cage has no symmetry to clear', ['params.planes']);
      const cleared: SubdivisionEntity = { ...entity };
      delete cleared.symmetry;
      return {
        ...changed(replaceEntity(doc, cleared), `${COMMAND}: '${entity.id}' — symmetry cleared.`, [entity.id]),
        data: { planes: [] },
      };
    }
    const tolerance = params.tolerance ?? Math.max(1e-12, 1e-6 * cageSize(entity.vertices));
    let vertices = entity.vertices;
    if (params.snap === true)
      for (const plane of planes) vertices = snapped(vertices, plane, pairVertices(vertices, [plane], tolerance).partners[0] as number[]);
    const pairing = pairVertices(vertices, planes, tolerance);
    if (pairing.unpaired.length > 0) {
      const listed = pairing.unpaired
        .slice(0, 8)
        .map(({ vertex, plane, distance }) => `${entity.elementIds.vertices[vertex]} (${plane}: ${distance.toPrecision(4)})`);
      return reject(
        'DIR_SYMMETRY_UNPAIRED',
        `${pairing.unpaired.length} vertex/plane pair(s) have no mirror partner within ${tolerance.toPrecision(3)}: ${listed.join(', ')}`,
        ['params.planes'],
      );
    }
    const symmetry: CageSymmetry = { planes, partners: pairing.partners, tolerance };
    const unmatched = symmetricTopologyProblem(entity.faces, symmetry);
    if (unmatched.length > 0)
      return reject(
        'DIR_SYMMETRY_TOPOLOGY',
        `${unmatched.length} face(s) have no mirror face: ${unmatched
          .slice(0, 8)
          .map((f) => entity.elementIds.faces[f])
          .join(', ')}`,
        ['params.planes'],
      );
    const updated: SubdivisionEntity = { ...entity, vertices, symmetry };
    const data = {
      planes,
      tolerance,
      pairs: pairing.partners.map((row) => row.filter((w, v) => w > v).length),
      onPlane: pairing.partners.map((row) => row.filter((w, v) => w === v).length),
      maxDeviation: symmetryDeviation(vertices, symmetry),
    };
    return {
      ...changed(
        replaceEntity(doc, updated),
        `${COMMAND}: '${entity.id}' — mirror planes ${planes.join(', ')}; ${data.pairs.join('/')} pair(s) per plane, max deviation ${data.maxDeviation.toExponential(2)}.`,
        [entity.id],
      ),
      data,
    };
  },
});
