/** Value validation of part idealizations (shell, plane stress) and defeaturing of a raw analysis case (untrusted file data, M6). */

import { isRecord } from '@lib/isRecord';
import { isVec3 } from '@lib/vec3';

const isPositive = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value > 0;
const isPointList = (value: unknown): boolean => Array.isArray(value) && value.every((point) => isVec3(point));

function shellErrors(idealization: Record<string, unknown>, where: string): string[] {
  const errors: string[] = [];
  const thickness = idealization['thickness'];
  if (!(thickness === 'auto' || isPositive(thickness))) errors.push(`${where}: shell thickness must be a number > 0 or 'auto'`);
  if (!['mid', 'top', 'bottom'].includes(String(idealization['offset']))) errors.push(`${where}: shell offset must be mid, top or bottom`);
  const mid = idealization['midsurface'];
  if (!isRecord(mid) || !isPositive(mid['maxThickness'])) errors.push(`${where}: shell midsurface.maxThickness must be a number > 0`);
  else {
    const tolerance = mid['angularTolDeg'];
    if (!(typeof tolerance === 'number' && tolerance >= 0 && tolerance <= 30))
      errors.push(`${where}: shell midsurface.angularTolDeg must be in [0, 30]`);
    const coverage = mid['minCoverage'];
    if (coverage !== undefined && !(typeof coverage === 'number' && coverage >= 0 && coverage <= 1))
      errors.push(`${where}: shell midsurface.minCoverage must be in [0, 1]`);
  }
  const laminate = idealization['laminate'];
  if (
    laminate !== undefined &&
    (!isRecord(laminate) ||
      typeof laminate['compositePartId'] !== 'string' ||
      (laminate['sectionId'] !== undefined && typeof laminate['sectionId'] !== 'string'))
  )
    errors.push(`${where}: shell laminate must name a compositePartId (and optionally a sectionId) as text`);
  return errors;
}

/** Errors of one part idealization; the kind itself is checked by the caller. */
export function idealizationErrors(idealization: Record<string, unknown>, where: string): string[] {
  if (idealization['kind'] === 'shell') return shellErrors(idealization, where);
  if (idealization['kind'] !== 'plane_stress') return [];
  return [
    ...(isPositive(idealization['thickness']) ? [] : [`${where}: plane_stress thickness must be a number > 0`]),
    ...(isPointList(idealization['sourceFacesNear']) && (idealization['sourceFacesNear'] as unknown[]).length > 0
      ? []
      : [`${where}: plane_stress sourceFacesNear must be a non-empty list of points`]),
  ];
}

/** Errors of `defeature`: keyed by parts of the case, each with maxFeatureSize > 0 and / or facesNear points. */
export function defeatureErrors(defeature: unknown, parts: Record<string, unknown>, where: string): string[] {
  if (defeature === undefined) return [];
  if (!isRecord(defeature)) return [`${where}: defeature must be a record`];
  const errors: string[] = [];
  for (const [entityId, spec] of Object.entries(defeature)) {
    if (!Object.hasOwn(parts, entityId)) errors.push(`${where}: defeature names '${entityId}', which is not a part`);
    if (!isRecord(spec)) {
      errors.push(`${where}: defeature of '${entityId}' must be a record`);
      continue;
    }
    if (spec['maxFeatureSize'] !== undefined && !isPositive(spec['maxFeatureSize']))
      errors.push(`${where}: defeature maxFeatureSize of '${entityId}' must be a number > 0`);
    if (spec['facesNear'] !== undefined && !isPointList(spec['facesNear']))
      errors.push(`${where}: defeature facesNear of '${entityId}' must be a list of points`);
    if (spec['maxFeatureSize'] === undefined && spec['facesNear'] === undefined)
      errors.push(`${where}: defeature of '${entityId}' names no feature`);
  }
  return errors;
}
