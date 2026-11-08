/** The margin part of substitute_material (PHY-12 FR-SEL-08, 09): rescaled margins when exact, else the re-solve plan. */

import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { issue } from './codes';
import { marginConditions, NU_TOLERANCE_DEFAULT, resolvePlan, rescaleMargin, type ConditionResult } from './marginRescale';
import { isAllowableRefusal, materialAllowable, type AllowableProperty } from '../margins/allowable';
import { propertyTemperatureK } from '../decks/elastic';
import { statusOf } from '../margins/marginMath';
import { analysisOf, caseOf } from '../shared/access';
import type { SelIssue } from './types';

interface MarginRowData {
  readonly rowId: string;
  readonly rowKey: string;
  readonly part: string;
  readonly region: string;
  readonly loadCase: string;
  readonly check: string;
  readonly criterion: string;
  readonly singular: boolean;
  readonly ms: number | null;
  readonly status: string;
  readonly factorApplied: number;
  readonly allowable?: { readonly property: string; readonly basis: string };
  readonly unverified: boolean;
  readonly unverifiedReasons: readonly string[];
}

interface MarginsData {
  readonly rows: readonly MarginRowData[];
  readonly resultsHash: string;
  readonly factors: unknown;
  readonly marginalBand: number | null;
}

interface RescaledMargin {
  readonly rowId: string;
  readonly rowKey: string;
  readonly part: string;
  readonly region: string;
  readonly loadCase: string;
  readonly check: string;
  readonly criterion: string;
  readonly singular: boolean;
  readonly factorApplied: number;
  readonly allowable: {
    readonly property: string;
    readonly from: { readonly valueMPa: number; readonly basis: string };
    readonly to: { readonly valueMPa: number; readonly basis: string };
  };
  readonly msFrom: number | null;
  readonly msTo: number | null;
  readonly statusFrom: string;
  readonly statusTo: string;
  readonly method: 'rescaled';
  readonly unverified: boolean;
  readonly unverifiedReasons: readonly string[];
  readonly reviewRequired: true;
}

export type MarginsOutcome =
  | { readonly kind: 'refused'; readonly code: string; readonly message: string; readonly path: string }
  | { readonly kind: 'data'; readonly data: Record<string, unknown>; readonly warnings: readonly SelIssue[]; readonly unverified: boolean };

interface Request {
  readonly entityIds: readonly string[];
  readonly from: string;
  readonly to: string;
  readonly analysisId: string | undefined;
  readonly nuTolerance: number | undefined;
  readonly marginalBand: number | undefined;
}

const noAnalysis = (reason: string, entityIds: readonly string[]): MarginsOutcome => ({
  kind: 'data',
  data: { code: 'SEL_NO_ANALYSIS', reason, ids: entityIds, reviewRequired: true },
  warnings: [issue('SEL_NO_ANALYSIS', 'info', reason, entityIds)],
  unverified: false,
});

/** The analysis whose parts hold the entities: the named one, the only one, or a refusal / SEL_NO_ANALYSIS. */
function pickAnalysis(doc: CadDocument, request: Request): { readonly id: string } | MarginsOutcome {
  if (request.analysisId !== undefined) {
    return caseOf(doc, request.analysisId) === undefined
      ? { kind: 'refused', code: 'SEL_PARAMS_INVALID', message: `no analysis '${request.analysisId}'`, path: 'analysisId' }
      : { id: request.analysisId };
  }
  const { cases, caseOrder } = analysisOf(doc);
  const holding = caseOrder.filter((id) => request.entityIds.some((entityId) => cases[id]?.parts[entityId] !== undefined));
  if (holding.length === 0) return noAnalysis('no analysis case has these entities as parts', request.entityIds);
  const [only, second] = holding;
  if (only === undefined || second !== undefined)
    return {
      kind: 'refused',
      code: 'SEL_PARAMS_INVALID',
      message: `${holding.length} analyses hold these entities (${holding.join(', ')}): name one with analysisId`,
      path: 'analysisId',
    };
  return { id: only };
}

