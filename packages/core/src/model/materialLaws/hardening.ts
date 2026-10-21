/** Isotropic hardening curves at a fixed temperature (PHY-02 §3.2, §5.2) resolved to MPa, plus rate factors (§5.8). */

import type { IsotropicHardening } from '../materialModel';
import { interp1Pairs } from '../../lib/interp1';
import { failure, isLawFailure, resolveAll, resolveParameter, convertQuantity, type LawFailure, type ResolveEnv } from './resolve';

export interface ResolvedIsotropic {
  /** Yield stress at zero plastic strain (and zero rate). */
  readonly y0: number;
  /** Flow stress (MPa) as a function of the equivalent plastic strain. */
  readonly stress: (equivalentPlasticStrain: number) => number;
  /** Slope of the curve when it is a straight line (perfect: 0; linear: plastic modulus), else null. */
  readonly linearSlope: number | null;
  /** Last equivalent plastic strain of a tabulated curve (multilinear), else null. */
  readonly lastTabulatedStrain: number | null;
}

/** Plastic modulus from a tangent modulus: H = E·Et / (E − Et); null when Et ≥ E. */
const plasticFromTangent = (E: number, tangent: number): number | null => (tangent < E ? (E * tangent) / (E - tangent) : null);

/** Johnson-Cook homologous temperature T* = (T − T_tr)/(T_m − T_tr) clamped to [0, 1]. */
const homologousTemperature = (T: number, transition: number, melt: number): number =>
  Math.min(1, Math.max(0, (T - transition) / (melt - transition)));

/** Curve [equivalent plastic strain, MPa] at a temperature: the single curve, or a linear blend of the two bracketing curves. */
export const multilinearCurve = (
  law: Extract<IsotropicHardening, { kind: 'multilinear' }>,
  temperature: number | null,
  path: string,
): ReadonlyArray<readonly [number, number]> | LawFailure => {
  const scale = convertQuantity(1, law.stressUnit, 'stress', `${path}.stressUnit`);
  if (isLawFailure(scale)) return scale;
  const curves = law.curves.map((curve) => {
    const kelvin =
      curve.temperature === undefined ? null : convertQuantity(curve.temperature.value, curve.temperature.unit, 'temperature', path);
    return {
      temperatureK: kelvin === null || isLawFailure(kelvin) ? null : kelvin,
      points: curve.points.map(([stress, strain]) => [strain, stress * scale] as const),
    };
  });
  const tabulated = curves.filter((curve) => curve.temperatureK !== null);
  if (tabulated.length === 0 || temperature === null) return curves[0]?.points ?? [];
  const sorted = [...tabulated].sort((a, b) => (a.temperatureK ?? 0) - (b.temperatureK ?? 0));
  const low = sorted[0];
  const high = sorted[sorted.length - 1];
  const lowT = low?.temperatureK ?? 0;
  const highT = high?.temperatureK ?? 0;
  if (low === undefined || high === undefined || temperature < lowT || temperature > highT) {
    return failure(
      'PROP_OUT_OF_RANGE',
      path,
      `T = ${temperature} K is outside the curve temperatures [${lowT}, ${highT}] K; llull never extrapolates`,
      'stay inside the tabulated temperatures or add a curve',
    );
  }
  const upper = sorted.find((curve) => (curve.temperatureK ?? 0) >= temperature) ?? high;
  const lower = [...sorted].reverse().find((curve) => (curve.temperatureK ?? 0) <= temperature) ?? low;
  if (upper === lower) return upper.points;
  const weight = (temperature - (lower.temperatureK ?? 0)) / ((upper.temperatureK ?? 0) - (lower.temperatureK ?? 0));
  const strains = [...new Set([...lower.points, ...upper.points].map(([strain]) => strain))].sort((a, b) => a - b);
  return strains.map(
    (strain) => [strain, (1 - weight) * interp1Pairs(lower.points, strain) + weight * interp1Pairs(upper.points, strain)] as const,
  );
};

/**
 * Resolve isotropic hardening at `temperatureK` (null when the step has no temperature).
 * @failure tangent modulus ≥ E -> MATL_LAW_PARAMS_INVALID; johnson_cook without a temperature -> PROP_VARIABLE_MISSING;
 *   property-model refusals pass through
 */
