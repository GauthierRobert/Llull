/** One nozzle rule and its evaluation on a load in the nozzle frame, shared by `nozzle_load_check` (given loads) and `check_nozzle_loads` (stored results). */

import { z } from '@core/commands/schema';
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
} from './nozzleLimits';

export const finite = z.number().refine(Number.isFinite, 'must be finite');
export const vec3 = z.tuple([finite, finite, finite]);
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

export const nozzleRuleShape = {
  standard: z.enum(['nema_sm23', 'api617', 'api610', 'user']).describe('Rule to check against.'),
  nominalIn: z
    .number()
    .positive()
    .describe('Nominal nozzle size D in inches (needed by nema_sm23 and api617; informational for api610).')
    .optional(),
  orientation: z
    .enum(['top', 'side', 'end'])
    .describe('API 610 nozzle orientation (which Table 5 force row applies). Required for api610.')
    .optional(),
  table: table.describe('API 610 Table 5 values for this nozzle size (api610 only).').optional(),
  userLimits: userLimits.describe('Limits for standard "user" (same units as the loads).').optional(),
};

export type NozzleRule = {
  readonly standard: 'nema_sm23' | 'api617' | 'api610' | 'user';
  readonly nominalIn?: number | undefined;
  readonly orientation?: 'top' | 'side' | 'end' | undefined;
  readonly table?: z.infer<typeof table> | undefined;
  readonly userLimits?: z.infer<typeof userLimits> | undefined;
};

export interface NozzleEvaluation {
  readonly ok: boolean;
  readonly ratio: number;
  readonly grade: 'B' | 'C';
  readonly ruleId: string;
  readonly unverified: string[];
  readonly warnings: { code: string; message: string }[];
  readonly numbers: Record<string, unknown>;
  readonly forceLbf: Vec3;
  readonly momentFtLbf: Vec3;
}

export interface NozzleRuleError {
  readonly error: { readonly code: string; readonly message: string; readonly path: string };
}

/** Evaluate `rule` on a nozzle load (`si`: N and N.m, else lbf and ft.lbf) in the nozzle frame. */
export function evaluateNozzleRule(rule: NozzleRule, given: Vec3, givenMoment: Vec3, si: boolean): NozzleEvaluation | NozzleRuleError {
  const fail = (code: string, message: string, path: string): NozzleRuleError => ({ error: { code, message, path } });
  const params = rule;
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
        components.push({ name: 'F', value: resultant(given), limit: user.resultantForce, ratio: resultant(given) / user.resultantForce });
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
  return { ok: ratio <= 1, ratio, grade, ruleId, unverified, warnings, numbers, forceLbf, momentFtLbf };
}
