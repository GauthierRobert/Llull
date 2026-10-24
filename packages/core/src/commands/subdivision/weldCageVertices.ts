import type { CadDocument, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { distance3 } from '../../lib/vec3';
import { cageProblem } from '../../geometry/subdivision';
import { cageState } from '../../geometry/subd/cageState';
import { weldClusters } from '../../geometry/subd/cageOps';
import { isRefProblem, resolveVertices } from '../../geometry/subd/elements';
import { closeVerticesUnderSymmetry, mirrorGroup } from '../../geometry/subd/symmetry';
import { dirRejection } from './codes';
import { isEntity, subdivisionOf, vertexRefField } from './shared';
import { finishedCage, isCommandResult, topologyResult } from './topologyResult';

const COMMAND = 'weld_cage_vertices';

/** Groups of `vertices` closer than `tolerance` (single linkage), only the groups of two or more. */
function nearClusters(positions: ReadonlyArray<Vec3>, vertices: readonly number[], tolerance: number): number[][] {
  const parent = new Map(vertices.map((v) => [v, v]));
  const find = (v: number): number => {
    const p = parent.get(v) as number;
    if (p === v) return v;
    const root = find(p);
    parent.set(v, root);
    return root;
  };
  vertices.forEach((a, i) =>
    vertices.slice(i + 1).forEach((b) => {
      if (distance3(positions[a] as Vec3, positions[b] as Vec3) <= tolerance) parent.set(find(a), find(b));
    }),
  );
  const groups = new Map<number, number[]>();
  for (const v of vertices) groups.set(find(v), [...(groups.get(find(v)) ?? []), v]);
  return [...groups.values()].filter((group) => group.length > 1);
}

/**
 * @affects modifies 1 subdivision entity (clusters of vertices merged into their lowest-index member; faces lose repeated vertices and vanish below 3; sharpness follows the merge)
 * @invariant the result is a valid 2-manifold cage; the survivor keeps its id and sits at the first vertex (or the cluster centre with toCentre); on a symmetric cage the mirror clusters weld too
 * @failure missing id (DIR_ENTITY_NOT_FOUND), unknown / wrong-kind vertex (DIR_REF_LOST / DIR_ELEMENT_KIND), fewer than two vertices or nothing within tolerance (DIR_NOTHING_TO_DO), non-manifold result (DIR_WELD_NONMANIFOLD), broken symmetry (DIR_SYMMETRY_BROKEN) -> no-op
 */
export const weldCageVertices = defineCommand({
  name: COMMAND,
  description:
    'Merge cage vertices into one: without `tolerance` all given `vertices` become a single vertex; with `tolerance` (document units) only vertices closer ' +
    'than that to each other merge (clusters). The survivor is the lowest-index vertex of the cluster and keeps its id; it stays where it is, or moves to ' +
    'the cluster centre with `toCentre`. Faces that touch the cluster lose the repeated corner (a quad becomes a triangle, a digon disappears); sharp ' +
    'edges and corners follow. Use it to collapse an edge, to stitch two boundary edges of an open cage, or to clean a cage. A symmetric cage welds the ' +
    'mirror clusters too. Refuses a weld that makes the surface non-manifold (DIR_WELD_NONMANIFOLD, e.g. opposite corners of a cube). Returns data ' +
    '{ vertexCount, faceCount, vertices, vertexIds, faceIds, welded, removedVertices, removedFaces }. Next: check_subdivision.',
  params: z.object({
    id: z.string().describe('Id of the subdivision solid.'),
    vertices: z.array(vertexRefField).min(2).describe('Vertices to merge, as ids or indices (at least 2).'),
    tolerance: z
      .number()
      .min(0)
      .describe('Document units: merge only vertices at most this far apart (clusters). Omit to merge all given vertices into one.')
      .optional(),
    toCentre: z
      .boolean()
      .describe('true: the merged vertex moves to the centre of its cluster. Default false (it stays at the first vertex).')
      .optional(),
  }),
  run: (doc: CadDocument, params): CommandResult => {
    const entity = subdivisionOf(doc, params.id, COMMAND);
    if (!isEntity(entity)) return entity;
    const reject = (code: string, message: string, path: string[] = []): CommandResult =>
      dirRejection(doc, COMMAND, code, message, [entity.id], path);
    const named = resolveVertices(entity, params.vertices, 'params.vertices');
    if (isRefProblem(named)) return reject(named.code, named.message, [named.path]);
    const chosen = [...new Set(named.items)].sort((a, b) => a - b);
    const group = entity.symmetry === undefined ? undefined : mirrorGroup(entity.symmetry);
    const clusters: number[][] =
      params.tolerance === undefined
        ? chosen.length > 1
          ? [
              ...new Map(
                (group ?? [{ map: null }]).map((image) => {
                  const mapped = chosen.map((v) => (image.map === null ? v : (image.map[v] as number))).sort((a, b) => a - b);
                  return [mapped.join(','), [...new Set(mapped)]] as [string, number[]];
                }),
              ).values(),
            ].filter((cluster) => cluster.length > 1)
          : []
        : nearClusters(
            entity.vertices,
            entity.symmetry === undefined ? chosen : closeVerticesUnderSymmetry(chosen, entity.symmetry),
            params.tolerance,
          );
    const disjoint = clusters.every((cluster, i) => clusters.slice(i + 1).every((other) => !cluster.some((v) => other.includes(v))));
    if (clusters.length === 0)
      return reject('DIR_NOTHING_TO_DO', 'no two of the given vertices are distinct and within tolerance', ['params.vertices']);
    if (!disjoint)
      return reject('DIR_WELD_NONMANIFOLD', 'a vertex and its mirror image are in the same cluster: weld them explicitly', [
        'params.vertices',
      ]);
    const state = cageState(entity);
    const removed = weldClusters(state, clusters, params.toCentre === true);
    const problem = cageProblem({
      vertices: state.vertices,
      faces: state.faces,
      creases: [],
      ...(entity.boundary === undefined ? {} : { boundary: entity.boundary }),
    });
    if (problem !== null)
      return reject('DIR_WELD_NONMANIFOLD', `the merge would give a non-manifold cage: ${problem}`, ['params.vertices']);
    const updated = finishedCage(doc, COMMAND, entity, state);
    if (isCommandResult(updated)) return updated;
    const keptV = new Set(updated.elementIds.vertices);
    const keptF = new Set(updated.elementIds.faces);
    return topologyResult(
      doc,
      COMMAND,
      updated,
      `${clusters.length} cluster(s) welded (${removed.vertices} vertex(es) and ${removed.faces} face(s) removed)`,
      {
        welded: clusters.map((cluster) => cluster.map((v) => entity.elementIds.vertices[v])),
        removedVertices: entity.elementIds.vertices.filter((id) => !keptV.has(id)),
        removedFaces: entity.elementIds.faces.filter((id) => !keptF.has(id)),
      },
      named.byIndex ? { vertices: named.ids } : null,
    );
  },
});
