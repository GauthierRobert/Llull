/** TR-MAT-32: does a command's params (recursively) reference a `licensed-no-redistribution` material, directly or through an entity / fastener stack. */

import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';

const MAX_DEPTH = 12;

/** True when the record behind `materialId` (or its library) is `licensed-no-redistribution`. */
export function isLicensedMaterial(doc: CadDocument, materialId: string): boolean {
  const material = Object.hasOwn(doc.materials, materialId) ? doc.materials[materialId] : undefined;
  const record = material?.record;
  if (record === undefined) return false;
  const library = record.libraryRef === undefined ? undefined : doc.materialLibraries?.[record.libraryRef.libraryId];
  return record.licence === 'licensed-no-redistribution' || library?.licence === 'licensed-no-redistribution';
}

/** True when the document holds any licensed material (the fail-closed answer when the references cannot be resolved). */
export function hasLicensedMaterial(doc: CadDocument): boolean {
  return Object.keys(doc.materials).some((id) => isLicensedMaterial(doc, id));
}

function entityLicensed(doc: CadDocument, entityId: string): boolean {
  const materialId = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId]?.materialId : undefined;
  return materialId !== undefined && isLicensedMaterial(doc, materialId);
}

function stringLicensed(doc: CadDocument, value: string): boolean {
  if (isLicensedMaterial(doc, value) || entityLicensed(doc, value)) return true;
  const stacks = doc.fasteners?.stacks;
  const stack = stacks !== undefined && Object.hasOwn(stacks, value) ? stacks[value] : undefined;
  return stack !== undefined && stack.layers.some((layer) => entityLicensed(doc, layer.entityId));
}

/**
 * True when any string in `value` (recursively) names a licensed material, an entity carrying one, or a fastener stack with such a layer.
 * A string holding a plan reference (`$alias`) resolves through `aliases`; with `aliases` unknown it counts as licensed when the document
 * holds any licensed material.
 * @invariant fail-closed: unresolvable plan references and runaway depth count as a reference when a licensed material exists
 */
export function referencesLicensed(doc: CadDocument, value: unknown, aliases?: Record<string, readonly string[]>, depth = 0): boolean {
  if (typeof value === 'string') {
    if (stringLicensed(doc, value)) return true;
    if (!value.includes('$')) return false;
    if (aliases === undefined) return hasLicensedMaterial(doc);
    return Object.values(aliases).some((ids) => ids.some((id) => stringLicensed(doc, id)));
  }
  if (depth > MAX_DEPTH) return hasLicensedMaterial(doc);
  if (Array.isArray(value)) return value.some((entry) => referencesLicensed(doc, entry, aliases, depth + 1));
  if (!isRecord(value)) return false;
  return Object.values(value).some((entry) => referencesLicensed(doc, entry, aliases, depth + 1));
}
