/** Numeric models of the driver, resolved at one step (temperature fixed): elasticity, J2, Prony, creep (PHY-02 §5.3, §5.8). */

import { convertValue, isUnitFailure } from '../../lib/quantity';
import type { LawOf, MaterialModel, SetSlot } from '../materialModel';
import { bulkShear, isotropicStiffness, orthotropicCompliance, stiffnessReport, symmetricFromUpperTriangle } from './elastic';
import type { Matrix } from './linalg';
import { invertMatrix, pivotReport } from './linalg';
import { cowperSymondsRateFactor, johnsonCookRateFactor, resolveIsotropic } from './hardening';
import type { J2Material } from './j2';
import { arrheniusLnShift, wlfLog10Shift } from './viscoelastic';
import { convertQuantity, failure, isLawFailure, resolveAll, resolveParameter, type LawFailure, type ResolveEnv } from './resolve';
import { resolveOrthotropicConstants } from './elasticResolve';

interface ElasticModel {
  readonly C: Matrix;
  /** Isotropic constants (null for orthotropic / anisotropic). */
  readonly iso: { readonly E: number; readonly nu: number; readonly G: number; readonly K: number } | null;
}

interface PronyModel {
  readonly shear: ReadonlyArray<{ readonly g: number; readonly tau: number }>;
  readonly bulk: ReadonlyArray<{ readonly k: number; readonly tau: number }>;
  /** Shift factor aT at the step temperature (reduced time Δξ = Δt/aT). */
  readonly shiftFactor: number;
}

export type CreepModel =
  | {
      readonly kind: 'norton';
      readonly A: number;
      readonly n: number;
      readonly m: number;
      readonly stressPerMPa: number;
      readonly timePerSecond: number;
    }
  | {
      readonly kind: 'garofalo';
      readonly A: number;
      readonly alpha: number;
      readonly n: number;
      readonly activationEnergy: number;
      readonly temperature: number;
    };

export interface SmallModel {
  readonly elastic: ElasticModel;
  readonly j2: J2Material | null;
  readonly prony: PronyModel | null;
  readonly creep: CreepModel | null;
  /** Stress scale for tolerances (yield stress, else the elastic modulus × 1e-3). */
  readonly referenceStress: number;
}

type Slots = Readonly<Partial<Record<SetSlot, MaterialModel>>>;

const pdFailure = (matrix: Matrix, path: string): LawFailure | null => {
  const report = stiffnessReport(matrix);
  return report.positiveDefinite
    ? null
    : failure(
        'MATL_ELASTIC_NOT_POSITIVE_DEFINITE',
        path,
        `the resolved stiffness is not positive definite (pivot ${(report.failingPivot ?? 0) + 1})`,
      );
};

function isotropicModel(E: number, nu: number, path: string): ElasticModel | LawFailure {
  if (!(E > 0) || !(nu > -1 && nu < 0.5))
    return failure('MATL_POISSON_BOUND', path, `E = ${E} MPa, ν = ${nu} is not a valid isotropic pair (E > 0, −1 < ν < 0.5)`);
  return { C: isotropicStiffness(E, nu), iso: { E, nu, ...bulkShear(E, nu) } };
}

function resolveElastic(model: MaterialModel, env: ResolveEnv): ElasticModel | LawFailure {
  const law = model.model as LawOf<'elastic_isotropic' | 'elastic_orthotropic' | 'elastic_transversely_isotropic' | 'elastic_anisotropic'>;
  const path = `models.${model.id}`;
  switch (law.kind) {
    case 'elastic_isotropic': {
      const values = resolveAll(
        { E: { parameter: law.E, dimension: 'stress' }, nu: { parameter: law.nu, dimension: 'dimensionless' } },
        env,
        path,
      );
      return isLawFailure(values) ? values : isotropicModel(values.E, values.nu, path);
    }
    case 'elastic_orthotropic':
    case 'elastic_transversely_isotropic': {
      const constants = resolveOrthotropicConstants(law, env, path);
      if (isLawFailure(constants)) return constants;
      const compliance = orthotropicCompliance(constants);
      const notPd = pivotReport(compliance).positiveDefinite
        ? null
        : failure('MATL_ELASTIC_NOT_POSITIVE_DEFINITE', path, 'the resolved compliance is not positive definite');
      if (notPd !== null) return notPd;
      const C = invertMatrix(compliance);
      return C === null ? failure('MATL_ELASTIC_NOT_POSITIVE_DEFINITE', path, 'singular compliance') : { C, iso: null };
    }
    case 'elastic_anisotropic': {
      const scale = convertQuantity(1, law.unit, 'stress', `${path}.unit`);
      if (isLawFailure(scale)) return scale;
      const C = symmetricFromUpperTriangle(law.stiffness).map((row) => row.map((value) => value * scale));
      return pdFailure(C, path) ?? { C, iso: null };
    }
  }
}

