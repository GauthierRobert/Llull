/** Load-time validation of the optional `review` field (viewpoints, section boxes, markups, walkthroughs, issues, comments; plant 09 VIS). Unknown keys are ignored. */

import { sectionBoxProblem } from '../../geometry/sectionBox';
import { ISSUE_PRIORITIES, ISSUE_STATUSES, MARKUP_SHAPES } from '../../model/review';
import { isRecord } from '../../lib/isRecord';
import { isStringArray } from '../../lib/isStringArray';
import { isReservedKey } from '../../lib/reservedKey';

const isVec3 = (value: unknown): boolean => Array.isArray(value) && value.length === 3 && value.every((n) => Number.isFinite(n));

const isOneOf = (list: readonly string[], value: unknown): boolean => typeof value === 'string' && list.includes(value);

const isAuthor = (value: unknown): boolean => value === 'agent' || value === 'human';

type Section = Record<string, unknown>;

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

function viewpointProblem(entry: Record<string, unknown>, sectionBoxes: Section): string | null {
  if (typeof entry['guid'] !== 'string' || typeof entry['name'] !== 'string') return 'guid and name must be strings';
  const cameraIssue = cameraProblem(entry['camera']);
  if (cameraIssue !== null) return cameraIssue;
  const box = entry['sectionBoxId'];
  if (box !== undefined && (typeof box !== 'string' || !Object.hasOwn(sectionBoxes, box))) return 'sectionBoxId must name a section box';
  if (entry['colourProfileId'] !== undefined && typeof entry['colourProfileId'] !== 'string') return 'colourProfileId must be a string';
  if (entry['selection'] !== undefined && !isStringArray(entry['selection'])) return 'selection must be a string array';
  const visibility = entry['visibility'];
  if (
    visibility !== undefined &&
    (!isRecord(visibility) || typeof visibility['defaultVisible'] !== 'boolean' || !isStringArray(visibility['exceptions']))
  )
    return 'visibility must be { defaultVisible, exceptions[] }';
  return null;
}

function sectionBoxEntryProblem(entry: Record<string, unknown>): string | null {
  if (typeof entry['name'] !== 'string') return 'name must be a string';
  const { min, max, rotationZ, planes } = entry;
  if (
    planes !== undefined &&
    (!Array.isArray(planes) || !planes.every((plane) => isRecord(plane) && isVec3(plane['normal']) && Number.isFinite(plane['offset'])))
  )
    return 'planes must be [{ normal, offset }]';
  if ((min !== undefined && !isVec3(min)) || (max !== undefined && !isVec3(max))) return 'min and max must be [x, y, z]';
  if (rotationZ !== undefined && typeof rotationZ !== 'number') return 'rotationZ must be a number';
  return sectionBoxProblem(entry as Parameters<typeof sectionBoxProblem>[0]);
}

