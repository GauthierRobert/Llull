/** Evaluates a history-only fatigue case: stress series -> rainflow -> per-cycle damage -> Miner life, margin and review items. */

import type { FatigueCase } from '@core/model/durability';
import type { CadDocument } from '@core/model/types';
import { convertValue, isUnitFailure } from '@lib/quantity';
import { blockCycles } from './historyData';
import { countCycles, totalsOf, type Cycle } from './rainflow';
import { findCurve, isCurveRefusal, strengthMpa } from './curves';
import { stressLifeDamage, strainLifeDamage, type DamageSum, type StrainLifeSetup, type StressLifeSetup } from './damage';
import { cyclicCurveOf, notchFactor } from './lifeMath';
import { meanInputsFor, meanModelName } from './meanInputs';
import { historyOf } from './store';
import { item, type Item } from './items';

export interface Failure {
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
}

export interface Evaluation {
  readonly cycles: readonly Cycle[];
  readonly totals: ReadonlyArray<readonly [number, number]>;
  readonly sum: DamageSum;
  readonly cyclesPerBlock: number;
  readonly lifeBlocks: number | null;
  readonly requiredBlocks: number;
  readonly margin: number | null;
  readonly status: 'PASS' | 'MARGINAL' | 'FAIL';
  readonly items: readonly Item[];
  readonly unverifiedReasons: readonly string[];
  readonly curveBasis: string;
  readonly curveKind: string;
}

/** Stress cycles (MPa) of the mapped histories of `fatigueCase`. */
function stressCycles(doc: CadDocument, fatigueCase: FatigueCase): Cycle[] | Failure {
  const histories = fatigueCase.mapping.map((entry) => ({ entry, history: historyOf(doc, entry.historyId) }));
  const series: number[][] = [];
  for (const { entry, history } of histories) {
    if (history === undefined) return { code: 'FAT_HISTORY_NOT_FOUND', message: `no history '${entry.historyId}'`, ids: [entry.historyId] };
    if (history.kind !== 'stress')
      return {
        code: 'FAT_HISTORY_INVALID',
        message: `history '${history.id}' is ${history.kind}; a history-only case needs stress histories`,
        ids: [history.id],
      };
    const factor = convertValue(1, history.unit, 'MPa');
    if (isUnitFailure(factor))
      return { code: 'FAT_HISTORY_INVALID', message: `history unit '${history.unit}' is not a stress`, ids: [history.id] };
    const toMpa = factor.value * entry.scale;
    if (history.data.form === 'blocks') {
      if (histories.length > 1)
        return { code: 'FAT_HISTORY_MISMATCH', message: 'a blocks history cannot be superposed with others', ids: [history.id] };
      return blockCycles(history, toMpa);
    }
    series.push(history.data.values.map((value) => value * toMpa));
  }
  const length = series[0]?.length ?? 0;
  if (series.some((values) => values.length !== length))
    return {
      code: 'FAT_HISTORY_MISMATCH',
      message: 'mapped histories have different lengths',
      ids: fatigueCase.mapping.map((m) => m.historyId),
    };
  const summed = Array.from({ length }, (_, index) => series.reduce((sum, values) => sum + (values[index] ?? 0), 0));
  const { method, residue, gate } = fatigueCase.counting;
  const cycles = countCycles(summed, method, residue, gate ?? 0);
  return cycles.length === 0
    ? { code: 'FAT_HISTORY_EMPTY', message: 'no cycle was counted', ids: fatigueCase.mapping.map((m) => m.historyId) }
    : cycles;
}

const isFailure = (value: unknown): value is Failure =>
  typeof value === 'object' && value !== null && 'code' in value && !Array.isArray(value);

/** Curve, mean-stress inputs and notch of a case, ready for `damageOf` (shared by the history and the FE paths). */
export type DamageSetup =
  | {
      readonly method: 'stress_life';
      readonly setup: StressLifeSetup;
      readonly unverifiedReasons: readonly string[];
      readonly curveBasis: string;
      readonly curveKind: string;
    }
  | {
      readonly method: 'strain_life';
      readonly setup: StrainLifeSetup;
      readonly unverifiedReasons: readonly string[];
      readonly curveBasis: string;
      readonly curveKind: string;
    };

/**
 * The damage set-up of `fatigueCase`.
 * @failure missing / unsupported curve, missing allowable, unsupported mean-stress model -> a Failure
 */
