import type { CadDocument, SubdivisionEntity } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed } from '../noop';
import { replaceEntity } from '../entity/entityOps';
import { type EdgeRef, edgeIdOf, isRefProblem, resolveEdges, resolveVertices } from '../../geometry/subd/elements';
import { edgeKey } from '../../geometry/subd/edgeKey';
import { edgeLoop } from '../../geometry/subd/loops';
import { SHARP_MAX, edgeSharpnessMap, partitionSharpness } from '../../geometry/subd/sharpness';
import { closeVerticesUnderSymmetry, mirrorGroup } from '../../geometry/subd/symmetry';
import { buildTopology } from '../../geometry/subd/topology';
import { dirRejection } from './codes';
import { edgeRefField, isEntity, subdivisionOf, vertexRefField } from './shared';

const COMMAND = 'set_cage_crease';

/**
 * @affects modifies 1 subdivision entity (edge sharpness, corner sharpness, crease method)
 * @invariant sharpness is stored exactly (0 removes, 10 is infinite); on a symmetric cage the mirror images of the edges / vertices get the same value
 * @failure missing id (DIR_ENTITY_NOT_FOUND), sharpness outside 0..10 (DIR_SHARPNESS_RANGE), unknown element (DIR_REF_LOST), id of the wrong kind (DIR_ELEMENT_KIND), no edge / vertex / method given -> no-op
 */
