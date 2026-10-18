/** Frontal / wetted area of document solids in m² (document units converted), shared by frontal_area, aero_drag and cycling_power. */

import type { CadDocument, Vec3 } from '@core/model/types';
import { is3D } from '@core/model/types';
import { entityToTriangles } from '@core/geometry/entityTriangles';
import { toMetres } from '@core/model/units';
import { projectedArea, type ProjectedArea } from './projectedArea';
import type { Triangle } from '@core/geometry/triangles';

export const DEFAULT_FLOW_DIRECTION: Vec3 = [1, 0, 0];
export const DEFAULT_RESOLUTION = 400;

export type GeometryAreaResult =
  | { readonly ok: true; readonly area: ProjectedArea; readonly ids: readonly string[]; readonly scaleToMetres: number }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly ids: readonly string[] };

/** Projected area of the solids `ids` along `direction`, every length in metres. */
export function geometryArea(doc: CadDocument, ids: readonly string[], direction: Vec3, resolution: number): GeometryAreaResult {
  const missing = ids.filter((id) => doc.entities[id] === undefined);
  if (missing.length > 0) return { ok: false, code: 'AER_ENTITY_NOT_FOUND', message: `no entity ${missing.join(', ')}`, ids: missing };
  const scale = toMetres(doc, 1);
  const triangles = ids.flatMap((id) => {
    const entity = doc.entities[id];
    return entity !== undefined && is3D(entity) ? entityToTriangles(entity, doc) : [];
  });
  const toMetric = (point: Vec3): Vec3 => [point[0] * scale, point[1] * scale, point[2] * scale];
  const metric = triangles.map(([a, b, c]): Triangle => [toMetric(a), toMetric(b), toMetric(c)]);
  const area = projectedArea(metric, direction, resolution);
  if (area === null)
    return { ok: false, code: 'AER_NO_GEOMETRY', message: 'the entities have no 3D surface (2D sketches only?)', ids: [...ids] };
  return { ok: true, area, ids, scaleToMetres: scale };
}