export function damageSetupOf(doc: CadDocument, fatigueCase: FatigueCase): DamageSetup | Failure {
  const { factors, material } = fatigueCase;
  const kf = fatigueCase.notch === undefined ? null : notchFactor(fatigueCase.notch.kt, fatigueCase.notch.q);
  if (fatigueCase.method === 'stress_life') {
    const curve = findCurve(doc, material.recordId, material.modelId, ['sn_basquin', 'sn_power_law', 'sn_table']);
    if (isCurveRefusal(curve)) return { ...curve, ids: [material.recordId] };
    if (curve.law.kind === 'sn_table' && curve.law.measure !== 'amplitude')
      return { code: 'FAT_CURVE_UNSUPPORTED', message: 'sn_table with measure max is not supported', ids: [material.recordId] };
    const mean = meanInputsFor(doc, material.recordId, fatigueCase.meanStress, factors.compressiveMean, curve.law);
    if ('missing' in mean) return { code: 'FAT_ALLOWABLE_MISSING', message: mean.missing, ids: [material.recordId] };
    const setup: StressLifeSetup = {
      curve: curve.law,
      modifierProduct: factors.modifiers.reduce((product, entry) => product * entry.value, 1),
      mean,
      ftu: strengthMpa(doc, material.recordId, 'Ftu'),
      stressScale: fatigueCase.notch !== undefined && !fatigueCase.notch.feIncludesKt && kf !== null ? kf : 1,
    };
    return {
      method: 'stress_life',
      setup,
      unverifiedReasons: curve.unverifiedReasons,
      curveBasis: curve.entry.basis,
      curveKind: curve.law.kind,
    };
  }
  const curve = findCurve(doc, material.recordId, material.modelId, ['en_coffin_manson']);
  if (isCurveRefusal(curve)) return { ...curve, ids: [material.recordId] };
  const cyclicFound =
    material.cyclicModelId === undefined ? null : findCurve(doc, material.recordId, material.cyclicModelId, ['cyclic_ramberg_osgood']);
  const cyclic = cyclicFound === null || isCurveRefusal(cyclicFound) ? null : cyclicCurveOf(cyclicFound.law);
  if (cyclic === null)
    return { code: 'FAT_CURVE_MISSING', message: 'strain_life needs a valid cyclic_ramberg_osgood model', ids: [material.recordId] };
  const meanName = meanModelName(fatigueCase.meanStress);
  if (meanName !== 'none' && meanName !== 'morrow' && meanName !== 'swt')
    return { code: 'FAT_MEAN_MODEL_UNSUPPORTED', message: `strain_life does not support meanStress ${meanName}`, ids: [fatigueCase.id] };
  return {
    method: 'strain_life',
    setup: { curve: curve.law, cyclic, mean: meanName, kf: fatigueCase.notch !== undefined && !fatigueCase.notch.feIncludesKt ? kf : null },
    unverifiedReasons: [
      ...curve.unverifiedReasons,
      ...(cyclicFound !== null && !isCurveRefusal(cyclicFound) ? cyclicFound.unverifiedReasons : []),
    ],
    curveBasis: curve.entry.basis,
    curveKind: curve.law.kind,
  };
}

/** Miner sum of `cycles` under a damage set-up. */
export const damageOf = (cycles: readonly Cycle[], damage: DamageSetup): DamageSum =>
  damage.method === 'stress_life' ? stressLifeDamage(cycles, damage.setup) : strainLifeDamage(cycles, damage.setup);

/**
 * Evaluation of a history-only `fatigueCase`.
 * @failure FE-driven case -> FAT_RESULTS_MISSING (the FE path is `evaluateFeCase`); missing curve / allowable / scatter factor (when `needScatter`) -> a Failure
 */
export function evaluateCase(doc: CadDocument, fatigueCase: FatigueCase, needScatter: boolean): Evaluation | Failure {
  if (fatigueCase.analysisId !== undefined)
    return {
      code: 'FAT_RESULTS_MISSING',
      message: `FE case on analysis '${fatigueCase.analysisId}': no current fatigue field (run fatigue_field caseId=${fatigueCase.id})`,
      ids: [fatigueCase.analysisId],
    };
  if (needScatter && fatigueCase.factors.scatter === undefined)
    return { code: 'FAT_SCATTER_FACTOR_UNSET', message: 'no scatter factor on the case', ids: [fatigueCase.id] };
  const cycles = stressCycles(doc, fatigueCase);
  if (isFailure(cycles)) return cycles;
  const damage = damageSetupOf(doc, fatigueCase);
  if (isFailure(damage)) return damage;
  return evaluateCycles(fatigueCase, cycles, damage);
}

