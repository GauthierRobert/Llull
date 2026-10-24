import type { CadDocument, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { type CageState, cageState } from '../../geometry/subd/cageState';
import { slideChain } from '../../geometry/subd/cageOps';
import { type EdgeRef, isRefProblem, resolveEdges } from '../../geometry/subd/elements';
import { edgeLoop } from '../../geometry/subd/loops';
import { symmetrize } from '../../geometry/subd/symmetry';
import { buildTopology } from '../../geometry/subd/topology';
import { dirRejection } from './codes';
import { edgeRefField, isEntity, subdivisionOf } from './shared';
import { finishedCage, isCommandResult, topologyResult } from './topologyResult';

const COMMAND = 'slide_cage_edges';

/**
 * @affects modifies 1 subdivision entity (the loop's vertices move along the rung edges that cross it; topology, ids and sharpness unchanged)
 * @invariant each vertex moves by |factor| of its rung edge towards the left (+) or right (-) of the loop's direction a->b seen from outside; a plane-symmetric slide stays symmetric
 * @failure missing id (DIR_ENTITY_NOT_FOUND), unknown / wrong-kind edge (DIR_REF_LOST / DIR_ELEMENT_KIND), factor outside -1..1 or 0 (DIR_SLIDE_RANGE), a loop vertex without a face on the sliding side (DIR_SLIDE_LOOP_INVALID), broken symmetry (DIR_SYMMETRY_BROKEN) -> no-op
 */
export const slideCageEdges = defineCommand({
  name: COMMAND,
  description:
    'Slide an edge loop of a quad subdivision cage along the cage without changing its topology: `edges` ({ loopFrom: edge } or a list; an edge is an id "e:<idA>|<idB>" or [a, b] vertex indices) names ' +
    'any edge of the loop (it continues straight through valence-4 vertices, as select_cage_elements loopFrom shows). Every loop vertex moves along the ' +
    "edge that crosses the loop at it by |factor| of that edge's length: factor 0.5 halfway to the neighbour, 1 onto it. A positive factor slides towards " +
    'the LEFT of the direction a -> b seen from outside the solid, a negative one towards the right. Use it to shift a loop cut sideways. A symmetric cage ' +
    'keeps its symmetry. Refuses a factor outside -1..1 or 0 (DIR_SLIDE_RANGE) and a loop with a vertex that has no face on the sliding side ' +
    '(DIR_SLIDE_LOOP_INVALID). Returns data { vertexCount, faceCount, vertices, vertexIds, faceIds, slid }. Next: edit_subdivision_cage, check_subdivision.',
  params: z.object({
    id: z.string().describe('Id of the subdivision solid.'),
    edges: z
      .union([
        z.object({ loopFrom: edgeRefField.describe('Any edge of the loop, directed first -> second vertex as written.') }),
        z.array(edgeRefField).min(1),
      ])
      .describe(
        'The loop to slide: { loopFrom: edge } or a list of edges (the loop through the FIRST one). An edge is an id "e:<idA>|<idB>" or [a, b] vertex indices.',
      ),
    factor: z
      .number()
      .describe(
        'Fraction -1..1 of the rung edge length: positive = towards the left of a -> b seen from outside, negative = towards the right. Not 0.',
      ),
  }),
  run: (doc: CadDocument, params): CommandResult => {
    const entity = subdivisionOf(doc, params.id, COMMAND);
    if (!isEntity(entity)) return entity;
    const reject = (code: string, message: string, path: string[] = []): CommandResult =>
      dirRejection(doc, COMMAND, code, message, [entity.id], path);
    const { factor } = params;
    if (!Number.isFinite(factor) || factor === 0 || Math.abs(factor) > 1)
      return reject('DIR_SLIDE_RANGE', `factor must be within -1..1 and not 0 (got ${factor})`, ['params.factor']);
    const topology = buildTopology(entity.vertices.length, entity.faces);
    const given = Array.isArray(params.edges) ? params.edges[0] : params.edges.loopFrom;
    const picked = resolveEdges(entity, [given as EdgeRef], 'params.edges', topology);
    if (isRefProblem(picked)) return reject(picked.code, picked.message, [picked.path]);
    const [a, b] =
      typeof given === 'string'
        ? (given
            .slice(2)
            .split('|')
            .map((vertexId) => entity.elementIds.vertices.indexOf(vertexId)) as [number, number])
        : (given as [number, number]);
    const state: CageState = cageState(entity);
    const chain = edgeLoop(topology, a, b);
    const problem = slideChain(state, topology, chain, factor);
    if (problem !== null) return reject('DIR_SLIDE_LOOP_INVALID', problem.message, ['params.edges']);
    if (entity.symmetry !== undefined) {
      const weights = entity.vertices.map((_, v) => (chain.some(([x, y]) => x === v || y === v) ? 1 : 0));
      state.vertices.splice(0, state.vertices.length, ...symmetrize(entity.vertices, state.vertices, weights, entity.symmetry));
    }
    const updated = finishedCage(doc, COMMAND, entity, state);
    if (isCommandResult(updated)) return updated;
    const slid = [...new Set(chain.flatMap(([x, y]) => [x, y]))].map((v) => entity.elementIds.vertices[v]);
    const moved = state.vertices.filter((p, v) => (p as Vec3).some((x, i) => x !== (entity.vertices[v] as Vec3)[i])).length;
    return topologyResult(
      doc,
      COMMAND,
      updated,
      `loop of ${chain.length} edge(s) slid by ${factor} (${moved} vertex(es) moved)`,
      { slid },
      picked.byIndex ? { edges: { loopFrom: picked.ids[0] } } : null,
    );
  },
});
