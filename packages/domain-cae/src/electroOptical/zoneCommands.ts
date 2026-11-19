/** set_lightning_zone / remove_lightning_zone (PHY-15 V1): the SAE ARP5414A lightning zone of a solid, as zoned by the applicant, with its source. */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { is3D } from '@core/model/types';
import { nextId } from '@lib/id';
import { refuseEop } from './codes';
import { EOP_LIMITS, sourceParams, withElectroOptical, zonesOf } from './model';
import { LIGHTNING_ZONES, type LightningZoneLabel } from './types';

const SET = 'set_lightning_zone';

/**
 * @affects doc.electroOptical.zones (adds a label `lz-<step>.<k>`, or replaces the solid's label keeping its id; affected: [labelId])
 * @invariant one label per solid; a label always has a source citation; the zone is one of ARP5414A 1A 1B 1C 2A 2B 3; llull never derives a zone
 * @failure unknown entity or a 2D shape -> EOP_ENTITY_NOT_FOUND; empty source citation -> EOP_ZONE_SOURCE_REQUIRED (document unchanged)
 */
export const setLightningZone = defineCommand({
  name: SET,
  description:
    'Label a solid with its lightning strike zone (SAE ARP5414A): 1A first return stroke, low hang-on probability; 1B first return stroke, high hang-on probability; ' +
    '1C transition zone for the first return stroke; 2A swept stroke, low hang-on probability; 2B swept stroke, high hang-on probability; 3 conducted current only. ' +
    'The zoning is the applicant determination: give its source (zoning drawing / report); llull never derives a zone. ' +
    'Setting again replaces the label of that solid (same id). check_bonding then warns EOP_LIGHTNING_ZONE_NO_PATH for a composite solid (material record productForm / designation) in a zone that no bond path names. ' +
    'Returns the label id in affected[0].',
  params: z.object({
    entityId: z.string().max(EOP_LIMITS.key).describe('Id of the solid.'),
    zone: z.enum(LIGHTNING_ZONES).describe('ARP5414A zone: 1A, 1B, 1C, 2A, 2B or 3.'),
    source: sourceParams('Zoning drawing, report or certification document').describe('REQUIRED: where the zone comes from.'),
  }),
  run: (doc, { entityId, zone, source }): CommandResult => {
    const entity = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId] : undefined;
    if (entity === undefined || !is3D(entity))
      return refuseEop(doc, SET, 'EOP_ENTITY_NOT_FOUND', `no solid '${entityId}'`, [entityId], ['entityId']);
    if (source.citation.trim() === '')
      return refuseEop(doc, SET, 'EOP_ZONE_SOURCE_REQUIRED', 'a lightning zone needs a source citation', [entityId], ['source']);
    const zones = zonesOf(doc);
    const existing = Object.values(zones).find((label) => label.entityId === entityId);
    const id = existing?.id ?? nextId('lz');
    const label: LightningZoneLabel = {
      id,
      entityId,
      zone,
      source: { citation: source.citation, ...(source.locator === undefined ? {} : { locator: source.locator }) },
    };
    return changed(
      withElectroOptical(doc, { zones: { ...zones, [id]: label } }),
      `${SET}: ${entityId} in zone ${zone} (${id}${existing === undefined ? '' : `, was ${existing.zone}`}); source ${source.citation}.`,
      [id],
    );
  },
});

const REMOVE = 'remove_lightning_zone';

/**
 * @affects doc.electroOptical.zones (removes the solid's label; affected: [labelId])
 * @failure the solid has no label -> EOP_ZONE_NOT_FOUND (document unchanged)
 */
export const removeLightningZone = defineCommand({
  name: REMOVE,
  description: 'Remove the lightning zone label of a solid (set_lightning_zone).',
  params: z.object({ entityId: z.string().describe('Id of the labelled solid.') }),
  run: (doc, { entityId }): CommandResult => {
    const zones = zonesOf(doc);
    const label = Object.values(zones).find((item) => item.entityId === entityId);
    if (label === undefined)
      return refuseEop(doc, REMOVE, 'EOP_ZONE_NOT_FOUND', `'${entityId}' has no lightning zone label`, [entityId], ['entityId']);
    const rest = Object.fromEntries(Object.entries(zones).filter(([key]) => key !== label.id));
    return changed(withElectroOptical(doc, { zones: rest }), `${REMOVE}: removed ${label.id} (zone ${label.zone}) from ${entityId}.`, [
      label.id,
    ]);
  },
});
