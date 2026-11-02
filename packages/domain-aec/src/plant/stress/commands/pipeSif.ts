/** `pipe_sif`: stress intensification and flexibility factors of a pipe component (07 PST M1, TR-PST-07 / 10). */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { computeSif, isSifRefusal, SIF_COMPONENTS } from '../code/sif';
import { RULE_SET_IDS, ruleRows, ruleSetOf } from '../code/ruleSets';
import { refuse, SIF_EDITION_WARNING } from '../codes';

const userSif = z.object({
  ii: z.number().min(1).describe('In-plane stress intensification factor (>= 1).'),
  io: z.number().min(1).describe('Out-of-plane stress intensification factor (>= 1).'),
  k: z.number().min(1).describe('Flexibility factor (>= 1). 1 for a fitting that is stiffer than the pipe.'),
  source: z.string().min(1).describe('Where the factors come from (B31J table, manufacturer data, test report). Recorded in the result.'),
});

/**
 * @affects none; data = { component, rule, h, k, ii, io, formula, grade, ruleRows, warnings, reviewRequired, provenance }
 * @invariant read-only closed form; B31.1 returns one SIF for both planes (ii = io); rule "user" returns the caller's factors unchanged and unverified
 * @failure non-physical wall, missing bendRadiusMm / padMm, sweepolet / reducer without user factors, rule "user" without userSif -> PST_PARAM_INVALID;
 *   editions needing B31J -> value returned with a non-hideable PST_SIF_EDITION warning
 */
export const pipeSif = defineCommand({
  name: 'pipe_sif',
  description:
    'Stress intensification factors (ii in-plane, io out-of-plane) and flexibility factor k of one pipe component, by closed form from the code appendix D, e.g. a 6 inch ' +
    'Sch 40 long radius elbow (OD 168.3, wall 7.11, R1 228.6 mm) gives h 0.2502, k 6.594, ii 2.267, io 1.889. Components: elbow / bend (needs bendRadiusMm), welding_tee, ' +
    'unreinforced_tee, reinforced_tee (needs padMm), weldolet, butt_weld; sweepolet and reducer have no factor in a read source and need rule "user". ' +
    'The rule is "B31.3-<edition>" (2016 to 2024) or "B31.1-<edition>" (2016 to 2022) or "user"; there is no default edition. Editions 2020 and later require ASME B31J ' +
    '(tables not public): the appendix D value is still returned with a non-hideable PST_SIF_EDITION warning, or give the B31J values with rule "user" and userSif. ' +
    'Bends are grade A, tees and olets grade B (named in the result); B31.1 returns one SIF for both planes. All lengths are mm. ' +
    'Read-only quick check, not a stress analysis; reviewRequired is always true. Next: pipe_stress_allowables for the allowable range.',
  params: z.object({
    component: z.enum(SIF_COMPONENTS).describe('Component whose factors are wanted.'),
    odMm: z.number().positive().describe('Outside diameter of the matching pipe in mm.'),
    wallMm: z.number().positive().describe('Nominal wall thickness T of the matching pipe in mm.'),
    bendRadiusMm: z
      .number()
      .positive()
      .describe('Centreline bend radius R1 in mm (elbow / bend). Long radius is 1.5 x nominal size, short radius 1.0 x.')
      .optional(),
    padMm: z.number().positive().describe('Thickness tr of the reinforcing pad or saddle in mm (reinforced_tee only).').optional(),
    rule: z
      .enum([...RULE_SET_IDS, 'user'] as const)
      .describe('Rule set: "B31.3-<edition>", "B31.1-<edition>" or "user" (factors given in userSif). Required.'),
    userSif: userSif
      .describe('Factors to return unchanged (rule "user" only): B31J values, manufacturer data. They stay unverified.')
      .optional(),
  }),
  annotations: { readOnly: true, idempotent: true },
  run: (doc, params): CommandResult => {
    const fail = (message: string, path: string): CommandResult => refuse(doc, 'pipe_sif', 'PST_PARAM_INVALID', message, [], [path]);
    const inputs = {
      component: params.component,
      odMm: params.odMm,
      wallMm: params.wallMm,
      ...(params.bendRadiusMm === undefined ? {} : { bendRadiusMm: params.bendRadiusMm }),
      ...(params.padMm === undefined ? {} : { padMm: params.padMm }),
    };
    if (params.rule === 'user') {
      if (params.userSif === undefined) return fail('rule "user" needs userSif { ii, io, k, source }', 'userSif');
      const { ii, io, k, source } = params.userSif;
      return report(doc, `pipe_sif: ${params.component} user factors ii ${ii}, io ${io}, k ${k} (${source}); unverified.`, {
        component: params.component,
        rule: 'user',
        h: null,
        k,
        ii,
        io,
        formula: 'caller-supplied',
        grade: 'C',
        unverified: true,
        source,
        ruleRows: [],
        warnings: [{ code: 'PST_SIF_UNVERIFIED', message: `factors from ${source} are not checked by llull` }],
        reviewRequired: true,
        provenance: { method: 'user-supplied factors', rule: 'user', inputs, defaulted: [] },
      });
    }
    const set = ruleSetOf(params.rule);
    const values = computeSif(set, inputs);
    if (isSifRefusal(values)) return fail(values.reason, values.path);
    const b31j = set.sifBasis === 'b31j';
    const rows = ruleRows(values.ruleRow, ...(b31j ? ['SIF-B31J'] : []));
    return report(
      doc,
      `pipe_sif: ${params.component} ${params.odMm} x ${params.wallMm} mm, ${set.id}: ${values.h === null ? '' : `h ${values.h.toFixed(4)}, `}k ${values.k.toFixed(4)}, ii ${values.ii.toFixed(4)}, io ${values.io.toFixed(4)} (grade ${values.grade}${b31j ? '; PST_SIF_EDITION: edition needs B31J, appendix D value shown' : ''}).`,
      {
        component: params.component,
        rule: set.id,
        h: values.h,
        k: values.k,
        ii: values.ii,
        io: values.io,
        formula: values.formula,
        grade: values.grade,
        ruleRows: rows,
        warnings: b31j ? [SIF_EDITION_WARNING] : [],
        reviewRequired: true,
        provenance: { method: 'closed form', rule: set.id, ruleRow: values.ruleRow, inputs, defaulted: [] },
      },
    );
  },
});
