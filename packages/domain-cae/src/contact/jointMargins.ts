/** joint_margins: the separation and fastener-ultimate margins of a preloaded bolt from a solved nonlinear_static case, as 05 margin rows (PHY-06 FR-CNT-12). */

import { documentIdentity } from '@core/model/documentUid';
import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { analysisInputHash } from '../hash/inputHash';
import { dispositionOf } from '../margins/disposition';
import { marginOfSafety, statusOf } from '../margins/marginMath';
import { analysisIdSchema } from '../shared/schemas';
import { NOT_APPROVED, refuseCnt } from './codes';
import { isSeries, jointSeriesOf, type Point } from './jointSeries';
import { forceUnitName } from './pretensionRules';

const n = (value: number): string => significantNumber(value, 5);

const positive = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value > 0;

/** Bolt force at applied load `load` by linear interpolation between the points that bracket it (points in time order, load rising); null outside the range. */
function forceAt(points: readonly Point[], load: number): number | null {
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    if (a === undefined || b === undefined) continue;
    if (load >= Math.min(a.load, b.load) && load <= Math.max(a.load, b.load))
      return a.load === b.load ? Math.max(a.force, b.force) : a.force + ((b.force - a.force) * (load - a.load)) / (b.load - a.load);
  }
  return null;
}

/**
 * @invariant read-only; separation capacity = the applied load of the last increment before the clamp zone opens (a lower bound: the true separation lies
 *   between it and the first open increment), or the largest load reached when it never opens (basis lower_bound); the ultimate margin evaluates the bolt force
 *   at the factored load FF x FS_u x P_design from the FE curve (no linear-theory equation); every row reviewRequired and FAIL / MARGINAL rows pending_human
 * @failure the joint_stiffness_from_fe refusals; a factor or design load missing / <= 0 -> CNT_FACTORS_UNSET (no defaults); fastenerAllowable <= 0 -> CNT_INPUT_INVALID
 */