/** J2 material at a step: isotropic elasticity required (the return mapping uses G and K). */
function resolveJ2(
  plastic: MaterialModel,
  rate: MaterialModel | undefined,
  elastic: ElasticModel,
  env: ResolveEnv,
  temperatureK: number | null,
): J2Material | LawFailure {
  const law = plastic.model as LawOf<'j2_plasticity'>;
  const path = `models.${plastic.id}`;
  if (elastic.iso === null)
    return failure(
      'MATL_PATH_INVALID',
      path,
      'the driver supports plasticity with elastic_isotropic only',
      'use an elastic_isotropic model for plastic runs',
    );
  const isotropic = resolveIsotropic(law.isotropic, env, elastic.iso.E, temperatureK, `${path}.isotropic`);
  if (isLawFailure(isotropic)) return isotropic;
  const terms: { C: number; gamma: number }[] = [];
  if (law.kinematic.kind === 'linear') {
    const C = resolveParameter(law.kinematic.C, 'stress', env, `${path}.kinematic.C`);
    if (isLawFailure(C)) return C;
    terms.push({ C, gamma: 0 });
  } else if (law.kinematic.kind === 'chaboche') {
    for (const [i, term] of law.kinematic.backstresses.entries()) {
      const C = resolveParameter(term.C, 'stress', env, `${path}.kinematic.backstresses[${i}].C`);
      if (isLawFailure(C)) return C;
      terms.push({ C, gamma: term.gamma });
    }
  }
  let rateFactor: J2Material['rateFactor'] = null;
  const rateLaw = rate?.model;
  if (rateLaw?.kind === 'rate_johnson_cook') {
    const reference = convertQuantity(rateLaw.referenceRate.value, rateLaw.referenceRate.unit, 'rate', `models.${rate?.id}.referenceRate`);
    if (isLawFailure(reference)) return reference;
    rateFactor = (plasticRate) => johnsonCookRateFactor(rateLaw.C, reference, plasticRate);
  } else if (rateLaw?.kind === 'rate_cowper_symonds') {
    const D = convertQuantity(rateLaw.D.value, rateLaw.D.unit, 'rate', `models.${rate?.id}.D`);
    if (isLawFailure(D)) return D;
    rateFactor = (plasticRate) => cowperSymondsRateFactor(D, rateLaw.q, plasticRate);
  }
  return {
    G: elastic.iso.G,
    K: elastic.iso.K,
    yieldStress: isotropic.stress,
    linearSlope: isotropic.linearSlope,
    backStresses: terms,
    rateFactor,
    referenceYield: isotropic.y0,
  };
}

function resolveProny(model: MaterialModel, temperatureK: number | null): PronyModel | LawFailure {
  const law = model.model as LawOf<'visco_prony'>;
  const path = `models.${model.id}`;
  const series = <T extends { tau: { value: number; unit: string } }>(
    terms: readonly T[],
    field: string,
  ): (T & { seconds: number })[] | LawFailure => {
    const out: (T & { seconds: number })[] = [];
    for (const [i, term] of terms.entries()) {
      const seconds = convertQuantity(term.tau.value, term.tau.unit, 'time', `${path}.${field}[${i}].tau`);
      if (isLawFailure(seconds)) return seconds;
      out.push({ ...term, seconds });
    }
    return out;
  };
  const shear = series(law.shear, 'shear');
  if (isLawFailure(shear)) return shear;
  const bulk = series(law.bulk ?? [], 'bulk');
  if (isLawFailure(bulk)) return bulk;
  let shiftFactor = 1;
  const shift = law.shift;
  if (shift !== undefined) {
    if (temperatureK === null)
      return failure(
        'PROP_VARIABLE_MISSING',
        `${path}.shift`,
        'a time-temperature shift needs the step temperature',
        'give steps[i].temperature',
      );
    const reference = convertQuantity(
      shift.referenceTemperature.value,
      shift.referenceTemperature.unit,
      'temperature',
      `${path}.shift.referenceTemperature`,
    );
    if (isLawFailure(reference)) return reference;
    if (shift.kind === 'wlf') {
      const C2 = convertQuantity(shift.C2.value, shift.C2.unit, 'temperature', `${path}.shift.C2`);
      if (isLawFailure(C2)) return C2;
      const log10 = wlfLog10Shift(shift.C1, C2, reference, shift.referenceIsTg, temperatureK);
      if (isLawFailure(log10)) return log10;
      shiftFactor = 10 ** log10;
    } else {
      const energy = convertQuantity(
        shift.activationEnergy.value,
        shift.activationEnergy.unit,
        'energyPerMole',
        `${path}.shift.activationEnergy`,
      );
      if (isLawFailure(energy)) return energy;
      shiftFactor = Math.exp(arrheniusLnShift(energy, reference, temperatureK));
    }
  }
  if (!Number.isFinite(shiftFactor) || !(shiftFactor > 0))
    return failure(
      'MATL_SHIFT_OUT_OF_RANGE',
      `${path}.shift`,
      `the shift factor ${shiftFactor} at T = ${temperatureK} K is not a finite positive number`,
      'stay closer to the reference temperature',
    );
  return {
    shear: shear.map((term) => ({ g: term.g, tau: term.seconds })),
    bulk: bulk.map((term) => ({ k: term.k, tau: term.seconds })),
    shiftFactor,
  };
}

