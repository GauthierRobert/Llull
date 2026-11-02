/** `pipe_stress_allowables`: stress range reduction factor f, allowable displacement stress range S_A and occasional limit (07 PST M1). */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import { computeAllowables } from '../code/allowables';
import { RULE_SET_IDS, ruleSetOf } from '../code/ruleSets';
import { refuse } from '../codes';

const fixed = (value: number): string => value.toFixed(3);

/**
 * @affects none; data = { rule, occasionalRatio?, occasionalOk?, f, fRaw, fCap, limited, SA1aMPa, SA1bMPa, SAMPa, equation, occasionalFactor, occasionalMPa, ruleRows, defaulted, reviewRequired, provenance }
 * @invariant read-only closed form; allowable stresses are inputs (never defaulted, D9); f = max(floor, min(raw, cap)); the cap is 1.0 unless ferrousLowStrength is stated true
 * @failure occasionalEvents with a B31.3 rule set -> PST_PARAM_INVALID; non-positive stress or cycles below 1 -> schema rejection
 */
export const pipeStressAllowables = defineCommand({
  name: 'pipe_stress_allowables',
  description:
    'Allowable stresses of a piping code from allowable stresses you give: the stress range reduction factor f for N full-range thermal cycles, the allowable displacement stress range ' +
    'S_A by eq. (1a) f (1.25 Sc + 0.25 Sh) and, when you give the sustained longitudinal stress SL, eq. (1b) f [1.25 (Sc + Sh) - SL] (it governs when Sh > SL), and the occasional limit ' +
    '(B31.3: 1.33 Sh; with sustainedMPa and occasionalLoadMPa also the ratio (S_L + S_occ) / limit; B31.1: 1.15 Sh, or 1.2 Sh for events up to 1 % of the time). f = 6 N^-0.2 up to the 2020 editions and 20 N^(-1/3) from B31.3-2022, never below 0.15 and capped at 1.2 only when ' +
    'ferrousLowStrength is true (ferrous material, SMTS up to 517 MPa, metal temperature up to 371 degC; B31.1 caps at 1.0), else 1.0 and the result lists it as defaulted. ' +
    'Example: Sc = Sh = 137.9 MPa, SL = 40, rule B31.3-2018, 100000 cycles: f 0.6, S_A 124.11 (1a) and 182.85 (1b) MPa. Stresses are MPa. The allowable stresses come from the code tables ' +
    '(licensed; llull never defaults them). The edition is required (rule). Read-only quick check; reviewRequired is always true. Next: pipe_sif for the factors that multiply the moments.',
  params: z.object({
    rule: z
      .enum(RULE_SET_IDS)
      .describe('Rule set "B31.3-<edition>" (2016 to 2024) or "B31.1-<edition>" (2016 to 2022). Required, no default edition.'),
    ScMPa: z.number().positive().describe('Basic allowable stress at the minimum (cold) metal temperature in MPa, from the code table.'),
    ShMPa: z.number().positive().describe('Basic allowable stress at the maximum (hot) metal temperature in MPa, from the code table.'),
    cycles: z
      .number()
      .min(1)
      .describe('Equivalent number of full displacement stress range cycles N over the design life (1 or more). Typical 7000.'),
    SLMPa: z
      .number()
      .min(0)
      .describe('Calculated sustained longitudinal stress S_L in MPa; enables eq. (1b). Omit to get eq. (1a) only.')
      .optional(),
    ferrousLowStrength: z
      .boolean()
      .describe(
        'True only when the material is ferrous with SMTS <= 517 MPa and the metal temperature <= 371 degC (allows the 1.2 cap of B31.3). Default false (cap 1.0).',
      )
      .optional(),
    sustainedMPa: z
      .number()
      .min(0)
      .describe('Sustained stress S_L in MPa to add to the occasional stress for the occasional check (give with occasionalLoadMPa).')
      .optional(),
    occasionalLoadMPa: z
      .number()
      .min(0)
      .describe('Stress from the occasional load alone in MPa (wind, seismic, relief). Give with sustainedMPa to get occasionalRatio.')
      .optional(),
    occasionalEvents: z
      .enum(['upTo10Percent', 'upTo1Percent'])
      .describe(
        'B31.1 only: share of the operating time the occasional load acts (up to 10 %: 1.15 Sh; up to 1 %: 1.2 Sh). Default up to 10 %.',
      )
      .optional(),
  }),
  annotations: { readOnly: true, idempotent: true },
  run: (doc, params) => {
    const set = ruleSetOf(params.rule);
    if (params.occasionalEvents !== undefined && set.code !== 'B31.1')
      return refuse(
        doc,
        'pipe_stress_allowables',
        'PST_PARAM_INVALID',
        'occasionalEvents applies to B31.1 rule sets only',
        [],
        ['occasionalEvents'],
      );
    if ((params.sustainedMPa === undefined) !== (params.occasionalLoadMPa === undefined))
      return refuse(
        doc,
        'pipe_stress_allowables',
        'PST_PARAM_INVALID',
        'give sustainedMPa and occasionalLoadMPa together',
        [],
        ['sustainedMPa', 'occasionalLoadMPa'],
      );
    const defaulted = [
      ...(params.ferrousLowStrength === undefined ? ['ferrousLowStrength=false (cap 1.0)'] : []),
      ...(set.code === 'B31.1' && params.occasionalEvents === undefined ? ['occasionalEvents=upTo10Percent (1.15 Sh)'] : []),
    ];
    const result = computeAllowables(set, {
      ScMPa: params.ScMPa,
      ShMPa: params.ShMPa,
      cycles: params.cycles,
      sustainedStressMPa: params.SLMPa,
      ferrousLowStrength: params.ferrousLowStrength ?? false,
      occasionalClass: params.occasionalEvents ?? 'default',
    });
    const { rules, ...numbers } = result;
    const occasional =
      params.sustainedMPa === undefined || params.occasionalLoadMPa === undefined
        ? {}
        : {
            occasionalSumMPa: params.sustainedMPa + params.occasionalLoadMPa,
            occasionalRatio: (params.sustainedMPa + params.occasionalLoadMPa) / result.occasionalMPa,
            occasionalOk: params.sustainedMPa + params.occasionalLoadMPa <= result.occasionalMPa,
            occasionalRuleGrade: rules.find((row) => row.id.endsWith('-OCC'))?.grade ?? 'B',
          };
    return report(
      doc,
      `pipe_stress_allowables: ${set.id}, N ${params.cycles}: f ${fixed(result.f)}${result.limited === 'none' ? '' : ` (${result.limited})`}, S_A ${fixed(result.SAMPa)} MPa by eq. ${result.equation} ` +
        `(1a ${fixed(result.SA1aMPa)}${result.SA1bMPa === null ? '' : `, 1b ${fixed(result.SA1bMPa)}`}), occasional limit ${fixed(result.occasionalMPa)} MPa (${result.occasionalFactor} Sh)` +
        `${defaulted.length > 0 ? `; defaulted: ${defaulted.join(', ')}` : ''}.`,
      {
        rule: set.id,
        ...numbers,
        ...occasional,
        ruleRows: rules,
        defaulted,
        reviewRequired: true,
        provenance: { method: 'closed form', rule: set.id, inputs: params, defaulted },
      },
    );
  },
});
