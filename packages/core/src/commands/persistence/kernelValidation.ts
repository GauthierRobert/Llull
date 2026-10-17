/**
 * Load-time checks of the aerospace-01 document slices (llull-document v3): `kernelSettings` and `blobs`, and the rule that every `brep`
 * recipe leaf references an existing, intact blob.
 * @failure a malformed slice, a blob whose bytes do not hash to its key (KRN_BLOB_HASH_MISMATCH) or a `brep` leaf with no blob
 *   (KRN_BLOB_MISSING) -> one error text each; the loader refuses the file
 */

import { isFiniteNumber } from '../../lib/isFiniteNumber';
import { isRecord } from '../../lib/isRecord';
import { blobProblem } from '../../model/blobs';
import { MAX_RECIPE_DEPTH } from '../../geometry/shapeRecipe';

const TOLERANCE_KEYS = ['linear', 'angular', 'maxImportTolerance'] as const;

function kernelSettingsProblems(settings: unknown): string[] {
  if (settings === undefined) return [];
  if (!isRecord(settings)) return ['kernelSettings must be an object'];
  const errors: string[] = [];
  if (settings['kernel'] !== 'occt' && settings['kernel'] !== 'manifold') errors.push("kernelSettings.kernel must be 'occt' or 'manifold'");
  for (const key of ['occtVersion', 'build'])
    if (settings[key] !== undefined && typeof settings[key] !== 'string') errors.push(`kernelSettings.${key} must be a string`);
  const tolerance = settings['modelingTolerance'];
  if (!isRecord(tolerance)) return [...errors, 'kernelSettings.modelingTolerance must be an object'];
  for (const key of TOLERANCE_KEYS) {
    const value = tolerance[key];
    if (!isFiniteNumber(value) || value <= 0) errors.push(`kernelSettings.modelingTolerance.${key} must be a finite number > 0`);
  }
  return errors;
}

/** JSON nesting scanned for `brep` leaves: a recipe level spans a few JSON levels, so this sits well above `MAX_RECIPE_DEPTH`. */
const MAX_SCAN_DEPTH = 4 * MAX_RECIPE_DEPTH;

/**
 * Every `{ op: 'brep', blob }` leaf below `value`, with the id of the entity it sits in; `tooDeep` collects owners nested beyond
 * `MAX_SCAN_DEPTH` (refused: an unscanned leaf would skip the KRN_BLOB_MISSING check).
 */
function collectBrepLeaves(value: unknown, owner: string, out: Array<readonly [string, string]>, tooDeep: Set<string>, depth = 0): void {
  if (typeof value !== 'object' || value === null) return;
  if (depth > MAX_SCAN_DEPTH) {
    tooDeep.add(owner);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectBrepLeaves(item, owner, out, tooDeep, depth + 1);
    return;
  }
  const node = value as Record<string, unknown>;
  if (node['op'] === 'brep' && typeof node['blob'] === 'string') out.push([owner, node['blob']]);
  for (const [key, child] of Object.entries(node))
    if (key !== 'positions' && key !== 'indices') collectBrepLeaves(child, owner, out, tooDeep, depth + 1);
}

/** Errors of `kernelSettings`, `blobs` and the `brep` leaves of `entities` / `components` in a raw document record. */
export function kernelSliceProblems(doc: Record<string, unknown>): string[] {
  const errors = kernelSettingsProblems(doc['kernelSettings']);
  const blobs = doc['blobs'];
  if (blobs !== undefined && !isRecord(blobs)) return [...errors, 'blobs must be an object keyed by sha256'];
  for (const [key, blob] of Object.entries(blobs ?? {})) {
    const problem = blobProblem(key, blob);
    if (problem === 'malformed')
      errors.push(`blob '${key}' is malformed (needs sha256, mediaType model/x-occt-brep|model/step, base64 bytes, size)`);
    else if (problem !== null) errors.push(`${problem}: blob '${key}' bytes do not match its sha256, mediaType or size`);
  }
  const leaves: Array<readonly [string, string]> = [];
  const tooDeep = new Set<string>();
  for (const section of ['entities', 'components'] as const) {
    const records = doc[section];
    if (!isRecord(records)) continue;
    for (const [id, item] of Object.entries(records)) collectBrepLeaves(item, id, leaves, tooDeep);
  }
  for (const owner of tooDeep)
    errors.push(`'${owner}' is nested deeper than ${MAX_SCAN_DEPTH} levels; its B-rep references cannot be checked`);
  for (const [owner, sha256] of leaves)
    if (!isRecord(blobs) || !Object.hasOwn(blobs, sha256))
      errors.push(
        `KRN_BLOB_MISSING: '${owner}' references B-rep blob ${sha256} that is not in the document blobs — re-import the STEP file`,
      );
  return errors;
}
