import type { CadDocument, SubdivisionEntity } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { cageState } from '../../geometry/subd/cageState';
import { removeFaces } from '../../geometry/subd/cageOps';
import { boundaryLoops } from '../../geometry/subd/boundary';
import { isRefProblem, resolveFaces } from '../../geometry/subd/elements';
import { closeFacesUnderSymmetry } from '../../geometry/subd/symmetry';
import { buildTopology } from '../../geometry/subd/topology';
import { dirRejection } from './codes';
import { faceRefField, isEntity, subdivisionOf } from './shared';
import { finishedCage, isCommandResult, topologyResult } from './topologyResult';

const COMMAND = 'delete_cage_faces';

/**
 * @affects modifies 1 subdivision entity (faces removed, vertices no face uses dropped, `boundary` set: the cage becomes / stays an open surface); surviving elements keep their ids
 * @invariant the result is a valid open 2-manifold cage (no pinched vertex); sharpness of vanished edges is dropped; the new boundary edges are infinitely sharp in the limit surface; on a symmetric cage the mirror faces are deleted too; an open cage has no volume
 * @failure missing id (DIR_ENTITY_NOT_FOUND), unknown / wrong-kind face (DIR_REF_LOST / DIR_ELEMENT_KIND), every face selected (DIR_CAGE_EMPTY), a pinched result (DIR_CAGE_INVALID), broken symmetry (DIR_SYMMETRY_BROKEN) -> no-op
 */
export const deleteCageFaces = defineCommand({
  name: COMMAND,
  description:
    'Delete faces of a subdivision cage, leaving a hole: the cage becomes an open surface whose boundary edges stay infinitely sharp (a bowl, a sheet, ' +
    'an opening to bridge or to shape). Faces are ids ("f-1.2") or indices; vertices that no face uses disappear, every other element keeps its id; a ' +
    'symmetric cage deletes the mirror faces too. `boundary` picks the corner rule of the open cage (default "edge_and_corner"). An open cage has no ' +
    'volume (mass_properties refuses it); close it again with fill_cage_hole or join two holes with bridge_cage_faces. Refuses deleting every face ' +
    '(DIR_CAGE_EMPTY) and a deletion that pinches the surface at a vertex (DIR_CAGE_INVALID). Returns data { vertexCount, faceCount, vertices, vertexIds, ' +
    'faceIds, removedFaces, removedVertices, boundaryLoops }. Next: fill_cage_hole, bridge_cage_faces, check_subdivision.',
  params: z.object({
    id: z.string().describe('Id of the subdivision solid.'),
    faces: z.array(faceRefField).min(1).describe('Faces to delete, as ids or indices.'),
    boundary: z
      .enum(['edge_and_corner', 'edge_only'])
      .describe(
        'Corner rule of the open cage: "edge_and_corner" (default; corners of a single face stay pinned) or "edge_only" (corners stay smooth).',
      )
      .optional(),
  }),
  run: (doc: CadDocument, params): CommandResult => {
    const entity = subdivisionOf(doc, params.id, COMMAND);
    if (!isEntity(entity)) return entity;
    const reject = (code: string, message: string, path: string[] = []): CommandResult =>
      dirRejection(doc, COMMAND, code, message, [entity.id], path);
    const named = resolveFaces(entity, params.faces, 'params.faces');
    if (isRefProblem(named)) return reject(named.code, named.message, [named.path]);
    const faces =
      entity.symmetry === undefined ? [...new Set(named.items)] : closeFacesUnderSymmetry(entity.faces, named.items, entity.symmetry);
    if (faces.length >= entity.faces.length) return reject('DIR_CAGE_EMPTY', 'every face of the cage would be deleted', ['params.faces']);
    const state = cageState(entity);
    removeFaces(state, new Set(faces));
    const open: SubdivisionEntity = { ...entity, boundary: params.boundary ?? entity.boundary ?? 'edge_and_corner' };
    const updated = finishedCage(doc, COMMAND, open, state);
    if (isCommandResult(updated)) return updated;
    const keptVertices = new Set(updated.elementIds.vertices);
    const removedVertices = entity.elementIds.vertices.filter((id) => !keptVertices.has(id));
    const loops = boundaryLoops(buildTopology(updated.vertices.length, updated.faces));
    return topologyResult(
      doc,
      COMMAND,
      updated,
      `${faces.length} face(s) deleted (${removedVertices.length} vertex(es) dropped); ${loops.length} boundary loop(s), ${updated.boundary ?? 'closed'}`,
      {
        removedFaces: faces.map((f) => entity.elementIds.faces[f]),
        removedVertices,
        boundaryLoops: loops.map((loop) => loop.map((v) => updated.elementIds.vertices[v])),
      },
      named.byIndex ? { faces: named.ids } : null,
    );
  },
});