/** Damage, life, margin, status and review items of counted `cycles` (one history or one FE hot spot). */
export function evaluateCycles(fatigueCase: FatigueCase, cycles: readonly Cycle[], damage: DamageSetup): Evaluation {
  const { factors, material } = fatigueCase;
  const items: Item[] = [];
  const sum = damageOf(cycles, damage);
  const { unverifiedReasons, curveBasis, curveKind } = damage;
  if (
    damage.method === 'stress_life' &&
    meanModelName(fatigueCase.meanStress) === 'none' &&
    cycles.some((cycle) => Math.abs(cycle.mean) > 1e-9)
  )
    items.push(
      item(
        'FAT_MEAN_MODEL_REQUIRED',
        'warning',
        'cycles have non-zero mean stress but meanStress is none: the curve amplitude is used unchanged',
        'choose a mean-stress model (goodman, gerber, soderberg, morrow, swt, walker)',
        [fatigueCase.id],
      ),
    );
  if (unverifiedReasons.length > 0)
    items.push(
      item('FAT_CURVE_UNVERIFIED', 'warning', `curve data unverified: ${unverifiedReasons.join('; ')}`, 'use a verified, sourced curve', [
        material.recordId,
      ]),
    );
  if (sum.extrapolated)
    items.push(
      item(
        'FAT_CURVE_EXTRAPOLATED',
        'warning',
        'cycles fall outside the tested life range of the curve',
        'use a curve covering the range',
        [material.recordId],
      ),
    );
  if (sum.flags.has('swt_nonpositive'))
    items.push(item('FAT_SWT_NONPOSITIVE', 'info', 'some cycles have max stress <= 0 under SWT / Walker: no damage', ''));
  const staticFailure = sum.flags.has('static_failure');
  if (staticFailure)
    items.push(
      item('FAT_STATIC_FAILURE', 'fail', 'a cycle reaches Ftu or the mean-stress strength', 'static redesign (margins) first', [
        fatigueCase.id,
      ]),
    );
  const cyclesPerBlock = sum.cyclesCounted;
  const { requiredLife } = fatigueCase;
  const requiredBlocks =
    requiredLife.unit === 'blocks'
      ? requiredLife.value
      : requiredLife.unit === 'cycles'
        ? requiredLife.value / cyclesPerBlock
        : requiredLife.value * (requiredLife.blocksPerUnit ?? 1);
  const lifeBlocks = staticFailure ? null : sum.damage > 0 ? factors.damageLimit / sum.damage : Number.POSITIVE_INFINITY;
  const scatter = factors.scatter?.value ?? 1;
  const margin = lifeBlocks === null ? null : lifeBlocks / (scatter * requiredBlocks) - 1;
  let status: Evaluation['status'] = 'PASS';
  if (margin === null || margin < 0) {
    status = 'FAIL';
    if (!staticFailure)
      items.push(
        item('FAT_LIFE_SHORT', 'fail', `margin ${(margin ?? 0).toFixed(3)} < 0`, 'redesign; reviewer disposition only', [fatigueCase.id]),
      );
  } else if (factors.marginalBand === undefined) {
    items.push(item('FAT_MARGINAL_BAND_UNSET', 'warning', 'no marginal band set', 'company rule or owner choice', [fatigueCase.id]));
  } else if (margin < factors.marginalBand) {
    status = 'MARGINAL';
    items.push(
      item('FAT_LIFE_MARGINAL', 'warning', `0 <= margin ${margin.toFixed(3)} < band ${factors.marginalBand}`, 'reviewer disposition', [
        fatigueCase.id,
      ]),
    );
  }
  return {
    cycles,
    totals: totalsOf(cycles),
    sum,
    cyclesPerBlock,
    lifeBlocks,
    requiredBlocks,
    margin,
    status,
    items,
    unverifiedReasons,
    curveBasis,
    curveKind,
  };
}

export const isEvaluationFailure = isFailure;
