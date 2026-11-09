/**
 * compute_margins criterion "joint" (PHY-06 FR-CNT-12): the separation and fastener-ultimate margins of a preloaded bolt from a solved nonlinear_static case.
 * The rows live in the margin table, so dispose_margin / margin_disposition_payload resolve them like every other row (one signed human gate).
 */

import type { AnalysisCase } from '@core/model/analysis';
import { documentIdentity } from '@core/model/documentUid';
import type { CadDocument } from '@core/model/types';
import type { ExecutionContext } from '@core/commands/types';
import { z } from '@core/commands/schema';
import { significantNumber } from '@lib/compactNumber';
import { analysisInputHash } from '../hash/inputHash';
import { dispositionOf } from '../margins/disposition';
import { marginOfSafety, statusOf, type MarginStatus } from '../margins/marginMath';
import { NOT_APPROVED } from './codes';
import { isSeries, jointSeriesOf, type Point } from './jointSeries';
import { forceUnitName } from './pretensionRules';

const n = (value: number): string => significantNumber(value, 5);

const positive = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value > 0;

export const jointMarginSchema = z
  .object({
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
  })
  .describe(
    'criterion joint only (PHY-06, a solved nonlinear_static case with a bolt pretension): rows joint_separation (MS = P_sep / (FF x FS_sep x P_design) - 1, P_sep = the ' +
      'applied load of the last increment before the clamp zone opens, a lower bound; refused with CNT_SEPARATED when it is open at the first increment; the largest ' +
      'load reached when it never opens, basis lower_bound) and fastener_ultimate (only with fastenerAllowable: MS = P_tu-allow / N - 1, N = the bolt force on the FE ' +
      'curve at the factored load FF x FS_u x P_design; no row and a warning when the curve does not reach it). The load must rise monotonically over the step ' +
      '(CNT_INPUT_INVALID otherwise). Every factor, the design load and the allowable are REQUIRED with their source, none has a default (CNT_FACTORS_UNSET). Rows ' +
      'are reviewRequired and FAIL / MARGINAL rows stay pending_human until dispose_margin (same params). joint_slip is not an FE criterion here: bolted_joint_check ' +
      '(NASA-STD-5020 A.10-4) and check_contact (CNT_SLIP). allowable / groupBy / loadCases / singularity params do not apply.',
  );

type JointInput = z.output<typeof jointMarginSchema>;

interface Refusal {
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
}

interface JointQuery {
  readonly joint?: JointInput | undefined;
  readonly allowable?: unknown;
  readonly groupBy?: unknown;
  readonly loadCases?: unknown;
  readonly singularityRadius?: unknown;
  readonly singularityNote?: unknown;
  readonly marginalBand?: number | undefined;
}

interface Row {
  readonly rowId: string;
  readonly ms: number | null;
  readonly status: MarginStatus | 'NOT_ASSESSED';
  readonly disposition: string;
  readonly [key: string]: unknown;
}

interface Table {
  readonly analysis: AnalysisCase;
  readonly rows: readonly Row[];
  readonly summary: string;
  readonly data: Record<string, unknown>;
}

/** Bolt force at applied load `load` by linear interpolation between the points that bracket it (load rising); null outside the range. */
function forceAt(points: readonly Point[], load: number): number | null {
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    if (a === undefined || b === undefined) continue;
    if (load >= a.load && load <= b.load)
      return a.load === b.load ? Math.max(a.force, b.force) : a.force + ((b.force - a.force) * (load - a.load)) / (b.load - a.load);
  }
  return null;
}

/**
 * The joint margin table of a solved nonlinear_static case (rows r1 = joint_separation, r2 = fastener_ultimate when an allowable is given).
 * @invariant capacity of the separation row is a lower bound; the ultimate margin evaluates the FE bolt force at the factored load (no linear-theory equation);
 *   every row reviewRequired; FAIL / MARGINAL rows pending_human through the 05 dispositionOf
 * @failure no joint param / stress-only params -> FEA_MARGIN_PARAM_INVALID; a factor, the design load or its source missing -> CNT_FACTORS_UNSET; allowable <= 0 ->
 *   CNT_INPUT_INVALID; the clamp zone open at the first increment -> CNT_SEPARATED; a falling load -> CNT_INPUT_INVALID; the refusals of the bolt / probe / results lookup
 */
