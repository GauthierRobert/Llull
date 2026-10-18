/** Resolves a crack-growth case into SI numbers: solved geometry, rate model, toughness, yield strength and the block of stress cycles. */

import type { CrackGrowthCase, Crack } from '@core/model/durability';
import type { MaterialModel } from '@core/model/materialModel';
import type { CadDocument } from '@core/model/types';
import { modelUnverifiedReasonsOf } from '@core/model/materialLaws/references';
import { convertValue, isUnitFailure } from '@lib/quantity';
import { blockCycles } from '../fatigue/historyData';
import { countCycles, reversalsOf, type Cycle } from '../fatigue/rainflow';
import { strengthMpa } from '../fatigue/curves';
import { crackOf, historyOf } from '../fatigue/store';
import { growthRate, rateModelOf, type RateModel } from './growthLaws';
import { solvedGeometry, type SolvedGeometry } from './kSolutions';

export interface Failure {
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
}

export const isFailure = (value: unknown): value is Failure =>
  typeof value === 'object' && value !== null && 'code' in value && 'message' in value && !Array.isArray(value);

/** One cycle of the block: peak stress, effective (tensile part of the) minimum stress [MPa], repetitions per block. */
interface BlockCycle {
  readonly sMax: number;
  readonly sMin: number;
  readonly count: number;
}

export interface GrowthSetup {
  readonly crack: Crack;
  readonly geometry: SolvedGeometry;
  readonly model: RateModel;
  readonly modelKind: string;
  /** Plane-strain / thickness-selected toughness [MPa sqrt(m)]. */
  readonly kc: number;
  readonly fty: number | null;
  readonly block: readonly BlockCycle[];
  readonly cyclesPerBlock: number;
  /** Largest cycle peak stress of the block [MPa]. */
  readonly sigmaPeak: number;
  readonly a0: number;
  readonly aDetectable: number | null;
  readonly aTarget: number | null;
  readonly residualStress: number | null;
  readonly maxDaOverA: number;
  readonly unverifiedReasons: readonly string[];
}

const metres = (quantity: { readonly value: number; readonly unit: string }): number | null => {
  const converted = convertValue(quantity.value, quantity.unit, 'm');
  return isUnitFailure(converted) ? null : converted.value;
};

function lookup(doc: CadDocument, recordId: string, modelId: string): { entry: MaterialModel; reasons: string[] } | null {
  const material = Object.hasOwn(doc.materials, recordId) ? doc.materials[recordId] : undefined;
  const entry = material?.materialModels?.find((candidate) => candidate.id === modelId);
  if (material === undefined || entry === undefined) return null;
  const record = { name: recordId, ...(material.propertyModels !== undefined ? { propertyModels: material.propertyModels } : {}) };
  return { entry, reasons: modelUnverifiedReasonsOf(entry, record) };
}

/** Toughness [MPa sqrt(m)] from a fracture_toughness law at thickness `t` [m]: KIc for plane strain, else the Kc entry nearest in thickness. */
function toughnessOf(entry: MaterialModel, t: number): number | string {
  const law = entry.model;
  if (law.kind !== 'fracture_toughness') return `model '${entry.id}' is a ${law.kind}, not a fracture_toughness`;
  const k = (quantity: { value: number; unit: string }): number | null => {
    const converted = convertValue(quantity.value, quantity.unit, 'MPa*m^0.5');
    return isUnitFailure(converted) ? null : converted.value;
  };
  if (law.state === 'plane_strain' || law.Kc === undefined || law.Kc.length === 0) {
    const kic = law.KIc === undefined ? null : k(law.KIc);
    return kic === null ? 'the toughness model has no usable KIc / Kc in a stress-intensity unit' : kic;
  }
  let best: { distance: number; value: number } | null = null;
  for (const row of law.Kc) {
    const thickness = metres(row.thickness);
    const value = k(row.value);
    if (thickness === null || value === null) return 'a Kc row has a unit that is not a thickness / stress-intensity unit';
    const distance = Math.abs(thickness - t);
    if (best === null || distance < best.distance) best = { distance, value };
  }
  return best === null ? 'no Kc entry' : best.value;
}

/** Cycles of the block from the case histories (MPa), as BlockCycle[] with the tensile part of the minimum. */
function blockOf(doc: CadDocument, growthCase: CrackGrowthCase): BlockCycle[] | Failure {
  const series: number[][] = [];
  let direct: Cycle[] | null = null;
  let repeating = false;
  for (const entry of growthCase.histories) {
    const history = historyOf(doc, entry.historyId);
    if (history === undefined) return { code: 'FRC_CASE_INVALID', message: `no history '${entry.historyId}'`, ids: [entry.historyId] };
    const factor = history.kind === 'stress' ? convertValue(1, history.unit, 'MPa') : null;
    if (factor === null || isUnitFailure(factor))
      return { code: 'FRC_CASE_INVALID', message: `history '${history.id}' must be a stress history`, ids: [history.id] };
    repeating ||= history.repeats === 'repeating';
    if (history.data.form === 'blocks') {
      if (growthCase.histories.length > 1)
        return { code: 'FRC_CASE_INVALID', message: 'a blocks history cannot be superposed', ids: [history.id] };
      direct = blockCycles(history, factor.value * entry.scale);
    } else series.push(history.data.values.map((value) => value * factor.value * entry.scale));
  }
  let cycles: Cycle[];
  if (direct !== null) cycles = direct;
  else {
    const length = series[0]?.length ?? 0;
    if (series.some((values) => values.length !== length))
      return { code: 'FRC_CASE_INVALID', message: 'histories have different lengths', ids: growthCase.histories.map((h) => h.historyId) };
    const summed = Array.from({ length }, (_, index) => series.reduce((sum, values) => sum + (values[index] ?? 0), 0));
    if (growthCase.sequence === 'rainflow_blocks')
      cycles = countCycles(summed, repeating ? 'rainflow_repeating' : 'rainflow_3pt', 'half_cycles');
    else {
      const reversals = reversalsOf(summed);
      cycles = reversals.slice(1).map((to, index) => {
        const from = reversals[index] ?? 0;
        return { from, to, range: Math.abs(to - from), mean: (from + to) / 2, count: 0.5 };
      });
    }
  }
  const block = cycles
    .map((cycle) => ({ sMax: Math.max(cycle.from, cycle.to), sMin: Math.max(Math.min(cycle.from, cycle.to), 0), count: cycle.count }))
    .filter((cycle) => cycle.sMax > cycle.sMin);
  return block.length === 0
    ? { code: 'FRC_NO_STRESS', message: 'the histories contain no tensile cycle', ids: growthCase.histories.map((h) => h.historyId) }
    : block;
}

