/**
 * @layer ui
 * @pure Runtime type guards for `CommandResult.data` (`unknown` at the registry boundary).
 * A failed guard means the command refused or returned another shape: callers show `summary`.
 */

import type { CostLine } from '@aec/index';
import type { Clash } from '@aec/industrial/clash';

type DataRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is DataRecord =>
  typeof value === 'object' && value !== null;

const isTriple = (value: unknown): value is [number, number, number] =>
  Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number');

export function isCsvData(value: unknown): value is { csv: string } {
  return isRecord(value) && typeof value['csv'] === 'string';
}

export interface EstimateData {
  readonly currency: string;
  readonly lines: CostLine[];
  readonly total: number;
  readonly csv: string;
}

export function isEstimateData(value: unknown): value is EstimateData {
  return (
    isCsvData(value) &&
    typeof (value as DataRecord)['currency'] === 'string' &&
    typeof (value as DataRecord)['total'] === 'number' &&
    Array.isArray((value as DataRecord)['lines'])
  );
}

export function isClashData(value: unknown): value is { clashes: Clash[] } {
  return (
    isRecord(value) &&
    Array.isArray(value['clashes']) &&
    value['clashes'].every(
      (clash) =>
        isRecord(clash) &&
        typeof clash['a'] === 'string' &&
        typeof clash['b'] === 'string' &&
        (clash['kind'] === 'hard' || clash['kind'] === 'clearance'),
    )
  );
}

/** `{ [field]: string, filename: string }` payload of the single-file export commands. */
export function stringFields(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const fields: Record<string, string> = {};
  for (const [key, field] of Object.entries(value))
    if (typeof field === 'string') fields[key] = field;
  return fields;
}

export function isNcFilesData(
  value: unknown,
): value is { files: ReadonlyArray<{ name: string; content: string }> } {
  return (
    isRecord(value) &&
    Array.isArray(value['files']) &&
    value['files'].every(
      (file) =>
        isRecord(file) && typeof file['name'] === 'string' && typeof file['content'] === 'string',
    )
  );
}

export function isCodeExportData(value: unknown): value is { text: string; fileName: string } {
  return (
    isRecord(value) && typeof value['text'] === 'string' && typeof value['fileName'] === 'string'
  );
}

export function isBoundsData(
  value: unknown,
): value is { min: [number, number, number]; max: [number, number, number] } {
  return isRecord(value) && isTriple(value['min']) && isTriple(value['max']);
}
