/**
 * Shape checks of the `report` a native job returns for `repair`, `fill_holes` and `sculpt`: the commands read these reports field by field (`changes`, `filled`,
 * `skipped`, `movedVertices`), so a report that is not what the TypeScript engine would give is refused by the host before a command sees it (as `isMeshAnalysis` does).
 */

import type { MeshAnalysis } from './analysis';
import type { Fairing } from './holeRefine';
import type { RepairChanges, RepairMode } from './repair';
import type { SculptParams } from './sculpt';

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

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * True when `value` is the sculpt report of the op asked: whole counts, finite measures, a volume basis from the two the TypeScript engine names, a symmetry error only
 * when the op has a symmetry plane, no refined edge without `refineEdge`, and between one and two stamps applied per stamp (two only with a symmetry plane).
 */
export function isSculptReport(value: unknown, op: Pick<SculptParams, 'stamps' | 'symmetry' | 'refineEdge'>): boolean {
  if (!isRecord(value)) return false;
  const { movedVertices, maxDisplacement, displacedVolume, volumeBasis, symmetryError, refinedEdges, stampsApplied } = value;
  const stamps = op.stamps.length;
  return (
    isCount(movedVertices) &&
    isFiniteNumber(maxDisplacement) &&
    maxDisplacement >= 0 &&
    isFiniteNumber(displacedVolume) &&
    isOneOf(['closed-volume-difference', 'height-field-sum'], volumeBasis) &&
    (symmetryError === null || (op.symmetry !== undefined && isFiniteNumber(symmetryError) && symmetryError >= 0)) &&
    isCount(refinedEdges) &&
    (op.refineEdge !== undefined || refinedEdges === 0) &&
    isCount(stampsApplied) &&
    stampsApplied >= stamps &&
    stampsApplied <= (op.symmetry === undefined ? stamps : 2 * stamps)
  );
}

/**
 * True when the pair-search fields of `analysis` are what the op asked for: no count and no pairs when it did not ask; otherwise a count, and exactly
 * `min(count, maxListed)` pairs `[low, high]` of faces of the mesh, ascending, with low below high (the `selfIntersectionPairs` / `selfIntersections` fields).
 */
export function isPairSearchOf(analysis: MeshAnalysis, op: { readonly selfIntersections: boolean; readonly maxListed: number }): boolean {
  const { selfIntersectionPairs: count, selfIntersections: pairs, faces } = analysis;
  if (!op.selfIntersections) return count === null && pairs.length === 0;
  if (count === null || count > (faces * (faces - 1)) / 2 || pairs.length !== Math.min(count, op.maxListed)) return false;
  return pairs.every(([low, high], k) => {
    const previous = pairs[k - 1];
    return low < high && high < faces && (previous === undefined || previous[0] < low || (previous[0] === low && previous[1] < high));
  });
}
