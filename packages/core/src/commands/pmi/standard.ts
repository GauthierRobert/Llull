import { PMI_STANDARDS } from '../../model/pmi';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed, noop } from '../noop';
import { pmiOf } from './pmiOps';

/**
 * @affects creates / patches the pmi header (standard, general tolerance note); affected = ['pmi']
 * @invariant items and saved views are untouched
 * @failure the same values already stored -> no-op, affected:[]
 */
export const setPmiStandard = defineCommand({
  name: 'set_pmi_standard',
  annotations: { idempotent: true },
  description:
    'Declare the governing GD&T standard of the document: ASME_Y14.5_2018 or ISO_GPS (ISO 1101 family), which decides symbol set and rule ' +
    'table. Optionally store a general tolerance / title-block note as plain text (e.g. "UNLESS OTHERWISE SPECIFIED: LINEAR +-0.1"); llull ' +
    'never computes values from a general-tolerance table. Creates the PMI model on first use; existing items are kept. Next: ' +
    'add_datum_feature, add_size_dimension, add_geometric_tolerance.',
  params: z.object({
    standard: z.enum(PMI_STANDARDS).describe('ASME_Y14.5_2018 or ISO_GPS.'),
    generalToleranceNote: z
      .string()
      .optional()
      .describe(
        'General tolerance note text, stored and printed as given (document units are the unit of any value in it). Omit to keep the stored note.',
      ),
  }),
  run: (doc, { standard, generalToleranceNote }): CommandResult => {
    const current = pmiOf(doc);
    const note = generalToleranceNote ?? current.generalToleranceNote;
    if (doc.pmi !== undefined && current.standard === standard && note === current.generalToleranceNote)
      return noop(doc, `set_pmi_standard: the standard is already ${standard}${note === undefined ? '' : ' with that note'}; no-op.`);
    const pmi = { ...current, standard, ...(note === undefined ? {} : { generalToleranceNote: note }) };
    return changed(
      { ...doc, pmi },
      `set_pmi_standard: standard ${standard}${note === undefined ? '' : `, general note "${note}"`}; ${current.order.length} PMI item(s) kept.`,
      ['pmi'],
    );
  },
});
