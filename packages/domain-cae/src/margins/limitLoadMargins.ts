/** compute_margins criterion "limit_load" (PHY-05 FR-NLS-14, §5.7): MS = P_limit / (P_design x FoS x prod(extra)) - 1 from a nonlinear curve. */

import type { AnalysisCase, CurveProbe, LoadCategory } from '@core/model/analysis';
import { documentIdentity } from '@core/model/documentUid';
import type { CadDocument } from '@core/model/types';
import type { ExecutionContext } from '@core/commands/types';
import { z } from '@core/commands/schema';
import { significantNumber } from '@lib/compactNumber';
import { analysisInputHash } from '../hash/inputHash';
import { loadBaseValue } from '../nonlinear/history';
import { limitLoadReport, limitLoadShape } from '../nonlinear/limitLoadQuery';
import { adequacyOf } from '../results/adequacy';
import { adequacyWarnings, gateRows, notAssessedText, overallOf } from './adequacyGate';
import { dispositionOf } from './disposition';
import { appliedFactor, factorReport, marginOfSafety, statusOf, type MarginStatus } from './marginMath';

export const limitLoadMarginSchema = z
  .object({
    ...limitLoadShape,
    designLoad: z
      .object({
        value: z.number().describe('Design LIMIT (or ultimate) load on the curve load axis, analysis force units, > 0.'),
        category: z
          .enum(['limit', 'ultimate'])
          .describe('limit: MS uses the ultimate factor; ultimate: only the extra factors (14 CFR 25.303).'),
        source: z.string().describe('Where the design load comes from (loads report, owner instruction); mandatory.'),
      })
      .optional()
      .describe(
        'The load the part must carry. Default for a load curve probe: the probe load as defined by add_fea_load (multiplier 1) with its category; REQUIRED for a reaction probe.',
      ),
  })
  .describe(
    'criterion limit_load only (PHY-05, a solved nonlinear_static case): ONE row, MS = P_limit / (P_design x ultimate factor x extras) - 1 ' +
      '(ultimate design load: extras only); P_limit is found on curve probe as limit_load does (method peak / plateau / auto); P_design = ' +
      'designLoad or the probe load as defined by add_fea_load; a curve that never peaks uses its lower bound (row basis lower_bound, ' +
      'NLS_LIMIT_NOT_REACHED, conservative); VNV_NO_CONVERGENCE_STUDY without a PHY-00 study; allowable / groupBy / loadCases / singularity ' +
      'params do not apply. Rows are reviewRequired and FAIL / MARGINAL rows stay pending_human until dispose_margin (same params).',
  );

type LimitLoadMarginInput = z.output<typeof limitLoadMarginSchema>;

interface Table {
  readonly analysis: AnalysisCase;
  readonly rows: readonly {
    readonly rowId: string;
    readonly ms: number | null;
    readonly status: MarginStatus | 'NOT_ASSESSED';
    readonly disposition: string;
    readonly [key: string]: unknown;
  }[];
  readonly summary: string;
  readonly data: Record<string, unknown>;
}

interface Refusal {
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
}

interface LimitLoadMarginQuery {
  readonly limitLoad?: LimitLoadMarginInput | undefined;
  readonly allowable?: unknown;
  readonly groupBy?: unknown;
  readonly loadCases?: unknown;
  readonly singularityRadius?: unknown;
  readonly singularityNote?: unknown;
  readonly marginalBand?: number | undefined;
  readonly acceptInadequateMesh?: boolean | undefined;
}

/** The design load of the row: stated, or the load of a load-kind probe at multiplier 1. */
function designOf(
  analysis: AnalysisCase,
  input: LimitLoadMarginInput,
  probe: CurveProbe,
): { readonly value: number; readonly category: LoadCategory; readonly source: string; readonly stated: boolean } | string {
  const stated = input.designLoad;
  if (stated !== undefined) {
    if (!(Number.isFinite(stated.value) && stated.value > 0)) return 'limitLoad.designLoad.value must be a finite number > 0';
    if (stated.source.trim() === '') return 'limitLoad.designLoad.source is mandatory';
    return { value: stated.value, category: stated.category, source: stated.source.trim(), stated: true };
  }
  const loadId = probe.load.kind === 'load' ? probe.load.loadId : undefined;
  const load = loadId !== undefined && Object.hasOwn(analysis.loads, loadId) ? analysis.loads[loadId] : undefined;
  if (load === undefined)
    return 'a reaction curve probe has no design load of its own: pass limitLoad.designLoad { value, category, source }';
  const value = loadBaseValue(load);
  if (!(value > 0)) return `load '${load.name}' has no positive magnitude to use as design load: pass limitLoad.designLoad`;
  return {
    value,
    category: load.category,
    source: `load '${load.name}' (${load.id}) as defined by add_fea_load, multiplier 1`,
    stated: false,
  };
}

/**
 * The limit-load margin table of a solved nonlinear_static case: one row per call (the curve of `limitLoad.probe`).
 * @invariant the capacity is the limit load (peak / plateau) or, when the curve never reaches one, its lower bound (row basis lower_bound,
 *   conservative); reviewRequired on every row; FAIL / MARGINAL rows stay pending_human until dispose_margin (human gate)
 * @failure no limitLoad param / stress-only params (allowable, groupBy, loadCases, singularity*) / bad design load -> FEA_MARGIN_PARAM_INVALID; the limitLoadReport refusals pass through
 */