/** The material strength a row was checked against (Ftu / Fty), else undefined: ply rows and explicit allowables are not rescalable. */
function materialProperty(row: Pick<MarginRowData, 'allowable'>): AllowableProperty | undefined {
  const property = row.allowable?.property;
  return property === 'Ftu' || property === 'Fty' ? property : undefined;
}

/** The refusal for a row whose allowable is not a material Ftu / Fty (SEL_MARGIN_ROW_UNSUPPORTED). */
export function unsupportedRow(row: Pick<MarginRowData, 'rowId' | 'allowable'>): Extract<MarginsOutcome, { kind: 'refused' }> {
  return {
    kind: 'refused',
    code: 'SEL_MARGIN_ROW_UNSUPPORTED',
    message: `row ${row.rowId} uses ${row.allowable === undefined ? 'no material allowable' : `the allowable '${row.allowable.property}'`}, not a material Ftu / Fty: rescaling is not defined`,
    path: 'analysisId',
  };
}

const isOutcome = (value: { readonly id: string } | MarginsOutcome): value is MarginsOutcome => 'kind' in value;

/**
 * Margins of the swap for the analysis holding `entityIds`.
 * @invariant rows are rescaled only when every blocking §5.4 condition holds; the rows are the compute_margins rows of the current results (default material allowable) with MS2 = (1 + MS1) A2 / A1 - 1;
 *   a non-blocking basis difference between the two allowables is reported (SEL_BASIS_MIXED), never hidden
 * @failure unknown / ambiguous analysisId -> refused; no analysis, no results, a case type without margins -> SEL_NO_ANALYSIS data; any blocking condition false -> SEL_MARGINS_NEED_RESOLVE data with the plan
 */
