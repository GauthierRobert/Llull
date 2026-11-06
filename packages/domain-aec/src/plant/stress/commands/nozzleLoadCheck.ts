/** `nozzle_load_check`: equipment nozzle loads against NEMA SM 23, API 617, API 610 Annex F component limits or user limits (07 PST M5b, TR-PST-09, VC-PST-15). */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import {
  API610_FACTOR,
  API617_NEMA_FACTOR,
  componentChecks,
  FTLBF_TO_NM,
  LBF_TO_N,
  nemaCheck,
  resultant,
  scaled,
  type NozzleComponentCheck,
  type Vec3,
} from '../code/nozzleLimits';
import { ruleRows } from '../code/ruleSets';
import { refuse } from '../codes';

const finite = z.number().refine(Number.isFinite, 'must be finite');
const vec3 = z.tuple([finite, finite, finite]);
const limit = (what: string): z.ZodType<number> => z.number().positive().describe(what);

const forceLimits = z.object({
  Fx: limit('Limit of the force along x.'),
  Fy: limit('Limit of the force along y.'),
  Fz: limit('Limit of the force along z.'),
});
const momentLimits = z.object({
  Mx: limit('Limit of the moment about x.'),
  My: limit('Limit of the moment about y.'),
  Mz: limit('Limit of the moment about z.'),
});

const table = z.object({
  source: z
    .string()
    .min(1)
    .describe(
      'Where the table values come from (edition, table, page). Recorded; the values stay unverified until a qualified engineer confirms them.',
    ),
  forcesLbf: z
    .object({
      top: forceLimits.describe('Top nozzle row.').optional(),
      side: forceLimits.describe('Side nozzle row.').optional(),
      end: forceLimits.describe('End nozzle row.').optional(),
    })
    .describe('Table 5 force limits in lbf for the nozzle size, per orientation: { top: { Fx, Fy, Fz }, side?, end? }.'),
  momentsFtLbf: momentLimits.describe('Table 5 moment limits in ft.lbf for the nozzle size: { Mx, My, Mz }.'),
});

const userLimits = z.object({
  source: z.string().min(1).describe('Where the limits come from (vendor, standard, calculation). Recorded.'),
  forces: forceLimits.optional().describe('Limit per force component, in the units of the loads you pass.'),
  moments: momentLimits.optional().describe('Limit per moment component, in the units of the loads you pass.'),
  resultantForce: limit('Limit of the resultant force, in the units of the loads you pass.').optional(),
  resultantMoment: limit('Limit of the resultant moment, in the units of the loads you pass.').optional(),
});

/**
 * @affects none; data = { standard, rule, grade, nominalIn?, De?, forceLbf, momentFtLbf, resultantForceLbf, resultantMomentFtLbf, lhs?, limit?, ratio, components?, ok, warnings, unverified, reviewRequired, provenance }
 * @invariant read-only arithmetic on one nozzle: NEMA SM 23 3F + M <= 500 De, API 617 the same x 1.85, API 610 each component <= 2 x the imported Table 5 value, user limits as stated; loads are in the nozzle frame
 * @failure missing nominalIn / table / orientation / limits -> PST_PARAM_INVALID or PST_NOZZLE_LIMIT_MISSING; mixed unit systems -> PST_PARAM_INVALID; a ratio above 1 -> PST_NOZZLE_OVERLOAD (detail carries the whole check)
 */
