/** compute_fatigue / check_fatigue (PHY-07 FR-FAT-06..13): Miner life, margin and the readiness check of a fatigue case (history-only or FE hot spots). */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { FatigueCase } from '@core/model/durability';
import type { CadDocument } from '@core/model/types';
import { refuseFatigue } from './codes';
import { evaluateCase, isEvaluationFailure, type Evaluation } from './evaluate';
import { evaluateFeCase } from './feHotspots';
import { item, REVIEW_NOTE, statusOfItems, type Item } from './items';
import { meanModelName, walkerGamma } from './meanInputs';
import { fatigueCaseOf } from './store';

/** The row fields every result row shares (history row or FE hot spot). */
function rowOf(fatigueCase: FatigueCase, evaluation: Evaluation): Record<string, unknown> {
  const unverified = evaluation.unverifiedReasons.length > 0;
  return {
    rangesMPa: evaluation.totals,
    cyclesPerBlock: evaluation.cyclesPerBlock,
    damagePerBlock: evaluation.sum.damage,
    lifeBlocks: evaluation.lifeBlocks,
    requiredLife: fatigueCase.requiredLife,
    requiredBlocks: evaluation.requiredBlocks,
    margin: evaluation.margin,
    status: evaluation.status,
    extrapolated: evaluation.sum.extrapolated,
    curve: {
      recordId: fatigueCase.material.recordId,
      modelId: fatigueCase.material.modelId,
      kind: evaluation.curveKind,
      basis: evaluation.curveBasis,
    },
    meanStress: meanModelName(fatigueCase.meanStress),
    ...(walkerGamma(fatigueCase.meanStress) !== undefined ? { walkerGamma: walkerGamma(fatigueCase.meanStress) } : {}),
    provenance: { method: `rainflow E1049 (${fatigueCase.counting.method}) + ${evaluation.curveKind} + Miner`, standard: ['ASTM E1049'] },
    unverified,
    unverifiedReasons: evaluation.unverifiedReasons,
    reviewRequired: true,
    reviewReason: 'fatigue life supports a certification decision',
  };
}

function factorsOf(fatigueCase: FatigueCase): Record<string, unknown> {
  const { factors } = fatigueCase;
  return {
    scatter: { value: factors.scatter?.value ?? null, source: factors.scatter?.source ?? '', defaulted: false },
    damageLimit: { value: factors.damageLimit, source: 'Palmgren-Miner rule', defaulted: factors.damageLimit === 1 },
    compressiveMean: {
      value: factors.compressiveMean,
      source: 'llull conservative rule',
      defaulted: factors.compressiveMean === 'no_benefit',
    },
    modifiers: factors.modifiers,
  };
}

const marginText = (margin: number | null): string => (margin === null ? 'n/a' : margin.toFixed(4));

/** compute_fatigue of an FE-driven case: hot spots ranked by damage over every node of the current FatigueField. */
function computeFe(doc: CadDocument, fatigueCase: FatigueCase, artifacts: Parameters<typeof evaluateFeCase>[2]): CommandResult {
  const evaluation = evaluateFeCase(doc, fatigueCase, artifacts, true);
  if (isEvaluationFailure(evaluation))
    return refuseFatigue(doc, 'compute_fatigue', evaluation.code, evaluation.message, evaluation.ids, ['caseId']);
  const rows = evaluation.hotSpots.map((spot) => ({
    rowKey: spot.rowKey,
    node: spot.node,
    part: spot.entityId,
    at: spot.at,
    measure: fatigueCase.measure,
    nativeDamagePerBlock: spot.nativeDamage,
    selection: 'all_nodes',
    ...rowOf(fatigueCase, spot.evaluation),
  }));
  const worst = evaluation.hotSpots[0];
  const life =
    worst === undefined
      ? ''
      : worst.evaluation.lifeBlocks === null
        ? ', static failure'
        : `, min life ${worst.evaluation.lifeBlocks.toPrecision(8)} blocks`;
  return report(
    doc,
    `compute_fatigue ${fatigueCase.id}: ${rows.length} hot spot(s) ranked by damage over all ${evaluation.nodesEvaluated} nodes (fatigue field ${evaluation.fatigueInputHash.slice(0, 12)})${life}, min margin ${marginText(evaluation.minMargin)} with scatter factor ${fatigueCase.factors.scatter?.value} (${fatigueCase.factors.scatter?.source}); ${evaluation.status}. ${REVIEW_NOTE}`,
    {
      caseId: fatigueCase.id,
      method: fatigueCase.method,
      analysisId: fatigueCase.analysisId,
      resultsHash: evaluation.resultsHash,
      fatigueInputHash: evaluation.fatigueInputHash,
      selection: 'all_nodes',
      nodesEvaluated: evaluation.nodesEvaluated,
      minMargin: evaluation.minMargin,
      status: evaluation.status,
      factors: factorsOf(fatigueCase),
      rows,
      items: evaluation.items,
      reviewRequired: true,
    },
  );
}

/**
 * @affects nothing; read-only, data { caseId, rows[{ rowKey, rangesMPa, damagePerBlock, lifeBlocks, requiredLife, margin, status, ... }], minMargin, factors, items, reviewRequired: true }
 * @invariant D per block = sum(count_i / N_i) over rainflow cycles (Miner); life = damageLimit / D; margin = life / (scatter x required) - 1; every factor is named with its source and `defaulted`;
 *   FE case: rows = the `locations.count` nodes of largest damage in the current FatigueField (all nodes), each recomputed by the TypeScript reference
 * @failure unknown case -> FAT_CASE_NOT_FOUND; no scatter factor -> FAT_SCATTER_FACTOR_UNSET; FE case without a current fatigue field -> FAT_RESULTS_MISSING;
 *   stale analysis -> FAT_RESULTS_STALE; curve / allowable / history problems -> their FAT_* code (unchanged doc)
 */
