/** assign_surface_coating / remove_surface_coating (PHY-15 FR-EOP-12): coatings placed on solids, with their declared electrical effect. */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { is3D } from '@core/model/types';
import { nextId } from '@lib/id';
import { refuseEop } from './codes';
import { electroOpticalOf, withElectroOptical } from './model';
import { COATING_LOCATIONS, ELECTRICAL_EFFECTS, type CoatingAssignment } from './types';

const ASSIGN = 'assign_surface_coating';

/**
 * @affects doc.electroOptical.coatings (adds 1 assignment `sc-<step>.<k>`; affected: [assignmentId])
 * @invariant the coating is a document material whose record productForm is 'coating'; an entity has at most one coating per location; an electrical effect other than 'unknown' needs a source; a solid only
 * @failure unknown entity or a 2D shape -> EOP_ENTITY_NOT_FOUND; missing / non-coating material -> EOP_COATING_NOT_FOUND; location already coated -> EOP_FACE_ALREADY_COATED;
 *   conductive / insulating without source -> EOP_PARAMS_INVALID (document unchanged)
 */
export const assignSurfaceCoating = defineCommand({
  name: ASSIGN,
  description:
    "Place a coating on a solid. The coating is a document material defined with define_material_record { productForm: 'coating' } whose optical values are PHY-01 models " +
    "(define_property_model: absorptivitySolar with condition { lifeState: 'BOL' | 'EOL' }, emissivityIr with condition { opticalKind: 'hemispherical_total' }). " +
    "location 'exposed' = the outer sun-facing / radiating surface (read by optical_balance); 'bonded_interface' = a surface the part is bonded through (read by check_bonding). " +
    "electrical states the coating's effect on a bond across it: 'conductive' or 'insulating' (each REQUIRES a source) or 'unknown' (default): an unknown or insulating coating on a bonded interface " +
    'never lets check_bonding pass. llull ships no coating data. One coating per entity and location. Returns the assignment id in affected[0].',
  params: z.object({
    entityId: z.string().describe('Id of the solid.'),
    coating: z.string().describe("Id of the coating material (record productForm 'coating')."),
    location: z.enum(COATING_LOCATIONS).optional().describe("'exposed' (default) or 'bonded_interface'."),
    electrical: z
      .enum(ELECTRICAL_EFFECTS)
      .optional()
      .describe('Declared electrical effect: conductive | insulating | unknown (default). A declared value needs `source`.'),
    source: z
      .object({ citation: z.string().describe('Datasheet, report or standard.'), locator: z.string().optional().describe('Page / table.') })
      .optional()
      .describe('Where the electrical effect comes from (required for conductive / insulating).'),
  }),
  run: (doc, { entityId, coating, location, electrical, source }): CommandResult => {
    const fail = (code: string, message: string, ids: readonly string[], path: string): CommandResult =>
      refuseEop(doc, ASSIGN, code, message, ids, [path]);
    const entity = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId] : undefined;
    if (entity === undefined || !is3D(entity)) return fail('EOP_ENTITY_NOT_FOUND', `no solid '${entityId}'`, [entityId], 'entityId');
    const material = Object.hasOwn(doc.materials, coating) ? doc.materials[coating] : undefined;
    if (material?.record?.productForm !== 'coating')
      return fail('EOP_COATING_NOT_FOUND', `no coating material '${coating}' (a record with productForm 'coating')`, [coating], 'coating');
    const where = location ?? 'exposed';
    const effect = electrical ?? 'unknown';
    if (effect !== 'unknown' && (source === undefined || source.citation.trim() === ''))
      return fail('EOP_PARAMS_INVALID', `a '${effect}' electrical effect needs a source citation`, [coating], 'source');
    const model = electroOpticalOf(doc);
    const existing = Object.values(model.coatings).find((item) => item.entityId === entityId && item.location === where);
    if (existing !== undefined)
      return fail(
        'EOP_FACE_ALREADY_COATED',
        `'${entityId}' already has coating '${existing.coating}' (${existing.id}) at ${where}`,
        [existing.id],
        'entityId',
      );
    const id = nextId('sc');
    const assignment: CoatingAssignment = {
      id,
      entityId,
      coating,
      location: where,
      electrical: effect,
      ...(source === undefined
        ? {}
        : { source: { citation: source.citation, ...(source.locator === undefined ? {} : { locator: source.locator }) } }),
    };
    return changed(
      withElectroOptical(doc, { coatings: { ...model.coatings, [id]: assignment } }),
      `${ASSIGN}: coating '${coating}' on ${entityId} at ${where} (${id}), electrical effect ${effect}.`,
      [id],
    );
  },
});

const REMOVE = 'remove_surface_coating';

/**
 * @affects doc.electroOptical.coatings (removes 1 assignment; affected: [assignmentId])
 * @failure unknown assignment id -> EOP_COATING_ASSIGNMENT_NOT_FOUND (document unchanged)
 */
export const removeSurfaceCoating = defineCommand({
  name: REMOVE,
  description: 'Remove a coating assignment made by assign_surface_coating (its id is the affected id of that command).',
  params: z.object({ assignmentId: z.string().describe("Assignment id, e.g. 'sc-4.1'.") }),
  run: (doc, { assignmentId }): CommandResult => {
    const model = electroOpticalOf(doc);
    if (!Object.hasOwn(model.coatings, assignmentId))
      return refuseEop(
        doc,
        REMOVE,
        'EOP_COATING_ASSIGNMENT_NOT_FOUND',
        `no assignment '${assignmentId}'`,
        [assignmentId],
        ['assignmentId'],
      );
    const rest = Object.fromEntries(Object.entries(model.coatings).filter(([key]) => key !== assignmentId));
    return changed(withElectroOptical(doc, { coatings: rest }), `${REMOVE}: removed ${assignmentId}.`, [assignmentId]);
  },
});
