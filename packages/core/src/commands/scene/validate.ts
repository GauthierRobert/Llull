/** Field checks of light and camera entities, shared by the creating / editing commands, the saved-document guard and `check_model`. */

import { LIGHT_TYPES } from '../../model/sceneKinds';
import { isHexColor } from '../../lib/isHexColor';
import { isFiniteNumber, isNonNegativeNumber, isPositiveNumber } from '../../lib/isFiniteNumber';

type Fields = Readonly<Record<string, unknown>>;

/** First problem of the light fields in `v` (a command's resolved fields or a stored entity), or null. */
export function lightFieldsProblem(v: Fields): string | null {
  const type = v['lightType'];
  if (!(LIGHT_TYPES as readonly unknown[]).includes(type)) return `lightType must be one of ${LIGHT_TYPES.join(', ')}, got ${String(type)}`;
  if (!isNonNegativeNumber(v['intensity'])) return `intensity must be finite and >= 0, got ${String(v['intensity'])}`;
  if (!isHexColor(v['lightColor'])) return `lightColor must be #rrggbb, got ${String(v['lightColor'])}`;
  if (!isNonNegativeNumber(v['radius'])) return `radius must be finite and >= 0, got ${String(v['radius'])}`;
  if (typeof v['castShadows'] !== 'boolean') return 'castShadows must be a boolean';
  const cone = v['coneAngle'];
  const blend = v['blend'];
  if (type === 'spot') {
    if (!isPositiveNumber(cone) || cone > Math.PI / 2) return `a spot needs 0 < coneAngle <= pi/2 radians, got ${String(cone)}`;
    if (!isFiniteNumber(blend) || blend < 0 || blend > 1) return `a spot needs 0 <= blend <= 1, got ${String(blend)}`;
  } else if (cone !== undefined || blend !== undefined)
    return `coneAngle and blend apply to spot lights only (lightType is ${String(type)})`;
  const { width, height } = v;
  if (type === 'area') {
    if (!isPositiveNumber(width) || !isPositiveNumber(height))
      return `an area light needs width > 0 and height > 0, got ${String(width)} x ${String(height)}`;
  } else if (width !== undefined || height !== undefined)
    return `width and height apply to area lights only (lightType is ${String(type)})`;
  return null;
}

/** First problem of the camera fields in `v`, or null. */
export function cameraFieldsProblem(v: Fields): string | null {
  for (const key of ['focalLength', 'sensorWidth', 'sensorHeight', 'focusDistance'])
    if (!isPositiveNumber(v[key])) return `${key} must be finite and > 0, got ${String(v[key])}`;
  const fStop = v['fStop'];
  if (fStop !== undefined && !isPositiveNumber(fStop)) return `fStop must be finite and > 0 (omit it for a pinhole), got ${String(fStop)}`;
  return null;
}