export const nozzleLoadCheck = defineCommand({
  name: 'nozzle_load_check',
  description:
    'Check the load a pipe puts on ONE equipment nozzle against a rule: standard "nema_sm23" (steam turbines: 3 F + M <= 500 De with F the resultant force in lbf, M the resultant moment in ft.lbf, De = nominal size up to 8 in, (16 + D) / 3 above; ' +
    'e.g. NPS 6, F 500 lbf, M 1200 ft.lbf: ratio 0.9; NPS 10, F 600, M 2000: De 8.667, ratio 0.877), "api617" (compressors, 1.85 x NEMA SM 23), "api610" (pumps, Annex F F.1.2 a: each force and moment component within 2 x the Table 5 value; ' +
    'Table 5 is copyrighted so you pass the values for the nozzle size in `table`, with `orientation` top / side / end) or "user" (your own limits in `userLimits`, in the units of the loads). ' +
    'Give the loads in the NOZZLE frame (api610: the Annex F axes) as force N or lbf and moment N.m or ft.lbf, one unit system for both. ratio is load / limit (api610: the largest component ratio against 2 x Table 5); a ratio above 1 is refused with PST_NOZZLE_OVERLOAD and the components are in error.detail. ' +
    'Rule grade B (secondary sources; user limits grade C), api610 table values are unverified until a qualified engineer confirms them; the API 610 resultant equations (F.1.2 b, c) and the NEMA cumulative exhaust limits are NOT checked (PST_NOZZLE_LIMIT_UNVERIFIED warning). Read-only; reviewRequired is always true.',
  params: z.object({
    standard: z.enum(['nema_sm23', 'api617', 'api610', 'user']).describe('Rule to check against.'),
    nominalIn: z
      .number()
      .positive()
      .describe('Nominal nozzle size D in inches (needed by nema_sm23 and api617; informational for api610).')
      .optional(),
    forceN: vec3.describe('Nozzle force [Fx, Fy, Fz] in N, nozzle frame. Give this or forceLbf.').optional(),
    forceLbf: vec3.describe('Nozzle force [Fx, Fy, Fz] in lbf, nozzle frame. Give this or forceN.').optional(),
    momentNm: vec3.describe('Nozzle moment [Mx, My, Mz] in N.m, nozzle frame. Give this or momentFtLbf.').optional(),
    momentFtLbf: vec3.describe('Nozzle moment [Mx, My, Mz] in ft.lbf, nozzle frame. Give this or momentNm.').optional(),
    orientation: z
      .enum(['top', 'side', 'end'])
      .describe('API 610 nozzle orientation (which Table 5 force row applies). Required for api610.')
      .optional(),
    table: table.describe('API 610 Table 5 values for this nozzle size (api610 only).').optional(),
    userLimits: userLimits.describe('Limits for standard "user" (same units as the loads).').optional(),
  }),
  annotations: { readOnly: true, idempotent: true },
  run: (doc, params): CommandResult => {
    const fail = (code: string, message: string, path: string): CommandResult =>
      refuse(doc, 'nozzle_load_check', code, message, [], [path]);
    if ((params.forceN === undefined) === (params.forceLbf === undefined))
      return fail('PST_PARAM_INVALID', 'give exactly one of forceN and forceLbf', 'forceN');
    if ((params.momentNm === undefined) === (params.momentFtLbf === undefined))
      return fail('PST_PARAM_INVALID', 'give exactly one of momentNm and momentFtLbf', 'momentNm');
    const si = params.forceN !== undefined;
    if (si !== (params.momentNm !== undefined))
      return fail('PST_PARAM_INVALID', 'give force and moment in one unit system (N with N.m, or lbf with ft.lbf)', 'momentNm');
    const given: Vec3 = (params.forceN ?? params.forceLbf) as Vec3;
    const givenMoment: Vec3 = (params.momentNm ?? params.momentFtLbf) as Vec3;
    const forceLbf = si ? scaled(given, 1 / LBF_TO_N) : given;
    const momentFtLbf = si ? scaled(givenMoment, 1 / FTLBF_TO_NM) : givenMoment;
    const warnings: { code: string; message: string }[] = [];
    let numbers: Record<string, unknown>;
    let ruleId: string;
    let ratio: number;
    let grade: 'B' | 'C' = 'B';
    let unverified: string[] = [];
    if (params.standard === 'nema_sm23' || params.standard === 'api617') {
      if (params.nominalIn === undefined) return fail('PST_PARAM_INVALID', `${params.standard} needs nominalIn`, 'nominalIn');
      const check = nemaCheck(forceLbf, momentFtLbf, params.nominalIn, params.standard === 'api617' ? API617_NEMA_FACTOR : 1);
      ruleId = params.standard === 'api617' ? 'NOZZLE-API617' : 'NOZZLE-NEMA-SM23';
      ratio = check.ratio;
      numbers = { nominalIn: params.nominalIn, ...check };
      warnings.push({
        code: 'PST_NOZZLE_LIMIT_UNVERIFIED',
        message:
          'the NEMA SM 23 cumulative exhaust-connection limits are not checked; the per-connection rule is a secondary-source rule (grade B)',
      });
    } else {
      let components: NozzleComponentCheck[];
      if (params.standard === 'api610') {
        if (params.table === undefined || params.orientation === undefined)
          return fail(
            'PST_NOZZLE_LIMIT_MISSING',
            'api610 needs the Table 5 values (table) and the nozzle orientation',
            params.table === undefined ? 'table' : 'orientation',
          );
        const row = params.table.forcesLbf[params.orientation];
        if (row === undefined)
          return fail(
            'PST_NOZZLE_LIMIT_MISSING',
            `table.forcesLbf has no ${params.orientation} row`,
            `table.forcesLbf.${params.orientation}`,
          );
        const moments = params.table.momentsFtLbf;
        components = componentChecks(forceLbf, momentFtLbf, [row.Fx, row.Fy, row.Fz], [moments.Mx, moments.My, moments.Mz], API610_FACTOR);
        ruleId = 'NOZZLE-API610-F12A';
        unverified = [`API 610 Table 5 values are caller-supplied (${params.table.source})`];
        warnings.push({
          code: 'PST_NOZZLE_LIMIT_UNVERIFIED',
          message:
            'only the component check F.1.2 a ran; the resultant equations F.1.2 b and c are not applied (their text is not in a read source)',
        });
        numbers = {
          orientation: params.orientation,
          source: params.table.source,
          ...(params.nominalIn === undefined ? {} : { nominalIn: params.nominalIn }),
        };
      } else {
        const user = params.userLimits;
        if (user === undefined) return fail('PST_NOZZLE_LIMIT_MISSING', 'standard user needs userLimits', 'userLimits');
        components = componentChecks(
          given,
          givenMoment,
          user.forces === undefined ? null : [user.forces.Fx, user.forces.Fy, user.forces.Fz],
          user.moments === undefined ? null : [user.moments.Mx, user.moments.My, user.moments.Mz],
        );
        if (user.resultantForce !== undefined)
          components.push({
            name: 'F',
            value: resultant(given),
            limit: user.resultantForce,
            ratio: resultant(given) / user.resultantForce,
          });
        if (user.resultantMoment !== undefined)
          components.push({
            name: 'M',
            value: resultant(givenMoment),
            limit: user.resultantMoment,
            ratio: resultant(givenMoment) / user.resultantMoment,
          });
        if (components.length === 0) return fail('PST_NOZZLE_LIMIT_MISSING', 'userLimits states no limit', 'userLimits');
        ruleId = 'NOZZLE-USER';
        grade = 'C';
        unverified = [`user limits are caller-supplied (${user.source})`];
        numbers = { source: user.source, unit: si ? 'N, N.m' : 'lbf, ft.lbf' };
      }
      ratio = Math.max(...components.map((entry) => entry.ratio));
      numbers = { ...numbers, components };
    }
    const ok = ratio <= 1;
    const data = {
      standard: params.standard,
      forceLbf,
      momentFtLbf,
      resultantForceLbf: resultant(forceLbf),
      resultantMomentFtLbf: resultant(momentFtLbf),
      ...numbers,
      ratio,
      ok,
      rule: ruleId,
      grade,
      ruleRows: ruleRows(ruleId),
      warnings,
      unverified,
      reviewRequired: true,
      provenance: { method: 'closed form', rule: ruleId, inputs: params, defaulted: [] },
    };
    const text = `${params.standard}: ratio ${ratio.toFixed(4)}${typeof numbers['De'] === 'number' ? ` (De ${numbers['De'].toFixed(4)} in, 3F + M = ${(numbers['lhs'] as number).toFixed(1)} of ${(numbers['limit'] as number).toFixed(1)})` : ''}`;
    if (!ok)
      return refuse(doc, 'nozzle_load_check', 'PST_NOZZLE_OVERLOAD', `${text}: the nozzle load exceeds the limit`, [], ['forceLbf'], data);
    return report(
      doc,
      `nozzle_load_check: ${text}, within the limit; rule grade ${grade}${unverified.length > 0 ? ', limits unverified' : ''}.`,
      data,
    );
  },
});