export function limitLoadMarginTable(
  doc: CadDocument,
  { id: analysisId }: AnalysisCase,
  query: LimitLoadMarginQuery,
  ctx: ExecutionContext | undefined,
): Table | Refusal {
  const refuse = (code: string, message: string): Refusal => ({ code, message, ids: [analysisId] });
  const stressOnly = (['allowable', 'groupBy', 'loadCases', 'singularityRadius', 'singularityNote'] as const).filter(
    (key) => query[key] !== undefined,
  );
  if (stressOnly.length > 0) return refuse('FEA_MARGIN_PARAM_INVALID', `${stressOnly.join(', ')} do not apply to criterion limit_load`);
  const input = query.limitLoad;
  if (input === undefined)
    return refuse('FEA_MARGIN_PARAM_INVALID', 'criterion limit_load needs limitLoad { probe, method, plateau?, designLoad? }');
  const found = limitLoadReport(doc, analysisId, input, ctx);
  if ('code' in found) return refuse(found.code, found.message);
  const { analysis, result } = found;
  const design = designOf(analysis, input, found.probe);
  if (typeof design === 'string') return refuse('FEA_MARGIN_PARAM_INVALID', design);
  const factors = factorReport(analysis);
  const factor = appliedFactor(factors, 'ultimate', design.category);
  const capacity = result.found === 'not_reached' ? result.lowerBound : result.limitLoad;
  const ms = marginOfSafety(capacity, design.value, factor);
  const status = statusOf(ms, query.marginalBand);
  const rowKey = ['limit_load', found.probe.id, input.method].join('|');
  const decided = dispositionOf(
    analysis,
    { rowKey, status, ms, inputHash: analysisInputHash(doc, analysisId, 'full') },
    ctx?.humanSignature ?? null,
    found.resultsHash,
    documentIdentity(doc),
  );
  const row = {
    rowId: 'r1',
    rowKey,
    probe: found.probe.id,
    probeName: found.probe.name,
    criterion: 'limit_load',
    check: 'ultimate',
    category: design.category,
    method: input.method,
    basis: result.found === 'not_reached' ? 'lower_bound' : result.found,
    [`capacity${found.forceUnit}`]: capacity,
    [`designLoad${found.forceUnit}`]: design.value,
    designLoad: { value: design.value, category: design.category, source: design.source, stated: design.stated },
    atDisplacement: result.atDisplacement,
    curveHash: found.curveHash,
    factorApplied: factor,
    ms,
    status,
    ...(status === 'FAIL' ? { code: 'FEA_MS_NEGATIVE' } : status === 'MARGINAL' ? { code: 'FEA_MS_MARGINAL' } : {}),
    provenance: {
      formula: 'MS = P_limit / (P_design x FoS x prod(extra)) - 1',
      standard: ['NASA-STD-5001B', '14 CFR 25.303', '14 CFR 25.305(a)'],
      limitLoad: found.provenance,
      ...(ms === null ? { note: 'design load is zero: no finite margin' } : {}),
    },
    unverified: found.unverifiedReasons.length > 0,
    unverifiedReasons: found.unverifiedReasons,
    reviewRequired: true,
    reviewReason: 'a limit-load margin of safety supports a structural substantiation decision',
    disposition: decided.disposition,
    statusLabel: decided.statusLabel,
    ...(decided.record !== undefined ? { dispositionRecord: decided.record } : {}),
    ...(decided.note !== undefined ? { dispositionNote: decided.note } : {}),
    ...(decided.code !== undefined ? { dispositionCode: decided.code } : {}),
  };
  const adequacy = adequacyOf(found.results, found.mesh);
  const gate = gateRows([row], adequacy, query.acceptInadequateMesh === true);
  const rows = gate.rows;
  const gated = rows[0];
  const pending = rows.filter((entry) => entry.disposition === 'pending_human').length;
  const worst = gate.gated
    ? notAssessedText(gate.reasons)
    : `MS ${ms === null ? 'n/a' : significantNumber(ms, 4)} (${String(gated?.['statusLabel'] ?? status)}): capacity ${significantNumber(capacity, 6)} ${found.forceUnit} (${row.basis}) against design ${significantNumber(design.value, 6)} ${found.forceUnit} x factor ${significantNumber(factor, 4)}`;
  return {
    analysis,
    rows,
    summary: `compute_margins: '${analysisId}' limit_load curve '${found.probe.name}' ${worst}; ${pending} pending a human disposition; ${found.unverifiedReasons.length > 0 ? 'UNVERIFIED inputs; ' : ''}factors ultimate ${factors.ultimate.value} (${factors.ultimate.defaulted ? 'DEFAULT 14 CFR 25.303, not set by the user' : 'set via create_analysis'}). Computed by llull, not approved: needs a qualified engineer.`,
    data: {
      analysisId,
      unitSystem: analysis.unitSystem,
      resultsHash: found.resultsHash,
      criterion: 'limit_load',
      marginalBand: query.marginalBand ?? null,
      minMs: gate.gated ? null : ms,
      minMsRow: gate.gated ? null : 'r1',
      factors,
      rows,
      overall: overallOf(rows),
      meshAdequacy: adequacy,
      ...(gate.overrides.length > 0 ? { overrides: gate.overrides } : {}),
      warnings: [
        ...found.warnings,
        ...adequacyWarnings(gate, adequacy),
        ...(query.marginalBand === undefined ? ['FEA_MARGINAL_BAND_UNSET: no marginalBand given, so no row is MARGINAL'] : []),
        ...(typeof row.dispositionCode === 'string' ? [`${row.dispositionCode}: r1: ${String(row.dispositionNote)}`] : []),
      ],
      reviewRequired: true,
    },
  };
}
