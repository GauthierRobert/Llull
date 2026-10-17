/**
 * Load-time checks of the aerospace-01 document slices (llull-document v3): `kernelSettings` and `blobs`, and the rule that every `brep`
 * recipe leaf references an existing, intact blob.
 * @failure a malformed slice, a blob whose bytes do not hash to its key (KRN_BLOB_HASH_MISMATCH) or a `brep` leaf with no blob
 *   (KRN_BLOB_MISSING) -> one error text each; the loader refuses the file
 */

import { isFiniteNumber } from '../../lib/isFiniteNumber';
import { isRecord } from '../../lib/isRecord';
import { blobProblem } from '../../model/blobs';

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

const MAX_SCAN_DEPTH = 64;

/** Every `{ op: 'brep', blob }` leaf below `value`, with the id of the entity it sits in. */
function collectBrepLeaves(value: unknown, owner: string, out: Array<readonly [string, string]>, depth = 0): void {
  if (depth > MAX_SCAN_DEPTH || typeof value !== 'object' || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectBrepLeaves(item, owner, out, depth + 1);
    return;
  }
  const node = value as Record<string, unknown>;
  if (node['op'] === 'brep' && typeof node['blob'] === 'string') out.push([owner, node['blob']]);
  for (const [key, child] of Object.entries(node))
    if (key !== 'positions' && key !== 'indices') collectBrepLeaves(child, owner, out, depth + 1);
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
  for (const section of ['entities', 'components'] as const) {
    const records = doc[section];
    if (!isRecord(records)) continue;
    for (const [id, item] of Object.entries(records)) collectBrepLeaves(item, id, leaves);
  }
  for (const [owner, sha256] of leaves)
    if (!isRecord(blobs) || !Object.hasOwn(blobs, sha256))
      errors.push(
        `KRN_BLOB_MISSING: '${owner}' references B-rep blob ${sha256} that is not in the document blobs — re-import the STEP file`,
      );
  return errors;
}
