import type { CadDocument } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { SHARP_MAX } from '../../geometry/subd/sharpness';
import { cageState } from '../../geometry/subd/cageState';
import { bevelEdges, isBevelProblem } from '../../geometry/subd/bevel';
import { edgeKey } from '../../geometry/subd/edgeKey';
import { isRefProblem, resolveEdges } from '../../geometry/subd/elements';
import { mirrorGroup } from '../../geometry/subd/symmetry';
import { buildTopology } from '../../geometry/subd/topology';
import { dirRejection } from './codes';
import { edgeRefField, isEntity, subdivisionOf } from './shared';
import { finishedCage, isCommandResult, topologyResult } from './topologyResult';

const COMMAND = 'bevel_cage_edges';
const MAX_SEGMENTS = 16;

/**
 * @affects modifies 1 subdivision entity (each edge becomes a strip of `segments` quads; its two end vertices split in two, +2 vertices and +`segments` faces per edge for valence-3 ends); surviving elements keep their ids
 * @invariant the strip edges lie `width` of the adjacent edges away from the old edge; a closed cage stays closed; on a symmetric cage the mirror edges are bevelled too
 * @failure missing id (DIR_ENTITY_NOT_FOUND), unknown / wrong-kind edge (DIR_REF_LOST / DIR_ELEMENT_KIND), width <= 0 (DIR_BEVEL_WIDTH_RANGE) or >= 0.5 (DIR_BEVEL_TOO_WIDE), edges sharing a vertex (DIR_BEVEL_ADJACENT), a boundary edge (DIR_BEVEL_BOUNDARY), segments / sharp out of range, cage cap (DIR_CAGE_TOO_LARGE), broken symmetry (DIR_SYMMETRY_BROKEN) -> no-op
 */
export const bevelCageEdges = defineCommand({
  name: COMMAND,
  description:
    'Bevel edges of a subdivision cage: each edge is replaced by a strip of `segments` quads, set back by `width` (a fraction 0 < width < 0.5 of the ' +
    'length of the adjacent edges) on both sides. A chamfer of a cage: the smooth surface gets a rounded edge where it was crisp, or with `sharp` a ' +
    'crisp chamfer. `edges` are ids ("e:<idA>|<idB>") or [a, b] vertex index pairs; the edges must not share a vertex (bevel the others in another call) ' +
    'and must border two faces. A symmetric cage bevels the mirror edges too. Refuses width >= 0.5 (DIR_BEVEL_TOO_WIDE), edges sharing a vertex ' +
    '(DIR_BEVEL_ADJACENT) and boundary edges (DIR_BEVEL_BOUNDARY). Returns data { vertexCount, faceCount, vertices, vertexIds, faceIds, newVertices, newFaces }. ' +
    'Next: set_cage_crease, edit_subdivision_cage, check_subdivision.',
  params: z.object({
    id: z.string().describe('Id of the subdivision solid.'),
    edges: z
      .array(edgeRefField)
      .min(1)
      .describe('Edges to bevel: ids "e:<idA>|<idB>" or [a, b] vertex index pairs; no two may share a vertex.'),
    width: z
      .number()
      .describe('Setback as a fraction of the adjacent edge length, 0 < width < 0.5 (0.25 on a 2-unit cube edge = 0.5 document units).'),
    segments: z.number().int().describe(`Quads across the strip, 1..${MAX_SEGMENTS} (default 1: a flat chamfer).`).optional(),
    sharp: z
      .number()
      .describe(`Sharpness 0..${SHARP_MAX} given to the two long edges of the strip (default 0 = smooth; ${SHARP_MAX} = infinitely crisp).`)
      .optional(),
  }),
  run: (doc: CadDocument, params): CommandResult => {
    const entity = subdivisionOf(doc, params.id, COMMAND);
    if (!isEntity(entity)) return entity;
    const reject = (code: string, message: string, path: string[] = []): CommandResult =>
      dirRejection(doc, COMMAND, code, message, [entity.id], path);
    const { width, segments = 1, sharp = 0 } = params;
    if (!(width > 0)) return reject('DIR_BEVEL_WIDTH_RANGE', `width must be > 0 (got ${width})`, ['params.width']);
    if (width >= 0.5)
      return reject('DIR_BEVEL_TOO_WIDE', `width ${width} reaches the middle of the adjacent edges (limit 0.5)`, ['params.width']);
    if (!Number.isInteger(segments) || segments < 1 || segments > MAX_SEGMENTS)
      return reject('DIR_BEVEL_WIDTH_RANGE', `segments must be an integer 1..${MAX_SEGMENTS} (got ${segments})`, ['params.segments']);
    if (!(sharp >= 0 && sharp <= SHARP_MAX))
      return reject('DIR_SHARPNESS_RANGE', `sharp ${sharp} is outside 0..${SHARP_MAX}`, ['params.sharp']);
    const topology = buildTopology(entity.vertices.length, entity.faces);
    const named = resolveEdges(entity, params.edges, 'params.edges', topology);
    if (isRefProblem(named)) return reject(named.code, named.message, [named.path]);
    const group = entity.symmetry === undefined ? [{ map: null }] : mirrorGroup(entity.symmetry);
    const edges = new Map<string, readonly [number, number]>();
    for (const e of named.items) {
      const { a, b } = topology.edges[e] as { a: number; b: number };
      for (const image of group) {
        const [x, y] = image.map === null ? [a, b] : [image.map[a] as number, image.map[b] as number];
        edges.set(edgeKey(x, y), [x, y]);
      }
    }
    const state = cageState(entity);
    const result = bevelEdges(state, topology, [...edges.values()], width, segments, sharp);
    if (isBevelProblem(result)) return reject(result.code, result.message, ['params.edges']);
    const updated = finishedCage(doc, COMMAND, entity, state);
    if (isCommandResult(updated)) return updated;
    return topologyResult(
      doc,
      COMMAND,
      updated,
      `${edges.size} edge(s) bevelled by ${width} in ${segments} segment(s); +${result.vertices} vertices, +${result.faces} faces`,
      {
        newVertices: updated.elementIds.vertices.filter((id) => !entity.elementIds.vertices.includes(id)),
        newFaces: updated.elementIds.faces.filter((id) => !entity.elementIds.faces.includes(id)),
      },
      named.byIndex ? { edges: named.ids } : null,
    );
  },
});
