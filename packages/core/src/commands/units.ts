/**
 * @command set_units
 * @pure
 * @layer core/commands
 * @affects document-level units and displayPrecision only; affected:[]
 * @invariant units must be one of 'mm'|'cm'|'m'|'in'|'ft'; displayPrecision >= 0 and integer
 * @failure invalid unit or negative/non-integer precision -> no-op, affected:[]
 */

import type { CadDocument, DocumentUnit } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';

const UNITS = ['mm', 'cm', 'm', 'in', 'ft'] as const satisfies readonly DocumentUnit[];

export const setUnits = defineCommand({
  name: 'set_units',
  annotations: { idempotent: true },
  description:
    'Set the document unit of length and/or the display precision (decimal places). ' +
    'Affects how all geometry values are displayed and labelled. ' +
    'At least one of units or displayPrecision should be provided.',
  params: z.object({
    units: z
      .enum(UNITS)
      .optional()
      .describe(
        "Unit of length for the document. Allowed values: 'mm' (millimetres), " +
          "'cm' (centimetres), 'm' (metres), 'in' (inches), 'ft' (feet).",
      ),
    displayPrecision: z
      .number()
      .optional()
      .describe(
        'Number of decimal places to show when formatting length values (e.g. 2 → "12.50 mm"). ' +
          'Must be a non-negative integer.',
      ),
  }),
  run: (doc, { units, displayPrecision }): CommandResult => {
    if (displayPrecision !== undefined) {
      if (displayPrecision < 0 || !Number.isInteger(displayPrecision)) {
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
});

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
