/** Sealed M6 records: as-built records and manufacturing BOMs carry a SHA-256 over their other fields, so a hand edit of a saved file is found on load. */

import type { AsBuiltRecord, MbomRecord, PlmModel } from '@core/model/plm';
import { jcsJson } from '@lib/jcs';
import { sha256Hex } from '@lib/sha256';

/** A serial number: letters, digits and . _ - / (1-64 characters). */
export const SERIAL = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,63}$/;

type Unsealed<T extends { readonly sha256: string }> = Omit<T, 'sha256'>;

/** The hash a record of this kind must carry: SHA-256 of the canonical JSON of everything but `sha256`. */
const sealOf = (record: Unsealed<AsBuiltRecord> | Unsealed<MbomRecord>): string => sha256Hex(jcsJson(record));

export function sealAsBuilt(record: Unsealed<AsBuiltRecord>): AsBuiltRecord {
  return { ...record, sha256: sealOf(record) };
}

export function sealMbom(record: Unsealed<MbomRecord>): MbomRecord {
  return { ...record, sha256: sealOf(record) };
}

/** Whether `record` still hashes to its own `sha256` (false for anything that is not a sealed record). */
export function isSealed(record: unknown): boolean {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return false;
  const { sha256, ...rest } = record as Record<string, unknown>;
  return typeof sha256 === 'string' && sha256 === sha256Hex(jcsJson(rest));
}

/** Part numbers in a stable order. */
export const byPartNumber = <T extends { readonly partNumber: string }>(rows: readonly T[]): T[] =>
  [...rows].sort((a, b) => (a.partNumber < b.partNumber ? -1 : a.partNumber > b.partNumber ? 1 : 0));

/** The frozen EBOM row quantity of `partNumber` in the baseline root's released structure (undefined when the structure does not list it). */
export function frozenQuantity(plm: PlmModel, rootRevision: string, partNumber: string): number | undefined {
  return plm.item.revisions[rootRevision]?.releasedStructure?.find((row) => row.partNumber === partNumber)?.quantity;
}
