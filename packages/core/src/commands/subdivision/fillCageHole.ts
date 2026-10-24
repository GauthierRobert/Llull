import type { CadDocument } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { cageState } from '../../geometry/subd/cageState';
import { fillLoop } from '../../geometry/subd/cageOps';
import { boundaryLoops } from '../../geometry/subd/boundary';
import { isRefProblem, resolveEdges } from '../../geometry/subd/elements';
import { mirrorGroup } from '../../geometry/subd/symmetry';
import { buildTopology } from '../../geometry/subd/topology';
import { dirRejection } from './codes';
import { edgeRefField, isEntity, subdivisionOf } from './shared';
import { finishedCage, isCommandResult, topologyResult } from './topologyResult';

const COMMAND = 'fill_cage_hole';

/**
 * @affects modifies 1 subdivision entity (+1 n-gon face, or +n/2 quads and +1 centre vertex); the hole closes, and the cage is closed again when it was the last one
 * @invariant the new faces are wound consistently with the surrounding cage; on a symmetric cage the mirror holes are filled too
 * @failure missing id (DIR_ENTITY_NOT_FOUND), unknown / wrong-kind edge (DIR_REF_LOST / DIR_ELEMENT_KIND), edge not on a boundary (DIR_NOT_BOUNDARY), "quads" on an odd loop (DIR_FILL_ODD), broken symmetry (DIR_SYMMETRY_BROKEN) -> no-op
 */
export const fillCageHole = defineCommand({
  name: COMMAND,
  description:
    'Close a hole of an open subdivision cage: `edge` (id "e:<idA>|<idB>" or [a, b] vertex indices) is any edge of the hole boundary. mode "ngon" ' +
    '(default) adds one face over the whole loop; "quads" adds a centre vertex and n/2 quads (the loop needs an even number of edges; the centre has ' +
    'valence n/2). When the last hole closes the cage is closed again and has a volume. A symmetric cage fills the mirror holes too. Refuses an edge that ' +
    'borders two faces (DIR_NOT_BOUNDARY) and "quads" on an odd loop (DIR_FILL_ODD). Returns data { vertexCount, faceCount, vertices, vertexIds, faceIds, ' +
    'newFaces, newVertices, loopSize }. Next: set_cage_crease, edit_subdivision_cage, check_subdivision.',
  params: z.object({
    id: z.string().describe('Id of the subdivision solid.'),
    edge: edgeRefField.describe('Any edge of the hole boundary: id "e:<idA>|<idB>" or [a, b] vertex indices.'),
    mode: z
      .enum(['ngon', 'quads'])
      .describe('"ngon" (default): one face over the loop. "quads": a centre vertex and n/2 quads (even loops only).')
      .optional(),
  }),
  run: (doc: CadDocument, params): CommandResult => {
    const entity = subdivisionOf(doc, params.id, COMMAND);
    if (!isEntity(entity)) return entity;
    const reject = (code: string, message: string, path: string[] = []): CommandResult =>
      dirRejection(doc, COMMAND, code, message, [entity.id], path);
    const topology = buildTopology(entity.vertices.length, entity.faces);
    const picked = resolveEdges(entity, [params.edge], 'params.edge', topology);
    if (isRefProblem(picked)) return reject(picked.code, picked.message, [picked.path]);
    const edge = topology.edges[picked.items[0] as number] as { a: number; b: number };
    const starts: Array<readonly [number, number]> = [[edge.a, edge.b]];
    if (entity.symmetry !== undefined)
      for (const image of mirrorGroup(entity.symmetry).slice(1)) starts.push([image.map[edge.a] as number, image.map[edge.b] as number]);
    const loops = boundaryLoops(topology);
    const holeOf = ([x, y]: readonly [number, number]): number[] | undefined =>
      loops.find((candidate) =>
        candidate.some((v, i) => {
          const next = candidate[(i + 1) % candidate.length];
          return (v === x && next === y) || (v === y && next === x);
        }),
      );
    // the mirror images of a hole are holes too (a symmetric cage has symmetric topology)
    const chosen = [...new Set(starts.map(holeOf).filter((loop): loop is number[] => loop !== undefined))];
    if (holeOf(starts[0] as readonly [number, number]) === undefined)
      return reject('DIR_NOT_BOUNDARY', `edge ${edge.a}-${edge.b} borders two faces: it is not on a boundary loop`, ['params.edge']);
    const mode = params.mode ?? 'ngon';
    const odd = chosen.find((loop) => mode === 'quads' && loop.length % 2 === 1);
    if (odd !== undefined) return reject('DIR_FILL_ODD', `the loop has ${odd.length} edges: "quads" needs an even number`, ['params.mode']);
    const state = cageState(entity);
    let [vertices, faces] = [0, 0];
    for (const loop of chosen) {
      const added = fillLoop(state, loop, mode);
      vertices += added.vertices;
      faces += added.faces;
    }
    const updated = finishedCage(doc, COMMAND, entity, state);
    if (isCommandResult(updated)) return updated;
    return topologyResult(
      doc,
      COMMAND,
      updated,
      `${chosen.length} hole(s) of ${chosen.map((loop) => loop.length).join(' + ')} edge(s) filled (${mode}); +${vertices} vertex(es), +${faces} face(s)`,
      {
        newFaces: updated.elementIds.faces.slice(entity.faces.length),
        newVertices: updated.elementIds.vertices.slice(entity.vertices.length),
        loopSize: (chosen[0] as number[]).length,
      },
      picked.byIndex ? { edge: picked.ids[0] } : null,
    );
  },
});
