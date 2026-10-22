/** Saved-document checks for the SWG fields of a sweep (laws, orientation, station blend, helix) and of a helix curve's `analytic` definition. */

import type { CurveSegment } from '../../model/curve';
import type { Vec3 } from '../../model/types';
import { isRecord } from '../../lib/isRecord';
import { isFiniteNumber, isPositiveNumber } from '../../lib/isFiniteNumber';
import { isVec3, len3 } from '../../lib/vec3';
import { lawIssue } from '../../lib/law/evaluate';
import { chainLength } from '../../geometry/curveSegments';
import { parseLaw, type LawInput } from '../../lib/law/parse';

/** Problem of a saved scalar law (shape, ordering, finiteness, positivity when asked), or null. */
function lawProblem(value: unknown, label: string, positive: boolean, length: number): string | null {
  if (!isRecord(value) || typeof value['type'] !== 'string') return `${label} must be a law object with a type`;
  const law = parseLaw(value as unknown as LawInput);
  if (typeof law === 'string') return `${label}: ${law}`;
  const issue = lawIssue(law, { positive, length });
  return issue === null ? null : `${label}: ${issue.message}`;
}

/** Problem of a saved `HelixDefinition`, or null. */
export function helixProblem(value: unknown, label = 'helix'): string | null {
  if (value === undefined) return null;
  if (!isRecord(value)) return `${label} must be an object`;
  if (value['type'] !== 'helix' && value['type'] !== 'spiral') return `${label}.type must be "helix" or "spiral"`;
  if (!isVec3(value['origin'])) return `${label}.origin must be a finite [x, y, z]`;
  const axis = value['axis'];
  if (!isVec3(axis) || Math.abs(len3(axis as Vec3) - 1) > 1e-6) return `${label}.axis must be a unit [x, y, z]`;
  if (!isPositiveNumber(value['radius']) || !isPositiveNumber(value['endRadius'])) return `${label} radius and endRadius must be > 0`;
  if (!isPositiveNumber(value['turns'])) return `${label}.turns must be > 0`;
  if (value['handedness'] !== 'right' && value['handedness'] !== 'left') return `${label}.handedness must be "right" or "left"`;
  if (!isFiniteNumber(value['startAngle'])) return `${label}.startAngle must be finite`;
  const pitch = value['pitch'];
  if (typeof pitch === 'number') return pitch >= 0 && Number.isFinite(pitch) ? null : `${label}.pitch must be finite and >= 0`;
  return lawProblem(pitch, `${label}.pitch`, true, 1);
}

/** Problem of a saved orientation, or null. */
function orientationProblem(value: unknown): string | null {
  if (value === undefined) return null;
  if (!isRecord(value)) return 'orientation must be an object';
  const direction = value['direction'];
  const directionOk = isVec3(direction) && len3(direction as Vec3) > 1e-9;
  switch (value['mode']) {
    case 'minimal':
    case 'frenet':
      return null;
    case 'fixed':
      return direction === undefined || directionOk ? null : 'orientation.direction must be a non-zero [x, y, z]';
    case 'binormal':
      return directionOk ? null : 'orientation.direction must be a non-zero [x, y, z]';
    case 'axis_plane':
      if (!directionOk || !isVec3(value['axisPoint'])) return 'orientation axis_plane needs a non-zero direction and an axisPoint';
      return value['sectionFrame'] === 'path' || value['sectionFrame'] === 'axial'
        ? null
        : 'orientation.sectionFrame must be "path" or "axial"';
    default:
      return 'orientation.mode must be minimal, frenet, fixed, binormal or axis_plane';
  }
}

/** First problem of the laws, orientation, station blend and helix of a saved sweep, or null. */
export function sweepDesignProblem(v: Record<string, unknown>, path: ReadonlyArray<CurveSegment<Vec3>>): string | null {
  const length = chainLength(path);
  if (v['scale'] !== undefined && v['area'] !== undefined) return 'scale and area are exclusive';
  const stretch = v['stretch'];
  if (stretch !== undefined && !isRecord(stretch)) return 'stretch must be an object';
  const checks: Array<[unknown, string, boolean]> = [
    [v['twist'], 'twist', false],
    [v['scale'], 'scale', true],
    [v['area'], 'area', true],
    [isRecord(stretch) ? stretch['x'] : undefined, 'stretch.x', true],
    [isRecord(stretch) ? stretch['y'] : undefined, 'stretch.y', true],
  ];
  for (const [value, label, positive] of checks) {
    const problem = value === undefined ? null : lawProblem(value, label, positive, length);
    if (problem !== null) return problem;
  }
  const blend = v['stationBlend'];
  if (blend !== undefined && blend !== 'smooth' && blend !== 'linear') return 'stationBlend must be "smooth" or "linear"';
  return orientationProblem(v['orientation']) ?? helixProblem(v['helix']);
}
