/** set_margin_band: the owner's marginal band of a case (FR-FEA-31: no default), read by check_analysis so FEA_MARGINAL_BAND_UNSET can be cleared. */

import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { caseOf, withCase } from '../shared/access';
import { refuseMarginsAs } from './refusal';
import { analysisIdSchema } from '../shared/schemas';

/**
 * @affects doc.analysis.cases[analysisId].marginalBand (not part of the analysis input hash: results stay valid)
 * @invariant a finite number >= 0 in margin-of-safety units; absent = no band (check_analysis warns FEA_MARGINAL_BAND_UNSET)
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; negative / non-finite band -> FEA_MARGIN_PARAM_INVALID (unchanged doc)
 */
export const setMarginBand = defineCommand({
  name: 'set_margin_band',
  description:
    'Record the marginal band of an analysis: a row with 0 <= MS < band reads MARGINAL in compute_margins and check_analysis stops warning ' +
    'FEA_MARGINAL_BAND_UNSET. There is NO default: the value comes from the owner or the company rule (never invent one). Omit `marginalBand` to clear it. ' +
    'Pass the same value as marginalBand to compute_margins to see the MARGINAL rows.',
  params: z.object({
    analysisId: analysisIdSchema,
    marginalBand: z
      .number()
      .optional()
      .describe('Band in margin-of-safety units, a finite number >= 0 (e.g. 0.1). Omit to clear the stored band.'),
  }),
  run: (doc, { analysisId, marginalBand }): CommandResult => {
    const found = caseOf(doc, analysisId);
    if (found === undefined)
      return refuseMarginsAs(doc, 'set_margin_band', 'FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId]);
    if (marginalBand !== undefined && !(Number.isFinite(marginalBand) && marginalBand >= 0))
      return refuseMarginsAs(
        doc,
        'set_margin_band',
        'FEA_MARGIN_PARAM_INVALID',
        `marginalBand ${marginalBand} must be a finite number >= 0`,
        [analysisId],
      );
    const { marginalBand: _previous, ...rest } = found;
    void _previous;
    const next = marginalBand === undefined ? rest : { ...rest, marginalBand };
    return changed(
      withCase(doc, next),
      marginalBand === undefined
        ? `set_margin_band: cleared the marginal band of '${analysisId}'.`
        : `set_margin_band: '${analysisId}' marginal band ${marginalBand} (MS units).`,
      [analysisId],
    );
  },
});
