/** compute_fatigue / check_fatigue (PHY-07 FR-FAT-06..13): Miner life, margin and the readiness check of a history-only fatigue case. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { refuseFatigue } from './codes';
import { evaluateCase, isEvaluationFailure } from './evaluate';
import { item, REVIEW_NOTE, statusOfItems, type Item } from './items';
import { meanModelName, walkerGamma } from './meanInputs';
import { fatigueCaseOf } from './store';

/**
 * @affects nothing; read-only, data { caseId, rows[{ rowKey, rangesMPa, damagePerBlock, lifeBlocks, requiredLife, margin, status, ... }], minMargin, factors, items, reviewRequired: true }
 * @invariant D per block = sum(count_i / N_i) over rainflow cycles (Miner); life = damageLimit / D; margin = life / (scatter x required) - 1; every factor is named with its source and `defaulted`
 * @failure unknown case -> FAT_CASE_NOT_FOUND; no scatter factor -> FAT_SCATTER_FACTOR_UNSET; FE-driven case -> FAT_RESULTS_MISSING; curve / allowable / history problems -> their FAT_* code (unchanged doc)
 */
export const computeFatigue = defineCommand({
  name: 'compute_fatigue',
  annotations: { readOnly: true },
  description:
    'Compute the fatigue life of a case from create_fatigue_case: rainflow-count the mapped stress history (E1049), apply the mean-stress model and Marin modifiers, ' +
    'sum Miner damage per block, life = damageLimit / D blocks, margin = life / (scatter x required life) - 1. Needs a scatter factor (set_fatigue_factors; no default). ' +
    'Returns data { rows[{ rowKey, rangesMPa [[range, count]], damagePerBlock, lifeBlocks, requiredLife, margin, status PASS|MARGINAL|FAIL, extrapolated, curve, meanStress, unverified, reviewRequired }], ' +
    'minMargin, factors (each with source and defaulted), items[] }. A fatigue case with analysisId (FE hot spots) is refused with FAT_RESULTS_MISSING. Results are not approved: a qualified engineer must review.',
  params: z.object({ caseId: z.string().describe('Fatigue case id (affected[0] of create_fatigue_case).') }),
  run: (doc, params): CommandResult => {
    const fatigueCase = fatigueCaseOf(doc, params.caseId);
    if (fatigueCase === undefined)
      return refuseFatigue(doc, 'compute_fatigue', 'FAT_CASE_NOT_FOUND', `no fatigue case '${params.caseId}'`, [params.caseId], ['caseId']);
    const evaluation = evaluateCase(doc, fatigueCase, true);
    if (isEvaluationFailure(evaluation))
      return refuseFatigue(doc, 'compute_fatigue', evaluation.code, evaluation.message, evaluation.ids, ['caseId']);
    const { factors } = fatigueCase;
    const unverified = evaluation.unverifiedReasons.length > 0;
    const row = {
      rowKey: 'history',
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
    const factorsData = {
      scatter: { value: factors.scatter?.value ?? null, source: factors.scatter?.source ?? '', defaulted: false },
      damageLimit: { value: factors.damageLimit, source: 'Palmgren-Miner rule', defaulted: factors.damageLimit === 1 },
      compressiveMean: {
        value: factors.compressiveMean,
        source: 'llull conservative rule',
        defaulted: factors.compressiveMean === 'no_benefit',
      },
      modifiers: factors.modifiers,
    };
    const life = evaluation.lifeBlocks === null ? 'static failure' : `life ${evaluation.lifeBlocks.toPrecision(8)} blocks`;
    return report(
      doc,
      `compute_fatigue ${fatigueCase.id}: D per block ${evaluation.sum.damage.toPrecision(8)}, ${life}, margin ${evaluation.margin === null ? 'n/a' : evaluation.margin.toFixed(4)} with scatter factor ${factors.scatter?.value} (${factors.scatter?.source}); ${evaluation.status}. ${REVIEW_NOTE}`,
      {
        caseId: fatigueCase.id,
        method: fatigueCase.method,
        minMargin: evaluation.margin,
        factors: factorsData,
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
    'Readiness / review check of a fatigue case: scatter factor set, curve present and verified, history valid, mean-stress model sensible, life margin and marginal band. ' +
    'Returns data { status pass|warn|fail, items[{ code, severity, ids, message, remediation }], reviewRequired: true }. Run it last, after compute_fatigue.',
  params: z.object({ caseId: z.string().describe('Fatigue case id.') }),
  run: (doc, params): CommandResult => {
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
    const evaluation = evaluateCase(doc, fatigueCase, false);
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
