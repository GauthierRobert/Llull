/** Load-time validation of the optional `review` field (viewpoints, walkthroughs, issues; plant 09 VIS). Unknown keys are ignored. */

import { isRecord } from '../../lib/isRecord';
import { isStringArray } from '../../lib/isStringArray';
import { isReservedKey } from '../../lib/reservedKey';

const isVec3 = (value: unknown): boolean => Array.isArray(value) && value.length === 3 && value.every((n) => Number.isFinite(n));

function cameraProblem(camera: unknown): string | null {
  if (!isRecord(camera) || !isVec3(camera['eye']) || !isVec3(camera['direction']) || !isVec3(camera['up']))
    return 'camera needs eye, direction and up as [x, y, z]';
  if (camera['projection'] === 'perspective') {
    const fov = camera['fovDeg'];
    return typeof fov === 'number' && fov > 0 && fov < 180 ? null : 'perspective camera needs fovDeg in (0, 180)';
  }
  if (camera['projection'] === 'orthographic') {
    const height = camera['viewHeight'];
    return typeof height === 'number' && height > 0 && Number.isFinite(height) ? null : 'orthographic camera needs viewHeight > 0';
  }
  return "camera.projection must be 'perspective' or 'orthographic'";
}

function entryProblem(
  section: string,
  id: string,
  value: unknown,
  check: (entry: Record<string, unknown>) => string | null,
): string | null {
  if (isReservedKey(id)) return `review.${section}: id '${id}' is a reserved JavaScript property name`;
  if (!isRecord(value) || value['id'] !== id) return `review.${section}['${id}'] must be an object whose id is '${id}'`;
  const problem = check(value);
  return problem === null ? null : `review.${section}['${id}']: ${problem}`;
}

const viewpointProblem = (entry: Record<string, unknown>): string | null =>
  typeof entry['guid'] !== 'string' || typeof entry['name'] !== 'string' ? 'guid and name must be strings' : cameraProblem(entry['camera']);

function walkthroughProblem(entry: Record<string, unknown>, viewpoints: Record<string, unknown>): string | null {
  const keys = entry['keys'];
  if (!Array.isArray(keys) || keys.length < 2) return 'keys must list at least 2 viewpoints';
  const projections = new Set<unknown>();
  for (const key of keys) {
    if (!isRecord(key) || typeof key['viewpointId'] !== 'string' || !Object.hasOwn(viewpoints, key['viewpointId']))
      return 'every key must reference a known viewpointId';
    if (typeof key['seconds'] !== 'number' || !(key['seconds'] > 0) || !Number.isFinite(key['seconds']))
      return 'every key needs finite seconds > 0';
    const viewpoint = viewpoints[key['viewpointId']];
    projections.add(isRecord(viewpoint) && isRecord(viewpoint['camera']) ? viewpoint['camera']['projection'] : undefined);
  }
  return projections.size > 1 ? 'keys mix perspective and orthographic viewpoints' : null;
}

/** The largest numeric suffix of review ids (`vp-3`, `wt-7`, `iss-12`), 0 when none. */
function largestNumber(ids: readonly string[]): number {
  return ids.reduce((largest, id) => Math.max(largest, Number(/-(\d+)$/.exec(id)?.[1] ?? 0)), 0);
}

const duplicateIn = (name: string, ids: readonly string[]): string | null =>
  new Set(ids).size === ids.length ? null : `review.${name} lists an id twice`;

function issueProblem(entry: Record<string, unknown>, viewpoints: Record<string, unknown>): string | null {
  if (typeof entry['guid'] !== 'string' || typeof entry['title'] !== 'string') return 'guid and title must be strings';
  if (!isStringArray(entry['labels']) || !isStringArray(entry['viewpointIds']) || !isStringArray(entry['entityIds']))
    return 'labels, viewpointIds and entityIds must be string arrays';
  const missing = entry['viewpointIds'].find((id) => !Object.hasOwn(viewpoints, id));
  return missing === undefined ? null : `viewpoint '${missing}' does not exist`;
}

/** Problems of the optional `review` field of a raw document (absent is valid). */
export function reviewProblems(value: unknown): string[] {
  if (value === undefined) return [];
  if (
    !isRecord(value) ||
    !isRecord(value['viewpoints']) ||
    !isStringArray(value['viewpointOrder']) ||
    !isRecord(value['walkthroughs']) ||
    !isRecord(value['issues']) ||
    !isStringArray(value['issueOrder']) ||
    typeof value['nextNumber'] !== 'number'
  )
    return ['review must be { viewpoints, viewpointOrder, walkthroughs, issues, issueOrder, nextNumber }'];
  const viewpoints = value['viewpoints'];
  const ids = [...Object.keys(viewpoints), ...Object.keys(value['walkthroughs']), ...Object.keys(value['issues'])];
  const next = value['nextNumber'];
  const problems: (string | null)[] = [
    typeof next === 'number' && Number.isInteger(next) && next > largestNumber(ids)
      ? null
      : 'review.nextNumber must be an integer above every review id number',
    duplicateIn('viewpointOrder', value['viewpointOrder']),
    duplicateIn('issueOrder', value['issueOrder']),
    ...Object.entries(viewpoints).map(([id, entry]) => entryProblem('viewpoints', id, entry, viewpointProblem)),
    ...Object.entries(value['walkthroughs']).map(([id, entry]) =>
      entryProblem('walkthroughs', id, entry, (e) => walkthroughProblem(e, viewpoints)),
    ),
    ...Object.entries(value['issues']).map(([id, entry]) => entryProblem('issues', id, entry, (e) => issueProblem(e, viewpoints))),
    ...value['viewpointOrder'].map((id) => (Object.hasOwn(viewpoints, id) ? null : `review.viewpointOrder: unknown viewpoint '${id}'`)),
    ...value['issueOrder'].map((id) => (Object.hasOwn(value['issues'] as object, id) ? null : `review.issueOrder: unknown issue '${id}'`)),
  ];
  return problems.filter((problem): problem is string => problem !== null);
}
