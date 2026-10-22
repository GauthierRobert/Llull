import type { CadDocument, SubdivisionEntity, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import { roundTo } from '../../lib/compactNumber';
import { sub3 } from '../../lib/vec3';
import { entityLocalToWorld } from '../../geometry/entityFrame';
import { cageVertexLimits, sampleCurvature, surfaceEvaluator } from '../../geometry/subd/limit';
import { isRefProblem, resolveFaces, resolveVertices } from '../../geometry/subd/elements';
import { buildTopology } from '../../geometry/subd/topology';
import { dirRejection } from './codes';
import { faceRefField, isEntity, subdivisionOf, vertexRefField } from './shared';

const COMMAND = 'evaluate_subdivision';
const MAX_POINTS = 10_000;
const CORNERS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

/**
 * @affects none (read-only); data = points[] { id, kind, limit, normal, rule?, valence?, k1?, k2?, depth?, approximate?, degenerate? }, extraordinary[] { id, valence }
 * @invariant limit points are on the Catmull-Clark limit surface (cage-vertex masks; uniform bicubic B-spline on regular patches); world coordinates, 1e-12 resolution
 * @failure missing id (DIR_ENTITY_NOT_FOUND), unknown element (DIR_REF_LOST), more than 10000 points (DIR_EVAL_BUDGET); a sample on an n-gon / extraordinary vertex is flagged degenerate (DIR_EVAL_DEGENERATE), not refused
 */
export const evaluateSubdivision = defineCommand({
  name: COMMAND,
  annotations: { readOnly: true },
  description:
    'Evaluate the limit surface of a subdivision solid exactly (independent of `levels`): the limit position and unit normal of cage ' +
    '`vertices` (default: all), and points at `samples` { face, u, v } (u, v in [0, 1] over a QUAD cage face, corner 0 at (0, 0), ' +
    'counter-clockwise). `curvature` adds the principal curvatures k1 >= k2 (1 / document unit, positive when convex). World coordinates. ' +
    'Each point carries its subdivision rule (smooth / crease / corner) and valence; data.extraordinary lists the cage vertices of valence ' +
    'other than 4 where continuity drops to G1. A point at an extraordinary vertex (curvature unbounded) or on an n-gon face is flagged ' +
    '`degenerate` with code DIR_EVAL_DEGENERATE. At most 10000 points. Next: check_subdivision, edit_subdivision_cage.',
  params: z.object({
    id: z.string().describe('Id of the subdivision solid.'),
    vertices: z
      .array(vertexRefField)
      .describe('Cage vertices whose limit points are returned. Default (no samples either): all.')
      .optional(),
    samples: z
      .array(
        z.object({
          face: faceRefField,
          u: z.number().min(0).max(1).describe('Parameter along the first edge of the face (0..1).'),
          v: z.number().min(0).max(1).describe('Parameter along the last edge of the face (0..1).'),
        }),
      )
      .describe('Surface samples on quad faces.')
      .optional(),
    curvature: z.boolean().describe('true: add principal curvatures k1, k2 (flagged degenerate where undefined).').optional(),
  }),
  run: (doc: CadDocument, params): CommandResult => {
    const entity = subdivisionOf(doc, params.id, COMMAND);
    if (!isEntity(entity)) return entity;
    const reject = (code: string, message: string, path: string[] = []): CommandResult =>
      dirRejection(doc, COMMAND, code, message, [entity.id], path);
    const wantAll = params.vertices === undefined && params.samples === undefined;
    const named = resolveVertices(entity, wantAll ? entity.vertices.map((_, v) => v) : (params.vertices ?? []), 'params.vertices');
    if (isRefProblem(named)) return reject(named.code, named.message, [named.path]);
    const samples = params.samples ?? [];
    const faces = resolveFaces(
      entity,
      samples.map((s) => s.face),
      'params.samples',
    );
    if (isRefProblem(faces)) return reject(faces.code, faces.message, [faces.path]);
    if (named.items.length + samples.length > MAX_POINTS)
      return reject('DIR_EVAL_BUDGET', `${named.items.length + samples.length} points requested (max ${MAX_POINTS})`, ['params.samples']);
    const origin = entityLocalToWorld(entity, [0, 0, 0]);
    const world = (p: Vec3): Vec3 => entityLocalToWorld(entity, p).map((value) => roundTo(value, 12)) as unknown as Vec3;
    const direction = (n: Vec3): Vec3 => sub3(entityLocalToWorld(entity, n), origin).map((value) => roundTo(value, 12)) as unknown as Vec3;
    const evaluator = surfaceEvaluator(entity);
    const topology = buildTopology(entity.vertices.length, entity.faces);
    const limits = cageVertexLimits(entity, named.items);
    const points: Array<Record<string, unknown>> = [];
    named.items.forEach((v, k) => {
      const limit = limits[k] as (typeof limits)[number];
      const id = named.ids[k] as string;
      const point: Record<string, unknown> = {
        id,
        kind: 'vertex',
        limit: world(limit.point),
        normal: direction(limit.normal),
        rule: limit.rule,
        valence: limit.valence,
      };
      if (params.curvature === true) Object.assign(point, vertexCurvature(entity, topology, evaluator, v));
      points.push(point);
    });
    samples.forEach((sample, k) => {
      const face = faces.items[k] as number;
      const id = `${faces.ids[k]}@${sample.u},${sample.v}`;
      const value = evaluator(face, sample.u, sample.v);
      if (value === null) {
        points.push({
          id,
          kind: 'sample',
          limit: null,
          degenerate: true,
          code: 'DIR_EVAL_DEGENERATE',
          reason: `face ${faces.ids[k]} is not a quad`,
        });
        return;
      }
      const curvature = sampleCurvature(value);
      const point: Record<string, unknown> = {
        id,
        kind: 'sample',
        limit: world(value.point),
        depth: value.depth,
        approximate: value.approximate,
        ...(curvature === null ? {} : { normal: direction(curvature.normal) }),
      };
      if (params.curvature === true)
        Object.assign(
          point,
          curvature === null
            ? { degenerate: true, code: 'DIR_EVAL_DEGENERATE' }
            : { k1: roundTo(curvature.k1, 12), k2: roundTo(curvature.k2, 12) },
        );
      points.push(point);
    });
    const extraordinary = (topology.vertexEdges as number[][]).flatMap((edges, v) =>
      edges.length === 4 ? [] : [{ id: entity.elementIds.vertices[v] as string, valence: edges.length }],
    );
    const degenerate = points.filter((p) => p['degenerate'] === true).length;
    return report(
      doc,
      `${COMMAND}: '${entity.id}' — ${points.length} point(s)` +
        (degenerate > 0 ? `, ${degenerate} flagged DIR_EVAL_DEGENERATE` : '') +
        `; ${extraordinary.length} extraordinary vertex(es).`,
      { points, extraordinary },
    );
  },
});

/** Principal curvatures at cage vertex `v`, from the incident quad that has it as a corner (flagged degenerate when none is regular there). */
function vertexCurvature(
  entity: SubdivisionEntity,
  topology: ReturnType<typeof buildTopology>,
  evaluator: ReturnType<typeof surfaceEvaluator>,
  v: number,
): Record<string, unknown> {
  const f = (topology.vertexFaces[v] as number[]).find((g) => (entity.faces[g] as ReadonlyArray<number>).length === 4);
  const corner = f === undefined ? undefined : CORNERS[(entity.faces[f] as ReadonlyArray<number>).indexOf(v)];
  const sample = f === undefined || corner === undefined ? null : evaluator(f, corner[0], corner[1]);
  const curvature = sample === null ? null : sampleCurvature(sample);
  return curvature === null
    ? { degenerate: true, code: 'DIR_EVAL_DEGENERATE', reason: 'curvature is undefined at an extraordinary or sharp vertex' }
    : { k1: roundTo(curvature.k1, 12), k2: roundTo(curvature.k2, 12) };
}
