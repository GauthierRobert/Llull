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

const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** `FontRecord.variation`: a plain record of 4-character axis tags to finite numbers (no reserved keys); one message per bad entry. */
function variationProblems(id: string, variation: unknown): string[] {
  if (variation === undefined) return [];
  if (!isRecord(variation) || Array.isArray(variation)) return [`fonts.${id}.variation must be an object of axis tag -> number`];
  const errors: string[] = [];
  const entries = Object.entries(variation);
  if (entries.length > 64) errors.push(`fonts.${id}.variation has ${entries.length} axes (at most 64)`);
  for (const [tag, value] of entries.slice(0, 64))
    if (RESERVED_KEYS.has(tag) || tag.length !== 4 || typeof value !== 'number' || !Number.isFinite(value))
      errors.push(`fonts.${id}.variation.${tag} must be a finite number under a 4-character axis tag`);
  return errors;
}

/** `fonts` (03 WRP): an object of records, each naming a stored `font/ttf` or `font/otf` blob (a font without its bytes cannot outline text). */
function fontProblems(fonts: unknown, blobs: unknown): string[] {
  if (fonts === undefined) return [];
  if (!isRecord(fonts)) return ['fonts must be an object keyed by font id'];
  const errors: string[] = [];
  for (const [id, record] of Object.entries(fonts)) {
    const key = isRecord(record) ? record['blob'] : undefined;
    const blob = typeof key === 'string' && isRecord(blobs) ? blobs[key] : undefined;
    if (
      !isRecord(record) ||
      typeof key !== 'string' ||
      !isRecord(blob) ||
      !['font/ttf', 'font/otf', 'font/x-llull-stroke'].includes(String(blob['mediaType']))
    )
      errors.push(
        `WRP_FONT_UNAVAILABLE: font '${id}' needs a font blob (font/ttf, font/otf or font/x-llull-stroke) in the document blobs — re-run import_font`,
      );
    else errors.push(...variationProblems(id, record['variation']));
  }
  return errors;
}

/** Errors of `kernelSettings`, `blobs` and the `brep` leaves of `entities` / `components` in a raw document record. */
export function kernelSliceProblems(doc: Record<string, unknown>): string[] {
  const errors = kernelSettingsProblems(doc['kernelSettings']);
  const blobs = doc['blobs'];
  if (blobs !== undefined && !isRecord(blobs)) return [...errors, 'blobs must be an object keyed by sha256'];
  for (const [key, blob] of Object.entries(blobs ?? {})) {
    const problem = blobProblem(key, blob);
    if (problem === 'malformed')
      errors.push(
        `blob '${key}' is malformed (needs sha256, mediaType model/x-occt-brep|model/step|model/iges|font/ttf|font/otf|font/x-llull-stroke, base64 bytes, size)`,
      );
    else if (problem !== null) errors.push(`${problem}: blob '${key}' bytes do not match its sha256, mediaType or size`);
  }
  errors.push(...fontProblems(doc['fonts'], blobs));
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
