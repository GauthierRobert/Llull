/**
 * Midsurface of an analysed part (05 §5.2, TR-FEA-20): the recipe fast paths first (a sheet-metal part, a box plate), then face pairing over the
 * exact kernel faces. Deviation from §5.2 step 7: the midsurface is not a `ShapeRecipe` node evaluated by the kernel but planar mid faces
 * computed here and handed to the mesher as polygons (the kernel boundary has no midsurface op).
 */

import type { GeometryKernel } from '@core/geometry/kernel';
import { recipeOf } from '@core/geometry/shapeRecipe';
import { is3D, type CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { cross3, dot3, len3, sub3 } from '@lib/vec3';
import { boxPlateMidsurface } from './boxPlate';
import { pairedMidsurface } from './facePairing';
import { sheetMetalMidsurface, sheetMetalPartOf } from './sheetMetalMid';
import type { MidFace, Midsurface, MidsurfaceOptions, MidsurfaceRefusal } from './types';

/** Default largest angle between reversed normals of paired faces (degrees, 05 §4 `extract_midsurface`). */
export const DEFAULT_ANGULAR_TOL_DEG = 1;
/** Paired-area fraction a face-paired midsurface needs for meshing unless the case states another (05 §5.2 step 5). */
export const DEFAULT_MIN_COVERAGE = 0.98;

/** Options with `maxThickness` possibly unknown: the fast paths need none (the recipe states the thickness). */
export interface MidsurfaceRequest {
  readonly maxThickness?: number;
  readonly angularTolDeg?: number;
  /** Sheet-metal bends: no strip shorter than this (the mesh globalSize, document units); absent = 15-degree strips only. */
  readonly stripLength?: number;
}

/**
 * Midsurface of `entityId`: sheet-metal part (no kernel), box plate (no kernel), else face pairing with `kernel.faceQuery`.
 * @failure missing / 2D entity -> FEA_PART_INVALID; face pairing without maxThickness -> FEA_PARAM_INVALID; no exact kernel -> FEA_KERNEL_OCC_REQUIRED;
 *   plus the refusals of each path
 */
export function midsurfaceOf(
  doc: CadDocument,
  entityId: string,
  request: MidsurfaceRequest,
  kernel: GeometryKernel | null,
): Midsurface | MidsurfaceRefusal {
  const entity = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId] : undefined;
  if (entity === undefined || !is3D(entity))
    return { code: 'FEA_PART_INVALID', message: `'${entityId}' is not a 3D solid of the document` };
  const sheet = sheetMetalPartOf(doc, entityId);
  if (sheet !== undefined) return sheetMetalMidsurface(doc, entityId, sheet, request.stripLength);
  const angularTolDeg = request.angularTolDeg ?? DEFAULT_ANGULAR_TOL_DEG;
  if (entity.kind === 'box') {
    const thinnest = Math.min(...entity.size);
    return boxPlateMidsurface(entity, { maxThickness: request.maxThickness ?? thinnest, angularTolDeg });
  }
  if (request.maxThickness === undefined)
    return { code: 'FEA_PARAM_INVALID', message: `'${entityId}' (${entity.kind}) needs maxThickness for face pairing` };
  const shape = kernel?.faceQuery === undefined ? null : kernel.evaluate(recipeOf(entity));
  if (kernel === null || shape === null)
    return {
      code: 'FEA_KERNEL_OCC_REQUIRED',
      message: `the midsurface of '${entityId}' (${entity.kind}) needs face pairing on the exact OCC kernel (--kernel occt-native); boxes and sheet-metal parts need none`,
    };
  const options: MidsurfaceOptions = { maxThickness: request.maxThickness, angularTolDeg };
  return pairedMidsurface(kernel, shape, entityId, options);
}

/** Area of a mid face (outer minus holes), document units squared. */
export function midFaceArea(face: MidFace): number {
  const loopArea = (loop: readonly Vec3[]): number => {
    let sum: Vec3 = [0, 0, 0];
    loop.forEach((a, index) => {
      const b = loop[(index + 1) % loop.length] ?? a;
      const c = cross3(a, b);
      sum = [sum[0] + c[0], sum[1] + c[1], sum[2] + c[2]];
    });
    return Math.abs(dot3(sum, face.normal)) / 2;
  };
  return loopArea(face.outer) - face.holes.reduce((total, hole) => total + loopArea(hole), 0);
}

/** Largest in-plane extent of a mid face (document units): used to flag thick shells (t / L). */
export function midFaceSpan(face: MidFace): number {
  let span = 0;
  for (const a of face.outer) for (const b of face.outer) span = Math.max(span, len3(sub3(a, b)));
  return span;
}
