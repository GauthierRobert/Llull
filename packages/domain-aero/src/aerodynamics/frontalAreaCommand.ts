/** frontal_area: projected (frontal) and wetted area of solids along a flow direction, in m². */

import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { briefReport, sig } from '../shared/results';
import { refuseAero } from './codes';
import { flowParams, geometryArea } from './geometryArea';

/**
 * @affects none; data = { ids, flowDirection, frontalAreaM2, uncertaintyM2, wettedAreaM2, lengthM, extentsM, cellSizeM, unitScale }
 * @invariant union of the projected triangles (overlaps once); lengths converted from document units to metres
 * @failure unknown ids -> AER_ENTITY_NOT_FOUND; no 3D geometry -> AER_NO_GEOMETRY; zero direction / bad resolution -> AER_PARAM_INVALID
 */
export const frontalArea = defineCommand({
  name: 'frontal_area',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only frontal (projected) area of 3D solids seen along the flow direction — the reference area A of drag D = ½ρV²·Cd·A — plus the ' +
    'wetted (surface) area for skin friction and the body length along the flow. Overlapping parts count once (silhouette union by ' +
    'rasterisation; `uncertaintyM2` = half the boundary cells). Lengths are converted from the document units to metres. Default flow ' +
    'direction [1, 0, 0]. Use for a cyclist + bike model, a fuselage, a car or any assembly; then aero_drag { cd, entityIds } or road_load_power.',
  params: z.object({ entityIds: z.array(z.string()).min(1).describe('Ids of the 3D solids / instances to project.'), ...flowParams }),
  run: (doc, params): CommandResult => {
    const measured = geometryArea(doc, params.entityIds, params.flowDirection, params.resolution);
    if (!measured.ok) return refuseAero(doc, 'frontal_area', measured.code, measured.message, measured.ids, [measured.path]);
    const { area, direction } = measured;
    const data = {
      ids: measured.ids,
      flowDirection: direction,
      frontalAreaM2: sig(area.area),
      uncertaintyM2: sig(area.uncertainty),
      wettedAreaM2: sig(area.wettedArea),
      lengthM: sig(area.length),
      extentsM: area.extents.map(sig),
      cellSizeM: sig(area.cellSize),
      unitScale: { documentUnits: doc.units, metresPerUnit: measured.scaleToMetres },
      notes: [
        'Areas come from the display tessellation: curved surfaces read slightly low (a 32-segment circle has 99.4 % of the true area).',
      ],
    };
    return briefReport(
      doc,
      `Frontal area of ${measured.ids.length} solid(s) along [${direction.join(', ')}]: ${data.frontalAreaM2} m² (± ${data.uncertaintyM2}), wetted ${data.wettedAreaM2} m², length ${data.lengthM} m.`,
      data,
    );
  },
});
