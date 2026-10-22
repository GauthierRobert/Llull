import type { CadDocument, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { cageState } from '../../geometry/subd/cageState';
import { insetPlan, sweepRegions } from '../../geometry/subd/regionOps';
import { dirRejection } from './codes';
import { faceRegions, isRegionProblem } from './faceRegions';
import { faceRefField, isEntity, subdivisionOf } from './shared';
import { finishedCage, isCommandResult, topologyResult } from './topologyResult';

const COMMAND = 'inset_cage_faces';

/**
 * @affects modifies 1 subdivision entity (+1 vertex per region-boundary vertex, +1 ring quad per boundary edge; the inner faces keep their ids)
 * @invariant a closed cage stays closed; with evenOffset every inner boundary edge lies exactly `thickness` inside its outer edge (planar faces); mirror faces inset too
 * @failure missing id (DIR_ENTITY_NOT_FOUND), unknown / wrong-kind element (DIR_REF_LOST / DIR_ELEMENT_KIND), thickness <= 0 (DIR_INSET_TOO_THICK), inner loop collapses (DIR_INSET_TOO_THICK, reports the limit), no usable normal (DIR_REGION_DEGENERATE) -> no-op
 */
export const insetCageFaces = defineCommand({
  name: COMMAND,
  description:
    'Inset faces of a subdivision cage: the boundary of each region of selected faces moves `thickness` inward in the face plane (even ' +
    'offset: every new edge exactly `thickness` from its old edge) and `depth` along the region normal (positive = outward, negative = ' +
    'into the solid), joined to the old boundary by a ring of quads. Faces are ids or indices; edge-connected faces inset as one ' +
    'region unless `individual`. Element ids are kept, new ones minted; a symmetric cage insets the mirror faces too. Refuses a ' +
    'thickness that would collapse the inner loop (DIR_INSET_TOO_THICK, with the largest valid thickness). Returns data { vertexCount, ' +
    'faceCount, vertices, vertexIds, faceIds, innerFaces, newFaces, newVertices }. Next: extrude_cage_faces, edit_subdivision_cage, set_cage_crease.',
  params: z.object({
    id: z.string().describe('Id of the subdivision solid.'),
    faces: z.array(faceRefField).min(1).describe('Faces to inset, as ids or indices.'),
    thickness: z.number().describe('Inset width in the face plane, document units (> 0).'),
    depth: z
      .number()
      .describe('Signed offset of the inner faces along the region normal, document units (+ outward). Default 0.')
      .optional(),
    individual: z.boolean().describe('true: inset every face on its own. Default false (edge-connected faces inset together).').optional(),
    evenOffset: z
      .boolean()
      .describe(
        'true (default): keep the width exactly `thickness` at corners (scales the corner offset); false: move corners by `thickness` along the bisector.',
      )
      .optional(),
  }),
  run: (doc: CadDocument, params): CommandResult => {
    const entity = subdivisionOf(doc, params.id, COMMAND);
    if (!isEntity(entity)) return entity;
    const reject = (code: string, message: string, path: string[] = []): CommandResult =>
      dirRejection(doc, COMMAND, code, message, [entity.id], path);
    const { thickness, depth = 0, evenOffset = true } = params;
    if (!(thickness > 0) || !Number.isFinite(thickness))
      return reject('DIR_INSET_TOO_THICK', `thickness must be > 0 (got ${thickness})`, ['params.thickness']);
    if (!Number.isFinite(depth)) return reject('DIR_INSET_TOO_THICK', `depth must be a finite number (got ${depth})`, ['params.depth']);
    const selected = faceRegions(entity, params.faces, params.individual === true);
    if (isRegionProblem(selected)) return reject(selected.code, selected.message, [selected.path]);
    const normals = selected.normals.filter((n): n is Vec3 => n !== null);
    if (normals.length !== selected.normals.length)
      return reject('DIR_REGION_DEGENERATE', 'a region has no usable normal (its faces cancel out)', ['params.faces']);
    const vertices = [...entity.vertices];
    const plan = (t: number): ReturnType<typeof insetPlan> =>
      insetPlan(vertices, selected.topology, selected.regions, normals, t, depth, evenOffset);
    const chosen = plan(thickness);
    if (chosen.collapsed) {
      let [ok, bad] = [0, thickness];
      for (let i = 0; i < 40; i++) {
        const mid = (ok + bad) / 2;
        if (plan(mid).collapsed) bad = mid;
        else ok = mid;
      }
      return reject(
        'DIR_INSET_TOO_THICK',
        `thickness ${thickness} collapses the inner loop; the largest valid thickness is ${ok.toPrecision(6)}`,
        ['params.thickness'],
      );
    }
    const state = cageState(entity);
    const created = sweepRegions(state, selected.regions, chosen.place);
    const updated = finishedCage(doc, COMMAND, entity, state);
    if (isCommandResult(updated)) return updated;
    return topologyResult(
      doc,
      COMMAND,
      updated,
      `${selected.faces.length} face(s) in ${selected.regions.length} region(s) inset by ${thickness}` +
        (depth !== 0 ? `, depth ${depth}` : '') +
        (selected.mirrored > 0 ? ` (+${selected.mirrored} mirror face(s))` : '') +
        `; +${created.vertices} vertices, +${created.faces} faces`,
      {
        innerFaces: selected.faces.map((f) => updated.elementIds.faces[f]),
        newFaces: updated.elementIds.faces.slice(entity.faces.length),
        newVertices: updated.elementIds.vertices.slice(entity.vertices.length),
      },
      selected.record,
    );
  },
});
