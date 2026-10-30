/**
 * Shape checks of the `report` a native job returns for `repair` and `fill_holes`: the commands read these reports field by field (`changes`, `filled`,
 * `skipped`), so a report that is not what the TypeScript engine would give is refused by the host before a command sees it (as `isMeshAnalysis` does).
 */

import type { Fairing } from './holeRefine';
import type { RepairChanges, RepairMode } from './repair';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isOneOf = (options: readonly string[], value: unknown): boolean => typeof value === 'string' && options.includes(value);

const CHANGE_FIELDS: ReadonlyArray<keyof RepairChanges> = [
  'welded',
  'duplicatesRemoved',
  'degenerateRemoved',
  'flipped',
  'stitched',
  'holesFilled',
  'componentsRemoved',
  'facesRemovedWithComponents',
];

const HOLE_CODES = ['MESH_HOLE_TOO_LARGE', 'MESH_HOLE_NON_SIMPLE', 'MESH_HOLE_NO_TRIANGULATION'];

/** True when `value` is `{ mode, changes, notes, skippedHoles }` of the repair report for `mode` (the mode of the op asked) with every count a whole number. */
export function isRepairReport(value: unknown, mode: RepairMode): boolean {
  if (!isRecord(value)) return false;
  const changes = value['changes'];
  return (
    value['mode'] === mode &&
    isRecord(changes) &&
    CHANGE_FIELDS.every((field) => isCount(changes[field])) &&
    Array.isArray(value['notes']) &&
    value['notes'].every((note) => typeof note === 'string') &&
    isCount(value['skippedHoles'])
  );
}

/** True when `value` is `{ totalLoops, filled, skipped }` of the hole-fill report for `fairing` (the op's): every loop entry has the fields of `FilledHole` / `SkippedHole` and a loop number below `totalLoops`. */
export function isFillReport(value: unknown, fairing: Fairing): boolean {
  if (!isRecord(value) || !isCount(value['totalLoops'])) return false;
  const { filled, skipped, totalLoops } = value;
  const isLoop = (loop: unknown): boolean => isCount(loop) && loop < totalLoops;
  return (
    Array.isArray(filled) &&
    filled.every(
      (hole) =>
        isRecord(hole) &&
        isLoop(hole['loop']) &&
        ['edges', 'triangles', 'addedVertices'].every((key) => isCount(hole[key])) &&
        typeof hole['area'] === 'number' &&
        Number.isFinite(hole['area']) &&
        isOneOf(['dp', 'greedy'], hole['triangulation']) &&
        hole['fairing'] === fairing,
    ) &&
    Array.isArray(skipped) &&
    skipped.every((hole) => isRecord(hole) && isLoop(hole['loop']) && isCount(hole['edges']) && isOneOf(HOLE_CODES, hole['code']))
  );
}
