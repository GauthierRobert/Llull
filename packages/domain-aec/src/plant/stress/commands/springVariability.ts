/** `spring_variability`: cold load and load variability of a variable spring hanger (07 PST M5b, TR-PST-10, VC-PST-14). */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { DEFAULT_MAX_VARIABILITY, springLoads } from '../code/springs';
import { ruleRows } from '../code/ruleSets';
import { refuse } from '../codes';

/**
 * @affects none; data = { hotLoadN, rateNPerMm, travelUpMm, coldLoadN, variability, maxVariability, ok, rule, grade, ruleRows, defaulted, reviewRequired, provenance }
 * @invariant read-only closed form P_cold = P_hot + k d, V = |k d| / P_hot; d positive upward (the pipe rises from cold to hot, the cold load is the larger)
 * @failure non-finite or non-positive hot load or rate, a cold load that is not positive -> PST_PARAM_INVALID; variability above the limit -> PST_SPRING_VARIABILITY (detail carries the numbers)
 */
export const springVariability = defineCommand({
  name: 'spring_variability',
  description:
    'Load variability of a variable-effort spring hanger: cold (installed) load P_cold = P_hot + k d and variability V = |k d| / P_hot, where d is the vertical travel from the cold to the hot position, ' +
    'positive when the pipe rises. Example: hot load 10000 N, rate 100 N/mm, 20 mm up: cold load 12000 N, V 0.20 (within the 0.25 default); 30 mm up: V 0.30, refused with PST_SPRING_VARIABILITY ' +
    '(the numbers are in error.detail). The limit is 0.25 (MSS SP-58 practice, grade B; attribution not confirmed), 0.15 near rotating equipment: pass maxVariability to change it (named, listed in defaulted when omitted). ' +
    'Units: loads N, rate N/mm, travel mm. Read-only quick check; reviewRequired is always true. For a whole model use select_spring_hangers.',
  params: z.object({
    hotLoadN: z
      .number()
      .positive()
      .describe('Hot (operating) load the spring carries, N (the restrained weight share of the hanger point).'),
    rateNPerMm: z.number().positive().describe('Spring rate k, N per mm of travel.'),
    travelUpMm: z
      .number()
      .describe(
        'Vertical travel d of the hanger point from the cold to the hot position, mm; positive upward, negative when the pipe sinks.',
      ),
    maxVariability: z
      .number()
      .positive()
      .max(1)
      .describe('Largest allowed variability V (fraction). Default 0.25; 0.15 near rotating equipment.')
      .optional(),
  }),
  annotations: { readOnly: true, idempotent: true },
  run: (doc, params): CommandResult => {
    const limit = params.maxVariability ?? DEFAULT_MAX_VARIABILITY;
    const loads = springLoads(params.hotLoadN, params.rateNPerMm, params.travelUpMm);
    const defaulted = params.maxVariability === undefined ? [`maxVariability=${DEFAULT_MAX_VARIABILITY}`] : [];
    const numbers = {
      hotLoadN: params.hotLoadN,
      rateNPerMm: params.rateNPerMm,
      travelUpMm: params.travelUpMm,
      coldLoadN: loads.coldLoadN,
      variability: loads.variability,
      maxVariability: limit,
    };
    if (!Number.isFinite(loads.coldLoadN) || loads.coldLoadN <= 0)
      return refuse(
        doc,
        'spring_variability',
        'PST_PARAM_INVALID',
        `the cold load ${loads.coldLoadN} N is not positive: the spring would be in compression the other way; pick a lower rate or a constant-effort hanger`,
        [],
        ['travelUpMm'],
        { ...numbers, ok: false },
      );
    if (loads.variability > limit)
      return refuse(
        doc,
        'spring_variability',
        'PST_SPRING_VARIABILITY',
        `variability ${loads.variability.toFixed(4)} exceeds the limit ${limit} (cold load ${loads.coldLoadN} N): use a lower rate, a larger size or a constant-effort hanger`,
        [],
        ['rateNPerMm'],
        { ...numbers, ok: false },
      );
    return report(
      doc,
      `spring_variability: hot ${params.hotLoadN} N, k ${params.rateNPerMm} N/mm, d ${params.travelUpMm} mm up: cold ${loads.coldLoadN} N, variability ${loads.variability.toFixed(4)} <= ${limit}${defaulted.length > 0 ? `; defaulted: ${defaulted.join(', ')}` : ''}.`,
      {
        ...numbers,
        ok: true,
        rule: 'SPRING-VARIABILITY',
        grade: 'B',
        ruleRows: ruleRows('SPRING-VARIABILITY'),
        defaulted,
        reviewRequired: true,
        provenance: { method: 'closed form', rule: 'SPRING-VARIABILITY', inputs: params, defaulted },
      },
    );
  },
});