export function substituteMargins(doc: CadDocument, request: Request, ctx: ExecutionContext | undefined): MarginsOutcome {
  const picked = pickAnalysis(doc, request);
  if (isOutcome(picked)) return picked;
  const analysis = caseOf(doc, picked.id);
  if (analysis === undefined) return noAnalysis(`analysis '${picked.id}' disappeared`, request.entityIds);
  if (analysis.type !== 'static' && analysis.type !== 'thermo_static')
    return noAnalysis(`analysis '${analysis.id}' is ${analysis.type}: margins exist for static and thermo_static cases`, request.entityIds);
  const tolerance =
    request.nuTolerance === undefined
      ? { ...NU_TOLERANCE_DEFAULT, defaulted: true as const }
      : { value: request.nuTolerance, source: 'given by the caller (nuTolerance)', defaulted: false as const };
  const conditions = marginConditions(doc, analysis, {
    from: request.from,
    to: request.to,
    nuTolerance: tolerance.value,
    entityIds: request.entityIds,
  });
  const failed = conditions.filter((entry) => !entry.ok && entry.blocking);
  if (failed.length > 0) {
    const reason = `exactness condition(s) failed: ${failed.map((entry) => entry.condition).join(', ')}`;
    return {
      kind: 'data',
      data: {
        code: 'SEL_MARGINS_NEED_RESOLVE',
        analysisId: analysis.id,
        failedConditions: failed.map((entry) => entry.condition),
        conditions,
        nuTolerance: tolerance,
        resolvePlan: resolvePlan(analysis.id, request.to, request.entityIds),
        reviewRequired: true,
      },
      warnings: [issue('SEL_MARGINS_NEED_RESOLVE', 'info', reason, [analysis.id])],
      unverified: false,
    };
  }
  const margins = execute(
    doc,
    'compute_margins',
    { analysisId: analysis.id, ...(request.marginalBand === undefined ? {} : { marginalBand: request.marginalBand }) },
    ctx,
  );
  const computed = margins.data as MarginsData | undefined;
  if (margins.rejected === true || computed === undefined)
    return noAnalysis(`compute_margins gave no rows for '${analysis.id}': ${margins.summary}`, request.entityIds);
  const toMaterial = doc.materials[request.to];
  const temperatureK = propertyTemperatureK(analysis);
  const rows: RescaledMargin[] = [];
  for (const row of computed.rows) {
    const property = materialProperty(row);
    if (property === undefined) return unsupportedRow(row);
    if (toMaterial === undefined)
      return { kind: 'refused', code: 'SEL_MATERIAL_NOT_FOUND', message: `no material '${request.to}'`, path: 'to' };
    const fromMaterial = doc.materials[request.from];
    const allowanceFrom = fromMaterial === undefined ? undefined : materialAllowable(fromMaterial, request.from, property, temperatureK);
    const allowanceTo = materialAllowable(toMaterial, request.to, property, temperatureK);
    if (allowanceFrom === undefined || isAllowableRefusal(allowanceFrom))
      return {
        kind: 'refused',
        code: 'SEL_PROPERTY_MISSING',
        message: allowanceFrom === undefined ? `no material '${request.from}'` : allowanceFrom.message,
        path: 'from',
      };
    if (isAllowableRefusal(allowanceTo)) return { kind: 'refused', code: 'SEL_PROPERTY_MISSING', message: allowanceTo.message, path: 'to' };
    const msTo = row.ms === null ? null : rescaleMargin(row.ms, allowanceFrom.valueMpa, allowanceTo.valueMpa);
    const reasons = [...new Set([...row.unverifiedReasons, ...allowanceTo.unverifiedReasons])];
    rows.push({
      rowId: row.rowId,
      rowKey: row.rowKey,
      part: row.part,
      region: row.region,
      loadCase: row.loadCase,
      check: row.check,
      criterion: row.criterion,
      singular: row.singular,
      factorApplied: row.factorApplied,
      allowable: {
        property,
        from: { valueMPa: allowanceFrom.valueMpa, basis: allowanceFrom.basis },
        to: { valueMPa: allowanceTo.valueMpa, basis: allowanceTo.basis },
      },
      msFrom: row.ms,
      msTo,
      statusFrom: row.status,
      statusTo: msTo === null ? row.status : statusOf(msTo, computed.marginalBand ?? undefined),
      method: 'rescaled',
      unverified: reasons.length > 0,
      unverifiedReasons: reasons,
      reviewRequired: true,
    });
  }
  const mixed = rows.filter((row) => row.allowable.from.basis !== row.allowable.to.basis);
  const basisCondition: ConditionResult = {
    condition: 'same_allowable_basis',
    ok: mixed.length === 0,
    blocking: false,
    detail:
      mixed.length === 0
        ? 'both allowables are on the same basis'
        : `allowable basis ${[...new Set(mixed.map((row) => `${row.allowable.from.basis} -> ${row.allowable.to.basis}`))].join(', ')}: margins compare unlike values`,
  };
  const finite = rows.filter((row) => row.msTo !== null && !row.singular);
  const lowest = (pick: (row: RescaledMargin) => number | null): number | null =>
    finite.reduce<number | null>((best, row) => {
      const value = pick(row);
      return value === null || (best !== null && best <= value) ? best : value;
    }, null);
  return {
    kind: 'data',
    data: {
      method: 'rescaled',
      analysisId: analysis.id,
      resultsHash: computed.resultsHash,
      conditions: [...conditions, basisCondition],
      nuTolerance: tolerance,
      factors: computed.factors,
      marginalBand: computed.marginalBand,
      rows,
      minMs: { from: lowest((row) => row.msFrom), to: lowest((row) => row.msTo) },
      reviewRequired: true,
    },
    warnings:
      mixed.length === 0 ? [] : [issue('SEL_BASIS_MIXED', 'warning', basisCondition.detail, [...new Set(mixed.map((row) => row.part))])],
    unverified: rows.some((row) => row.unverified),
  };
}
