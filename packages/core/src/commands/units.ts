/**
 * @command set_units
 * @pure
 * @layer core/commands
 * @affects document-level units and displayPrecision only; affected:[]
 * @invariant units must be one of 'mm'|'cm'|'m'|'in'|'ft'; displayPrecision integer in [0, 20]
 * @failure invalid unit or negative/non-integer/>20 precision -> no-op, affected:[]
 */

import type { CadDocument } from '../model/types';
import { DOCUMENT_UNITS } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { noop, report } from './noop';
import { MAX_DISPLAY_PRECISION } from './limits';

export const setUnits = defineCommand({
  name: 'set_units',
  annotations: { idempotent: true },
  description:
    'Set the document unit of length and/or the display precision (decimal places). ' +
    'Affects how all geometry values are displayed and labelled. ' +
    'At least one of units or displayPrecision should be provided.',
  params: z.object({
    units: z
      .enum(DOCUMENT_UNITS)
      .optional()
      .describe(
        "Unit of length for the document. Allowed values: 'mm' (millimetres), " +
          "'cm' (centimetres), 'm' (metres), 'in' (inches), 'ft' (feet).",
      ),
    displayPrecision: z
      .number()
      .int()
      .optional()
      .describe(
        'Number of decimal places to show when formatting length values (e.g. 2 → "12.50 mm"). ' +
          'Must be an integer in [0, 20].',
      ),
  }),
  run: (doc, { units, displayPrecision }): CommandResult => {
    if (
      displayPrecision !== undefined &&
      (displayPrecision < 0 || displayPrecision > MAX_DISPLAY_PRECISION)
    ) {
      return noop(
        doc,
        `Invalid displayPrecision ${String(displayPrecision)}. Must be an integer in [0, ${MAX_DISPLAY_PRECISION}].`,
      );
    }

    if (units === undefined && displayPrecision === undefined) {
      return noop(doc, 'No changes: provide at least one of units or displayPrecision.');
    }

    const nextUnits = units ?? doc.units;
    const nextPrecision = displayPrecision ?? doc.displayPrecision;

    return report(
      { ...doc, units: nextUnits, displayPrecision: nextPrecision },
      `Units set to ${nextUnits}, precision ${nextPrecision}.`,
    );
  },
});

/**
 * Format a length value using the document's current units and displayPrecision.
 *
 * @example formatLength(doc, 12.5) // "12.500 mm"
 */
export function formatLength(doc: CadDocument, value: number): string {
  return `${value.toFixed(doc.displayPrecision)} ${doc.units}`;
}
