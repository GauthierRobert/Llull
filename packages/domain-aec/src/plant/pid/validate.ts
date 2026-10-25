/**
 * Load-time validation of `plant.pid` (the plugin's `DocumentExtension.validate`, plant 04 PID §6.4): settings, sheets, accepted findings, import
 * records and counters here, items and the references between them in `validateItems.ts`. A file breaking one invariant is refused with its path.
 */

import { isRecord } from '@lib/isRecord';
import { isReservedKey } from '@lib/reservedKey';
import { PID_CONVENTIONS, PID_IMPORT_FORMATS, PID_PAPERS, PID_SHEET_STATUSES, PID_TAG_FORMAT_KINDS } from './model';
import { itemErrors } from './validateItems';

const nonEmpty = (value: unknown): boolean => typeof value === 'string' && value !== '';
const isOneOf = (list: readonly string[], value: unknown): boolean => typeof value === 'string' && list.includes(value);

function settingsErrors(raw: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (raw['version'] !== 1) errors.push('plant.pid.version must be 1');
  if (!isOneOf(PID_CONVENTIONS, raw['convention'])) errors.push(`plant.pid.convention must be ${PID_CONVENTIONS.join(' or ')}`);
  if (!nonEmpty(raw['lineNumberFormat'])) errors.push('plant.pid.lineNumberFormat must be a non-empty string');
  const formats = raw['tagFormats'];
  if (!isRecord(formats)) return [...errors, 'plant.pid.tagFormats must be an object'];
  for (const [kind, format] of Object.entries(formats)) {
    const path = `plant.pid.tagFormats.${kind}`;
    if (!isOneOf(PID_TAG_FORMAT_KINDS, kind)) errors.push(`${path}: the kind must be ${PID_TAG_FORMAT_KINDS.join(', ')}`);
    else if (!isRecord(format) || typeof format['pattern'] !== 'string' || typeof format['separator'] !== 'string')
      errors.push(`${path} must be { pattern: string, separator: string }`);
    else
      try {
        new RegExp(format['pattern']);
      } catch {
        errors.push(`${path}.pattern must be a regular expression`);
      }
  }
  return errors;
}

function sheetErrors(raw: Record<string, unknown>): string[] {
  const sheets = raw['sheets'];
  if (!isRecord(sheets)) return ['plant.pid.sheets must be an object'];
  const errors: string[] = [];
  const numbers = new Set<string>();
  const keys = Object.keys(sheets);
  const order = raw['sheetOrder'];
  if (
    !Array.isArray(order) ||
    order.length !== keys.length ||
    new Set(order).size !== keys.length ||
    !order.every((id) => typeof id === 'string' && Object.hasOwn(sheets, id))
  )
    errors.push('plant.pid.sheetOrder must list every sheet id exactly once');
  for (const key of keys) {
    const path = `plant.pid.sheets.${key}`;
    const sheet = sheets[key];
    if (isReservedKey(key)) errors.push(`${path}: the id is a reserved name`);
    if (!isRecord(sheet)) {
      errors.push(`${path} must be an object`);
      continue;
    }
    if (sheet['id'] !== key) errors.push(`${path}.id must equal its key`);
    if (!nonEmpty(sheet['number'])) errors.push(`${path}.number must be a non-empty string`);
    else if (numbers.has(String(sheet['number']))) errors.push(`${path}.number ${String(sheet['number'])} is used by another sheet`);
    else numbers.add(String(sheet['number']));
    if (typeof sheet['title'] !== 'string') errors.push(`${path}.title must be a string`);
    if (!isOneOf(PID_PAPERS, sheet['paper'])) errors.push(`${path}.paper must be ${PID_PAPERS.join(', ')}`);
    if (typeof sheet['revision'] !== 'string') errors.push(`${path}.revision must be a string`);
    if (!isOneOf(PID_SHEET_STATUSES, sheet['status'])) errors.push(`${path}.status must be ${PID_SHEET_STATUSES.join(', ')}`);
    const issued = sheet['issuedBy'];
    if (issued !== undefined && !(isRecord(issued) && nonEmpty(issued['signer']) && nonEmpty(issued['at'])))
      errors.push(`${path}.issuedBy must be { signer, at }`);
    if (sheet['status'] === 'issued_for_construction' && issued === undefined)
      errors.push(`${path}: an issued-for-construction sheet needs issuedBy`);
  }
  return errors;
}

function recordErrors(raw: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const acceptances = raw['acceptances'];
  if (acceptances !== undefined) {
    if (!isRecord(acceptances)) errors.push('plant.pid.acceptances must be an object');
    else
      for (const [key, value] of Object.entries(acceptances))
        if (!(isRecord(value) && nonEmpty(value['reason']) && nonEmpty(value['by']) && nonEmpty(value['at'])))
          errors.push(`plant.pid.acceptances.${key} must be { reason, by, at } (non-empty strings)`);
  }
  const imports = raw['imports'];
  if (imports !== undefined) {
    if (!Array.isArray(imports)) errors.push('plant.pid.imports must be an array');
    else
      imports.forEach((record, index) => {
        const path = `plant.pid.imports[${index}]`;
        if (!isRecord(record)) return void errors.push(`${path} must be an object`);
        if (!isOneOf(PID_IMPORT_FORMATS, record['format'])) errors.push(`${path}.format must be ${PID_IMPORT_FORMATS.join(' or ')}`);
        if (!nonEmpty(record['version'])) errors.push(`${path}.version must be a non-empty string`);
        if (typeof record['sha256'] !== 'string' || !/^[0-9a-f]{64}$/.test(record['sha256']))
          errors.push(`${path}.sha256 must be 64 lowercase hex digits`);
        if (!Array.isArray(record['warnings']) || !record['warnings'].every((w) => typeof w === 'string'))
          errors.push(`${path}.warnings must be an array of strings`);
      });
  }
  const counters = raw['counters'];
  if (!isRecord(counters) || !Object.values(counters).every((n) => Number.isInteger(n) && (n as number) >= 0))
    errors.push('plant.pid.counters must map names to non-negative integers');
  return errors;
}

/** Errors of the raw `plant.pid` value of a saved document (absent = none); each names the path. */
export function pidErrors(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!isRecord(raw)) return ['plant.pid must be an object'];
  const sheets = isRecord(raw['sheets']) ? raw['sheets'] : {};
  return [...settingsErrors(raw), ...sheetErrors(raw), ...itemErrors(raw, sheets), ...recordErrors(raw)];
}
