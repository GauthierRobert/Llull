/** Export-control marking as an agent writes it: one flat object, checked into the `ExportMarking` union. */

import type { ExportMarking } from '../../model/materialLibrary';
import { z } from '../schema';

export const markingInput = z.object({
  regime: z
    .enum(['none', 'EAR99', 'EAR', 'ITAR'])
    .describe('Export-control regime: none, EAR99, EAR (needs eccn) or ITAR. EAR and ITAR content is gated on export.'),
  eccn: z.string().optional().describe('Export Control Classification Number, e.g. "1C002"; required for regime EAR.'),
  category: z.string().optional().describe('USML category for ITAR, e.g. "XIII(g)"; optional.'),
});

/** The marking, or the reason it is not valid. */
export function markingOf(input: z.output<typeof markingInput>): ExportMarking | string {
  switch (input.regime) {
    case 'none':
    case 'EAR99':
      return { regime: input.regime };
    case 'EAR':
      return input.eccn !== undefined && input.eccn.trim() !== '' ? { regime: 'EAR', eccn: input.eccn } : 'regime EAR needs an eccn';
    case 'ITAR':
      return { regime: 'ITAR', ...(input.category !== undefined ? { category: input.category } : {}) };
  }
}

/** Short text of a marking for summaries: "ITAR", "EAR 1C002". */
export const markingText = (marking: ExportMarking): string =>
  marking.regime === 'EAR'
    ? `EAR ${marking.eccn}`
    : marking.regime === 'ITAR' && marking.category !== undefined
      ? `ITAR ${marking.category}`
      : marking.regime;
