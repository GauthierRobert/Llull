import type { CadDocument } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { type CageState, cageState } from '../../geometry/subd/cageState';
import { edgeKey } from '../../geometry/subd/edgeKey';
import { isRefProblem, resolveEdges } from '../../geometry/subd/elements';
import { cutRing, isRingProblem, walkRing } from '../../geometry/subd/loops';
import { mirrorGroup } from '../../geometry/subd/symmetry';
import { buildTopology } from '../../geometry/subd/topology';
import { dirRejection } from './codes';
import { edgeRefField, isEntity, subdivisionOf } from './shared';
import { finishedCage, isCommandResult, topologyResult } from './topologyResult';

const COMMAND = 'loop_cut_cage';
const MAX_CUTS = 32;

/**
 * @affects modifies 1 subdivision entity (+`cuts` vertices per crossed edge, +`cuts` quads per strip face; the first piece of each split face keeps its id)
 * @invariant the loop follows the quad strip across the picked edge until it closes; sharpness of crossed edges is inherited by both halves; the surface limit may change (the cage gains resolution)
 * @failure missing id (DIR_ENTITY_NOT_FOUND), unknown / wrong-kind edge (DIR_REF_LOST / DIR_ELEMENT_KIND), strip meets a non-quad face (DIR_LOOP_NOT_QUAD), cuts / factor out of range (DIR_LOOP_CUTS_RANGE), cage cap (DIR_CAGE_TOO_LARGE), broken symmetry (DIR_SYMMETRY_BROKEN) -> no-op
 */
export const loopCutCage = defineCommand({
  name: COMMAND,
  description:
    'Insert edge loops into a subdivision cage: `edge` (id "e:<idA>|<idB>" or [a, b] vertex indices) is an edge CROSSING the loop; the ' +
    'cut follows the strip of quads across it until it closes, adding `cuts` evenly spaced loops (default 1), or one loop at `factor` ' +
    '(0..1 from the first vertex of the pair) when cuts is 1. More resolution to shape with; new vertices lie on the old edges, so the ' +
    'cage outline is unchanged. Refuses a strip that meets an n-gon (DIR_LOOP_NOT_QUAD): cut from another edge. A symmetric cage cuts ' +
    'the mirror loops too. Returns data { vertexCount, faceCount, vertices, vertexIds, faceIds, newVertices, newFaces, stripFaces }. ' +
    'Next: edit_subdivision_cage, set_cage_crease { loopFrom }.',
  params: z.object({
    id: z.string().describe('Id of the subdivision solid.'),
    edge: edgeRefField.describe('An edge crossing the loop (each loop edge it crosses is split); id or [a, b] vertex indices.'),
    cuts: z
      .number()
      .int()
      .describe(`Number of loops to insert, 1..${MAX_CUTS} (default 1), evenly spaced along the crossed edges.`)
      .optional(),
    factor: z
      .number()
      .describe(
        'Position of a single loop along the crossed edges, 0..1 exclusive, from the first vertex of the picked edge (default 0.5). Only with cuts 1.',
      )
      .optional(),
  }),
  run: (doc: CadDocument, params): CommandResult => {
    const entity = subdivisionOf(doc, params.id, COMMAND);
    if (!isEntity(entity)) return entity;
    const reject = (code: string, message: string, path: string[] = []): CommandResult =>
      dirRejection(doc, COMMAND, code, message, [entity.id], path);
    const { cuts = 1, factor } = params;
    if (!Number.isInteger(cuts) || cuts < 1 || cuts > MAX_CUTS)
      return reject('DIR_LOOP_CUTS_RANGE', `cuts must be an integer 1..${MAX_CUTS} (got ${cuts})`, ['params.cuts']);
    if (factor !== undefined && (cuts !== 1 || !(factor > 0 && factor < 1)))
      return reject(
        'DIR_LOOP_CUTS_RANGE',
        `factor needs cuts 1 and a value strictly between 0 and 1 (got cuts ${cuts}, factor ${factor})`,
        ['params.factor'],
      );
    const topology = buildTopology(entity.vertices.length, entity.faces);
    const picked = resolveEdges(entity, [params.edge], 'params.edge', topology);
    if (isRefProblem(picked)) return reject(picked.code, picked.message, [picked.path]);
    const [a, b] =
      typeof params.edge === 'string'
        ? (params.edge
            .slice(2)
            .split('|')
            .map((vertexId) => entity.elementIds.vertices.indexOf(vertexId)) as [number, number])
        : params.edge;
    const fractions = cuts === 1 ? [factor ?? 0.5] : Array.from({ length: cuts }, (_, i) => (i + 1) / (cuts + 1));
    const state: CageState = cageState(entity);
    const stripFaces: string[] = [];
    const starts: Array<readonly [number, number]> = [[a, b]];
    if (entity.symmetry !== undefined)
      for (const image of mirrorGroup(entity.symmetry).slice(1)) starts.push([image.map[a] as number, image.map[b] as number]);
    const done = new Set<string>();
    for (const [x, y] of starts) {
      const current = buildTopology(state.vertices.length, state.faces);
      if (!current.edgeIndex.has(edgeKey(x, y)) || done.has(edgeKey(x, y))) continue;
      const forward = current.directed.has(`${x}>${y}`);
      const ring = forward ? walkRing(current, x, y) : walkRing(current, y, x);
      if (isRingProblem(ring)) return reject('DIR_LOOP_NOT_QUAD', ring.message, ['params.edge']);
      if (new Set(ring.faces).size !== ring.faces.length)
        return reject('DIR_LOOP_SELF_CROSS', 'the quad strip crosses one face twice (cut from another edge)', ['params.edge']);
      for (const [s, t] of ring.edges) done.add(edgeKey(s, t));
      stripFaces.push(...ring.faces.map((f) => state.faceIds[f] as string));
      cutRing(state, ring, forward ? fractions : fractions.map((f) => 1 - f).reverse());
    }
    const updated = finishedCage(doc, COMMAND, entity, state);
    if (isCommandResult(updated)) return updated;
    const newVertices = updated.elementIds.vertices.slice(entity.vertices.length);
    const newFaces = updated.elementIds.faces.slice(entity.faces.length);
    return topologyResult(
      doc,
      COMMAND,
      updated,
      `${cuts} loop(s) cut through ${stripFaces.length} strip face(s); +${newVertices.length} vertices, +${newFaces.length} faces`,
      { newVertices, newFaces, stripFaces },
      typeof params.edge === 'string' ? null : { edge: `e:${entity.elementIds.vertices[a]}|${entity.elementIds.vertices[b]}` },
    );
  },
});