function markupProblem(entry: Record<string, unknown>, viewpoints: Section): string | null {
  const viewpointId = entry['viewpointId'];
  if (typeof viewpointId !== 'string' || !Object.hasOwn(viewpoints, viewpointId)) return 'viewpointId must name a viewpoint';
  if (!isOneOf(MARKUP_SHAPES, entry['shape'])) return 'shape is not a markup shape';
  const width = entry['space'] === 'screen' ? 2 : entry['space'] === 'world' ? 3 : 0;
  if (width === 0) return "space must be 'screen' or 'world'";
  const points = entry['points'];
  if (
    !Array.isArray(points) ||
    points.length === 0 ||
    !points.every((p) => Array.isArray(p) && p.length === width && p.every(Number.isFinite))
  )
    return `points must be finite ${width}-component arrays`;
  const colour = entry['colour'];
  if (typeof colour !== 'string' || !/^#[0-9a-f]{6}$/.test(colour)) return 'colour must be #rrggbb';
  return isAuthor(entry['author']) ? null : "author must be 'agent' or 'human'";
}

function commentProblem(entry: Record<string, unknown>, issues: Section, viewpoints: Section): string | null {
  const issueId = entry['issueId'];
  if (typeof issueId !== 'string' || !Object.hasOwn(issues, issueId)) return 'issueId must name an issue';
  if (typeof entry['text'] !== 'string') return 'text must be a string';
  const cited = entry['viewpointId'];
  if (cited !== undefined && (typeof cited !== 'string' || !Object.hasOwn(viewpoints, cited))) return 'viewpointId must name a viewpoint';
  return isAuthor(entry['author']) ? null : "author must be 'agent' or 'human'";
}

function historyProblem(history: unknown): string | null {
  if (!Array.isArray(history)) return 'history must be an array';
  const bad = history.some(
    (item) =>
      !isRecord(item) ||
      !isOneOf(ISSUE_STATUSES, item['status']) ||
      !isAuthor(item['by']) ||
      typeof item['reason'] !== 'string' ||
      (item['by'] === 'human' && typeof item['signatureId'] !== 'string'),
  );
  return bad ? 'history entries are { status, by, reason } (a human entry carries signatureId)' : null;
}

function walkthroughProblem(entry: Record<string, unknown>, viewpoints: Section): string | null {
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

/** The largest numeric suffix of review ids (`vp-3`, `wt-7`, `iss-12`, `sb-2`, `mk-4`, `cm-1`), 0 when none. */
function largestNumber(ids: readonly string[]): number {
  return ids.reduce((largest, id) => Math.max(largest, Number(/-(\d+)$/.exec(id)?.[1] ?? 0)), 0);
}

const duplicateIn = (name: string, ids: readonly string[]): string | null =>
  new Set(ids).size === ids.length ? null : `review.${name} lists an id twice`;

function issueProblem(entry: Record<string, unknown>, viewpoints: Section): string | null {
  if (typeof entry['guid'] !== 'string' || typeof entry['title'] !== 'string') return 'guid and title must be strings';
  if (!isOneOf(ISSUE_STATUSES, entry['status'])) return 'status is not an issue status';
  if (!isOneOf(ISSUE_PRIORITIES, entry['priority'])) return 'priority is not an issue priority';
  const historyIssue = historyProblem(entry['history']);
  if (historyIssue !== null) return historyIssue;
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
    !isRecord(value['sectionBoxes']) ||
    !isRecord(value['markups']) ||
    !isRecord(value['walkthroughs']) ||
    !isRecord(value['issues']) ||
    !isStringArray(value['issueOrder']) ||
    !isRecord(value['comments']) ||
    typeof value['nextNumber'] !== 'number'
  )
    return ['review must be { viewpoints, viewpointOrder, sectionBoxes, markups, walkthroughs, issues, issueOrder, comments, nextNumber }'];
  const { viewpoints, sectionBoxes, markups, comments, issues, walkthroughs } = value;
  const ids = [
    ...Object.keys(viewpoints),
    ...Object.keys(walkthroughs),
    ...Object.keys(issues),
    ...Object.keys(sectionBoxes),
    ...Object.keys(markups),
    ...Object.keys(comments),
  ];
  const next = value['nextNumber'];
  const active = value['activeSectionBoxId'];
  const problems: (string | null)[] = [
    Number.isInteger(next) && next > largestNumber(ids) ? null : 'review.nextNumber must be an integer above every review id number',
    active === undefined || (typeof active === 'string' && Object.hasOwn(sectionBoxes, active))
      ? null
      : 'review.activeSectionBoxId must name a section box',
    duplicateIn('viewpointOrder', value['viewpointOrder']),
    duplicateIn('issueOrder', value['issueOrder']),
    ...Object.entries(viewpoints).map(([id, entry]) => entryProblem('viewpoints', id, entry, (e) => viewpointProblem(e, sectionBoxes))),
    ...Object.entries(sectionBoxes).map(([id, entry]) => entryProblem('sectionBoxes', id, entry, sectionBoxEntryProblem)),
    ...Object.entries(markups).map(([id, entry]) => entryProblem('markups', id, entry, (e) => markupProblem(e, viewpoints))),
    ...Object.entries(walkthroughs).map(([id, entry]) => entryProblem('walkthroughs', id, entry, (e) => walkthroughProblem(e, viewpoints))),
    ...Object.entries(issues).map(([id, entry]) => entryProblem('issues', id, entry, (e) => issueProblem(e, viewpoints))),
    ...Object.entries(comments).map(([id, entry]) => entryProblem('comments', id, entry, (e) => commentProblem(e, issues, viewpoints))),
    ...value['viewpointOrder'].map((id) => (Object.hasOwn(viewpoints, id) ? null : `review.viewpointOrder: unknown viewpoint '${id}'`)),
    ...value['issueOrder'].map((id) => (Object.hasOwn(issues, id) ? null : `review.issueOrder: unknown issue '${id}'`)),
  ];
  return problems.filter((problem): problem is string => problem !== null);
}
