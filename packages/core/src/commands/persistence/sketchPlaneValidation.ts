import { isRecord } from '../../lib/isRecord';
import { isStringArray } from '../../lib/isStringArray';
import { isFiniteNumber } from '../../lib/isFiniteNumber';
import { isVec3 } from '../../lib/vec3';

const isUnit = (value: unknown): boolean => isVec3(value) && Math.abs(Math.hypot(...value) - 1) < 1e-6;

function frameProblem(id: string, frame: unknown): string | null {
  if (!isRecord(frame) || !isVec3(frame['origin']) || !isUnit(frame['normal']) || !isUnit(frame['xDir']))
    return `sketchPlane '${id}': frame needs a finite origin and unit normal / xDir`;
  return null;
}

/** Value checks for sketch planes and sketch links (SC-S3): renderers place sketches by them without further guards. */
export function sketchPlaneProblems(v: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const planes = v['sketchPlanes'];
  if (planes !== undefined && !isRecord(planes)) errors.push('sketchPlanes must be an object');
  if (isRecord(planes))
    for (const [id, plane] of Object.entries(planes)) {
      if (!isRecord(plane) || plane['id'] !== id || typeof plane['name'] !== 'string') {
        errors.push(`sketchPlane '${id}': needs id (matching its key) and name`);
        continue;
      }
      if (!isFiniteNumber(plane['offset']) || !isFiniteNumber(plane['spin']))
        errors.push(`sketchPlane '${id}': offset and spin must be finite`);
      const base = plane['base'];
      const kind = isRecord(base) ? base['kind'] : undefined;
      if (kind !== 'world' && !(kind === 'face' && isRecord(base) && typeof base['entityId'] === 'string'))
        errors.push(`sketchPlane '${id}': base must be { kind: 'world', plane } or { kind: 'face', entityId }`);
      const frame = frameProblem(id, plane['frame']);
      if (frame !== null) errors.push(frame);
    }
  const links = v['sketchLinks'];
  if (links !== undefined && !isRecord(links)) errors.push('sketchLinks must be an object');
  if (isRecord(links))
    for (const [id, link] of Object.entries(links)) {
      const source = isRecord(link) ? link['source'] : undefined;
      const valid =
        isRecord(link) &&
        link['id'] === id &&
        typeof link['planeId'] === 'string' &&
        (link['mode'] === 'project' || link['mode'] === 'intersect') &&
        isRecord(source) &&
        typeof source['entityId'] === 'string' &&
        isStringArray(source['edgeNames']);
      if (!valid)
        errors.push(
          `sketchLink '${id}': needs id (matching its key), planeId, mode project | intersect and source { entityId, edgeNames }`,
        );
    }
  return errors;
}