export function resolveIsotropic(
  law: IsotropicHardening,
  env: ResolveEnv,
  youngModulus: number | null,
  temperatureK: number | null,
  path: string,
): ResolvedIsotropic | LawFailure {
  switch (law.kind) {
    case 'perfect': {
      const y0 = resolveParameter(law.yieldStress, 'stress', env, `${path}.yieldStress`);
      return isLawFailure(y0) ? y0 : { y0, stress: () => y0, linearSlope: 0, lastTabulatedStrain: null };
    }
    case 'linear': {
      const values = resolveAll(
        { y0: { parameter: law.yieldStress, dimension: 'stress' }, modulus: { parameter: law.modulus, dimension: 'stress' } },
        env,
        path,
      );
      if (isLawFailure(values)) return values;
      let slope = values.modulus;
      if (law.modulusKind === 'tangent') {
        const plastic = youngModulus === null ? null : plasticFromTangent(youngModulus, values.modulus);
        if (plastic === null)
          return failure(
            'MATL_LAW_PARAMS_INVALID',
            `${path}.modulus`,
            'a tangent modulus needs the elastic E and must be < E',
            'give a tangent modulus below E',
          );
        slope = plastic;
      }
      const { y0 } = values;
      return { y0, stress: (ep) => y0 + slope * ep, linearSlope: slope, lastTabulatedStrain: null };
    }
    case 'multilinear': {
      const points = multilinearCurve(law, temperatureK, `${path}.curves`);
      if (isLawFailure(points)) return points;
      const first = points[0];
      const last = points[points.length - 1];
      if (first === undefined || last === undefined) return failure('MATL_HARDENING_CURVE_INVALID', `${path}.curves`, 'empty curve');
      return { y0: first[1], stress: (ep) => interp1Pairs(points, ep), linearSlope: null, lastTabulatedStrain: last[0] };
    }
    case 'voce': {
      const values = resolveAll(
        { y0: { parameter: law.yieldStress, dimension: 'stress' }, Q: { parameter: law.Q, dimension: 'stress' } },
        env,
        path,
      );
      if (isLawFailure(values)) return values;
      const { y0, Q } = values;
      return { y0, stress: (ep) => y0 + Q * (1 - Math.exp(-law.b * ep)), linearSlope: null, lastTabulatedStrain: null };
    }
    case 'johnson_cook': {
      if (temperatureK === null)
        return failure(
          'PROP_VARIABLE_MISSING',
          `${path}`,
          'johnson_cook hardening needs the step temperature',
          'give steps[i].temperature',
        );
      const A = convertQuantity(law.A.value, law.A.unit, 'stress', `${path}.A`);
      if (isLawFailure(A)) return A;
      const B = convertQuantity(law.B.value, law.B.unit, 'stress', `${path}.B`);
      if (isLawFailure(B)) return B;
      const melt = convertQuantity(law.meltTemperature.value, law.meltTemperature.unit, 'temperature', `${path}.meltTemperature`);
      if (isLawFailure(melt)) return melt;
      const transition = convertQuantity(
        law.transitionTemperature.value,
        law.transitionTemperature.unit,
        'temperature',
        `${path}.transitionTemperature`,
      );
      if (isLawFailure(transition)) return transition;
      const thermal = 1 - homologousTemperature(temperatureK, transition, melt) ** law.m;
      return { y0: A * thermal, stress: (ep) => (A + B * ep ** law.n) * thermal, linearSlope: null, lastTabulatedStrain: null };
    }
  }
}

/** Johnson-Cook rate factor 1 + C ln(ε̇/ε̇0), clamped to ≥ 1 below the reference rate (named default, OQ-PROP-08). */
export const johnsonCookRateFactor = (C: number, referenceRate: number, rate: number): number =>
  rate > referenceRate ? 1 + C * Math.log(rate / referenceRate) : 1;

/** Cowper-Symonds rate factor 1 + (ε̇/D)^(1/q). */
export const cowperSymondsRateFactor = (D: number, q: number, rate: number): number => (rate > 0 ? 1 + (rate / D) ** (1 / q) : 1);

/** Johnson-Cook flow stress (A + B εp^n)(1 + C ln(ε̇/ε̇0))(1 − T*^m) in the unit of A, B (VC-MATL-12). */
export function johnsonCookFlowStress(
  hardening: { A: number; B: number; n: number; m: number; meltTemperature: number; transitionTemperature: number },
  rate: { C: number; referenceRate: number },
  equivalentPlasticStrain: number,
  strainRate: number,
  temperature: number,
): number {
  const thermal = 1 - homologousTemperature(temperature, hardening.transitionTemperature, hardening.meltTemperature) ** hardening.m;
  return (
    (hardening.A + hardening.B * equivalentPlasticStrain ** hardening.n) *
    johnsonCookRateFactor(rate.C, rate.referenceRate, strainRate) *
    thermal
  );
}