export const setCageCrease = defineCommand({
  name: COMMAND,
  description:
    'Set crease sharpness on a subdivision solid: `edges` (ids "e:<idA>|<idB>" or [a, b] index pairs, the string "all", or { loopFrom: edge } ' +
    'for the whole edge loop through that edge) and/or `vertices` (corner sharpness) get `sharpness` 0..10: 0 smooth (removes the crease), ' +
    '1 crisp for one subdivision level, 2 for two levels, 10 infinitely sharp. Fractional values blend (0.5 = half crisp). `method` ' +
    '"uniform" (default) lowers sharpness by 1 per level, "chaikin" smooths the decay. Mirror images follow when the cage has symmetry. ' +
    'Returns data { sharpness, edges (ids), vertices (ids) }. Next: check_subdivision, mass_properties.',
  params: z.object({
    id: z.string().describe('Id of the subdivision solid.'),
    edges: z
      .union([
        z.literal('all'),
        z.array(edgeRefField),
        z.object({ loopFrom: edgeRefField.describe('An edge of the loop; the loop continues straight through valence-4 vertices.') }),
      ])
      .describe('Edges to set: a list, "all", or { loopFrom }.')
      .optional(),
    vertices: z
      .array(vertexRefField)
      .describe('Cage vertices whose corner sharpness is set (they stay point-like for about that many levels).')
      .optional(),
    sharpness: z.number().describe('Sharpness 0..10: 0 smooth, 1 one level crisp, 10 infinitely sharp.'),
    method: z.enum(['uniform', 'chaikin']).describe('Decay of sharpness per level (entity-wide): uniform (default) or chaikin.').optional(),
  }),
  run: (doc: CadDocument, params): CommandResult => {
    const entity = subdivisionOf(doc, params.id, COMMAND);
    if (!isEntity(entity)) return entity;
    const reject = (code: string, message: string, path: string[] = []): CommandResult =>
      dirRejection(doc, COMMAND, code, message, [entity.id], path);
    const { sharpness, edges, vertices } = params;
    if (!(sharpness >= 0 && sharpness <= SHARP_MAX))
      return reject('DIR_SHARPNESS_RANGE', `sharpness ${sharpness} is outside 0..${SHARP_MAX}`, ['params.sharpness']);
    if (edges === undefined && vertices === undefined && params.method === undefined)
      return reject('DIR_NOTHING_TO_DO', 'give edges, vertices or method');
    const topology = buildTopology(entity.vertices.length, entity.faces);
    let pairs: Array<readonly [number, number]> = [];
    let record: Record<string, unknown> | null = null;
    if (edges === 'all') pairs = topology.edges.map((edge) => [edge.a, edge.b]);
    else if (edges !== undefined && !Array.isArray(edges)) {
      const start = resolveEdges(entity, [(edges as { loopFrom: EdgeRef }).loopFrom], 'params.edges.loopFrom', topology);
      if (isRefProblem(start)) return reject(start.code, start.message, [start.path]);
      const edge = topology.edges[start.items[0] as number] as { a: number; b: number };
      pairs = edgeLoop(topology, edge.a, edge.b);
      if (start.byIndex) record = { edges: { loopFrom: start.ids[0] } };
    } else if (edges !== undefined) {
      const named = resolveEdges(entity, edges as EdgeRef[], 'params.edges', topology);
      if (isRefProblem(named)) return reject(named.code, named.message, [named.path]);
      pairs = named.items.map((e) => [(topology.edges[e] as { a: number }).a, (topology.edges[e] as { b: number }).b]);
      if (named.byIndex) record = { edges: named.ids };
    }
    const corners = resolveVertices(entity, vertices ?? [], 'params.vertices');
    if (isRefProblem(corners)) return reject(corners.code, corners.message, [corners.path]);
    if (corners.byIndex) record = { ...record, vertices: corners.ids };
    if (pairs.length === 0 && corners.items.length === 0 && params.method === undefined)
      return reject('DIR_NOTHING_TO_DO', 'no edge or vertex was given', ['params.edges']);
    const group = entity.symmetry === undefined ? undefined : mirrorGroup(entity.symmetry);
    const sharp = edgeSharpnessMap(entity);
    const touched = new Set<string>();
    for (const [a, b] of pairs)
      for (const image of group ?? [{ mask: 0, map: null }]) {
        const [x, y] = image.map === null ? [a, b] : [image.map[a] as number, image.map[b] as number];
        if (sharpness > 0) sharp.set(edgeKey(x, y), sharpness);
        else sharp.delete(edgeKey(x, y));
        touched.add(edgeIdOf(entity.elementIds, x, y));
      }
    const cornerSet = new Set(entity.symmetry === undefined ? corners.items : closeVerticesUnderSymmetry(corners.items, entity.symmetry));
    const kept = (entity.vertexSharpness ?? []).filter(({ v }) => !cornerSet.has(v));
    const vertexSharpness = sharpness > 0 ? [...kept, ...[...cornerSet].sort((a, b) => a - b).map((v) => ({ v, s: sharpness }))] : kept;
    const { creases, edgeSharpness } = partitionSharpness(
      [...sharp].map(([key, s]): [number, number, number] => {
        const [a, b] = key.split(':').map(Number) as [number, number];
        return [a, b, s];
      }),
    );
    const updated: SubdivisionEntity = { ...entity, creases };
    if (edgeSharpness.length > 0) updated.edgeSharpness = edgeSharpness;
    else delete updated.edgeSharpness;
    if (vertexSharpness.length > 0) updated.vertexSharpness = vertexSharpness;
    else delete updated.vertexSharpness;
    if (params.method !== undefined) updated.creaseMethod = params.method;
    const data = {
      sharpness,
      edges: [...touched],
      vertices: [...cornerSet].sort((a, b) => a - b).map((v) => entity.elementIds.vertices[v] as string),
    };
    return {
      ...changed(
        replaceEntity(doc, updated),
        `${COMMAND}: '${entity.id}' — sharpness ${sharpness} on ${data.edges.length} edge(s) and ${data.vertices.length} vertex(es)` +
          (params.method !== undefined ? `; method ${params.method}` : '') +
          `; ${creases.length} infinite and ${edgeSharpness.length} semi-sharp edge(s) now.`,
        [entity.id],
      ),
      data,
      ...(record === null ? {} : { recordExtras: record }),
    };
  },
});