export const computeFatigue = defineCommand({
  name: 'compute_fatigue',
  annotations: { readOnly: true },
  description:
    'Compute the fatigue life of a case from create_fatigue_case: rainflow-count the mapped stress history (E1049), apply the mean-stress model and Marin modifiers, ' +
    'sum Miner damage per block, life = damageLimit / D blocks, margin = life / (scatter x required life) - 1. Needs a scatter factor (set_fatigue_factors; no default). ' +
    'Returns data { rows[{ rowKey, rangesMPa [[range, count]], damagePerBlock, lifeBlocks, requiredLife, margin, status PASS|MARGINAL|FAIL, extrapolated, curve, meanStress, unverified, reviewRequired }], ' +
    'minMargin, factors (each with source and defaulted), items[] }. A fatigue case with analysisId (FE) reads the fatigue field of every node written by the fatigue_field ' +
    'transport (llull fatigue_field caseId=...; native llull-compute): rows are the locations.count nodes of largest damage (h1, h2, ... with node, part, at, selection all_nodes), ' +
    'each recomputed here; without a current field it is refused with FAT_RESULTS_MISSING. Results are not approved: a qualified engineer must review.',
  params: z.object({ caseId: z.string().describe('Fatigue case id (affected[0] of create_fatigue_case).') }),
  run: (doc, params, ctx): CommandResult => {
    const fatigueCase = fatigueCaseOf(doc, params.caseId);
    if (fatigueCase === undefined)
      return refuseFatigue(doc, 'compute_fatigue', 'FAT_CASE_NOT_FOUND', `no fatigue case '${params.caseId}'`, [params.caseId], ['caseId']);
    if (fatigueCase.analysisId !== undefined) return computeFe(doc, fatigueCase, ctx?.feaArtifacts);
    const evaluation = evaluateCase(doc, fatigueCase, true);
    if (isEvaluationFailure(evaluation))
      return refuseFatigue(doc, 'compute_fatigue', evaluation.code, evaluation.message, evaluation.ids, ['caseId']);
    const { factors } = fatigueCase;
    const row = { rowKey: 'history', ...rowOf(fatigueCase, evaluation) };
    const life = evaluation.lifeBlocks === null ? 'static failure' : `life ${evaluation.lifeBlocks.toPrecision(8)} blocks`;
    return report(
      doc,
      `compute_fatigue ${fatigueCase.id}: D per block ${evaluation.sum.damage.toPrecision(8)}, ${life}, margin ${marginText(evaluation.margin)} with scatter factor ${factors.scatter?.value} (${factors.scatter?.source}); ${evaluation.status}. ${REVIEW_NOTE}`,
      {
        caseId: fatigueCase.id,
        method: fatigueCase.method,
        minMargin: evaluation.margin,
        factors: factorsOf(fatigueCase),
        rows: [row],
        items: evaluation.items,
        reviewRequired: true,
      },
    );
  },
});

/**
 * @affects nothing; read-only, data { caseId, status pass|warn|fail, items[{ code, severity, ids, message, remediation }], reviewRequired: true }
 * @failure unknown case -> FAT_CASE_NOT_FOUND (unchanged doc); problems are reported as items, not thrown
 */
export const checkFatigue = defineCommand({
  name: 'check_fatigue',
  annotations: { readOnly: true },
  description:
    'Readiness / review check of a fatigue case: scatter factor set, curve present and verified, history valid, mean-stress model sensible, life margin and marginal band ' +
    '(FE case: the current fatigue field and its hot spots). Returns data { status pass|warn|fail, items[{ code, severity, ids, message, remediation }], reviewRequired: true }. ' +
    'Run it last, after compute_fatigue.',
  params: z.object({ caseId: z.string().describe('Fatigue case id.') }),
  run: (doc, params, ctx): CommandResult => {
    const fatigueCase = fatigueCaseOf(doc, params.caseId);
    if (fatigueCase === undefined)
      return refuseFatigue(doc, 'check_fatigue', 'FAT_CASE_NOT_FOUND', `no fatigue case '${params.caseId}'`, [params.caseId], ['caseId']);
    const items: Item[] = [];
    if (fatigueCase.factors.scatter === undefined)
      items.push(
        item('FAT_SCATTER_FACTOR_UNSET', 'error', 'no scatter factor', 'set_fatigue_factors scatter={value, source} (ask the owner)', [
          fatigueCase.id,
        ]),
      );
    const evaluation =
      fatigueCase.analysisId === undefined
        ? evaluateCase(doc, fatigueCase, false)
        : evaluateFeCase(doc, fatigueCase, ctx?.feaArtifacts, false);
    if (isEvaluationFailure(evaluation))
      items.push(item(evaluation.code, 'error', evaluation.message, 'see the command description of compute_fatigue', evaluation.ids));
    else items.push(...evaluation.items);
    const status = statusOfItems(items);
    return report(
      doc,
      `check_fatigue ${fatigueCase.id}: ${status}, ${items.length} item(s) [${items.map((entry) => entry.code).join(', ')}]. ${REVIEW_NOTE}`,
      { caseId: fatigueCase.id, status, items, reviewRequired: true },
    );
  },
});
