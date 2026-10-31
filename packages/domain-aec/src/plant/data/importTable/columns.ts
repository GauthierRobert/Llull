/** Mapping of sheet headers to property definitions and of cell values to typed property input (plant 08 DAT §5.11 step 1 and 3). */

import { isPhysicalType, type PlantValue, type PropertyDefinition } from '../model';
import type { PlantValueInput } from '../properties';
import type { ImportCell } from './sheetSource';

const UNIT_SUFFIX = /^(.*\S) \(([^()]+)\)$/;
const NUMBER = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;

/** How a header names a property: the unit the sheet states (absent = the unit of the definition). */
export interface HeaderMatch {
  readonly unit?: string;
}

/** Does `header` name `definition`: "DisplayName (unit)", "DisplayName", "name (unit)" or "name"; a unit other than the definition's is converted on import. */
export function matchHeader(header: string, definition: PropertyDefinition): HeaderMatch | null {
  const names = [definition.displayName, definition.name];
  if (names.includes(header)) return {};
  const suffix = UNIT_SUFFIX.exec(header);
  if (suffix === null || definition.unit === undefined || !names.includes(suffix[1] as string)) return null;
  const unit = suffix[2] as string;
  return unit === definition.unit ? {} : { unit };
}

export type InputOutcome = { readonly ok: true; readonly input: PlantValueInput } | { readonly ok: false; readonly message: string };

/**
 * The typed input a cell stands for. Empty cells clear the value; a numeric text becomes a number for numeric properties; a number becomes text for a text
 * property (spreadsheets turn "101" into 101); a text that is `true` / `false` becomes a boolean. Anything else is passed on and `coerceValue` refuses it.
 */
export function cellToInput(definition: PropertyDefinition, cell: ImportCell, unit?: string): InputOutcome {
  if (cell === null) return { ok: true, input: null };
  if (typeof cell === 'object')
    return { ok: false, message: cell.unreadable === 'formula' ? `${cell.detail}` : `the cell holds ${cell.detail}` };
  const numeric = definition.type === 'integer' || definition.type === 'real' || isPhysicalType(definition.type);
  let value: PlantValue = cell;
  if (typeof cell === 'string') {
    const text = cell.normalize('NFC').trim();
    if (text === '') return { ok: true, input: null };
    if (numeric && NUMBER.test(text)) value = Number(text);
    else if (definition.type === 'boolean' && /^(?:true|false)$/i.test(text)) value = text.toLowerCase() === 'true';
    else value = text;
  } else if (typeof cell === 'number' && (definition.type === 'text' || definition.type === 'enum')) value = String(cell);
  if (typeof value === 'number' && unit !== undefined && isPhysicalType(definition.type)) return { ok: true, input: { value, unit } };
  return { ok: true, input: value };
}
