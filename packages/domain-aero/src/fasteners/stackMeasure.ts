/**
 * Stack measurement (08 MAT TECHNICAL_SPEC §5.3): the thickness of the solids a fastener passes through, along a ray `origin + s·direction`.
 * Entry/exit come from the solid's triangles (flat faces are exact; a cylinder's caps are exact), merged across layers.
 */

import { type CadDocument, type Vec3, is3D } from '@core/model/types';
import { entityToTriangles } from '@core/geometry/entityTriangles';
import { rayTriangleDistance } from '@core/geometry/triangleQueries';
import { cross3, dot3, len3, sub3 } from '@lib/vec3';

interface MeasuredLayer {
  readonly entityId: string;
  readonly entryS: number;
  readonly exitS: number;
  /** Angle in degrees between the ray and the face it enters through. */
  readonly entryAngleDeg: number;
}

export type StackMeasurement =
  | {
      readonly ok: true;
      readonly layers: readonly MeasuredLayer[];
      readonly startS: number;
      readonly endS: number;
      readonly thickness: number;
    }
  | {
      readonly ok: false;
      readonly code: 'FAST_LAYER_GAP' | 'FAST_AXIS_MISS' | 'FAST_LAYER_MISSING';
      readonly message: string;
      readonly ids: readonly string[];
    };

type LayerFailure = { readonly code: 'FAST_AXIS_MISS' | 'FAST_LAYER_MISSING'; readonly message: string };

function measureLayer(doc: CadDocument, entityId: string, origin: Vec3, direction: Vec3): MeasuredLayer | LayerFailure {
  const entity = doc.entities[entityId];
  if (entity === undefined) return { code: 'FAST_LAYER_MISSING', message: `entity '${entityId}' does not exist` };
  if (!is3D(entity)) return { code: 'FAST_LAYER_MISSING', message: `entity '${entityId}' is kind '${entity.kind}', not a 3D solid` };
  let entry = Infinity;
  let exit = -Infinity;
  let entryAngleDeg = 0;
  for (const triangle of entityToTriangles(entity, doc)) {
    const s = rayTriangleDistance(origin, direction, triangle, -Infinity, Infinity);
    if (s === null) continue;
    if (s < entry) {
      entry = s;
      const normal = cross3(sub3(triangle[1], triangle[0]), sub3(triangle[2], triangle[0]));
      const length = len3(normal);
      entryAngleDeg = length === 0 ? 0 : (Math.acos(Math.min(1, Math.abs(dot3(normal, direction)) / length)) * 180) / Math.PI;
    }
    if (s > exit) exit = s;
  }
  if (!(exit > entry)) return { code: 'FAST_AXIS_MISS', message: `the fastener axis does not pass through entity '${entityId}'` };
  return { entityId, entryS: entry, exitS: exit, entryAngleDeg };
}

/**
 * Layers hit by the ray, in order along it, merged into one stack.
 * @param direction unit vector
 * @param contactTolerance largest gap (document units) still counted as contact
 * @failure missing / non-solid entity -> FAST_LAYER_MISSING; the ray misses a solid -> FAST_AXIS_MISS; gap > tolerance -> FAST_LAYER_GAP
 */
export function measureStack(
  doc: CadDocument,
  entityIds: readonly string[],
  origin: Vec3,
  direction: Vec3,
  contactTolerance: number,
): StackMeasurement {
  const layers: MeasuredLayer[] = [];
  for (const id of entityIds) {
    const layer = measureLayer(doc, id, origin, direction);
    if ('code' in layer) return { ok: false, code: layer.code, message: layer.message, ids: [id] };
    layers.push(layer);
  }
  layers.sort((a, b) => a.entryS - b.entryS);
  let reach = -Infinity;
  let previous: MeasuredLayer | undefined;
  for (const layer of layers) {
    if (previous !== undefined && layer.entryS - reach > contactTolerance)
      return {
        ok: false,
        code: 'FAST_LAYER_GAP',
        message: `gap of ${layer.entryS - reach} document units between '${previous.entityId}' and '${layer.entityId}' (contact tolerance ${contactTolerance})`,
        ids: [previous.entityId, layer.entityId],
      };
    if (layer.exitS > reach) {
      reach = layer.exitS;
      previous = layer;
    }
  }
  const startS = layers[0]?.entryS ?? 0;
  return { ok: true, layers, startS, endS: reach, thickness: reach - startS };
}
