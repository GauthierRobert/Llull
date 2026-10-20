/** Load-time validation of `thermomech.orientations` (PHY-04 M4b): part ids with two finite, non-zero, non-parallel axes. */

import { isRecord } from '@lib/isRecord';
import type { Vec3 } from '@core/model/vectors';
import { orthonormalAxes } from './orientation';

const isVec3 = (value: unknown): value is Vec3 =>
  Array.isArray(value) && value.length === 3 && value.every((c) => typeof c === 'number' && Number.isFinite(c));

/** Error messages of a raw `orientations` value (undefined is valid); `entities` is the document's entity bag. */
export function orientationErrors(orientations: unknown, entities: Record<string, unknown>, where: string): string[] {
  if (orientations === undefined) return [];
  if (!isRecord(orientations)) return [`${where}: orientations must be a record keyed by part id`];
  const errors: string[] = [];
  for (const [partId, orientation] of Object.entries(orientations)) {
    if (!Object.hasOwn(entities, partId)) errors.push(`${where}: orientation part '${partId}' does not exist`);
    if (!isRecord(orientation) || !isVec3(orientation['axis1']) || !isVec3(orientation['axis2']))
      errors.push(`${where}: orientation '${partId}' needs axis1 and axis2 as three finite numbers`);
    else {
      const axes = orthonormalAxes(orientation['axis1'], orientation['axis2']);
      if (typeof axes === 'string') errors.push(`${where}: orientation '${partId}': ${axes}`);
    }
  }
  return errors;
}
