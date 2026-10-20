/** A `CompositePart` and its `Ply` list rebuilt from a read `CompositeRecord` (placeholder ids), for the measures that only need geometry. */

import type { CompositePart, Ply } from '@core/model/composites';
import type { CompositeRecord, PlyRecord } from './interchange';

export function rebuildPart(record: Omit<CompositeRecord, 'validation'>): {
  part: CompositePart;
  plies: { record: PlyRecord; ply: Ply }[];
} {
  const part: CompositePart = {
    id: 'part-ap242',
    name: record.name,
    toolFaces: [{ entityId: record.tool.entityId, faceNear: record.tool.faceNear }],
    laminateSide: record.laminateSide,
    rosetteId: '',
    surface: record.surface,
    outline: record.outline,
  };
  const plies = [...record.plies]
    .sort((a, b) => a.order - b.order)
    .map((entry, index) => ({
      record: entry,
      ply: {
        id: `ply-ap242-${index}`,
        name: entry.name,
        partId: part.id,
        order: entry.order,
        sequence: entry.sequence,
        materialName: entry.material,
        orientation: entry.orientation,
        rosetteId: '',
        boundary: entry.boundary,
        ...(entry.drape === undefined ? {} : { drape: entry.drape }),
        ...(entry.cuts === undefined ? {} : { cuts: entry.cuts }),
      } satisfies Ply,
    }));
  return { part, plies };
}