export function jointMarginTable(
  doc: CadDocument,
  { id: analysisId }: AnalysisCase,
  query: JointQuery,
  ctx: ExecutionContext | undefined,
): Table | Refusal {
  const refuse = (code: string, message: string): Refusal => ({ code, message, ids: [analysisId] });
  const stressOnly = (['allowable', 'groupBy', 'loadCases', 'singularityRadius', 'singularityNote'] as const).filter(
    (key) => query[key] !== undefined,
  );
  if (stressOnly.length > 0) return refuse('FEA_MARGIN_PARAM_INVALID', `${stressOnly.join(', ')} do not apply to criterion joint`);
  const input = query.joint;
  if (input === undefined)
    return refuse(
      'FEA_MARGIN_PARAM_INVALID',
      'criterion joint needs joint { pretension, loadProbe, stepId, designLoad, factors, fastenerAllowable? }',
    );
  const { factors, designLoad, fastenerAllowable } = input;
  const { separation: fsSeparation, ultimate: fsUltimate, fitting } = factors;
  if (!positive(fsSeparation) || !positive(fsUltimate) || !positive(fitting) || (factors.source ?? '').trim() === '')
    return refuse(
      'CNT_FACTORS_UNSET',
      'joint.factors.separation, ultimate and fitting (each > 0) and factors.source are required: there is no default',
    );
  if (!positive(designLoad.value) || designLoad.source.trim() === '')
    return refuse('CNT_FACTORS_UNSET', 'joint.designLoad.value must be > 0 with a source');
  if (fastenerAllowable !== undefined && (!positive(fastenerAllowable.value) || fastenerAllowable.source.trim() === ''))
    return refuse('CNT_INPUT_INVALID', 'joint.fastenerAllowable.value must be > 0 with a source');
  const series = jointSeriesOf(doc, 'compute_margins', { analysisId, ...input }, ctx);
  if (!isSeries(series)) return refuse(series.error?.code ?? 'CNT_INPUT_INVALID', series.summary);
  const { analysis, bolt, probe, stepId, points, separatedAt } = series;
  if (points.length < 2)
    return refuse('CNT_INPUT_INVALID', `fewer than 2 increments of step '${stepId}' carry both a bolt force and a probe load`);
  if (!series.monotonic)
    return refuse(
      'CNT_INPUT_INVALID',
      `the applied load of step '${stepId}' falls between two increments (unloading or reversal): the separation load and the force interpolation need a rising load`,
    );
  const closed = separatedAt === null ? points : points.filter((point) => point.time < separatedAt);
  if (closed.length === 0)
    return refuse(
      'CNT_SEPARATED',
      `the clamp zone of '${bolt.id}' is already open at the first increment of step '${stepId}': the joint has no separation capacity in this step`,
    );
  const capacity = Math.max(...closed.map((point) => point.load));
  const force = forceUnitName(analysis.unitSystem);
  const resultsHash = analysis.results?.resultsHash ?? '';
  const inputHash = analysisInputHash(doc, analysis.id, 'full');
  const band = query.marginalBand;
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
  const built: Record<string, unknown>[] = [
    build('joint_separation', marginOfSafety(capacity, designLoad.value, fitting * fsSeparation), {
      formula: 'MS = P_sep / (FF x FS_sep x P_design) - 1',
      capacity,
      basis: separatedAt === null ? 'lower_bound (the clamp zone does not open in the load range)' : 'last closed increment (lower bound)',
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
      built.push(
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
  const rows = built.map((row, index): Row => ({ ...row, rowId: `r${index + 1}` }) as Row);
  const pending = rows.filter((row) => row.disposition === 'pending_human').length;
  const text = rows
    .map((row) => `${String(row['criterion'])} MS ${row.ms === null ? 'n/a' : n(row.ms)} (${String(row['statusLabel'])})`)
    .join('; ');
  const numeric = rows.flatMap((row) => (row.ms === null ? [] : [row.ms]));
  return {
    analysis,
    rows,
    summary: `compute_margins: bolt '${bolt.id}' in '${analysis.id}', step '${stepId}', probe '${probe.name}': ${text}; ${pending} pending a human disposition; factors from "${factors.source}". ${NOT_APPROVED}`,
    data: {
      analysisId: analysis.id,
      pretensionId: bolt.id,
      stepId,
      criterion: 'joint',
      marginalBand: band ?? null,
      rows,
      minMs: numeric.length === 0 ? null : Math.min(...numeric),
      factors: { separation: fsSeparation, ultimate: fsUltimate, fitting, source: factors.source },
      omitted: [
        'joint_slip: bolted_joint_check (NASA-STD-5020 A.10-4) and check_contact (CNT_SLIP); needs the shear load, not an FE criterion here',
      ],
      warnings,
      resultsHash,
      overall: rows.some((row) => row.status === 'FAIL') ? 'fail' : rows.some((row) => row.status === 'MARGINAL') ? 'marginal' : 'pass',
      reviewRequired: true,
    },
  };
}
