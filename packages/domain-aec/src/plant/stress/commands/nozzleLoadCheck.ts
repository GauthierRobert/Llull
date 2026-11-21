/** `nozzle_load_check`: equipment nozzle loads against NEMA SM 23, API 617, API 610 Annex F component limits or user limits (07 PST M5b, TR-PST-09, VC-PST-15). */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { evaluateNozzleRule, nozzleRuleShape, vec3 } from '../code/nozzleRule';
import { resultant, type Vec3 } from '../code/nozzleLimits';
import { ruleRows } from '../code/ruleSets';
import { refuse } from '../codes';

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
    ...nozzleRuleShape,
    forceN: vec3.describe('Nozzle force [Fx, Fy, Fz] in N, nozzle frame. Give this or forceLbf.').optional(),
    forceLbf: vec3.describe('Nozzle force [Fx, Fy, Fz] in lbf, nozzle frame. Give this or forceN.').optional(),
    momentNm: vec3.describe('Nozzle moment [Mx, My, Mz] in N.m, nozzle frame. Give this or momentFtLbf.').optional(),
    momentFtLbf: vec3.describe('Nozzle moment [Mx, My, Mz] in ft.lbf, nozzle frame. Give this or momentNm.').optional(),
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
    const evaluated = evaluateNozzleRule(params, given, givenMoment, si);
    if ('error' in evaluated) return fail(evaluated.error.code, evaluated.error.message, evaluated.error.path);
    const { ratio, grade, unverified, warnings, numbers, forceLbf, momentFtLbf, ruleId, ok } = evaluated;
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
