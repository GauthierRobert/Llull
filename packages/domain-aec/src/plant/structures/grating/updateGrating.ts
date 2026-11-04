import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { noop } from '@core/commands/noop';
import type { GratingElement } from '@aec/building/types';
import { getBuilding, withElement } from '../../../building/model';
import { commitBuilding } from '../../../building/evaluate/evaluateElements';
import { refuse } from '../codes';
import { findGratingType } from './gratingTypes';

/**
 * @affects replaces the type and / or the imposed load of the given grating panels (the panels are regenerated)
 * @invariant boundary, supports, bar direction and top are unchanged; a deeper type lowers the underside, check_grating re-verifies the bearing
 * @failure id that is not a grating -> STA_UNKNOWN_ELEMENT; unknown type -> STA_GRATING_TYPE_UNKNOWN; neither field given -> STA_INVALID_GEOMETRY; every panel already has the values -> no-op
 */
export const updateGrating = defineCommand({
  name: 'update_grating',
  description:
    'Change the grating type and / or the imposed load of existing panels (the `elementIds` of add_grating): use a deeper bar after check_grating reported STA_GRATING_OVERSTRESS or STA_GRATING_DEFLECTION; ' +
    'imposedLoadKPa (kN/m², >= 0) is the live load that check_steel_members puts on the panels with their self-weight. ' +
    'The panel outline, supports, bar direction and walking-surface height stay as they are. A deeper bar lowers the underside by the depth difference: run check_grating afterwards, it re-verifies that the supports still bear.',
  params: z.object({
    ids: z.array(z.string()).min(1).describe('Grating element ids (the `elementIds` of add_grating).'),
    gratingType: z.string().optional().describe('New catalogue key from list_grating_types.'),
    imposedLoadKPa: z
      .number()
      .min(0)
      .optional()
      .describe('Imposed load on the walking surface, kN/m² (kPa), for check_steel_members. Unset keeps the current value.'),
  }),
  run: (doc, { ids, gratingType, imposedLoadKPa }): CommandResult => {
    const building = getBuilding(doc);
    if (gratingType === undefined && imposedLoadKPa === undefined)
      return refuse(
        doc,
        'update_grating',
        'STA_INVALID_GEOMETRY',
        'give gratingType and / or imposedLoadKPa',
        [],
        ['gratingType', 'imposedLoadKPa'],
      );
    const type = gratingType === undefined ? undefined : findGratingType(gratingType);
    if (gratingType !== undefined && type === undefined)
      return refuse(doc, 'update_grating', 'STA_GRATING_TYPE_UNKNOWN', `no grating type '${gratingType}'`, [], ['gratingType']);
    const unknown = ids.filter((id) => building.elements[id]?.category !== 'grating');
    if (unknown.length > 0)
      return refuse(doc, 'update_grating', 'STA_UNKNOWN_ELEMENT', `${unknown.join(', ')} is not a grating`, unknown, ['ids']);
    const edit = (panel: GratingElement): GratingElement => ({
      ...panel,
      ...(type === undefined ? {} : { gratingType: type.name }),
      ...(imposedLoadKPa === undefined ? {} : { imposedLoadKPa }),
    });
    const panels = [...new Set(ids)].flatMap((id) => {
      const element = building.elements[id];
      return element?.category === 'grating' && JSON.stringify(edit(element)) !== JSON.stringify(element) ? [element] : [];
    });
    if (panels.length === 0)
      return noop(
        doc,
        `update_grating: every given panel already has ${type !== undefined && imposedLoadKPa === undefined ? `type ${type.name}` : 'these values'}; nothing changed.`,
      );
    const next = panels.reduce((model, panel) => withElement(model, edit(panel)), building);
    const parts = [
      ...(type === undefined ? [] : [`to ${type.name}${type.verified ? '' : ' (unverified type)'}`]),
      ...(imposedLoadKPa === undefined ? [] : [`imposed load ${imposedLoadKPa} kPa`]),
    ];
    return commitBuilding(
      doc,
      next,
      panels.map((panel) => panel.id),
      `Changed ${panels.length} grating panel(s) ${panels.map((panel) => panel.mark).join(', ')} ${parts.join(', ')}; run check_grating.`,
      {
        elementIds: panels.map((panel) => panel.id),
        ...(type === undefined ? {} : { gratingType: type.name }),
        ...(imposedLoadKPa === undefined ? {} : { imposedLoadKPa }),
      },
    );
  },
});
