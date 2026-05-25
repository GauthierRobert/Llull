/**
 * @command set_units
 * @pure
 * @layer core/commands
 * @affects document-level units and displayPrecision only; affected:[]
 * @invariant units must be one of 'mm'|'cm'|'m'|'in'|'ft'; displayPrecision >= 0 and integer
 * @failure invalid unit or negative/non-integer precision -> no-op, affected:[]
 */

import type { CadDocument, DocumentUnit } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';

const VALID_UNITS: ReadonlySet<string> = new Set<DocumentUnit>(['mm', 'cm', 'm', 'in', 'ft']);

interface SetUnitsParams {
  units?: DocumentUnit;
  displayPrecision?: number;
}

export const setUnits: CommandDefinition<SetUnitsParams> = {
  name: 'set_units',
  description:
    'Set the document unit of length and/or the display precision (decimal places). ' +
    'Affects how all geometry values are displayed and labelled. ' +
    'At least one of units or displayPrecision should be provided.',
  paramsSchema: {
    type: 'object',
    properties: {
      units: {
        type: 'string',
        enum: ['mm', 'cm', 'm', 'in', 'ft'],
        description:
          "Unit of length for the document. Allowed values: 'mm' (millimetres), " +
          "'cm' (centimetres), 'm' (metres), 'in' (inches), 'ft' (feet).",
      },
      displayPrecision: {
        type: 'number',
        description:
          'Number of decimal places to show when formatting length values (e.g. 2 → "12.50 mm"). ' +
          'Must be a non-negative integer (0–15).',
      },
    },
    required: [],
  },
  run: (doc, { units, displayPrecision }): CommandResult => {
    if (units !== undefined && !VALID_UNITS.has(units)) {
      return {
        document: doc,
        summary: `Invalid unit '${String(units)}'. Allowed: mm, cm, m, in, ft.`,
        affected: [],
      };
    }

    if (displayPrecision !== undefined) {
      if (
        typeof displayPrecision !== 'number' ||
        displayPrecision < 0 ||
        !Number.isInteger(displayPrecision)
      ) {
        return {
          document: doc,
          summary: `Invalid displayPrecision ${String(displayPrecision)}. Must be a non-negative integer.`,
          affected: [],
        };
      }
    }

    if (units === undefined && displayPrecision === undefined) {
      return {
        document: doc,
        summary: 'No changes: provide at least one of units or displayPrecision.',
        affected: [],
      };
    }

    const nextUnits: DocumentUnit = units ?? doc.units;
    const nextPrecision: number = displayPrecision ?? doc.displayPrecision;

    const nextDoc: CadDocument = { ...doc, units: nextUnits, displayPrecision: nextPrecision };

    return {
      document: nextDoc,
      summary: `Units set to ${nextUnits}, precision ${nextPrecision}.`,
      affected: [],
    };
  },
};

// ---------------------------------------------------------------------------
// Pure display helper — reusable by measure / annotation commands.
// ---------------------------------------------------------------------------

/**
 * Format a length value using the document's current units and displayPrecision.
 *
 * @example formatLength(doc, 12.5) // "12.500 mm"
 */
export function formatLength(doc: CadDocument, value: number): string {
  return `${value.toFixed(doc.displayPrecision)} ${doc.units}`;
}