/**
 * Everything a growth integration needs for `growthCase`.
 * @failure missing crack / model / history, unsupported units, bad sizes -> a Failure with its FRC_* code
 */
export function resolveGrowth(doc: CadDocument, growthCase: CrackGrowthCase): GrowthSetup | Failure {
  const crack = crackOf(doc, growthCase.crackId);
  if (crack === undefined) return { code: 'FRC_CRACK_NOT_FOUND', message: `no crack '${growthCase.crackId}'`, ids: [growthCase.crackId] };
  const geometry = solvedGeometry(crack.geometry);
  if (typeof geometry === 'string') return { code: 'FRC_CRACK_INVALID', message: geometry, ids: [crack.id] };
  if (geometry.kind === 'surface_semi_elliptical')
    return {
      code: 'FRC_K_SOLUTION_UNCONFIRMED',
      message: 'growth integration supports through cracks (centre, edge); the Newman-Raju surface solution is unconfirmed',
      ids: [crack.id],
    };
  const { recordId, growthModelId, toughnessModelId } = growthCase.material;
  const growth = lookup(doc, recordId, growthModelId);
  const toughness = lookup(doc, recordId, toughnessModelId);
  if (growth === null)
    return { code: 'FRC_MODEL_MISSING', message: `no growth model '${growthModelId}' on '${recordId}'`, ids: [recordId] };
  if (toughness === null)
    return { code: 'FRC_MODEL_MISSING', message: `no toughness model '${toughnessModelId}' on '${recordId}'`, ids: [recordId] };
  const law = growth.entry.model;
  if (!law.kind.startsWith('da_dn_'))
    return { code: 'FRC_MODEL_MISSING', message: `model '${growthModelId}' is a ${law.kind}, not a growth law`, ids: [recordId] };
  const model = rateModelOf(law as Parameters<typeof rateModelOf>[0]);
  if (typeof model === 'string') return { code: 'FRC_UNITS_MISMATCH', message: model, ids: [recordId] };
  const kc = toughnessOf(toughness.entry, geometry.t);
  if (typeof kc === 'string') return { code: 'FRC_UNITS_MISMATCH', message: kc, ids: [recordId] };
  const block = blockOf(doc, growthCase);
  if (isFailure(block)) return block;
  const a0 = metres(growthCase.growth.aInitial);
  if (a0 === null || !(a0 > 0)) return { code: 'FRC_CASE_INVALID', message: 'growth.aInitial must be a length > 0', ids: [growthCase.id] };
  const optional = (quantity: { value: number; unit: string } | undefined): number | null | 'bad' => {
    if (quantity === undefined) return null;
    const value = metres(quantity);
    return value === null || !(value > 0) ? 'bad' : value;
  };
  const aDetectable = optional(growthCase.growth.aDetectable);
  const aTarget = optional(growthCase.growth.aTarget);
  const residual =
    growthCase.residualStrengthStress === undefined
      ? null
      : convertValue(growthCase.residualStrengthStress.value, growthCase.residualStrengthStress.unit, 'MPa');
  if (aDetectable === 'bad' || aTarget === 'bad' || (residual !== null && (isUnitFailure(residual) || !(residual.value > 0))))
    return {
      code: 'FRC_CASE_INVALID',
      message: 'aDetectable / aTarget must be lengths > 0 and residualStrengthStress a stress > 0',
      ids: [growthCase.id],
    };
  const sigmaPeak = Math.max(...block.map((cycle) => cycle.sMax));
  return {
    crack,
    geometry,
    model,
    modelKind: law.kind,
    kc,
    fty: strengthMpa(doc, recordId, 'Fty'),
    block,
    cyclesPerBlock: block.reduce((sum, cycle) => sum + cycle.count, 0),
    sigmaPeak,
    a0,
    aDetectable,
    aTarget,
    residualStress: residual === null || isUnitFailure(residual) ? null : residual.value,
    maxDaOverA: growthCase.integration.maxDaOverA,
    unverifiedReasons: [...growth.reasons.map((r) => `growth model: ${r}`), ...toughness.reasons.map((r) => `toughness: ${r}`)],
  };
}

/** da per block [m] at crack size `a` [m], with whether any cycle used an extrapolated rate. */
export function growthPerBlock(
  setup: GrowthSetup,
  a: number,
  kOf: (a: number, sigma: number) => number,
): { readonly perBlock: number; readonly extrapolated: boolean } {
  let perBlock = 0;
  let extrapolated = false;
  for (const cycle of setup.block) {
    const dK = kOf(a, cycle.sMax - cycle.sMin);
    const found = growthRate(setup.model, dK, cycle.sMin / cycle.sMax);
    perBlock += cycle.count * found.rate;
    extrapolated ||= found.extrapolated;
  }
  return { perBlock, extrapolated };
}
