/** list_surface_systems (PHY-13): read-only listing of the surface systems, for other plugins (composed through `execute`, no access to the corrosion slice). */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { corrosionOf } from './model';

/**
 * @affects nothing; read-only, document returned unchanged, affected: []
 * @invariant data = { systems: [{ id, entityIds, layers: [{ class, spec?, galvanicGroup? }] }], count }, sorted by id; a document without corrosion data lists none
 * @failure never refuses
 */
export const listSurfaceSystems = defineCommand({
  name: 'list_surface_systems',
  annotations: { readOnly: true, idempotent: true },
  description:
    'List the surface systems (protective finishes) assigned with assign_surface_system: id, the solids each covers and its layers inner to outer (class none, anodize, conversion_coating, ' +
    'metallic_plating, acid_process, primer, paint, with the process spec text). Read-only. A document with no surface system answers an empty list. Used by check_bonding to see which solids carry a finish.',
  params: z.object({ entityId: z.string().optional().describe('Only the system that covers this solid. Omit for all.') }),
  run: (doc, { entityId }): CommandResult => {
    const systems = Object.values(corrosionOf(doc).surfaceSystems)
      .filter((system) => entityId === undefined || system.entityIds.includes(entityId))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return report(
      doc,
      `list_surface_systems: ${systems.length} surface system(s)${entityId === undefined ? '' : ` covering ${entityId}`}.`,
      { systems, count: systems.length },
    );
  },
});