function resolveCreep(model: MaterialModel, temperatureK: number | null): CreepModel | LawFailure {
  const law = model.model as LawOf<'creep_norton' | 'creep_garofalo'>;
  const path = `models.${model.id}`;
  if (law.kind === 'creep_norton') {
    if (law.hardening !== 'time')
      return failure('MATL_PATH_INVALID', path, 'the driver integrates Norton creep with time hardening only', "use hardening 'time'");
    const toModelStress = convertQuantityTo(1, 'MPa', law.stressUnit, path);
    if (isLawFailure(toModelStress)) return toModelStress;
    const toModelTime = convertQuantityTo(1, 's', law.timeUnit, path);
    if (isLawFailure(toModelTime)) return toModelTime;
    return { kind: 'norton', A: law.A, n: law.n, m: law.m, stressPerMPa: toModelStress, timePerSecond: toModelTime };
  }
  if (temperatureK === null)
    return failure('PROP_VARIABLE_MISSING', path, 'Garofalo creep needs the step temperature', 'give steps[i].temperature');
  const A = convertQuantity(law.A.value, law.A.unit, 'rate', `${path}.A`);
  const alpha = convertQuantity(law.alpha.value, law.alpha.unit, 'inverseStress', `${path}.alpha`);
  const energy = convertQuantity(law.activationEnergy.value, law.activationEnergy.unit, 'energyPerMole', `${path}.activationEnergy`);
  if (isLawFailure(A)) return A;
  if (isLawFailure(alpha)) return alpha;
  if (isLawFailure(energy)) return energy;
  return { kind: 'garofalo', A, alpha, n: law.n, activationEnergy: energy, temperature: temperatureK };
}

function convertQuantityTo(value: number, from: string, to: string, path: string): number | LawFailure {
  const converted = convertValue(value, from, to);
  return isUnitFailure(converted) ? failure('MATL_CREEP_PARAMS_INVALID', path, converted.message) : converted.value;
}

/**
 * All numeric models of a set at one step.
 * @failure property-model refusals pass through; unsupported combinations -> MATL_PATH_INVALID
 */
export function resolveSmallModel(slots: Slots, env: ResolveEnv, temperatureK: number | null): SmallModel | LawFailure {
  const elasticModel = slots.elastic;
  if (elasticModel === undefined)
    return failure(
      'MATL_PATH_INVALID',
      'set',
      'small-strain runs need an elastic model in the set',
      'use a set with an elastic model, or kinematics finite for hyperelastic',
    );
  const elastic = resolveElastic(elasticModel, env);
  if (isLawFailure(elastic)) return elastic;
  let j2: J2Material | null = null;
  if (slots.plastic !== undefined) {
    const resolved = resolveJ2(slots.plastic, slots.rate, elastic, env, temperatureK);
    if (isLawFailure(resolved)) return resolved;
    j2 = resolved;
  }
  let prony: PronyModel | null = null;
  if (slots.viscoelastic !== undefined) {
    const resolved = resolveProny(slots.viscoelastic, temperatureK);
    if (isLawFailure(resolved)) return resolved;
    prony = resolved;
  }
  let creep: CreepModel | null = null;
  if (slots.creep !== undefined) {
    const resolved = resolveCreep(slots.creep, temperatureK);
    if (isLawFailure(resolved)) return resolved;
    creep = resolved;
  }
  const combos = [j2 !== null, prony !== null, creep !== null].filter(Boolean).length;
  if (combos > 1)
    return failure(
      'MATL_PATH_INVALID',
      'set',
      'the driver combines elasticity with ONE of plasticity, viscoelasticity or creep',
      'drive the laws in separate sets',
    );
  if ((prony !== null || creep !== null) && elastic.iso === null)
    return failure('MATL_PATH_INVALID', 'set', 'viscoelastic and creep runs need elastic_isotropic', 'use an elastic_isotropic model');
  const referenceStress =
    j2?.referenceYield ?? 1e-3 * (elastic.iso?.E ?? Math.max(...elastic.C.map((row) => Math.max(...row.map(Math.abs)))));
  return { elastic, j2, prony, creep, referenceStress };
}