export const jointMargins = defineCommand({
  name: 'joint_margins',
  description:
    'Joint margins of safety of a preloaded bolt from a SOLVED nonlinear_static analysis, as 05-style margin rows (reviewRequired, FAIL / MARGINAL rows pending_human): ' +
    'joint_separation: MS = P_sep / (FF x FS_sep x P_design) - 1 where P_sep is the applied load (curve probe loadProbe, same rules as joint_stiffness_from_fe) at the ' +
    'last increment of the step before the clamp zone opens (a lower bound; the largest load reached when it never opens: basis lower_bound); fastener_ultimate (only with ' +
    'fastenerAllowable): MS = P_tu_allow / N - 1 with N the bolt force at the factored load FF x FS_u x P_design, interpolated on the FE curve (a load beyond the ' +
    'curve gives no row and a warning). Every factor, the design load and the allowable are REQUIRED with their source, none has a default (CNT_FACTORS_UNSET). Forces in ' +
    'the analysis force unit. joint_slip is not an FE criterion here: use bolted_joint_check (NASA-STD-5020 A.10-4) and check_contact (CNT_SLIP). ' +
    NOT_APPROVED,
  annotations: { readOnly: true },
  params: z.object({
    analysisId: analysisIdSchema,
    pretension: z.string().describe('Bolt id (affected[1] of add_bolt_pretension) or unique name.'),
    loadProbe: z
      .string()
      .describe(
        'Curve probe (id or unique name) whose load axis is the applied external force through the joint (a reaction is sign-flipped).',
      ),
    stepId: z
      .string()
      .describe('Step (id or unique name) AFTER the preload step in which the external load grows to at least the factored design load.'),
    designLoad: z
      .object({
        value: z.number().describe('Design LIMIT load P_design through the joint, analysis force unit (> 0).'),
        source: z.string().describe('Where it comes from (loads report, owner instruction); mandatory.'),
      })
      .describe('The external tension load the joint must carry (limit).'),
    factors: z
      .object({
        separation: z.number().optional().describe('Factor of safety on separation FS_sep (> 0), from the programme; no default.'),
        ultimate: z.number().optional().describe('Ultimate factor of safety FS_u (> 0); no default.'),
        fitting: z.number().optional().describe('Fitting factor FF (> 0); no default.'),
        source: z.string().optional().describe('Who / which document sets the factors; mandatory.'),
      })
      .describe('Factors of safety and fitting factor; none is defaulted.'),
    fastenerAllowable: z
      .object({
        value: z.number().describe('Allowable tensile load P_tu-allow of the fastener, analysis force unit (> 0).'),
        source: z.string().describe('Where it comes from (fastener spec, test); mandatory.'),
      })
      .optional()
      .describe('Allowable fastener tension; absent = no fastener_ultimate row.'),
    marginalBand: z.number().optional().describe('MARGINAL when 0 <= MS < marginalBand; absent = no MARGINAL (named in the warnings).'),
  }),
  run: (doc, params, ctx?: ExecutionContext): CommandResult => {
    const command = 'joint_margins';
    const series = jointSeriesOf(doc, command, params, ctx);
    if (!isSeries(series)) return series;
    const { analysis, bolt, probe, stepId, points, separatedAt } = series;
    const fail = (code: string, message: string, path: string): CommandResult =>
      refuseCnt(doc, command, code, message, [analysis.id], [path]);
    const { factors, designLoad, fastenerAllowable } = params;
    const { separation: fsSeparation, ultimate: fsUltimate, fitting } = factors;
    if (!positive(fsSeparation) || !positive(fsUltimate) || !positive(fitting) || (factors.source ?? '').trim() === '')
      return fail(
        'CNT_FACTORS_UNSET',
        'factors.separation, ultimate and fitting (each > 0) and factors.source are required: there is no default',
        'factors',
      );
    if (!positive(designLoad.value) || designLoad.source.trim() === '')
      return fail('CNT_FACTORS_UNSET', 'designLoad.value must be > 0 with a source', 'designLoad');
    if (fastenerAllowable !== undefined && (!positive(fastenerAllowable.value) || fastenerAllowable.source.trim() === ''))
      return fail('CNT_INPUT_INVALID', 'fastenerAllowable.value must be > 0 with a source', 'fastenerAllowable');
    if (points.length < 2)
      return fail('CNT_INPUT_INVALID', `fewer than 2 increments of step '${stepId}' carry both a bolt force and a probe load`, 'stepId');
    const closed = separatedAt === null ? points : points.filter((point) => point.time < separatedAt);
    const capacity = Math.max(...(closed.length > 0 ? closed : points.slice(0, 1)).map((point) => point.load));
    const force = forceUnitName(analysis.unitSystem);
    const resultsHash = analysis.results?.resultsHash ?? '';
    const inputHash = analysisInputHash(doc, analysis.id, 'full');
    const band = params.marginalBand;
    const warnings: string[] = band === undefined ? ['FEA_MARGINAL_BAND_UNSET: no marginalBand given, so no row is MARGINAL'] : [];
    const build = (
      criterion: 'joint_separation' | 'fastener_ultimate',
      ms: number | null,
      extra: Record<string, unknown>,
    ): Record<string, unknown> => {
      const status = statusOf(ms, band);
      const rowKey = ['joint', bolt.id, criterion].join('|');
      const decided = dispositionOf(
        analysis,
        { rowKey, status, ms, inputHash },
        ctx?.humanSignature ?? null,
        resultsHash,
        documentIdentity(doc),
      );
      return {
        rowKey,
        pretensionId: bolt.id,
        criterion,
        ms,
        status,
        ...(status === 'FAIL' ? { code: 'CNT_MS_NEGATIVE' } : {}),
        ...extra,
        unverified: false,
        reviewRequired: true,
        reviewReason: 'a joint margin of safety supports a structural substantiation decision',
        disposition: decided.disposition,
        statusLabel: decided.statusLabel,
        ...(decided.record !== undefined ? { dispositionRecord: decided.record } : {}),
        ...(decided.note !== undefined ? { dispositionNote: decided.note } : {}),
        ...(decided.code !== undefined ? { dispositionCode: decided.code } : {}),
      };
    };
    const rows: Record<string, unknown>[] = [
      build('joint_separation', marginOfSafety(capacity, designLoad.value, fitting * fsSeparation), {
        formula: 'MS = P_sep / (FF x FS_sep x P_design) - 1',
        capacity,
        basis:
          separatedAt === null ? 'lower_bound (the clamp zone does not open in the load range)' : 'last closed increment (lower bound)',
        separatedAt,
        designLoad: { value: designLoad.value, source: designLoad.source },
        factorApplied: fitting * fsSeparation,
      }),
    ];
    if (fastenerAllowable !== undefined) {
      const factored = fitting * fsUltimate * designLoad.value;
      const bolted = forceAt(points, factored);
      if (bolted === null)
        warnings.push(
          `no fastener_ultimate row: the factored load ${n(factored)} ${force} is outside the load range of step '${stepId}' (${n(Math.min(...points.map((p) => p.load)))} .. ${n(Math.max(...points.map((p) => p.load)))} ${force}); load the model to it`,
        );
      else
        rows.push(
          build('fastener_ultimate', marginOfSafety(fastenerAllowable.value, bolted, 1), {
            formula: 'MS = P_tu-allow / N(FF x FS_u x P_design) - 1, N from the FE curve',
            capacity: fastenerAllowable.value,
            boltForce: bolted,
            factoredLoad: factored,
            allowable: { value: fastenerAllowable.value, source: fastenerAllowable.source },
            factorApplied: 1,
          }),
        );
    }
    rows.forEach((row, index) => Object.assign(row, { rowId: `r${index + 1}` }));
    const pending = rows.filter((row) => row['disposition'] === 'pending_human').length;
    const text = rows
      .map((row) => `${String(row['criterion'])} MS ${row['ms'] === null ? 'n/a' : n(Number(row['ms']))} (${String(row['statusLabel'])})`)
      .join('; ');
    return report(
      doc,
      `${command}: bolt '${bolt.id}' in '${analysis.id}', step '${stepId}', probe '${probe.name}': ${text}; ${pending} pending a human disposition; factors from "${factors.source}". ${NOT_APPROVED}`,
      {
        analysisId: analysis.id,
        pretensionId: bolt.id,
        stepId,
        criterion: 'joint',
        marginalBand: band ?? null,
        rows,
        minMs: rows.reduce<number | null>((low, row) => (typeof row['ms'] === 'number' ? Math.min(low ?? Infinity, row['ms']) : low), null),
        factors: { separation: fsSeparation, ultimate: fsUltimate, fitting, source: factors.source },
        omitted: [
          'joint_slip: bolted_joint_check (NASA-STD-5020 A.10-4) and check_contact (CNT_SLIP); needs the shear load, not an FE criterion here',
        ],
        warnings,
        resultsHash,
        reviewRequired: true,
      },
    );
  },
});
