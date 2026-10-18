/** Frontal / wetted area of document solids in m² (document units converted), shared by frontal_area, aero_drag and cycling_power. */

import { z } from '@core/commands/schema';
import type { CadDocument, Vec3 } from '@core/model/types';
import { is3D } from '@core/model/types';
import { entityToTriangles } from '@core/geometry/entityTriangles';
import { toMetres } from '@core/model/units';
import { projectedArea, type ProjectedArea } from './projectedArea';
import type { Triangle } from '@core/geometry/triangles';

const DEFAULT_FLOW_DIRECTION: Vec3 = [1, 0, 0];
const DEFAULT_RESOLUTION = 400;

/** The flow-direction and silhouette-resolution params of every command that measures a frontal area. */
export const flowParams = {
  flowDirection: z
    .array(z.number())
    .length(3)
    .optional()
    .describe('Direction the air moves relative to the body [x, y, z] (any length, not zero). Default [1, 0, 0]: a body moving along -x.'),
  resolution: z
    .number()
    .int()
    .optional()
    .describe('Silhouette grid cells along its larger extent, 50..2000. Default 400 (area error ~ ±0.5 %).'),
};

export type GeometryAreaResult =
  | {
      readonly ok: true;
      readonly area: ProjectedArea;
      readonly ids: readonly string[];
      readonly direction: Vec3;
      readonly scaleToMetres: number;
    }
  | { readonly ok: false; readonly code: string; readonly message: string; readonly ids: readonly string[]; readonly path: string };

/**
 * Projected area of the solids `ids` along `flowDirection` (default +x), every length in metres.
 * @failure zero / non-finite direction or resolution outside 50..2000 -> AER_PARAM_INVALID; unknown ids -> AER_ENTITY_NOT_FOUND; no 3D surface -> AER_NO_GEOMETRY
 */
export function geometryArea(
  doc: CadDocument,
  ids: readonly string[],
  flowDirection: readonly number[] | undefined,
  resolution: number = DEFAULT_RESOLUTION,
): GeometryAreaResult {
  const direction = (flowDirection ?? DEFAULT_FLOW_DIRECTION) as Vec3;
  if (!direction.every(Number.isFinite) || !(Math.hypot(...direction) > 0) || !(resolution >= 50 && resolution <= 2000))
    return {
      ok: false,
      code: 'AER_PARAM_INVALID',
      message: 'flowDirection must be a non-zero vector and resolution within 50..2000',
      ids: [],
      path: 'flowDirection',
    };
  const missing = ids.filter((id) => doc.entities[id] === undefined);
  if (missing.length > 0)
    return { ok: false, code: 'AER_ENTITY_NOT_FOUND', message: `no entity ${missing.join(', ')}`, ids: missing, path: 'entityIds' };
  const scale = toMetres(doc, 1);
  const triangles = ids.flatMap((id) => {
    const entity = doc.entities[id];
    return entity !== undefined && is3D(entity) ? entityToTriangles(entity, doc) : [];
  });
  const toMetric = (point: Vec3): Vec3 => [point[0] * scale, point[1] * scale, point[2] * scale];
  const metric = triangles.map(([a, b, c]): Triangle => [toMetric(a), toMetric(b), toMetric(c)]);
  const area = projectedArea(metric, direction, resolution);
  if (area === null)
    return {
      ok: false,
      code: 'AER_NO_GEOMETRY',
      message: 'the entities have no 3D surface (2D sketches only?)',
      ids: [...ids],
      path: 'entityIds',
    };
  return { ok: true, area, ids, direction, scaleToMetres: scale };
}
