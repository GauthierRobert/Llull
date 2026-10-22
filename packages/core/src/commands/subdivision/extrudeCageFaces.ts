import type { CadDocument, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { inverseEulerXYZ } from '../../lib/eulerRotation';
import { len3, scale3, normalize3 } from '../../lib/vec3';
import { cageState } from '../../geometry/subd/cageState';
import { sweepRegions, translatePlace } from '../../geometry/subd/regionOps';
import { dirRejection } from './codes';
import { faceRegions, isRegionProblem } from './faceRegions';
import { faceRefField, isEntity, subdivisionOf } from './shared';
import { finishedCage, isCommandResult, topologyResult } from './topologyResult';

const COMMAND = 'extrude_cage_faces';

/**
 * @affects modifies 1 subdivision entity (+1 vertex per region-boundary vertex, +1 side quad per boundary edge; selected faces move; elements keep their ids)
 * @invariant a closed cage stays closed and wound outward (Euler characteristic unchanged); on a symmetric cage the mirror faces extrude too
 * @failure missing id (DIR_ENTITY_NOT_FOUND), unknown / wrong-kind element (DIR_REF_LOST / DIR_ELEMENT_KIND), distance 0 (DIR_DISTANCE_ZERO), zero direction (DIR_DIRECTION_ZERO), no usable normal or no boundary (DIR_REGION_DEGENERATE), cage cap (DIR_CAGE_TOO_LARGE), broken symmetry (DIR_SYMMETRY_BROKEN) -> no-op
 */
export const extrudeCageFaces = defineCommand({
  name: COMMAND,
  description:
    'Extrude faces of a subdivision cage along their average normal (or `direction`) by `distance` in document units, creating side quads; ' +
    'the smooth surface grows a boss or handle. Faces are ids from select_cage_elements or data.faceIds ("f-1.2") or indices. Edge-connected ' +
    'faces extrude as one region (one shared normal) unless `individual`. Existing element ids are kept, new ones are minted; a ' +
    'symmetric cage extrudes the mirror faces too. Negative distance cuts inward. Refuses edges / vertices (DIR_ELEMENT_KIND), distance 0 ' +
    '(DIR_DISTANCE_ZERO). Returns data { vertexCount, faceCount, vertices, vertexIds, faceIds, capFaces, newFaces, newVertices }. ' +
    'Next: edit_subdivision_cage to shape the new faces, inset_cage_faces, check_subdivision.',
  params: z.object({
    id: z.string().describe('Id of the subdivision solid.'),
    faces: z.array(faceRefField).min(1).describe('Faces to extrude, as ids or indices.'),
    distance: z.number().describe('Extrusion distance in document units along the direction (negative = into the solid). Not 0.'),
    direction: vec3('World-space direction of the extrusion (any non-zero length). Default: each region average face normal.').optional(),
    individual: z
      .boolean()
      .describe('true: extrude every face on its own along its own normal. Default false (edge-connected faces move together).')
      .optional(),
  }),
  run: (doc: CadDocument, params): CommandResult => {
    const entity = subdivisionOf(doc, params.id, COMMAND);
    if (!isEntity(entity)) return entity;
    const reject = (code: string, message: string, path: string[] = []): CommandResult =>
      dirRejection(doc, COMMAND, code, message, [entity.id], path);
    const { distance, direction } = params;
    if (!Number.isFinite(distance) || distance === 0)
      return reject('DIR_DISTANCE_ZERO', `distance must be a non-zero number (got ${distance})`, ['params.distance']);
    if (direction !== undefined && len3(direction) < 1e-12)
      return reject('DIR_DIRECTION_ZERO', 'direction has zero length', ['params.direction']);
    const selected = faceRegions(entity, params.faces, params.individual === true);
    if (isRegionProblem(selected)) return reject(selected.code, selected.message, [selected.path]);
    const localDirection = direction === undefined ? undefined : normalize3(inverseEulerXYZ(direction, entity.rotation));
    const offsets: Vec3[] = [];
    for (const normal of selected.normals) {
      const along = localDirection ?? normal;
      if (along === null || along === undefined)
        return reject('DIR_REGION_DEGENERATE', 'a region has no usable normal (its faces cancel out): pass direction', [
          'params.direction',
        ]);
      offsets.push(scale3(along, distance));
    }
    const state = cageState(entity);
    const created = sweepRegions(state, selected.regions, translatePlace([...entity.vertices], offsets));
    const updated = finishedCage(doc, COMMAND, entity, state);
    if (isCommandResult(updated)) return updated;
    return topologyResult(
      doc,
      COMMAND,
      updated,
      `${selected.faces.length} face(s) in ${selected.regions.length} region(s) extruded by ${distance}` +
        (selected.mirrored > 0 ? ` (+${selected.mirrored} mirror face(s))` : '') +
        `; +${created.vertices} vertices, +${created.faces} faces`,
      {
        capFaces: selected.faces.map((f) => updated.elementIds.faces[f]),
        newFaces: updated.elementIds.faces.slice(entity.faces.length),
        newVertices: updated.elementIds.vertices.slice(entity.vertices.length),
      },
      selected.record,
    );
  },
});
