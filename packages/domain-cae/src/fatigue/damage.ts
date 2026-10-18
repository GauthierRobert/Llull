/** Per-cycle fatigue damage: stress-life with mean-stress correction and Marin modifiers, strain-life with Neuber and SWT / Morrow (Miner sum). */

import type { Cycle } from './rainflow';
import {
  cyclicStrain,
  equivalentAmplitude,
  masingStrainRange,
  neuberStress,
  stressLife,
  strainLifeReversals,
  swtLifeReversals,
  type CurveLife,
  type CyclicCurve,
  type MeanStressInputs,
} from './lifeMath';
import type { CurveOf } from './curves';

type CycleFlag = 'static_failure' | 'swt_nonpositive' | 'no_life';

export interface DamageSum {
  readonly damage: number;
  readonly cyclesCounted: number;
  readonly extrapolated: boolean;
  readonly flags: ReadonlySet<CycleFlag>;
  /** Largest equivalent amplitude seen (MPa), for reporting. */
  readonly maxEquivalentAmplitude: number;
}

export interface StressLifeSetup {
  readonly curve: CurveOf<'sn_basquin'> | CurveOf<'sn_power_law'> | CurveOf<'sn_table'>;
  readonly modifierProduct: number;
  readonly mean: MeanStressInputs;
  readonly ftu: number | null;
  /** Elastic notch factor Kf applied to the nominal stresses (1 = none). */
  readonly stressScale: number;
}

/** Miner sum of `cycles` (values in MPa, count per cycle record) on a stress-life curve. */
export function stressLifeDamage(cycles: readonly Cycle[], setup: StressLifeSetup): DamageSum {
  let damage = 0;
  let cyclesCounted = 0;
  let extrapolated = false;
  let maxEquivalentAmplitude = 0;
  const flags = new Set<CycleFlag>();
  for (const cycle of cycles) {
    cyclesCounted += cycle.count;
    const sa = (cycle.range / 2) * setup.stressScale;
    const sm = cycle.mean * setup.stressScale;
    const equivalent = equivalentAmplitude(sa, sm, setup.mean);
    if (equivalent === null) {
      flags.add('no_life');
      continue;
    }
    if ((setup.ftu !== null && sm + sa >= setup.ftu) || !Number.isFinite(equivalent)) {
      flags.add('static_failure');
      continue;
    }
    if (equivalent === 0 && (setup.mean.model === 'swt' || setup.mean.model === 'walker')) flags.add('swt_nonpositive');
    maxEquivalentAmplitude = Math.max(maxEquivalentAmplitude, equivalent);
    const life: CurveLife | null = stressLife(setup.curve, equivalent / setup.modifierProduct);
    if (life === null) {
      flags.add('no_life');
      continue;
    }
    extrapolated ||= life.extrapolated;
    if (Number.isFinite(life.cycles)) damage += cycle.count / life.cycles;
  }
  return { damage, cyclesCounted, extrapolated, flags, maxEquivalentAmplitude };
}

export interface LocalResponse {
  readonly sigmaA: number;
  readonly epsA: number;
  readonly sigmaMax: number;
  readonly sigmaMean: number;
}

/** Local stress / strain of a cycle (nominal amplitude `sa`, mean `sm`, MPa) on the cyclic curve; Neuber's rule when `kf` is given. */
export function localResponse(curve: CyclicCurve, sa: number, sm: number, kf: number | null): LocalResponse {
  if (kf === null) return { sigmaA: sa, epsA: cyclicStrain(curve, sa), sigmaMax: sm + sa, sigmaMean: sm };
  const sigmaA = neuberStress(curve, kf * sa);
  const peak = sm + sa;
  const sigmaMax = Math.sign(peak) * neuberStress(curve, kf * Math.abs(peak));
  return { sigmaA, epsA: masingStrainRange(curve, 2 * sigmaA) / 2, sigmaMax, sigmaMean: sigmaMax - sigmaA };
}

/** Stress on the cyclic curve that gives total strain `eps` (bisection). */
export function stressAtStrain(curve: CyclicCurve, eps: number): number {
  let [low, high] = [0, 1];
  while (cyclicStrain(curve, high) < eps && high < 1e9) high *= 2;
  for (let i = 0; i < 200; i += 1) {
    const mid = (low + high) / 2;
    if (cyclicStrain(curve, mid) < eps) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

export type StrainMeanModel = 'none' | 'morrow' | 'swt';

/** Reversals to failure at a local response: CMB, Morrow (mean stress term) or SWT. null = the solver found nothing; Infinity = no damage (SWT with smax <= 0). */
export function strainLifeAt(model: CurveOf<'en_coffin_manson'>, response: LocalResponse, mean: StrainMeanModel): number | null {
  if (mean === 'swt') return response.sigmaMax <= 0 ? Number.POSITIVE_INFINITY : swtLifeReversals(model, response.sigmaMax, response.epsA);
  return strainLifeReversals(model, response.epsA, mean === 'morrow' ? response.sigmaMean : 0);
}

export interface StrainLifeSetup {
  readonly curve: CurveOf<'en_coffin_manson'>;
  readonly cyclic: CyclicCurve;
  readonly mean: StrainMeanModel;
  readonly kf: number | null;
}

/** Miner sum of nominal-stress `cycles` (MPa) on a strain-life curve. */
export function strainLifeDamage(cycles: readonly Cycle[], setup: StrainLifeSetup): DamageSum {
  let damage = 0;
  let cyclesCounted = 0;
  let maxEquivalentAmplitude = 0;
  const flags = new Set<CycleFlag>();
  for (const cycle of cycles) {
    cyclesCounted += cycle.count;
    const response = localResponse(setup.cyclic, cycle.range / 2, cycle.mean, setup.kf);
    maxEquivalentAmplitude = Math.max(maxEquivalentAmplitude, response.sigmaA);
    const reversals = strainLifeAt(setup.curve, response, setup.mean);
    if (reversals === null) flags.add('no_life');
    else if (!Number.isFinite(reversals)) flags.add('swt_nonpositive');
    else damage += cycle.count / (reversals / 2);
  }
  return { damage, cyclesCounted, extrapolated: false, flags, maxEquivalentAmplitude };
}
